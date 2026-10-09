import { describe, it, expect } from 'vitest';
import {
  createWorld,
  stepWorld,
  getState,
  spawnBox,
} from '../physics-sandbox/src/world.js';

const DT = 16.666;

describe('physics-sandbox world', () => {
  it('is deterministic: same seed + same spawns → identical state', () => {
    const a = createWorld(64);
    const b = createWorld(64);
    for (let i = 0; i < 60; i++) {
      if (i === 30) {
        spawnBox(a, 1, 10, 0, 1);
        spawnBox(b, 1, 10, 0, 1);
      }
      stepWorld(a, DT, {});
      stepWorld(b, DT, {});
    }
    expect(getState(a)).toEqual(getState(b));
  });

  it('different seeds → different initial box placements', () => {
    const a = createWorld(1);
    const b = createWorld(2);
    const sig = (w) => w.bodies.filter((x) => !x.isStatic).map((x) => x.x);
    expect(sig(a)).not.toEqual(sig(b));
  });

  it('state() is JSON-serializable', () => {
    const w = createWorld(5);
    stepWorld(w, DT, {});
    const s = getState(w);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('boxes fall under gravity', () => {
    const w = createWorld(5);
    const y0 = Math.max(...w.bodies.filter((b) => !b.isStatic).map((b) => b.y));
    for (let i = 0; i < 60; i++) stepWorld(w, DT, {});
    const y1 = Math.max(...w.bodies.filter((b) => !b.isStatic).map((b) => b.y));
    expect(y1).toBeLessThan(y0);
  });

  it('boxes land on the ground and settle (no sinking through)', () => {
    const w = createWorld(5);
    for (let i = 0; i < 600; i++) stepWorld(w, DT, {});
    for (const b of w.bodies) {
      if (b.isStatic) continue;
      // ground top is y=0; box bottom must not sink below it (allow slop)
      expect(b.y - b.hy).toBeGreaterThan(-0.05);
    }
    expect(getState(w).settled).toBe(true);
  });

  it('spawnBox adds a body and respects the cap', () => {
    const w = createWorld(5);
    const n0 = w.bodies.length;
    spawnBox(w, 0, 20, 0, 1);
    expect(w.bodies.length).toBe(n0 + 1);
    for (let i = 0; i < 200; i++) spawnBox(w, 0, 20 + i, 0, 1);
    expect(w.bodies.length).toBeLessThanOrEqual(120);
  });
});
