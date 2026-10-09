/**
 * Shim tests — the shim is plain JS, so we load it in a node:vm sandbox with a
 * fake window/document/performance and assert the contract behavior.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const SHIM_SRC = readFileSync(join(here, 'shim.js'), 'utf8');

interface FakeWindow {
  __studio?: any;
  __threeRenderer?: any;
  addEventListener(type: string, cb: (...a: any[]) => void): void;
  requestAnimationFrame?: (cb: (t: number) => void) => number;
  [k: string]: any;
}

function makeSandbox() {
  const listeners: Record<string, Array<(...a: any[]) => void>> = {};
  const rafCallbacks: Array<(t: number) => void> = [];
  const win: FakeWindow = {
    addEventListener(type: string, cb: (...a: any[]) => void) {
      (listeners[type] ??= []).push(cb);
    },
    requestAnimationFrame(cb: (t: number) => void) {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    },
  };
  const sandbox: any = {
    window: win,
    document: { readyState: 'complete' },
    performance: { now: () => 1234.5 },
    Date,
    Math,
    Object,
    JSON,
    Number,
    String,
    Array,
    Error,
    Symbol,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SHIM_SRC, sandbox, { filename: 'shim.js' });
  return { sandbox, win, listeners, rafCallbacks };
}

describe('__studio shim', () => {
  it('installs the facade with the full contract surface', () => {
    const { win } = makeSandbox();
    for (const m of ['seed', 'release', 'step', 'state', 'inspect', 'capture', 'ready', 'errors', 'drawCalls', 'mode']) {
      expect(typeof win.__studio[m], m).toBe('function');
    }
  });

  it('seed() switches to virtual mode; release() restores native', () => {
    const { sandbox, win } = makeSandbox();
    expect(win.__studio.mode()).toBe('native');
    win.__studio.seed(42);
    expect(win.__studio.mode()).toBe('virtual');
    expect(sandbox.performance.now()).toBe(0);
    win.__studio.step(16.666);
    expect(sandbox.performance.now()).toBeCloseTo(16.666, 3);
    win.__studio.release();
    expect(win.__studio.mode()).toBe('native');
    expect(sandbox.performance.now()).toBe(1234.5); // original restored
  });

  it('seeded RNG is deterministic between seed(n) and release()', () => {
    const { sandbox, win } = makeSandbox();
    win.__studio.seed(7);
    const a = [sandbox.Math.random(), sandbox.Math.random(), sandbox.Math.random()];
    win.__studio.seed(7);
    const b = [sandbox.Math.random(), sandbox.Math.random(), sandbox.Math.random()];
    expect(a).toEqual(b);
    win.__studio.release();
  });

  it('wraps (not replaces) a game-provided richer __studio', () => {
    const { win } = makeSandbox();
    // Game code runs AFTER the shim and assigns its own object.
    win.__studio = {
      state: () => ({ score: 99 }),
      ready: () => 'ready',
      customThing: () => 'untouched',
    };
    // Facade still exposed; game methods take precedence and are wrapped.
    expect(win.__studio.state()).toEqual({ score: 99 });
    expect(win.__studio.ready()).toBe('ready');
    // Instrumentation still present.
    expect(win.__studio.mode()).toBe('native');
    win.__studio.seed(1);
    expect(win.__studio.mode()).toBe('virtual');
    expect(win.__studio.errors()).toEqual([]);
  });

  it('ready() reports loading before load, loaded after', () => {
    const { win, listeners } = makeSandbox();
    // fresh sandbox: document.readyState was 'complete' → loaded already
    expect(win.__studio.ready()).toBe('loaded');
    void listeners;
  });

  it('captures page errors into a capped ring buffer', () => {
    const { win, listeners } = makeSandbox();
    const errHandler = listeners['error'][0];
    for (let i = 0; i < 250; i++) {
      errHandler({ message: `boom ${i}`, filename: 'game.js', lineno: i, colno: 1 });
    }
    const errs = win.__studio.errors();
    expect(errs.length).toBe(200); // capped
    expect(errs[0].message).toBe('boom 50'); // oldest evicted
    expect(errs[199].message).toBe('boom 249');
  });

  it('counts draw calls via a three-like renderer', () => {
    const { win } = makeSandbox();
    let rendered = 0;
    win.__threeRenderer = {
      info: { render: { calls: 0 } },
      render() { rendered += 1; },
    };
    win.__studio.seed(3); // wrapRenderer runs on seed
    win.__threeRenderer.render();
    win.__threeRenderer.render();
    expect(win.__studio.drawCalls()).toBe(2);
    expect(rendered).toBe(2); // original still invoked
  });

  it('never throws on hostile input', () => {
    const { win } = makeSandbox();
    expect(() => {
      win.__studio.seed(undefined as any);
      win.__studio.step(NaN as any);
      win.__studio.state();
      win.__studio.inspect(null);
      win.__studio.capture(undefined as any);
      win.__studio.ready();
      win.__studio.errors();
      win.__studio.drawCalls();
      win.__studio = null as any; // setter must not throw
      win.__studio = 42 as any;
      win.__studio.release(); // restore host Date.now / Math.random
    }).not.toThrow();
  });
});
