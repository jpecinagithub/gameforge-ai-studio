// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32). World logic MUST use this — never Math.random.
// ---------------------------------------------------------------------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const W = 480;
export const H = 640;
const PADDLE_W = 90;
const PADDLE_H = 14;
const PADDLE_Y = H - 46;
const PADDLE_SPEED = 520;
const BALL_R = 8;
const BALL_SPEED = 380;
const BRICK_W = 52;
const BRICK_H = 24;
const BRICK_GAP = 6;
const COLS = 8;

// Pure world: no canvas, no DOM. Importable in Node for tests.
export function createWorld(seed = 1) {
  const rand = mulberry32(seed);
  const rows = 4 + Math.floor(rand() * 3); // 4..6 rows
  const bricks = [];
  const offX = (W - (COLS * (BRICK_W + BRICK_GAP) - BRICK_GAP)) / 2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < COLS; c++) {
      bricks.push({
        x: offX + c * (BRICK_W + BRICK_GAP),
        y: 70 + r * (BRICK_H + BRICK_GAP),
        hp: rand() < 0.12 ? 2 : 1, // ~12% hard bricks
        alive: true,
      });
    }
  }
  return {
    seed: seed >>> 0,
    paused: false,
    timeMs: 0,
    paddle: { x: W / 2 },
    ball: { x: W / 2, y: PADDLE_Y - 30, vx: BALL_SPEED * 0.35, vy: -BALL_SPEED * 0.94 },
    bricks,
    score: 0,
    lives: 3,
    resetTimerMs: 0,
    won: false,
    lost: false,
  };
}

function resetBall(world) {
  world.ball.x = W / 2;
  world.ball.y = PADDLE_Y - 30;
  world.ball.vx = BALL_SPEED * 0.35;
  world.ball.vy = -BALL_SPEED * 0.94;
  world.resetTimerMs = 0;
}

// input: { left, right: bool } or { paddleX: number } (absolute target)
export function stepWorld(world, dtMs, input = {}) {
  const dt = Math.max(0, dtMs) / 1000;
  world.timeMs += Math.max(0, dtMs);
  if (world.won || world.lost) return;

  // Paddle
  if (typeof input.paddleX === 'number') {
    world.paddle.x = Math.max(PADDLE_W / 2, Math.min(W - PADDLE_W / 2, input.paddleX));
  } else {
    const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    world.paddle.x = Math.max(
      PADDLE_W / 2,
      Math.min(W - PADDLE_W / 2, world.paddle.x + dir * PADDLE_SPEED * dt),
    );
  }

  if (world.resetTimerMs > 0) {
    world.resetTimerMs -= dtMs;
    if (world.resetTimerMs <= 0) resetBall(world);
    return;
  }

  const b = world.ball;
  b.x += b.vx * dt;
  b.y += b.vy * dt;

  // Walls
  if (b.x - BALL_R < 0) { b.x = BALL_R; b.vx = Math.abs(b.vx); }
  if (b.x + BALL_R > W) { b.x = W - BALL_R; b.vx = -Math.abs(b.vx); }
  if (b.y - BALL_R < 0) { b.y = BALL_R; b.vy = Math.abs(b.vy); }

  // Paddle bounce (only when moving down)
  if (
    b.vy > 0 &&
    b.y + BALL_R >= PADDLE_Y &&
    b.y - BALL_R <= PADDLE_Y + PADDLE_H &&
    Math.abs(b.x - world.paddle.x) <= PADDLE_W / 2 + BALL_R
  ) {
    const offset = (b.x - world.paddle.x) / (PADDLE_W / 2); // -1..1
    const ang = offset * 1.05; // max ~60°
    b.vx = BALL_SPEED * Math.sin(ang);
    b.vy = -BALL_SPEED * Math.cos(ang);
    b.y = PADDLE_Y - BALL_R - 0.5;
  }

  // Bricks
  for (const br of world.bricks) {
    if (!br.alive) continue;
    const cx = Math.max(br.x, Math.min(b.x, br.x + BRICK_W));
    const cy = Math.max(br.y, Math.min(b.y, br.y + BRICK_H));
    const dx = b.x - cx;
    const dy = b.y - cy;
    if (dx * dx + dy * dy < BALL_R * BALL_R) {
      // Bounce on the dominant axis
      const overlapX = BALL_R - Math.abs(dx);
      const overlapY = BALL_R - Math.abs(dy);
      if (overlapX < overlapY) {
        b.vx = dx > 0 ? Math.abs(b.vx) : -Math.abs(b.vx);
        b.x += dx > 0 ? overlapX : -overlapX;
      } else {
        b.vy = dy > 0 ? Math.abs(b.vy) : -Math.abs(b.vy);
        b.y += dy > 0 ? overlapY : -overlapY;
      }
      br.hp -= 1;
      if (br.hp <= 0) {
        br.alive = false;
        world.score += 10;
      }
      break; // one brick per step
    }
  }

  // Ball lost
  if (b.y - BALL_R > H + 10) {
    world.lives -= 1;
    if (world.lives <= 0) {
      world.lost = true;
    } else {
      world.resetTimerMs = 900;
      b.x = -100; // park off-screen while waiting
      b.y = -100;
      b.vx = 0;
      b.vy = 0;
    }
    return;
  }

  if (world.bricks.every((br) => !br.alive)) world.won = true;
}

export function getState(world) {
  const r = (v) => +v.toFixed(3);
  return {
    seed: world.seed,
    timeMs: Math.round(world.timeMs),
    score: world.score,
    lives: world.lives,
    paddleX: r(world.paddle.x),
    ball: { x: r(world.ball.x), y: r(world.ball.y) },
    bricksLeft: world.bricks.filter((b) => b.alive).length,
    won: world.won,
    lost: world.lost,
  };
}
