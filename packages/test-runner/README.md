# @gameforge/test-runner

Build pipeline + deterministic visual-evidence gathering for GameForge AI Studio.
Implements master prompt §11 (15 build phases) and the `window.__studio`
instrumentation contract (ARCHITECTURE.md §4, adapted-from-Genex).

Playwright is an **optional peer dependency**: all browser interaction goes through
the minimal `BrowserLike` / `BrowserPageLike` interfaces, so unit tests inject mocks
and the production Chromium pool (Oracle) injects real Playwright pages.

## The `window.__studio` contract (v1)

`src/shim.js` is injected by the page server **before any game code runs**.
Dependency-free, never throws (every hook is guarded).

```js
window.__studio = {
  seed(n),            // deterministic mode: seeds RNG + enters VIRTUAL clock
  release(),          // back to native clock/RNG
  step(dtMs),         // advance one scripted tick; returns state()
  state(),            // JSON-serializable game snapshot
  inspect(query),     // scene/entity queries (game-provided; fallback: {error})
  capture(cameraTag), // hint the game to frame a camera; harness screenshots
  ready(),            // 'loading' | 'loaded' | <game's own readiness string>
  errors(),           // captured page errors (ring buffer, cap 200)
  drawCalls(),        // counted three.js renderer.render calls since seed()
  mode(),             // 'virtual' | 'native'
}
```

**Wrapping, not replacing.** If the game assigns its own richer `window.__studio`
after the shim runs (templates do), the assignment is intercepted via a
getter/setter: the game's `seed/step/state/inspect/capture/ready` take precedence
and are *wrapped* with studio instrumentation (clock, RNG, error capture,
draw-call counting).

**Clock modes.**
- `native` (default): real `performance.now` / `Date.now` / `requestAnimationFrame`.
  `step(dt)` delegates to the game's own `step()` if present, else no-ops.
- `virtual` (entered by `seed(n)`): time is studio-owned and advances **only** via
  `step(dtMs)`. `Math.random` is replaced by a seeded mulberry32 between `seed(n)`
  and `release()`. Deterministic playthroughs.

**Readiness is a fact the page reports, never a wait.** `ready()` returns the game's
own readiness when it provides one, else `'loaded'` after the window `load` event
(`'loading'` before). The harness waits on this fact with a boot budget; a spent
budget is a note, not a crash.

**Draw-call counting** is best-effort: the shim wraps the first three.js-like
renderer it can find (`window.__threeRenderer`, else a scan for `.render` +
`.info.render.calls`). Never throws if none exists.

## Evidence determinism

`gatherEvidence({ page, url, seed, cameras, script, bootMs })`:

1. `goto` → wait for `__studio.ready() !== 'loading'` (boot budget, default 15 s).
2. `__studio.seed(seed)` (default `1234`, PAGE_SEED-style).
3. Baseline `state()` snapshot, then scripted actions: hold keys, `step(dtMs)` × n,
   snapshot `state()` per action.
4. Per named camera: `__studio.capture(tag)` hint, then screenshot.
5. Pixel statistics per shot via `pngjs` — `lumaMean`, `lumaStdDev`,
   `nearBlackFraction` (luma < 8), `litFraction` (luma ≥ 32). Model-free
   blank-output detection: all shots `nearBlackFraction > 0.85` ⇒ blank.
6. Console errors, failed requests, `__studio.errors()`, `drawCalls()` collected.

`classifyEvidenceFailure()` distinguishes:
- `OBSERVATION_DOWN` — the harness couldn't look (navigation threw, page closed,
  no report). **Retry; never charged to the build.**
- `BUILD_BROKEN` — the page ran but the game is broken (console/page errors,
  failed asset requests, blank output, never-ready, missing `__studio`).

## Build verdicts

`runBuildPipeline()` executes the 15 phases in §11 order. Verdict rule:

- any phase **failed** → `failed` (diagnostic preserved on the phase; `verdict` +
  `persist` always run so a failed build still gets its record — a build with no
  persisted job is a build that never happened);
- any **required** phase skipped → `partial`;
- **zero optional** phases passed (all skipped — a build that verified nothing) →
  `partial`;
- otherwise → `verified`.

