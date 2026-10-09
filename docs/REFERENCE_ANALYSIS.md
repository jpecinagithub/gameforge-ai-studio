# REFERENCE_ANALYSIS — Genex Desktop → GameForge AI Studio

**Date:** 2026-10-09
**Subject:** Reverse-engineering of the Genex reference for the GameForge AI Studio web project.
**Repos surveyed (shallow clones, 2026-10-09):**
- `https://github.com/genex-games/genex-desktop` (HEAD `d6ee9ce`, package `ai-game-studio` v0.1.4)
- `https://github.com/genex-games/genex` (HEAD `1199d5b`)
- `https://genex.games/docs` (13 pages, fetched 2026-10-09)

**Claim marking:** `[VERIFIED]` = proven by repository source code or official docs (path cited).
`[INFERRED]` = reasoned from code evidence, not stated outright. Inferred claims are
flagged where they matter.

## 0. License and brand boundaries (mandatory)

Both surveyed repositories are **MIT licensed**:
- `genex/LICENSE` — "MIT License / Copyright (c) 2026 Genex" [VERIFIED]
- `genex-desktop/LICENSE` — "MIT License / Copyright (c) 2026 genex.games" [VERIFIED]

Any code, docs or ideas adapted from these repos into GameForge **must preserve the MIT
copyright + permission notices**, with third-party attribution mirroring
`genex-desktop/THIRD-PARTY-NOTICES.md`.

**Must NOT be reused:**
- The Genex name, wordmark, logos, share cards (`genex/assets/`, `.github/logo-*.svg`)
  — MIT grants no trademark rights [VERIFIED: brand assets ship in repo, no trademark grant].
- Genex **proprietary services** (no server code in either repo — by design):
  `api.genex.games` (asset-generation billing/ledger), `mcp.genex.games`,
  `plugins.genex.games` catalog, game hosting/gallery (`<slug>.genex.technology`),
  multiplayer relay (`@genex-ai/multiplayer`), player identity (`@genex-ai/embed-sdk`),
  the asset-generation backend itself ("Genex holds the provider relationships")
  [VERIFIED: `genex.games/docs/guide/how-it-works.md`, `docs/plugins.md`].
- The proprietary Claude Agent SDK (bundled dependency, not open) [VERIFIED: `package.json`].
- The pinned `@genex-ai/cli-demo` CLI (license not stated in docs; treat as unlicensed).

**Caveat on generated-asset licensing:** Genex's own docs state their licensing page is
"held until a one-time legal pass over each provider's terms" — i.e. not final legal
advice [VERIFIED: `reference/licensing-faq.md`]. GameForge must write its own terms.

## 1. Corrections to the master prompt's assumptions

1. **`genex.games/docs` is NOT the product documentation.** It contains exactly 13
   pages, all about the *asset-generation product* (Genex Tools): skill/MCP/CLI/API
   quickstarts, billing, publishing, pricing, licensing FAQ, limits
   [VERIFIED: `https://genex.games/docs/llms.txt`, "Pages: 13"]. All the documents the
   master prompt lists (product docs, developer field guide, agent runtime, plugin SDK,
   build/live-preview, studio learning) live in **`genex-desktop/docs/`** instead
   [VERIFIED: directory listing].
2. **The two repos are not a monorepo and share no code.** `genex` = the Genex *skill*
   text + Claude Code marketplace manifest + brand assets; **no application code**
   [VERIFIED: `genex/README.md`]. `genex-desktop` = the actual Electron studio app.
3. **The asset-generation backend is closed.** Open repos carry only clients (CLI, skill,
   MCP, API docs) [VERIFIED]. GameForge therefore cannot "reuse" Genex asset generation —
   it must implement its own provider adapters (procedural, Blender, user upload) and
   treat any third-party generation API as an optional, explicitly-configured provider.
4. **Genex ships no LLM and pays for no tokens.** It *borrows the user's subscriptions*
   (Claude Code CLI / Codex CLI) or runs local models (Ollama, bundled Bonsai 27B
   ternary). Its metered engine (OpenRouter) is **never auto-selected** [VERIFIED:
   `src/shared/providers.ts`, `docs/agent/architecture.md`]. GameForge's Cloudflare Workers AI neuron-metered design is the **economic inverse**: Genex's metered-engine guards become
   GameForge's *primary* cost design (budgets, wall clocks, usage accounting).
