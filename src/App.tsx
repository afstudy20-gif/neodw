import { Component, lazy, Suspense, useState, useEffect, type ReactNode } from 'react';
import Welcome from './shell/Welcome';
import { I18nProvider, useI18n } from './shell/i18n';
import { ThemeProvider } from './theme/ThemeProvider';
import type { CtInitialPanel } from './modalities/ct/CtApp';
import type { DicomSeriesInfo } from './modalities/ct/core/dicomLoader';
import { parseDicomWebUrlParams, loadDicomWebStudy } from './shared/dicom/dicomwebLoader';
import { initCornerstone } from './shared/core/cornerstone';

// Catches errors from React.lazy chunk loads (e.g., stale index.html after
// a fresh deploy 404s the hashed chunk). Without this the Suspense fallback
// would hang forever — main.tsx's chunk-reload path only fires if `root`
// has no children, which is false once App has mounted.
class LazyChunkBoundary extends Component<
  { children: ReactNode; onReset: () => void },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) {
    console.error('[App] lazy chunk load failed', error);
  }
  render() {
    if (this.state.error) {
      const isChunk = /Failed to fetch dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk/i
        .test(this.state.error.message);
      return (
        <div style={{ padding: 40, color: 'var(--nd-text)', fontFamily: 'system-ui' }}>
          <h2>Failed to load module</h2>
          <p style={{ opacity: 0.8 }}>
            {isChunk
              ? 'A new build was probably deployed while this tab was open. Reload to pick it up.'
              : this.state.error.message}
          </p>
          <button
            style={{ padding: '8px 16px', marginRight: 8 }}
            onClick={() => {
              const u = new URL(window.location.href);
              u.searchParams.set('_v', String(Date.now()));
              window.location.replace(u.toString());
            }}
          >
            Reload
          </button>
          <button
            style={{ padding: '8px 16px' }}
            onClick={() => { this.setState({ error: null }); this.props.onReset(); }}
          >
            Back to home
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const CtApp = lazy(() => import('./modalities/ct/CtApp'));
const CCTAApp = lazy(() => import('./modalities/coronary-ct/CCTAApp'));
const AngioApp = lazy(() => import('./modalities/angio/AngioApp'));
const EchoApp = lazy(() => import('./modalities/echo/EchoApp'));

export type ModalityRoute =
  | { kind: 'ct'; panel: CtInitialPanel; title: string }
  | { kind: 'ccta' }
  | { kind: 'angio' }
  | { kind: 'echo' }
  | { kind: 'xray' };

interface Session {
  route: ModalityRoute;
  files?: File[];
  remoteSeries?: DicomSeriesInfo[];
}

export default function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <Shell />
      </I18nProvider>
    </ThemeProvider>
  );
}

function Shell() {
  const [session, setSession] = useState<Session | null>(null);
  const [remoteLoad, setRemoteLoad] = useState<{ status: 'loading' | 'error'; message: string } | null>(null);
  const { t } = useI18n();

  function handleBack() {
    setSession(null);
  }

  function handleLaunch(route: ModalityRoute, files?: File[]) {
    setSession({ route, files });
  }

  // Remote-share bootstrap. When the URL carries ?dicomweb=...&study=...
  // (plus #token=...) we skip the Welcome screen and pull the study from the
  // configured DICOMweb endpoint before mounting the CT viewer.
  useEffect(() => {
    const params = parseDicomWebUrlParams();
    if (!params) return;
    let cancelled = false;
    setRemoteLoad({ status: 'loading', message: 'Fetching remote study…' });
    (async () => {
      try {
        await initCornerstone();
        const series = await loadDicomWebStudy({
          baseUrl: params.dicomweb,
          studyUID: params.study,
          token: params.token,
          modalities: params.modality === 'mr' ? ['MR'] : ['CT', 'MR'],
        });
        if (cancelled) return;
        if (series.length === 0) {
          setRemoteLoad({ status: 'error', message: 'No CT/MR series found in this study.' });
          return;
        }
        setSession({
          route: { kind: 'ct', panel: null, title: 'mod.ct' },
          remoteSeries: series,
        });
        setRemoteLoad(null);
      } catch (err: any) {
        if (cancelled) return;
        setRemoteLoad({ status: 'error', message: err?.message || 'Remote study load failed' });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (remoteLoad) {
    return (
      <div style={{ padding: 40, color: 'var(--nd-text)', fontFamily: 'system-ui' }}>
        <h2>{remoteLoad.status === 'loading' ? 'Loading remote study' : 'Could not load study'}</h2>
        <p style={{ opacity: 0.8 }}>{remoteLoad.message}</p>
      </div>
    );
  }

  if (!session) {
    return <Welcome onLaunch={handleLaunch} />;
  }

  return (
    <LazyChunkBoundary onReset={handleBack}>
    <Suspense fallback={<div style={{ padding: 40, color: 'var(--nd-text)' }}>Loading…</div>}>
      {session.route.kind === 'ct' && (
        <CtApp
          onBack={handleBack}
          initialFiles={session.files}
          initialSeries={session.remoteSeries}
          initialPanel={session.route.panel}
          title={t(session.route.title)}
        />
      )}
      {session.route.kind === 'ccta' && (
        <CCTAApp onBack={handleBack} initialFiles={session.files} />
      )}
      {session.route.kind === 'angio' && (
        <AngioApp onBack={handleBack} initialFiles={session.files} />
      )}
      {session.route.kind === 'echo' && (
        <EchoApp onBack={handleBack} initialFiles={session.files} title={t('mod.echo')} mode="echo" />
      )}
      {session.route.kind === 'xray' && (
        <EchoApp onBack={handleBack} initialFiles={session.files} title={t('mod.xray')} mode="xray" />
      )}
    </Suspense>
    </LazyChunkBoundary>
  );
}
