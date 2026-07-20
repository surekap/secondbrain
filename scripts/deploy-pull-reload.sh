#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${SECOND_BRAIN_REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
BRANCH="${SECOND_BRAIN_DEPLOY_BRANCH:-main}"
STATUS_FILE="$REPO_DIR/.agent-logs/deploy-reload-status.json"
LOG_FILE="$REPO_DIR/.agent-logs/deploy-reload.log"
LOCK_DIR="$REPO_DIR/.agent-logs/deploy-reload.lock"
PID_FILE="$REPO_DIR/.agent-pids/deploy-ui-api.pids"
RUN_BUILD="${SECOND_BRAIN_DEPLOY_BUILD:-1}"
RUN_INSTALL="${SECOND_BRAIN_DEPLOY_INSTALL:-0}"

mkdir -p "$REPO_DIR/.agent-logs" "$REPO_DIR/.agent-pids"

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

write_status() {
  local status="$1" step="$2" message="$3"
  local extra_json="${4:-{}}"
  local escaped_message
  escaped_message=$(printf '%s' "$message" | json_escape)
  python3 - "$STATUS_FILE.tmp" "$status" "$step" "$escaped_message" "$BRANCH" "$LOG_FILE" "$extra_json" <<'PY'
import json, sys, datetime
path, status, step, escaped_message, branch, log_file, extra = sys.argv[1:]
obj = {
  'status': status,
  'step': step,
  'message': json.loads(escaped_message),
  'branch': branch,
  'updated_at': datetime.datetime.utcnow().replace(microsecond=0).isoformat() + 'Z',
  'log_file': log_file,
}
try:
  obj.update(json.loads(extra or '{}'))
except Exception as exc:
  obj['status_extra_error'] = str(exc)
with open(path, 'w') as f:
  json.dump(obj, f)
PY
  mv "$STATUS_FILE.tmp" "$STATUS_FILE"
}

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE"
}

cleanup() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  write_status "running" "locked" "Deploy/reload already running"
  exit 0
fi

: > "$LOG_FILE"
write_status "running" "start" "Starting pull/reload"
log "repo=$REPO_DIR branch=$BRANCH run_build=$RUN_BUILD run_install=$RUN_INSTALL"
cd "$REPO_DIR"

write_status "running" "preflight" "Checking git state"
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  write_status "failed" "preflight" "Not a git repository: $REPO_DIR"
  exit 1
fi

DIRTY_STATUS="$(git status --porcelain)"
if [ -n "$DIRTY_STATUS" ]; then
  printf '%s\n' "$DIRTY_STATUS" | tee -a "$LOG_FILE"
  DIRTY_SUMMARY=$(printf '%s' "$DIRTY_STATUS" | tr '\n' '; ' | cut -c1-1000)
  write_status "failed" "preflight" "Working tree is dirty; refusing to pull/reload. Dirty files: $DIRTY_SUMMARY"
  exit 1
fi

write_status "running" "fetch" "Fetching origin/$BRANCH"
log "git fetch origin $BRANCH"
git fetch origin "$BRANCH" | tee -a "$LOG_FILE"

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")
BASE=$(git merge-base HEAD "origin/$BRANCH")
log "local=$LOCAL remote=$REMOTE base=$BASE"

if [ "$LOCAL" = "$REMOTE" ]; then
  log "Already up to date"
elif [ "$LOCAL" = "$BASE" ]; then
  write_status "running" "pull" "Fast-forwarding to origin/$BRANCH"
  git pull --ff-only origin "$BRANCH" | tee -a "$LOG_FILE"
else
  write_status "failed" "pull" "Local branch diverged from origin/$BRANCH; refusing automatic reload"
  exit 1
fi

if [ "$RUN_INSTALL" = "1" ]; then
  write_status "running" "install" "Installing npm dependencies"
  log "npm install"
  npm install 2>&1 | tee -a "$LOG_FILE"
fi

if [ "$RUN_BUILD" = "1" ]; then
  write_status "running" "build" "Building UI"
  log "npm run build --workspace=packages/ui"
  npm run build --workspace=packages/ui | tee -a "$LOG_FILE"
fi

append_pid() {
  local candidate="$1"
  case "$candidate" in
    ''|*[!0-9]*) return ;;
  esac
  case " $PIDS " in
    *" $candidate "*) ;;
    *) PIDS="$PIDS $candidate" ;;
  esac
}

append_descendants() {
  local parent="$1" child
  if ! command -v pgrep >/dev/null 2>&1; then return; fi
  for child in $(pgrep -P "$parent" 2>/dev/null || true); do
    append_pid "$child"
    append_descendants "$child"
  done
}

