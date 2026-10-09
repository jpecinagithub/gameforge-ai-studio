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

export const ARENA_HALF = 20; // arena is 40 x 40 m
export const PLAYER_RADIUS = 0.5;
const SPEED = 6; // m/s

// Pure world: no three.js, no DOM. Importable in Node for tests.
export function createWorld(seed = 1) {
  const rand = mulberry32(seed);
  const obstacles = [];
  for (let i = 0; i < 8; i++) {
    obstacles.push({
      x: (rand() * 2 - 1) * (ARENA_HALF - 4),
      z: (rand() * 2 - 1) * (ARENA_HALF - 4),
      r: 0.8 + rand() * 1.2,
    });
  }
  return {
    seed: seed >>> 0,
    paused: false,
    timeMs: 0,
    player: { x: 0, z: 8, yaw: 0, pitch: 0 },
    obstacles,
  };
}

// input: { forward, back, left, right: bool, lookDX, lookDY: radians }
export function stepWorld(world, dtMs, input = {}) {
  const dt = Math.max(0, dtMs) / 1000;
  world.timeMs += Math.max(0, dtMs);
  const p = world.player;

  if (input.lookDX) p.yaw -= input.lookDX;
  if (input.lookDY) {
    p.pitch = Math.max(-1.45, Math.min(1.45, p.pitch - input.lookDY));
  }

  const fwd = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
  const strafe = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  if (fwd !== 0 || strafe !== 0) {
    // yaw = 0 faces -z (three.js convention)
    const sin = Math.sin(p.yaw);
    const cos = Math.cos(p.yaw);
    let dx = -sin * fwd + cos * strafe;
    let dz = -cos * fwd - sin * strafe;
    const len = Math.hypot(dx, dz) || 1;
    dx = (dx / len) * SPEED * dt;
    dz = (dz / len) * SPEED * dt;
    p.x += dx;
    p.z += dz;

    // Arena walls
    const lim = ARENA_HALF - PLAYER_RADIUS;
    p.x = Math.max(-lim, Math.min(lim, p.x));
    p.z = Math.max(-lim, Math.min(lim, p.z));

    // Circle obstacles: push out
    for (const o of world.obstacles) {
      const ox = p.x - o.x;
      const oz = p.z - o.z;
      const d = Math.hypot(ox, oz);
      const min = o.r + PLAYER_RADIUS;
      if (d < min && d > 1e-6) {
        p.x = o.x + (ox / d) * min;
        p.z = o.z + (oz / d) * min;
      }
    }
  }
}

export function getState(world) {
  const p = world.player;
  return {
    seed: world.seed,
    timeMs: Math.round(world.timeMs),
    player: {
      x: +p.x.toFixed(4),
      z: +p.z.toFixed(4),
      yaw: +p.yaw.toFixed(4),
      pitch: +p.pitch.toFixed(4),
    },
    obstacleCount: world.obstacles.length,
  };
}
