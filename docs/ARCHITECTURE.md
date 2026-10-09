# ARCHITECTURE — GameForge AI Studio

**Date:** 2026-10-09
**Status:** Decided architecture (Phase 1). Open questions are explicitly marked `[OPEN]`.
**Source:** Derived from `docs/REFERENCE_ANALYSIS.md` (Phase 1 task 1 — reverse engineering of
Genex Desktop and the Genex skill/tooling repos).

> **Attribution.** Mechanisms marked **adapted-from-Genex** are reimplementations of designs
> observed in the MIT-licensed repositories `genex-games/genex-desktop` and `genex-games/genex`
> (Copyright © 2026 Genex / genex.games). MIT copyright and permission notices are preserved
> wherever code or doc text is adapted; no Genex brand assets, names, or proprietary services
> (asset-generation backend, publishing platform, multiplayer relay, player identity, metered
> platform APIs) are used. Trademark rights are not granted by the MIT license.

---

## 1. System overview

GameForge AI Studio is a browser-based AI game-development studio. A single user describes a
game in natural language; a server-side orchestrator runs specialized AI agents (Cloudflare Workers AI) that
generate real source files, build, test, visually verify, and export working browser games —
all on the user's own Oracle Cloud Linux server. The Vercel frontend is a thin, stateless
control surface: durable state lives in Postgres; durable scheduling lives in BullMQ/Redis;
untrusted code executes only inside isolated runner containers.

### 1.1 Component diagram

```
                         ┌────────────────────────────────────────────────────┐
                         │                    USER BROWSER                    │
                         │  GameForge Studio (React SPA)                      │
                         │  ┌──────────────┐   ┌─────────────────────────┐    │
                         │  │ Control UI   │   │ Live Preview (iframe)   │    │
                         │  │ (main origin)│   │ (PREVIEW origin, opaque)│    │
                         │  └──────┬───────┘   └───────────┬─────────────┘    │
                         │         │ SSE (stable event IDs) │ postMessage only │
                         └─────────┼───────────────────────┼──────────────────┘
                                   │ HTTPS                 │ HTTPS (no secrets)
                    ┌──────────────┴───────────────────────┴──────────────────┐
                    │                    REVERSE PROXY                        │
                    │        (TLS termination, routing, rate limiting)         │
                    └──────────────┬───────────────────────┬──────────────────┘
                                   │                       │  (separate host
                    ┌──────────────┴───────────┐  ┌────────┴───────────────┐
                    │ apps/api (Fastify)       │  │ Preview origin server  │
                    │  - REST /api/v1 (OpenAPI)│  │  - page server         │
                    │  - SSE event stream      │  │  - shim injection      │
                    │  - page-serve endpoint   │  │  - static artifacts    │
                    │  - auth boundary         │  │  (NO API secrets here) │
                    │  - model registry cache  │  └────────┬───────────────┘
                    └──────┬───────────────────┘           │
                           │                               │
              ┌────────────┼────────────────────┐          │ CDP / Playwright
              │            │                    │          ▼
       ┌──────┴──────┐ ┌───┴────┐    ┌──────────┴──────────┐
       │ PostgreSQL  │ │ Redis  │    │ apps/worker         │
       │ - events    │ │ BullMQ │    │  - orchestrator     │
       │ - journal   │ │ queues │    │  - agent roles      │
       │ - metadata  │ │ delayed│    │  - build pipeline   │
       │ - memory    │ │ jobs   │    │  - evidence runner  │
       └─────────────┘ └────────┘    └──────┬──────────────┘
                                           │ narrow scoped RPC
                    ┌──────────────────────┴───────────────────────┐
                    │  RUNNER (rootless containers, per job)       │
                    │  - build runner (Vite/TS/unit/build)         │
                    │  - headless-Chromium pool (Playwright/CDP)    │
                    │  - Blender jobs (if enabled)                 │
                    │  - plugin backends                           │
                    │  dedicated non-root user · no docker socket  │
                    │  read-only rootfs · CPU/RAM/pid/timeout      │
                    │  restricted network · no metadata endpoints │
                    └──────────────────────┬───────────────────────┘
                                           │ per-build ephemeral dirs
                    ┌──────────────────────┴───────────────────────┐
                    │  STORAGE (volumes on Oracle)                 │
                    │  - git:  <data>/projects/<id>.git  (1/project)│
                    │  - artifacts: content-addressed by hash      │
                    │  - assets: content-addressed media store      │
                    │  - builds: scratch/<project>-<treehash>/     │
                    └──────────────────────────────────────────────┘
```

