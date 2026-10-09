# arcade-2d

Canvas breakout/arkanoid: paddle, ball, seeded brick field (4–6 rows, ~12% hard
bricks needing 2 hits), score, 3 lives, win/lose states. Pure Canvas2D — no
Phaser, by design: zero dependencies and fully instrumentable (Phaser remains an
optional Phase 6 template).

## Controls

- **←/→** or mouse/touch drag to move the paddle.

## Contract notes

- `state()` → `{ score, lives, paddleX, ball: {x,y}, bricksLeft, won, lost }`.
- Scripted input: `{ left, right }` or `{ paddleX }` (absolute).
- Instrumentation is entity-based (`inspect()` returns paddle/ball/brick tags),
  not scene-graph — documented as reduced instrumentation vs the 3D templates
  (Genex marks Phaser/canvas2D out of scope for the shim; same honesty here).

## How to extend

- Brick patterns: `createWorld` row/hp distributions. Power-ups would be another
  array stepped alongside the ball.
