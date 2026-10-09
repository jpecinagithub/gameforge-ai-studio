import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // 'prompt' = safe update behavior: the user is asked, we never
      // force-reload (a reload mid-run would drop the SSE stream state).
      registerType: 'prompt',
      includeAssets: ['icons/icon-192.svg', 'icons/icon-512.svg'],
      manifest: {
        name: 'GameForge AI Studio',
        short_name: 'GameForge',
        description: 'Describe a game in natural language; AI agents build, test and preview it.',
        theme_color: '#0a0a0f',
        background_color: '#0a0a0f',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icons/icon-192.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icons/icon-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        cleanupOutdatedCaches: true,
        // Never cache the API or SSE stream.
        navigateFallbackDenylist: [/^\/api\//],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      // Local dev: the API runs on :8090 (see .env.example).
      '/api': { target: 'http://127.0.0.1:8090', changeOrigin: true },
    },
  },
});
