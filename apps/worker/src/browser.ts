import type { BrowserLike, BrowserPageLike } from '@gameforge/test-runner';

/**
 * Headless-Chromium factory for the evidence pipeline.
 *
 * Playwright is an optional peer: if it is not installed or the browser fails
 * to launch (e.g. this dev VM), every newPage() throws a typed
 * BrowserUnavailableError, which the evidence classifier maps to
 * OBSERVATION_DOWN (retry, never charged to the build) — an honest
 * degradation, not a fake pass.
 */
export class BrowserUnavailableError extends Error {
  readonly code = 'observation_down';
  constructor(message = 'Headless Chromium is unavailable on this host') {
    super(message);
    this.name = 'BrowserUnavailableError';
  }
}

function wrapPage(page: {
  goto(url: string): Promise<unknown>;
  evaluate(expr: string): Promise<unknown>;
  screenshot(): Promise<Buffer>;
  keyboard: { press(k: string): Promise<unknown>; down(k: string): Promise<unknown>; up(k: string): Promise<unknown> };
  waitForFunction(expr: string, arg?: unknown, opts?: { timeout?: number }): Promise<unknown>;
  on(event: string, cb: (...args: never[]) => void): void;
  isClosed(): boolean;
  close(): Promise<unknown>;
}): BrowserPageLike {
  return {
    goto: (url) => page.goto(url).then(() => undefined),
    evaluate: <T>(expression: string) => page.evaluate(expression) as Promise<T>,
    screenshot: () => page.screenshot(),
    keyboard: {
      press: (key) => page.keyboard.press(key).then(() => undefined),
      down: (key) => page.keyboard.down(key).then(() => undefined),
      up: (key) => page.keyboard.up(key).then(() => undefined),
    },
    waitForFunction: (expression, timeoutMs) =>
      page.waitForFunction(expression, undefined, { timeout: timeoutMs }).then(() => undefined),
    onConsole: (cb) => {
      page.on('console', (msg: { type(): string; text(): string }) => {
        try {
          cb(msg.type(), msg.text());
        } catch { /* never let a listener break the page */ }
      });
    },
    onRequestFailed: (cb) => {
      page.on('requestfailed', (req: { url(): string; failure(): { errorText: string } | null }) => {
        try {
          cb(req.url(), req.failure()?.errorText ?? 'unknown');
        } catch { /* ignore */ }
      });
    },
    isClosed: () => page.isClosed(),
  };
}

/** Launch headless Chromium, or return the fail-closed stub. */
export async function createBrowser(): Promise<BrowserLike> {
  try {
    const { chromium } = (await import('playwright')) as typeof import('playwright');
    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--use-gl=swiftshader',
        '--enable-unsafe-swiftshader',
      ],
    });
    return {
      newPage: async () => wrapPage(await browser.newPage()),
      close: async () => {
        await browser.close();
      },
    };
  } catch {
    return {
      newPage: async (): Promise<BrowserPageLike> => {
        throw new BrowserUnavailableError();
      },
      close: async () => undefined,
    };
  }
}
