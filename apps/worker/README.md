# gameforge-worker

BullMQ worker host for GameForge AI Studio (Phase 2).

## What it does

- `src/queues.ts` — the four durable queues (`agent-runs`, `builds`,
  `asset-generations`, `maintenance`) with bounded retries and exponential backoff.
- `src/events.ts` — `appendEvent()`: append-only, redaction-on-append event log
  writer with per-run serialized `seq` allocation (row lock on `agent_runs`).
- `src/runProcessor.ts` — **durable skeleton (honest scaffold)** for agent runs:
  atomic claim (`queued → planning`), journal rehydration with resume-not-replay,
  pause/cancel handling, and `interrupted` (not `failed`) on unexpected errors so a
  human can resume. Phase 2 writes a stub plan explicitly labeled
  `{scaffold: true}` — **no LLM calls, no game files touched**. Phase 3 replaces
  the stub with the real director.
- `src/index.ts` — boots the `agent-runs` worker (concurrency from
  `WORKER_CONCURRENCY`, default 2), graceful SIGTERM/SIGINT, structured JSON logs.

## Honest-scaffold contract

Anything the worker cannot really do yet is labeled `scaffold: true` in code,
events and journal — never presented as real agent work. The run row in Postgres
is the source of truth; BullMQ is scheduling, not state.

## Test

`npm test` — vitest, all external systems (pg, BullMQ) mocked. Live Postgres/Redis
testing happens on the Oracle server (Phase 7); this dev VM has neither.
