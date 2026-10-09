# empty-three

The minimal GameForge template: a fixed camera, a grid, axes, and a spinning cube.
Use it as the starting point for any 3D scene, or as the conformance reference for
the `window.__studio` contract.

## Run

Serve statically (no build step): `npx serve .` — then open `index.html`.
Append `?seed=N` to reseed.

## Contract notes

- `seed(n)` rebuilds the world; the cube's initial angle derives from the seed.
- `step(dtMs)` advances the spin; `state()` returns `{ seed, timeMs, cubeAngle }`.
- `inspect()` lists tagged objects: `grid`, `axes`, `cube`.
- Demos: `default`, `freeze`, `unfreeze`.

## How to extend

1. Add objects in `main.js`, tag them with `userData.tag` so `inspect()` sees them.
2. Put all simulation state in `world.js` (`createWorld`/`stepWorld`/`getState`) —
   it must stay importable in Node with zero browser/three.js dependencies.
3. Never use `Math.random` in `world.js`; use the inlined `mulberry32`.