Traffic is split by host: the control application and the API live on the **main origin**;
the game preview and the `__studio` page server live on a **separate preview origin**
(Section 8). Generated game HTML is never served from the main application origin.

### 1.2 Design principles

1. **The studio is a harness; the game is a real project.** Adapted-from-Genex ("Genex is not
   an editor"). The studio never conflates its own UI with the game artifact.
2. **Honest gates.** Adapted-from-Genex: a finished worker, passing checks, an integrated
   change, and a live revision are *distinct facts*, never merged in summaries. Builds are
   `verified` | `partial` | `failed` — never "done" on LLM assertion alone.
3. **Never decide behavior by matching English text.** Adapted-from-Genex (`loop/outcomes.ts`
   StopCodes): state machines use typed codes everywhere.
4. **No fake features.** An unavailable capability renders as *unavailable*, never as a dead
   button (e.g. Blender adapter disabled until the Oracle instance proves capable; vision
   review labeled "unverified" when no vision model exists).
5. **Cost is a first-class constraint.** Workers AI is always metered in neurons (the economic inverse of
   Genex's borrow-your-subscription model): budgets, wall clocks, and per-completion usage
   accounting are load-bearing architecture, not telemetry.

---

## 2. Component responsibilities

### apps/web — Control surface (Vercel)

- Vite + React + TypeScript SPA, PWA-capable, EN default / ES switchable, dark mode default.
- Three-panel studio layout (left nav, central workspace, right workspace; resizable,
  collapsible), mobile tabs/drawers/full-screen preview.
- No login (by design); **localStorage is never authoritative** — it caches view state only;
  Postgres is the source of truth.
- Chat composer with plan/question cards (adapted-from-Genex interaction vocabulary:
  composer, question panel, plan review cards, rewind — reimplemented UI, no code copied).
- Monaco code editor (optimistic concurrency via expected-commit-SHA), asset manager,
  build graph, Activity panel, diagnostics dashboard, Settings.
- SSE client with stable event IDs + reconnect replay (Section 8).
- **Never ships secrets.** No Cloudflare API token, no Oracle credentials, no preview-internal data in
  the client bundle. Vercel Analytics included; the key boundary is a build-time assertion.

### apps/api — Control plane (Fastify, Oracle)

- Versioned REST API `/api/v1` (OpenAPI generated, zod-validated inputs): system, projects,
  conversations, agent runs, builds, assets, models, plugins, settings, memory.
- SSE endpoint `/runs/:id/events` with stable event IDs and reconnect replay (Section 8).
- Infrastructure access boundary enforcement (Section 10 of master prompt): the API is not
  publicly exposed; deployment requires VPN/private connectivity — a **deployment
  prerequisite, documented as such**, not a code feature `[OPEN: exact mechanism chosen at
  deploy time, e.g. WireGuard vs security-group allowlist]`.
- Model registry cache (Workers AI model probing, Section 7); provider connectivity test endpoint
  (returns capability matrix, never the key).
- Hosts the `__studio` **page server** endpoints for headless evidence runs (shim injection
  point). Serves preview-origin traffic separately from control traffic.

### apps/worker — Agent runtime (Node, Oracle)

- BullMQ consumers: `agent-jobs`, `build-jobs`, `evidence-jobs`, `asset-jobs`, `plugin-jobs`,
  delayed wake/digest jobs.
- Implements the **director / workers / judges** role model (adapted-from-Genex):
  - **Director** (one Workers AI tool-calling session per run, ≤ N wakes; ≤ 30 wakes/hour analog).
  - **Workers**: planner, builder (per-facet, parallel-bounded by server capacity), plus
    role agents — gameplay, scene/visual, UI, asset, QA — with per-role prompts, model
    selection, tool permissions, timeouts, iteration limits, token budgets.
  - **Judges**: fresh-context one-shot Workers AI calls; blind A/B compares (a pick + the biggest
    gap, never a score — adapted-from-Genex gauntlet discipline); one-question vision
    checks; art-director "would you ship this?" verdict (routes defects as finish work,
    **never vetoes a landing** — adapted-from-Genex).
  - **Scout** (read-only pre-plan probe; plan clamped to its ceiling) and **spike**
    (throwaway mini-scene → recipe on consecutive failures) — adapted-from-Genex modes.
- Execution modes: **Manual** (one change → test → return control), **Auto** (fixed
  autopilot pipeline with bounded auto-correction), **Loop** (facet build⟳verify against
  fixed acceptance criteria, gated by iteration/time/model budgets + measurable progress).
- Wake/digest pattern: director state rehydrated from the Postgres run journal each wake
  (Workers AI has no sessions) — adapted-from-Genex, storage-substituted.
- Build pipeline (Section 3c), evidence pipeline (Section 4), crash recovery (Section 5).
- **The worker never runs untrusted code in-process**; all generated code runs in runner
  containers via a narrow, typed tool-call interface (structured args, validated — never
  unrestricted shell as a default agent capability).

### packages/shared

- Typed contracts shared by web/api/worker: OpenAPI-derived types, SSE event schemas with
  stable IDs, StopCodes, execution-state enums, asset provenance schema, `window.__studio`
  contract types, chat/checkpoint ref naming, error schemas, pagination envelopes.
- i18n dictionaries (EN default, ES) — UI language contract lives here, not in components.

### packages/agent-core

- The harness: turn loop (bounded rounds/turn), tool-call dispatch with idempotency keys,
  role prompts + per-role model binding, memory retrieval/summarization, budget
  accounting hooks, typed StopCodes (adapted-from-Genex `loop/outcomes.ts` + `model-roles.ts`
  role-modeling discipline), wake/digest journal schema.
- Reimplements the **HostMethod RPC vocabulary** concept (adapted-from-Genex
  `src/shared/harness-api.ts`): the harness talks to the platform only through typed
  host methods; the Fastify server + runner service implement that surface. No Electron
  assumptions.

### packages/game-templates

- Eight functional starter templates (empty three.js, 3D first-person, third-person,
  racing, 3D platformer, 2D arcade, puzzle, physics sandbox w/ Rapier), each a **real
  working project** implementing the `window.__studio` contract (seed/step/state/
  inspect/capture — Section 4), with declared kind traits, probe axes, and a smoke
  play-script.
- Templates with no build step follow Genex's no-build discipline (ES modules, vendored
  three.js, no network) where possible; TS templates build with Vite. Coverage is honest
  per template: Phaser/canvas2D templates get reduced instrumentation (Genex marks these
  out of scope for the shim — say so).

### packages/plugin-sdk

- Plugin manifest schema (`plugin.json`, apiVersion, capabilities, `<plugin>__<tool>`
  naming), sandboxed panel bridge (opaque-origin iframe + `postMessage`, strict CSP),
  backend tool protocol for containerized execution, consent-card protocol.
- **Trust model:** plugin backends run in containers (stronger than Genex's crash-only
  isolation — say so honestly); **agents can never install/enable plugins** (adapted-from-
  Genex); host-owned consent cards that agents can't bypass or answer.
- Ships ≥2 working example plugins (e.g. procedural-geometry, asset-import) + a Blender
  example gated on server capability; developer guide.

### packages/model-providers

- Cloudflare Workers AI provider adapter (OpenAI-compatible client, tool calling, streaming), capability
  registry (Section 7), rate-limit/token-accounting/backoff/budget enforcement, provider
  failure ladder (rate-limit → backoff → reduce worker concurrency → pause).
- Provider interface is replaceable; Cloudflare Workers AI is the configured provider.

### packages/test-runner

- Acceptance-scenario harness (Scenarios A–F), seeded evidence runs, pixel-statistics
  blank detection (adapted-from-Genex plugin API 3 `observe`/`still` luma analysis —
  model-free), conformance tests for the `__studio` contract per template, security test
  suite (path traversal, unsafe commands, network isolation, invalid uploads, secret
  exposure, request limits, runner cancellation, malformed tool calls).

---

## 3. Core flows

### 3a. Create project from natural language

```
User types idea in home composer
  → POST /api/v1/projects { prompt, templateHint? }
  → api: create project row + git repo (init, main), conversation row, first message row
  → api: enqueue agent job { runMode: Auto|Manual } with idempotency key (run UUID)
  → worker/director: scout probe (read-only: template surface, capability check)
  → director: select template (kind traits + probe axes), draft plan
  → plan card → user (Approve / Make changes / Cancel) via question panel (SSE)
      - ask_user question cards are DURABLE (persisted, replayable on reconnect)
  → approval → workers generate files (each file write = git checkpoint first)
  → build pipeline (3c) → evidence pipeline (4) → judge review
  → verdict: verified | partial | failed → live revision = last verified build (3e)
  → preview playable; source downloadable; run journal closed
```

Chat rewind restores the **conversation projection**; DB rows are retained with withdrawn-turn
markers (adapted-from-Genex `chat-rewind.ts`). Restore-game-files checks out the
`refs/studio/chat/<thread>/before|after/<message>` checkpoint (Section 6).

### 3b. Auto / Loop run lifecycle

```
director (wake loop, BullMQ delayed jobs)
 ├─ wakes ≤ configured rate; each wake rehydrates run journal from Postgres
 ├─ decomposes goal → tasks with dependencies (deterministic IDs)
 ├─ dispatches worker jobs (BullMQ, per-facet branch/worktree: refs/studio/runs/<id>/…)
 ├─ workers: gameplay/scene/UI/asset/QA agents call tools (file writes, builds,
 │   evidence probes) with idempotency keys; git checkpoint BEFORE every agent edit
 ├─ judges (fresh context): blind A/B compare → pick + biggest gap (never a score);
 │   garbled verdict KEEPS THE INCUMBENT (adapted-from-Genex) — never tie/defect/fail
 ├─ integrate: merge validated worker results only; merge conflicts → surface, never
 │   silently overwrite user edits
 ├─ build pipeline (3c) → evidence pipeline (4)
 ├─ reviewer: independent check vs user's acceptance criteria → structured feedback
 ├─ loop mode: repeat facet build⟳verify while budgets remain AND progress is measurable
 │   AND user hasn't stopped AND no unresolved external blocker (typed StopCodes)
 └─ terminal: completed | failed | canceled | delivered-stale — each DISTINCT
     (adapted-from-Genex: stopped/failed/incomplete/delivered stay distinct)
```

Stop = no new work starts; owned active processes terminated safely; queued work canceled;
run journal marks `canceled` with the checkpoint where it stopped. Pause = journal
persisted, delayed wake removed; resume re-queues the wake from the journal.

### 3c. Build pipeline phases (per build job)

1. Validate project structure + required files (template contract).
2. Install allowed dependencies (`registry.npmjs.org` only, allowlisted — mirrors Genex's
   install discipline; explicit user consent recorded).
3. Typecheck (strict TS).
4. Unit tests.
5. Production bundle (Vite where the template needs it; skipped for no-build templates).
6. **Shadow build**: build in `scratch/builds/<project>-<treehash>/` (content-keyed
   memoization), never in the live repo — adapted-from-Genex.
7. Launch temporary preview server (preview origin, ephemeral port).
8. Chromium smoke tests (headless, CDP): boot, zero fatal console errors.
9. Console + network failure inspection (failed asset requests collected).
10. Gameplay smoke: deterministic playthrough via `__studio` (seeded RNG, scripted step()).
11. Screenshots at every named camera (`userData.tag` addressing — adapted-from-Genex).
12. Pixel-statistics blank detection (model-free luma analysis).
13. Acceptance criteria evaluation (typed criteria, per build revision).
14. Verdict: **verified | partial | failed** (typed; never merged with LLM assertions).
15. Persist artifacts + reports; link build → git commit SHA.

Build record: unique build ID, source revision, timestamps, agent run ID, status, test
results, screenshot references, runtime logs, artifact dir, resource consumption.
**Last known-good build remains playable even when a new build fails** (adapted-from-Genex);
failed builds show last-good output with the failure reason.

### 3d. Live preview serving

- The preview panel loads the **last verified build** in a sandboxed iframe from the
  **separate preview origin** (opaque origin, restrictive CSP, no API secrets).
- Controls: Play / Stop / Reload, fullscreen, mute/unmute, keyboard focus, touch controls
  (where supported), viewport presets, FPS counter, resolution, runtime errors, build
  revision, loading status.
- Live-behind gate: Reload lights when a new verified build waits (adapted-from-Genex).
- Readiness is **a fact the page reports** (cooperative `__studio` `postMessage`), not a
  fixed wait (adapted-from-Genex). Authoritative screenshots/evidence come from the
  server-side headless pipeline (Section 4), not the browser tab.
- WebGL required; WebGPU progressive enhancement; explicit fallback UI for unsupported
  browsers.

### 3e. Crash recovery via run journal

- Run journal: JSONB document on the `agent_runs` row — worked clock, plan, ledger,
  worker states, completed steps, checkpoint refs, retry state, wake state
  (adapted-from-Genex `autopilot_<runId>` journal).
- Worker crash → BullMQ stalled-job detection → job re-queued → worker **reopens the run
  as `interrupted`/paused from the journal** (adapted-from-Genex crash/quit recovery).
- **No silent repetition**: every side-effecting tool call carries an idempotency key;
  completed steps are never re-executed; paid API operations are never duplicated.
- Distinct terminal states are preserved on recovery: a crashed run resumes as
  `interrupted` (recoverable), never rewritten to `failed` or `completed`.

---

## 4. `window.__studio` instrumentation contract

The single highest-value mechanism adapted from Genex; implemented first (Phase 3) because
every acceptance scenario depends on it.

### 4.1 Page server

- The API's preview-origin server serves game pages through a rewrite layer
  (adapted-from-Genex `src/main/page-serve.ts` custom-scheme serving): HTML is rewritten
  so the studio-owned **shim script is injected before any game code runs**.
- Games are served per build revision (content-keyed), so evidence is always linked to an
  exact revision.

### 4.2 Shim contract (injected before game code)

```text
window.__studio = {
  seed(n),            // set deterministic RNG seed
  step(dt),           // advance simulation one scripted tick
  state(),            // JSON snapshot of game state
  inspect(query),     // scene-graph / entity queries (tag-addressed via userData.tag)
  capture(cameraTag), // per-camera screenshot trigger
  ready(),            // page reports readiness (fact, not a wait)
  tag helpers         // elements addressable by userData.tag
}
```

- Studio-owned clock + seeded RNG make playthroughs deterministic (`PAGE_SEED`-style).
- Contract version declared in the game's `studio.json` (adapted-from-Genex contractVersion).

### 4.3 Evidence pipeline (CDP-driven)

1. Playwright launches headless Chromium (bounded pool; size decided by Oracle inspection —
   `[OPEN R1]`).
2. Deterministic playthrough: seed → `step()` script → named-camera `capture()` at each.
3. Structural probes via `inspect()`; console errors + GPU errors + failed network requests
   collected; blank detection via pixel statistics (`lumaMean`, `lumaStdDev`,
   `nearBlackFraction`, `litFraction`) — no model required (adapted-from-Genex).
4. Vision review (optional): bounded screenshots + acceptance criteria submitted to a
   Workers AI model **only if the registry verifies vision capability**; otherwise the result is
   labeled **"visual assessment unverified"** and deterministic checks stand alone.
5. Judges run fresh-context, one-shot, blind A/B (pick + biggest gap, never scores);
   garbled output keeps the incumbent.

### 4.4 Evidence → review linkage

Every review result records: criterion, result, confidence, supporting evidence
(screenshot refs, probe outputs, console excerpts), detected issue, recommended
correction, retest-required flag — linked to the **exact build revision tested**.

---

## 5. Durability model

| Concern | Decision |
|---|---|
| Event log | Append-only `agent_events` table (single-writer discipline, IDs minted under a DB lock — adapted-from-Genex `EventStore`). **Redaction-on-append**: secrets are scrubbed before the row is written; they never reach logs, prompts, games, or plugins (adapted-from-Genex). |
| Run journal | JSONB column on `agent_runs`: worked clock, plan, ledger, health, workers, wake state, checkpoint refs. Crash/quit recovery reopens runs as paused/interrupted from the journal. |
| Wake/digest timers | BullMQ **delayed jobs** (file watchers don't exist on a server; replaces Genex's in-process wake timers). |
| Idempotency | Deterministic IDs + idempotency keys on every job and side-effecting tool call. A worker crash must not create duplicate assets or repeat paid API operations. |
| Terminal states | `queued · planning · running · waiting_for_user · building · testing · reviewing · completed · failed · canceled · interrupted` — terminal states are **distinct and never rewritten** (adapted-from-Genex). |
| Job payloads | Task payload, agent identity, current step, completed steps, artifacts, logs, errors, retry count, usage metrics, checkpoint references — all persisted per run. |

Crash-recovery test (Scenario D) is a first-class acceptance gate: kill the worker mid-run →
run reopens as `interrupted` with completed steps intact; no duplicate paid operations
(verified by idempotency-key audit in tests).

---

## 6. Versioning

- **One git repo per project** under backend storage (`<data>/projects/<id>`); server-side
  git, same tool Genex uses.
- **Ref namespaces adopted verbatim** (adapted-from-Genex):
  - `refs/studio/runs/<runId>/…` — per-run worker branches/worktrees and checkpoints.
  - `refs/studio/chat/<thread>/before|after/<message>` — chat checkpoints per message
    (private index, hooks off; keep 100 checkpoints/chat).
  - Asset checkpoints per delivery under `refs/studio/assets/<deliveryId>`.
- **Never-capture list** (adapted-from-Genex): `.env`, `node_modules/`, `dist/`,
  `.studio/`, secrets files — checkpoint code never snapshots these.
- Automatic checkpoint **before every agent edit**; commits for accepted changes;
  build→commit linkage in the DB.
- Optimistic concurrency in the editor: save carries expected-commit-SHA; mismatch →
  conflict surfaced in the diff viewer, never silently overwritten.
- Restore = checkout + re-serve; last-known-good build linked to its commit.
- Large binary assets: git-lfs **or** content-addressed asset store with DB metadata
  `[OPEN: choose at Phase 5; master prompt §22 forbids large binaries in relational rows]`.
- Export ZIP preserves git history; contains source + package metadata + README +
  reproducible build instructions; **secret scan refuses files containing known
  credential values** (adapted-from-Genex exporter discipline); cover image = one real
  16:9 frame captured headless from the game's cover demo.

---

## 7. Cost control architecture

Workers AI is always metered — the **economic inverse** of Genex's borrow-your-subscription model.
Genex's metered-engine guards become GameForge's primary cost design:

1. **Per-role model selection.** Each agent role (planning, code generation, code review,
   general reasoning, tool orchestration, vision, summarization, memory consolidation) has
   a separately configurable model binding. Multiple roles may share one model.
2. **Live capability registry, never hardcoded model names.** At startup (and on demand),
   the server probes the account's Workers AI model catalog and documented capabilities; the registry records
   per-model: tool-calling support, vision support, context window, known limits. If a
   role's model lacks a required capability, the system selects a verified compatible
   model or displays a clear limitation (Genex's own rule: metered engines are never
   auto-selected — here the registry enforces compatibility before spend).
3. **Per-completion usage accounting.** Every LLM call records prompt/completion tokens,
   latency, model, role, run ID → `model_usage` table. Nothing is estimated after the fact.
4. **Budgets + wall clocks.** Configurable per run: token budget, request budget,
   max duration, max parallel agents, max retries. Loop mode additionally gates on
   *measurable progress*. Typed StopCodes (`budget`, `engine-exhausted`, `circuit-break`,
   …) end runs — never English-text matching (adapted-from-Genex `outcomes.ts`).
5. **Backoff.** Exponential backoff with jitter on rate limits/timeouts; bounded retries;
   provider failure ladder: rate-limit → backoff → reduce worker concurrency → pause run.
   `[OPEN R3: real-world tuning under parallel workers.]`
6. **No fabricated LLM responses.** Mocked/deterministic responses exist only in the
   test suite and are never presented as live AI results. The opt-in "real AI acceptance"
   test uses the user's configured Cloudflare credentials and proves: structured work → files written →
   built game executes.

---

## 8. Networking & origins

### Origins

- **Main origin** (`app`): the React SPA + `/api/v1` + SSE. Typed REST (OpenAPI + zod);
  CORS to approved origins only (never treated as authentication).
- **Preview origin** (`preview`, separate host): game pages, page server with shim
  injection, static build artifacts. **No API secrets, no session cookies, no backend
  credentials** reach this origin. Sandboxed iframe (opaque origin) + restrictive CSP
  (`default-src 'none'`-style, no external network except allowlisted CDNs) — the
  server-side mapping of Genex's closed game partition (adapted-from-Genex
  `src/main/preview.ts`).

