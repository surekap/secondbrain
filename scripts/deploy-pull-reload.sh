#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${SECOND_BRAIN_REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
BRANCH="${SECOND_BRAIN_DEPLOY_BRANCH:-main}"
STATUS_FILE="$REPO_DIR/.agent-logs/deploy-reload-status.json"
LOG_FILE="$REPO_DIR/.agent-logs/deploy-reload.log"
LOCK_DIR="$REPO_DIR/.agent-logs/deploy-reload.lock"
RUN_BUILD="${SECOND_BRAIN_DEPLOY_BUILD:-1}"

mkdir -p "$REPO_DIR/.agent-logs"

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

write_status() {
  local status="$1" step="$2" message="$3"
  local escaped_message
  escaped_message=$(printf '%s' "$message" | json_escape)
  cat > "$STATUS_FILE.tmp" <<JSON
{"status":"$status","step":"$step","message":$escaped_message,"branch":"$BRANCH","updated_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","log_file":"$LOG_FILE"}
JSON
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
log "repo=$REPO_DIR branch=$BRANCH run_build=$RUN_BUILD"
cd "$REPO_DIR"

write_status "running" "preflight" "Checking git state"
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  write_status "failed" "preflight" "Not a git repository: $REPO_DIR"
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  git status --short | tee -a "$LOG_FILE"
  write_status "failed" "preflight" "Working tree is dirty; refusing to pull/reload"
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

if [ "$RUN_BUILD" = "1" ]; then
  write_status "running" "build" "Building UI"
  log "npm run build --workspace=packages/ui"
  npm run build --workspace=packages/ui | tee -a "$LOG_FILE"
fi

write_status "running" "stop" "Stopping existing listeners on 4000/4001"
PIDS=""
if command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -ti tcp:4000 -sTCP:LISTEN 2>/dev/null || true) $(lsof -ti tcp:4001 -sTCP:LISTEN 2>/dev/null || true)"
elif command -v fuser >/dev/null 2>&1; then
  PIDS="$(fuser 4000/tcp 2>/dev/null || true) $(fuser 4001/tcp 2>/dev/null || true)"
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

write_status "running" "start" "Starting npm run ui"
log "Starting npm run ui"
nohup npm run ui >> "$REPO_DIR/.agent-logs/ui.log" 2>&1 &
UI_PID=$!
log "npm run ui launched pid=$UI_PID"
sleep 5

write_status "running" "verify" "Verifying API port 4001"
if command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 10 http://127.0.0.1:4001/api/intelligence/refresh/status >/dev/null; then
    write_status "completed" "done" "Pulled/reloaded successfully; api reachable on 4001"
    log "Reload complete"
    exit 0
  fi
fi
write_status "failed" "verify" "Reload command launched but API did not respond on 4001 within verification window"
exit 1
