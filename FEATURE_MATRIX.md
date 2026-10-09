# FEATURE_MATRIX — GameForge AI Studio

**Date:** 2026-10-09 · **Updated:** phase by phase.
**Status legend:** ✅ Implemented and verified · 🔶 Implemented but not verified ·
◐ Partially implemented · ❌ Not implemented · ⛔ Blocked by an external dependency

> Rule: no fake features. A row moves from ❌ only when the acceptance check in its
> row actually passes. "Verified" means an automated test or a documented manual
> verification — never a model-generated assertion.
>
> **Phase 3 status (2026-10-09):** the minimum complete workflow is built and
> unit-verified — 182 tests green across the workspace (shared has no test
> files: types/schemas only). New in Phase 3: 8 playable game templates with
> the `window.__studio` contract (44/44 determinism tests), the 15-phase build
> pipeline + visual-evidence gathering (33/33), the Cloudflare-backed director agent
> with tool loop (11/11), the Vite/React PWA frontend (13/13 + `vite build`),
> worker↔director↔pipeline wiring (worker 12/12), preview origin on :8091
> serving verified builds with strict CSP (4/4 new API tests), source-ZIP
> export with secret scan (refuses on secret-shaped content), and
> message→run + question→answer→resume wiring in the API (21/21).
> A real pipeline dry-run against arcade-2d was executed: validation, skips,
> preview server, honest chromium-unavailable failure, verdict, and persist all
> behaved as designed. Live-service rows (Docker/Postgres/Redis/Chromium/Cloudflare)
> remain 🔶 until Oracle (Phase 7).

## §2 Non-negotiable technical requirements — Frontend

| Requirement | Status | Notes / target |
|---|---|---|
| Vite + React + TypeScript | ✅ | 13/13 tests + vite build green |
| Responsive (mobile/tablet/desktop) | ✅ | Audited at 390px: no page-level horizontal scroll, ≥44px touch targets, mobile tab bar + bottom-sheet drawer |
| PWA (manifest + icons + service worker) | ✅ | registerType prompt; never force-reloads mid-run |
| Vercel deployment | ❌ | Phase 7; deploy is Jon's (standing rule) |
| Vercel Analytics (@vercel/analytics) | ✅ | Mounted once in App |
| Dark mode default + optional light | ✅ | Class strategy, persisted, no flash |
| No login / registration / accounts | ✅ | By design; enforced in review |
| No third-party auth | ✅ | By design |
| UI language EN/ES switchable (EN default) | ✅ | 109 keys, parity test fails CI on mismatch |
| Accessibility + keyboard navigation | ✅ | role=tree/treeitem file explorer, Esc closes drawer, Ctrl/Cmd+S save, "/" focuses composer, skip-safe focus states |
| High-performance rendering | ❌ | Profiler budgets Phase 7 |
| Auto-reconnect after network loss (SSE replay) | ✅ | Last-Event-ID replay + exponential backoff |

## §2 Backend

| Requirement | Status | Notes / target |
|---|---|---|
| Node.js LTS + TypeScript | 🔶 | Code complete, strict TS; live run on Oracle Phase 7 |
| Fastify REST API | 🔶 | Routes + OpenAPI + SSE implemented, 16/16 inject tests; live test Phase 7 |
| PostgreSQL persistent data | 🔶 | 23-table migrations written + statically validated; not applied live yet |
| Redis + BullMQ durable queues | 🔶 | Queues + worker implemented, mocked tests; live recovery test Phase 7 |
| Docker/rootless containers for isolation | 🔶 | Runner implemented, fail-closed verified (no Docker here); container runs on Oracle Phase 7 |
| Git project version history | 🔶 | Real git init/clone in API; per-project repos live on Oracle |
| Playwright + Chromium automated testing | 🔶 | Pipeline + evidence implemented 33/33; browser runs on Oracle |
| Blender headless where supported | ⛔ | Phase 6; **blocked**: needs Oracle instance inspection (OS/arch/RAM) — adapter stays disabled with explanation if unsupported |
| Structured logging | 🔶 | pino JSON logging in API/worker |
| OpenAPI documentation | 🔶 | Served at /api/v1/openapi.json + /docs UI; live review Phase 7 |
| systemd lifecycle | ❌ | Phase 7 (unit files) |
| Reverse proxy + HTTPS | 🔶 | Caddyfile written (main + preview origins); `caddy validate` + TLS on Oracle Phase 7 |
| Works with frontend closed | ✅ | By design: runs live server-side via BullMQ |

