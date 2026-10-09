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

const GRAVITY = -26;
const JUMP_VEL = 10.5;
const SPEED = 8;
const PLAYER_HALF = 0.4;
const PLAYER_HEIGHT = 1.6;
const COIN_RADIUS = 0.9;

// Pure world: no three.js, no DOM. Importable in Node for tests.
// Side view: x = run direction, y = up, z fixed at 0.
export function createWorld(seed = 1) {
  const rand = mulberry32(seed);
  const platforms = [{ x0: -6, x1: 8, y: 0 }]; // start ground (top surface y)
  const coins = [];
  let x = 8;
  let y = 0;
  for (let i = 0; i < 6; i++) {
    const gap = 2.5 + rand() * 2.5;
    const w = 3 + rand() * 2.5;
    const dy = (rand() * 2 - 1) * 2.2;
    x += gap;
    y = Math.max(0, y + dy);
    platforms.push({ x0: x, x1: x + w, y });
    // coin above the platform middle
    coins.push({ x: x + w / 2, y: y + 1.6, taken: false });
    x += w;
  }
  const goal = { x: x + 3, y, w: 1.2, h: 3 };
  platforms.push({ x0: goal.x - 2, x1: goal.x + 4, y: goal.y });
  return {
    seed: seed >>> 0,
    paused: false,
    timeMs: 0,
    player: { x: 0, y: 0, vx: 0, vy: 0, onGround: true },
    platforms,
    coins,
    goal,
    coinsTaken: 0,
    won: false,
  };
}

// input: { left, right: bool, jump: bool }
export function stepWorld(world, dtMs, input = {}) {
  const dt = Math.max(0, dtMs) / 1000;
  world.timeMs += Math.max(0, dtMs);
  const p = world.player;

  p.vx = ((input.right ? 1 : 0) - (input.left ? 1 : 0)) * SPEED;
  if (input.jump && p.onGround) {
    p.vy = JUMP_VEL;
    p.onGround = false;
  }
  p.vy += GRAVITY * dt;
  p.x += p.vx * dt;
  p.y += p.vy * dt;

  // Land on platform tops (thin platforms: top surface at pl.y, thickness below)
  p.onGround = false;
  for (const pl of world.platforms) {
    if (
      p.x + PLAYER_HALF > pl.x0 &&
      p.x - PLAYER_HALF < pl.x1 &&
      p.vy <= 0 &&
      p.y <= pl.y + 0.05 &&
      p.y > pl.y - 2.5
    ) {
      p.y = pl.y;
      p.vy = 0;
      p.onGround = true;
    }
  }
  if (p.y < -12) {
    // fell: respawn at start
    p.x = 0; p.y = 0; p.vx = 0; p.vy = 0;
  }

  // Coins
  for (const c of world.coins) {
    if (!c.taken && Math.hypot(p.x - c.x, p.y + 0.9 - c.y) < COIN_RADIUS + 0.5) {
      c.taken = true;
      world.coinsTaken++;
    }
  }

  // Win: all coins + touching the goal flag
  const g = world.goal;
  if (
    !world.won &&
    world.coinsTaken === world.coins.length &&
    p.x + PLAYER_HALF > g.x - g.w / 2 &&
    p.x - PLAYER_HALF < g.x + g.w / 2 &&
    p.y < g.y + g.h
  ) {
    world.won = true;
  }
}

export function getState(world) {
  const p = world.player;
  const r = (v) => +v.toFixed(4);
  return {
    seed: world.seed,
    timeMs: Math.round(world.timeMs),
    player: { x: r(p.x), y: r(p.y), onGround: p.onGround },
    coinsTaken: world.coinsTaken,
    coinsTotal: world.coins.length,
    won: world.won,
  };
}