5. **Genex is a macOS-first Electron desktop app** ("Self-improving AI game studio for
   macOS on Apple Silicon") [VERIFIED: `package.json`]; Linux x64 shipped, Windows
   planned. It is explicitly **pre-release** ("no released builds yet") [VERIFIED:
   `SECURITY.md`, README].
6. **"Genex is not an editor."** The game is a normal three.js project built by the
   user's coding agent; Genex is a *harness around it*: assets, multiplayer relay,
   publishing, player identity [VERIFIED: `docs/agent/glossary.md`, README]. GameForge
   follows the same honest framing: the studio is a harness, the game is a real project.
7. **Unity support is retired** (`archive/unity/`, "no flag enables them and there is no
   migration path") [VERIFIED]. The master prompt's §4 requirement not to advertise
   Unity/Unreal without validated integration aligns exactly with Genex's own discipline.

---

## 2. Feature-by-feature comparison

Format per feature: **Genex behavior** → **Evidence** → **GameForge proposal** →
**Reusable (MIT)** → **Required changes** → **Known limitations** → **Acceptance criteria**.

### F1. Natural-language game creation (home composer → chat)

- **Genex:** Launch opens a home composer; typing an idea starts a game the model names;
  one game per conversation; games live in `~/AI Games` by default. Game chat supports
  Markdown, streamed replies, message queue, **Rewind to any message**, and "Restore game
  files" checkpoint restore. `ask_user` opens a question panel (options + typed answer);
  plan review cards (Approve / Make changes / Cancel).
  [VERIFIED: `docs/product/workspace.md`, `docs/product/chat.md`, `docs/conversation-coordinator.md`]
- **GameForge:** Same interaction model, but games persist server-side (Postgres +
  filesystem git repos), not in a user folder. Conversations stored in DB (`conversations`,
  `messages`), chat checkpoints as git refs per message (see F8). One project per
  conversation; question cards durable via SSE with stable event IDs (replay after
  reconnect).
- **Reusable:** The *interaction vocabulary* (composer, permission pill, question panel,
  plan cards, rewind) is UI design — freely reimplementable; no code copy needed.
- **Required changes:** Electron IPC → typed REST/SSE API; `~/AI Games` → server project
  storage; Rewind → event-log projection (Genex rewinds are projections, rows stay —
  same model in DB).
- **Limitations:** Rewind UX needs a resolved event-sourcing design in Postgres; keep
  withdrawn-turn markers like Genex (`chat-rewind.ts`).
- **Acceptance:** User describes a game in chat; a project is created; the plan/question
  cards render; answering a question resumes the run; rewinding a message restores the
  conversation projection.

### F2. Agent orchestration (director / workers / judges)

- **Genex:** Three jobs — `planner` (orchestrator), `builder` (workers), `judge`
  (reviewers); the orchestrator's job **never crosses engines** (`CROSSABLE =
  {builder, judge}`) [VERIFIED: `src/harness-seed/loop/model-roles.ts`]. Five modes share
  primitives: **director** (one delegated session + wake/digest loop, ≤30 wakes/hour, 20-min
  heartbeat), **autopilot** (fixed pipeline for direct engines), **facet loop**
  (build⟳verify per facet), **gauntlet** (blind A/B critic — "a pick and the biggest gap,
  never a score"), **spike** (throwaway mini-scene → recipe on 2 consecutive identity
  failures) [VERIFIED: `src/harness-seed/loop/`]. Additional roles: **scout** (read-only
  pre-plan probe; plan clamped to its ceiling), **coordinator**, **art director** ("would
  you ship this?" verdict — defects routed as finish work but **never vetoes a landing**)
  [VERIFIED: `docs/agent/architecture.md`, `docs/harness-runtime.md`].
- **GameForge:** Same role model and mode set, adapted to a server orchestrator:
  director = one Workers AI tool-calling session (the AGENT JOB project already proved
  `openai/gpt-oss-120b` tool-calling works via an OpenAI-compatible client); workers = queued BullMQ jobs with
  per-facet git worktrees/branches; judges = fresh-context one-shot Workers AI calls with
  screenshots attached (vision-capable model where available, else deterministic checks
  labeled "visual assessment unverified"). Execution modes Manual/Auto/Loop map to
  director-on-demand / autopilot-fixed-pipeline / facet-loop-with-budgets. Typed
  **StopCodes** (24 codes in Genex, e.g. `budget`, `circuit-break`, `engine-exhausted`)
  [VERIFIED: `loop/outcomes.ts`] — adopt the typed-code discipline ("never decide behavior
  by matching English text").
- **Reusable:** `model-roles.ts` logic, `outcomes.ts` StopCodes, `loop/` prompt designs
  (MIT, with notice). The harness-seed is Node TS with **no Electron imports** and talks
  to the host only through the typed `HostMethod` RPC vocabulary [VERIFIED:
  `src/shared/harness-api.ts`] — a server host can implement the same RPC surface.
- **Required changes:** Vendor-CLI delegated sessions don't exist for Workers AI → use the
  harness's own tool loop (`turn-loop.ts`, max 30 rounds/turn) with an
  OpenAI-compatible client. Parallel workers limited by
  Oracle CPU/RAM (Genex caps at 12 "a machine on its knees"; server default lower, e.g. 2–4).
- **Limitations:** Workers AI has no sessions/memory across calls — wake/digest must be
  rehydrated from the persisted run journal each wake. No subscription delegation: every
  neuron is billed; budgets are load-bearing.
- **Acceptance:** A run creates planner/builder/judge tasks with per-role models; workers
  build in isolated branches; judges return blind verdicts with provenance; stop codes
  are typed; a run can be paused/resumed/canceled.

### F3. Durable runs (event log, run journal, crash recovery)

- **Genex:** Append-only `EventStore` (single writer, ids minted under a lock; crash
  recovery keeps files), **redaction-on-append** (secrets never reach renderer/logs/
  prompts/games/plugins) [VERIFIED: `src/substrate/event-store.ts`,
  `docs/agent/architecture.md`]. Run journal (`autopilot_<runId>`): worked clock, plan,
  ledger, health, workers, wake state — crash/quit recovery **reopens runs as paused from
  the journal**; stopped/failed/incomplete/delivered stay distinct; a resumed run never
  silently repeats completed work [VERIFIED: `docs/agent/architecture.md`,
  `docs/harness-runtime.md`].
- **GameForge:** Same durability contract on Postgres + BullMQ: append-only
  `agent_events` table (redaction on write), run journal as a JSONB document per
  `agent_runs` row with checkpoint fields; worker crash → BullMQ stalled-job recovery
  rehydrates from the journal; idempotency keys on all side-effecting tool calls.
- **Reusable:** The durability *design* (append-only + redaction + journal + distinct
  terminal states). `secretRedactor` concept reimplemented.
- **Required changes:** File event store → Postgres; wake timers → BullMQ delayed jobs.
- **Limitations:** None fundamental; Postgres must be tuned for append-heavy workload.
- **Acceptance:** Kill the worker mid-run → run reopens as `interrupted`/paused with all
  completed steps intact; no duplicate paid operations (idempotency keys verified in test).

### F4. Visual verification (`window.__studio` instrumentation)

- **Genex:** The studio serves the game over a custom `game://` scheme, rewrites the
  HTML, and injects a shim **before any game code runs**: studio-owned clock, seeded RNG,
  scripted `step()`, `state()` JSON snapshots, `inspect()` scene-graph queries,
  per-camera `capture()` — everything tag-addressed via `userData.tag` [VERIFIED:
  `src/main/page-serve.ts`, `src/game-template/docs/CONTRACT.md`]. Evidence pass =
  deterministic playthrough (`PAGE_SEED=1234`) + screenshots at every named camera +
  structural probes + console/GPU error capture [VERIFIED: `loop/evidence.ts`]. Judges:
  one-question vision checks, blind A/B compares (never scores), an art-director
  ship/no-ship — all fresh-context one-shot sessions; a garbled answer **keeps the
  incumbent**, never reads as tie/defect/failure [VERIFIED: `loop/judge/*.md`,
  `docs/harness-runtime.md`]. Deterministic blank detection without any model via pixel
  statistics (`lumaMean`, `lumaStdDev`, `nearBlackFraction`, `litFraction`) [VERIFIED:
  plugin API 3 `observe`/`still`].
- **GameForge:** Port 1:1 to **server-side headless Chromium via CDP**: the API serves
  game pages through a page server that injects the same `window.__studio` shim before
  game code; Playwright drives deterministic playthroughs (seeded), captures
  screenshots, reads console/network, and runs `state()`/`inspect()` probes via page
  evaluate. Pixel statistics give model-free blank detection. Vision review submits
  bounded screenshots to a vision-capable Workers AI model *only if the model registry
  verifies vision support*; otherwise label "visual assessment unverified".
- **Reusable:** The `window.__studio` contract design and the evidence/judge prompt
  patterns (MIT, with notice). The shim concept is engine-agnostic JavaScript.
- **Required changes:** `game://` scheme + Electron `webContents` → Express page server
  + Playwright CDP; Electron `WebContentsView` pool → headless Chromium pool (bounded by
  server RAM); vision judge → Workers AI vision model w/ capability check.
- **Limitations:** Browser-tab preview can't do cross-origin screenshotting — the live
  user preview uses a cooperative `postMessage` contract + server-captured stills, while
  *authoritative* verification happens server-side in headless Chromium.
- **Acceptance:** Scenario A: seeded playthrough produces screenshots from named cameras,
  zero console errors, pixel stats prove non-blank; judge verdict carries provenance
  (model, prompt hash, image count); garbled verdicts keep the incumbent.

### F5. Build lifecycle

- **Genex:** Template games need **no build at all** (ES modules + vendored three.js,
  "no network at all") [VERIFIED: `scripts/build.mjs` header]. A game is **never built
  in the user's folder**: mirrored into `scratch/builds/<project>-<hash>/`, memoized on
  a tree key; a failed build shows the **last good output with the reason**; judged loads
  never see stale output [VERIFIED: `src/main/game-build.ts`, `docs/agent/architecture.md`].
  Builds: 5-min timeout, 10-min install; installs only from `registry.npmjs.org` behind an
  explicit button [VERIFIED].
- **GameForge:** Same shadow-build discipline on the server: build in ephemeral
  per-build directories (content-keyed memoization), keep `lastGood` artifact; build
  phases per master prompt §11 (validate → install → typecheck → unit → bundle →
  preview server → Chromium smoke → console/network → gameplay smoke → screenshots →
  acceptance → verdict). Game templates: keep Genex's no-build discipline where
  possible — serve ES-module games directly; use Vite build only where the template
  needs it.
- **Reusable:** `GameBuilds` class design (MIT, with notice); the memoization and
  last-good patterns.
- **Required changes:** Desktop scratch dirs → server build dirs + artifact storage;
  real bundling (Vite) for TS templates where Genex needed none.
- **Limitations:** Oracle CPU/RAM bounds parallelism; build caching must be disk-aware.
- **Acceptance:** Scenario C: deliberate syntax error → build `failed` with diagnostics
  to the agent; previous working build still playable; correction attempted within
  retry budget.

### F6. Project persistence

- **Genex:** Games are **real local folders**; library indexed by canonical folder;
  removal *hides* the entry, never deletes user data; rename never renames the folder
  [VERIFIED: `docs/product/workspace.md`, `docs/agent/architecture.md`]. Renderer state
  is view-only (Zustand); `localStorage` keys centralized; secrets never reach renderer
  [VERIFIED: AGENTS.md].
- **GameForge:** Projects = server git repos (one per project) + Postgres metadata;
  **localStorage is never authoritative** (per master prompt §5). Dashboard reads from
  the API. Delete = archive flag (recoverable); hard delete requires confirmation and a
  grace period.
- **Reusable:** The "hide, don't delete" and "rename ≠ folder rename" policies.
- **Required changes:** Filesystem-on-user-disk → server storage + DB metadata.
- **Limitations:** Export/import must preserve the git history to be meaningful.
- **Acceptance:** Create/rename/duplicate/archive/delete/export/import all work from the
  dashboard; a deleted project is restorable within the grace window.

### F7. Templates

- **Genex:** The studio's own game template (contractVersion in `studio.json` + vendored
  three import map) gets full run support; `ProjectShape` decided by *evidence* (scripts,
  package.json, bundler config), never the filename; eight game *kinds* (first-person,
  third-person, top-down, side-2d, racing, flight, static-board, free-camera), each with
  traits, probe axes, eye cameras, a critic and a play script [VERIFIED:
  `docs/agent/architecture.md`, `loop/kinds.ts`].
- **GameForge:** Eight functional starter templates per master prompt §5 (empty
  three.js, 3D first-person, third-person, racing, 3D platformer, 2D arcade (Phaser/Pixi),
  puzzle, physics sandbox with Rapier) — each a real working project implementing the
  `window.__studio` contract (seed/step/state/inspect/capture), with declared kind
  traits, probe axes and a smoke play-script.
- **Reusable:** The kind/trait/probe-axis design (MIT, with notice). three.js vendoring
  idea (pin versions, serve locally).
- **Required changes:** Electron game-template → web templates implementing the shim
  contract; Vite build for templates that need it.
- **Limitations:** Phaser/canvas2D templates get reduced instrumentation (Genex marks
  Phaser/canvas2D "out of scope" for the shim — be honest about coverage per template).
- **Acceptance:** Each template opens, plays in preview, passes its smoke play-script,
  and exposes the `__studio` contract (verified by a conformance test per template).

### F8. Versioning and rollback

- **Genex:** "Snapshot engine (git instead of Docker commit/save/load)" — snapshot = **git
  commit + tag** recorded in the event log; restore = checkout; "instant, diffable …
  kilobytes" [VERIFIED: `src/substrate/snapshots.ts`]. Run versioning on studio refs
  (`refs/studio/runs/<runId>/…`); chat checkpoints per message on
  `refs/studio/chat/<thread>/before|after/<message>` (private index, hooks off; never
  captures `.env`/`node_modules`/`dist`/`.studio`; keeps 100 checkpoints/chat)
  [VERIFIED: `src/main/chat-checkpoints.ts`]; asset checkpoints per delivery; harness
  snapshots with wedge-watchdog rewind to newest healthy [VERIFIED].
- **GameForge:** Identical model, server-side: one git repo per project under backend
  storage; same namespaced refs; same never-capture list; same keep-limits; restore =
  checkout + re-serve. Optimistic concurrency in the code editor via expected-commit-SHA
  on save (prevents silent overwrites); agent edits always checkpoint first.
- **Reusable:** `snapshots.ts` design and the ref-namespace scheme (MIT, with notice).
- **Required changes:** Local git → server git (same tool); DB links build→commit.
- **Limitations:** Large binary assets bloat repos → git-lfs or content-addressed
  asset store with DB metadata (master prompt §22: no large binaries in relational rows).
- **Acceptance:** Checkpoint before every agent edit; compare/restore any revision from
  UI; last-known-good build linked to its commit; concurrent user+agent edit on one
  file → conflict surfaced, never silently overwritten.

### F9. Asset management

- **Genex:** `ASSET_FORMATS` table (extension → kind/viewer/MIME/thumbnail reader);
  models glb/gltf/obj/fbx/stl/ply; images incl. hdr/exr/ktx2; audio mp3/wav/ogg/opus/m4a/
  aac/flac; video mp4/webm/mov/ogv [VERIFIED: `src/shared/game-assets.ts`].
  **Delivery is host-owned** — "a plugin can neither forge nor skip it" [VERIFIED].
  `ProjectAsset` provenance: file (relative), kind, bytes, source
  (`genex`|`blender`|`imported`|plugin id), jobId, generationId, prompt, availability
  (project/integration/worker + revision), `use` stage **unconfirmed/integrated/verified**
  ("A delivered file is never evidence the game uses it") [VERIFIED].
  Blender flow: `assets/<name>.glb` + `assets/src/<name>.py`; `loadAsset`/`preloadAssets`
  [VERIFIED: `src/game-template/src/assets.js`].
- **GameForge:** Same asset model in Postgres (`assets` table + filesystem/object store
  by content hash): format table, host-issued delivery records, provenance metadata,
  the unconfirmed→integrated→verified ladder (verified = observed loaded by the running
  game via the `__studio` probe). Viewers: three.js model viewer, native
  audio/video/image; lazy loading, size caps (Genex: 16 MiB stills, 100 MiB previews).
  Generation providers: **mandatory baseline** = procedural three.js geometry, procedural
  materials, canvas textures, open-licensed import, user upload; **optional** = Blender
  headless (API-3-style native job on the server, bounded outputs) and third-party
  generation APIs behind capability-checked adapters that appear *unavailable* when not
  configured — never as dead buttons (master prompt §14).
- **Reusable:** Format table and provenance model design (MIT, with notice).
- **Required changes:** Electron asset preview → web viewers; native Blender process →
  containerized Blender job on Oracle (only if the instance supports it — check OS/arch/
  RAM first, else keep the adapter disabled with a transparent explanation).
- **Limitations:** No Workers AI 3D/music/video generation — never claim it. Blender
  availability depends on the Oracle instance.
- **Acceptance:** Scenario E: GLB import → validated, metadata stored, preview renders,
  model loads in the running game (verified stage), runtime loading checked.

### F10. Plugin architecture

- **Genex:** A plugin = **prebuilt directory**: `plugin.json` manifest + backend ES
  module + optional isolated HTML panels. **No npm install, no build hook, no archive
  extraction** [VERIFIED: `docs/plugins.md`, `src/plugin-sdk/index.d.ts`]. Manifest:
  apiVersion 1|2|3 (additive), capabilities (`settings`, `project.read/write`,
  `credentials`, `external-auth`, `observe`, `jobs`, `network`, `export`,
  `native-runtime`), tools named `<plugin>__<tool>`, panels in sandboxed iframes
  (opaque origin, strict CSP), ≤32 network hosts, ≤4 MCP servers. **Backends are trusted
  native code — "a process is crash isolation, not a sandbox"** (stated in the trust
  dialog) [VERIFIED: `docs/PLUGIN_GUIDE.md`]. Three install states
  (enabled/disabled/not-enabled); static scan + startup probe; reinstall from recorded
  origin; **agents can never install/enable plugins**; host-owned consent cards agents
  can't bypass or answer [VERIFIED]. Bundled examples: **blender** (API 3,
  native-runtime) and **genex** (asset gen + publishing), plus an `example` scaffold
  plugin [VERIFIED: `src/plugins/`].
