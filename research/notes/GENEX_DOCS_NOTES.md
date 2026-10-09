# GENEX Research Notes — for GameForge AI Studio

Research date: 2026-10-09. Researcher: subagent (docs + repo survey).
Sources: `research/genex/` (clone of github.com/genex-games/genex, HEAD 1199d5b),
`research/genex-desktop/` (clone of github.com/genex-games/genex-desktop, HEAD d6ee9ce, 2026-10-09),
and https://genex.games/docs (fetched 2026-10-09 as raw `.md` mirrors via `/docs/llms.txt`).

Every claim is tagged **[VERIFIED]** (with exact source) or **[INFERRED]** (reasoning from evidence, not directly stated).
All Genex repos surveyed are MIT-licensed; short quotes/paraphrases are used for research, not reproduction.

---

## 0. Key correction to the master prompt's assumptions

**[VERIFIED]** The docs site https://genex.games/docs does **NOT** contain the product documentation,
developer field guide, agent runtime documentation, plugin SDK documentation, build/live-preview
documentation or studio learning documentation. It contains exactly 13 pages, all about the
**asset-generation product** ("Genex Tools"): skill/MCP/CLI/API quickstarts, how billing works,
publish-your-game, CLI/API reference, pricing, licensing FAQ, limits
(source: https://genex.games/docs/llms.txt, fetched 2026-10-09 — "Pages: 13").

**[VERIFIED]** All of those requested documents live in the **genex-desktop** repository under
`docs/`: `docs/product/*.md` (chat, workspace, builds-live, models-context, studio-learning,
assets-plugins), `docs/STUDIO-DEVELOPER-FIELD-GUIDE.md`, `docs/agent/*.md` (architecture,
feature-map, glossary, design, verification, recipes, context), `docs/harness-runtime.md`,
`docs/conversation-coordinator.md`, `docs/judge-evaluation.md`, `docs/plugins.md`,
`docs/PLUGIN_GUIDE.md`, `docs/local-models.md`, `docs/tool-permissions.md`, `docs/evals.md`,
`docs/windows-sandbox.md` (source: `genex-desktop/docs/` directory listing; README "Documentation" section).

**[VERIFIED]** The two repos are **not a monorepo** and share no code. Their relationship:
- `genex-games/genex` = the Genex *skill* (`skills/genex/SKILL.md`, stated byte-identical to the
  one served at genex.games/SKILL.md, mirrored automatically on every release) + the Claude Code
  plugin marketplace manifest (`.claude-plugin/`) + brand assets (`assets/`). It contains **no
  application code** (source: `genex/README.md`, "What is in this repository" table).
- `genex-games/genex-desktop` = the actual Electron desktop app (`package.json` name
  "ai-game-studio", productName "Genex", version 0.1.4; depends on the published
  `@genex-ai/cli-demo` 1.36.2 npm package) (source: `genex-desktop/package.json`, README).
- The asset-generation **backend is proprietary/closed**: the open repos contain clients
  (CLI package, skill, MCP, API docs) but no generation serving code. The docs say Genex "holds
  the provider relationships" and bills per generation (source: genex.games/docs/guide/how-it-works.md).

---

## (a) Architecture overview — in Genex's own terms

Genex's house vocabulary (source: `genex-desktop/docs/agent/glossary.md`):

- **Studio** — the Electron app itself (`src/main/studio-core.ts` assembles it). Also the name of
  the app-wide assistant room: a *tool-free* chat about runs and learning that cannot commission
  games or mutate the harness.
- **Harness** — the in-app agent's own code, seeded from `src/harness-seed/` into an **editable
  workspace** and run as a **sandboxed child process**; it reaches the app only through substrate RPC.
- **Substrate** — host services under the harness: event store, snapshots, workspaces, engines,
  sandbox, and the RPC the harness calls (`src/substrate/`; RPC handlers in `src/main/harness-rpc/`).
- **Seed / applySeed** — the shipped harness source plus the upgrade procedure that copies it into
  the mutable workspace *while keeping the agent's edits* (so a Git SHA alone does not identify
  runtime harness bytes).
- **Engine** — a model-provider adapter, either *direct* (completion API) or *delegated* (a
  session inside a workspace, i.e. a coding CLI).
- **Loop** has three meanings: (1) *Loop mode*, the composer switch that starts an unattended run
  (UI "Auto" means Loop off); (2) the `loop/` policy-module folder in the harness; (3) a *facet
  loop*: one facet's build → review → evidence → checks iteration.
