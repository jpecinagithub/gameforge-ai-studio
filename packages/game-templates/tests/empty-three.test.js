import { describe, it, expect } from 'vitest';
import { createWorld, stepWorld, getState } from '../empty-three/src/world.js';

describe('empty-three world', () => {
  it('is deterministic: same seed + same steps → identical state', () => {
    const a = createWorld(42);
    const b = createWorld(42);
    for (let i = 0; i < 120; i++) {
      stepWorld(a, 16.666, {});
      stepWorld(b, 16.666, {});
    }
    expect(getState(a)).toEqual(getState(b));
  });

  it('different seeds → different initial cube angle', () => {
    const a = createWorld(1);
    const b = createWorld(2);
    expect(a.cube.angle).not.toBe(b.cube.angle);
  });

  it('state() is JSON-serializable', () => {
    const w = createWorld(7);
    stepWorld(w, 100, {});
    const s = getState(w);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('cube angle advances with time', () => {
    const w = createWorld(9);
    const before = getState(w).cubeAngle;
    stepWorld(w, 1000, {});
    expect(getState(w).cubeAngle).not.toBe(before);
    expect(getState(w).timeMs).toBe(1000);
  });
});
