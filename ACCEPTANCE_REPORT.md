# GameForge AI Studio — Acceptance Report (Phase 7)

Generated: 2026-10-09 (acceptance suite, `packages/test-runner/src/acceptance/`)
Environment: node v24.20.0, linux/x64, **real Chromium available** (Chrome for Testing 153, software WebGL),
Docker unavailable, no Cloudflare credentials.

The suite (`npx vitest run src/acceptance` in `packages/test-runner`, 6/6 green)
exercises REAL code paths: the real 15-phase build pipeline, the real preview
page server, the real export-ZIP module, the real asset upload routes (via a
real Fastify app), and the real asset-thumbnail plugin. Outcomes are exactly
`verified` / `partial` / `failed` — a scenario is `verified` only when every
asserted step really ran.

## Results

| Scenario | Outcome | Evidence |
|---|---|---|
| A — Basic 3D game (files, build, controls, render, tests, download) | **verified** | Real Chromium: chromiumSmoke=pass, gameplaySmoke=pass, 1 non-blank screenshot; preview GET / → 200 with shim injected; ZIP export 8 entries incl. source + README, byte-reproducible; secret-shaped file refused |
| B — Enhancement (coins/score/victory, regression green) | **verified** | Edit to `src/world.js` picked up; baseline and rebuild both `verified`; persisted dist artifact contains the change; 2 revisions recorded; zero boot console errors on a real page; game state advances across the scripted playthrough |
| C — Failed build recovery (diagnostics, bounded correction, last-good intact) | **verified** | Failed typecheck → verdict=failed; compiler diagnostic captured and persisted; failed build still recorded; last-good untouched with 6 dist files (failed build: 0); last-good still serves over HTTP; correction loop gave up after exactly 3 attempts |
| D — Interrupted execution (state retained, no dup paid ops) | **partial** | Crashed run persisted as failed with the crash point recorded; rerun issued exactly 3 paid ops, each capability once (nothing double-charged); rerun completed `verified`; two distinct build jobs. NOT run: a real SIGKILL of the worker process — needs the live worker on Oracle |
| E — Asset integration (validated, stored, downloaded, deleted) | **partial** | Real routes: upload 201 (kind inferred `image`, hostile filename sanitized, contained on disk, sha256 matches), download 200 + attachment, empty file → 400, real PNG thumbnail 128×128 via the asset-thumbnail plugin, delete 204 + file gone + download 404. NOT run: GLB parse/load/runtime validation on a live preview page — Oracle only |
| F — Export (ZIP: source, metadata, README, reproducible, no keys) | **verified** | Valid ZIP (central directory parsed); 7 entries incl. source + generated README; two exports byte-identical; 6 committed files clean under the secret redactor; planted secret refused via `ExportBlockedError` |

## What was NOT run and why

- **Live Docker / container runner** — no Docker daemon in this VM. Runner isolation
  flags (non-root, no socket, read-only rootfs, quotas) are implemented and unit-tested
  (`apps/runner`, 13/13) but no workload container has ever been spawned. Oracle only.
- **Live PostgreSQL / Redis / BullMQ** — migrations are written and statically validated;
  the worker's resume logic and queue recovery are mocked in tests. Oracle only.
- **Real SIGKILL crash recovery (Scenario D remainder)** — the simulated crash (a thrown
  error mid-pipeline) proves verdict/persist always run and paid ops aren't duplicated;
  a true process kill exercises the worker's BullMQ resume path. Oracle only.
- **GLB runtime checks (Scenario E remainder)** — route-level validation ran for real;
  loading a model in a live game page needs the preview origin. Oracle only.
- **Cloudflare-backed flows** (director runs, semantic visual review, real AI acceptance) —
  no key in this environment. The vision gate is implemented and tested with mocks;
  unverified reviews are labeled, never presented as verified.
- **CDN three.js in headless runs** — this sandbox's egress proxy is unreachable from
  Chrome, so the acceptance runs vendor three.js 0.170.0 locally (game code unchanged,
  only the import-map URL). On Oracle the CDN import map is used as-is.

## Real defect found and fixed by this suite

The `third-person` template (and all 8 templates) shipped without a favicon, producing
a 404 console error at boot — which the pipeline's zero-console-errors contract
correctly turns into a failed build. Fixed: `<link rel="icon" href="data:,">` added to
every template's `index.html`. Template suite still 44/44 green; scenarios A/B now
reach `verified` on the real browser.

## Criteria for marking D and E verified on Oracle

- **D**: kill the worker container mid-build (`docker kill`), restart it, assert the run
  resumes or is re-queued exactly once (BullMQ job log), usage accounting shows no
  duplicated paid ops, and the build job ends with a verdict.
- **E**: upload a real `.glb`, open the game on the preview origin, assert the model
  renders (non-blank screenshot via the evidence pipeline) and `window.__studio`
  reports no errors.

## How to re-run

```bash
cd packages/test-runner
npx vitest run src/acceptance          # full suite (needs Chrome; set GF_CHROME_PATH to override)
npx tsc --noEmit -p tsconfig.acceptance.json   # typecheck the harness
```

The suite auto-detects its environment (`chromium: available|unavailable`,
`docker`, `providerCredentials`) and degrades honestly: without a Chromium binary the
browser-bound checks become `skip` (outcome `partial`), never fake passes.