## §2 Artificial intelligence (Cloudflare Workers AI)

| Requirement | Status | Notes / target |
|---|---|---|
| Cloudflare Workers AI as the LLM provider | 🔶 | CloudflareClient complete, 44/44 mocked tests; live credential test is opt-in on Oracle |
| Key via server env only, never client-side | ✅ | By design; redactor registered at boot; enforced in review |
| Startup model discovery + capability inspection | 🔶 | ModelRegistry.refresh() from the account model catalog; live run on Oracle |
| Configurable model per role (planning, codegen, review, reasoning, orchestration, vision, summarization, memory) | 🔶 | Registry + settings.modelByRole; role wiring Phase 4 |
| Model capability registry + compatibility checks | 🔶 | Implemented; curated table date-stamped 2026-10-09, must re-verify |
| No hardcoded/deprecated model names | ✅ | By design; selection is capability-filtered; enforced in review |
| Rate limiting, token accounting, exp. backoff, bounded retries, timeouts, cost/request budget | 🔶 | Implemented + tested with mocks; live behavior on Oracle |
| No fabricated LLM responses for production | ✅ | By design; enforced in review |
| Vision review only with verified image-capable model | ✅ | `verifyVisionModel()`: selectModel(requiresVision) → live vision probe; only a passing probe labels reviews `verified`; ⛔ live vision-capable model itself confirmed at Oracle startup |

## §3 Reverse engineering

| Requirement | Status | Notes |
|---|---|---|
| Clone Genex repos to research dir | ✅ | `research/genex-desktop`, `research/genex` |
| Read LICENSE/README/AGENTS.md/package.json + docs + source | ✅ | Two research agents, notes in `research/notes/` |
| docs/REFERENCE_ANALYSIS.md (15 features, evidence, proposals, limitations, acceptance) | ✅ | Delivered 2026-10-09 |
| Verified vs inferred distinguished | ✅ | Tagged throughout |
| MIT notices preserved; proprietary services/brands avoided | ✅ | §0 of the analysis |

## §4 Product experience

| Requirement | Status | Notes / target |
|---|---|---|
| Desktop 3-pane studio layout, resizable panels, collapsible nav | ✅ | 3-pane desktop grid; collapsible nav; mobile single-pane tabbed layout |
| Lucide icons, restrained palette, skeleton loading, reduced-motion | 🔶 | Lucide + restrained zinc/cyan palette done; skeleton loading + reduced-motion not yet |
| Mobile: tabs/drawers/full-screen preview; create/submit/monitor/play/assets/builds | ✅ | Tabs, bottom-sheet drawer, settings/gear reachable on all viewports |
| No dead buttons / decorative controls | ✅ | By design; enforced per-phase review |

## §5 Dashboard & project management

| Requirement | Status | Notes / target |
|---|---|---|
| Dashboard (games, thumbnails, status, engine, last revision, recent, active runs) | ❌ | Phase 3 |
| New/Open/Rename/Duplicate/Archive/Delete (confirm)/Export/Download/Import/Restore | ❌ | Phase 3 (delete = archive + grace) |
| Backend persistence (localStorage never authoritative) | ❌ | Phase 2/3 |
| 8 functional starter templates (working code, three.js primary, Rapier/Phaser/Pixi where apt) | ❌ | Phase 3 |
| No Unity/Unreal advertised without validated integration | ✅ | By design (Genex retired Unity too) |

## §6 Natural-language game generation (17-step pipeline)

