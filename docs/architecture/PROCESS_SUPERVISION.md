# Agent process supervision

Long-running connectors and analysis agents are owned by the API process supervisor. They are restartable workers, not independent daemons.

## Ownership contract

1. Exactly one API process may own the database advisory supervisor lease. A second API may serve no agent lifecycle work while that lease is held.
2. A managed worker remains an attached child of its supervisor. Do not use `detached`, `unref`, `nohup`, or a second backgrounding layer for managed agents.
3. A worker's stdout and stderr pipes belong to its current supervisor. The shared process-output guard exits immediately if either pipe fails, preventing recursive `uncaughtException` logging on `EPIPE`.
4. PID files are local diagnostic hints, never proof of ownership. Process discovery must validate the exact Node entrypoint argument before sending a signal.
5. After acquiring the lease, a new supervisor terminates every exact-match stale worker before starting desired agents. It never adopts a process whose pipes and exit events it does not own.
6. Graceful API shutdown stops all managed workers, waits for a bounded grace period, force-stops verified survivors, releases the lease, and only then exits.
7. Desired state and restart backoff remain durable in `system.agent_runtime_state`. Agent work itself remains idempotent, checkpointed, and independently protected from overlapping data runs.

## Failure behavior

| Failure | Required response |
|---|---|
| Worker exits | Record failure, apply bounded exponential backoff, start one replacement |
| API receives `SIGINT`/`SIGTERM` | Drain all children before releasing supervisor ownership |
| API is killed or crashes | Output guard makes noisy orphans exit; replacement supervisor reaps every remaining exact match |
| Two APIs start together | Database advisory lease permits only one agent owner |
| Stale or reused PID file | Ignore it unless the live command exactly matches the configured entrypoint |

Do not weaken this contract to preserve an in-flight analysis process across an API restart. Pipelines must preserve work through database checkpoints and leases, not through unowned operating-system processes.
