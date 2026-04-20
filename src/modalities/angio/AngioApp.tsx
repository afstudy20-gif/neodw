import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import { DicomDropzone } from './components/DicomDropzone';
import { SeriesPanel } from './components/SeriesPanel';
import { Toolbar } from './components/Toolbar';
import { AngioViewer } from './components/AngioViewer';
import { QCAWorkspace } from './components/QCAWorkspace';
import { loadDicomFiles, preloadImages, type DicomSeriesInfo } from './core/dicomLoader';
import { initCornerstone } from './core/initCornerstone';
import { destroyToolGroup, setupToolGroup } from './core/toolManager';
import { createInitialSession, qcaReducer, type QCASession, type QCAAction } from './qca/QCATypes';
import angioModuleCss from './angio-module.css?inline';
import { useTheme } from '../../theme/ThemeProvider';
import { expandAndFilterDicom } from '../../shared/fileIntake';

function ThemeToggleBtn() {
  const { theme, toggle } = useTheme();
  return (
    <button className="secondary-btn" onClick={toggle} title="Tema" aria-label="theme">
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}

const RENDERING_ENGINE_ID = 'angioRenderingEngine';
const VIEWPORT_ID = 'angio-main';

interface AngioAppProps {
  onBack?: () => void;
  initialFiles?: File[];
}

export default function AngioApp({ onBack, initialFiles }: AngioAppProps = {}) {
  const renderingEngineRef = useRef<cornerstone.RenderingEngine | null>(null);
  const initialFilesConsumedRef = useRef(false);

  const [isInitialized, setIsInitialized] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [seriesList, setSeriesList] = useState<DicomSeriesInfo[]>([]);
  const [activeSeries, setActiveSeries] = useState<DicomSeriesInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingProgress, setLoadingProgress] = useState('');
  const [qcaActive, setQcaActive] = useState(false);
  const [currentFrame, setCurrentFrame] = useState(0);

  const [qcaSession, qcaDispatchRaw] = useReducer(qcaReducer, undefined, createInitialSession);
  const undoStackRef = useRef<QCASession[]>([]);
  const MAX_UNDO = 50;

  const qcaDispatch = useCallback((action: QCAAction) => {
    // Don't push undo for trivial/frequent actions
    const skipUndo = action.type === 'SET_CHART_MODE' || action.type === 'SET_ANALYSIS_TAB' || action.type === 'SET_INTERACTION' || action.type === 'SET_FRAME';
    if (!skipUndo) {
      undoStackRef.current = [...undoStackRef.current.slice(-(MAX_UNDO - 1)), qcaSession];
    }
    qcaDispatchRaw(action);
  }, [qcaSession]);

  const qcaUndo = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    const prev = stack[stack.length - 1];
    undoStackRef.current = stack.slice(0, -1);
    qcaDispatchRaw({ type: 'RESTORE', state: prev });
  }, []);

  useEffect(() => {
    const el = document.createElement('style');
    el.setAttribute('data-neodw-module', 'angio');
    el.textContent = angioModuleCss;
    document.head.appendChild(el);
    return () => el.remove();
  }, []);

  // Ctrl+Z undo handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        e.preventDefault();
        qcaUndo();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [qcaUndo]);

  useEffect(() => {
    if (!isInitialized || initialFilesConsumedRef.current) return;
    if (initialFiles && initialFiles.length > 0) {
      initialFilesConsumedRef.current = true;
      void handleFilesLoaded(initialFiles);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInitialized]);

  useEffect(() => {
    let mounted = true;

    initCornerstone()
      .then(() => {
        if (!mounted) return;
        renderingEngineRef.current = new cornerstone.RenderingEngine(RENDERING_ENGINE_ID);
        setIsInitialized(true);
      })
      .catch((initError: Error) => {
        if (!mounted) return;
        setError(`Failed to initialize Cornerstone: ${initError.message}`);
      });

    return () => {
      mounted = false;
      destroyToolGroup();
      renderingEngineRef.current?.destroy();
    };
  }, []);

  // Sync current frame from viewport
  useEffect(() => {
    const engine = renderingEngineRef.current;
    if (!engine || !activeSeries) return;

    const vp = engine.getViewport(VIEWPORT_ID);
    if (!vp?.element) return;

    const handleRendered = () => {
      const svp = engine.getViewport(VIEWPORT_ID) as cornerstone.Types.IStackViewport | undefined;
      if (svp && 'getCurrentImageIdIndex' in svp) {
        setCurrentFrame(svp.getCurrentImageIdIndex());
      }
    };

    vp.element.addEventListener(cornerstone.Enums.Events.IMAGE_RENDERED, handleRendered);
    return () => vp.element.removeEventListener(cornerstone.Enums.Events.IMAGE_RENDERED, handleRendered);
  }, [activeSeries]);

  async function handleFilesLoaded(files: File[]) {
    if (!isInitialized) return;

    setIsLoading(true);
    setError(null);
    setLoadingProgress('Expanding archives / scanning DICOM...');

    try {
      const expanded = await expandAndFilterDicom(files);
      if (expanded.length === 0) {
        setError('No DICOM files found (including inside ZIP/RAR).');
        setIsLoading(false);
        return;
      }
      setLoadingProgress('Parsing DICOM files...');
      const series = await loadDicomFiles(expanded);
      setSeriesList(series);

      if (series.length === 0) {
        setError('No DICOM series found in the selected files.');
        return;
      }

      await loadSeries(series[0]);
    } catch (loadError: any) {
      setError(`Failed to load DICOM files: ${loadError.message}`);
    } finally {
      setIsLoading(false);
    }
  }

  async function loadSeries(series: DicomSeriesInfo) {
    const engine = renderingEngineRef.current;
    if (!engine) return;

    setActiveSeries(series);
    setIsLoading(true);
    setLoadingProgress(`Loading images: 0/${series.imageIds.length}`);
    setQcaActive(false);
    qcaDispatch({ type: 'RESET' });

    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

    let stage = 'initialization';
    try {
      stage = 'destroyToolGroup';
      destroyToolGroup();
      // Skip cornerstone.cache.purgeCache() on a series switch: the
      // dicom-image-loader fileManager registers blob URLs up front; a
      // blanket purge revokes those blobs and the in-flight setStack()
      // loads immediately error out with "The image was purged from the
      // cache before it completed loading", leaving the viewport black.
      // Cache pressure is already bounded by the loader's own LRU policy.

      stage = 'resolveViewportElement';
      const viewportElement = document.getElementById('viewport-angio') as HTMLDivElement | null;
      if (!viewportElement) throw new Error('Viewport element not found in DOM');

      stage = 'setViewports';
      engine.setViewports([
        {
          viewportId: VIEWPORT_ID,
          type: cornerstone.Enums.ViewportType.STACK,
          element: viewportElement,
          defaultOptions: { background: [0, 0, 0] as cornerstone.Types.RGB },
        },
      ]);

      stage = 'setupToolGroup';
      setupToolGroup(RENDERING_ENGINE_ID, VIEWPORT_ID);

      stage = 'setStack';
      setLoadingProgress(`Setting up ${series.imageIds.length} frames...`);
      const viewport = engine.getViewport(VIEWPORT_ID) as cornerstone.Types.IStackViewport;
      await viewport.setStack(series.imageIds);
      try { await viewport.setImageIdIndex(0); } catch { /* ignore */ }

      try { viewport.resetProperties(); } catch { /* ignore */ }
      // resetCamera recenters the image in the viewport. Without this the
      // camera can keep a stale focal point or zoom from a previous series,
      // which parks the new frame entirely outside the visible rect — the
      // canvas paints the background color and looks pitch black.
      try { viewport.resetCamera(); } catch { /* ignore */ }
      try { engine.resize(true, true); } catch { /* ignore */ }

      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      viewport.render();

      // Diagnostic: dump actual viewport + canvas state so a black frame
      // can be attributed to the right layer on the next report.
      try {
        const el = document.getElementById('viewport-angio');
        const canvas = el?.querySelector('canvas') as HTMLCanvasElement | null;
        const props = viewport.getProperties();
        const cam = viewport.getCamera();
        console.info('[loadSeries:render]', {
          elementSize: el ? { w: el.clientWidth, h: el.clientHeight } : null,
          canvasSize: canvas ? { w: canvas.width, h: canvas.height } : null,
          voi: props?.voiRange,
          invert: props?.invert,
          currentIndex: viewport.getCurrentImageIdIndex?.(),
          parallelScale: cam?.parallelScale,
        });
      } catch { /* ignore */ }

      // If DICOM already provides a usable VOI, keep it (native display).
      // Only derive a fallback VOI when Cornerstone's default leaves the
      // frame black — use a very wide 0.2-99.8 percentile band so we don't
      // crush contrast or darken the image.
      try {
        const existing = viewport.getProperties?.()?.voiRange;
        const hasGoodVoi = existing && Number.isFinite(existing.lower) && Number.isFinite(existing.upper) && existing.upper > existing.lower;

        const imageId = series.imageIds[0];
        const image: any = await cornerstone.imageLoader.loadAndCacheImage(imageId);
        const invert = image?.photometricInterpretation === 'MONOCHROME1';
        if (invert) {
          viewport.setProperties({ invert: true });
        }

        if (!hasGoodVoi) {
          const pixels: ArrayLike<number> | undefined =
            image?.getPixelData?.() ?? image?.imageFrame?.pixelData;
          if (pixels && pixels.length > 0) {
            const sampleStride = Math.max(1, Math.floor(pixels.length / 100000));
            const sample: number[] = [];
            for (let i = 0; i < pixels.length; i += sampleStride) sample.push(pixels[i]);
            sample.sort((a, b) => a - b);
            const lowerIdx = Math.floor(sample.length * 0.002);
            const upperIdx = Math.floor(sample.length * 0.998);
            const lower = sample[lowerIdx];
            const upper = sample[upperIdx];
            if (Number.isFinite(lower) && Number.isFinite(upper) && upper > lower) {
              viewport.setProperties({ voiRange: { lower, upper } });
            }
          }
        }
        viewport.render();
      } catch (voiErr) {
        console.warn('[loadSeries] VOI auto-compute failed; using Cornerstone default', voiErr);
      }
    } catch (seriesError: any) {
      console.error(`[loadSeries:${stage}]`, seriesError);
      setError(`Failed to load series at ${stage}: ${seriesError.message}`);
    } finally {
      setIsLoading(false);
    }
  }

  function handleReset() {
    setError(null);

    // Clear all annotations (measurements, QCA lines, labels) from the viewport
    try {
      const anno: any = (cornerstoneTools as any).annotation?.state;
      const mgr = anno?.getAnnotationManager?.();
      if (mgr?.removeAllAnnotations) {
        mgr.removeAllAnnotations();
      } else if (anno?.removeAllAnnotations) {
        anno.removeAllAnnotations();
      }
    } catch (e) {
      console.warn('[angio reset] annotation clear failed', e);
    }

    // Reset QCA workspace state
    qcaDispatch({ type: 'RESET' });
    setQcaActive(false);

    const engine = renderingEngineRef.current;
    if (!engine) return;

    const viewport = engine.getViewport(VIEWPORT_ID) as cornerstone.Types.IStackViewport | undefined;
    if (viewport) {
      viewport.resetCamera();
      viewport.resetProperties();
      viewport.setProperties({ invert: false });
      viewport.render();
    }
  }

  function toggleQCA() {
    if (qcaActive) {
      setQcaActive(false);
      qcaDispatch({ type: 'RESET' });
    } else {
      setQcaActive(true);
      qcaDispatch({ type: 'RESET' });
    }
  }

  function openFilePicker() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = (event) => {
      const target = event.target as HTMLInputElement;
      if (target.files?.length) handleFilesLoaded(Array.from(target.files));
    };
    input.click();
  }

  function openFolderPicker() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    (input as HTMLInputElement & { webkitdirectory?: boolean }).webkitdirectory = true;
    input.onchange = (event) => {
      const target = event.target as HTMLInputElement;
      if (target.files?.length) handleFilesLoaded(Array.from(target.files));
    };
    input.click();
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="header-kicker">Angiography Suite</p>
          <h1>QCA + vFFR Workbench</h1>
        </div>
        <div className="header-meta">
          {activeSeries ? (
            <>
              <span>{activeSeries.patientName}</span>
              <span className="dot">&bull;</span>
              <span>{activeSeries.studyDescription}</span>
              <span className="dot">&bull;</span>
              <span>{activeSeries.modality} / {activeSeries.numImages} frames</span>
            </>
          ) : (
            <span>No active study</span>
          )}
        </div>
        <div className="header-actions">
          {onBack && (
            <button className="secondary-btn" onClick={onBack}>{'<- Modality'}</button>
          )}
          <button className="secondary-btn" onClick={openFilePicker} disabled={isLoading}>Open Files</button>
          <button className="secondary-btn" onClick={openFolderPicker} disabled={isLoading}>Open Folder</button>
          <ThemeToggleBtn />
        </div>
      </header>

      {activeSeries && (
        <Toolbar
          renderingEngineId={RENDERING_ENGINE_ID}
          viewportId={VIEWPORT_ID}
          onReset={handleReset}
          qcaActive={qcaActive}
          onToggleQCA={toggleQCA}
        />
      )}

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {!activeSeries ? (
        <DicomDropzone onFilesLoaded={handleFilesLoaded} isLoading={isLoading} />
      ) : (
        <main className={`workspace-layout ${qcaActive ? 'with-qca' : ''}`}>
          <SeriesPanel
            seriesList={seriesList}
            activeSeriesUID={activeSeries.seriesInstanceUID}
            onSelectSeries={loadSeries}
            isLoading={isLoading}
          />
          <div className="viewer-column">
            <AngioViewer
              renderingEngineId={RENDERING_ENGINE_ID}
              viewportId={VIEWPORT_ID}
              imageCount={activeSeries.numImages}
              qcaSession={qcaActive ? qcaSession : null}
              qcaDispatch={qcaActive ? qcaDispatch : null}
              seriesIndex={seriesList.indexOf(activeSeries)}
              seriesCount={seriesList.length}
              onPrevSeries={() => {
                const idx = seriesList.indexOf(activeSeries);
                if (idx > 0) loadSeries(seriesList[idx - 1]);
              }}
              onNextSeries={() => {
                const idx = seriesList.indexOf(activeSeries);
                if (idx < seriesList.length - 1) loadSeries(seriesList[idx + 1]);
              }}
            />
          </div>
          {qcaActive && (
            <QCAWorkspace
              session={qcaSession}
              dispatch={qcaDispatch}
              currentFrame={currentFrame}
              imageCount={activeSeries.numImages}
            />
          )}
        </main>
      )}

      {isLoading && (
        <div className="loading-overlay">
          <div className="loading-card">
            <div className="spinner" />
            <p>{loadingProgress || 'Loading angiography...'}</p>
          </div>
        </div>
      )}
    </div>
  );
}
