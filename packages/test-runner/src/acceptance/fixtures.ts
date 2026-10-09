/**
 * Shared fixtures for the acceptance scenarios.
 *
 * - `memoryStore()`: in-memory BuildStore (same contract the pg
 *   implementation satisfies in the worker).
 * - `localRunner()`: a RunnerLike that executes nothing — it records
 *   every call and returns success unless configured to fail/throw.
 *   Used where container execution is genuinely unavailable (no Docker
 *   in this VM); every scenario that relies on it says so.
 * - `stubBrowser()`: a faithful in-process BrowserLike implementing the
 *   page contract the pipeline uses: __studio.ready/state/step/seed,
 *   screenshots as real PNGs, console/request-failure capture hooks.
 *   It is NOT a browser and every scenario labels it as such.
 * - Filesystem helpers: temp dirs, template copies, real git repos.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import type {
  BrowserLike,
  BrowserPageLike,
  BuildStore,
  RunnerLike,
} from '../pipeline.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/* In-memory build store                                                */
/* ------------------------------------------------------------------ */

export interface MemoryStore extends BuildStore {
  jobs: Array<Record<string, unknown>>;
  tests: Array<Record<string, unknown>>;
  reviews: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
}

export function memoryStore(): MemoryStore {
  const s: MemoryStore = {
    jobs: [],
    tests: [],
    reviews: [],
    artifacts: [],
    saveBuildJob: async (r) => {
      s.jobs.push(r as unknown as Record<string, unknown>);
    },
    saveTestResult: async (id, r) => {
      s.tests.push({ buildId: id, ...r });
    },
    saveReviewResult: async (id, r) => {
      s.reviews.push({ buildId: id, ...r });
    },
    saveArtifact: async (id, a) => {
      s.artifacts.push({ buildId: id, ...a });
      return `art_${s.artifacts.length}`;
    },
  };
  return s;
}

/* ------------------------------------------------------------------ */
/* Local runner (no Docker)                                             */
/* ------------------------------------------------------------------ */

export interface LocalRunnerOptions {
  /** Capability whose exec returns a failure result (diagnostic error). */
  failCapability?: 'install' | 'build' | 'test' | 'typecheck';
  /** Capability whose exec THROWS (simulates a crashed worker). */
  throwCapability?: 'install' | 'build' | 'test' | 'typecheck';
  stderr?: string;
}

export interface LocalRunner extends RunnerLike {
  calls: Array<{ capability: string; command: string[] }>;
}

/**
 * Records every exec call; executes nothing. Honest about what it is:
 * in this VM there is no container runtime, so phases that need one
 * (install/typecheck/unit/bundle on templates with package.json) would
 * use it in production. Our template fixtures have no package.json, so
 * those phases skip before the runner is ever called.
 */