- **Coordinator** — a read-only session that answers a game's chat on behalf of a run when the
  chat has no lead of its own.

**Process model and trust boundaries** [VERIFIED — `docs/agent/architecture.md`
"Processes and trust boundaries"]:

| Process | Trust level |
|---|---|
| Electron main | Privileged: owns IPC, StudioCore, windows, previews, secrets |
| Preload | Sandboxed; exposes only the fixed `StudioApi` calls |
| Renderer | A browser: no Node/Electron/main/substrate imports; talks only via named calls in `src/shared/studio-api.ts` (boundary enforced in CI by `verify:architecture` → `scripts/check-boundaries.ts`) |
| Harness child | **Untrusted** (the in-app agent rewrites it): plain Node under `ProcessSandbox` |
| Contractors (coding CLIs) | Vendor harnesses briefed by the studio |
| Game pages | Untrusted web content in a closed partition |
| Plugin backends, MCP servers | **Trusted native code the user approved** — a process is crash isolation, *not* a sandbox |
| Terminal hosts | One Electron utility process per node-pty session, running as the user |
| CLI installers | Vendor installers, unsandboxed |

**Sandbox mechanics** [VERIFIED — same section + `docs/windows-sandbox.md`]:
- `ProcessSandbox` grants per-process folder roots; macOS uses a Seatbelt profile, Windows runs
  commands as a local `srt-sandbox` user via sandbox-runtime's srt-win backend (vendored exe).
- Base deny-read list (`baseDenyRead`): `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.netrc`,
  `~/Library/Keychains`, and on Linux the desktop secret stores (`keyrings`, `~/.gnupg`,
  kwallet, `~/.pki`).
- Path containment has one home (`src/substrate/paths.ts`): lexical `isInside`/`isBelow` plus
  realpath checks; symlink leaves are never followed on write.
- The harness RPC is an **untrusted surface**: zod schemas (`HARNESS_PARAM_SCHEMAS`) validate
  every call; unknown methods and bad path params are refused; `events.append`/`turn.append`
  refuse `tool_permission` and `plugin_consent` rows (only the host may write those); host git
  always runs with `core.hooksPath=/dev/null` so a repo config can never make the host run a program.
- Sandboxed children get an allow-listed environment; credential-shaped env vars
  (`*TOKEN*`, `*SECRET*`, `*KEY*`, `*PASSWORD*`, `*_DSN`, `*SESSION*`, …) are stripped for contractors.
- **Documented residual risks** (Genex lists them honestly): a Codex contractor can read the
  whole disk (Codex's own sandbox restricts writes, not reads; wrapping it in ProcessSandbox is
  *planned*); OpenCode reads its sign-ins; an npm install briefly opens the registry to every
  sandboxed process; a `genex` CLI run briefly opens `api.genex.games` to every sandboxed process;
  a `Run` button on an agent-offered command executes with the user's own permissions.

**Persistence** [VERIFIED — architecture.md "Persistence and the event log"]:
- `EventStore` (`src/substrate/event-store.ts`): append-only, single writer, ids minted under a
  lock so a clock set back cannot reorder history; crash recovery keeps rather than moves files.
- **Redaction on append**: every event passes through `secretRedactor(knownSecretValues())`
  before being written, returned or announced — credentials never reach the renderer, logs,
  prompts, games or other plugins.
- `SecretStore` (`src/substrate/secrets.ts`): OS-keychain-backed via Electron safeStorage, fails
  closed; plaintext backends are tests-only.
- Game library (`~/AI Games` default root): versioned index keyed by canonical folder; *removal
  hides the entry and leaves files and events* (never deletes user data); rename never renames
  the folder; every game-named folder in the root is listed.
- Run summaries and Studio activity are pure projections over the event log, never execution gates.
- Dev fixtures: `npm run studio:dev -- start --profile first-run --fixture app-basics` runs the
  app with scripted models and no account; every new IPC channel must be classified
  fixture-safe or native.

---

## (b) Agent system design — roles, tools, orchestration, memory

**Roles** [VERIFIED — glossary.md, architecture.md "The run", product/models-context.md]:
- **Director** — on session-capable engines, *one delegated session conducts the whole run*,
  using the harness machinery as tools (`plan`, `goal_update`, `worker_start`, `worker_status`,
  `worker_steer`, `worker_stop`, `judge`, `playtest`, `integrate`, `show`, `note`, `finish`, `look`).
  The director leads the integration worktree; a waking variant ("lead"/"one session") *is* the
  chat's own session and answers the chat again after the close.