| Requirement | Status | Notes / target |
|---|---|---|
| Interpret objective → plan → tasks → assign → generate → validate → build → isolated browser test → checks → visual evidence → review → bounded correction → preview → history | ❌ | Phase 3 (vertical slice), hardened Phase 4 |
| Never mark complete from LLM output alone; explicit incomplete-verification reporting | ✅ | By design; build verdicts are verified/partial/failed |

## §7 Multi-agent architecture

| Requirement | Status | Notes / target |
|---|---|---|
| Director agent | ❌ | Phase 3 (basic), Phase 4 (full) |
| Gameplay / Scene-Visual / UI / Asset / QA agents | ❌ | Phase 4 |
| Reviewer agent (independent, vs acceptance criteria) | ❌ | Phase 4 |
| Per-role: prompts, models, tool permissions, timeouts, iteration limits, token budgets, result schemas | ❌ | Phase 4 |
| Agents as genuine execution units (tools, read results, structured decisions) | ❌ | Phase 2 (tool loop), Phase 4 |

## §8 Execution modes

| Requirement | Status | Notes / target |
|---|---|---|
| Manual / Auto / Loop modes | ❌ | Phase 3/4 |
| Loop budgets (iterations, time, model, measurable progress, user stop, no unresolved blocker) | ❌ | Phase 4 |
| Start/Pause/Resume/Stop/Cancel queue/History/Inspect step | ❌ | Phase 4 |
| Stop terminates owned processes safely; persisted state; resume without repeating completed external ops | ❌ | Phase 4 |

## §9 Durable job orchestration

| Requirement | Status | Notes / target |
|---|---|---|
| PostgreSQL durable run state + BullMQ scheduling | 🔶 | Implemented + mocked tests; live crash-recovery test on Oracle Phase 7 |
| Explicit states: queued/planning/running/waiting_for_user/building/testing/reviewing/completed/failed/canceled/interrupted | 🔶 | Typed enums + CHECK constraints; transitions tested |
| Deterministic IDs + idempotency keys | ✅ | ULID ids; run create dedupes by key (tested) |
| Crash-safe: task payload, agent identity, steps, artifacts, logs, errors, retries, usage, checkpoints | 🔶 | Journal + events schema done; worker skeleton resumes-not-replays (mocked) |
| SSE/WebSocket progress with reconnect + replay (stable event IDs) | ✅ | SSE with Last-Event-ID replay + exponential backoff; live browser test on Oracle Phase 7 |

## §10 Secure code execution

| Requirement | Status | Notes / target |
|---|---|---|
| Isolated container runner (non-root, no privileged, no docker socket, no host secrets, read-only rootfs, quotas, timeouts, restricted network, no DB/Redis/metadata access, auto-cleanup, per-run logs) | 🔶 | Implemented; fail-closed verified; real container runs on Oracle Phase 7 |
| Narrow orchestrator↔runner interface; separated privileges (edit/install/build/test/publish/delete) | 🔶 | Capability enum + per-capability image allowlist; HTTP binding Phase 3 |
| No arbitrary host commands for the LLM; validated structured tool args; no unrestricted shell as default capability | ✅ | By design; zod-validated specs; enforced in review |

## §11 Game build pipeline (15 phases)

| Requirement | Status | Notes / target |
|---|---|---|
| Validate → install → typecheck → unit → bundle → preview server → Chromium smoke → console/network → gameplay smoke → screenshots → acceptance → verdict → persist | ✅ | 15 phases implemented in test-runner, 33/33 tests; Chromium step fails cleanly where unavailable |
| Build record (ID, revision, timestamps, run, status, tests, screenshots, logs, artifacts, resources) | ✅ | Persisted by worker; exposed via builds + tests/reviews/artifacts diagnostics endpoints |
| Last-known-good build survives failed builds | ✅ | Shadow builds + last-known-good retention in worker |

## §12 Live game preview

| Requirement | Status | Notes / target |
|---|---|---|
| Play/Stop/Reload/Fullscreen/Mute/Keyboard focus/Touch/Viewport presets/FPS/Resolution/Errors/Revision/Loading | 🔶 | Preview panel with play/reload/open-standalone; build drawer shows phase errors + revision; viewport presets not done |
| Separate preview origin; sandboxed iframe + restrictive CSP; no API secrets in preview | ✅ | Preview on :8091; opaque sandbox="allow-scripts" iframe; restrictive CSP |
| WebGL required; WebGPU progressive; fallback for unsupported browsers | ❌ | Not yet |

