# THREAT MODEL — GameForge AI Studio

**Date:** 2026-10-09
**Scope:** Phase 1 design document. Covers the web architecture derived from the
Genex reverse-engineering (`docs/REFERENCE_ANALYSIS.md` §F12, §5 R1–R5) and the
master prompt §§10, 25, 27. This is a **design-time** threat model: it is written
*before* the code (Phase 7 hardening will re-verify every claim against the
implemented system and update this document).

**Honesty rule (adopted from Genex's engineering discipline):** no security
theater. Every control below is labeled either **[ARCH]** (architectural must —
design mandates it, Phase 7 must verify it) or **[P7]** (verified in Phase 7
hardening). Anything marked *planned* is not a feature yet and must not be
described as working. Residual risks are listed without mitigation — they are
accepted, not solved.

---

## 1. Assets and trust zones

### 1.1 Assets (what we protect)

| # | Asset | Why it matters | Worst-case impact |
|---|---|---|---|
| A1 | **Groq API key** | Billed by the token; the single credential that turns the app into a spending device | Key theft → attacker burns the user's Groq quota/budget; prompt data exposed to attacker |
| A2 | **User's game source + project history** | The user's actual work product (git repos under backend storage) | Theft, tampering, or silent corruption; loss of IP |
| A3 | **Agent run state & Studio Memory** (Postgres) | Contains prompts, design decisions, failed approaches, conversation content | Data breach of user ideas/text; poisoned memory degrading future runs |
| A4 | **Server host** (Oracle Linux) + sibling services | Co-tenants of the same machine (Postgres, Redis, vault, SSH, Docker) | Full host compromise = everything above + pivot to the user's Oracle account |
| A5 | **Groq budget / wallet** | Usage is pay-per-token; an agent loop can spend unboundedly | Runaway agent = real money loss |
| A6 | **Browser session integrity** (Vercel frontend, SSE streams) | Where the user observes and approves agent work | UI spoofing / confused-origin = attacker triggers state-changing API actions |
| A7 | **Build artifacts & exports** | Downloaded by the user; may embed secrets if scanned poorly | Secret leakage into ZIP files |
| A8 | **Plugin code** (user-trusted, not system-trusted) | Runs with elevated capability relative to generated code | Malicious/buggy plugin escapes its sandbox → host |

### 1.2 Trust zones

Adapted from Genex's zone table (REFERENCE_ANALYSIS.md §F12; GENEX_DESKTOP_NOTES.md §12).
"Trusted" here means trusted *by the system design* — never trusted by the network.

| Zone | Trust | Description | May NOT touch |
|---|---|---|---|
| **User's browser (studio UI)** | **Untrusted** | React SPA on Vercel. Render-only: no secrets, no direct DB/queue access; all calls go through the typed `/api/v1` REST/SSE surface. | Secrets (never rendered), Postgres, Redis, runner containers, vault |
| **Vercel edge / CDN** | Untrusted hosting surface | Static assets + SPA shell only. No server functions holding secrets; the backend URL is a public env var (that is fine — it is an address, not a secret). | Backend secrets, Groq key |
| **Reverse proxy (TLS termination)** | Trusted infra | nginx/traefik on the Oracle host. TLS, rate limits, IP allowlist, mTLS/basic-auth when the access boundary requires it. | Application secrets (passes through only) |
| **Fastify API process** | Trusted | REST + SSE, zod-validated, typed routes. Holds the run orchestrator. No generated code runs here. | Untrusted content only enters through validated parsers |
| **BullMQ worker processes** | Trusted, but agent-controlled | Executes planner/builder/judge logic; issues tool calls. Isolated from the API process (separate process/container). The LLM's instructions arrive as *data*; tools are validated structured calls — the worker must never hand an unquoted LLM string to a shell. | Raw shell with unvalidated args; direct Postgres writes outside the ORM/repository layer |
| **Runner containers** (untrusted code execution) | **Untrusted by design** | Rootless, non-root user, no privileged containers, no Docker socket, read-only rootfs where practical, CPU/RAM/pid/timeout quotas, writable scratch only, restricted network, no Postgres/Redis/cloud-metadata access, per-run logs, auto cleanup. This is the **single execution gate** for: file edits, dependency installs, builds, tests, preview serving, Blender, plugin backends. | Host filesystem, secrets, sibling containers, internal service networks, internet (default deny) |
| **Postgres** | Trusted data store | Durable state: projects, files metadata, revisions, conversations, runs, events, builds, assets, memories, audit events. | Never reachable from runner containers or the browser |
| **Redis** | Trusted queue/messaging | BullMQ job payloads and SSE state. | Never reachable from runner containers or the browser |
| **Server-side secret vault** | Trusted | Encrypted-at-rest store for GROQ_API_KEY and future provider keys. Filesystem dir with `0600` perms, readable only by API/worker OS users; **on the container deny-mount list** so no runner can read it. | Must never appear in logs, events, artifacts, exports, or API responses |
| **Preview origin (game pages)** | **Untrusted web content** | Separate origin from the studio UI; sandboxed iframes, restrictive CSP; preview builds receive no API secrets and no backend access. Authoritative verification happens in server-side headless Chromium, not in this origin. | Studio origin, API endpoints (except the narrowly scoped `__studio` reporting channel), cookies |
| **Plugin backends** | **User-trusted, system-untrusted** | Run in the same runner containers as untrusted code (this is *stronger* than Genex, which trusted plugin backends as native code — we deliberately do not follow that part). Capability-declared, ≤N allowed hosts, install/enable only by the user, never by an agent. | Anything outside their declared capabilities; the vault |

---

## 2. Threat enumeration

Numbered T1–T14. Each: threat → affected assets → severity (High/Med/Low under the
assumption that the access boundary holds; notes where it doesn't).

### T1 — Prompt/LLM-originated attacks
**Sub-cases:**
- **T1a. Malicious tool-call arguments:** the model emits crafted arguments (path traversal
  strings, oversized payloads, shell metacharacters) in tool calls. Affects all zones the
  worker can reach.
- **T1b. Exfiltration via generated code:** generated game code is not "user code" — it is
  model output that later *runs*. An attacker who can influence the model (poisoned
  training data, prompt injection through fetched web content, malicious plugin tool
  descriptions) can plant code that, when built/tested, attempts DNS exfiltration,
  phone-home beacons, or crypto mining inside the runner.
- **T1c. Prompt injection into agent context:** fetched pages (asset-library searches,
  `fetch_public_page`-style tools, imported README/plugin manifests) contain embedded
  instructions ("ignore previous instructions and…") that get rehydrated into agent
  context as data but read as commands by the model.

Severity: **High** (T1b → A4 host/crypto-mining; T1a → A2/A3 data tampering).

**Controls (mitigations):**
- **[ARCH]** All tool arguments validated with **zod schemas** at the tool boundary;
  paths realpath-validated against the per-run workspace root (`containedReal` discipline,
  ported from Genex `substrate/paths.ts`); sizes and string lengths bounded.
- **[ARCH]** Tool calls are allowlisted and use **validated structured arguments** —
  never unrestricted shell. The worker subprocess gate rejects anything that looks like
  shell composition (blocklist on `;`, `&&`, `||`, backticks, `$(`, redirects in args).
- **[ARCH]** The runner container has **default-deny network** (allowlist empty at rest;
  the *only* openings are `registry.npmjs.org` during the bounded `npm install` phase —
  the same documented residual risk Genex accepts — and any user-approved per-run
  allowlist entries recorded in the audit trail). DNS exfiltration is covered by the same
  deny; containers cannot reach cloud metadata endpoints (`169.254.169.254` blocked at
  the container network level).
- **[ARCH]** Injected-content hygiene: fetched third-party content is wrapped and
  labeled as *untrusted data* in the agent context (never silently concatenated as
  instructions); the orchestrator re-validates tool outputs against expected schemas.
- **[ARCH]** Build artifacts are produced by the runner, but **served** only after the
  pipeline marks them `verified`/`partial`; `partial` and `failed` builds are labeled as
  such in the UI (never silently presented as working — Genex's honesty rules, §F11/F12).

### T2 — Container escape / privilege escalation
**Threat:** kernel or container-runtime zero-day, misconfigured volume mount,
privileged flag, or Docker socket exposure lets generated code reach the host or
sibling services (Postgres, Redis, vault, SSH agent).
Severity: **High** (→ A4, then everything).

**Controls:**
- **[ARCH]** Rootless containers; non-root dedicated user; **no privileged containers**;
  **no Docker socket mounted** into runners; read-only rootfs where practical; writable
  scratch only; drop all Linux capabilities; `no-new-privileges`; seccomp default profile.
- **[ARCH]** Resource quotas: CPU shares, RAM limit, pid limit (prevents fork bombs),
  storage quota, **execution timeouts** (build 5 min / install 10 min, mirroring Genex's
  timeouts).
- **[ARCH]** Network isolation: runners on an isolated container network with **no route
  to Postgres/Redis** or cloud metadata; egress default-deny (see T1).
- **[ARCH]** The vault directory and secret env files are **deny-mounted** (not just
  "not mounted" — explicitly blocked in the runner spec so a spec edit can't silently
  weaken it).
- **[ARCH]** Runner spec is a typed document; per-run overlays may only **add**
  restrictions, never remove them (Genex's "overlays can only add denies" rule).
- **[P7 — PARTIAL, 2026-10-09]** What runs without Docker is tested (traversal,
  unsafe args, request limits, cancellation of API-side jobs, malformed tool
  calls — `apps/api/test/security.test.ts`, 18/18). Network isolation, secret
  reachability from inside a workload container, and the cancellation kill-tree
  need the live stack → **pending-Oracle** (see `docs/ACCEPTANCE_REPORT.md`).

### T3 — SSRF (server-side request forgery)
**Threat:** a `fetch`-capable tool (`fetch_public_page`-style, asset import from URL,
webhook targets, plugin network hosts) is pointed at internal addresses:
`127.0.0.1`, `169.254.169.254`, or the private Postgres/Redis/VPN subnets.
Severity: **High** (→ A3/A4/A1 via metadata creds).

**Controls:**
- **[ARCH]** URL validation at the tool boundary: scheme must be `https:` (http only for
  explicit localhost preview loopback); hostname must resolve to a **public** IP
  (resolve-then-check: reject RFC1918, loopback, link-local, multicast, and the
  `169.254.0.0/16` metadata range); DNS rebinding defense via resolve-at-validation +
  no-redirect-to-private (redirects re-validated).
- **[ARCH]** Plugins declare ≤N network hosts (Genex: ≤32); requests outside declared
  hosts are refused.
- **[ARCH]** Fetch tools run **inside the runner container**, not in the worker process —
  so even a validator miss faces container network isolation as a second layer.

### T4 — Path traversal
**Threat:** `../../../` in project-file API params, ZIP export/import entries, plugin
install paths, or asset upload names writes outside the project root — reading the
vault, overwriting sibling projects, or planting files in the host.
Severity: **High** (→ A1/A2/A4).

**Controls:**
- **[ARCH]** Canonicalize + realpath-check every path against the project/workspace root
  before any file operation (Genex `containedReal` port). Reject (never silently
  normalize-away) any path escaping the root.
- **[ARCH]** ZIP import: extract with entry-name validation (reject absolute paths,
  `..`, symlinks, device files); size caps per entry and total (decompression-bomb
  defense, see T5); file-count cap.
- **[ARCH]** Export ZIP **excludes** hidden files, `.env`, keys, `node_modules` symlinks
  (Genex's exclusion list, §F13); secret scan before packaging.
- **[ARCH]** Plugin installs: prebuilt directory + `plugin.json` manifest; **no archive
  extraction into arbitrary paths** (Genex's "no npm install, no build hook, no archive
  extraction" rule, §F10).

### T5 — Upload / asset abuse
**Threat:** decompression bombs (tiny zip → GiB output), polyglot files (valid PNG +
  valid JS/HTML → stored XSS when served), oversized files exhausting disk, MIME
  confusion on preview.
Severity: **Medium** (→ A4 disk exhaustion; → A6 stored-XSS if previews serve attacker
bytes with wrong content-type).

**Controls:**
- **[ARCH]** Size caps: per-file (e.g. 16 MiB stills / 100 MiB previews, mirroring Genex)
  and total project quota; streamed decompression with output-size guard; request-size
  limits on all upload routes.
- **[ARCH]** Content validation by magic bytes, not extension; **SVG sanitized**
  (strip scripts/event handlers); GLB validated as binary glTF before preview.
- **[ARCH]** Assets stored **content-hashed** in the asset store (dedupe + no
  attacker-chosen filenames on disk); metadata in Postgres.
- **[ARCH]** Preview serving: attacker-controlled files served with
  `Content-Type` matching validated type and `Content-Disposition`/sandboxed origin;
  never serve user bytes as `text/html` from a trusted origin.

### T6 — Secret exposure
**Threat:** the Groq key (or future provider keys) leaks through: structured logs,
`agent_events` payloads, build logs/artifacts, exported ZIPs, error messages returned
to the browser, SSE streams, plugin tool outputs, screenshots/OCR text.
Severity: **High** (→ A1 → A5).

**Controls:**
- **[ARCH]** **Redaction-on-append** (Genex's core discipline, §F3/F12): a secret
  redactor runs on every write path — event log rows, structured logs, run journals,
  build logs, error payloads — *before* persistence. Redaction covers the actual key
  values *and* credential-shaped patterns.
- **[ARCH]** Secrets live only in the vault + process env of API/worker; **never in
  client bundles**; API read endpoints (`GET /settings`, `GET /models`) return key
  *presence/status*, never values (master prompt §21).
- **[ARCH]** Child/container env is **allowlisted**: toolchain basics only;
  credential-shaped env names stripped for any child that doesn't need them
  (Genex `childEnv` port).
- **[ARCH]** Export secret scan: packaging refuses files containing known credential
  values (Genex §F13); also scans for high-entropy token-shaped strings with an
  explicit false-positive escape hatch in the UI.
- **[ARCH]** Error envelopes: server-side detail stays in logs; client-facing errors
  are typed codes + safe messages (never stack traces with env dumps).
- **[P7 — PARTIAL, 2026-10-09]** Verified: 500s return the envelope only (test
  injects a throwing route with fake key material — nothing leaks), pino paths
  + `globalRedactor` redact the real key at boot (observed `<redacted>` in
  logs), export secret-scan refuses secret-shaped content. The full grep of
  *export artifacts + build logs + event stream after a scripted run* needs a
  live run → **pending-Oracle**.

### T7 — Supply chain (npm installs in builds, plugin integrity)
**Threat:** `npm install` pulls typosquatted/malicious packages; a plugin's prebuilt
directory contains obfuscated backdoors; pinned registries get swapped.
Severity: **High** (→ A4 via install scripts; → A8).

**Controls:**
- **[ARCH]** Installs only from `registry.npmjs.org` (pinned), behind an **explicit
  user action** (Genex's "Install packages" button discipline); lockfile respected;
  install phase time-bounded (10 min).
- **[ARCH]** Install scripts (`preinstall`/`postinstall`) run **inside the runner
  container** (already untrusted zone) — a malicious package gets container
  confinement, not host execution.
- **[ARCH]** Plugins: **no auto-execution of downloaded repos**; install only from
  user-provided prebuilt directories; manifest signature/integrity field checked at
  install; **agents can never install or enable plugins** (Genex §F10); enable/disable
  requires a user consent card the agent cannot answer or bypass.
- **[P7 — PARTIAL, 2026-10-09]** `npm audit` is **blocked in the build VM**
  (registry proxy denies the audit endpoint — see `SECURITY_NOTES.md`); it must
  run on the Oracle host before production traffic. `npm outdated` shows all
  deps on pinned majors; one patch bump (`@fastify/swagger` 9.9.1→9.9.2) was
  taken, suite still green. Dependency allowlist for templates: not implemented.

### T8 — DoS / resource exhaustion
**Threat:** runaway build loops (Loop mode without convergence), queue flooding
(malicious or buggy run spawning thousands of jobs), Chromium pool exhaustion,
disk fill from artifacts, memory blow-up in the API process from huge SSE replays.
Severity: **Medium** (→ availability; → A5 cost).

**Controls:**
- **[ARCH]** Execution modes carry **budgets**: iteration budget, wall-clock budget,
  token/request budget per run; Loop mode stops when *any* budget is exhausted or
  progress is unmeasurable (master prompt §8). `Stop` kills owned processes safely;
  `Cancel` drains queued work.
- **[ARCH]** Bounded queues: per-project concurrency cap; max queued jobs; worker
  concurrency derived from **startup resource inspection** (CPU/RAM — master prompt §24).
- **[ARCH]** Chromium pool bounded (single instance by default unless RAM allows more);
  per-test timeouts; screenshots size-capped.
- **[ARCH]** Retention/cleanup: build artifacts and preview dirs have TTL + disk
  watermark eviction; failed builds don't accumulate unboundedly.
- **[ARCH]** Rate limits on API routes (per-IP, per-route tiers); request-size limits;
  SSE replay paginated with stable event IDs.

### T9 — CSRF / confused-origin on state-changing routes
**Threat:** the browser auto-attaches ambient authority; a malicious page (or a
compromised *game preview*) tricks the studio UI session into issuing
`POST /projects/:id/runs`, `DELETE`, plugin enable, etc. Note: there is **no login**,
so the attack surface is about *origin confusion* and *network-reachability*, not
session theft.
Severity: **Medium** (→ A2/A8 integrity actions; low data theft since no cookies carry
privilege — see §5 for why the access boundary matters more than CSRF tokens here).

**Controls:**
- **[ARCH]** `Origin`/`Referer` validation on all state-changing routes (allowlist =
  the studio frontend origin only); `Sec-Fetch-Site: same-origin` enforcement where
  browsers send it.
- **[ARCH]** CORS: **approved origins only** (the Vercel frontend domain); CORS is
  documented as *not* authentication (master prompt §25).
- **[ARCH]** Game previews run on a **separate origin** in sandboxed iframes with a
  restrictive CSP — a malicious game cannot reach the API origin with ambient
  authority (no cookies, no shared origin).
- **[ARCH]** Approval tickets (plugin installs, package installs, destructive actions)
  are **single-use, user-issued, short-TTL** — an agent or a confused deputy cannot
  replay them.

### T10 — Insecure direct object references (IDOR)
**Threat:** `/projects/:id`, `/assets/:id`, `/builds/:id` accept sequential/guessable
IDs; a second user (or a leaked link) enumerates or mutates another project. In the
single-user design the main risk is *cross-project contamination* (an agent acting on
project A writes to project B's ID) and *link leakage* (a shared preview URL becomes
a capability).
Severity: **Low–Medium** (single-user; becomes High if multi-user ever ships).

**Controls:**
- **[ARCH]** Opaque, unguessable IDs (UUIDv7 or equivalent) for projects/assets/builds;
  every mutation checks the ID belongs to the addressed project (scoped queries, never
  bare `WHERE id = ?`).
- **[ARCH]** Preview URLs carry short-lived signed tokens scoped to one build revision;
  no bare enumerable preview paths.
- **[ARCH]** Do not log full IDs in client-visible error messages where avoidable.

### T11 — Malicious/insider with server access
Listed under residual risks (§4) — no in-application control; documented honestly.

### T12 — Log/audit tampering and repudiation gaps
**Threat:** an attacker (or a bug) deletes `audit_events` rows to hide actions;
worker writes events that misattribute agent decisions.
Severity: **Medium** (→ incident response blind).

**Controls:**
- **[ARCH]** Append-only event tables (`agent_events`, `audit_events`): **no UPDATE/
  DELETE grants** to the application DB role; rotation only via a separate retention
  job with its own role.
- **[ARCH]** Events carry: timestamp, actor (user/agent role/plugin id), run/task IDs,
  idempotency keys. Redaction-on-append (§T6) keeps them safe to store.
- **[P7 — DONE, 2026-10-09]** Enforced by migration
  `0004_append_only_audit.sql`: `BEFORE UPDATE OR DELETE` triggers on
  `agent_events` and `audit_events` raise instead of allowing the write
  (trigger-based rather than role grants — equivalent for the single-role
  deployment, and it survives role changes). The application only INSERTs
  (verified by code search). Live verification at first Oracle boot: the
  migrator logs each applied migration and aborts boot loudly on failure.

### T13 — Backups exfiltrated / restored maliciously
**Threat:** DB dumps + file backups contain secrets-in-data (API keys pasted into chat
by the user, private prompts) and become a second copy of every asset; a restored
backup reintroduces a compromised plugin or poisoned memory.
Severity: **Medium**.

**Controls:**
- **[ARCH]** Backups encrypted at rest; stored off the application host; access logged.
- **[ARCH]** Restore is a **user-initiated, explicit** operation with a pre-restore
  snapshot (so a bad restore is itself reversible); memory/plugin tables can be
  restored selectively.
- **[P7 — DONE (scripts+docs), drill pending-Oracle, 2026-10-09]**
  `infra/backup/backup.sh` + `restore.sh` (checksum-verified, reversible,
  refuse without env), full procedure + restore drill in `docs/BACKUPS.md`.
  Executing the drill needs the live stack.

### T14 — AI provider (Groq) side handling of prompts
**Threat:** prompts contain the user's game ideas, pasted secrets, code — all sent to
Groq's API. Groq-side logging/retention/training policies are outside our control.
Severity: **Medium** (→ confidentiality of A2/A3; listed as residual in §4).

**Controls (partial):**
- **[ARCH]** Minimize what is sent: summarization + relevance retrieval (never whole
  histories), per-role context budgets; redaction-on-append applies *before* the
  payload leaves our boundary (keys, not user ideas — be honest: we cannot redact
  the user's own ideas from a request to the model that needs them).
- **[ARCH]** Token accounting + budget alerts make anomalous exfiltration-shaped usage
  visible (a sudden 10× token spike is an observable event in the diagnostics dashboard).
- **[P7 — PENDING]** Vendor DPA/retention terms for Groq are **not yet reviewed
  or recorded**. The first-run UI warning exists in the plan but the docs entry
  does not. Do not claim otherwise.

---

## 3. Control summary (by mechanism)

| Control | Threats | Status |
|---|---|---|
| zod-validated typed API (`/api/v1`) + OpenAPI | T1a, T3, T4 | [ARCH] → verify P7 |
| Runner = rootless containers, single spawn gate, overlays add-only | T1b, T2, T7 | [ARCH] → verify P7 |
| Default-deny egress (npm registry + user-approved hosts only) | T1b, T3 | [ARCH] → verify P7 |
| No Postgres/Redis/metadata route from runners | T2, T3 | [ARCH] → verify P7 |
| Path canonicalization (`containedReal` discipline) | T4 | [ARCH] → verify P7 |
| Env allowlist + credential-shaped stripping for children | T1b, T6 | [ARCH] → verify P7 |
| Redaction-on-append (events, logs, journals, errors) | T6 | [ARCH] → verify P7 |
| Vault `0600`, deny-mounted from runners, never in client bundles | T2, T6 | [ARCH] → verify P7 |
| Separate preview origin + sandboxed iframe + restrictive CSP | T5, T9 | [ARCH] → verify P7 |
| Origin/Referer validation + approved-origin CORS (documented as non-auth) | T9 | [ARCH] → verify P7 |
| Single-use approval tickets (plugins, installs, destructive ops) | T7, T9 | [ARCH] → verify P7 |
| Agents cannot install/enable plugins | T7, T10 | [ARCH] → test P7 |
| Run budgets (iterations, wall-clock, tokens) + safe Stop/Cancel | T8, A5 | [ARCH] → verify P7 |
| Bounded queues + startup resource inspection | T8 | [ARCH] → verify P7 |
| Idempotency keys on side-effecting jobs/tools | T8, crash recovery | [ARCH] → verify P7 |
| Upload caps, magic-byte validation, SVG sanitize, content-hash store | T5 | [ARCH] → verify P7 |
| Export exclusion list + secret scan | T4, T6 | [ARCH] → test P7 |
| Opaque IDs + scoped queries + signed preview tokens | T10 | [ARCH] → verify P7 |
| Append-only audit/event tables (trigger-enforced, migration 0004) | T12 | [P7] done 2026-10-09; live-verify at first Oracle boot |
| Reversible restore (checksum-verified, pre-restore snapshot) | T13 | [P7] done 2026-10-09; drill execution pending-Oracle |
| Backup encryption + off-host copies (operator step, documented) | T13 | Documented in docs/BACKUPS.md; not scripted (keys/destinations are operator secrets) |
| Rate limits + request-size limits on API | T8, T9 | [P7] done 2026-10-09: global 100/min + tiers 20/60/min, 429+Retry-After tested |

---

## 4. What we explicitly do NOT defend against (residual risks)

Documented honestly, Genex-style. These are accepted; listing them is the control.

1. **Malicious insider with server access (T11).** Anyone with SSH/root on the Oracle
   host can read the vault, the DB, and the git repos. No application control survives
   host compromise. Mitigation is operational: SSH key hygiene, minimal accounts,
   and the user understanding that *the server operator is fully trusted*.
2. **Side-channel attacks on the shared Oracle host.** Co-tenant VMs, hypervisor-level
   observation, and cache-timing attacks are outside our threat model.
3. **Zero-days in the container runtime / kernel.** Containers reduce but do not
   eliminate escape risk; a kernel 0-day defeats every control in §3. We track base
   image and runtime updates as maintenance, not as a guarantee.
4. **Groq-side data handling (T14).** Prompts, code, and any pasted secrets are
   processed by Groq under Groq's terms. We minimize and account, but we cannot
   audit their infrastructure.
5. **The user's own mistakes.** Pasting a secret into chat (it will be sent to Groq
   and stored in conversation history — redaction covers *our* keys, not the user's
   pasted ones; the UI warns before first run), approving a malicious plugin, opening
   the API to the public internet (§5), or disabling the VPN.
6. **npm registry compromise.** If `registry.npmjs.org` serves a malicious tarball,
   our pin is to a compromised source. Container confinement is the backstop, not a
   fix. (Same shape as Genex's documented "npm install briefly opens the registry
   process-wide" residual risk.)
7. **Physical / Oracle-account compromise.** If the user's Oracle Cloud account or
   the machine's console is taken over, all bets are off.
8. **Browser 0-days on the user's machine.** The studio UI is a web app; a compromised
   browser sees everything the user sees.

---

## 5. No-login access boundary

### 5.1 Why no login is a deliberate design choice — and why the boundary is mandatory

There is no application login because this is a **single-user personal studio**: adding
accounts, passwords, sessions, and recovery flows would add attack surface (credential
storage, reset flows) for exactly one human. The threat model instead assumes:

> **The API is reachable only over a trusted private path.** Deployment prerequisite
> (not a code feature): VPN, WireGuard/Tailscale-style mesh, SSH tunnel, or Oracle
> private subnet — such that packets reaching the reverse proxy already come from the
> user's devices.

Under this assumption, "no auth" is sound: the network *is* the authentication, and
the application never has to distinguish the user from an attacker because the
attacker cannot reach the socket.

### 5.2 What breaks if the API is exposed publicly

Without the boundary, every one of these is unauthenticated remote:

- `POST /projects/:id/runs` — **remote code execution as a service**: anyone on the
  internet can make the backend generate, build, and run arbitrary code in containers
  (and burn the user's Groq budget doing it → A5 drained in hours).
- `POST /assets/generations`, plugin enable, project delete — integrity and
  availability destruction.
- `GET /projects/:id/export` — exfiltration of the user's entire work product.
- SSE streams — live observation of the user's activity and prompts.
- Groq connectivity test + model registry — oracle for key validity; error messages
  could leak key-presence information useful for follow-up attacks.

**Bluntly: a publicly exposed GameForge backend is a free, anonymous, AI-driven
code-execution and crypto-mining service billed to the user.** The container sandbox
limits host damage but does *not* prevent abuse of the service itself (T8, A5).

### 5.3 Minimum compensating controls if the user insists on public exposure

These are **network/edge controls**, presented honestly as *not application
authentication*:

1. **IP allowlist at the reverse proxy** — only the user's known IPs reach the API.
   Weak on mobile/roaming IPs; better than nothing; log denials.
2. **Mutual TLS (client certificates)** — the proxy requires a client cert the user
   installs on their devices. This is the strongest compensating control: possession
   of the cert ≈ the VPN's device identity. Operational cost: cert issuance, renewal,
   revocation list.
3. **HTTP basic auth at the proxy** — a single shared password checked before any
   traffic reaches Fastify. Resists casual scanning only; the password traverses every
   request, must be long/random, rotated on any suspicion, and is *not* a substitute
   for the VPN. Say this in the docs, not just here.
4. **Fail-closed default**: if none of the above is configured, the install script
   binds the API to localhost/private interfaces only and prints a warning — public
   binding requires an explicit, logged opt-in flag.

None of these create user accounts, sessions, or password recovery — the no-login
design is preserved. But §5.2's warning must ship in the Oracle install guide in
plain language, because the most likely real-world failure is the user exposing the
port "temporarily" and forgetting.

---

## 6. Incident response basics

### 6.1 Detection surface
- **`audit_events`** (append-only): who/what/when for every privileged action —
  plugin install/enable, approval tickets issued/consumed, settings changes, exports,
  restores, budget overrides. The first place to look.
- **Diagnostics dashboard**: queue depth spikes, worker crash loops, token usage
  anomalies, container OOM kills, 4xx/5xx rates, denied-origin attempts at the proxy.
- **Structured logs** (JSON, secret-redacted): API + worker + runner logs with run/task
  IDs for correlation. Logs never contain key material (§T6) — grep-able safely.

### 6.2 Response playbook (short, because the user is the whole SOC)

| Step | Action |
|---|---|
| 1. **Stop the bleeding** | `POST /runs/:id/cancel` for runaway runs; `docker compose stop worker runner` (or systemd equivalents) to halt all execution; revoke at the proxy (IP block) if abuse is remote. |
| 2. **Preserve evidence** | `audit_events` and logs are append-only — copy them *before* any cleanup. Snapshot the project git repos (`git bundle`) before restoring. |
| 3. **Rotate secrets** | Groq key: rotate in the Groq dashboard → update the vault → restart API/worker → run `POST /models/connection-test`. Vault encryption key: rotate via the documented re-encryption procedure, then re-verify redaction tests. Any secret that traversed chat: treat as compromised, rotate at the issuer. |
| 4. **Assess scope** | Which projects/runs were active? Check `build_artifacts` and exports created during the window; run the export secret-scan retroactively on suspicious artifacts. |
| 5. **Recover** | Restore from encrypted backup (reversible: pre-restore snapshot first); re-run the Phase 7 security test suite before re-enabling the runner; re-issue approval tickets (old single-use tickets are dead by design). |
| 6. **Learn** | Write the incident up in `docs/` with the same honesty as §4; add a regression test; if an agent instruction contributed, route it through the SkillOpt gate (auto-apply stays off). |

### 6.3 Backup / restore integrity
- Backups cover **Postgres dumps + project git repos + asset store + vault** (encrypted
  at rest, off-host, access-logged). Large media lives in the content-hash asset store,
  not in DB rows — backups must capture the store or restores will dangle.
- Restore is explicit and reversible (pre-restore snapshot); memory and plugin tables
  restorable independently so a poisoned memory or bad plugin doesn't have to come back.
- Integrity: checksums recorded at backup time; restore verifies before swapping live
  data. A restore drill is part of the Oracle install guide (P7).

---

## 7. Mapping to the master prompt

| Master prompt section | Covered here |
|---|---|
| §10 Secure code execution | T1, T2; runner zone in §1.2; control table §3 |
| §25 Security without login | §5 (boundary), T9, §3 (CORS/proxy) |
| §27 Security tests | Referenced per-threat as [P7] verification |
| §22 DB design (`audit_events`) | T12; §6.1 |
| §21 Settings (no key exposure) | T6 |
| §26 Deployment (VPN, firewall, volumes) | §5, §6.3 |
| §17 Self-improvement safety | T1c, incident step 6 (SkillOpt gate; agent instructions can never override security policy) |
| §18 Plugins | T7; plugin zone in §1.2 |

---

*Next: Phase 7 re-verifies every [ARCH] claim against the implemented system; any
control that fails verification is moved to "Partially implemented" or "Not
implemented" in FEATURE_MATRIX.md with a dated note here. This document must never
describe a planned control in the past tense.*
