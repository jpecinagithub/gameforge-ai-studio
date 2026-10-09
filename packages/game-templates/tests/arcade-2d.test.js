import { describe, it, expect } from 'vitest';
import { createWorld, stepWorld, getState, W, H } from '../arcade-2d/src/world.js';

const DT = 16.666;

describe('arcade-2d world', () => {
  it('is deterministic: same seed + same inputs → identical state', () => {
    const a = createWorld(2024);
    const b = createWorld(2024);
    for (let i = 0; i < 180; i++) {
      const input = { paddleX: W / 2 + Math.sin(i / 8) * 150 };
      stepWorld(a, DT, input);
      stepWorld(b, DT, input);
    }
    expect(getState(a)).toEqual(getState(b));
  });

  it('different seeds → different brick fields', () => {
    const a = createWorld(1);
    const b = createWorld(2);
    // row count (4..6) and/or hard-brick placement differs
    const sig = (w) => w.bricks.map((br) => br.hp).join(',');
    expect(sig(a)).not.toBe(sig(b));
  });

  it('state() is JSON-serializable', () => {
    const w = createWorld(3);
    stepWorld(w, DT, { left: true });
    const s = getState(w);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('ball destroys a brick on impact and scores', () => {
    const w = createWorld(3);
    // Single-brick scenario, aimed shot.
    w.bricks = [{ x: 200, y: 100, hp: 1, alive: true }];
    w.ball.x = 226;
    w.ball.y = 200;
    w.ball.vx = 0;
    w.ball.vy = -380;
    const score0 = w.score;
    for (let i = 0; i < 120 && w.bricks[0].alive; i++) stepWorld(w, DT, {});
    expect(w.bricks[0].alive).toBe(false);
    expect(w.score).toBe(score0 + 10);
    expect(getState(w).won).toBe(true);
  });

  it('missing the ball costs a life; losing all lives ends the game', () => {
    const w = createWorld(3);
    w.lives = 1;
    w.ball.x = W / 2;
    w.ball.y = H - 10;
    w.ball.vx = 0;
    w.ball.vy = 380; // heading down, paddle far away
    w.paddle.x = 40;
    for (let i = 0; i < 120 && !w.lost; i++) stepWorld(w, DT, {});
    expect(getState(w).lost).toBe(true);
    expect(getState(w).lives).toBe(0);
  });

  it('paddle bounce angle follows hit position', () => {
    const mk = () => {
      const w = createWorld(3);
      w.ball.x = w.paddle.x - 40; // left edge hit
      w.ball.y = H - 46 - 9;
      w.ball.vx = 0;
      w.ball.vy = 380;
      return w;
    };
    const w = mk();
    stepWorld(w, DT, {});
    expect(w.ball.vy).toBeLessThan(0); // bounced upward
    expect(w.ball.vx).toBeLessThan(0); // angled left
  });
});
