import { describe, it, expect } from 'vitest';
import {
  createWorld,
  createSolvedWorld,
  stepWorld,
  getState,
  moveTile,
  isSolved,
} from '../puzzle/src/world.js';

describe('puzzle world', () => {
  it('is deterministic: same seed → identical shuffle', () => {
    const a = createWorld(99);
    const b = createWorld(99);
    expect(getState(a)).toEqual(getState(b));
    // and identical after identical moves
    stepWorld(a, 0, { tile: a.grid[0] });
    stepWorld(b, 0, { tile: b.grid[0] });
    expect(getState(a)).toEqual(getState(b));
  });

  it('different seeds → different shuffles, never solved', () => {
    const a = createWorld(10);
    const b = createWorld(11);
    expect(a.grid).not.toEqual(b.grid);
    expect(a.solved).toBe(false);
    expect(b.solved).toBe(false);
    // still a permutation of 0..15
    expect([...a.grid].sort((x, y) => x - y)).toEqual(
      Array.from({ length: 16 }, (_, i) => i),
    );
  });

  it('state() is JSON-serializable', () => {
    const w = createWorld(12);
    const s = getState(w);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('solved is reachable: 1-move-away board solves in one move', () => {
    const w = createSolvedWorld();
    expect(w.solved).toBe(true);
    // Move tile 15 (index 14) into the empty cell (index 15): board unsolved.
    expect(moveTile(w, 15)).toBe(true);
    expect(w.solved).toBe(false);
    expect(w.moves).toBe(1);
    // Move it back: solved again.
    expect(moveTile(w, 15)).toBe(true);
    expect(getState(w).solved).toBe(true);
    expect(getState(w).moves).toBe(2);
  });

  it('illegal moves are rejected', () => {
    const w = createSolvedWorld();
    // Empty at index 15; tile 1 (index 0) is not adjacent.
    expect(moveTile(w, 1)).toBe(false);
    expect(w.moves).toBe(0);
    expect(w.solved).toBe(true);
  });

  it('isSolved agrees with the solved grid', () => {
    expect(isSolved(createSolvedWorld().grid)).toBe(true);
    expect(isSolved(createWorld(13).grid)).toBe(false);
  });
});
