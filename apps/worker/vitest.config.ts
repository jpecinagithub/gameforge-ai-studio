import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// In tests, resolve @gameforge/shared to source so no build step is needed.
export default defineConfig({
  resolve: {
    alias: {
      '@gameforge/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  test: { include: ['test/**/*.test.ts'] },
});
