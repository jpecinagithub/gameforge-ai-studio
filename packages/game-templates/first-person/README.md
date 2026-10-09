# first-person

WASD + mouse-look (pointer lock) character in a 40×40 m walled arena with 8
seeded cylindrical obstacles. Collision: arena walls clamp + circle push-out.

## Controls

- Click the canvas to lock the pointer, then **WASD** to move, **mouse** to look.

## Contract notes

- `seed(n)` repositions the 8 obstacles deterministically; player resets to spawn.
- `step(dtMs, …)` — scripted input shape:
  `{ forward, back, left, right, lookDX, lookDY }`.
- `state()` → `{ player: { x, z, yaw, pitch }, obstacleCount, … }`.
- `inspect({ tag })` — tags: `floor`, `wall`, `obstacle`, `player`.

## How to extend

- Obstacle layout lives in `world.js:createWorld` (seeded `mulberry32`).
- Add eye cameras / probes by tagging meshes with `userData.tag`.