- **GameForge:** Same shape, web-adapted: prebuilt directory + `plugin.json`; panels as
  sandboxed iframes (opaque origin, CSP: no network/forms/external scripts); backend
  tools run **server-side in containers** (stronger than Genex's crash-isolation, since
  GameForge executes untrusted generated code by design); capability declarations;
  host-owned consent cards; agents can never install/enable. Ship two working example
  plugins (e.g. procedural-geometry + asset-import) + a Blender example gated on server
  capability; full developer docs (`docs/PLUGIN_GUIDE.md` equivalent).
- **Reusable:** SDK design and manifest schema concepts (MIT, with notice) — reimplement,
  don't copy the `.d.ts` verbatim unless preserving notice.
- **Required changes:** Native child processes → containerized plugin backends;
  `studio-plugin:` scheme → sandboxed iframe + `postMessage` bridge.
- **Limitations:** Third-party plugins are still *user-trusted code*; the trust dialog
  must say exactly what Genex's says.
- **Acceptance:** Install/enable/disable/configure/remove a plugin; tool consent card
  blocks until the user answers; an agent cannot enable a plugin (tested); example
  plugins actually work end-to-end.

### F11. Learning and self-improvement

- **Genex:** SkillOpt loop (ported from **microsoft/SkillOpt**, MIT): bounded edits,
  failure-priority merge, **gate = strict improvement on a held-out set; rejected edits
  go into a step buffer**; runs after every finished run **on the engine that ran the
  run**; auto-apply **OFF by default**; every learned change individually undoable
  [VERIFIED: `loop/skillopt.ts`, `docs/product/studio-learning.md`]. Recipe library
  mined from passing spikes (`library/recipes/*.json`); validation-fork self-edit gate
  (`guardian.validate_edit` — vendored TS typecheck + boot + healthcheck, fails closed)
  [VERIFIED: `src/main/core/self-edit-gate.ts`]. Honest gates: "a learning count does
  not certify a better game"; "keep automatic learning off until its own measured
  acceptance is established"; pinned eval briefs never reworded [VERIFIED:
  `docs/evals.md`].
