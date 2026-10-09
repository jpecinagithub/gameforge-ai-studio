// GameForge __studio contract — browser side.
// main.js calls installStudio() after building its scene; the page server /
// verification harness then drives the game through window.__studio.
//
// Contract:
//   seed(n)      — rebuild the world deterministically with seed n
//   ready()      — true once the contract is installed AND the first frame rendered
//   step(dtMs)   — advance the simulation by dtMs (harness drives this in headless;
//                  it calls stepWorld directly; the live rAF loop must be frozen first
//                  via demo('freeze') to avoid double-stepping)
//   state()      — JSON-serializable snapshot of the world
//   inspect(q)   — structural queries; q = { tag?: string } → [{ tag, position }]
//   demos()      — list of named demo states
//   demo(name)   — jump to a named demo; returns true/false
import { createWorld, stepWorld, getState } from './world.js';

let world = null;
let readyFlag = false;
let hooks = {};

export function installStudio(h) {
  hooks = h || {};
  if (!world) world = createWorld(hooks.seed ?? 1);
  window.__studio = { seed, ready, step, state, inspect, demos, demo };
  return window.__studio;
}

/** Call after the first frame renders — readiness is a fact the page reports. */
export function markReady() {
  readyFlag = true;
}

export function getWorld() {
  return world;
}

export function setWorld(w) {
  world = w;
}

function seed(n) {
  world = createWorld(n >>> 0);
  if (hooks.onSeed) hooks.onSeed(world);
}

function ready() {
  return readyFlag && world !== null;
}

function step(dtMs) {
  stepWorld(world, dtMs, {});
  if (hooks.afterStep) hooks.afterStep(world);
}

function state() {
  return getState(world);
}

function inspect(q = {}) {
  const out = [];
  if (hooks.scene) {
    hooks.scene.traverse((o) => {
      if (o.userData && o.userData.tag) {
        out.push({
          tag: o.userData.tag,
          position: [o.position.x, o.position.y, o.position.z],
        });
      }
    });
  }
  if (hooks.inspect) out.push(...hooks.inspect(world, q));
  return q.tag ? out.filter((o) => o.tag === q.tag) : out;
}

function demos() {
  return Object.keys(hooks.demos || { default: 1 });
}

function demo(name) {
  const d = (hooks.demos || {})[name];
  if (!d) return false;
  d(world);
  return true;
}
