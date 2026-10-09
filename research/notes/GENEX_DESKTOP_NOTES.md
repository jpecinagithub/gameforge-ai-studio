# Genex Desktop — Deep-Dive Research Notes

**Repo:** `https://github.com/genex-games/genex-desktop` (shallow clone `--depth 50`,
HEAD `d6ee9ce`, branch main), at `~/workspace/gameforge-ai-studio/research/genex-desktop/`.
**Researched:** 2026-10-09 by 4 parallel read-only workers + direct reads. No code was
executed, no `npm install` run, nothing written into the clone.

**Claim marking:** every substantive claim is tagged **VERIFIED** (file path + line/doc
that proves it) or **INFERRED** (reasoned from code, not stated). Claims from worker
reports are cited as found; I spot-checked the most important ones.

**License:** MIT, copyright 2026 genex.games (VERIFIED — `LICENSE`). Reuse must preserve
the copyright + permission notice. Separate trademark rights apply to the Genex brand
(see §16).

---

## 0. One-paragraph picture

Genex (formerly "AI Game Studio") is a **macOS Electron app** (`productName: "Genex"`,
`description: "Self-improving AI game studio for macOS on Apple Silicon"`,
VERIFIED — `package.json`) for making **local browser games** with AI. The user describes
a game in chat; coordinated AI agents (a director/orchestrator, workers, judges) write,
build, preview, screenshot-verify and iterate real game projects stored in `~/AI Games`.
It ships **no LLM itself**: it borrows the user's Claude Code / ChatGPT subscriptions, or
runs local models (Ollama, bundled Bonsai 27B). The app's core value is the **agent harness**
(`src/harness-seed/` — agent-editable TypeScript), the **sandboxed preview/verification
pipeline** (`window.__studio` instrumentation + host-driven screenshots/probes), and the
**git-refs versioning model**. Everything the studio needs that is proprietary lives
behind Genex-hosted services (`api.genex.games`, publishing, asset generation) — none of
that backend is in the repo.

---

## 1. Feature inventory

(VERIFIED — `docs/product/workspace.md`, `chat.md`, `builds-live.md`, `models-context.md`,
`assets-plugins.md`, `studio-learning.md`, `docs/agent/feature-map.md`; confirmed
`docs/agent/context.md`.)

1. **Home composer / New game** — launch opens a home composer; typing an idea starts a
   game the model names; one game per conversation; games live in `~/AI Games` by default.
2. **Game chat** — one conversation per game; Markdown replies, file links, streamed
   replies, message queue, Rewind to any message, "Restore game files" checkpoint restore.
3. **Live preview** — native view playing the browser game (WebGL/WebGPU); Play/Stop/Reload,
   sound switch, fullscreen; live-behind gate lights Reload when a new build waits.
4. **Builds stage** — run graph ("You asked → parts → Your build → lead"), per-node agent
   screens, verdict records, delivery cards with Play.
5. **Assets stage** — cards for `assets/` + `public/assets/` grouped by source
   (Genex/Blender/plugin/hand-made); previews for images, audio/video, 3D models, textures.
6. **Prompt bar** — model picker (Main agent / Workers / Reviewers roles), permission pill
   (Auto · Manual · Accept edits · Plan · Bypass permissions), Auto/Loop mode with time
   limits, Plan mode, image/reference attachments, plugin & MCP switches, context ring.
7. **Questions & plans** — `ask_user` opens a question panel (options + typed answer);
   plan review cards (Approve / Make changes / Cancel).
8. **Model providers** — Claude Code (subscription CLI), Codex (ChatGPT/Codex CLI), Ollama
   (local), Bonsai 2 (managed local, Apple Silicon), OpenRouter + OpenCode (metered, never
   auto-chosen).
9. **Studio (self-improvement)** — separate assistant conversation + Activity feed; harness
   proposes instruction changes with diffs, apply/undo per change; "Apply suggestions
   automatically" off by default; max concurrent workers default 4, up to 12.
10. **Plugins** — Plugins page; install from GitHub (sha-pinned), local folder, curated
    marketplace; isolated panels; toolbar buttons; tool consent cards; bundled Genex
    (AI asset generation) and Local Blender plugins.
11. **MCP connectors** — stdio/HTTP/SSE servers, browser OAuth, per-project scoping,
    `<connector>__<tool>` namespaced tools, per-call consent unless saved.
12. **Genex publishing** — Publish button → tests draft → publishes to genex.games; staged
    16:9 `genex-cover` demo frame sent as gallery cover.
13. **Export game** — chat header → Export game…; static web bundle to the profile's
    exports folder.
14. **Embedded terminal** — xterm.js + node-pty project shell in a dock below chat;
    "Run" a one-line `bash` block from a reply.
15. **Notifications bell** — questions/plans/permission requests persist until answered;
    macOS notifications + Dock badge when unfocused.
16. **Games library** — search (local BM25), pin/unpin, rename, change image, delete
    (files kept; reopening folder restores), animated cover spheres.
17. **Open existing folder** — adopts an outside folder as a game (contract install,
    `CLAUDE.md`/`NOTES.md` seeded).
18. **Settings** — Model Providers, Local Models, Appearance (theme presets + custom
    palettes), Games root folder, Harness, Permissions (saved rules), Privacy, About;
    Copy diagnostics.
19. **Welcome onboarding** — first-launch flow: "Plan your game → Build with workers →
    Reviewers test it", then connect a model.
20. **Send feedback** — sidebar bug icon sends message + optional logs/chat to
    `api.genex.games/api/desktop/feedback`.
21. **Auto-update** — "Relaunch to update" (macOS/Windows), "Download" on Linux; respects
    active runs.

---

## 2. User interaction flows

(VERIFIED — `docs/product/workspace.md`, `chat.md`, `builds-live.md`;
`docs/conversation-coordinator.md`; `docs/agent/architecture.md`.)

1. **Describe** — launch → home composer → type the idea. First message names the game
   and creates its folder.
2. **Configure** — prompt bar sets model (Main/Workers/Reviewers), permission mode (Auto
   recommended), Auto vs Loop (time limit). Optionally Plan mode for a one-message
   reviewed plan; attach references/images.
3. **Converse (Auto)** — chat's own session (Claude Code / Codex / local) answers; asks
   real questions (`ask_user` panel); permission requests pin above the composer until
   answered. Edits go straight into the game folder.
4. **Build (Loop)** — send with Loop on starts a run: a read-only **scout** looks at the
   game, the director **plans** facets, parallel **workers** build in Git worktrees, blind
   **judges** pick winners, an **art director** polish look runs at the finish mark, the
   close judges the head and **lands** it into the game folder.
5. **Monitor** — Builds graph shows parts/workers/judgements; live chat with the lead
   (messages reach it mid-build); steer via message; Stop/Finish/Resume; a morning card
   summarizes the close.
6. **Play** — Live tab plays the running game; a new healthy build lights Reload;
   "Play this build"/"Make it live" controls.
7. **Assets** — Assets tab shows delivered media grouped by source/job.
8. **After the build** — the same session answers follow-ups (small edits directly with
   Loop off; reopens the finished run from its journal with Loop on); paused runs resume
   with remaining time.
9. **Rewind** — any sent message offers Rewind — chat history projects back; optionally
   restore the game folder to that message's checkpoint.
10. **Ship** — Export game… (static web bundle); Publish via Genex (draft → public
    listing with cover frame).

---

## 3. Agent orchestration design

### 3.1 Roles: planner / builder / judge

(VERIFIED — `src/harness-seed/loop/model-roles.ts:13-19`, `docs/agent/architecture.md`
"Roles across providers".)

Every game run has three jobs:
- `planner` ("Orchestrator") — interviews the user, plans the facets, re-points checks.
- `builder` ("Workers") — build the base, every facet, the spikes, the merge.
- `judge` ("Judges") — vision checks, taste, code review, playtester, panel.

`resolveRoles()` splits one user pick into all three; `normalizeRoles()` handles explicit
per-role selections from the composer UI; `withRoles()` stamps a run spec once at launch.
The orchestrator's job **never crosses to another engine** (VERIFIED,
`CROSSABLE = {builder, judge}`, `model-roles.ts:116`). Only builder and judge may run on
a different ready provider than the orchestrator (`crossesTo`).

### 3.2 Two fundamentally different execution paths

(VERIFIED — `build-turn.ts`, `model-roles.ts:308-346`; worker report.)

1. **Delegated engines** (Claude Code, Codex) — "your subscription, their harness". The
   studio holds a *session* in the vendor CLI (`engine.delegate` RPC) and the vendor's
   harness does the tool loop. Studio tools reach them as **MCP tools**
   (`mcp__studio__<name>` for Claude Code) or via a **shell bridge**
   (`node .studio/bridge/tool.mjs <name> --field=value` for Codex/OpenCode — literal must
   match `BRIDGE_DIR` in `src/substrate/engines/studio-bridge.ts`, held together by a
   conformance test, `tests/conformance/engine-voice.test.ts`).
