# @gameforge/game-templates

Eight functional starter game templates for GameForge AI Studio. Each template is a
**real working project**: `index.html` + ES modules, served statically. **No build
step** (Genex discipline — template games need no bundler), **zero npm dependencies
inside templates**.

## Template list

| Template | Kind | Renderer | Play |
|---|---|---|---|
| `empty-three` | free-camera | three.js | Spinning cube, grid, axes |
| `first-person` | first-person | three.js | WASD + pointer-lock mouse look, walled arena, obstacles |
| `third-person` | third-person | three.js | Follow camera, WASD + jump, climbing platforms |
| `racing` | racing | three.js | Chase cam, throttle/brake/steer, lap timer, checkpoints |
| `platformer-3d` | side-2d | three.js | Side view, run/jump, 6 coins, goal flag → win |
| `arcade-2d` | side-2d | Canvas2D | Breakout: paddle, ball, seeded bricks, score, lives |
| `puzzle` | static-board | Canvas2D | 15-puzzle, seeded solvable shuffle, move counter |
| `physics-sandbox` | free-camera | three.js | Falling/stacking boxes, click to spawn |

three.js is pinned via import map to
`https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js`
(verified live 2026-10-09). `arcade-2d` and `puzzle` use plain Canvas2D —
no Phaser, by design: zero dependencies and fully instrumentable (Genex marks
Phaser/canvas2D out of scope for the shim; same honesty here). `physics-sandbox`
uses a small inline AABB physics module (~150 lines) with a documented upgrade
path to Rapier in Phase 6.

## The no-build discipline

- A template is `index.html` + `src/*.js` + `studio.json` + `README.md`.
- No `node_modules`, no bundler, no compile step. The backend serves the directory
  statically; the page server injects the verification shim around it.
- Per-template files: `src/world.js` (pure logic), `src/main.js` (rendering/input),
  `src/studio.js` (contract wiring — identical file in every template).

## The `window.__studio` contract

Every template installs `window.__studio` via `src/studio.js`:

```js
window.__studio = {
  seed(n),     // rebuild the world deterministically with seed n
  ready(),     // true once the contract is installed AND the first frame rendered
               // (readiness is a fact the page reports, never a wait)
  step(dtMs),  // advance the simulation by dtMs with empty input.
               // The harness freezes the live rAF loop first via demo('freeze').
  state(),     // JSON-serializable snapshot (getState of the pure world)
  inspect(q),  // structural queries. q = { tag?: string }
               // → [{ tag, position }] from scene userData.tag (3D) or entities (2D)
  demos(),     // list of named demo states
  demo(name),   // jump to a named demo; returns true/false
};
```

Every template ships demos `default`, `freeze`, `unfreeze`; several add useful
ones (`start-line`, `near-goal`, `spawnAt`).

## Determinism rules

1. `world.js` is **pure**: no `three.js`, no DOM, importable in Node. It exports
   `createWorld(seed)`, `stepWorld(world, dtMs, input)`, `getState(world)`.
2. World logic uses the inlined `mulberry32` PRNG — **never `Math.random`**.
   Same seed + same inputs ⇒ bit-identical states (asserted by tests).
3. `main.js` is a thin layer: devices → `input` object → `stepWorld` → sync meshes.
   Scripted input shapes are documented per template README.
4. `getState` output must survive `JSON.parse(JSON.stringify(...))` (asserted).

## Contract conformance

`npx vitest run` — 44 tests, all in Node, no browser. Per template the suite
asserts: (a) determinism, (b) seed-varying layouts, (c) JSON-serializable state,
(d) a scripted win/solved path (teleport-onto-coins, 1-move puzzle solve, aimed
brick shot, lap-line teleport, settle-to-rest, wall clamp, jump-and-land).

## How the backend instantiates a template

```
cp -r packages/game-templates/<name> <data>/projects/<id>/
cd <data>/projects/<id> && git init && git add -A && git commit -m "seed: <name>"
```

The seed commit becomes the project's first `project_revisions` row. The page
server then serves `index.html` and drives `window.__studio` for verification.

## Tests

`npm test` in this package (vitest, Node only). `npm run typecheck` for the
test harness TS config.
