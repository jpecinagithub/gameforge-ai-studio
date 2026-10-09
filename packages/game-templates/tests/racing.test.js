import { describe, it, expect } from 'vitest';
import {
  createWorld,
  stepWorld,
  getState,
  trackPointAt,
} from '../racing/src/world.js';

const DT = 16.666;

describe('racing world', () => {
  it('is deterministic: same seed + same inputs → identical state', () => {
    const a = createWorld(555);
    const b = createWorld(555);
    for (let i = 0; i < 120; i++) {
      const input = { throttle: 1, steer: Math.sin(i / 10) * 0.5 };
      stepWorld(a, DT, input);
      stepWorld(b, DT, input);
    }
    expect(getState(a)).toEqual(getState(b));
  });

  it('different seeds → different tracks', () => {
    const a = createWorld(1);
    const b = createWorld(2);
    expect(a.track.length).not.toBe(b.track.length);
  });

  it('state() is JSON-serializable', () => {
    const w = createWorld(8);
    stepWorld(w, DT, { throttle: 1 });
    const s = getState(w);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('trackPointAt wraps around the loop', () => {
    const w = createWorld(8);
    const p0 = trackPointAt(w, 0);
    const p1 = trackPointAt(w, w.track.length);
    expect(p0.x).toBeCloseTo(p1.x, 6);
    expect(p0.z).toBeCloseTo(p1.z, 6);
  });

  it('completing a lap increments the lap counter and records a lap time', () => {
    const w = createWorld(8);
    // Teleport just before the finish line with the checkpoint armed, at speed.
    const L = w.track.length;
    w.car.s = L - 5;
    w.car.speed = 30;
    w.car.checkpoint = true;
    w.car.lapStartMs = 0;
    w.timeMs = 90000;
    const lap0 = w.car.lap;
    for (let i = 0; i < 120 && w.car.lap === lap0; i++) {
      stepWorld(w, DT, { throttle: 1 });
    }
    expect(w.car.lap).toBe(lap0 + 1);
    const s = getState(w);
    expect(s.lastLapMs).not.toBeNull();
    expect(s.bestLapMs).toBe(s.lastLapMs);
  });

  it('off-track driving is slower than on-track', () => {
    const mk = () => {
      const w = createWorld(8);
      w.car.speed = 30;
      return w;
    };
    const on = mk();
    const off = mk();
    off.car.lat = 20; // far outside the track
    for (let i = 0; i < 120; i++) {
      stepWorld(on, DT, { throttle: 1 });
      stepWorld(off, DT, { throttle: 1 });
    }
    expect(off.car.speed).toBeLessThan(on.car.speed);
    expect(getState(off).offTrack).toBe(true);
  });
});