2. **Direct engines** (Ollama, OpenRouter, Bonsai) — the harness runs **its own tool loop**
   (`turn-loop.ts`): `turn.begin` → up to `BUILD_TURN_MAX_ROUNDS = 30` completion rounds →
   `turn.end`. The tool registry is **rebuilt every round by re-scanning `tools/*.ts`
   with an mtime cache-buster** — so the agent can install/use a tool in the same turn
   (VERIFIED — `src/harness-seed/tools/index.ts` header).

### 3.3 Execution modes (all VERIFIED; AGENTS.md names all five; code in `loop/`)

All modes share primitives from `loop/git.ts`, `evidence.ts`, `build-turn.ts`,
`config.ts`, `outcomes.ts` (no classes/DI/FSM libraries):

- **director** (`loop/director.ts`, ~754 lines) — *"the run as one agent's decisions, not
  a program's phases."* One delegated session is in charge, with harness-machinery tools:
  `plan`, `goal_update`, `worker_start` (fork gate, contract, own worktree + window),
  `worker_status/steer/stop`, `judge`, `playtest`, `integrate`, `show`, `look`, `note`,
  `finish`. Driven by a **wake loop** (`director/wake.ts`): the director ends its turn
  after each decision and is woken with a digest (user words verbatim, what happened,
  where the run stands; at most 30 wakes/hour; 20-min heartbeat). Only for engines that
  can hold a session. Plan-review gate: `worker_start` refuses until `plan` was called.
- **autopilot** (`loop/autopilot.ts`, ~2988 lines) — the classic fixed pipeline: interview
  → decompose into typed specs → base builder → facet loops through the scheduler,
  continuously merged into a run-level integration branch → integration facet → global
  verdict → close. *Kept for direct engines, which cannot hold a session, and as
  `run.classic`.* Parallel worktrees on delegated/cloud; **sequential on direct local**
  ("a 30 tok/s GPU is saturated by one stream").
- **facet loop** (`loop/facet-loop.ts`) — one facet's build⟳verify loop: spike (if
  identity check keeps failing) → brief into `.studio/BRIEF.md` → build in a persistent
  contractor session → code review → evidence (spec cameras, eye cameras, motion strip,
  audio) → checks (scene/pixel/probe/demo + one-question vision judge + playtester) →
  scoreboard compare → accept on "no regression and ≥1 flip" → commit or retain-on-ref +
  rollback.
