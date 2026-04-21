import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/shell.css';

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
