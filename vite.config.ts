import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

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
  // Dev enables cross-origin isolation so SharedArrayBuffer matches the
  // fast multi-threaded WASM path. Production (nginx/netlify/vercel) omits
  // COEP/COOP on purpose — see README "Cross-origin isolation".
  server: {
    host: '127.0.0.1',
    port: 5180,
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/jspdf') || id.includes('node_modules/html2canvas')) {
            return 'pdf-export';
          }
          if (id.includes('node_modules/@cornerstonejs/')) {
            return 'cornerstone-vendor';
          }
          if (id.includes('node_modules/jszip')) {
            return 'jszip';
          }
        },
      },
    },
  },
  resolve: {
    alias: [
      { find: /^globalthis$/, replacement: fileURLToPath(new URL('./src/shared/core/globalthisShim.ts', import.meta.url)) },
      { find: /^fast-deep-equal$/, replacement: fileURLToPath(new URL('./src/shared/core/fastDeepEqualShim.ts', import.meta.url)) },
      { find: /^seedrandom$/, replacement: fileURLToPath(new URL('./src/shared/core/seedrandomShim.ts', import.meta.url)) },
      { find: /^spark-md5$/, replacement: fileURLToPath(new URL('./src/shared/core/sparkMd5Shim.ts', import.meta.url)) },
      { find: /^loglevel$/, replacement: fileURLToPath(new URL('./src/shared/core/loglevelShim.ts', import.meta.url)) },
      { find: /^lodash\.get$/, replacement: fileURLToPath(new URL('./src/shared/core/lodashGetShim.ts', import.meta.url)) },
      { find: /^xmlbuilder2$/, replacement: fileURLToPath(new URL('./src/shared/core/xmlbuilder2Shim.ts', import.meta.url)) },
      { find: /^webworker-promise$/, replacement: fileURLToPath(new URL('./src/shared/core/webworkerPromiseShim.ts', import.meta.url)) },
      { find: /^webworker-promise\/lib\/register$/, replacement: fileURLToPath(new URL('./src/shared/core/webworkerPromiseRegisterShim.ts', import.meta.url)) },
      { find: /^utif$/, replacement: fileURLToPath(new URL('./src/shared/core/utifShim.ts', import.meta.url)) },
      // dicom-image-loader's package.json `exports` field does not advertise
      // the decode worker entrypoint as a subpath, so neither bare-specifier
      // imports nor Vite's `?worker` sub-rollup can resolve it through normal
      // package resolution. Alias a private specifier to the actual file path
      // so the shim under src/shared/core/cornerstoneDecodeWorker.ts can bring
      // the worker into a Vite-emitted chunk. See that file for the import.
      {
        find: /^@cornerstonejs\/dicom-image-loader\/__decodeImageFrameWorker$/,
        replacement: fileURLToPath(
          new URL(
            './node_modules/@cornerstonejs/dicom-image-loader/dist/esm/decodeImageFrameWorker.js',
            import.meta.url
          )
        ),
      },
    ],
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
    ],
    include: [
      'dicom-parser',
      'comlink',
      '@cornerstonejs/codec-libjpeg-turbo-8bit/decodewasmjs',
      '@cornerstonejs/codec-charls/decodewasmjs',
      '@cornerstonejs/codec-openjpeg/decodewasmjs',
      '@cornerstonejs/codec-openjph/wasmjs',
      'globalthis',
      'fast-deep-equal',
      'seedrandom',
      'spark-md5',
      'loglevel',
      'lodash.get',
      'xmlbuilder2',
      'webworker-promise',
      'webworker-promise/lib/register',
      'utif',
    ],
  },
});
