import { describe, it, expect } from 'vitest';
import { createWorld, stepWorld, getState } from '../platformer-3d/src/world.js';

const DT = 16.666;

describe('platformer-3d world', () => {
  it('is deterministic: same seed + same inputs → identical state', () => {
    const a = createWorld(31337);
    const b = createWorld(31337);
    const inputs = [{ right: true }, { right: true, jump: true }, { left: true }, {}];
    for (let i = 0; i < 120; i++) {
      stepWorld(a, DT, inputs[i % inputs.length]);
      stepWorld(b, DT, inputs[i % inputs.length]);
    }
    expect(getState(a)).toEqual(getState(b));
  });

  it('different seeds → different levels', () => {
    const a = createWorld(4);
    const b = createWorld(5);
    expect(a.platforms).not.toEqual(b.platforms);
    expect(a.coins).not.toEqual(b.coins);
  });

  it('state() is JSON-serializable', () => {
    const w = createWorld(6);
    for (let i = 0; i < 30; i++) stepWorld(w, DT, { right: true });
    const s = getState(w);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('win is reachable: collect all coins by scripted teleport, then touch goal', () => {
    const w = createWorld(6);
    // Scripted playthrough: teleport the player onto each coin, then to the goal.
    for (const c of w.coins) {
      w.player.x = c.x;
      w.player.y = c.y - 0.9;
      w.player.vy = 0;
      stepWorld(w, DT, {});
    }
    expect(w.coinsTaken).toBe(w.coins.length);
    w.player.x = w.goal.x;
    w.player.y = w.goal.y;
    w.player.vy = 0;
    stepWorld(w, DT, {});
    expect(getState(w).won).toBe(true);
  });

  it('goal alone does not win without all coins', () => {
    const w = createWorld(6);
    w.player.x = w.goal.x;
    w.player.y = w.goal.y;
    stepWorld(w, DT, {});
    expect(getState(w).won).toBe(false);
  });

  it('falling off the world respawns at start', () => {
    const w = createWorld(6);
    w.player.x = -500;
    w.player.y = -50;
    stepWorld(w, DT, {});
    expect(w.player.x).toBe(0);
    expect(w.player.y).toBe(0);
  });
});
