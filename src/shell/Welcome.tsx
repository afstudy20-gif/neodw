import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { LANGS, useI18n } from './i18n';
import { useTheme } from '../theme/ThemeProvider';
import type { ModalityRoute } from '../App';

interface Props {
  onLaunch: (route: ModalityRoute, files?: File[]) => void;
}

const APP_VERSION = '0.1.0';

const COUNTRY_XY: Record<string, [number, number]> = {
  us:[90,80], ca:[85,55], mx:[95,100], br:[135,130], ar:[130,155],
  gb:[178,65], fr:[182,75], de:[190,70], es:[178,80], it:[192,82],
  nl:[185,68], se:[195,55], no:[190,50], ru:[245,60], pl:[200,68],
  tr:[215,90], sa:[225,105], ae:[235,105], il:[215,95], eg:[215,105],
  za:[215,155], ng:[195,120], ke:[225,130], ma:[180,95],
  in:[265,105], pk:[260,100], bd:[275,105], lk:[270,115],
  cn:[290,85], jp:[320,85], kr:[315,87], id:[300,135], ph:[310,115], vn:[295,110], th:[285,110], my:[295,125], sg:[295,128],
  au:[315,160], nz:[340,165],
  ir:[235,95], iq:[225,95], ua:[210,72], ro:[205,80], gr:[205,85], pt:[175,85], be:[185,72], ch:[188,75], at:[195,75], cz:[198,73], hu:[200,77], ie:[172,65], fi:[205,52], dk:[190,62], cl:[125,150], co:[115,125], pe:[120,135], ve:[120,120], tw:[315,100], hk:[305,105],
};

const LAND_DOTS = "60,45 65,45 70,43 75,43 80,45 85,47 90,48 95,50 100,52 105,55 110,55 115,55 120,55 125,55 130,55 135,53 65,50 70,50 75,50 80,52 85,53 90,54 95,55 100,58 105,60 110,60 115,60 65,55 70,55 75,58 80,60 85,60 90,62 95,62 100,64 105,65 110,65 115,62 90,68 95,70 100,70 105,72 110,72 115,70 95,75 100,78 105,80 110,80 115,82 108,85 112,88 115,92 120,92 125,95 130,98 135,102 140,108 145,115 150,122 148,130 145,138 140,145 135,152 130,158 128,162 130,165 135,165 170,50 175,48 180,50 185,50 190,48 195,48 200,50 205,52 210,55 215,55 220,55 225,58 175,55 180,55 185,55 190,55 195,55 200,55 205,55 210,58 215,60 220,60 225,62 230,62 180,62 185,62 190,62 195,62 200,62 205,62 210,65 215,68 180,68 185,68 190,68 195,70 200,72 205,72 210,75 215,75 190,75 195,78 200,80 205,82 210,82 215,82 220,82 195,85 200,88 205,90 210,92 215,92 220,92 225,92 200,95 205,98 210,102 215,105 220,105 225,108 230,108 235,108 240,105 245,105 200,110 205,112 210,115 215,118 220,118 225,118 200,122 205,125 210,128 215,130 218,135 215,140 212,145 210,148 208,145 205,140 250,60 255,58 260,58 265,58 270,58 275,58 280,58 285,58 290,60 295,60 300,60 305,62 310,65 250,65 255,65 260,65 265,65 270,65 275,65 280,65 285,65 290,65 295,68 300,70 305,70 310,72 315,72 250,72 255,72 260,72 265,75 270,78 275,78 280,78 285,78 290,80 295,82 300,82 305,82 310,85 320,85 325,85 260,82 265,85 270,88 275,88 280,90 285,92 290,92 295,95 300,98 305,100 310,102 315,102 322,88 322,92 328,90 265,95 270,98 275,102 280,105 285,108 290,112 268,108 272,112 275,115 278,118 282,120 298,132 302,132 308,132 295,138 300,138 305,138 310,138 295,155 300,155 305,155 310,155 315,155 320,155 325,155 330,158 335,160 340,162 345,162 325,165 330,165 335,168 340,168 345,170 345,172 348,174 340,140 345,142";