export function localRunner(opts: LocalRunnerOptions = {}): LocalRunner {
  const calls: Array<{ capability: string; command: string[] }> = [];
  return {
    calls,
    exec: async (o) => {
      calls.push({ capability: o.capability, command: o.command });
      if (opts.throwCapability === o.capability) {
        throw new Error('SIMULATED WORKER CRASH: SIGKILL');
      }
      if (opts.failCapability === o.capability) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: opts.stderr ?? 'SYNTHETIC FAILURE',
          timedOut: false,
        };
      }
      return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Faithful in-process browser stub                                     */
/* ------------------------------------------------------------------ */

/**
 * Implements the BrowserPageLike contract with real __studio semantics:
 * seed() enters virtual mode, step(dt) advances a tick counter, state()
 * returns JSON that changes across steps, screenshots are real PNGs
 * (non-blank), console/request hooks are honored. It cannot execute
 * real page JavaScript — it is a stub, and scenarios must label it so.
 */
function stubPage(): BrowserPageLike & { gotoUrl: string | null } {
  let tick = 0;
  let seed = 0;
  const holder: { gotoUrl: string | null } = { gotoUrl: null };
  const consoleCbs: Array<(type: string, text: string) => void> = [];
  const failedCbs: Array<(url: string, failure: string) => void> = [];
  const page: BrowserPageLike & { gotoUrl: string | null } = {
    get gotoUrl() {
      return holder.gotoUrl;
    },
    goto: async (url: string) => {
      holder.gotoUrl = url;
    },
    evaluate: (async <T>(expr: string): Promise<T> => {
      if (expr.includes('Boolean(window.__studio)')) return true as T;
      if (expr.includes('__studio.ready')) return true as T;
      const seedM = /__studio\.seed\((\d+)\)/.exec(expr);
      if (seedM) {
        seed = Number(seedM[1]);
        tick = 0;
        return null as T;
      }
      if (expr.includes('__studio.step')) {
        tick += 1;
        return null as T;
      }
      if (expr.includes('__studio.state')) {
        return JSON.stringify({ tick, seed, player: { x: tick * 2 } }) as T;
      }
      if (expr.includes('__studio.capture')) return null as T;
      if (expr.includes('__studio.errors')) return [] as T;
      if (expr.includes('__studio.drawCalls')) return 42 as T;
      return null as T;
    }) as BrowserPageLike['evaluate'],
    screenshot: async () => makePng(64, 64, 200),
    keyboard: {
      press: async () => {},
      down: async () => {},
      up: async () => {},
    },
    waitForFunction: async () => {},
    onConsole: (cb) => {
      consoleCbs.push(cb);
    },
    onRequestFailed: (cb) => {
      failedCbs.push(cb);
    },
    isClosed: () => false,
  };
  void consoleCbs;
  void failedCbs;
  return page;
}

export function stubBrowser(): BrowserLike {
  return {
    newPage: async () => stubPage(),
    close: async () => {},
  };
}

/* ------------------------------------------------------------------ */
/* Real Chromium adapter (playwright-core)                              */
/* ------------------------------------------------------------------ */

const CHROME_CANDIDATES = [
  process.env.GF_CHROME_PATH,
  `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
].filter(Boolean) as string[];

export function chromeBinaryPath(): string | null {
  for (const p of CHROME_CANDIDATES) {
    try {
      if (existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export interface AcquiredBrowser {
  browser: BrowserLike;
  /** True when this is a real Chromium (not the stub). */
  real: boolean;
  describe(): string;
}

function toBrowserPageLike(pwPage: import('playwright-core').Page): BrowserPageLike {
  return {
    goto: (url) => pwPage.goto(url).then(() => {}),
    evaluate: <T>(expr: string) => pwPage.evaluate(expr) as Promise<T>,
    screenshot: () => pwPage.screenshot().then((b) => Buffer.from(b)),
    keyboard: pwPage.keyboard,
    waitForFunction: (expr, timeoutMs) =>
      pwPage.waitForFunction(expr, null, { timeout: timeoutMs }).then(() => {}),
    onConsole: (cb) =>
      pwPage.on('console', (msg) => cb(msg.type(), msg.text())),
    onRequestFailed: (cb) =>
      pwPage.on('requestfailed', (req) =>
        cb(req.url(), req.failure()?.errorText ?? 'requestfailed'),
      ),
    isClosed: () => pwPage.isClosed(),
  };
}

/**
 * Prefer a REAL Chromium (headless, software WebGL). Falls back to the
 * faithful in-process stub when no browser binary is available — and
 * says so, so scenarios can cap their outcome at `partial` honestly.
 */
export async function acquireBrowser(): Promise<AcquiredBrowser> {
  const exe = chromeBinaryPath();
  if (exe) {
    try {
      const { chromium } = await import('playwright-core');
      const pwBrowser = await chromium.launch({
        executablePath: exe,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
      });
      const browser: BrowserLike = {
        newPage: async () => toBrowserPageLike(await pwBrowser.newPage()),
        close: async () => {
          await pwBrowser.close();
        },
      };
      return {
        browser,
        real: true,
        describe: () => `real Chromium (${exe})`,
      };
    } catch {
      /* fall through to the stub */
    }
  }
  return {
    browser: stubBrowser(),
    real: false,
    describe: () =>
      'in-process stub (no Chromium binary found — set GF_CHROME_PATH to use a real browser)',
  };
}

/* ------------------------------------------------------------------ */
/* three.js vendoring (acceptance runs)                                 */
/* ------------------------------------------------------------------ */

/**
 * Copy a locally-downloaded three.module.js into the project and rewrite
 * the import map from the CDN URL to the vendored file. The game code is
 * untouched; only the module URL changes. Labeled in every report that
 * uses it: headless Chrome in this sandbox cannot reach the CDN through
 * the egress proxy, so without vendoring the game cannot boot here at
 * all. On Oracle (direct internet), the CDN import map is used as-is.
 */
export function vendorThreeJs(projectDir: string, threeJsPath: string): void {
  const vendorDir = join(projectDir, 'vendor');
  mkdirSync(vendorDir, { recursive: true });
  const dest = join(vendorDir, 'three.module.js');
  copyFileSync(threeJsPath, dest);
  const indexPath = join(projectDir, 'index.html');
  const html = readFileSync(indexPath, 'utf8');
  const rewritten = html.replace(
    /https:\/\/cdn\.jsdelivr\.net\/npm\/three@[0-9.]+\/build\/three\.module\.js/g,
    './vendor/three.module.js',
  );
  if (rewritten === html) {
    throw new Error('no CDN import map entry found to vendor in index.html');
  }
  writeFileSync(indexPath, rewritten);
}

const THREE_VERSION = '0.170.0';

/** Download three.module.js once into a temp cache; returns the file path. */
export async function ensureThreeJs(): Promise<string> {
  const cacheDir = join(tmpdir(), 'gf-acc-vendor');
  mkdirSync(cacheDir, { recursive: true });
  const dest = join(cacheDir, `three.${THREE_VERSION}.module.js`);
  if (!existsSync(dest)) {
    execFileSync(
      'curl',
      [
        '-sS',
        '--max-time',
        '180',
        '-o',
        dest,
        `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/build/three.module.js`,
      ],
      { stdio: 'pipe' },
    );
    if (!existsSync(dest)) throw new Error('three.js download failed');
  }
  return dest;
}

export const VENDORED_THREE_NOTE =
  'three.js vendored locally for this run (headless Chrome in this sandbox ' +
  'cannot reach the jsDelivr CDN through the egress proxy); game code unchanged, ' +
  'only the import-map URL differs from the Oracle run';

/* ------------------------------------------------------------------ */
/* PNG helper                                                           */
/* ------------------------------------------------------------------ */

/** A real PNG with the given solid luma (0–255). Non-blank for luma > 0. */

/** A real PNG with the given solid luma (0–255). Non-blank for luma > 0. */
export function makePng(width: number, height: number, luma = 200): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = luma;
    png.data[i * 4 + 1] = luma;
    png.data[i * 4 + 2] = luma;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                 */
/* ------------------------------------------------------------------ */

/** Real HTTP GET against the in-process page server. */
export function httpGet(url: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
      );
      res.on('error', reject);
    }).on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* Filesystem                                                           */
/* ------------------------------------------------------------------ */

const tracked: string[] = [];

export function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tracked.push(d);
  return d;
}

/** Remove every temp dir created through tempDir(). */
export function cleanupTempDirs(): void {
  while (tracked.length > 0) {
    const d = tracked.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
}

/** Copy a game template into a fresh temp dir; returns the project dir. */
export function copyTemplate(name: string): string {
  // acceptance -> src -> packages/test-runner -> packages -> game-templates/<name>
  const src = resolve(HERE, '..', '..', '..', 'game-templates', name);
  if (!existsSync(src)) {
    throw new Error(`template not found: ${src}`);
  }
  const dest = tempDir(`gf-acc-${name}-`);
  cpSync(src, dest, { recursive: true, filter: (s) => !s.includes('node_modules') });
  return dest;
}

export function writeFile(dir: string, rel: string, content: string): void {
  writeFileSync(join(dir, rel), content);
}

export function readFile(dir: string, rel: string): string {
  return readFileSync(join(dir, rel), 'utf8');
}

export function fileExists(dir: string, rel: string): boolean {
  return existsSync(join(dir, rel));
}

/**
 * Initialize a real git repo in `dir` with every file committed.
 * Sets repo-local identity (this VM's git has no global identity).
 */
export function initGitRepo(dir: string, message = 'acceptance fixture'): void {
  const run = (args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  run(['init', '-q']);
  run(['config', 'user.name', 'GameForge Acceptance']);
  run(['config', 'user.email', 'acceptance@gameforge.local']);
  run(['add', '-A']);
  run(['commit', '-q', '-m', message]);
}

/* ------------------------------------------------------------------ */
/* Minimal ZIP central-directory reader (for scenario F)                */
/* ------------------------------------------------------------------ */

export interface ZipEntry {
  name: string;
  size: number;
  crc: number;
}

/** Parse the central directory of a stored-entry ZIP. Throws on garbage. */
export function readZipEntries(zip: Buffer): ZipEntry[] {
  if (zip.subarray(0, 2).toString('ascii') !== 'PK') {
    throw new Error('not a ZIP file (missing PK magic)');
  }
  // Find End Of Central Directory (scan last 66KB for the signature).
  const EOCD = 0x06054b50;
  let eocd = -1;
  const scanStart = Math.max(0, zip.length - 66000);
  for (let i = zip.length - 22; i >= scanStart; i--) {
    if (zip.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP end-of-central-directory not found');
  const count = zip.readUInt16LE(eocd + 10);
  let off = zip.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(off) !== 0x02014b50) {
      throw new Error(`bad central-directory signature at entry ${n}`);
    }
    const nameLen = zip.readUInt16LE(off + 28);
    const extraLen = zip.readUInt16LE(off + 30);
    const commentLen = zip.readUInt16LE(off + 32);
    const crc = zip.readUInt32LE(off + 16);
    const size = zip.readUInt32LE(off + 24);
    const name = zip.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    entries.push({ name, size, crc });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
