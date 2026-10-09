# physics-sandbox

Boxes fall, collide and stack under gravity. The physics is a small **inline
AABB engine** (~150 lines in `world.js`): gravity, substeps, minimum-penetration
resolution, restitution impulse, Coulomb-lite friction.

**Upgrade path:** replace the inline module with Rapier (Phase 6) behind the same
body interface `{ id, x,y,z, vx,vy,vz, hx,hy,hz, static }` — `main.js` only
reads positions/scales.

## Controls

- Click the ground to spawn a box.

## Contract notes

- `state()` → `{ bodyCount, settled, bodies: [{ id, x,y,z, vx,vy,vz }] }`.
- `spawnBox(world, x, y, z, size)` is exported from `world.js` for scripted tests.
- Body cap: 120 (runaway-script guard).
- Demo `spawnAt` drops a box at (0, 8, 0) — scripted interaction for the harness.

## How to extend

- Restitution/friction: constants at the top of `world.js`. Compound shapes and
  rotation are out of scope for the inline engine — that's the Rapier upgrade.
