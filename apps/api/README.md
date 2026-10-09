# gameforge-api — GameForge AI Studio REST API

Fastify + TypeScript REST API (`/api/v1`), the control plane of GameForge AI Studio.
Single-user by design: no login, no accounts. The infrastructure access boundary
(VPN/private network, see `docs/THREAT_MODEL.md`) is what keeps the code-execution
backend off the public internet.

## Run

```bash
cp .env.example .env   # fill in — never commit the filled file
npm install            # at the repo root (workspaces)
npm run build -w gameforge-api
npm start -w gameforge-api
# or: node apps/api/dist/index.js
```

Defaults: `PORT=8090`, `BIND_ADDR=127.0.0.1` (loopback — the reverse proxy terminates
TLS; binding `0.0.0.0` requires an explicit `BIND_ADDR`).

Migrations in `infra/db/migrations/` run automatically at boot under a Postgres
advisory lock. If Postgres/Redis are unreachable the server still boots: `/health`
stays green, `/ready` reports the outage, and DB-backed routes return
`503 dependency_unavailable` instead of crashing.

## Environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `REDIS_URL` | Redis connection string (BullMQ) |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | Server-side only. Token registered with the secret redactor at boot; **never** returned by any endpoint, never logged |
| `STORAGE_ROOT` | Filesystem root for project git repos (`projects/<uuid>/repo`) |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins. Empty = none. `*` is refused in production |
| `PORT` / `BIND_ADDR` | Listen port / address (default `8090` / `127.0.0.1`) |
| `RATE_LIMIT_PER_MINUTE` | Per-IP rate limit (default 100) |
| `GF_RATE_MANAGEMENT_PER_MIN` | Tiered limit: `/plugins`, `/improvements` mutations (default 20) |
| `GF_RATE_WRITE_PER_MIN` | Tiered limit: other write endpoints (default 60) |
| `REQUEST_TIMEOUT_MS` | Request timeout, 503 + Retry-After (default 30000; SSE exempt) |
| `GF_SLOW_REQUEST_MS` | Slow-request warn threshold (default 1000) |
| `GF_SSE_MAX_PER_RUN` / `GF_SSE_MAX_TOTAL` | SSE stream caps (default 8 / 64) |
| `GF_SSE_REPLAY_LIMIT` | Max events per SSE replay poll (default 500) |
| `LOG_LEVEL` | pino level (default `info`) |
| `MIGRATIONS_DIR` | Override for the migrations directory |

## Routes (`/api/v1`)

| Method & path | Status | Notes |
|---|---|---|
| `GET /health` | live | Liveness, no dependencies |
| `GET /ready` | live | 200 only when Postgres **and** Redis are up; else 503 |
| `GET /system/capabilities` | live | Engines, template ids, runner/blender/vision availability (honest) |
| `GET /system/metrics` | live | Uptime, best-effort queue depths |
| `GET /projects` · `POST /projects` | live | Create also `git init`s the project repo for real |
| `GET /projects/:id` · `PATCH /projects/:id` | live | |
| `DELETE /projects/:id` | live | Soft delete — row + git repo are kept |
| `POST /projects/:id/duplicate` | live | New row + local `git clone` |
| `GET /projects/:id/export` · `POST /projects/import` | **501** | Planned for Phase 7 — honest stub, not a fake |
| `GET /projects/:id/messages` · `POST /projects/:id/messages` | live | One conversation per project (Phase 2); run wiring in Phase 3 |
| `POST /projects/:id/runs` | live | Idempotency-key dedupe (200 existing / 202 enqueued); BullMQ `jobId` = key |
| `GET /runs/:id` | live | |
| `POST /runs/:id/pause` · `/resume` · `/cancel` | live | Pause/resume are journal flags + events; terminal states immutable (409) |
| `GET /runs/:id/events` | live | SSE with `Last-Event-ID: <runId>:<seq>` replay; `event: done` on terminal status |
| `POST /projects/:id/builds` · `GET /projects/:id/builds` · `GET /builds/:id` | skeleton | Row + enqueue only; the 15-phase pipeline is Phase 3 |
| `GET /projects/:id/assets` | live (read) | Mutations → 501 (Phase 5/6) |
| `POST /projects/:id/assets` · `DELETE /assets/:id` · `POST /assets/generations` · `GET /assets/generations/:id` | **501** | Phase 5/6 |
| `GET /models` · `GET /models/capabilities` | live | Read from `model_registry` — no hardcoded model names |
| `POST /models/connection-test[?probeTools=true]` | live | See below |
| `GET /plugins` | live (read) | Enable/disable → 501 (Phase 6) |
| `GET /improvements` · `GET /improvements/:id` | live | Paginated list + version history |
| `POST /improvements` | live | Propose: evidence must reference real builds/reviews; scope-bounded change validation; actor header required |
| `POST /improvements/:id/approve` · `/reject` | live | **Human/API-key only** — `agent:*` actors → 403; every action audited |
| `POST /improvements/:id/apply` | live | Requires prior approval (409 otherwise); prompt → stages `skill_versions` candidate; config → writes settings (secret-like refused); code → diff stored for manual review, never executed |
| `POST /improvements/:id/activate` | live | Prompt scope only; needs held-out gate evidence; promotes candidate → active |
| `POST /improvements/:id/rollback` | live | Restores previous config value / rolls back staged candidate |
| `GET /settings` · `PATCH /settings` | live | Secret-like keys/values are refused with 400 |
| `GET /projects/:id/memories` · `GET /studio/memories` | live (read) | Writes → 501 (Phase 4) |
| `GET /api/v1/openapi.json` · `GET /docs` | live | OpenAPI 3.0 spec + Swagger UI |