- **Workers / Contractors** — persistent builder sessions that write game code for one facet or
  turn, each in its own worktree (`refs/studio/runs/<runId>/workers/<facetId>`); default max 4
  concurrent, configurable up to 12 (Settings → Harness).
- **Reviewers (Judges)** — fresh-context, one-shot sessions that compare candidates **blind** and
  name defects; *never a score* ("The app calls it a reviewer; the harness and its prompts keep
  'judge' on purpose").
- **Scout** — read-only session that plays the game to the requested state and reports setup/
  builder-count/what-exists *before* planning; the plan is clamped to that ceiling.
- **Coordinator** — read-only session answering the chat for runs with no lead.
- **Art director** — the one absolute judge: asks "would you ship this as the user's demo today?"
  over ≤14 frames; defects are routed to owners as finish work but **never veto a landing**.
- **Studio assistant** — tool-free, app-wide chat about runs and learning; owns no authority to
  mutate the harness.

**Model-per-role selection** [VERIFIED — product/models-context.md, architecture.md
"Roles across providers"]: the UI exposes **Main agent, Workers, Reviewers** model pickers
grouped by provider; each chat keeps its model/effort/Loop; workers and reviewers run only in
Loop and survive a main-agent change; reviewers must be vision-capable. Jobs may cross engines
(`crossesTo` rule): an Ollama main agent may hand workers/reviewers to a session provider; a
session main agent may hand reviewers (never workers) to Ollama, because the director hires every
worker as a session.

**Engines** [VERIFIED — architecture.md "Engines and providers"]: direct engines (`complete`,
`models`, `status`: Ollama, Bonsai) and delegated engines (`delegate` into a workspace: Claude
Code, Codex). Preferred order: **local first (cannot be rate-limited), then subscriptions**.
Rate limits fall back only to a direct engine; context overflow and auth fall back to nothing.
Judge sessions are one-shot with no history, run in one stable directory so the prompt prefix can
be cached. Provider receipts distinguish requested vs reported model; unknown stays unknown.

**No API keys of Genex's own**: the desktop app drives the user's **existing Claude Code or
ChatGPT subscriptions** through the vendor CLIs' native sign-in (credential homes kept in the OS
keychain; sign-in UI is a guided in-app flow), or **local models** (Bonsai 2 27B managed download
on Apple Silicon ≥16 GiB, or the user's own Ollama). OpenRouter/OpenCode appear as metered
alternatives, never auto-chosen. [VERIFIED — README, product/models-context.md, docs/local-models.md,
research/bring-your-own-ai-subscription-2026-09-04.md]

**Orchestration mechanics** [VERIFIED — architecture.md "The run: director, workers and judging",
docs/harness-runtime.md]:
- **Wake/digest loop**: the director ends its turn after each decision; the harness resumes the
  same session with a digest (user's words verbatim, what happened, run state). User/finish/steer
  wake at once, worker news after 5 s; timers cover plan window, wrap-up, worker limits and a
  20-minute heartbeat; at most 30 wakes/hour.
- **Run journal** (`autopilot_<runId>`): durable record — worked clock, plan, ledger, health,
  workers, wake state. Resume continues with time left; reopen starts a fresh budget. Crash/quit
  recovery reopens runs as *paused* from the journal — stopped/failed/incomplete/delivered stay
  distinct, and a resumed run never silently repeats completed work.
- **Git-backed coordination**: integration head on `refs/studio/runs/<runId>/integration`;
  attempts, spikes and snapshots on studio refs; one committer identity (`STUDIO_AS`); builder
  notes in `docs/notes/NOTES.<facet>.md`; landing requires the head to have moved beyond the
  start *and* loaded or been judge-passed; uncommitted user changes block landing ("Make it live").
- **Plan review**: composer Plan mode requires explicit approval before execution; the request,
  plan and versioned status live in thread metadata; approval dispatches the brief; a waiting plan
  survives relaunch.
- **Verdicts**: every judged build leaves `{pass, build, against, observed, measured, seen,
  decision, because}`; blind side-by-side picks decide acceptance; a flip counts as proof only
  when it is a "strong flip" (scene/pixel/metric/probe/demo/play check); regressions need a
  second look to reproduce.
- **Permissions**: five modes — Auto (recommended), Manual, Accept edits, Plan, Bypass
  permissions. Only the chat's own session, the build's lead, or the run's coordinator ever asks
  the person; **builders, workers, playtester, scouts and judges stay unattended and sandboxed**.
  The host alone decides who may ask, from its own records — never from anything the harness says.
  [VERIFIED — docs/tool-permissions.md]

**Memory** [VERIFIED — harness-runtime.md "Ledger and lessons", glossary, product/studio-learning.md]:
- `loop/ledger.ts` appends one record per outcome to `library/games/<game>.jsonl` in the harness
  workspace (never the user's repo); `deriveLessons` writes `library/games/<game>.md`; the next
  run carries the top five as `LAST TIME ON THIS GAME`.
- Technique library: `library/checks.json` (technical checks), `library/recipes` (craft checks
  retrieved by failing check/named defect/plan); a passing *spike* becomes a recipe.
- Wake payloads report estimated token size against an 8k budget; compaction is automatic per
  provider; `/compact` is the manual control; original user requirements survive compaction.
- [INFERRED] There is no vector/semantic memory in the surveyed code — memory is file/journal/
  ledger-based with relevance retrieval by check/defect/plan keys.

**Self-improvement (Studio Learning)** [VERIFIED — product/studio-learning.md,
architecture.md "Learned changes", runtimewire/bitcoinversus reporting]:
- Learning starts ON; **"Apply suggestions automatically" starts OFF** on fresh installs.
- Harness learns from run evidence and proposes reusable instruction changes; each proposal has a
  plain-language title/summary, the exact diff, and **Undo**; SkillOpt stages edits to skill
  files or `library/contract-lessons.md`.
- **Self-edit gate** (`guardian.validate_edit`): a proposed harness code change is type-checked
  *in a validation fork* with the vendored TypeScript compiler and booted; only
  `guardian.write_self` changes the agent's files; a snapshot is taken before, a blind judge
  compares, and a version that fails to start is rolled back. Experimental and disabled unless
  the user enables it.
- **A learning count does not certify a better game**; proposed/applied/checked/game-quality
  results are tracked as distinct states; automatic learning stays off until measured acceptance
  is established (docs/evals.md: "Keep automatic learning off until its own measured acceptance
  is established"; candidates run in shadow mode on a frozen eval set first).

---

## (c) Build / test / preview pipeline mechanics

**Project shapes** [VERIFIED — architecture.md "Projects, builds and previews"]: `ProjectShape`
is decided by *evidence* (every `<script src>`, package.json, bundler config, engine runtime
files), never the entry filename: `three-vite`, `three-modules`, `canvas2d`, `phaser`,
`engine-export`, `own-script`. Only the studio's own template (contractVersion in studio.json +
vendored three import map) gets full run support; an `engine-export` game can be played and
photographed but **can never start a run**. Eight game *kinds* (`loop/kinds.ts`): first-person,
third-person, top-down, side-2d, racing, flight, static-board, free-camera — each declares
traits (all OFF until the planner/director/`studio.json` declares them), probe axes, eye
cameras, a critic (`place` for walkable worlds, `screen` for boards/puzzles), and a play script.

**Builds** [VERIFIED — same section]:
- A build **never runs in a folder the user owns**: the folder is mirrored into a shadow copy
  under `scratch/builds/<project>-<hash>/` (Git's view of the project + `.env*`, `node_modules`
  linked, output kept in `last/`). Builds are memoized on a tree key; "Try again" forgets the memo.
- The package manager comes from the lockfile; installing is the one thing that opens the network
  (only `registry.npmjs.org`, behind an explicit button), and only the lockfile's own install
  line runs.
- A failed or empty build shows the **last good output** with the reason; a judged load can still
  fail a bad-looking good build.

**Preview (Live)** [VERIFIED — architecture.md + product/builds-live.md]:
- Every game view comes from `GamePreview.create()`: its own session partition, `sandbox`,
  `contextIsolation`, no Node, `webSecurity`, no preload/IPC, `window.open` refused; the session
  grants pointer lock/fullscreen and denies mic/camera.
- **Network policy**: the game partition is closed — `onBeforeRequest` allows only `game:`,
  `data:`, `blob:`, registered loopback ports, and HTTPS GET/HEAD to the exact public library
  and font CDN hosts in `src/substrate/preview-network.ts`. No per-game network opt-in exists yet.
- **Served-page rewrite** (`src/main/page-serve.ts`): only the served document is rewritten (never
  a file on disk; idempotent): charset first, the studio **shim** script, the page's own import
  map with only `three` and `three/webgpu` pointed at the studio hook, then the module hook.
- **Page shim** (`src/page/`): `window.__studio` facade, studio-owned clock (`step`/`pause`/
  `seed`), `seed(n)` reproducible, draw calls counted *at the graphics API*, readiness a *fact
  the page reports* rather than a wait. Applies to any Three.js game (inline, ES modules,
  Vite bundle which adds a two-line `installStudio({renderer, player})`); WebGL and WebGPU equal.
  **Out of scope: Phaser, plain canvas 2D, engine exports.**
- **Readiness**: waits for a fact (`READY_PROBE`, via shim/contract/none), never throws; order is
  ready → gesture → setup → start, one boot budget (default 15 s; a spent budget is a note, not a failure).

**Evidence / visual verification** [VERIFIED — harness-runtime.md "Acceptance evidence",
glossary "Evidence pass"]:
- `gatherEvidence`: load → prove the clock → drive → photograph → read, with one classifier for
  why a look failed. Captures record provenance (source, composited, drawCalls).
- **Agents test in hidden windows, never in Live**; each building delegation and looking
  read-only session gets one pooled preview window (`preview.capacity` reports free windows and
  memory). The lead's frames that the chat reuses never certify a delivered build.
- **Computer tool** (`src/substrate/computer-tool.ts`): the studio's own computer use with
  Anthropic's action vocabulary plus `camera`, `state`, `reload`, `console`.
- Plugin API 3 `observe`/`still`: photographs a named view at 320–1920×240–1200 and returns the
  image **plus pixel statistics** (`lumaMean`, `lumaStdDev`, `nearBlackFraction`, `litFraction`) —
  deterministic blank-output detection without any model.
- **Judging**: blind A/B (or facet A/B, or the art director's ship/no-ship) with full provenance
  per verdict (system-prompt SHA-256, challenger A/B shuffle, engine, requested vs served model,
  fallback; SHA-256 of the whole ask; reply excerpt; usage; image count). A garbled/unusable
  answer is *never* read as a tie, defect or failure — the incumbent is kept. Human blind pair
  review (≥2 independent labelers) is the calibration standard in evals.
- **Scoreboard**: per-iteration pass/fail of each check, compared mechanically between iterations.
- **Evals** (offline, `docs/evals.md`, `evals/`): lanes (`genex-claude`, `raw-claude`,
  `raw-codex`, `genex-codex`, `-auto`, `-plugin-off`, fixture lanes); **pinned briefs in
  `evals/cases.md` — "a brief is never reworded once pinned"**, each versioned by the sha256 of
  its own block; append-only local JSONL ledger; metrics-only committed baselines; `npm run
  check:isolation` fails if a case's words appear in anything the in-app agent or graders read.

**Acceptance vocabulary** [VERIFIED — harness-runtime.md "Build outcome reporting acceptance"]:
a build is *verified*, *partial* or *failed*; a finished worker, passing checks, integration and
Live's revision are **distinct facts that summaries never merge**; chat shows the delivery's
capture and Play (failures included); missing checks, coverage limits, counts and revisions are
reported in Builds and Studio.

---

## (d) Asset generation pipeline — and what is proprietary/closed

**Genex cloud asset tools (proprietary backend; open clients)** [VERIFIED —
genex.games/docs/reference/api.md, guide/how-it-works.md, reference/limits.md]:
- 13 generation lanes (`kind`): `model`, `model_segment`, `model_rig`, `model_animation`,
  `image`, `video`, `texture`, `sfx`, `music`, `voice`, `character`, `character_animation`,
  `character_motion`.
- `POST /api/generations` → `201 {id, kind, status: "pending", creditsQuoted}` (charge lands at
  acceptance) → poll `GET /api/generations/:id` (`pending → processing → completed | failed`) or
  subscribe to `GET /api/generations/:id/events` (SSE: snapshot, heartbeats, terminal event with
  the full `files` manifest, then the stream closes).
- **One balance, one price rule**: 1 credit = $0.01 (public fixed anchor); price = provider cost
  × 1.15 margin, rounded up to a whole credit; live prices rendered from the API (docs prose
  never types a price — a docs-truth test enforces it). Failed generations refund automatically;
  a 402 means out of credits — do not retry.
- Rate tiers: 600 req/min overall; 30 generations/5 min; video 4/10 min; character motion 6/10 min.
- Four **credential classes**: full account (browser/CLI), API key (`genex_sk_v1_`, generate+read
  only, shown once, stored hashed), MCP creator token, Player MCP (`genex:player`, spends nothing).
- Sign-in is a device-code flow: the agent waits, **never drives the user's browser**; the chat
  never sees a key (SKILL.md "The trust point").
- **What is closed**: the provider relationships, the generation workers, the pricing/billing
  backend, the hosted relay behind `@genex-ai/multiplayer`, the publishing platform behind
  `genex publish`, and player identity (`@genex-ai/embed-sdk`). The open repos contain only the
  skill text, CLI/MCP clients, and API documentation. [VERIFIED — absence of any serving code in
  both repos + "Genex holds the provider relationships" (how-it-works.md)]
- **Licensing of outputs** [VERIFIED — reference/licensing-faq.md]: "Assets you generate are
  yours to ship inside your game"; music is fine inside a game, not as a standalone download;
  do not resell generated assets as packs. **Caveat**: the page is explicitly "held until a
  one-time legal pass over each provider's terms" — treat as intent, not a licence [INFERRED:
  not final legal advice].

**Local Blender (open, first-party plugin)** [VERIFIED — `src/plugins/blender/plugin.json`,
backend.ts]: API 3 plugin, `native-runtime` capability, needs no Genex account. Tools:
`status`, `model` (runs a `bpy` script from `assets/src/<name>.py`; the script must not
export/render itself — the host exports **GLB + two renders**), `retrieve`. Skill text tells
the agent to load the exact returned GLB path with GLTFLoader and verify it in the real preview.
CPU-compatible by construction; bounded native outputs (100 MiB/job cap).

**In-app asset bookkeeping** [VERIFIED — architecture.md "Assets"]:
- Delivery ledger: `PluginServices.onDelivered` → host-owned `asset_delivered` event (project,
  plugin, job, files, worker attribution); the Builds graph joins tool calls to deliveries on
  `callId`/`jobId`. **A plugin cannot forge or suppress these records.**
- Inventory: `game-assets.ts` enumerates `assets/**` and `public/assets/**` read-only, joins the
  ledger by SHA-256 (renames tracked); **"A delivered file is never evidence the game uses it."**
- Viewers: native media elements + trusted `asset-model-viewer`; CSP allows WebAssembly and blob
  workers, not arbitrary evaluation; readers are byte-sniffed and size-capped (16 MiB stills,
  100 MiB previews).
- Export (`game-export.ts`): stages fresh public files into an app-managed destination; hidden
  files, env files, private-key names, dependencies and symlinks excluded/refused.

**Publishing (proprietary platform; open client flow)** [VERIFIED —
genex.games/docs/guide/publish-your-game.md, `src/plugins/genex/publish.ts`]:
- `npx genex init --convert` turns a tools workspace into a hosted game (project row, private
  managed repo, play URL, `.genex/project.json`); `preview` deploys to a staging address;
  `promote` copies that exact build to production; `rollback` reverts.
- Play address `https://<slug>.genex.technology`; gallery page with cover and optional Remix button.
- The cover is **one real 16:9 frame of the game** (`.genex/scratch/cover.png`), never synthetic art.
- Rule (carried in both Skill and MCP tool): offer publishing **at most once**, after the game is
  built and running, in one line — a no is final.
- The in-app Genex plugin wraps this with host tools (`genex__cli` free, `genex__cli-paid` and
  `genex__package` after consent) and a host-drawn publish dialog that tests the draft before
  making it public.

---

## (e) Plugin system design

**[VERIFIED]** — `docs/plugins.md` ("Studio plugins — API 3"), `docs/PLUGIN_GUIDE.md`,
`src/plugin-sdk/`, `src/plugins/{example,blender,genex}`.

- **Shape**: a prebuilt directory with `plugin.json` (manifest), a backend ES module, and
  self-contained HTML panels. Agent tool names are namespaced `<plugin-id>__<tool-name>`.
- **API versions 1/2/3 are additive**; unknown versions refused; unknown manifest fields dropped
  (canonical manifest = the string the catalog compares); version-gated fields rejected with a
  clear message rather than silently ignored.
- **Manifest fields**: `apiVersion`, `id` (lowercase/digits/hyphens), `version` (semver), `name`,
  `publisher`, `description`, `backend`, `capabilities`, `tools[]`, `tools[].confirmation` (API 2),
  `tools[].host` (API 3, reserved for the bundled Genex plugin), `skills[]` (inline text or API 3
  file skills — summary in the brief, full text read on demand via `<plugin>__skill`, never
  copied into a game), `panels[]`, `settings[]`, `actions[]` (UI-invoked, never agent tools;
  sensitive names like `unlock`/`publish-draft` must carry confirmation), `network` (≤32 hosts,
  API 2), `toolbar[]` (≤4 stage-strip buttons, API 2), `mcpServers[]` (≤4 plugin-owned MCP
  connectors, API 2), `icon` (≤512 KiB, verified by magic bytes).
- **Capabilities**: `settings`, `project.read`, `project.write`, `jobs` (+`events.emit`),
  `observe`, `credentials`, `external-auth`, `network`, `export` (API 2), `native-runtime` (API 3).
- **Three install states**: `enabled` / `disabled` / `not-enabled` (code found without an install
  record — listed under "Not enabled" and never activated until the person presses **Allow…**).
  Dropping a folder into the packages dir changes nothing until a person allows it.
- **Distribution**: local folder load, Install from GitHub (pins the release / newest commit),
  curated catalog served anonymously from `plugins.genex.games` (SHA-256 digests, canonical
  manifest comparison; downloads refuse redirects, bounded 256 MiB). Reviewed release records
  live in `genex-games/genex-plugins`; a maintainer review gates Marketplace listing.
  **Game agents cannot install, enable, update, allow or approve plugins**; updates are never
  automatic and wait for active sessions; expanded capabilities require explicit re-consent.
- **Install-time static scan** + isolated startup probe; a failed probe leaves the prior
  installation selected. Removal preserves data/credentials/jobs; reinstall re-acquires from the
  **recorded origin** (the exact pinned commit, not today's index). An id is not an identity:
  same id + different publisher requires "Replace and erase data".
- **Tool consent model** (host-owned, never the plugin or agent): a tool with `confirmation`
  (anything that spends, publishes or acts beyond the game folder) triggers a host-drawn card;
  approval comes only from the user; decline/timeout/stop reaches the agent as *text*, not an
  error; unanswered questions decline after 9 minutes. Every tool call is wrapped by the host —
  engines cannot route around the card.
- **Backend SDK** (`src/plugin-sdk/`): `export async activate(host)` returning
  `tool`/`action`/`review`; capability-checked, invocation-scoped host services:
  `settings.read`, `storage.root`, `project.read/write` (traversal refused),
  `assets.deliver` (host records `asset_delivered`), `jobs.read/write`, `events.emit`,
  `observe`/`still`, `export.stage`, `credentials.read/write/clear` (plugin-scoped; agents
  cannot invoke account actions). Backends start with only PATH/HOME/TMPDIR; **"a child process
  is crash isolation, not an OS security sandbox — the trust dialog says so."**
- **Panels**: opaque-origin sandboxed frames over `studio-plugin:`; CSP refuses network, forms,
  external scripts/images; approval tickets are short-lived, single-use, bound to
  plugin/action/arguments/project; a panel never supplies its own approval ticket.
- **Shipped examples**: `src/plugins/example` (API 2: plain tool, confirmed tool, actions,
  settings panel, toolbar button), `src/plugins/blender` (API 3, native-runtime), `src/plugins/genex`
  (bundled; asset lanes, publishing, cover, skills, MCP entry). Scaffolding: `npm run plugin:new`,
  `npm run plugin:doctor` (checks it the way Genex will), `npm run plugin:pack`.

---

## (f) Local vs cloud execution; licensing / MIT notices to preserve

- **Local-first**: the whole studio (agents, builds, previews, event store, harness) runs on the
  user's machine as an Electron app (macOS Apple Silicon + Linux x64 shipped; Windows soon).
  [VERIFIED — README download table]
- **Model compute**: user's own Claude Code / ChatGPT subscriptions via the vendor CLIs'
  native sign-in (credentials in OS keychain / safeStorage, redacted from every event), or local
  models: **Bonsai 2 27B** (managed download of pinned Hugging Face revisions with SHA-256
  verification, on-demand loopback-only server, stops after 5 min idle) or the user's own
  Ollama. OpenRouter/OpenCode are metered alternatives, never auto-chosen.
  [VERIFIED — product/models-context.md, docs/local-models.md, architecture.md "Engines and providers"]
- **Cloud touchpoints (all optional, all Genex-operated)**: asset generation
  (`api.genex.games`), multiplayer relay (`@genex-ai/multiplayer`), publishing
  (`<slug>.genex.technology` + gallery), player identity (`@genex-ai/embed-sdk`), plugin catalog
  (`plugins.genex.games`). Core game creation, previews and exports work with **no enabled plugins**.
  [VERIFIED — docs/plugins.md, product/assets-plugins.md]
- **Genex Pro** is a plan for the *hosted game-building chat* on genex.games — "a separate thing
  from Genex Tools, and nothing on these pages requires it." [VERIFIED — how-it-works.md callout]
- **Data locations** [VERIFIED — STUDIO-DEVELOPER-FIELD-GUIDE.md]: normal profile
  `~/Library/Application Support/Genex/`; harness workspace `workspaces/harness/`; engine homes,
  runs, events under the profile; `~/AI Games/` for user game source; eval data under
  `~/.genex-evals`, never committed with secrets.

**Licensing** [VERIFIED]:
- `genex/LICENSE`: "MIT License / Copyright (c) 2026 Genex" — full MIT text.
- `genex-desktop/LICENSE`: "MIT License / Copyright (c) 2026 genex.games" — full MIT text.
- `genex-desktop/THIRD-PARTY-NOTICES.md` exists (vendored-component attribution).
- What the MIT covers: code, docs, the skill text. **Brand assets** (`genex/assets/`: wordmark,
  mark, share card; `.github/logo-*.svg`, banner) ship in the repo but carry no trademark grant —
  [INFERRED] GameForge must not reuse Genex's name, logo or wordmark; keep the MIT copyright
  notices on any adapted code/docs and add third-party attribution mirroring THIRD-PARTY-NOTICES.md.
- Skill/installer notes: `skills/genex/SKILL.md` is mirrored byte-identical from the product on
  every release ("not edited here"); the desktop app pins `@genex-ai/cli-demo`; installer writes
  `.genex/workspace.json`, a managed block in the project's `AGENTS.md`, and appends
  `.genex/`, `.env*` to `.gitignore` — "all appends, nothing moved or deleted."
- **Do not use** Genex proprietary services without authorization: the generation API
  (api.genex.games), the multiplayer relay, the publishing platform, and player identity are
  Genex-operated; the docs warn that generated-asset *licensing* itself is pending a legal pass.
- Product status: pre-release — README says "Genex is early: expect rough edges"; SECURITY.md
  "Scope" notes "There are no released builds yet" (as of the surveyed HEAD, 2026-10-09).
  [VERIFIED]

---

## Appendix: file map of the surveyed material (for the reference-analysis author)

- `research/genex/` — README.md, LICENSE, `skills/genex/SKILL.md` (96 lines), `.claude-plugin/`, `assets/`
- `research/genex-desktop/docs/product/` — chat.md, workspace.md, builds-live.md, models-context.md, studio-learning.md, assets-plugins.md
- `research/genex-desktop/docs/agent/` — architecture.md (1171 lines), feature-map.md, glossary.md, design.md, verification.md, recipes.md, context.md, knowledge-map.json
- `research/genex-desktop/docs/` — harness-runtime.md, conversation-coordinator.md, judge-evaluation.md, local-models.md, tool-permissions.md, connections-and-context.md, plugins.md, PLUGIN_GUIDE.md, STUDIO-DEVELOPER-FIELD-GUIDE.md, STUDIO-MARKETPLACE-RELEASE.md, evals.md, windows-sandbox.md, release-operations.md, release-readiness.md, performance.md
- `research/genex-desktop/` — README.md, AGENTS.md, LICENSE, SECURITY.md, PRIVACY.md, THIRD-PARTY-NOTICES.md, CONTRIBUTING.md, package.json, forge.config.cjs, `src/{main,renderer,preload,substrate,harness-seed,harness-boot,game-template,page,plugins,plugin-sdk,shared}`, `evals/{README.md,cases.md,lanes.json,prices.json}`, `marketplace/`, `research/bring-your-own-ai-subscription-2026-09-04.md`
- `/tmp/genex-docs/*.md` — the 13 fetched genex.games/docs pages (ephemeral; re-fetch from the `.md` URLs in llms.txt if needed)

## Notable mechanisms worth stealing for GameForge (editorial, all VERIFIED above)

1. "A delivered file is never evidence the game uses it" — asset delivery ≠ integration proof.
2. Judge verdicts carry provenance (prompt SHA-256, challenger shuffle, model identity); garbled answers keep the incumbent — never read as tie/defect/failure.
3. Builds never run in the user's folder (shadow copies); a failed build shows the last good output with the reason.
4. Wake/digest orchestration: the director ends its turn after each decision; the harness resumes with a digest; run journal makes crash recovery a resume, not a restart.
5. Host-owned consent cards that agents cannot route around or answer; declines arrive as text, not errors.
6. Append-only event log with redaction-on-append; run summaries as pure projections.
7. Pinned, never-reworded eval briefs versioned by sha256; automatic learning off until measured acceptance exists.
8. Seed/applySeed upgrades that preserve the agent's own edits to the harness, with a type-checked validation fork before any self-edit lands.
