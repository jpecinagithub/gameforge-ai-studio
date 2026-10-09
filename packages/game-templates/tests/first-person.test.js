import { describe, it, expect } from 'vitest';
import { createWorld, stepWorld, getState, ARENA_HALF } from '../first-person/src/world.js';

const DT = 16.666;

describe('first-person world', () => {
  it('is deterministic: same seed + same inputs → identical state', () => {
    const a = createWorld(1234);
    const b = createWorld(1234);
    const inputs = [
      { forward: true },
      { forward: true, right: true, lookDX: 0.05 },
      { lookDY: -0.1 },
      {},
    ];
    for (let i = 0; i < 60; i++) {
      stepWorld(a, DT, inputs[i % inputs.length]);
      stepWorld(b, DT, inputs[i % inputs.length]);
    }
    expect(getState(a)).toEqual(getState(b));
  });

  it('different seeds → different obstacle layouts', () => {
    const a = createWorld(11);
    const b = createWorld(22);
    expect(a.obstacles).not.toEqual(b.obstacles);
  });

  it('state() is JSON-serializable', () => {
    const w = createWorld(5);
    stepWorld(w, DT, { forward: true, lookDX: 0.2 });
    const s = getState(w);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('moves forward and respects wall bounds', () => {
    const w = createWorld(3);
    const z0 = w.player.z;
    for (let i = 0; i < 600; i++) stepWorld(w, DT, { forward: true });
    const s = getState(w);
    expect(s.player.z).toBeLessThan(z0); // moved toward -z
    expect(Math.abs(s.player.x)).toBeLessThanOrEqual(ARENA_HALF);
    expect(Math.abs(s.player.z)).toBeLessThanOrEqual(ARENA_HALF);
  });

  it('mouse-look changes yaw/pitch deterministically', () => {
    const w = createWorld(3);
    stepWorld(w, DT, { lookDX: 0.5, lookDY: 0.2 });
    const s = getState(w);
    expect(s.player.yaw).toBeCloseTo(-0.5, 4);
    expect(s.player.pitch).toBeCloseTo(-0.2, 4);
  });
});