### Browser ↔ studio communication

- Control channel: **SSE** with **stable event IDs**; the frontend reconnects
  automatically after network interruption and **replays missed events** from the last
  seen ID (the running job survives browser loss — server-side journal is authoritative).
- Preview ↔ studio: cooperative `postMessage` `__studio` contract only (readiness,
  runtime errors, FPS). No cross-origin screenshotting from the tab — authoritative
  captures are server-side (Section 4).
- State-changing API operations are protected against unauthorized web origins and
  cross-site requests (CSRF protections independent of CORS); rate limits, request-size
  limits, and execution quotas apply.

---

## 9. Deployment topology

### 9.1 Frontend — Vercel

- Vite production build, SPA routing (`vercel.json` rewrites), PWA manifest + service
  worker with safe update behavior, Vercel Analytics.
- Single environment variable: backend URL. **Build-time assertion: no secret-shaped
  values in the client bundle** (Cloudflare token, Oracle credentials).
- Vercel is hands-off by default: the agent pushes code to GitHub; the user imports and
  deploys. Vercel-bound commits use the user's GitHub identity.

### 9.2 Backend — Oracle Cloud Linux (Docker Compose)

Services:

| Service | Role |
|---|---|
| `reverse-proxy` | TLS termination, host-based routing (main vs preview origin), rate limiting |
| `api` | Fastify control plane, SSE, page server |
| `worker` | BullMQ consumers: agent orchestration, builds, evidence, assets, plugins |
| `postgres` | Durable state (events, journal, metadata, memory, model usage) |
| `redis` | BullMQ queues + delayed wake jobs |
| `runner` | Spawns per-job **rootless containers**: build, Chromium pool, Blender, plugin backends |

