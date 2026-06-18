import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { LANGS, useI18n } from './i18n';
import { useTheme } from '../theme/ThemeProvider';
import type { ModalityRoute } from '../App';

interface Props {
  onLaunch: (route: ModalityRoute, files?: File[]) => void;
}

const APP_VERSION = '0.1.0';

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
const IcoRefresh = (p: { s?: number }) => <Ico s={p.s}><><path d="M3 12a9 9 0 0 1 15.5-6.36L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.36L3 16"/><path d="M3 21v-5h5"/></></Ico>;

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
    tags: ['MPR', '3D VR', 'W/L', 'Length', 'Angle', 'Annotate'],
  },
  {
    route: { kind: 'ct', panel: 'tavi', title: 'mod.tavi' },
    group: 'cross',
    name: 'mod.tavi',
    desc: 'mod.tavi.desc',
    icon: <IcoHeart/>,
    key: 'tavi',
    tags: ['Annulus', 'Per-cusp Ca²⁺', 'Sinus 3×', 'Coronary Ø', 'Fluoro angle', 'SFAR'],
  },
  {
    route: { kind: 'ct', panel: 'la', title: 'mod.la_laa' },
    group: 'cross',
    name: 'mod.la_laa',
    desc: 'mod.la_laa.desc',
    icon: <IcoHeart/>,
    key: 'la-laa',
    tags: ['LA 3D', 'Wall Ø', 'Veins 4×', 'LAA Ostium', 'Landing zone', 'Device size'],
  },
  {
    route: { kind: 'ct', panel: 'vascular', title: 'mod.aorta_vascular' },
    group: 'cross',
    name: 'mod.aorta_vascular',
    desc: 'mod.aorta_vascular.desc',
    icon: <IcoActivity/>,
    key: 'aorta-vascular',
    tags: ['Aorta 3D', 'Centerline', 'AAA/TAA', 'EVAR', 'Neck Ø', 'Fenestration'],
  },
  {
    route: { kind: 'ct', panel: 'lv-adas', title: 'mod.lvadas' },
    group: 'cross',
    name: 'mod.lvadas',
    desc: 'mod.lvadas.desc',
    icon: <IcoHeart/>,
    key: 'lvadas',
    tags: ['17-segment', 'Scar core', 'Border zone', 'Bullseye', 'VT substrate', 'Endo / Epi'],
  },
  {
    route: { kind: 'ct', panel: 'hand-mr', title: 'mod.handmr' },
    group: 'cross',
    name: 'mod.handmr',
    desc: 'mod.handmr.desc',
    icon: <IcoScan/>,
    key: 'handmr',
    tags: ['MR MPR', 'W/L preset', 'Length', 'Angle', 'Annotate', 'Thin slab'],
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
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (!window.confirm('Önbelleği temizleyip sayfayı yenilemek istediğinize emin misiniz?')) return;
    setIsRefreshing(true);
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister().catch(() => null)));
      }
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k).catch(() => null)));
      }
    } catch (err) {
      console.warn('[refresh]', err);
    }
    const url = new URL(location.href);
    url.searchParams.set('_r', Date.now().toString(36));
    window.location.replace(url.toString());
  };

  // Visitor analytics (ipapi geo + abacus counters + world map) removed —
  // no third-party tracking; the app stays fully local.

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
          <button 
            className="nd-icon-btn" 
            onClick={handleRefresh} 
            title="Önbelleği Temizle ve Yenile" 
            aria-label="refresh"
            style={isRefreshing ? { animation: 'spin 1s linear infinite' } : {}}
          >
            <IcoRefresh/>
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
                className="nd-hero-link nd-hero-link-flow"
                href="https://flow.drtr.uk/"
                target="_blank"
                rel="noopener noreferrer"
                title="Flow — tarayıcıda PRISMA akış şeması ve grafiksel özet hazırlama aracı"
              >
                <span className="nd-hero-link-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <rect x="3" y="3" width="7" height="7" rx="1.5"/>
                    <rect x="14" y="3" width="7" height="7" rx="1.5"/>
                    <rect x="3" y="14" width="7" height="7" rx="1.5"/>
                    <rect x="14" y="14" width="7" height="7" rx="1.5"/>
                    <path d="M10 6.5h4"/>
                    <path d="M17.5 10v4"/>
                    <path d="M10 17.5h4"/>
                    <path d="M6.5 10v4"/>
                  </svg>
                </span>
                <span className="nd-hero-link-text">
                  <b>
                    Flow <span className="nd-hero-link-pill">Yeni</span>
                  </b>
                  Akış şeması & grafiksel özet hazırlama aracı. PRISMA 2020, tarayıcıda, kurulum yok. <span className="nd-hero-link-host">flow.drtr.uk ↗</span>
                </span>
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
