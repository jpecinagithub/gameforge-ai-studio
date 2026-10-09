/**
 * Playwright is an OPTIONAL peer dependency of the worker: it is installed on
 * the Oracle host (where Chromium runs) but not on every dev machine.
 * This ambient declaration keeps `import('playwright')` typeable without
 * forcing the dependency on all installs. The runtime import is wrapped in
 * try/catch — a missing module degrades to the fail-closed stub in browser.ts.
 */
declare module 'playwright';