All errors use the typed envelope `{ error: { code, message, requestId, detail? } }`.
Validation failures (zod in handlers, AJV for declared OpenAPI schemas) → `400
validation_failed`. Stack traces and secrets never leave the process.

## `POST /models/connection-test` — token-cost policy

- **Without parameters:** only calls the Workers AI model catalog (list). **Zero neuron cost.**
  Returns `{ ok, modelCount, toolProbe: null }`.
- **With `?probeTools=true`:** additionally runs `probeToolSupport()` — one minimal
  chat completion with a dummy tool definition — against the model bound to the
  **director** role (`application_settings.modelByRole.director`). **This spends
  neurons** and runs **only** on explicit request; any other value (or none) keeps the
  zero-cost path. Returns `{ ok, modelCount, toolProbe: { model, supported } | null }`
  (`null` when no director model is configured or the provider package has no probe).
- The response never contains the API key, its prefix, or any credential material.

## Security notes

- CORS allowlist only; `*` refused in production. Global rate limit (100/min/IP)
  plus stricter tiers: 20/min management, 60/min writes — 429 + `Retry-After`.
- Defense-in-depth security headers at the API layer (`apps/api/src/security.ts`):
  nosniff, `X-Frame-Options: DENY`, strict referrer policy, restrictive CSP
  fallback. The Caddy edge config sets them too.
- 10 MB body limit, `x-request-id` on every response. Requests over
  `REQUEST_TIMEOUT_MS` get 503 + `Retry-After` (SSE streams exempt).
- SSE: ≤8 streams per run, ≤64 total (429s when full), replay capped at 500
  events per poll, 15 s heartbeat.
- `PATCH /settings` refuses secret-like keys (`*key*`, `*token*`, `*secret*`,
  `*password*`, …) and secret-looking values — secrets live in the server vault.
- Project file paths are validated (`relativePathSchema`); git operations use
  `execFile` argv arrays, never shell strings. Project ids are UUID-validated before
  touching the filesystem (`STORAGE_ROOT/projects/<uuid>/repo`).
- Event payloads are redacted on write (worker's job) **and** again on SSE read
  (defense in depth); error messages pass through the secret redactor.

## Performance budgets

Targets (single-user studio on the reference Oracle shape; measure, don't guess):

| Surface | Budget |
|---|---|
| CRUD reads (`GET /projects`, `/builds`, …) | p95 < 150 ms (warm DB) |
| SSE event latency (event written → client receives) | p95 < 3 s (2 s poll) |
| File save (write + git commit) | p95 < 500 ms for ≤1 MiB files |
| Asset upload (10 MiB) | p95 < 5 s on LAN |
| Slow-request warn threshold | `GF_SLOW_REQUEST_MS` (default 1000 ms) |

Requests slower than the warn threshold are logged with method, URL, duration
and status — that log is the measurement point, not a rewrite trigger. The
in-memory tiered rate limiter is per API process; with one API replica behind
the proxy (the documented deployment) that is exact. Do not add a second API
replica without moving the limiter to Redis.

## Tests

```bash
npm test -w gameforge-api   # vitest, fastify.inject, stubbed db/queue/git — no live services
```

16 tests: health/ready/404 envelopes, validation, run idempotency (same key → same
run, single enqueue, BullMQ `jobId` dedupe), pause/resume/cancel transitions, SSE
replay + terminal `done`, settings secret refusal, connection-test (zero-cost default,
opt-in probe, missing key), honest 501 stubs.

45 tests: file listing/read/write (SHA concurrency, traversal defense, binary/oversize
refusals, git commit on save), revisions pagination, asset upload/delete/download
(sanitized filenames, 10 MiB cap), build diagnostics (tests/reviews/artifacts +
contained downloads), asset generation → 501.

19 tests: self-improvement proposals — evidence gating (unknown build/review → 400),
scope-bounded change validation (secret-like config keys, traversal targets → 400),
actor trust rules (no header → 403, agents can never approve/apply → 403),
propose→approve→apply→activate→rollback lifecycle, auto-apply OFF (apply without
approval → 409), prompt staging as candidate (never active), config rollback
restores/removes the key, code diffs staged for manual review only.

## What is deliberately not here yet

- The 15-phase build pipeline (Phase 3), the director agent (Phase 3), multi-agent
  orchestration (Phase 4), asset upload/generation (Phase 5/6), plugin management
  (Phase 6), project export/import ZIP (Phase 7). Endpoints for those return `501
  not_implemented` — never fake success.
