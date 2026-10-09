# racing

Chase-camera car on a seeded loop track (perturbed oval via Catmull-Rom).
Lap timer, halfway checkpoint, off-track slowdown, best-lap tracking.

## Controls

- **W / ↑** throttle, **S / ↓** brake, **A D / ← →** steer.

## Contract notes

- `state()` → `{ lap, checkpoint, speed, lateral, offTrack, lapTimeMs,
  lastLapMs, bestLapMs }`.
- Scripted input: `{ throttle: 0..1, brake: 0..1, steer: -1..1 }`.
- Demos: `default`, `start-line` (reset car to the line), `freeze`, `unfreeze`.
- `trackPointAt(world, s)` (exported from `world.js`) interpolates the
  centerline — used by `main.js` for the ribbon and the car.

## How to extend

- Track shape: control-point perturbation in `createWorld`. AI opponents would
  follow `trackPointAt` with their own `s`/`lat` state.