- **GameForge:** Same loop, server-side: run ledgers in Postgres; SkillOpt-style
  improvement proposals with diffs + undo; recipe library as DB records; validation fork
  = container running typecheck + boot + healthcheck before a harness-skill change
  lands; auto-apply off by default; memory scopes (project / studio / run) in Postgres
  with summarization and relevance retrieval (no full histories in prompts); memory
  versioning + inspectability.
- **Reusable:** SkillOpt itself is MIT (microsoft/SkillOpt) — the honest-gate design
  transfers; prompt patterns reimplementable.
- **Required changes:** File ledgers → Postgres; validation fork → container job.
- **Limitations:** No vector/semantic memory in Genex's design — GameForge starts the
  same way (keyed retrieval); embeddings optional later.
- **Acceptance:** A repeated failure produces a proposal with a diff; applying it is
  undoable; the held-out gate rejects non-improvements; agent instructions can never
  override security policy (tested).

### F12. Security boundaries

- **Genex:** Explicit zones — main trusted; renderer untrusted (sandboxed, no
  Node/Electron imports, 177 typed API methods); harness child untrusted (Seatbelt/
  seccomp via `ProcessSandbox`, the single spawn gate; default **empty network
  allowlist**; credential homes deny-read; per-run overlays can only *add* denies;
  credential-shaped env vars stripped) [VERIFIED: `src/main/index.ts:8-13`,
  `src/substrate/spawn.ts`, `docs/agent/architecture.md`]. Game pages: untrusted web
  content in a closed partition (separate session, no preload/IPC, navigation locked
  down, network allowlisted to the studio server + CDNs) [VERIFIED:
  `src/main/preview.ts`]. IPC channels classified fixture-safe/native at creation;
  unclassified fails closed [VERIFIED: `src/main/dev/native-policy.ts`]. Secrets in
  OS keychain (safeStorage), redaction-on-append everywhere [VERIFIED].
  **Documented residual risks** (Codex can read the whole disk; npm install briefly
  opens the registry process-wide) [VERIFIED].
