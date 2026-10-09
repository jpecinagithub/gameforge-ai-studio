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

// ---------------------------------------------------------------------------
// Inline rigid-body physics (AABB boxes only, ~150 lines).
// Upgrade path: replace this module with Rapier (Phase 6) behind the same
// body interface { id, x,y,z, vx,vy,vz, hx,hy,hz, static }.
// ---------------------------------------------------------------------------
const GRAVITY = -22;
const RESTITUTION = 0.2;
const FRICTION_MU = 0.6; // Coulomb friction coefficient for tangential impulse
const SLOP = 0.001;
const SUBSTEPS = 4;

export function makeBody(world, x, y, z, hx, hy, hz, opts = {}) {
  return {
    id: world.nextBodyId++,
    x, y, z,
    vx: 0, vy: 0, vz: 0,
    hx, hy, hz,
    mass: opts.mass ?? 1,
    isStatic: !!opts.static,
  };
}

export function spawnBox(world, x, y, z, size = 1) {
  const b = makeBody(world, x, y, z, size / 2, size / 2, size / 2);
  // cap bodies so a runaway script can't exhaust memory
  if (world.bodies.length < 120) world.bodies.push(b);
  return b;
}

function collide(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const ox = a.hx + b.hx - Math.abs(dx);
  if (ox <= 0) return;
  const oy = a.hy + b.hy - Math.abs(dy);
  if (oy <= 0) return;
  const oz = a.hz + b.hz - Math.abs(dz);
  if (oz <= 0) return;

  // Resolve along the minimum-penetration axis
  let nx = 0, ny = 0, nz = 0, pen = 0;
  if (ox < oy && ox < oz) { nx = dx > 0 ? 1 : -1; pen = ox; }
  else if (oy < oz) { ny = dy > 0 ? 1 : -1; pen = oy; }
  else { nz = dz > 0 ? 1 : -1; pen = oz; }

  const ima = a.isStatic ? 0 : 1 / a.mass;
  const imb = b.isStatic ? 0 : 1 / b.mass;
  const imSum = ima + imb;
  if (imSum === 0) return;

  // Positional correction (split by inverse mass)
  const corr = Math.max(pen - SLOP, 0) / imSum;
  a.x -= nx * corr * ima; a.y -= ny * corr * ima; a.z -= nz * corr * ima;
  b.x += nx * corr * imb; b.y += ny * corr * imb; b.z += nz * corr * imb;

  // Impulse along the contact normal
  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const rvz = b.vz - a.vz;
  const vn = rvx * nx + rvy * ny + rvz * nz;
  if (vn < 0) {
    const j = (-(1 + RESTITUTION) * vn) / imSum;
    a.vx -= j * nx * ima; a.vy -= j * ny * ima; a.vz -= j * nz * ima;
    b.vx += j * nx * imb; b.vy += j * ny * imb; b.vz += j * nz * imb;
    // Friction (Coulomb-lite): tangential impulse clamped to mu * j
    const tx = rvx - vn * nx;
    const ty = rvy - vn * ny;
    const tz = rvz - vn * nz;
    const vt = Math.hypot(tx, ty, tz);
    if (vt > 1e-6) {
      const jt = Math.min(FRICTION_MU * j, vt / imSum);
      const fx = tx / vt, fy = ty / vt, fz = tz / vt;
      a.vx += jt * fx * ima; a.vy += jt * fy * ima; a.vz += jt * fz * ima;
      b.vx -= jt * fx * imb; b.vy -= jt * fy * imb; b.vz -= jt * fz * imb;
    }
  }
}

function physicsStep(world, dt) {
  for (const b of world.bodies) {
    if (b.isStatic) continue;
    b.vy += GRAVITY * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.z += b.vz * dt;
  }
  const bodies = world.bodies;
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      collide(bodies[i], bodies[j]);
    }
  }
}

// Pure world: no three.js, no DOM. Importable in Node for tests.
export function createWorld(seed = 1) {
  const rand = mulberry32(seed);
  const world = {
    seed: seed >>> 0,
    paused: false,
    timeMs: 0,
    bodies: [],
    nextBodyId: 1, // per-world id counter: identical seeds → identical ids
  };
  // Static ground: top surface at y = 0
  world.bodies.push(makeBody(world, 0, -5, 0, 30, 5, 30, { static: true }));
  // A few falling boxes with seeded x/z offsets
  for (let i = 0; i < 5; i++) {
    const s = 0.8 + rand() * 0.8;
    spawnBox(world, (rand() * 2 - 1) * 4, 4 + i * 2.2, (rand() * 2 - 1) * 4, s);
  }
  return world;
}

// input unused (interaction is click-to-spawn via the harness API spawnAt)
export function stepWorld(world, dtMs, _input = {}) {
  const dt = Math.max(0, dtMs) / 1000;
  world.timeMs += Math.max(0, dtMs);
  const sub = dt / SUBSTEPS;
  for (let i = 0; i < SUBSTEPS; i++) physicsStep(world, sub);
}

export function getState(world) {
  const r = (v) => +v.toFixed(4);
  return {
    seed: world.seed,
    timeMs: Math.round(world.timeMs),
    bodyCount: world.bodies.length,
    settled: world.bodies.every(
      (b) => b.isStatic || Math.hypot(b.vx, b.vy, b.vz) < 0.08,
    ),
    bodies: world.bodies.map((b) => ({
      id: b.id,
      x: r(b.x), y: r(b.y), z: r(b.z),
      vx: r(b.vx), vy: r(b.vy), vz: r(b.vz),
    })),
  };
}
