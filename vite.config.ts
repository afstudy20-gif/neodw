import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Auto-update strategy: SW checks for a new revision on every page
      // load. When a new SW is found it installs in the background, then
      // immediately activates (skipWaiting + clientsClaim). The page reloads
      // silently on controllerchange — no banner, clinical-app workflow.
      registerType: 'autoUpdate',
      injectRegister: 'auto',

      // Use the hand-written manifest already in public/. Setting `manifest: false`
      // stops the plugin from generating its own.
      manifest: false,

      // Make sure the existing static manifest + favicon land in the precache.
      includeAssets: ['favicon.svg', 'manifest.webmanifest'],

      // Sometimes the precache budget warns on big bundles (Cornerstone is
      // chunky). Raise the per-file limit so we never silently exclude an
      // entry — every shipped JS chunk MUST be precached or the app shell
      // breaks offline.
      workbox: {
        // App-shell precache. Notably absent: any DICOM file or API path.
        // PHI never enters the SW cache.
        globPatterns: ['**/*.{js,css,html,svg,webmanifest}'],
        maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        skipWaiting: true,
        clientsClaim: true,
        // SPA fallback: any navigation request that misses precache hits
        // index.html so the client router can take over.
        navigateFallback: '/index.html',
        // Don't try to cache fontsapis / external CDN — keep PWA strictly
        // first-party.
        navigateFallbackDenylist: [/^\/api\//, /^\/_/],
      },

      devOptions: {
        enabled: false, // SW disabled in dev to avoid stale-HMR confusion
      },
    }),
  ],
  server: {
    host: '127.0.0.1',
    port: 5180,
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
  worker: {
    format: 'es',
  },
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: {
    exclude: [
      '@cornerstonejs/core',
      '@cornerstonejs/tools',
      '@cornerstonejs/dicom-image-loader',
      '@cornerstonejs/codec-libjpeg-turbo-8bit',
      '@cornerstonejs/codec-charls',
      '@cornerstonejs/codec-openjpeg',
      '@cornerstonejs/codec-openjph',
    ],
    include: [
      'dicom-parser',
      'comlink',
    ],
  },
});
