/**
 * GameForge __studio shim — injected BEFORE any game code runs.
 * Dependency-free. Never throws: every hook is guarded.
 *
 * CONTRACT (v1):
 *   window.__studio = {
 *     seed(n),            // deterministic mode: seed RNG + switch to VIRTUAL clock
 *     release(),          // back to native clock/RNG
 *     step(dtMs),         // advance one scripted tick (virtual) or delegate (native)
 *     state(),            // JSON-serializable game snapshot
 *     inspect(query),     // scene/entity queries (game-provided; fallback error object)
 *     capture(cameraTag), // hint the game to frame a camera; screenshot taken by harness
 *     ready(),            // 'loading' | 'loaded' | <game's own readiness string>
 *     errors(),           // captured page errors (ring buffer, cap 200)
 *     drawCalls(),        // counted three.js renderer.render calls since seed()
 *     mode(),             // 'virtual' | 'native'
 *   }
 *
 * If the game assigns its own richer window.__studio AFTER this shim runs (templates
 * do), the assignment is intercepted: the game's seed/step/state/inspect/capture/ready
 * take precedence and are WRAPPED with the studio instrumentation (clock, RNG,
 * error capture, draw-call counting) — never replaced.
 *
 * CLOCK MODES:
 *   'native'  — default. Real performance.now/Date.now/rAF. step(dt) delegates to the
 *               game's own step() if it has one, else no-ops.
 *   'virtual' — entered by seed(n). performance.now/Date.now/rAF are studio-owned:
 *               time advances ONLY via step(dtMs). Deterministic playthroughs.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  // ---- preserved originals -------------------------------------------------
  var realNow = performance.now.bind(performance);
  var realDateNow = Date.now;
  var realRaf = window.requestAnimationFrame
    ? window.requestAnimationFrame.bind(window)
    : null;
  var realRandom = Math.random;

  // ---- state ----------------------------------------------------------------
  var virtual = false;
  var vNow = 0; // virtual ms since seed()
  var epochBase = 0; // real Date.now() captured at seed()
  var rafQueue = []; // pending rAF callbacks in virtual mode
  var rafId = 0;
  var rngState = 0;
  var drawCount = 0;
  var renderWrapped = false;
  var loaded = false;
  var gameHooks = {}; // game's own __studio methods, when provided

  var errBuf = [];
  function pushError(kind, message, extra) {
    try {
      errBuf.push({
        kind: kind,
        message: String(message == null ? '' : message).slice(0, 2000),
        time: virtual ? vNow : realNow(),
        extra: extra || null,
      });
      if (errBuf.length > 200) errBuf.splice(0, errBuf.length - 200);
    } catch (e) { /* never throw */ }
  }

  try {
    window.addEventListener('error', function (ev) {
      pushError('error', ev.message, {
        source: ev.filename || null, lineno: ev.lineno || null, colno: ev.colno || null,
      });
    });
    window.addEventListener('unhandledrejection', function (ev) {
      var r = ev.reason;
      pushError('unhandledrejection', (r && (r.message || r)) || 'rejected', null);
    });
    window.addEventListener('load', function () { loaded = true; });
    if (document.readyState === 'complete') loaded = true;
  } catch (e) { /* never throw */ }

  // ---- seeded RNG (mulberry32) ----------------------------------------------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var rng = realRandom;

  function installVirtualClock() {
    try {
      performance.now = function () { return vNow; };
      Date.now = function () { return epochBase + Math.floor(vNow); };
      window.requestAnimationFrame = function (cb) {
        rafQueue.push(cb);
        rafId += 1;
        return rafId;
      };
    } catch (e) { /* never throw */ }
  }
  function restoreNativeClock() {
    try {
      performance.now = realNow;
      Date.now = realDateNow;
      if (realRaf) window.requestAnimationFrame = realRaf;
      Math.random = realRandom;
    } catch (e) { /* never throw */ }
  }
  function flushRaf() {
    var q = rafQueue; rafQueue = [];
    for (var i = 0; i < q.length; i++) {
      try { q[i](vNow); } catch (e) { pushError('raf', e && e.message, null); }
    }
  }

  // ---- draw-call counting (best effort) --------------------------------------
  function findRenderer() {
    try {
      if (window.__threeRenderer && typeof window.__threeRenderer.render === 'function') {
        return window.__threeRenderer;
      }
      var keys = Object.keys(window);
      for (var i = 0; i < keys.length; i++) {
        var v = window[keys[i]];
        if (v && typeof v.render === 'function' && v.info && v.info.render &&
            typeof v.info.render.calls === 'number') {
          return v;
        }
      }
    } catch (e) { /* never throw */ }
    return null;
  }
  function wrapRenderer() {
    if (renderWrapped) return;
    try {
      var r = findRenderer();
      if (!r) return;
      var orig = r.render.bind(r);
      r.render = function () {
        drawCount += 1;
        return orig.apply(null, arguments);
      };
      renderWrapped = true;
    } catch (e) { /* never throw */ }
  }

  // ---- facade -----------------------------------------------------------------
  function doSeed(n) {
    try {
      virtual = true; vNow = 0; rafQueue = []; drawCount = 0;
      epochBase = realDateNow();
      rngState = (Number(n) || 0) >>> 0;
      rng = mulberry32(rngState);
      Math.random = function () { return rng(); };
      installVirtualClock();
      wrapRenderer();
    } catch (e) { /* never throw */ }
  }
  function doRelease() {
    try { virtual = false; restoreNativeClock(); } catch (e) { /* never throw */ }
  }

  var facade = {
    seed: function (n) {
      doSeed(n);
      try { if (typeof gameHooks.seed === 'function') return gameHooks.seed(n); } catch (e) { pushError('seed', e && e.message, null); }
      return true;
    },
    release: function () {
      doRelease();
      try { if (typeof gameHooks.release === 'function') return gameHooks.release(); } catch (e) { /* ignore */ }
      return true;
    },
    step: function (dtMs) {
      var dt = Number(dtMs) || 16.666;
      try {
        if (virtual) {
          if (typeof gameHooks.step === 'function') gameHooks.step(dt);
          vNow += dt;
          flushRaf();
          if (!renderWrapped) wrapRenderer(); // renderer may appear after boot
        } else if (typeof gameHooks.step === 'function') {
          gameHooks.step(dt);
        }
      } catch (e) { pushError('step', e && e.message, null); }
      return facade.state();
    },
    state: function () {
      try {
        if (typeof gameHooks.state === 'function') return gameHooks.state();
      } catch (e) { pushError('state', e && e.message, null); }
      return { t: virtual ? vNow : realNow(), mode: virtual ? 'virtual' : 'native' };
    },
    inspect: function (query) {
      try {
        if (typeof gameHooks.inspect === 'function') return gameHooks.inspect(query);
      } catch (e) { pushError('inspect', e && e.message, null); }
      return { error: 'no inspect() provided by game' };
    },
    capture: function (cameraTag) {
      try {
        if (typeof gameHooks.capture === 'function') return gameHooks.capture(cameraTag);
      } catch (e) { pushError('capture', e && e.message, null); }
      return true; // ack: harness takes the screenshot itself
    },
    ready: function () {
      try {
        if (typeof gameHooks.ready === 'function') return gameHooks.ready();
      } catch (e) { /* never throw */ }
      return loaded ? 'loaded' : 'loading';
    },
    errors: function () { return errBuf.slice(); },
    drawCalls: function () { return drawCount; },
    mode: function () { return virtual ? 'virtual' : 'native'; },
  };

  // Intercept later assignments: wrap, don't replace.
  var current = window.__studio;
  try {
    Object.defineProperty(window, '__studio', {
      configurable: true,
      enumerable: true,
      get: function () { return facade; },
      set: function (gameObj) {
        try {
          if (gameObj && typeof gameObj === 'object') {
            ['seed', 'step', 'state', 'inspect', 'capture', 'ready', 'release'].forEach(function (k) {
              if (typeof gameObj[k] === 'function') gameHooks[k] = gameObj[k].bind(gameObj);
            });
          }
        } catch (e) { /* never throw */ }
      },
    });
    if (current && typeof current === 'object') window.__studio = current; // re-wrap pre-existing
  } catch (e) {
    // defineProperty failed (frozen window?): fall back to plain assignment.
    try { window.__studio = facade; } catch (e2) { /* never throw */ }
  }
})();