function ccFlag(cc: string): string {
  if (!cc || cc.length !== 2) return '🌐';
  return [...cc.toUpperCase()].map((c) => String.fromCodePoint(c.charCodeAt(0) + 127397)).join('');
}

interface CountryStat { cc: string; count: number; }

/* ── Icons ───────────────────────────────────────── */
function Ico({ s = 16, children }: { s?: number; children: JSX.Element }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}
const IcoFolder = (p: { s?: number }) => <Ico s={p.s}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></Ico>;
const IcoFile = (p: { s?: number }) => <Ico s={p.s}><><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></></Ico>;
const IcoSun = (p: { s?: number }) => <Ico s={p.s}><><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></></Ico>;
const IcoMoon = (p: { s?: number }) => <Ico s={p.s}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></Ico>;
const IcoInfo = (p: { s?: number }) => <Ico s={p.s}><><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v5h1"/></></Ico>;
const IcoHeart = (p: { s?: number }) => <Ico s={p.s}><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/></Ico>;
const IcoScan = (p: { s?: number }) => <Ico s={p.s}><><path d="M3 7V5a2 2 0 0 1 2-2h2M21 7V5a2 2 0 0 0-2-2h-2M3 17v2a2 2 0 0 0 2 2h2M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M3 12h18"/></></Ico>;
const IcoActivity = (p: { s?: number }) => <Ico s={p.s}><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></Ico>;
const IcoWave = (p: { s?: number }) => <Ico s={p.s}><path d="M3 12h3l2-4 3 8 3-12 3 16 2-8h2"/></Ico>;
const IcoUpload = (p: { s?: number }) => <Ico s={p.s}><><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></></Ico>;

/* ── Brand mark: outlined heart with ECG trace ────── */
export function NeoDWMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-label="NeoDW">
      <path
        d="M32 55 C 10 42, 6 26, 12 17 C 18 9, 28 10, 32 19 C 36 10, 46 9, 52 17 C 58 26, 54 42, 32 55 Z"
        fill="none"
        stroke="var(--nd-primary)"
        strokeWidth="4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path
        d="M8 34 L 20 34 L 24 26 L 29 44 L 33 20 L 37 46 L 41 30 L 48 34 L 56 34"
        fill="none"
        stroke="var(--nd-danger, #C9392E)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Wordmark({ tagline = false, size = 17 }: { tagline?: boolean; size?: number }) {
  return (
    <div className="nd-wordmark">
      <div className="nd-wordmark-logo" style={{ background: 'transparent', color: 'var(--nd-primary)' }}>
        <NeoDWMark size={size + 14} />
      </div>
      <div>
        <div className="nd-wordmark-text" style={{ fontSize: size }}>
          Neo<span className="accent">DW</span>
        </div>
        {tagline && (
          <div className="mono nd-wordmark-tag cap">UNIVERSAL · DICOM · WORKSTATION</div>
        )}
      </div>
    </div>
  );
}

/* ── Mode definitions ───────────────────────────── */
interface ModeDef {
  route: ModalityRoute;
  group: 'cross' | 'coronary' | 'us' | 'xray';
  featured?: boolean;
  name: string;
  desc: string;
  icon: JSX.Element;
  key: string;
  tags: string[];
}