## §13 Live code editor (Monaco)

| Requirement | Status | Notes / target |
|---|---|---|
| File tree, syntax highlight (TS/JS/JSON/CSS/HTML/MD), search, diff, save, format, error highlight, revision view/restore | ✅ | Monaco: tree + search + save + DiffEditor + revision view; error highlight via Monaco; no auto-format wired yet; restore not implemented |
| Optimistic concurrency (no silent overwrites); checkpoint before agent edits; side-by-side diffs | ✅ | SHA expectedSha → 409 with currentSha; conflict dialog (reload theirs / overwrite mine / diff) |

## §14 Asset manager

| Requirement | Status | Notes / target |
|---|---|---|
| Categories, upload/drag-drop, search/filters, thumbnails, properties, license metadata, usage refs, rename/replace/safe-delete/download | ✅ | Upload + drag/drop + two-step delete + download + filters + kind icons (no thumbnails: list carries no file URL); license metadata + usage refs not yet |
| 3D viewer (rotate/zoom/lighting/animation), lazy loading, size caps | ❌ | Phase 5 |
| Host-owned delivery records; unconfirmed/integrated/verified ladder | ❌ | Phase 5 |
| Provider architecture: mandatory baseline (procedural three.js, canvas textures, open-licensed import, upload); optional (Blender, third-party APIs) with capability detection; unavailable = shown unavailable | ❌ | Phase 5/6 |
| Never claim the AI provider generates 3D/music/video | ✅ | By design |

## §15 Blender integration

| Requirement | Status | Notes / target |
|---|---|---|
| Headless Blender on Oracle: procedural geometry, transforms, materials, GLB export, animation, optimization; isolated jobs; CPU-compatible bounded | ⛔ | Phase 6; **blocked**: Oracle OS/arch/RAM inspection first — adapter disabled + transparent explanation if unsupported |

## §16 Visual review system

| Requirement | Status | Notes / target |
|---|---|---|
| window.__studio instrumentation contract + CDP evidence pipeline | ✅ | Contract enforced across 8 templates (44/44 determinism tests); 15-phase pipeline with evidence (33/33) |
| Playwright: start, readiness, screenshots, blank detection, console errors, failed assets, viewport, scripted inputs | ✅ | Implemented; fails cleanly where Chromium unavailable (no fake pass) |
| Structured review (criterion/result/confidence/evidence/issue/recommendation/retest) linked to build revision | ✅ | Blind A/B reviewer, Phase 4 |
| Semantic review only with verified vision model; else deterministic + labeled unverified | ✅ | `visualReview` pipeline phase: selectModel(requiresVision) → live probeVisionSupport() → semantic review with judge_model recorded; any other path saves an `unverified` row with the explicit reason; deterministic checks continue regardless |

## §17 Self-improvement & memory

| Requirement | Status | Notes / target |
|---|---|---|
| Postgres memory: project / studio / run scopes | ✅ | Phase 4; retrieval salience+recency+keywords |
| Summarization + relevance retrieval (no full histories in prompts) | ✅ | Phase 4; retrieval failure degrades to no memories |
| Memory versioning + inspectability | ✅ | Versioned API writes; supersede chain |
| SkillOpt-style proposals: versioned candidates, comparison tests, evidence gate, approval/promotion, rollback; auto-apply OFF default; never override security policy | ✅ | `/api/v1/improvements`: propose→approve→apply→(prompt: activate with gate evidence)→rollback; evidence must reference real builds/reviews; agents can never approve; code diffs staged for manual review, never executed |

## §18 Plugin system

