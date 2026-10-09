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

const GRAVITY = -22;
const JUMP_VEL = 8.5;
const SPEED = 7;
const PLAYER_HALF = 0.45;
const PLAYER_HEIGHT = 1.7;

// Pure world: no three.js, no DOM. Importable in Node for tests.
export function createWorld(seed = 1) {
  const rand = mulberry32(seed);
  const platforms = [
    // ground
    { x: 0, y: -1, z: 0, w: 60, h: 2, d: 60 },
  ];
  // Ascending stepping platforms
  let px = 0;
  let py = 0.5;
  for (let i = 0; i < 7; i++) {
    px += 4 + rand() * 3;
    py += 1.2 + rand() * 0.8;
    const pz = (rand() * 2 - 1) * 8;
    platforms.push({ x: px, y: py, z: pz, w: 3, h: 0.6, d: 3 });
  }
  return {
    seed: seed >>> 0,
    paused: false,
    timeMs: 0,
    // p.y is the FEET. Ground top is y=0, so spawn feet at 0.
    player: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, onGround: true, yaw: 0 },
    platforms,
  };
}

// input: { forward, back, left, right: bool, jump: bool }
export function stepWorld(world, dtMs, input = {}) {
  const dt = Math.max(0, dtMs) / 1000;
  world.timeMs += Math.max(0, dtMs);
  const p = world.player;

  const mx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const mz = (input.back ? 1 : 0) - (input.forward ? 1 : 0);
  p.vx = mx * SPEED;
  p.vz = mz * SPEED;
  if (mx !== 0 || mz !== 0) p.yaw = Math.atan2(mx, mz);

  if (input.jump && p.onGround) {
    p.vy = JUMP_VEL;
    p.onGround = false;
  }
  p.vy += GRAVITY * dt;

  p.x += p.vx * dt;
  p.z += p.vz * dt;
  p.y += p.vy * dt;

  // AABB collision vs platforms. Player box: min=(x-hw, y, z-hw),
  // max=(x+hw, y+HEIGHT, z+hw) — p.y is the FEET.
  p.onGround = false;
  const hw = PLAYER_HALF;
  for (const pl of world.platforms) {
    const minX = p.x - hw, maxX = p.x + hw;
    const minY = p.y, maxY = p.y + PLAYER_HEIGHT;
    const minZ = p.z - hw, maxZ = p.z + hw;
    const qminX = pl.x - pl.w / 2, qmaxX = pl.x + pl.w / 2;
    const qminY = pl.y - pl.h / 2, qmaxY = pl.y + pl.h / 2;
    const qminZ = pl.z - pl.d / 2, qmaxZ = pl.z + pl.d / 2;
    if (maxX > qminX && minX < qmaxX && maxY > qminY && minY < qmaxY && maxZ > qminZ && minZ < qmaxZ) {
      // Penetration depths
      const dx1 = qmaxX - minX, dx2 = maxX - qminX;
      const dy1 = qmaxY - minY, dy2 = maxY - qminY;
      const dz1 = qmaxZ - minZ, dz2 = maxZ - qminZ;
      const m = Math.min(dx1, dx2, dy1, dy2, dz1, dz2);
      if (m === dy1 && p.vy <= 0) {
        // landed on top: feet rest on the platform surface
        p.y = qmaxY;
        p.vy = 0;
        p.onGround = true;
      } else if (m === dy2) {
        // head bump: head stops at the platform underside
        p.y = qminY - PLAYER_HEIGHT;
        p.vy = Math.min(0, p.vy);
      } else if (m === dx1) p.x = qmaxX + hw;
      else if (m === dx2) p.x = qminX - hw;
      else if (m === dz1) p.z = qmaxZ + hw;
      else p.z = qminZ - hw;
    }
  }
  // Safety net: never fall through the world
  if (p.y < -30) {
    p.x = 0; p.y = 0; p.z = 0; p.vx = p.vy = p.vz = 0;
  }
}

export function getState(world) {
  const p = world.player;
  const r = (v) => +v.toFixed(4);
  return {
    seed: world.seed,
    timeMs: Math.round(world.timeMs),
    player: { x: r(p.x), y: r(p.y), z: r(p.z), onGround: p.onGround, yaw: r(p.yaw) },
    platformCount: world.platforms.length,
  };
}
