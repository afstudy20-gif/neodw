import { lazy, Suspense, useState } from 'react';
import Welcome from './shell/Welcome';
import { I18nProvider, useI18n } from './shell/i18n';
import { ThemeProvider } from './theme/ThemeProvider';
import type { CtInitialPanel } from './modalities/ct/CtApp';

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
  const { t } = useI18n();

  function handleBack() {
    setSession(null);
  }

  function handleLaunch(route: ModalityRoute, files?: File[]) {
    setSession({ route, files });
  }

  if (!session) {
    return <Welcome onLaunch={handleLaunch} />;
  }

  return (
    <Suspense fallback={<div style={{ padding: 40, color: 'var(--nd-text)' }}>Loading…</div>}>
      {session.route.kind === 'ct' && (
        <CtApp
          onBack={handleBack}
          initialFiles={session.files}
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
  );
}