- **GameForge:** Server-side mapping (master prompt §10, §25): seatbelt/seccomp →
  **rootless containers** (dedicated non-root user, no privileged containers, no Docker
  socket inside, read-only rootfs where practical, CPU/RAM/pid/timeout quotas,
  restricted network, no access to Postgres/Redis/cloud-metadata); renderer →
  browser with a **typed REST/SSE API** (OpenAPI + zod); game partition → sandboxed
  iframe (opaque origin) + restrictive CSP on a **separate preview origin**; secrets →
  server-side encrypted vault, never in client bundles, redaction-on-append to logs;
  infrastructure access boundary (VPN/private network) since there is no login but the
  backend executes code. Threat model + residual risks documented honestly (see
  `docs/THREAT_MODEL.md` to be written in Phase 7).
- **Reusable:** The zone model, the typed-channel discipline, redaction-on-append, the
  honest residual-risk documentation practice.
- **Required changes:** OS sandbox → container sandbox (the single biggest substitution);
  keychain → server vault; Electron partitions → origins + iframe sandbox + CSP.
- **Limitations:** Containers are heavier than Seatbelt; Oracle instance sizing decides
  runner concurrency (inspect at startup, disable heavy capabilities when unsupported).
- **Acceptance:** Security test suite (§27): path traversal, unsafe commands, network
  isolation, invalid uploads, secret exposure, request limits, runner cancellation,
  malformed tool calls — all blocked; threat model documents residual risks.