| Requirement | Status | Notes / target |
|---|---|---|
| Manifest (name/version/publisher/description/capabilities/tools/env/permissions/compat); prebuilt dir; isolated panels; enable/disable/config/status/logs/compat/remove | ✅ | Manifest schema + registry + tool protocol + panel CSP bridge; enable/disable human-only endpoints (403 for agents) |
| ≥2 working example plugins + developer docs | ✅ | procedural-geometry (deterministic seeded meshes) + asset-thumbnail (real PNG thumbnails); plugins/README.md. Blender example deferred to Phase 7 (needs Oracle OS/arch/RAM inspection first) |
| Agents can never install/enable plugins; user-approved only; no auto-execution of arbitrary repos | ✅ | By design |

## §19 Version control

| Requirement | Status | Notes / target |
|---|---|---|
| Git per project; auto-checkpoints before agent edits; build↔commit link; compare/restore; last-known-good; ZIP export | ❌ | Phase 3 |
| No concurrent uncoordinated edits; branches/worktrees; validated merges only; never silently overwrite user edits | ❌ | Phase 3/5 |

## §20 Activity & observability

| Requirement | Status | Notes / target |
|---|---|---|
| Activity panel (jobs, decisions, tools, builds, tests, model calls, errors, retries, pauses, completions) with timestamps + IDs | ❌ | Phase 5 |
| Diagnostics (backend/DB/Redis/workers/queue/containers/disk/mem/CPU/failures/AI usage/latency) | ❌ | Phase 5 |
| No secrets in logs | ✅ | By design (redaction-on-append) |

## §21 Settings

| Requirement | Status | Notes / target |
|---|---|---|
| Backend status, per-role models, AI provider connectivity test, defaults, limits, budgets, storage, preview, language, theme, sound, confirmations, plugins, memory, export | ✅ | Settings page: theme, language, model-per-role table, read-only API URL; key values never served |
| No key values via read endpoints; persist across restarts | ✅ | By design; verified in review |

## §22 Database design

| Requirement | Status | Notes |
|---|---|---|
| Normalized schemas (22 tables), migrations, indexes | ✅ | docs/DATABASE.md (design); ❌ implementation Phase 2 |
| No large binaries in rows; FS/object store + metadata; deletion policies; backup/restore strategy | ✅ | Design done; ❌ implementation Phase 2/7 |

## §23 REST API (/api/v1)

| Requirement | Status | Notes / target |
|---|---|---|
| System/Projects/Conversations/Runs/Builds/Assets/Models/Plugins/Settings/Memory route groups | 🔶 | All implemented incl. plugin management + improvement proposals; live test Phase 7 |
| Pagination, filtering, error schemas, validation, status codes, OpenAPI, HTTP test collection | 🔶 | Envelope + zod validation + OpenAPI served; HTTP collection Phase 7 |

## §24 Backend performance

| Requirement | Status | Notes / target |
|---|---|---|
| Startup resource inspection → safe concurrency; disable heavy caps when unsupported | ❌ | Phase 2 |
| Async API, bounded queues, separate api/worker, streaming, efficient queries, pagination, lazy assets, build caching, hash dedup, retention/cleanup | ❌ | Phase 2/3 |
| No browser/Blender in API process; bounded Chromium instances | ❌ | Phase 2 |

## §25 Security without login

| Requirement | Status | Notes / target |
|---|---|---|
| Infrastructure access boundary (VPN/private) for admin + backend | ❌ | Phase 7 (deployment prerequisite, documented) |
| Secrets server-only; SSRF guards; path validation; upload sanitization; size limits; CORS approved origins; CSRF protection; rate limits; quotas | ❌ | Phase 2/7 |
| Threat model + residual risks documented | ◐ | docs/THREAT_MODEL.md in progress (subagent) |

## §26 Deployment

| Requirement | Status | Notes / target |
|---|---|---|
| Frontend: Vite build, SPA routing, PWA manifest/SW, backend URL env, Analytics, prod checks | ❌ | Phase 7 |
| Backend: Docker Compose (api/worker/postgres/redis/runner/proxy), HTTPS, firewall, private nets, volumes, healthchecks, restarts, limits, logs, backups, rotation, cleanup | ❌ | Phase 7 |
| Sample env files (no secrets), init/update scripts | ❌ | Phase 7 |
| No deployment claimed until services verified on target | ✅ | By design (standing rule: Jon deploys; guided-hands Oracle) |

