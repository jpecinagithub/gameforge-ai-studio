import { describe, it, expect } from 'vitest';
import { createWorld, stepWorld, getState } from '../third-person/src/world.js';

const DT = 16.666;

describe('third-person world', () => {
  it('is deterministic: same seed + same inputs → identical state', () => {
    const mk = () => createWorld(777);
    const a = mk();
    const b = mk();
    const inputs = [{ forward: true }, { forward: true, jump: true }, { right: true }, {}];
    for (let i = 0; i < 90; i++) {
      stepWorld(a, DT, inputs[i % inputs.length]);
      stepWorld(b, DT, inputs[i % inputs.length]);
    }
    expect(getState(a)).toEqual(getState(b));
  });

  it('different seeds → different platform layouts', () => {
    const a = createWorld(100);
    const b = createWorld(200);
    expect(a.platforms).not.toEqual(b.platforms);
    expect(a.platforms.length).toBe(b.platforms.length); // same count, different places
  });

  it('state() is JSON-serializable', () => {
    const w = createWorld(9);
    for (let i = 0; i < 30; i++) stepWorld(w, DT, { forward: true, jump: i === 5 });
    const s = getState(w);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('jump leaves the ground and lands back', () => {
    const w = createWorld(9);
    expect(w.player.onGround).toBe(true);
    expect(w.player.y).toBe(0); // feet on the ground top
    stepWorld(w, DT, { jump: true });
    expect(w.player.onGround).toBe(false);
    expect(w.player.y).toBeGreaterThan(0);
    for (let i = 0; i < 300; i++) stepWorld(w, DT, {});
    expect(w.player.onGround).toBe(true);
    expect(w.player.y).toBeCloseTo(0, 2);
  });

  it('player never falls through the world', () => {
    const w = createWorld(9);
    w.player.x = 500; // far off any platform
    w.player.y = 50;
    for (let i = 0; i < 600; i++) stepWorld(w, DT, {});
    expect(w.player.y).toBeGreaterThan(-30);
  });
});