append_ancestors() {
  local current="$1" parent
  while command -v ps >/dev/null 2>&1; do
    parent="$(ps -o ppid= -p "$current" 2>/dev/null | tr -d '[:space:]')"
    case "$parent" in
      ''|*[!0-9]*|0|1) return ;;
    esac
    if [ "$parent" = "$$" ] || [ "$parent" = "$PPID" ]; then return; fi
    append_pid "$parent"
    current="$parent"
  done
}

write_status "running" "stop" "Stopping the previous UI/API process tree"
PIDS=""
LISTENER_PIDS=""
if command -v lsof >/dev/null 2>&1; then
  LISTENER_PIDS="$(lsof -ti tcp:4000 -sTCP:LISTEN 2>/dev/null || true) $(lsof -ti tcp:4001 -sTCP:LISTEN 2>/dev/null || true)"
elif command -v fuser >/dev/null 2>&1; then
  LISTENER_PIDS="$(fuser 4000/tcp 2>/dev/null || true) $(fuser 4001/tcp 2>/dev/null || true)"
fi
for pid in $LISTENER_PIDS; do
  append_pid "$pid"
  append_descendants "$pid"
  append_ancestors "$pid"
done
if [ -f "$PID_FILE" ]; then
  while IFS= read -r pid; do
    append_pid "$pid"
    append_descendants "$pid"
  done < "$PID_FILE"
fi
PIDS="$(echo "$PIDS" | xargs || true)"
if [ -n "$PIDS" ]; then
  log "Stopping pids: $PIDS"
  kill $PIDS 2>/dev/null || true
  sleep 2
  kill -9 $PIDS 2>/dev/null || true
else
  log "No listeners found on 4000/4001"
fi
rm -f "$PID_FILE"

write_status "running" "start" "Starting API and UI processes"
log "Starting API"
nohup node packages/ui/server.js >> "$REPO_DIR/.agent-logs/ui.log" 2>&1 &
API_PID=$!
log "API launched pid=$API_PID"
log "Starting Next.js UI"
nohup npm start --workspace=packages/ui >> "$REPO_DIR/.agent-logs/ui.log" 2>&1 &
NEXT_PID=$!
log "Next.js UI launched pid=$NEXT_PID"
printf '%s\n%s\n' "$API_PID" "$NEXT_PID" > "$PID_FILE"

VERIFY_TIMEOUT_SECONDS="${SECOND_BRAIN_DEPLOY_VERIFY_TIMEOUT_SECONDS:-90}"
VERIFY_INTERVAL_SECONDS=2
VERIFY_DEADLINE=$((SECONDS + VERIFY_TIMEOUT_SECONDS))
HEALTHY_SINCE=0
STABILITY_SECONDS="${SECOND_BRAIN_DEPLOY_STABILITY_SECONDS:-10}"
write_status "running" "verify" "Waiting up to ${VERIFY_TIMEOUT_SECONDS}s for UI/API readiness"
if command -v curl >/dev/null 2>&1; then
  while [ "$SECONDS" -lt "$VERIFY_DEADLINE" ]; do
    if ! kill -0 "$API_PID" 2>/dev/null || ! kill -0 "$NEXT_PID" 2>/dev/null; then
      break
    fi
    if curl -fsS --max-time 3 http://127.0.0.1:4001/api/health >/dev/null \
       && curl -fsS --max-time 3 http://127.0.0.1:4000/ >/dev/null; then
      if [ "$HEALTHY_SINCE" -eq 0 ]; then HEALTHY_SINCE=$SECONDS; fi
      if [ $((SECONDS - HEALTHY_SINCE)) -ge "$STABILITY_SECONDS" ]; then
        write_status "completed" "done" "Pulled/reloaded successfully; UI and API are stable"
        log "Reload complete"
        exit 0
      fi
    else
      HEALTHY_SINCE=0
    fi
    sleep "$VERIFY_INTERVAL_SECONDS"
  done
fi
PIDS=""
for pid in "$API_PID" "$NEXT_PID"; do
  append_pid "$pid"
  append_descendants "$pid"
done
PIDS="$(echo "$PIDS" | xargs || true)"
if [ -n "$PIDS" ]; then
  kill $PIDS 2>/dev/null || true
  sleep 2
  kill -9 $PIDS 2>/dev/null || true
fi
rm -f "$PID_FILE"
write_status "failed" "verify" "Reload command launched but UI/API did not become ready within ${VERIFY_TIMEOUT_SECONDS}s"
exit 1
