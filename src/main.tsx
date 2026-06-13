import React from 'react';
import ReactDOM from 'react-dom/client';
// Self-hosted fonts via @fontsource — bundled by Vite, served same-origin.
// Replaces the fonts.googleapis.com / fonts.gstatic.com CDN <link> tag so
// the page can run under Cross-Origin-Embedder-Policy: credentialless
// (third-party font subresources without CORP would otherwise be blocked).
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import App from './App';
import './styles/shell.css';

// ── PWA auto-update via vite-plugin-pwa / Workbox ────────────────────────
// Static import keeps the registerSW shim in the main bundle so an old
// cached index.html never references a missing dynamic chunk hash.
// On each page load the SW pings for a new revision; when found it
// installs in the background, then `skipWaiting + clientsClaim` (set in
// vite.config.ts) promote it immediately. Activation reloads the page
// silently so the user sees fresh code without manual cache-clearing.
import { registerSW } from 'virtual:pwa-register';

const isLocalDevHost =
  import.meta.env.DEV &&
  ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);

if (isLocalDevHost && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations()
    .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
    .then(() => (window.caches ? caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))) : null))
    .catch((err) => console.warn('[pwa] localhost cleanup skipped:', err));
}

if (!isLocalDevHost && 'serviceWorker' in navigator) {
  try {
    const updateSW = registerSW({
      immediate: true,
      onRegisteredSW(_swUrl, registration) {
        if (!registration) return;
        // Poll for SW updates every 30 minutes for long sessions.
        setInterval(() => {
          registration.update().catch(() => undefined);
        }, 30 * 60 * 1000);
      },
      onNeedRefresh() {
        // New SW installed and waiting. Activate immediately and reload.
        void updateSW(true);
      },
      onOfflineReady() {
        // eslint-disable-next-line no-console
        console.info('[pwa] offline-ready');
      },
    });
  } catch (err) {
    console.warn('[pwa] registerSW skipped:', err);
  }
}

// Chunk-load recovery. After a new build is deployed the hashed asset
// filenames change. If a browser still has the old index.html cached,
// React.lazy()'s dynamic import resolves to a 404 and the whole screen
// shows "NeoDW failed to start · Failed to fetch dynamically imported
// module". Detect that specific failure and force-reload to pick up the
// fresh index.html + new chunk names. Guard against reload loops using a
// sessionStorage marker cleared on a successful load.
const CHUNK_RELOAD_KEY = '__neodw_chunk_reload';
const isChunkLoadError = (msg: string): boolean =>
  /Failed to fetch dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk [\w-]+ failed|error loading dynamically imported module/i.test(msg);

function tryChunkReload(msg: string): boolean {
  if (!isChunkLoadError(msg)) return false;
  try {
    const already = sessionStorage.getItem(CHUNK_RELOAD_KEY);
    if (already && Date.now() - Number(already) < 10_000) return false;
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
  } catch {}
  // Cache-busting reload
  const u = new URL(window.location.href);
  u.searchParams.set('_v', String(Date.now()));
  window.location.replace(u.toString());
  return true;
}

// Clear the reload marker after the app has been up for >3s (assume success)
window.setTimeout(() => { try { sessionStorage.removeItem(CHUNK_RELOAD_KEY); } catch {} }, 3000);

// Vite-specific preload failure event
window.addEventListener('vite:preloadError', () => {
  tryChunkReload('Failed to fetch dynamically imported module');
});

window.addEventListener('error', (event) => {
  const msg = event.error?.message || event.message || '';
  if (tryChunkReload(msg)) return;
  console.error('Global error:', event.error);
  const root = document.getElementById('root');
  if (root && !root.hasChildNodes()) {
    root.innerHTML = `<div style="color:#f85149;padding:24px;font-family:monospace">
      <h2>NeoDW failed to start</h2>
      <pre>${event.error?.message || event.message}</pre>
      <pre>${event.error?.stack || ''}</pre>
    </div>`;
  }
});

window.addEventListener('unhandledrejection', (event) => {
  const msg = (event.reason?.message ?? String(event.reason ?? '')) as string;
  if (tryChunkReload(msg)) return;
  console.error('Unhandled rejection:', event.reason);
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Convenience globals for console debugging. Keep these off the critical
// startup path so the shell can render even if Cornerstone's large module
// graph is still loading or a dev-only dependency hiccups.
void Promise.all([
  import('@cornerstonejs/core'),
  import('@cornerstonejs/tools'),
])
  .then(([cornerstone, cornerstoneTools]) => {
    (window as any).cornerstone = cornerstone;
    (window as any).cornerstoneTools = cornerstoneTools;
  })
  .catch((err) => {
    console.warn('[cornerstone globals] skipped:', err);
  });
