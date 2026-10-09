# SECURITY_NOTES.md — GameForge AI Studio

**Date:** 2026-10-09 (Phase 7 hardening pass)
**Rule:** no security theater. A control is listed as *implemented* only if a
test or a direct code read in this pass proves it. Anything else is marked
*pending-Oracle* (needs the live stack) or *residual*.

## 1. Dependency audit — 2026-10-09

`npm audit` **could not run in this environment**: the sandbox's npm registry
proxy returns `403 policy_denied` for the audit endpoint
(`POST /-/npm/v1/security/audits/quick`). This is an environment limitation,
not a clean bill of health. **The audit MUST be re-run on the Oracle host**
before production traffic:

```bash
cd ~/gameforge-ai-studio
npm audit --omit=dev
```

What was done instead (verifiable here):

- `npm outdated` across the workspace: every dependency is on its pinned
  major and `wanted == current` everywhere except `@fastify/swagger`
  (`9.9.1` → `9.9.2`), which was upgraded as a patch bump. API suite still
  88/88 after the upgrade.
- No major-version upgrades were taken (deliberate: majors change behavior;
  they are a maintenance task with their own test run, not a hardening
  drive-by).
- `playwright` is an *optional* peer of `@gameforge/test-runner` and is
  intentionally absent from this VM — browser tests are an Oracle-gated step
  (see `docs/ACCEPTANCE_REPORT.md`).

## 2. Controls implemented in this pass (all test-backed)

| Control | Where | Test |
|---|---|---|
| Security headers at the API layer (nosniff, DENY framing, strict referrer, restrictive CSP fallback) | `apps/api/src/security.ts` | `test/security.test.ts` — headers |
| CORS: env allowlist only; `*` refused in prod at boot; no credentials; preview origin `:8091` gets no ACAO | `apps/api/src/server.ts` | CORS block (4 tests) |
| Tiered rate limits: 20/min management (`/plugins`, `/improvements`), 60/min other writes, 429 + `Retry-After`, env-tunable | `apps/api/src/security.ts` | rate-limit block (3 tests) |
| Request timeout (default 30 s, 503 + `Retry-After`), SSE streams exempt | `apps/api/src/security.ts` | timeout test |
| Slow-request logging (≥1 s, structured, secret-redacted) | `apps/api/src/security.ts` | — (log-level, manual) |
| SSE bounds: ≤8 streams/run, ≤64 global (429s), replay capped at 500 events/poll, 15 s heartbeat, `nosniff` on the stream | `apps/api/src/routes/runs.ts` + `SseGuard` | SseGuard unit tests |
| Agent actors forbidden on plugin install/enable/disable and on all improvement mutations | pre-existing; re-verified | actor-enforcement tests |
| JSON body cap 10 MB (413 `payload_too_large`); multipart 10 MB/file | pre-existing; tested | body-limit tests |
| Error envelope never leaks stack traces / key material; pino redaction + `globalRedactor` on secrets | pre-existing; tested | 500-leak test |
| Redaction registered at boot (`GROQ_API_KEY`, `DATABASE_URL`, `REDIS_URL`) | `apps/api/src/redact.ts` | log line shows `<redacted>` |
| Backup + restore scripts (checksum-verified, reversible, refuse without env) | `infra/backup/` | syntax + refusal verified |

## 3. Verified by code read (not unit-testable here)

- Vault `0600` + deny-mount for runners: enforced in the runner spec and the
  compose file (no Docker socket on api/worker; runners are non-root,
  `--cap-drop=ALL`, `--network none` by default). **Live container behavior
  is pending-Oracle** — the spec is typed and reviewed, but a spec is not a
  running container.
- Preview origin isolation: separate origin `:8091`, own CSP, sandboxed
  iframe from the studio UI. The API's CORS layer independently denies the
  preview origin (tested).
- `GET /settings` / `GET /models` return key *presence*, never values
  (verified in route code).

## 4. Honestly pending (Oracle, Phase 7 acceptance)

- `npm audit` with a reachable registry (see §1).
- Live container escape / network-isolation / secret-reachability tests.
- TLS issuance + firewall + private-access boundary (VPN/Tailscale) — config
  exists in `infra/deploy/`; the *running* boundary is the operator's step.
- Load behavior of the tiered limiter under real concurrency (in-memory state
  is per-process; with multiple API replicas it is per-replica — documented,
  acceptable for a single-user studio behind one proxy).
- Groq opt-in acceptance (real key, real tokens) — `docs/ACCEPTANCE_REPORT.md`.
