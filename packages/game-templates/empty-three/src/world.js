// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32). World logic MUST use this — never Math.random,
// so createWorld(seed) is reproducible for seeded verification playthroughs.
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

// Pure world: no three.js, no DOM. Importable in Node for tests.
export function createWorld(seed = 1) {
  const rand = mulberry32(seed);
  return {
    seed: seed >>> 0,
    paused: false,
    timeMs: 0,
    cube: { angle: rand() * Math.PI * 2, spinSpeed: 0.8 },
  };
}

export function stepWorld(world, dtMs, _input = {}) {
  const dt = Math.max(0, dtMs) / 1000;
  world.timeMs += Math.max(0, dtMs);
  world.cube.angle = (world.cube.angle + dt * world.cube.spinSpeed) % (Math.PI * 2);
}

export function getState(world) {
  return {
    seed: world.seed,
    timeMs: Math.round(world.timeMs),
    cubeAngle: world.cube.angle,
    objectCount: 3, // grid + axes + cube
  };
}