### F13. Export and publishing

- **Genex:** `export.stage` host service → audited exporter: builds the game, stages a
  public copy (excludes hidden/env/key/deps/symlinks; prunes vendor by imports;
  **secret scan refuses files containing known credential values**); the *cover* is one
  real 16:9 frame from the game's own `genex-cover` demo [VERIFIED:
  `src/plugins/genex/publish.ts`, `src/main/core/genex-cli.ts`]. Publishing itself
  (`preview`/`promote`/`rollback` to `<slug>.genex.technology`) is the proprietary
  platform — not reusable [VERIFIED: `genex.games/docs/guide/publish-your-game.md`].
- **GameForge:** Server-side exporter with the same exclusion list + secret scan;
  downloadable ZIP (source + package metadata + README + reproducible build
  instructions, no keys) — Scenario F. Cover = real 16:9 frame captured headless from
  the game's cover demo. Publishing: GameForge needs its **own** hosting story
  (Vercel/static export of the built game is the honest baseline); never touch
  Genex's platform.
- **Reusable:** Exporter exclusion/secret-scan design (MIT, with notice).
- **Required changes:** Desktop exporter → server job producing a ZIP download.
- **Limitations:** No gallery/publishing platform in v1 — export ZIP + static hosting
  guide; mark "publishing platform" as not-implemented in FEATURE_MATRIX.