- **Explicit isolation for the runner** — co-location on one Compose network is *not*
  treated as a security boundary (master prompt §26): runner containers get dedicated
  non-root users, no privileged containers, no Docker socket inside, read-only rootfs
  where practical, CPU/RAM/pid/timeout quotas, restricted network (no Postgres/Redis
  networks, no cloud metadata endpoints), writable temp workspace only, automatic cleanup,
  per-run logs.
- Volumes: postgres data, redis data, git project storage, content-addressed artifact/
  asset store, build scratch (with disk-cleanup policy).
- Health checks per service; restart policies; resource limits; structured logging;
  log rotation; backup/restore strategy covering DB **and** files.
- systemd manages the Compose stack lifecycle on the host; firewall restricts to the
  access boundary (Section 8 / `[OPEN R5]`).
- Sample `.env` files ship **without secrets**; init/update scripts provided.
- **Deployment success is claimed only after services are actually started and verified
  on the target environment** (master prompt §26). If Oracle access is unavailable,
  deliver complete artifacts + exact instructions instead.

### 9.3 Startup self-inspection (worker/API boot)

At startup the backend inspects the instance (CPU/RAM/arch) and reports safe worker
concurrency, whether the Chromium pool can run, and whether Blender is viable —
disabling resource-heavy capabilities when unsupported `[OPEN R1/R4]`.