const MODES: ModeDef[] = [
  {
    route: { kind: 'ct', panel: null, title: 'mod.ctmr' },
    group: 'cross',
    name: 'mod.ctmr',
    desc: 'mod.ctmr.desc',
    icon: <IcoHeart/>,
    key: 'ctmr',
    tags: ['MPR', '3D VR', 'TAVI', 'LA', 'Aorta', 'LAA', 'LV-ADAS', 'Hand-MR'],
  },
  {
    route: { kind: 'ccta' },
    group: 'coronary',
    name: 'mod.ccta',
    desc: 'mod.ccta.desc',
    icon: <IcoScan/>,
    key: 'ccta',
    tags: ['CCTA', 'Centerline', 'QCA', 'Plaque', 'CT-FFR'],
  },
  {
    route: { kind: 'angio' },
    group: 'coronary',
    name: 'mod.angio',
    desc: 'mod.angio.desc',
    icon: <IcoActivity/>,
    key: 'xa',
    tags: ['XA', 'QCA', 'vFFR'],
  },
  {
    route: { kind: 'echo' },
    group: 'cross',
    name: 'mod.echo',
    desc: 'mod.echo.desc',
    icon: <IcoWave/>,
    key: 'us',
    tags: ['US', 'Cine', 'Doppler', 'Length'],
  },
  {
    route: { kind: 'xray' },
    group: 'xray',
    name: 'mod.xray',
    desc: 'mod.xray.desc',
    icon: <IcoFile/>,
    key: 'xr',
    tags: ['CR', 'DX', 'MG', 'W/L', 'Length'],
  },
];

const GROUPS: { id: ModeDef['group']; key: string }[] = [
  { id: 'cross', key: 'sec.ctmr' },
  { id: 'coronary', key: 'sec.coronary' },
  { id: 'xray', key: 'sec.xray' },
];

function pickFiles(folder: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (folder) (input as any).webkitdirectory = true;
    input.onchange = (e) => {
      const target = e.target as HTMLInputElement;
      if (target.files?.length) resolve(Array.from(target.files));
      else resolve([]);
    };
    input.click();
  });
}