- **gauntlet** (`loop/gauntlet.ts`, ~830 lines) — one unattended run; **fresh-context blind
  critic** compares actual output vs reference (labels stripped, order shuffled); returns *a
  pick and the single biggest remaining gap, never a score* ("scores out of 10 drift
  upward"); incumbent only advances on a clear win; ties/errors keep the incumbent and
  roll back.
- **spike** (`loop/spike.ts`, ~728 lines) — when an identity check fails **2 iterations
  running** (or tagged `hard`), a throwaway mini-scene (one HTML page, subsystem alone,
  same check) in its own worktree; a passing spike yields a **recipe** (code + check +
  evidence) ported into the facet and stored in the technique library.

Additional loop parts (VERIFIED — `docs/agent/architecture.md`): **scout** (read-only
recon before the plan; reports setup, builder count, what exists; `decompose` clamps
facets to that ceiling), **integrator** (merge), **playtester**, **replan**, judges
(vision, taste, code review).

### 3.4 How agents are spawned

(VERIFIED — `src/main/studio-core.ts`, `src/substrate/spawn.ts`, `src/harness-boot/bootstrap.mjs`.)

AGENTS.md hard invariant: *"Every spawned agent or game process goes through
ProcessSandbox."* `StudioCore.#createSandbox()` creates it; `src/substrate/spawn.ts`
(~1006 lines) wraps `@anthropic-ai/sandbox-runtime` (Seatbelt on macOS, srt-win on
Windows). The harness itself runs as a plain-Node child via `ELECTRON_RUN_AS_NODE` through
`ProcessSandbox.spawnLongLived` (`src/substrate/harness-host.ts:282`); the fixed,
non-agent-editable `harness-boot/bootstrap.mjs` speaks the substrate protocol and
dynamically imports the agent-editable harness — the fixed point of the self-modification
story. `src/genex-host/preload.mjs` handles host-only credential transport for the
bundled Genex CLI (token over fd 3, never argv/env/disk).

### 3.5 Models / engines / capability registry

(VERIFIED — `src/shared/providers.ts`, `src/substrate/engines/types.ts`,
`registry.ts`, `model-catalog.ts`; `docs/connections-and-context.md`,
`docs/local-models.md`, `docs/agent/architecture.md`.)

The app abstracts LLMs as **engines**, not providers:

| Engine id | Billing | Role support | Mechanism |
|---|---|---|---|
| `claude-code` | subscription (Claude plan) | presets | Delegated session |
| `codex` | subscription (ChatGPT plan) | presets | Delegated session |
| `bonsai` | local | completion | Bundled 27B ternary model, local session |
| `ollama` | local | completion | Completion-only, user's local server |
| `opencode` | metered | sessions | — |
| `openrouter` | metered | sessions | API key pasted in Settings, OS secret store |

- **Capability model**: `EngineModel` carries `contextWindow`, `supportsFast`,
  `supportsTools`, `supportsVision`, `efforts`, `defaultEffort`
  (`substrate/engines/types.ts:459-461`, `registry.ts:154-168`); `EngineDescriptor` adds
  `supportsSessions`, `compactsNatively`, status, usage, catalog. Model catalogs are
  **discovered live** (Codex keeps `models_cache.json`; `ModelCatalog` coalesces snapshots);
  the seed's `CLAUDE_CODE_MODELS`/`CODEX_MODELS` rows are empty fallbacks.
- **Known model ids in seed**: `FABLE="claude-fable-5-1"`, `OPUS="opus"`,
  `SOL="gpt-5.6-sol"`, `TERRA="gpt-5.6-terra"` (`model-roles.ts:91-94`); evals used
  `claude-opus-5-5` and `gpt-6.1-sol` (`evals/lanes.json`).
- **Completions path**: `@earendil-works/pi-ai ^0.84.2` (devDependency,
  `package.json`) — OpenAI-compatible completions used by Ollama & OpenRouter engines:
  message conversion, tool calling, stream drain, usage/cost accounting
  (`pi-completions.ts`); custom undici dispatcher with no headers/body timeout
  ("long-haul fetch" — a 27B model can emit one tool call for ~5 min).
- **Bonsai** (bundled local): pinned 27B ternary GGUF weights from HuggingFace
  (`bonsai-2:27b-pq2_0` 7.2GB, `bonsai-2:27b-ptq1_0` 5.9GB) + projector
  (`src/substrate/bonsai/manifest.ts`); FIFO inference queue so a waiting director never
  holds the slot its workers need; idle server stops after 5 min; 102,400-token working
  context (≥32 GiB Macs).
- **Per-role effort**: one composer effort mapped per role by `nearestEffort` into
  `roles.efforts`; judges always run `LIGHT_EFFORT = "low"`.
- **Auto-compaction**: per-provider auto-compaction (host sends no threshold to Claude
  Code/Codex); Compact-now works on every engine; direct-engine tool loop appends an
  append-only log and auto-compacts when history outgrows the context window.

### 3.6 Token / cost controls

(VERIFIED — `substrate/engines/pi-completions.ts`, `model-loop/tool-loop.ts`,
`loop/config.ts`, `director/budgets.ts`, `src/shared/providers.ts`, `evals/prices.json`.)

- **Usage tracked per completion**: `Usage { input_tokens, output_tokens,
  cache_read/write_tokens, cost_usd, engine }`; pi-ai prices replies from per-token
  catalog prices — **zero for local models** ("the reason unattended runs are viable").
- **Context budgeting in the tool loop**: `MAX_TURN_IMAGES = 4` pictures,
  `IMAGE_TOKENS = 2048` each, `REPLY_RESERVE_TOKENS = 4096`, `CHARS_PER_TOKEN = 4`;
  thread compaction (`compact.ts`): append-only log, auto-compaction when history outgrows
  the model's context window, summarizer at low effort.
- **Billing policy**: billing ∈ {local, subscription, metered}; **a metered engine is
  never auto-selected** (`#readyInOrder` filters `isMetered` out) — "only the person's
  explicit pick spends their credits". Rate-limit fallback → local engine (the only one
  that can't be rate-limited), context-overflow/auth fall back to nothing.
- **Wall clocks & timeouts**: default run wall clock 24h (`DEFAULT_WALL_CLOCK_MS`), max
  24h commission; delegated turns floored at 1 min; git ops bounded (`GIT_TIMEOUT_MS`).
- **Evals cost reporting**: `evals/prices.json` (dated USD/million-tokens, 2026-10-03);
  unknown prices reported as unavailable, never guessed.
- Engine preferred order: **local first, then subscriptions** (VERIFIED —
  `docs/agent/architecture.md`).

### 3.7 Adaptability notes for GameForge (INFERRED unless noted)

- The planner/builder/judge role model, the five mode designs, facet build⟳verify loops,
  typed checks, blind-judge gates, StopCodes — the harness seed is **Node TS with no
  Electron imports** and talks to the host only through the `HostMethod` RPC vocabulary
  (VERIFIED: `src/shared/harness-api.ts` types it), so a **server host could implement the
  same RPC surface** behind a different transport.
- pi-ai completions path is already HTTP and could run in a Node backend (OpenRouter;
  Ollama needs local access).
- **Key gap to note honestly:** GameForge would lose Genex's biggest economic moat — the
  *delegated subscription* model ("your Claude/ChatGPT subscription, their harness") that
  makes long unattended runs cost the studio nothing. On web, every token is the
  operator's bill; the metered-engine protections become the *primary* cost design instead
  of an edge case.
- GameForge's Groq-API design is the opposite of Genex's subscription-delegation model:
  instead of borrowing user subscriptions, GameForge pays per-token. The Genex patterns
  that transfer: role-separated model selection, per-completion usage accounting, metered
  engines never auto-picked, local-first fallback ordering, budget caps + wall clocks.

---

## 4. Worker coordination

(VERIFIED — `src/harness-seed/loop/director/workers.ts`, `budgets.ts`, `outcomes.ts`,
`src/substrate/engines/registry.ts`; `docs/agent/architecture.md`.)

- **`MAX_WORKERS = 12`** (`director/budgets.ts:36` — "twelve windows is already a machine
  on its knees"); `workers.ts` refuses `worker_start` past it. Effective count also
  limited by the preview-window pool (`workerWindows(cap.max)`, `foundation.ts:33`). The
  app UI default is 4, user-settable up to 12.
- `WorkerState`: `running/done/stopped/failed` (`outcomes.ts:86-97`); `WorkerMode`:
  `loop` (judged facet loop on a board) or `single` (one session).
- Each worker: its own **git worktree** + leased **preview window** + contract gate
  (`workers.ts` header); wins merged via `integrate`; merge conflicts go to a worker of
  their own (`director.ts` header).
- **Stop semantics are typed** — `StopCode`, 24 codes (`outcomes.ts:32-81`), e.g.
  `budget`, `yielded` (fair share), `circuit-break`, `usage-limit`, `engine-exhausted`,
  `observation-down`, `judge-down`, `sign-in`. Code-decided, never phrase-matched.
- **Provider failure ladder** (`registry.ts:120-138`): `fallbackFor()` answers what could
  take over after a failure; harness policy decides. Rate-limit → local only.
- A monitor (`director/workers.ts`) reads each running worktree (`git status --porcelain`,
  `git diff -U0`, the mechanical reviewer; no model, window or index lock) and notes only
  a change; `waitDigest` gives each worker its reviewers' ideas and the room left.
- Defects a judge names for another worker's seam route to that worker's live spec
  (`makeRouteDefect`); a finished owner's defects go to `defectsNobodyOwns`; never to
  itself.
- Direct-local engines: workers run **sequentially**; delegated/cloud: parallel.
- Parallel worker coordination primitive is **git worktrees + integration branch refs**
  (`refs/studio/runs/<runId>/integration`, `.../workers/<facetId>`), not locks — merge is
  explicit via `integrate`.

---

## 5. Visual verification mechanisms

### 5.1 How the agent "sees" the game

(VERIFIED — `src/harness-seed/loop/evidence.ts`, `loop/host-methods.ts:72-96`,
`loop/facet/prompt.ts:755`, `loop/judge.ts` + `judge/*.md`, `src/main/preview.ts`,
`src/main/preview-input-driver.ts`, `src/main/preview-images.ts`,
`src/preview-profiler/observer.ts`; `src/game-template/docs/CONTRACT.md`.)

The foundation is the **studio-instrumentation contract**: the studio serves the game
itself over a custom `game://` scheme and **injects a shim before any game code runs**
(`src/main/page-serve.ts` — `rewriteGameHtml` injects a classic script
`vendor/studio/shim.js` which owns `performance.now`, `Date.now`,
`requestAnimationFrame`, seeds `Math.random`, plus a module `hook-entry.js`; the `three`
/`three/webgpu` import-map keys are rewritten through its own hook so it can find the
renderer). Games install `window.__studio` (`src/game-template/src/studio.js`): `seed(n)`,
`start/pause/begin`, `step(dtMs)` (scripted stepping), `state()` (JSON snapshot),
`inspect()` (read-only scene-graph queries: `meshes(tag)`, `bbox`, `lights`…),
`capture()` (data-URL screenshot), `demo(name)`, `demos()`, `debugCamera(name)`,
probes; everything tag-addressed via `userData.tag`. Deterministic, seeded, inspectable
by construction.

- Evidence passes run through **host RPC to a pooled preview-window system**
  (`loop/host-methods.ts`): `preview.acquire/release`, `preview.load/reload`,
  `preview.screenshot` (per-camera), `preview.input` (play-script actions),
  `preview.evaluate` (JS in page), `preview.state` (reads `window.__studio.state()`),
  `preview.crop`, `preview.diff`, `preview.console`, `preview.gpuErrors`, `preview.statsOf`.
- A pass (`evidence.ts:747`): **deterministic playthrough** (`PAGE_SEED=1234`,
  `config.ts`) + screenshots at every named camera + structural probes + console/GPU
  error capture. "Every mode uses this one number" (seed).
- **The agent's own eyes** (host tools bridged to agents): the `computer` tool (drives
  the build live in its own window — screenshot/zoom/keyboard/click) and `capture`
  (takes every registered camera at once). Prompts mandate them: *"Look after every
  meaningful change… do not finish without at least one frame that shows your change
  working from the primary camera"* (`loop/facet/prompt.ts:755`).
- **Input driving**: `preview-input-driver.ts` + `substrate/preview-input.ts` inject
  key/look/wheel/pointer actions (capped) — scripted playthroughs.
- **Profiler**: `preview-profiler/observer.ts` — studio-owned observer through
  `inspect()`; world-call counters from `renderer.info.render` read immediately after the
  world render (excludes HUD/postprocessing).
- **Evidence capture pipeline**: `screenshot()` = compositor/page capture → JPEG;
  `screenshotWithStats()` returns one JPEG used by both the vision model and luminance
  arithmetic (luma mean/stddev, near-black fraction); `preview-images.ts` has
  `resizeToJpeg`, `diffImageFiles`, `pairJpeg`, `cropImageFile` — diff-based change
  detection.
- Evidence produces `RunSummary` with captures/shots under run folders
  (`src/main/run-evidence.ts` reads `verdict.json`, `playtest.json`, shot paths).

### 5.2 Judges (independent visual/semantic review)

(VERIFIED — `src/harness-seed/loop/judge.ts` + `judge/*.md` — 14 judge prompts.)

- `vision-check.md` — one yes/no question about ONE picture, fresh-context, JSON answer.
- `blind-compare.md` — A/B vs reference on four facets (works/visuals/feel/play), never
  scores.
- `taste-veto.md`, `taste-finish.md`, `playtester.md`, `ship-review.md`,
  `code-review.md`, `readability.md`, `artefact-classes.md`, `liveness.md`,
  `optimization-preserve.md`, `facet-compare.md`, `reference-panel.md`, `vision-batch.md`.
- **Every verdict is a one-shot session with no history.** Claude verdicts run in one
  stable directory (`JUDGE_CWD` in `claude-code.ts`) so the unchanging prompt prefix can
  be cached; the frozen rubric leads the user message and pictures come last.
- Judges run at `LIGHT_EFFORT = "low"` regardless of run effort.
- Failure classification: `ObservationDown` (blind camera, display asleep — retried, not
  charged to the build) vs build-broken, via `classifyEvidenceFailure`
  (`evidence.ts:302-354`).

### 5.3 Portability (INFERRED)

This is fundamentally a **headless-Chromium-with-injection** architecture; the Electron
`WebContentsView` is just their Chromium. On a server, the same page-server + shim +
`window.__studio` contract runs under headless Chromium via CDP: screenshots, input
injection, console capture, renderer-info counters all have CDP equivalents. The vision
review step maps to any image-capable model call (Genex uses the judge engine's vision;
GameForge would use Groq vision-capable models where available, with clear
"unverified" labelling when unavailable).

---

## 6. Build lifecycle

(VERIFIED — `src/main/game-build.ts` (~484 lines, class `GameBuilds`),
`scripts/build.mjs` header, `src/game-template/docs/CONTRACT.md`,
`src/shared/genex.ts` `GENEX_GAME_PACKAGES`, `docs/agent/architecture.md`.)

Game projects (NOT the app itself) — template games need no build at all:

- Template games run as **ES modules served by the studio's file server**; "the game
  workspaces need no bundler at all (import maps + vendored three)" — three.js is vendored
  with the studio ("games build and run with no network at all"). **No build step** for
  template games (VERIFIED — `scripts/build.mjs` header).
- Externally-authored projects may declare their own build: `studio.json` records `main`
  (entry module), `build` (shell command run *before every preview*), `entry` (the page
  served), `bootMs` (default 15s wait for readiness).
- A user's game is **never built in place**: built in a **shadow mirror** under the app's
  scratch (tracked git files + modified/untracked-but-not-ignored + `.env`; a worktree is
  built where it stands). The mirror never includes `dist/`, `node_modules/`, `.git`,
  `.studio`. Builds on mirrored copies under `scratch/builds/<project>-<hash>/`,
  **memoised on a tree key** (change-keyed memoization; per-source `#inFlight` map
  coalesces concurrent builds).
- **Last-good output is kept**: a failed build does NOT blank the live stage — but judges
  never see stale output (`servedAfterBuild(outcome, {fallback})`: live stage may fall back
  to `lastGood`, judged loads may not).
- Build command from the project's shape (`studio.json` `build`); timeouts: 5 min build,
  10 min install. Package installs only on an explicit user button or approved Genex
  package (registry limited to `registry.npmjs.org`); agents may add only
  `@genex-ai/multiplayer` (0.16.1) and `@genex-ai/embed-sdk` (0.30.0) at pinned versions.
- The **app itself** builds with **esbuild only** ("one tool, no plugin-compatibility
  surface") into `dist/main/main.mjs`, `dist/preload/`, `dist/renderer/`,
  `dist/resources/` — resources include vendored three.js, the game template, and a
  bundled TypeScript 7 compiler "the in-app type gate runs".

For GameForge (INFERRED): the "shadow-mirror + change-keyed memoization + last-good
fallback + judged-loads-never-stale" build model maps directly to server-side ephemeral
build dirs. GameForge's Vite-based games add a real build phase Genex skips; the
change-keyed memoization and last-known-good retention are worth copying.

---

## 7. Project persistence

(VERIFIED — `docs/product/workspace.md`, `docs/agent/architecture.md`
"Core services", `src/renderer/state/` conventions, AGENTS.md.)

- Games are **real local folders** in `~/AI Games` (user-settable games root); library
  indexed by `GameWorkspaces` (versioned, canonical-folder keyed). The game is a real
  local project that can be opened, edited and exported — not a database record.
- Conversation state: **append-only `EventStore` per conversation**; chat pagination
  (`studio:chat.page` returns newest 160 events + `before` cursors); renderer dedupes by
  event identity; global event tail capped at 4,000.
- Renderer state is **not** persistence: Zustand domain stores
  (`src/renderer/state/`) are view state only; pure exported actions, selector-only
  reads, `localStorage` keys centralized in `renderer/storage.ts`. Secrets never reach
  renderer or event log (redaction-on-append).
- Asset inventory: host-owned ledger (`asset inventory ledger` in core services).
- Settings persist across app changes; "Accounts, local projects and installed harness
  edits must survive application changes" (VERIFIED — `docs/agent/context.md`).
- Game template ships its own `CLAUDE.md`/`NOTES.md` contract files; adopting an outside
  folder seeds them.

GameForge difference (INFERRED): Genex persistence is files-on-user-disk + git refs; a
web GameForge needs server-side project storage (filesystem + DB metadata, e.g. Postgres
for projects/runs/builds and git repos per project on disk), since localStorage must not
be authoritative.

---

## 8. Versioning and rollback

(VERIFIED — `src/substrate/snapshots.ts`, `src/main/chat-checkpoints.ts`,
`src/main/asset-checkpoints.ts`, `src/shared/chat-rewind.ts`,
`docs/agent/architecture.md` "Snapshots and health" + run-versioning refs,
`docs/conversation-coordinator.md`.)

**Git is the whole mechanism.** No database-based revisioning:

- **`substrate/snapshots.ts`**: "Snapshot engine (git instead of Docker commit/save/load)."
  Snapshot = **git commit + tag** recorded in the event log; restore = checkout.
  "instant, diffable … and kilobytes". A snapshot becomes `healthy` only after the
  harness completes a full turn past it, so rewinds land on a version that actually ran.
  Workspaces are dependency-free (bundled esbuild + vendored three), so restore is a pure
  checkout.
- **Run versioning**: everything a run must find later lives on studio Git refs —
  `refs/studio/runs/<runId>/integration`, `.../workers/<facetId>`,
  `.../attempts/<facet>/<n>` (`-stopped` for stopped rounds), `.../spikes/...`,
  `refs/studio/snap/<id>`. One committer signs studio commits.
- **Chat checkpoints** (`chat-checkpoints.ts`): the game folder as it was just before
  *and* just after each chat message — a commit on studio-owned ref
  `refs/studio/chat/<thread>/before|after/<message>` whose parent is the HEAD taken on.
  Taking one never moves HEAD/branches or touches the user's index (private index file,
  hooks off); restore writes the working tree only. Never captures `.env`,
  `node_modules`, `dist`, `.studio`, `output` (`NEVER_CAPTURED`). Refused when the folder
  changed through a commit/landed build since (HistoryChanged), when history/branches
  changed, or files exceed limits (50 MiB/file, 1 GiB/change batch; keeps 100
  checkpoints/chat, 10 rewound).
- **Asset checkpoints** (`asset-checkpoints.ts`): commits of host-delivered asset files so
  asset deliveries are individually revertible; records what was left out.
- **Chat rewind** (`shared/chat-rewind.ts`): rewind is a *projection* over the event log
  — rows stay on disk; withdrawn turns get a marker; builds observed and rewinds
  themselves are never withdrawn.
- **Harness snapshots**: snapshots are "healthy" only by having booted; the wedge
  watchdog rewinds to the newest healthy harness snapshot on crash (three exits/5 min or
  10 silent min); seed upgrades snapshot around migrations; rollback refuses during a
  run/contractor/user turn.
- **Landing**: close lands the integration head into the game folder only if it moved and
  loaded/judge-passed; landing blocked by user commits → waits for "Make it live"
  (`landBuild`); refused with typed codes (`uncommitted-changes`, `could-not-land`).

For GameForge (INFERRED): git-commit/tag/restore ports extremely well to a server-backed
web studio (server holds a git repo per project; namespaced refs for checkpoints/runs).
The model itself — immutable content-addressed checkpoints, keep-100-per-thread, never
capture secrets/build output — is the transferable part.

---

## 9. Asset management

(VERIFIED — `src/shared/game-assets.ts`, `src/main/game-assets.ts` (~903 lines),
`src/main/asset-workspaces.ts`, `asset-preview.ts`, `asset-checkpoints.ts`;
`src/game-template/src/assets.js`; `docs/product/assets-plugins.md`;
`src/game-template/docs/CONTRACT.md` "Assets".)

- **Format table** (`ASSET_FORMATS` in `shared/game-assets.ts`): one row per lowercase
  extension — kind (image/model/audio/video/other), viewer, MIME, thumbnail reader.
  Models: glb/gltf/obj/fbx/stl/ply. Images: png/jpg/webp/gif/avif/svg/bmp +
  hdr/exr/ktx2 ("shown on a plane by the model viewer"). Audio:
  mp3/wav/ogg/opus/m4a/aac/flac. Video: mp4/webm/mov/ogv. Unknown → `other`.
- **Provenance model** (`ProjectAsset`): `file` (posix-relative to game root — the
  renderer never gets absolute paths), `kind`, `bytes`, `source` (`genex` | `blender` |
  `imported` | plugin id), `jobId`, `generationId`, `prompt`, `availability` (deliveries
  per workspace with scope project/integration/worker + revision), `use` (stage:
  **unconfirmed/integrated/verified** — evidence an asset is *loaded by the running
  game*), plus `render`/`renderFront` PNG paths of Blender renders readable through
  `readRunStill`.
- **Delivery is host-owned**: after `assets.deliver` returns (or Blender writes a
  model), the *host* writes the delivery record — "a plugin can neither forge nor skip
  it" (VERIFIED — `shared/game-assets.ts` header).
- Delivered assets get **git checkpoints** (`asset-checkpoints.ts`) so deliveries are
  individually revertible.
- **Asset preview**: `asset-preview.ts` + `src/shared/asset-preview.ts` —
  viewers/thumbnails per format (serialized decoder queue, WebGL contexts disposed).
- **Blender flow**: `assets/<name>.glb` committed with the game +
  `assets/src/<name>.py` source script; `loadAsset("dog", {tag, scale, position})`,
  `preloadAssets([...])`, `assetUrl()`.
- Genex paid asset generation (via genex plugin): models, images, textures, video, sfx,
  music, voice, character rigging; 1024-char model prompt limit.

For GameForge (INFERRED): the extension→kind table, host-issued delivery records,
provenance metadata, and the unconfirmed/integrated/verified usage ladder all port
cleanly. Blender needs a server runtime (Genex declares API-3 `nativeRuntimes`).

---

## 10. Plugin architecture

(VERIFIED — `src/plugin-sdk/index.d.ts` (468 lines), `panel.js`/`ui.js`,
`backend.mjs`; `docs/PLUGIN_GUIDE.md`, `docs/plugins.md`; `src/plugins/{blender,
example, genex}/`; `docs/STUDIO-MARKETPLACE-RELEASE.md`; `marketplace/`.)

### SDK surface

Self-contained typed contract (`Activate = (host) => PluginActivation`). A plugin = a
**prebuilt directory**: `plugin.json` (manifest), backend ES module, optional isolated
HTML panel(s). **No npm install, no build hook, no archive extraction** — Studio
installs files as-is.

- **Manifest**: `apiVersion` (1|2|3, additive compatibility), id/version/name/publisher/
  description, `capabilities`, `tools` (agent tools, named `<plugin>__<tool>`), `actions`
  (user-invoked, with optional `review()` evidence), `panels` (placement: `settings` |
  `project`, sandboxed iframe with opaque origin, `window.studioPlugin` bridge only),
  `settings` (typed), `toolbar` (≤4 stage-strip buttons), `skills` (inline ≤32, or file
  skills), `mcpServers` (≤4, stdio node or reserved host-cli), `account`
  (connect/unlock/disconnect/status/cancel — host-managed auth flow), `icon`, `network`
  (declared hosts), `nativeRuntimes`/`nativeJobs` (API 3 — e.g. Blender: runtime
  candidates, version checks, install recipes, jobs with timeouts/output/asset byte
  caps, GPU permission), `assetLimits`.
- **Capabilities**: `settings`, `project.read`, `project.write`, `credentials`,
  `external-auth`, `observe`, `jobs`, `network`, `export`, `native-runtime`
  (`export` = `export.stage`; `observe` = inspect + optional `still` photo of a
  demo/camera on a hidden window).
- **Host services** the backend may call (`PluginHostCall`, gated by capabilities,
  answered only during an active invocation): `runtime.detect/install`, `native.run`,
  `settings.read`, `storage.root`, `project.read/write`, `assets.deliver`,
  `export.stage`, `jobs.read/write`, `events.emit`, `observe` (+`still`),
  `credentials.session/read/write/clear`.
- **Trust model**: backends are **trusted native code in a crash-isolated child process,
  not an OS sandbox** (VERIFIED — `PLUGIN_GUIDE.md`). Activation must be
  side-effect-free. Install-time static scan (`scanPackage`) is disclosure, not
  isolation (verdicts `safe`/`caution`/`dangerous`).
- **Tools vs actions**: `tool` = agent-invoked; `action` = user-invoked from
  panel/dialog/toolbar, never an agent tool; optional `review()` returns host-rendered
  evidence before a confirmed action. Confirmed tools carry a `confirmation` string
  (consent dialog). **Agents can never install/enable plugins.**
- Panels: framework-free `ui.js` helpers (`text`, `status`, `error`, `job`).

### Bundled plugins (the two working examples)

- **blender** (API 3, v1.1.1): `native-runtime` capability — runs a `bpy` script from
  `assets/src` in local headless Blender; exports GLB + two renders; tools: `status`,
  `model`, `retrieve`; setup actions incl. install with sha256/bytes verification.
- **genex** (API 3, v1.6.0, bundled + enabled by default): capabilities `credentials
  observe jobs network external-auth project.write export`; tools `asset` (paid
  generation), `publish`/`publish-status`, `genex__cli`/`genex__cli-paid` as **host
  tools** (Studio runs its own pinned CLI instead of plugin code — reserved for this
  plugin only). MCP connector + 10 skills (incl. `genex-tool-publish`, `genex-cover`,
  `genex-threejs-multiplayer`).
- **example** (API 2): plain tool, confirmed tool, two actions, a settings panel, one
  toolbar button — the reference implementation; also the `plugin:new` scaffold source.

### Distribution

- **Local install**: Plugins → Add → Load local plugin → copied into host-owned storage
  after a trust dialog (publisher + capabilities). Dotfiles/authoring files never packed.
- **Catalog**: curated `catalog.json` with exact manifests, HTTPS artifact URLs, SHA-256
  digests, served at `https://plugins.genex.games/catalog/v1/index.json` (empty scaffold
  in repo; actual releases via `npm run catalog:prepare` + validator + PR CI).
- **Install from GitHub**: resolves to one exact commit, verifies per-file blob SHAs
  (caps: 400 files / 8 MiB per file / 64 MiB total); updates never automatic; expanded
  capabilities re-ask; official `genex`/`blender` ids reserved as official tier.
- CLI scripts: `plugin:new` (scaffold), `plugin:pack` (content-addressed envelope +
  digest), `plugin:doctor` (install-probe validation), `plugin:submit`, `plugin:unpack`.
- App-enforced policy (`STUDIO_CATALOG_POLICY`): official ids/origins pinned in-app; a
  catalog entry the app doesn't allow is dropped.

For GameForge (INFERRED): the "prebuilt directory + manifest + isolated panel iframe +
host-service bridge" model ports to the browser nearly 1:1; the native-runtime and
child-process bits need server execution. **Genex explicitly does NOT claim OS sandboxing
for arbitrary backends** ("trusted native code") — a browser studio should sandbox
third-party extensions in iframes/web workers with declared capabilities instead.

---

## 11. Learning and skill refinement

(VERIFIED — `src/harness-seed/loop/skillopt.ts`, `loop/library.ts`, `run-dispatch.ts`,
`loop/learning.ts`, `src/main/core/self-edit-gate.ts`, `src/main/self-changes.ts`,
`src/substrate/type-gate.ts`; `docs/agent/harness-runtime.md`,
`docs/product/studio-learning.md`, `docs/evals.md`, `evals/README.md`.)

- **SkillOpt** (`loop/skillopt.ts`): *"the outer loop that improves the studio's skills
  between runs"* — ported from **microsoft/SkillOpt** (VERIFIED third-party, MIT):
  bounded string-anchored edits (≤4 per analyst call), failure-priority merge + ranking
  by systematic impact, **gate: kept only on strict improvement against a held-out set;
  rejected edits go into a step buffer** so dead ideas don't return; `best_skill.md` per
  skill + accepted history. Adapted: cheap **replayable sub-tasks mined from run
  transcripts** instead of full validation runs; gate is pairwise and blind
  (tie ⇒ reject).
- **Triggered after every finished run** (`run-dispatch.ts:336-369`, `learnFromRun`) —
  the pass runs **on the engine that ran the run** ("the model that made the mistakes is
  the one that studies them"), gated by the user's **Self-improvement switch**
  (`learningOn`) — off = Studio learns nothing (records remain, so turning it back on
  learns from everything since).
- **Recipe library** (`loop/library.ts`): *"What replaces SkillOpt for builders"* — one
  technique per class of hard problem, mined from passing spikes (code + check +
  evidence); `library/recipes/*.json` hold the shipped recipes (e.g.
  `characters.silhouettes-differ`, `fps.hands-in-frame`); `library/checks.json`;
  `library/contract-lessons.md` that SkillOpt distils into future briefs.
- **Self-edit gate** (`guardian.validate_edit`, VERIFIED `host-methods.ts:99`): an
  agent's edit to its *own harness code* (`guardian.write_self`) is tried in a
  **validation fork** (git worktree), type-checked by the **vendored TypeScript 7 native
  compiler** (`resources/tsc/` per `substrate/type-gate.ts`; AGENTS.md cites
  `dist/resources/tsc`), must then **boot and answer its healthcheck** (+ loop self-test
  for architect jobs) — fails closed, no silent accepts
  (`main/core/self-edit-gate.ts`). Frozen top folder `judge` can never be written.
- **Learned changes are listed and undoable by the host**
  (`main/self-changes.ts`): SkillOpt's staged records, the architect's, and the agent's
  own. Each records `post_snapshot_id`; **Undo this change** reverses its diff alone.
  Studio chat surfaces instruction proposals with plain titles/diffs; "Apply suggestions
  automatically" is off by default.
- **Offline evals** (`docs/evals.md`, `evals/`): frozen public `cases.md`, per-lane
  `baselines/<case>.json`, cost `prices.json`, `lanes.json` (lane registry incl. model
  lanes), ledger snapshots `ledger/export-<appSha>.jsonl`; run artifacts stay in
  `$GENEX_EVALS_HOME`, never committed. Version reference is the app commit — every
  later `appSha` compared on the version axis. Eval isolation: `check-isolation.ts`
  (eval case words must not leak into what agents/graders read).
- Run ledgers feed learning: `library/games/<game>.jsonl` → lessons → next run's brief.

For GameForge (INFERRED): SkillOpt's held-out-gate loop, the recipe library, and the
validation-fork self-edit gate are portable to a server (Postgres instead of files;
worktrees as branches/containers). The "learns on the engine that ran the run" and
"auto-apply off by default" policies are worth copying.

---

## 12. Security boundaries

(VERIFIED — `docs/agent/architecture.md` "Processes and trust boundaries" + "Residual
risks"; `src/main/index.ts:8-13`; `src/substrate/spawn.ts`; `src/shared/ipc-channels.ts`;
`src/main/dev/native-policy.ts`; `src/substrate/secrets.ts`; `SECURITY.md`; `PRIVACY.md`.)

**Processes & trust zones** — stated explicitly at the top of `src/main/index.ts:8-13`:
*"Main owns everything privileged: the event store, git snapshots, the sandbox, the
engines, the preview's `webContents`, and the keep-awake blocker. The renderer is a view;
the harness is a contained child process. Neither can reach past main."*

| Zone | Trusted? | What it is |
|---|---|---|
| Electron main + substrate | Trusted | All privileges: event store, git snapshots, ProcessSandbox, AI engines, provider credentials, filesystem |
| Renderer | **Untrusted** | "The renderer is a browser: no Node, Electron, main, preload or substrate imports" (AGENTS.md). Main window: `sandbox: true, contextIsolation: true, nodeIntegration: false` (`main/index.ts:702-708`). Talks only via fixed named calls in `src/shared/studio-api.ts` (177 methods). |
| Harness child | **Untrusted, agent-controlled** | Agent can rewrite its own tools; containment via Seatbelt/seccomp profile inherited by children. Host contact only via typed `HarnessHostApi` (`src/shared/harness-api.ts:202`); path params realpath-validated (`substrate/paths.ts` `containedReal`). |
| Contractor CLIs (Claude Code/Codex) | Vendor harnesses, briefed | **Codex can read the whole disk** — documented residual risk. |
| Game pages | **Untrusted web content in closed partition** | `WebContentsView`, own session partition, no preload, no IPC bridge; one-way main→page control via `webContents` APIs (`main/preview.ts` header). |
| Plugin backends, MCP servers | Trusted native code the user approved | **Crash isolation, not a sandbox** — explicitly. |
| Terminal hosts | One Electron utility process per node-pty session, as the user. | — |

**ProcessSandbox** (`src/substrate/spawn.ts`, ~1006 lines) — the single spawn gate:
*"Every agent-originated process goes through here."*
- Backends: macOS Seatbelt via `@anthropic-ai/sandbox-runtime`; Linux same package with
  `apply-seccomp` helper; Windows `srt-win` under Git Bash.
- Policy: `allowedDomains` (default empty = **no outbound network**), `allowLocalBinding`,
  `allowWrite`, `allowRead`, `denyRead`, `denyWrite`. Writable: harness workspace + games
  root only + per-agent scratch (also `TMPDIR`). **Never readable** (`denyRead`):
  safeStorage blob dir + engine credential homes + `baseDenyRead()`: `~/.ssh`,
  `~/Library/Keychains`, `~/.aws`, `~/.config/gh`, `~/.netrc`, Linux keyrings/GnuPG/
  KWallet/`~/.pki`, coding-CLI sign-in homes (`~/.codex`, `~/.claude`, …).
  Deny-write on top: credential homes, frozen judge rubrics, game's `.claude` folders
  (agents can't plant Claude Code settings/hooks).
- Per-run overlays can only **add** denies — never weaken them.
- **Environment allow-listing**: child env reduced to toolchain basics (`childEnv`,
  `base: "sandbox"`) — app credentials never leak down; credential-shaped names stripped
  for contractors.
- Kill: own process group + SIGKILL of the tree on POSIX; srt-win job object on Windows.
- Documented residual risk: network domain openings are process-wide; the only caller is
  the user-pressed "Install packages" against `registry.npmjs.org`.

**IPC security model**:
- Typed channel registry (`src/shared/ipc-channels.ts`); registration via
  `createIpcHandle` (`main/ipc-handle.ts`) enforces: (1) `STUDIO_UI_ONLY` prefix guard
  (`studio:plugins.`, `studio:mcp.`, `studio:terminal.`, `studio:permissions.` — only
  Studio's own main frame, never a plugin/game frame); (2) fixture policy
  (`assertNativeActionAllowed`).
- Every IPC channel classified **fixture-safe** or **native**
  (`src/main/dev/native-policy.ts`): ~40 NATIVE_CHANNELS (accounts/dialogs/downloads/
  external apps/network), ~110 FIXTURE_SAFE (read-mostly, profile-local, each with an
  inline safety justification); a compile-time `Unclassified` trick + runtime refusal
  means an unclassified channel is never allowed by default.

**Secret storage** (`src/substrate/secrets.ts`):
- Encrypted at rest via Electron `safeStorage` (Keychain-backed on macOS), under
  `userData/secrets/` (on the sandbox deny-read list — no agent process can read it even
  after the agent rewrites its own tools). Refuses to store without real encryption
  (Linux without keyring locks the store). Only the OpenRouter API key and MCP secrets
  are actually stored; subscriptions never produce a held token.
- "Provider tokens never reach the renderer or the event log" (PRIVACY.md);
  redaction-on-append to the event log; export/publication scans refuse files containing
  known credential values.

**Game isolation** (`src/main/preview.ts`): separate renderer (`sandbox: true,
contextIsolation: true, nodeIntegration: false, webSecurity: true`, no preload);
separate session partition (`game-preview`, facets `game-preview-facet-N`); separate
scheme (`game://`, privileged); **offline by default** (`webRequest.onBeforeRequest`
cancels everything except the studio's `game:` server, `data:`/`blob:`, loopback port,
and allowlisted font/library CDN HTTPS reads); navigation lockdown
(`will-navigate`/`setWindowOpenHandler(() => deny)` — "a remote page inside the studio's
chrome, which has no URL bar, is a fake sign-in form nobody can tell from the studio's
own"); permission handlers deny everything except `pointerLock` (+fullscreen); WebRTC
non-proxied UDP disabled.

**Documented residual risks** (`docs/agent/architecture.md#residual-risks`,
`docs/tool-permissions.md#residual-risks`): Codex can read the whole disk; plugin
installs/Genex CLI runs briefly widen sandbox network process-wide; a `Run` offered by a
reply executes outside the sandbox (user's reading is the last check); Codex permissions
advisory only; asset adapter runs the pinned CLI with the user's real `HOME`
(follow-up planned).

**SECURITY.md scope**: sandbox escapes, credential exposure, plugin/MCP trust, renderer+
preview isolation, path/git safety are in scope; report to `team@genex.games`; no bug
bounty; only latest dev/main supported.

For GameForge (INFERRED): no login + arbitrary code execution means an infrastructure
access boundary is mandatory (matches master prompt §25). Server-side equivalents:
OS keychain → encrypted vault (never to browser); Seatbelt → container/VM sandboxing
(Docker/gVisor/Firecracker); game partition → sandboxed iframe (opaque origin) + CSP +
server-side headless capture; IPC classification → typed API contract with
capability-scoped routes. The typed-StopCode / typed-channel philosophy ("never decide
behavior by matching English text" — AGENTS.md) transfers directly.

---

## 13. Export and publishing mechanisms

(VERIFIED — `src/plugins/genex/` (`publish.ts` 322 lines, `deployment.ts`, `cover.ts`
637 lines, `plugin.json` v1.6.0), `src/main/core/genex-cli.ts` (281 lines),
`src/main/studio-core.ts:1647-1660`, `docs/plugins.md`, `docs/connections-and-context.md`,
`PRIVACY.md#publication`, `src/plugin-sdk/index.d.ts` `PluginExportResult`.)

- **Export**: `export.stage` host service → `exportPublicCopy(project, targetDir)` —
  builds the game first (if its shape builds), then stages it via "the same audited
  exporter the Export button uses". The plugin gets Studio's public copy:
  `{dir, files, included, excluded, genex: {dependencies, settings}}`. Genex SDK
  settings come from the game's own `package.json` `genex` field, stripped from the copy.
  Excludes hidden files, env files, private-key names, dependencies, symlinks; prunes
  vendor via parsed imports/references; **secret scan**: public export refuses any file
  containing a known secret value, naming the file, never the value.
- **Publish phases** (`publish.ts` `publishArgs`): `genex preview --no-build` (upload
  draft), `genex promote` (make public), `genex publish --no-push` (gallery listing).
  Kinds: `draft` (unlisted draft only) vs `gallery` (updates draft page, tests it,
  promotes it to public version; lists in gallery first time). Studio exports the game
  itself and asks the user before either runs. Publishing requires git + git-lfs on the
  machine. Retry: at most 2 uploads.
- **Genex cover** ("one real 16:9 frame genex.games shows for a game — its gallery card,
  its page, every shared link"; distinct from Studio's own sidebar cover): the frame is
  the game's own demo named **`genex-cover`** in `config.demos`, photographed by the host
  through `observe` with a `still` into plugin storage (`covers/<project>/`), then sent
  via the pinned CLI's `genex cover <file> --json` after a publish is recorded.
  1920×1080 ≤ 8 MiB; Genex stores it at 1280×720; Studio mirrors Genex's luma gate
  (MinMean 0.12, MaxNearBlack 0.85) only as advisory — "Genex decides everything that
  matters"; never lets a cover wedge a publish.
- **`@genex-ai/cli-demo` 1.36.2**: the **pinned Genex CLI**, vendored into app resources.
  It's how Studio talks to `api.genex.games` (publishing, covers, project creation).
  Security model: each CLI call runs in a fresh folder under `<userData>/genex-cli`
  (outside agents' writable roots), HOME redirected there; the credential is piped on
  stdin, never argv/env/disk; network sandbox allows only the Genex API origin; run
  folder deleted after. Exposed to agents as host tools `genex__cli`/`genex__cli-paid`
  (a "paid" variant gates credit-spending commands).
- Genex plugin also ships: an `asset` tool (paid Genex asset generation — models, images,
  textures, video, sfx, music, voice, character rigging; 1024-char model prompt limit),
  MCP creator servers, and 10 skills (incl. `genex-tool-publish`, `genex-cover`,
  `genex-threejs-multiplayer`).
- `genex__package` adds `@genex-ai/multiplayer` (0.16.1) or `@genex-ai/embed-sdk`
  (0.30.0) at exact pins after consent; multiplayer tested only on the published draft
  (Studio preview stays single-player).

For GameForge (INFERRED): export needs a server-side exporter with secret scanning;
the cover pipeline is directly portable (run the game's `genex-cover` demo headless,
capture a still, use as listing image); Genex's hosted publishing backend itself is
proprietary and cannot be reused.

---

## 14. Electron-specific dependencies

### 14.1 App code APIs actually used (all VERIFIED in `src/`; harness-seed and
game-template payloads excluded)

| Electron API | Role in this app | Representative file | Web/server equivalent |
|---|---|---|---|
| `BrowserWindow` | Main studio window (sandboxed renderer + preload); offscreen facet-observation windows with own session partition (`game-preview-facet-N`); short-lived cover renderer | `main/index.ts:720,821`, `main/game-cover-renderer.ts:22` | Browser tab/popup (`window.open`); server side: none |
| `WebContentsView` | Game preview surface embedded in the studio window; fullscreen exit view | `main/preview.ts:344`, `main/full-screen-view.ts:30` | Sandboxed `<iframe sandbox="allow-scripts">` |
| `ipcMain` / `ipcRenderer` / `contextBridge` | Typed IPC backbone (main↔renderer) | `main/ipc-handle.ts`, `preload/index.ts` | `postMessage` + REST/WebSocket typed API |
| `app` | Lifecycle (`whenReady`, `quit`), paths (`getPath("userData")`), version, single-instance lock, name | `main/index.ts` | Server process lifecycle |
| `Menu` / `MenuItem` | Native application menu incl. "Check for Updates" | `main/index.ts:1225-1232` | Custom HTML menus |
| `Notification` | OS notifications via `studio:notify` | `main/index.ts:1148,1249` | Web Notifications API |
| `autoUpdater` | `quitAndInstall` into downloaded release; hourly check | `main/index.ts:402`, `main/auto-update.ts:150` | PWA service-worker update flow |
| `crashReporter` | Started with `uploadToServer: false` (local only) | `main/index.ts:329` | Sentry-style JS error reporting |
| `dialog` | Native folder pickers (project/games-root), message boxes, error boxes | `main/index.ts`, `main/ipc/projects.ts`, `main/plugin-install-dialog.ts` | File System Access API pickers; custom modals |
| `shell` | `openExternal` (URLs in real browser), `showItemInFolder`, `openPath`, `trashItem` | `main/ipc/games.ts`, `main/ipc/plugins.ts` | `window.open(..., "_blank")`; no "reveal in folder" — show path text |
| `nativeImage` | Screenshot capture/processing pipeline | `main/preview-images.ts`, `main/preview.ts` | Canvas `toDataURL`/`toBlob` |
| `nativeTheme` | Window background matches OS dark mode | `main/index.ts:695` | `matchMedia("(prefers-color-scheme: dark)")` |
| `net` (Electron) | `net.fetch` for release checks and CLI installer downloads (Chromium network stack) | `main/index.ts:422`, `main/preview.ts:560` | `fetch` (browser or Node) |
| `protocol` | `protocol.handle("studio-plugin", …)` serves plugin panels with strict CSP; `gameSession.protocol.handle("game", …)`/`handle("http", …)` serve games | `main/index.ts:1404`, `main/preview.ts:329-335`; `registerSchemesAsPrivileged(["game"])` | Service Worker `fetch` interception (same-origin only) |
| `session` | `session.fromPartition("game-preview")` — isolated storage/cookies for game code | `main/preview.ts:316` | Separate origin + iframe sandbox + storage partitioning |
| `webContents` | One-way control of the game view: `executeJavaScript` probes (`window.__studio.state()`), `capturePage`, `setWindowOpenHandler(() => deny)`, navigation guards, console observation, crash signals | `main/preview.ts` (multiple) | `iframe.contentWindow.postMessage` contract only; **no** cross-origin screenshot/JS injection from browser |
| `webRequest` (`session.webRequest`) | `onBeforeRequest` network allowlist — game partition may reach only the studio's own `game:` server, `data:`/`blob:`, loopback port, allowlisted font/library CDN reads | `main/preview.ts:339`, `main/page-serve.ts:678` | Service Worker allowlist (same-origin); cross-origin blocked by CSP + sandbox |
| `safeStorage` | OS-keychain-backed encryption for secrets at rest | `substrate/secrets.ts:78-106` | Server-side vault (encrypted DB/KMS); browser cannot do OS keychain |
| `powerSaveBlocker` | Hold App Nap off during unattended runs (doubles as run-active signal) | `main/keep-awake.ts`, `main/index.ts` | Wake Lock API (`navigator.wakeLock`) |
| `utilityProcess` | Fork `terminal/host.cjs` as isolated Node service for embedded terminal | `main/index.ts:441` | Server-side child process or Web Worker |
| `contentTracing` | Chromium trace recording, **dev diagnostics only** | `main/dev/diagnostics.ts:68-88` | Performance API / DevTools |
| `electron-rebuild` / node-pty / xterm.js | Embedded terminal (project shell, up to 4 sessions) | `package.json`, `main/terminal-service.ts` | Server-side PTY (GameForge: server terminal via websocket) |

### 14.2 APIs verified NOT used in app code

`screen`, `systemPreferences`, `globalShortcut`, `Tray`, `powerMonitor`,
`desktopCapturer`, Electron `clipboard` — not used. ("clipboard" appears only in a
comment; "screen" only in harness-seed payload text.)

### 14.3 Four hard gaps for a browser port (INFERRED)

(a) OS-keychain secret storage → must live server-side (encrypted vault); (b)
cross-origin screenshot/JS probing of game iframes → replace with the cooperative
`postMessage` `window.__studio` contract + server-side headless capture; (c) "reveal in
folder"/native pickers → File System Access API covers pickers, not reveal; (d) process
sandboxing of agent code (Seatbelt/seccomp) → the web equivalent is server-side
containers (Docker/gVisor) — **the single biggest architectural substitution**.

---

## 15. Components and ideas adaptable to a browser/server web environment

(INFERRED, grounded in the verified mechanisms above; each names what transfers and
what must change.)

1. **`window.__studio` instrumentation contract + HTML shim injection** (§5.1) — the
   crown jewel. Serve the game page, inject clock/input/three-hooks before game code,
   expose deterministic `seed/step/state/capture/inspect`. Transfers 1:1 to a
   server-side page server + headless Chromium (CDP).
2. **Evidence pipeline** — deterministic playthrough + per-camera screenshots +
   structural probes + console/GPU error capture + one-question vision judges on a
   JSON protocol. Vision review maps to any image-capable model.
3. **Git-refs versioning** (§8) — commit/tag checkpoints, run refs, chat checkpoints per
   message, never capture secrets/build output, keep-100-per-thread. Server: one git
   repo per project.
4. **Role model + model registry** (§3.1, §3.5) — planner/builder/judge with per-role
   model selection, capability fields (`contextWindow`, `supportsTools`,
   `supportsVision`, `efforts`), live-discovered catalogs, never-hardcode-model rule.
5. **Cost/billing discipline** (§3.6) — per-completion usage accounting, metered sources
   never auto-picked, local-first fallback, wall clocks, token budgets; crucial since
   GameForge pays per-token (Groq) rather than borrowing user subscriptions.
6. **Blind judging** (§5.2) — fresh-context one-shot verdicts, blind A/B comparisons,
   "a pick and the single biggest gap, never a score".
7. **SkillOpt learning loop + recipe library + validation-fork self-edit gate** (§11)
   — held-out-gate improvement, pairwise-blind tie-reject, undoable learned changes.
8. **Plugin model** (§10) — prebuilt directory + manifest + isolated panel iframe +
   host-service bridge + capability declarations; agents never install/enable plugins;
   trust dialog says what it is.
9. **Asset model** (§9) — extension→kind table, host-issued delivery records (plugins
   can't forge), provenance metadata, unconfirmed/integrated/verified usage ladder.
10. **Typed contracts everywhere** — `src/shared/` as the single source of IPC/RPC/UI
    contracts; typed vocabularies instead of string matching; typed StopCodes and
    refusal codes; unclassified channels fail closed. Maps to OpenAPI + zod validation.
11. **Shadow builds + change-keyed memoization + last-good fallback** (§6) — build in
    ephemeral mirrors, never user folders; judges never see stale output.
12. **Consent fails closed** — paid asset generation, publishing, tool confirmations all
    wait on explicit user cards; approvals short-lived/single-use.
13. **Question/answer durable protocol** (`ask_user` → durable `interview_question` → the
    answer arrives through the normal message queue and resumes the session).
14. **Renderer=view rule** — renderer talks to the backend only through named calls
    (`studio-api.ts`, 177 methods) → maps 1:1 to a typed REST/WebSocket client.
15. **What must change**: ProcessSandbox → container sandboxing; preview window pool →
    headless Chromium pool; Electron keychain → server vault; user subscriptions →
    Groq pay-per-token with budget guards; terminal → server-side PTY over websocket
    (or drop); Bonsai local model → server GPU or drop.

---

## 16. Tech stack

### App stack (VERIFIED — `package.json`, AGENTS.md)

| Layer | Technology |
|---|---|
| App shell | Electron 43 (`electron 43.7.6`) + electron-forge 8 (dmg/deb/rpm/squirrel) |
| Language | TypeScript 7 (native compiler vendored; Node runs `.ts` by type stripping — hence the "no enum/namespace" rule); Node 24 required (`.nvmrc`) |
| Renderer | React 19, Zustand 5 (domain stores), Tailwind 4, Radix UI, Base UI, framer-motion 11, lucide-react, xterm.js 6 (terminal), highlight.js, marked |
| Build | esbuild only ("one tool, no plugin-compatibility surface"); custom `scripts/build.mjs` |
| Lint/format | Biome 2 |
| Tests | Node test runner (`--test`), fast-check (property tests), Playwright 1.63 (e2e), tiered L1/L2/L3 with change-scoped `affected-tests.mjs` via import graph + `tests/test-map.json` |
| Game engine | three.js ^0.185.1 — **vendored** into app resources; games run as ES modules, no build step |
| Process sandbox | `@anthropic-ai/sandbox-runtime` ^0.0.73 (Seatbelt macOS / srt-win Windows; `apply-seccomp` helper on Linux) |
| CLI discovery | login-shell PATH probing, standard folders; Claude Agent SDK `@anthropic-ai/claude-agent-sdk` ^0.3.257 |

### LLM / AI stack (VERIFIED — §3.5–3.6; `package.json`)

- **No Genex-hosted LLM.** The studio borrows: Claude Code CLI (user's Claude
  subscription), Codex CLI/app-server (user's ChatGPT subscription), Ollama (user's
  local server), Bonsai 2 (bundled managed 27B ternary GGUF local model, pinned HF
  revision), OpenRouter (pasted API key, metered — never auto-picked), OpenCode.
- LLM API client: `@earendil-works/pi-ai` ^0.84.2 (OpenAI-compatible completions;
  tool calling, stream drain, usage/cost accounting; custom undici "long-haul fetch").
- Agent harness: `src/harness-seed/` TypeScript, modes director/autopilot/facet
  loop/gauntlet/spike; vendor CLIs do their own tool loop via MCP (`mcp__studio__*`)
  or shell bridge; the harness's own tool loop (`turn-loop.ts`, max 30 rounds) for
  direct engines.
- Known model ids (seed): `claude-fable-5-1`, `opus`, `gpt-5.6-sol`, `gpt-5.6-terra`;
  evals used `claude-opus-5-5`, `gpt-6.1-sol`.
- **Groq: not used anywhere.** (INFERRED — grep found no Groq references; Genex has no
  API-key-by-default LLM design.)

### Other notable deps (VERIFIED — `package.json`)

`@modelcontextprotocol/sdk` 1.30.0 (MCP), `ollama` 0.6.3, `node-pty` 1.1.0,
`update-electron-app`, `zod` 4.4.3, `@xterm/addon-fit`.

---

## 17. Explicitly NOT open-source / proprietary

(VERIFIED — `docs/plugins.md`, `docs/STUDIO-MARKETPLACE-RELEASE.md`, `PRIVACY.md`,
`docs/connections-and-context.md`, `docs/release-readiness.md`.)

1. **Genex hosted services** — `api.genex.games` (asset-generation billing/ledger,
   build-metrics ingestion, feedback endpoint), `mcp.genex.games` (creator MCP),
   `plugins.genex.games` (plugin catalog, served from Cloudflare R2
   `studio-plugin-releases`), `genex.games` (game hosting/gallery/publishing). None of
   these backends is repo code.
2. **The Genex asset-generation backend itself** — the paid `genex__asset` tool calls a
   proprietary generation service; the repo contains only the client/plugin adapter.
3. **Claude Agent SDK** — proprietary; "Needs Anthropic's confirmation … or an API-key
   mode" for distribution.
4. **Genex trademark/brand** — MIT with separate trademark rights; bundle id
   `games.genex.desktop`, name "Genex" must not change after release (fork identity
   check).
5. **Pinned Genex CLI** (`@genex-ai/cli-demo` 1.36.2) — Genex-shipped tooling, vendored
   as plugin payload; docs do not state its license; THIRD-PARTY-NOTICES covers only
   copied sources.
6. **Vendor provider accounts/CLIs** (Claude Code, Codex) — external subscriptions the
   app borrows, not bundled or open.
7. The repo itself is MIT (copyright genex.games) — caveats: contributor terms (DCO/CLA)
   still open; repo history contains internal evidence/personal paths; the unlicensed
   third-party editor reference is excluded from `dev` but on `main`.
8. **Unity support** — retired and archived (`archive/unity/`); "no flag enables them
   and there is no migration path." Unity/Unreal plugins listed in the README as "soon".

---

## 18. Test strategy overview

(VERIFIED — `tests/{conformance,e2e,property,fixtures,helpers}` + `tests/test-map.json`,
`scripts/test.mjs`, `scripts/affected-tests.mjs`, `evals/README.md`.)

- **conformance** (~hundreds of `*.test.ts`, Node test runner): one file per
  module/behavior — e.g. `page-shim.test.ts`, `page-serve.test.ts`, `build-preview.test.ts`,
  `plugin-sdk-types.test.ts` (compiles SDK `index.d.ts` against `src/shared/plugins.ts`
  both ways), `architecture.test.ts` (module boundaries), `rpc-authority.test.ts`
  (hostile-root table), `words.test.ts` (no raw status literals in UI), seed-contracts
  tests (two-copy rules).
- **e2e**: driver scripts `run-*.mjs` — full Electron, UI, build smoke, optimization,
  computer smoke, shapes, agentic-readiness, packaged smoke, design system; fixtures
  (`.tsx` UI fixtures, eval-fixture-pipeline, games, mcp fixtures, pages).
- **property**: `event-log.property.test.ts` (fast-check).
- **Change-scoped testing**: `tests/test-map.json` (explicit file→test edges) + import
  graph; tiers **L1** (fast), **L2** (per area), **L3** (rig — serial). `npm run check` =
  static + L1. `npm run verify` = static + typecheck + full tests + build + electron e2e
  + build smoke + shapes e2e + agentic-readiness.
- **Heavy static gates**: architecture boundaries, vocabulary lint (typed vocabularies,
  no raw string matching), test style, eval isolation.
- **evals/**: offline eval harness — frozen public `cases.md`, per-lane baselines, cost
  `prices.json`, `lanes.json`; ledger `ledger/export-<appSha>.jsonl`; artifacts in
  `$GENEX_EVALS_HOME`, never committed.

---

## 19. Discipline worth copying into GameForge's engineering rules

(INFERRED from AGENTS.md + architecture doc; these are Genex's own stated invariants.)

1. "No new assertions over source text; test behavior through the code's interface."
2. "Path, symlink and network boundaries get hostile-input tables that assert no side
   effect."
3. Never decide behavior by matching English text — typed codes and fields
   (StopCodes, refusal codes, vocabulary `as const` tables).
4. Every IPC channel/RPC method classified at creation; unclassified fails closed.
5. Timeouts, caps, sizes, retries are named constants in shared duration units.
6. Red first: every fix starts with a failing test for the reported reason.
7. Never describe a focused test pass as a full run (honest verification language).
8. Learned changes are versioned, listed, and individually undoable.
