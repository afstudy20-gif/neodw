import { useState } from 'react';

/**
 * Manual cache-clear + hard reload, modelled after the notepad PWA's
 * refresh button. After a new build is deployed, browsers can sit on
 * stale hashed chunks until they happen to fetch the new index.html.
 * This button gives the user an explicit "pick up the fresh build" lever.
 *
 * Scope is origin-only: service worker registrations and Cache Storage
 * entries belong to this origin, so other sites are unaffected.
 * localStorage / IndexedDB are NOT touched — user data (theme, language
 * preference) survives.
 */
export function RefreshButton() {
  const [spinning, setSpinning] = useState(false);

  async function onClick() {
    const ok = window.confirm(
      'Bu uygulamanın önbelleği temizlenip yeniden yüklensin mi? Tercihleriniz (tema, dil) korunacak. Diğer siteler etkilenmez.'
    );
    if (!ok) return;
    setSpinning(true);
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister().catch(() => null)));
      }
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k).catch(() => null)));
      }
    } catch (err) {
      console.warn('[refresh]', err);
    }
    const url = new URL(window.location.href);
    url.searchParams.set('_r', Date.now().toString(36));
    window.location.replace(url.toString());
  }

  return (
    <button
      type="button"
      className={`nd-refresh-btn${spinning ? ' spinning' : ''}`}
      onClick={onClick}
      disabled={spinning}
      title="Önbelleği temizle ve uygulamayı yenile"
      aria-label="Refresh app"
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0 }}
      >
        <path d="M3 12a9 9 0 0 1 15.5-6.36L21 8" />
        <path d="M21 3v5h-5" />
        <path d="M21 12a9 9 0 0 1-15.5 6.36L3 16" />
        <path d="M3 21v-5h5" />
      </svg>
      <span>Güncelle</span>
    </button>
  );
}