## §27 Testing strategy

| Requirement | Status | Notes / target |
|---|---|---|
| Unit tests (validation, state machines, plans, tools, memory, files, retry, cancel, model selection) | ❌ | Per phase |
| Integration tests (PG/Redis/queues/recovery/git/storage/API/mocked model adapter) | ❌ | Per phase |
| Browser E2E (create/prompt/inspect/play/edit/restore/download) | ❌ | Phase 7 |
| Opt-in real-AI acceptance with Jon's Cloudflare credentials (structured work → files → built game runs; mocks never presented as live) | ❌ | Phase 7 |
| Security tests (traversal, unsafe commands, net isolation, uploads, secrets, limits, cancellation, malformed tool calls) | ❌ | Phase 7 |

## §28 Acceptance scenarios

| Scenario | Status | Notes / target |
|---|---|---|
| A — Basic 3D game (files, build, controls, render, tests, download) | ✅ | Verified 2026-10-09: real Chromium (smoke+gameplay pass, non-blank shot), preview 200 + shim, ZIP reproducible, secret refusal |
| B — Enhancement (coins/score/victory, regression green) | ✅ | Verified 2026-10-09: change in persisted dist, both revisions recorded, real-page state advances |
| C — Failed build recovery (diagnostics, bounded correction, last-good intact) | ✅ | Verified 2026-10-09: diagnostics persisted, last-good serves, correction stops at 3 |
| D — Interrupted execution (state retained, no dup paid ops) | 🔶 | Partial: crash persisted, no dup paid ops, rerun verified. Real SIGKILL needs live worker (Oracle) |
| E — Asset integration (GLB validated, previewed, loaded, runtime-checked) | 🔶 | Partial: real routes (upload/download/delete/thumbnail) green. GLB runtime needs preview origin (Oracle) |
| F — Export (ZIP: source, metadata, README, reproducible, no keys) | ✅ | Verified 2026-10-09: valid reproducible ZIP, README, secret refusal |

## §29 Deliverables checklist

| # | Deliverable | Status |
|---|---|---|
| 1–2 | Working frontend / backend | ✅ | Vite PWA + Fastify API; acceptance A–F run (4 verified, 2 partial — see ACCEPTANCE_REPORT.md) |
| 3–4 | DB migrations / durable job system | 🔶 | 4 migrations written + statically validated; live apply on Oracle |
| 5–7 | Cloudflare integration / agent orchestration / isolated runner | 🔶 | Provider + orchestration + runner implemented and unit-tested; live Cloudflare/Docker on Oracle |
| 8–11 | Live preview / asset manager / build+test pipeline / memory+history | ✅ | Preview origin, asset routes, 15-phase pipeline, memory scopes — all exercised by acceptance suite |
| 12–13 | Functional templates / plugin examples | 🔶 | Templates done; plugins done; live container execution Phase 7 |
| 14–16 | Docker deploy config / env examples / API docs | ✅ | Compose + Caddy + Dockerfiles, .env.example (+DATABASE_URL/REDIS_URL), docs/API_GUIDE.md |
| 17–19 | Frontend deploy guide / Oracle install guide / security docs | ✅ | docs/VERCEL_GUIDE.md, docs/ORACLE_INSTALL.md, docs/THREAT_MODEL.md, SECURITY_NOTES.md |
| 20–22 | Automated tests / E2E acceptance report / known limitations | ✅ | 424+ tests workspace-wide; ACCEPTANCE_REPORT.md with honest partials and not-run list |

## §31/§32 Engineering rules adopted

- Prefer maintainability; working vertical slices over breadth; strict typing; validate
  external inputs; small modules; observable operations; rollback for dangerous changes;
  replaceable providers; **never let model-generated assertions be the only proof.**
- From Genex's discipline: typed codes not English matching; finished worker / passing
  checks / integration / live revision are distinct facts; builds are verified/partial/
  failed; garbled judge output keeps the incumbent; a delivered file is never evidence
  the game uses it; never describe a focused test pass as a full run.
