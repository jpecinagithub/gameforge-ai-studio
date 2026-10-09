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

export const TRACK_HALF_WIDTH = 6;
const ACCEL = 22;
const BRAKE = 40;
const DRAG = 0.55; // per second, proportional
const MAX_SPEED = 42;
const OFFTRACK_DRAG = 2.2;

// Pure world: no three.js, no DOM. Importable in Node for tests.
export function createWorld(seed = 1) {
  const rand = mulberry32(seed);
  // Loop track: perturbed oval, N control points.
  const N = 12;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const rx = 55 + (rand() * 2 - 1) * 14;
    const rz = 38 + (rand() * 2 - 1) * 10;
    pts.push({ x: Math.cos(a) * rx, z: Math.sin(a) * rz });
  }
  // Arclength table for constant-speed param.
  const samples = [];
  let total = 0;
  const SEG = 24; // subdivisions per control segment
  let prev = null;
  for (let i = 0; i < N; i++) {
    const p0 = pts[(i - 1 + N) % N];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % N];
    const p3 = pts[(i + 2) % N];
    for (let j = 0; j < SEG; j++) {
      const t = j / SEG;
      const p = catmullRom(p0, p1, p2, p3, t);
      if (prev) total += Math.hypot(p.x - prev.x, p.z - prev.z);
      samples.push({ x: p.x, z: p.z, s: total });
      prev = p;
    }
  }
  const length = total;
  return {
    seed: seed >>> 0,
    paused: false,
    timeMs: 0,
    track: { points: pts, samples, length },
    car: {
      s: 0, // arclength along centerline
      lat: 0, // lateral offset (+ = left of direction)
      speed: 0,
      lap: 1,
      checkpoint: false, // crossed halfway marker
      lapStartMs: 0,
      lastLapMs: null,
      bestLapMs: null,
      offTrack: false,
    },
  };
}

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x:
      0.5 *
      (2 * p1.x +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    z:
      0.5 *
      (2 * p1.z +
        (-p0.z + p2.z) * t +
        (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 +
        (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
  };
}

/** Interpolated track frame at arclength s. Pure helper for rendering + tests. */
export function trackPointAt(world, s) {
  const { samples, length } = world.track;
  const sm = ((s % length) + length) % length;
  // binary search
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].s < sm) lo = mid + 1;
    else hi = mid;
  }
  const i1 = lo % samples.length;
  const i0 = (lo - 1 + samples.length) % samples.length;
  const a = samples[i0];
  const b = samples[i1];
  const span = b.s - a.s || 1;
  const t = Math.max(0, Math.min(1, (sm - a.s) / span));
  const x = a.x + (b.x - a.x) * t;
  const z = a.z + (b.z - a.z) * t;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  return { x, z, dirX: dx / len, dirZ: dz / len, angle: Math.atan2(dx, dz) };
}

// input: { throttle: 0..1, brake: 0..1, steer: -1..1 }
export function stepWorld(world, dtMs, input = {}) {
  const dt = Math.max(0, dtMs) / 1000;
  world.timeMs += Math.max(0, dtMs);
  const car = world.car;
  const { length } = world.track;

  const throttle = Math.max(0, Math.min(1, input.throttle ?? 0));
  const brake = Math.max(0, Math.min(1, input.brake ?? 0));
  const steer = Math.max(-1, Math.min(1, input.steer ?? 0));

  car.speed += (throttle * ACCEL - brake * BRAKE) * dt;
  car.speed -= car.speed * DRAG * dt;
  if (car.offTrack) car.speed -= car.speed * OFFTRACK_DRAG * dt;
  car.speed = Math.max(0, Math.min(MAX_SPEED, car.speed));

  const prevS = car.s;
  car.s += car.speed * dt;
  car.lat += steer * (4 + car.speed * 0.35) * dt;
  car.offTrack = Math.abs(car.lat) > TRACK_HALF_WIDTH;

  // Halfway checkpoint + lap counting
  const half = length / 2;
  if (!car.checkpoint && prevS % length < half && car.s % length >= half) {
    car.checkpoint = true;
  }
  if (car.s >= length) {
    car.s -= length;
    if (car.checkpoint && car.speed > 1) {
      const lapMs = world.timeMs - car.lapStartMs;
      car.lastLapMs = Math.round(lapMs);
      car.bestLapMs =
        car.bestLapMs === null ? car.lastLapMs : Math.min(car.bestLapMs, car.lastLapMs);
      car.lap += 1;
    }
    car.checkpoint = false;
    car.lapStartMs = world.timeMs;
  }
}

export function getState(world) {
  const car = world.car;
  const r = (v) => +v.toFixed(3);
  return {
    seed: world.seed,
    timeMs: Math.round(world.timeMs),
    lap: car.lap,
    checkpoint: car.checkpoint,
    speed: r(car.speed),
    lateral: r(car.lat),
    offTrack: car.offTrack,
    lapTimeMs: Math.round(world.timeMs - car.lapStartMs),
    lastLapMs: car.lastLapMs,
    bestLapMs: car.bestLapMs,
  };
}