/* ── Component ──────────────────────────────────── */
export default function Welcome({ onLaunch }: Props) {
  const { t, lang, setLang } = useI18n();
  const { theme, toggle: toggleTheme } = useTheme();
  const [aboutOpen, setAboutOpen] = useState(false);

  const [stats, setStats] = useState<{ total: number | null; daily: number | null; active: number | null; countries: CountryStat[]; myCc: string | null; myName: string | null }>({
    total: null, daily: null, active: null, countries: [], myCc: null, myName: null,
  });

  useEffect(() => {
    let cancelled = false;
    const CACHE_KEY = 'neodw_stats_cache';
    const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

    // Serve from cache if fresh
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.ts && Date.now() - parsed.ts < CACHE_TTL_MS) {
          setStats(parsed.data);
        }
      }
    } catch {}

    async function loadStats() {
      const NS = 'neodw-global';
      let geoCc: string | null = null;
      let geoName: string | null = null;
      try {
        const controller = (AbortSignal as any).timeout ? { signal: (AbortSignal as any).timeout(4000) } : {};
        const geo = await fetch('https://ipapi.co/json/', controller).then((r) => r.json());
        geoCc = (geo.country_code || '').toLowerCase() || null;
        geoName = geo.country_name || geo.country_code || null;
      } catch {}

      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const hourKey = new Date().toISOString().slice(0, 13).replace(/[-:T]/g, '');
      const sessionHit = sessionStorage.getItem('neodw_hit');
      const op = sessionHit ? 'get' : 'hit';
      const base = 'https://abacus.jasoncameron.dev';

      const fetchCount = (key: string, operation: string) =>
        fetch(`${base}/${operation}/${NS}/${key}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => (j && typeof j.value === 'number' ? j.value : null))
          .catch(() => null);

      const [total, daily, active] = await Promise.all([
        fetchCount('visits', op),
        fetchCount(`d-${today}`, op),
        fetchCount(`h-${hourKey}`, op),
      ]);

      if (!sessionHit) {
        sessionStorage.setItem('neodw_hit', '1');
        if (geoCc && geoCc.length === 2) fetch(`${base}/hit/${NS}/c-${geoCc}`).catch(() => {});
      }

      // Country queries: serial with small delay to avoid rate limits. Skip if recent cache exists.
      let results: CountryStat[] = [];
      try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed?.data?.countries && Date.now() - (parsed.ts || 0) < CACHE_TTL_MS) {
            results = parsed.data.countries;
          }
        }
      } catch {}

      if (results.length === 0) {
        const ccs = Object.keys(COUNTRY_XY);
        for (const cc of ccs) {
          if (cancelled) return;
          const n = await fetchCount(`c-${cc}`, 'get');
          results.push({ cc, count: n || 0 });
          await new Promise((r) => setTimeout(r, 60));
        }
      }

      if (cancelled) return;
      const data = { total, daily, active, countries: results, myCc: geoCc, myName: geoName };
      setStats(data);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); } catch {}
    }

    void loadStats();
    return () => { cancelled = true; };
  }, []);

  // PWA install prompt capture — surface an in-page hint that mirrors the
  // address-bar install icon, and trigger prompt() on click when the browser
  // fires beforeinstallprompt.
  const installDeferred = useRef<any>(null);
  const [canInstall, setCanInstall] = useState<boolean>(false);
  const [installed, setInstalled] = useState<boolean>(false);
  useEffect(() => {
    const onBIP = (e: Event) => {
      e.preventDefault();
      installDeferred.current = e;
      setCanInstall(true);
    };
    const onInstalled = () => {
      installDeferred.current = null;
      setCanInstall(false);
      setInstalled(true);
    };
    window.addEventListener('beforeinstallprompt', onBIP as EventListener);
    window.addEventListener('appinstalled', onInstalled);
    // Also detect already-standalone (installed) PWA
    try {
      const mql = window.matchMedia('(display-mode: standalone)');
      if (mql.matches) setInstalled(true);
    } catch {}
    return () => {
      window.removeEventListener('beforeinstallprompt', onBIP as EventListener);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);
  const promptInstall = async () => {
    const dp = installDeferred.current;
    if (!dp) return;
    try { await dp.prompt(); const res = await dp.userChoice; if (res?.outcome === 'accepted') { installDeferred.current = null; setCanInstall(false); } } catch {}
  };

  // Prevent browser from opening a dragged file in a new tab when the user
  // releases it outside a drop target (default behavior would navigate away
  // from the app). Page-wide dragover + drop preventDefault neutralizes this.
  useEffect(() => {
    const prevent = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  async function launchWith(route: ModalityRoute, mode: 'files' | 'folder' | 'empty') {
    if (mode === 'empty') {
      onLaunch(route);
      return;
    }
    const files = await pickFiles(mode === 'folder');
    if (files.length === 0) return;
    onLaunch(route, files);
  }

  async function quickOpen(mode: 'files' | 'folder') {
    // Quick-open without modality: default to CT app
    const files = await pickFiles(mode === 'folder');
    if (files.length === 0) return;
    onLaunch({ kind: 'ct', panel: null, title: 'mod.ctmr' }, files);
  }

  const topCountries = stats.countries.filter((c) => c.count > 0).sort((a, b) => b.count - a.count).slice(0, 8);

  return (
    <div>
      {/* Top Bar */}
      <div className="nd-topbar">
        <Wordmark size={17} />
        <div className="nd-topbar-sep" />
        <div style={{ flex: 1 }} />
        <div className="mono nd-topbar-status">
          <span className="dot-ok" /> PACS · LOCAL
          <span style={{ color: 'var(--nd-line)' }}>│</span>
          v{APP_VERSION}
        </div>
        <div className="nd-topbar-actions">
          <div className="nd-langs" style={{ gap: 4 }}>
            {LANGS.map((l) => (
              <button
                key={l.code}
                className={`nd-lang ${lang === l.code ? 'on' : ''}`}
                onClick={() => setLang(l.code)}
                title={l.label}
              >
                {l.flag}
              </button>
            ))}
          </div>
          <button className="nd-icon-btn" onClick={toggleTheme} title={t('btn.theme')} aria-label="theme">
            {theme === 'dark' ? <IcoSun/> : <IcoMoon/>}
          </button>
          <button className="nd-icon-btn" onClick={() => setAboutOpen(true)} title={t('btn.about')} aria-label="about">
            <IcoInfo/>
          </button>
        </div>
      </div>

      <div className="nd-launcher">
        {/* Hero */}
        <div className="nd-hero">
          <div>
            <div className="cap nd-hero-kicker">{t('app.tagline')}</div>
            <h1 className="nd-hero-heading">
              {t('hero.headline')}
            </h1>

            <div className="nd-hero-badges">
              <div className="nd-privacy-badge" role="note" aria-label="privacy">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  <path d="M9 12l2 2 4-4"/>
                </svg>
                <span><b>{t('priv.title')}</b> {t('priv.desc')}</span>
              </div>
              <a
                className="nd-hero-link"
                href="https://flow.drtr.uk/"
                target="_blank"
                rel="noopener noreferrer"
                title="Flow — PRISMA sistematik inceleme akış şeması"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="3" y="4" width="18" height="6" rx="1.5"/>
                  <rect x="3" y="14" width="10" height="6" rx="1.5"/>
                  <path d="M8 10v4"/>
                </svg>
                <span><b>Flow</b> by drtr.uk · PRISMA akış şeması</span>
              </a>
              {!installed && (
                <button
                  type="button"
                  className="nd-install-hint"
                  onClick={canInstall ? promptInstall : undefined}
                  title={canInstall
                    ? 'Tarayıcıya uygulama olarak yükle'
                    : 'Adres çubuğundaki yükle simgesine tıkla (Chrome / Edge). Safari: Paylaş → Ana Ekrana Ekle.'}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M3 3h7v7H3z"/>
                    <path d="M14 3h7v7h-7z"/>
                    <path d="M14 14h7v7h-7z"/>
                    <path d="M3 14h7v7H3z"/>
                    <path d="M12 8v8M8 12h8"/>
                  </svg>
                  <span>
                    <b>Uygulama olarak yükle</b>
                    {canInstall
                      ? 'Tıkla: NeoDW Chrome/Edge üzerinden cihazına kurulur.'
                      : 'Adres çubuğunun sağındaki ⊞ simgesine tıkla. Safari: Paylaş → Ana Ekrana Ekle.'}
                  </span>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Modalities section */}
        <div className="nd-modalities-head">
          <div className="cap">{t('sp.choose')}</div>
          <div className="mono nd-modalities-count">{MODES.length} ENVIRONMENTS · DICOM WORKSTATION</div>
        </div>

        {GROUPS.map((g) => {
          const items = MODES.filter((m) => m.group === g.id);
          if (items.length === 0) return null;
          const singleCol = items.length === 1 || items[0].featured;
          return (
            <div key={g.id} className="nd-mode-group">
              <div className="cap nd-mode-group-title">{t(g.key)}</div>
              <div className={`nd-modes ${singleCol ? 'cols-1' : 'cols-2'}`}>
                {items.map((m) => (
                  <ModalityCard key={m.key} m={m} t={t} onLaunch={launchWith} onDropFiles={(r, files) => onLaunch(r, files)} />
                ))}
              </div>
            </div>
          );
        })}

        {/* Contact + Support card (Flow-style) */}
        <div className="nd-support-wrap">
          <div className="nd-support-email">
            <a href="mailto:adycovs@gmail.com">✉ adycovs@gmail.com</a>
          </div>

          <div className="nd-support-card">
            <div className="nd-support-title">{t('sp.supportT')}</div>
            <div className="nd-support-desc">{t('sp.supportD')}</div>
            <div className="nd-support-btns">
              <a className="nd-support-btn patreon" href="https://www.patreon.com/posts/156026494" target="_blank" rel="noreferrer">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M22.957 7.21c-.004-3.078-2.584-5.593-5.638-5.593-3.074 0-5.588 2.456-5.588 5.539 0 3.052 2.478 5.535 5.531 5.535 3.051 0 5.698-2.427 5.695-5.481zM2.83 2.185a.91.91 0 00-.91.91v17.436a.91.91 0 00.91.91h3.391a.91.91 0 00.91-.91V3.095a.91.91 0 00-.91-.91H2.83z"/></svg>
                {t('btn.patreon')}
              </a>
              <a className="nd-support-btn shopier" href="https://www.shopier.com/tools26/46355545" target="_blank" rel="noreferrer">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 7h12l-1.5 11a2 2 0 0 1-2 1.7h-5a2 2 0 0 1-2-1.7L6 7Z"/><path d="M9 7V5a3 3 0 0 1 6 0v2"/></svg>
                {t('btn.shopier')}
              </a>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' }}>
            <button className="nd-support-about" onClick={() => setAboutOpen(true)}>{t('btn.about')}</button>
            <span style={{ color: 'var(--nd-ink-3)' }}>·</span>
            <a className="nd-support-about" href="https://flow.drtr.uk/" target="_blank" rel="noreferrer" style={{ textDecoration: 'underline', textUnderlineOffset: 3 }}>
              Flow by drtr.uk
            </a>
          </div>

          <div className="nd-support-copy">
            Dr. Yusuf Hoşoğlu &copy; 2026 · All rights reserved
          </div>
        </div>

        <MapMyVisitors />
      </div>

      {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}
    </div>
  );
}

/* ── Drop helper: flatten dragged files + folders (webkitGetAsEntry) ── */
async function gatherFilesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const out: File[] = [];
  const entries: any[] = [];
  const items = dt.items;
  if (items && items.length) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const entry = (it as any).webkitGetAsEntry?.();
      if (entry) entries.push(entry);
      else {
        const f = it.getAsFile?.();
        if (f) out.push(f);
      }
    }
  }
  async function walk(entry: any): Promise<void> {
    if (entry.isFile) {
      await new Promise<void>((r) => entry.file((f: File) => { out.push(f); r(); }, () => r()));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      while (true) {
        const batch = await new Promise<any[]>((r) => reader.readEntries((e: any[]) => r(e), () => r([])));
        if (batch.length === 0) break;
        for (const c of batch) await walk(c);
      }
    }
  }
  for (const e of entries) await walk(e);
  if (out.length === 0 && dt.files) {
    for (let i = 0; i < dt.files.length; i++) out.push(dt.files[i]);
  }
  return out;
}

/* ── Modality Card ──────────────────────────────── */
function ModalityCard({ m, t, onLaunch, onDropFiles }: {
  m: ModeDef;
  t: (k: string) => string;
  onLaunch: (r: ModalityRoute, mode: 'files' | 'folder' | 'empty') => void;
  onDropFiles: (r: ModalityRoute, files: File[]) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);

  const cardDropHandlers = {
    onDragEnter: (e: ReactDragEvent) => {
      if (!Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault();
      dragCounter.current++;
      setDragOver(true);
    },
    onDragOver: (e: ReactDragEvent) => {
      if (!Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: () => {
      dragCounter.current--;
      if (dragCounter.current <= 0) {
        dragCounter.current = 0;
        setDragOver(false);
      }
    },
    onDrop: async (e: ReactDragEvent) => {
      e.preventDefault();
      dragCounter.current = 0;
      setDragOver(false);
      const files = await gatherFilesFromDataTransfer(e.dataTransfer);
      if (files.length > 0) onDropFiles(m.route, files);
    },
  };

  return (
    <div className={`nd-mode-card ${dragOver ? 'drop-over' : ''}`} {...cardDropHandlers}>
      <div className="nd-mode-head">
        <div className="nd-mode-icon">{m.icon}</div>
        <div style={{ flex: 1 }}>
          <div className="nd-mode-title">{t(m.name)}</div>
          <div className="mono nd-mode-sub">{m.key.toUpperCase()} · DICOM · MULTI-SERIES</div>
        </div>
        {m.featured && <span className="cap nd-mode-badge">Primary</span>}
      </div>

      <div className="nd-mode-blurb">{t(m.desc)}</div>

      <div className="nd-mode-tags">
        {m.tags.map((tag) => (
          <span key={tag} className="mono nd-mode-tag">{tag}</span>
        ))}
      </div>

      <div className="nd-mode-divider" />

      <div className="nd-mode-actions">
        <button
          className="nd-mode-btn primary"
          onClick={() => onLaunch(m.route, 'folder')}
          title="Klasör seç (ya da karta sürükle-bırak)"
        >
          <IcoFolder s={14}/> {t('btn.folder')}
        </button>
        <button
          className="nd-mode-btn"
          onClick={() => onLaunch(m.route, 'files')}
          title="Dosya seç (ya da karta sürükle-bırak)"
        >
          <IcoFile s={14}/> {t('btn.files')}
        </button>
      </div>

      <div className="nd-mode-drop-hint" aria-hidden>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <path d="M7 10l5-5 5 5"/>
          <path d="M12 5v12"/>
        </svg>
        <span>veya DICOM dosya/klasörünü buraya sürükle-bırak</span>
      </div>

      {dragOver && (
        <div className="nd-mode-dropmask">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <path d="M7 10l5-5 5 5"/>
            <path d="M12 5v12"/>
          </svg>
          <span>Buraya bırak</span>
        </div>
      )}
    </div>
  );
}

/* ── Global Activity (replaces Recent panel) ─────── */
function GlobalActivityPanel({ stats }: { stats: any }) {
  const { t } = useI18n();
  return (
    <div className="nd-recent">
      <div className="nd-recent-head">
        <div className="cap">{t('panel.activity')}</div>
        <div style={{ flex: 1 }} />
        <div className="mono" style={{ fontSize: 10.5, color: 'var(--nd-ink-3)' }}>GLOBAL</div>
      </div>

      <div style={{ padding: '18px 18px 10px' }}>
        <div className="nd-visitor-stats">
          <div>
            <div className="mono nd-visitor-stat-num">{stats.active ?? '—'}</div>
            <div className="cap nd-visitor-stat-lbl">{t('sp.active')}</div>
          </div>
          <div>
            <div className="mono nd-visitor-stat-num">{stats.daily ?? '—'}</div>
            <div className="cap nd-visitor-stat-lbl">{t('sp.today')}</div>
          </div>
          <div>
            <div className="mono nd-visitor-stat-num">{stats.total?.toLocaleString() ?? '—'}</div>
            <div className="cap nd-visitor-stat-lbl">{t('sp.visits')}</div>
          </div>
        </div>

        <div style={{ fontSize: 13, color: 'var(--nd-ink-3)', marginTop: 14 }}>
          <span>{stats.myCc ? ccFlag(stats.myCc) : '🌐'}</span>{' '}
          <span>{t('sp.loc')}: {stats.myName ?? '—'}</span>
        </div>
      </div>

      <div className="nd-recent-foot">
        <button className="nd-recent-drop" onClick={async () => {
          const input = document.createElement('input');
          input.type = 'file';
          input.multiple = true;
          (input as any).webkitdirectory = true;
          input.click();
        }}>
          <IcoUpload s={14}/> {t('panel.drop')}
        </button>
      </div>
    </div>
  );
}

/* ── mapmyvisitors embed ────────────────────────── */
function MapMyVisitors() {
  useEffect(() => {
    const slot = document.getElementById('mapmyvisitors-slot');
    if (!slot) return;
    if (document.getElementById('mapmyvisitors')) return;

    // MapMyVisitors map.js renders via document.write(), which is
    // silently dropped for async-inserted scripts. Proxy document.write
    // so any output lands inside our slot div, then restore after the
    // script finishes executing. This is the standard workaround for
    // embedding document.write-based third-party widgets in SPAs.
    const origWrite = document.write.bind(document);
    const origWriteln = document.writeln.bind(document);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (document as any).write = (...args: any[]) => {
      slot.insertAdjacentHTML('beforeend', args.join(''));
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (document as any).writeln = (...args: any[]) => {
      slot.insertAdjacentHTML('beforeend', args.join('') + '\n');
    };

    const restore = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (document as any).write = origWrite;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (document as any).writeln = origWriteln;
    };

    const s = document.createElement('script');
    s.type = 'text/javascript';
    s.id = 'mapmyvisitors';
    s.src = 'https://mapmyvisitors.com/map.js?d=mKLyIjWT577bDc9kAESkC_hHaxcXtAD5mKvhZGFApHQ&cl=ffffff&w=a';
    s.onload = restore;
    s.onerror = () => {
      restore();
      console.warn('[MapMyVisitors] script failed to load. Check network reach / ad-blocker.');
    };
    slot.appendChild(s);
  }, []);
  return (
    <div
      id="mapmyvisitors-slot"
      style={{
        marginTop: 24,
        opacity: 0.85,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        maxWidth: 320,
        marginLeft: 'auto',
        marginRight: 'auto',
      }}
    >
      <style>{`
        #mapmyvisitors-slot img,
        #mapmyvisitors-slot canvas,
        #mapmyvisitors-slot iframe {
          max-width: 100%;
          height: auto;
        }
        #mapmyvisitors-slot a { display: inline-block; }
      `}</style>
    </div>
  );
}

/* ── World map ──────────────────────────────────── */
function WorldMap({ countries, myCc }: { countries: CountryStat[]; myCc: string | null }) {
  const max = Math.max(1, ...countries.map((d) => d.count));
  return (
    <div className="nd-worldmap">
      <svg viewBox="0 0 360 180" xmlns="http://www.w3.org/2000/svg">
        <rect width="360" height="180" fill="transparent" />
        <g fill="var(--nd-ink-3)" opacity="0.28">
          {LAND_DOTS.split(' ').map((p, i) => {
            const [x, y] = p.split(',');
            return <circle key={i} cx={x} cy={y} r={1.3} />;
          })}
        </g>
        <g>
          {countries.filter((c) => c.count > 0).map((c) => {
            const xy = COUNTRY_XY[c.cc]; if (!xy) return null;
            const r = Math.max(2.2, Math.min(7.5, 2.2 + 5 * Math.sqrt(c.count / max)));
            const isMe = c.cc === myCc;
            return (
              <circle key={c.cc} cx={xy[0]} cy={xy[1]} r={r} fill={isMe ? 'var(--nd-crimson)' : 'var(--nd-primary)'} opacity={0.75}>
                <title>{c.cc.toUpperCase()}: {c.count}</title>
              </circle>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

/* ── About modal ────────────────────────────────── */
function AboutModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <div className="nd-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="nd-modal">
        <button className="nd-close" onClick={onClose} aria-label="close">✕</button>
        <div className="nd-modal-head">
          <Wordmark size={20} tagline />
        </div>

        <div className="nd-modal-desc">{t('ab.desc')}</div>

        <div className="nd-modal-disclaimer">
          <div className="cap nd-modal-sec-t">⚠ {t('ab.disclaimerT')}</div>
          <div className="nd-modal-sec-d">{t('ab.disclaimerD')}</div>
        </div>

        <div className="nd-modal-grid">
          <div>
            <div className="cap nd-modal-sec-t">{t('ab.missionT')}</div>
            <div className="nd-modal-sec-d">{t('ab.missionD')}</div>
          </div>
          <div>
            <div className="cap nd-modal-sec-t">{t('ab.standardsT')}</div>
            <div className="nd-modal-sec-d">{t('ab.standardsD')}</div>
          </div>
          <div>
            <div className="cap nd-modal-sec-t">{t('ab.privacyT')}</div>
            <div className="nd-modal-sec-d">{t('ab.privacyD')}</div>
          </div>
          <div>
            <div className="cap nd-modal-sec-t">{t('ab.techT')}</div>
            <div className="nd-modal-sec-d">{t('ab.techD')}</div>
          </div>
        </div>

        <div className="nd-modal-btns">
          <button className="nd-btn" onClick={onClose}>{t('btn.close')}</button>
        </div>

        <div className="mono" style={{ marginTop: 16, fontSize: 10, color: 'var(--nd-ink-3)', textAlign: 'center' }}>
          Dr. Yusuf Hoşoğlu · &copy; 2026 · v{APP_VERSION}
        </div>
      </div>
    </div>
  );
}
