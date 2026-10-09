# GameForge AI Studio — API Guide

Base URL (production): `https://YOUR_DOMAIN/api/v1`
— served by Caddy from the Fastify API on the Oracle VM.
Local dev: `http://127.0.0.1:8090/api/v1` (Vite proxies `/api` there).

Interactive OpenAPI docs are served by the API itself (see
`apps/api/src/server.ts` — the OpenAPI document is generated from the route
schemas). This guide is the human-readable companion: the actor model, the
envelopes, and the endpoint groups. Route sources live in
`apps/api/src/routes/`.

## 1. Actor model — there is no login, and that's deliberate

This is a single-user personal studio. There are no accounts, sessions, or
passwords — the **network boundary is the authentication** (see
`docs/ORACLE_INSTALL.md` and `docs/THREAT_MODEL.md` §5: the API must only be
reachable over your private Tailscale network).

Two headers distinguish *who* is acting, because agents must never perform
certain privileged actions:

| Header | Used by | Meaning |
|---|---|---|
| `x-agent-role` | agent tool calls | Present when the caller is an AI agent (`director`, `qa`, …). Plugin install/enable/disable endpoints return **403** when it's present. |
| `x-studio-actor` | improvement proposals | Required on every mutating `/improvements/*` endpoint. Values starting with `agent:` are **403**'d on approve/reject/apply/activate/rollback — agents can propose, never approve. |

The frontend never sends either header — it's the human.

## 2. Envelopes

**Errors** — every error response has this shape (`@gameforge/shared`):

```json
{ "error": { "code": "not_found", "message": "…", "detail": {}, "requestId": "req_…" } }
```

`code` is one of: `bad_request`, `validation_failed`, `not_found`, `conflict`,
`rate_limited`, `payload_too_large`, `unsupported_media_type`, `binary_file`,
`budget_exhausted`, `model_unavailable`, `runner_unavailable`,
`dependency_unavailable`, `not_implemented`, `forbidden`, `request_timeout`,
`internal_error`. Messages never contain secrets (redacted server-side).

**Pagination** — list endpoints accept `?page=` / `?pageSize=` and return:

```json
{ "items": [ … ], "page": 1, "pageSize": 20, "total": 42 }
```

**Optimistic concurrency** — `PUT /projects/:id/files/*` accepts
`expectedSha`; a stale SHA returns **409** with `currentSha` in the body —
the client must reload, diff, or explicitly overwrite. Nothing is silently
overwritten.

## 3. Rate limits

- Global: `RATE_LIMIT_PER_MINUTE` (default 100) per IP, via `@fastify/rate-limit`.
- Tiered (in `apps/api/src/security.ts`): management endpoints
  (`/plugins/*`, `/improvements/*`) — 20/min; other writes — 60/min
  (tune with `GF_RATE_MANAGEMENT_PER_MIN` / `GF_RATE_WRITE_PER_MIN`).
- `429` responses carry a `retry-after` header and the `rate_limited` code.

## 4. Endpoint groups

All paths below are relative to `/api/v1`.

**System** — `GET /health`, `GET /ready`, `GET /system/metrics`,
`GET /system/capabilities`.

**Projects** — `GET /projects` (paginated), `POST /projects`,
`GET /projects/:id`, `DELETE /projects/:id` (soft),
`POST /projects/:id/duplicate`, `GET /projects/:id/export` (ZIP of committed
HEAD + generated README; **refuses with 400** if any file trips the secret
scanner — the refusal names files, never contents), `POST /projects/import`
(501 — planned).

**Project files** — `GET /projects/:id/files` (recursive listing),
`GET /projects/:id/files/*path` (`{path, content, sha}`; binary → 400
`binary_file`), `PUT /projects/:id/files/*path` (`{content, expectedSha?}` →
commits as `studio: update <path>`), `GET /projects/:id/revisions`
(paginated, newest-first).

**Conversations & runs** — `POST /projects/:id/messages` (chat; can start a run),
`GET /projects/:id/messages`, `GET /projects/:id/conversations/:cid`,
`GET /projects/:id/runs` (implied by client), `GET /runs/:id`,
`POST /runs/:id/pause|resume|cancel`.

**Agent events (SSE)** — `GET /runs/:id/events` returns a
`text/event-stream`. Each event has a stable `id` of the form
`<runId>:<seq>`; on reconnect send `Last-Event-ID: <runId>:<seq>` and the
server replays everything after it. Concurrent streams are bounded per-run
and globally (429 `rate_limited` when exhausted).

**Builds & diagnostics** — `POST /projects/:id/builds`, `GET /projects/:id/builds`,
`GET /builds/:id`, `GET /builds/:id/tests`, `GET /builds/:id/reviews`,
`GET /builds/:id/artifacts`, `GET /artifacts/:id/download` (attachment,
path-contained).

**Assets** — `GET /projects/:id/assets` (paginated, kind filters),
`POST /projects/:id/assets` (multipart, 10 MiB cap, kind inferred from
extension, sha256 recorded), `GET /assets/:id/download`,
`DELETE /assets/:id` (204; file removed + soft delete),
`POST /assets/generations` (501 — AI generation is a Phase 6+ concern).

**Models** — `GET /models` (discovered at startup via the live Cloudflare Workers AI catalog —
never hardcoded names), `GET /models/capabilities`,
`POST /models/connection-test` (opt-in; `?probeTools=true` also probes
tool-calling; spends neurons — it's explicit).

**Plugins** — `GET /plugins`, `POST /plugins/install`,
`POST /plugins/:id/enable`, `POST /plugins/:id/disable`.
Install/enable/disable are **human-only** (403 for agent actors). Plugin tools
are exposed to agents under `<plugin>__<tool>` names, filtered per role.

**Settings** — `GET /settings`, `PATCH /settings` (secret-like keys/values are
refused — secrets live in the server vault, never in settings). Key values are
never returned by read endpoints.

**Memory** — `GET /projects/:id/memories`, `POST /projects/:id/memories`,
`PUT /memories/:id`, `DELETE /memories/:id`, `GET /studio/memories`,
`POST /studio/memories` (agents may write project/run memories, never
studio-global).

**Self-improvement** — `GET /improvements`, `GET /improvements/:id`,
`POST /improvements` (evidence must reference real builds/reviews),
`POST /improvements/:id/approve|reject|apply|activate|rollback`.
Lifecycle `proposed → approved → applied`; auto-apply is OFF; agents can never
approve (see §1).

## 5. Security headers

The API sets `nosniff`, `DENY` framing, a strict `frame-ancestors 'none'` CSP
(JSON only), and `same-origin` CORP on every response — defense in depth under
the Caddy edge headers (`infra/deploy/Caddyfile`). The preview origin (`:8091`)
is a separate origin with its own restrictive CSP; game content is never served
from the API origin.

## 6. Client notes

- The web client (`apps/web/src/api/client.ts`) reads the base URL from the
  **build-time** variable `VITE_API_URL` — no secrets ever leave the browser.
- On network loss, the SSE client reconnects with exponential backoff and
  `Last-Event-ID` replay — see `apps/web/src/api/sse.ts`.
- `409` on file save → show the conflict dialog (reload theirs / overwrite
  mine / diff). `429` → honor `retry-after`.
