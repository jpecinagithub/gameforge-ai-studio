# third-person

Follow-camera character with WASD movement, jumping, and AABB platform
collisions. Seven seeded platforms ascend from the ground — climb them.

## Controls

- **WASD** move, **Space** jump.

## Contract notes

- `state()` → `{ player: { x, y, z, onGround, yaw }, platformCount, … }`
  (`y` = feet height).
- Scripted input: `{ forward, back, left, right, jump }`.
- Tags: `ground`, `platform`, `player`.

## How to extend

- Platform layout: `world.js:createWorld`. Collision resolution is minimal-axis
  AABB in `stepWorld` — landing sets `onGround`.