---

## 10. Open risks carried from the analysis

| ID | Risk | Status / plan |
|---|---|---|
| **R1** | Oracle instance sizing (CPU/RAM/arch) unknown | Decide at Phase 2 startup-inspection implementation; sets Chromium pool size, worker concurrency, Blender viability. |
| **R2** | Workers AI vision-capable models — availability & limits | Verified at startup via the live capability registry (Section 7); semantic review degrades gracefully to deterministic checks labeled "visual assessment unverified". |
| **R3** | Workers AI rate limits under parallel workers | Provider failure ladder (Section 7.5) needs real-world tuning; keep default worker parallelism conservative (2–4, vs Genex's 12 on a desktop). |
| **R4** | Blender on Oracle Linux | CPU-only, bounded complexity; adapter ships **disabled** with a transparent explanation if the instance can't run it. |
| **R5** | No-login + code execution → infrastructure access boundary | A **deployment prerequisite** (VPN/private connectivity), not a code feature; documented in the threat model (Phase 7). |

**Additional open decisions** (not risks, but unresolved): git-lfs vs content-addressed
asset store (Phase 5); exact access-boundary mechanism (WireGuard vs security-group
allowlist); embedded terminal — server-side PTY over websocket, or deferred if it risks
the security model (Phase 5 decision).

---

## Appendix: requirement traceability

Each master-prompt requirement maps to a section of this document and a
`FEATURE_MATRIX.md` row (`Implemented and verified / Implemented but not verified /
Partially implemented / Not implemented / Blocked by external dependency`). The matrix is
maintained per phase; **no fake features** — anything unverified stays marked as such.

---

*End of ARCHITECTURE.md — Phase 1, task 2. Next: security model, DB schemas, FEATURE_MATRIX.md.*