Required: validateStructure, validateFiles, previewServer, chromiumSmoke,
consoleCheck, networkCheck, verdict, persist. Optional (skip honestly with a note
when not applicable): install, typecheck, unitTests, bundle, gameplaySmoke,
screenshots, acceptanceEval. No-build templates are first-class: `bundle` skips and
the static tree is served as-is.

Acceptance criteria (`console-clean` | `no-failed-requests` | `non-blank` |
`state-changed` | `manual`) evaluate to `pass` | `fail` | `unverified` and are
persisted as review results linked to the build. `manual` is always `unverified`
(requires human or judge).

## Interfaces to implement elsewhere

- `RunnerLike.exec({capability, cwd, command, env, timeoutMs, network})` —
  container execution; capabilities `install|build|test|typecheck`; network
  `'none'|'registry-only'`. No shell interpolation, ever.
- `BuildStore` (`saveBuildJob`, `saveTestResult`, `saveReviewResult`,
  `saveArtifact`) — **the Postgres implementation lands in the worker wiring
  (Phase 3b)**; this package never imports pg.
- Shadow builds: the project is copied to an ephemeral `buildDir` (excluding
  `node_modules/dist/.git/.studio`; symlinks never copied); the source tree is
  never built in place. Content-keyed memoization of `buildDir` and lastGood
  promotion are the **caller's** responsibility.

## Semantic visual review (Phase 6)

The optional `visualReview` phase (after `screenshots`) runs an AI review of
the captured screenshots — but ONLY against a LIVE verified vision-capable
model:

1. `verifyVisionModel()` selects via the registry (`requiresVision: true`,
   never a hardcoded name) and then runs `probeVisionSupport()` — a real
   1x1-image completion. Only a passing probe produces a verified binding.
2. `runVisualReview()` sends up to `maxShots` (default 4) screenshots with the
   acceptance criteria, demands a strict JSON reply, and persists one
   `review_results` row per criterion with `judge_model` set.
3. Every other path — no key, no vision model advertised, probe inconclusive,
   request failed, unparseable reply — saves a single row
   (`criterion: 'semantic-visual-review'`, `result: 'unverified'`) with an
   explicit `issue` naming the reason, and the phase SKIPS (never fails the
   build). Deterministic checks (blank detection, luma analysis, conformance)
   run independently and continue regardless.

**Honesty contract:** a row is `pass`/`fail` only when a live vision model
examined the screenshots in this run. Curated `supports_vision` flags are
hypotheses, never verification. Usage is reported through
`VisualReviewDeps.onUsage` for §7 cost accounting (the worker wires it to
`model_usage`).

## Oracle note

Real Chromium execution happens on the Oracle server (headless-Chromium pool,
bounded by instance RAM — ARCHITECTURE.md open risk R1). This VM cannot run
Playwright/Chromium, so all browser interaction here is interface-mocked and
verified by contract tests. The `BrowserLike` interface is the seam where the
real pool plugs in.

## Acceptance scenarios A–F (`src/acceptance/`)

End-to-end checks against real code paths (pipeline, page server, export-ZIP
module, asset routes via a real Fastify app, asset-thumbnail plugin). Outcomes
are exactly `verified` / `partial` / `failed` — a scenario is `verified` only
when every asserted step really ran.

```bash
npx vitest run src/acceptance          # full suite
npx tsc --noEmit -p tsconfig.acceptance.json   # typecheck the harness
```

**Browser:** the harness prefers a real Chromium (`acquireBrowser()`), found via
`GF_CHROME_PATH` or the standard Playwright cache, launched with software WebGL.
Without a binary it falls back to a faithful in-process stub and the
browser-bound checks become `skip` (outcome `partial`) — never fake passes.
`playwright-core` is a devDependency; Playwright remains an optional peer for
the package itself.

**three.js vendoring:** headless Chrome in sandboxes often can't reach the
jsDelivr CDN (egress proxies), so browser scenarios vendor three.js 0.170.0
locally and rewrite only the import-map URL in the temp project copy — game
code is untouched. The rewrite is labeled in every report (`VENDORED_THREE_NOTE`).

The harness is **test-only**: `src/acceptance` is excluded from the package
build (`tsconfig.json`) and typechecked separately (`tsconfig.acceptance.json`),
so the cross-package imports of the real API export/asset modules don't leak
into the published `dist`.