- **Acceptance:** Scenario F passes: ZIP downloads, builds reproducibly, contains no
  secrets (verified by scan test).

### F14. Live preview

- **Genex:** Native view (WebGL/WebGPU); Play/Stop/Reload, sound switch, fullscreen;
  live-behind gate lights Reload when a new build waits; preview partition closed by
  default [VERIFIED: `docs/product/builds-live.md`, `src/main/preview.ts`].
- **GameForge:** Dedicated Live Preview panel: Play/Stop/Reload, fullscreen,
  mute/unmute, keyboard focus, touch controls where supported, viewport presets, FPS
  counter, resolution, runtime errors, build revision, loading status — served from a
  **separate preview origin** in a sandboxed iframe with restrictive CSP; preview
  builds get no API secrets. WebGL required; WebGPU progressive enhancement; clear
  fallback for unsupported browsers (master prompt §12).
- **Reusable:** The control vocabulary and the closed-partition network policy concept.
- **Required changes:** `WebContentsView` → iframe; `webContents.executeJavaScript`
  probes → cooperative `postMessage` `__studio` contract (the page *reports* readiness —
  Genex's own principle: "readiness a fact the page reports rather than a wait").
- **Limitations:** No cross-origin screenshotting from the browser — authoritative
  captures happen server-side.
- **Acceptance:** Preview plays the last verified build; a failed new build doesn't
  blank it (last-good); runtime errors surface in the console panel; works on
  mobile/tablet viewports.

### F15. Code editor, dashboard, activity, settings

- **Genex:** Builds stage = run graph ("You asked → parts → Your build → lead") with
  per-node agent screens, verdict records, delivery cards with Play [VERIFIED:
  `docs/product/workspace.md`]. Embedded terminal (xterm + node-pty) [VERIFIED].
  Studio assistant = separate tool-free chat about runs/learning [VERIFIED: glossary].
  Settings: providers, local models, appearance, games root, harness, permissions,
  privacy, about, diagnostics copy [VERIFIED].
- **GameForge:** Left/center/right studio layout per master prompt §4 (resizable panels,
  collapsible nav, mobile tabs/drawers); Monaco editor with file tree, diff, search,
  optimistic concurrency (expected-commit-SHA); build graph view; Activity panel
  (jobs, decisions, tool calls, model calls, errors, retries) + diagnostics dashboard
  (health, DB/Redis, queue depth, containers, disk/mem/CPU, AI usage/latency);
  settings per master prompt §21 (never expose key values; persist across restarts).
  Embedded terminal → server-side PTY over websocket (or deferred if it risks the
  security model — decide in Phase 5).
- **Reusable:** Layout and information architecture ideas; the run-graph presentation.
- **Required changes:** Everything Electron → web components.
- **Limitations:** Mobile gets a simplified (but real) editing experience.
- **Acceptance:** No dead buttons — every control wired; empty/loading/error states;
  keyboard navigation; reduced-motion respected.

---

## 3. What Genex deliberately does NOT do (and GameForge must not claim)

1. No Unity/Unreal integration (Unity retired; "soon" never shipped) [VERIFIED].
2. No Phaser/canvas2D support in the instrumentation contract ("out of scope")
   [VERIFIED: `docs/agent/architecture.md`].
3. Engine-export games can be played/photographed but **can never start a run**
   [VERIFIED].
4. Scores are banned from judging ("scores drift upward") — verdicts are picks + gaps
   [VERIFIED: `loop/gauntlet.ts`].
5. Metered engines are never auto-selected [VERIFIED].
6. Plugin backends are crash-isolated, **not** OS-sandboxed — stated in the trust dialog
   [VERIFIED]. GameForge's container story is *stronger*; say so honestly.
7. The asset-generation backend, publishing platform, multiplayer relay and player
   identity are proprietary services — not in the repos, not reusable [VERIFIED].

## 4. Architecture decisions for GameForge (derived from the analysis)

1. **Harness portability:** Reimplement the `HostMethod` RPC vocabulary on a Fastify
   server; keep the planner/builder/judge role model, the five loop modes (director,
   autopilot, facet loop, gauntlet, spike), typed StopCodes, and the wake/digest
   pattern (rehydrated from the Postgres run journal — Workers AI has no sessions).
2. **`window.__studio` contract:** The single highest-value mechanism. Implement the
   page server + shim injection + CDP-driven evidence pipeline first (Phase 3), because
   every acceptance scenario depends on it.
3. **Versioning:** One git repo per project on the server; Genex's ref-namespace scheme
   (`refs/studio/runs/<id>/…`, chat checkpoints per message) adopted verbatim.
4. **Cost design:** Per-completion usage accounting, per-role model selection with a
   live capability registry (never hardcode model names — Genex's own rule; Workers AI model
   availability is probed at startup as the master prompt requires), budgets + wall
   clocks + exponential backoff, metered-everything posture (Workers AI is always metered).
5. **Security:** Container-based runner (the seatbelt→container substitution), typed
   API (OpenAPI + zod), redaction-on-append, server vault, separate preview origin +
   sandboxed iframe + CSP, infrastructure access boundary (no login by design).
6. **Honesty rules (adopted from Genex's engineering discipline):** never decide
   behavior by matching English text (typed codes); a finished worker / passing checks /
   integration / live revision are distinct facts never merged in summaries; builds are
   *verified*, *partial* or *failed*; garbled judge output keeps the incumbent; "a
   delivered file is never evidence the game uses it"; never describe a focused test
   pass as a full run.

## 5. Open questions / risks for later phases

- **R1.** Oracle instance sizing (CPU/RAM/arch) — unknown until inspected; decides
  Chromium pool size, Blender viability, worker concurrency. (Check in Phase 2/6.)
- **R2.** Workers AI vision-capable models — availability and limits verified at startup via
  the model registry; semantic review degrades gracefully to deterministic checks.
- **R3.** Workers AI rate limits under parallel workers — the provider failure ladder
  (rate-limit → backoff → reduce concurrency) needs real-world tuning.
- **R4.** Blender on Oracle Linux — CPU-only workflows, bounded complexity; keep the
  adapter disabled with a transparent explanation if the instance can't run it.
- **R5.** No-login + code execution: the infrastructure access boundary (VPN/private
  connectivity) is a deployment prerequisite, not a code feature — document it as such.

---

*End of REFERENCE_ANALYSIS.md — Phase 1, task 1. Next: architecture definition, security
model, DB schemas, and FEATURE_MATRIX.md.*
