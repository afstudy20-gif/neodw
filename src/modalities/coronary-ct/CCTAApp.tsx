import { useEffect, useRef, useState } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import coronaryModuleCss from './coronary-module.css?inline';
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
import { DicomDropzone } from './components/DicomDropzone';
import { SeriesPanel } from './components/SeriesPanel';
import { Toolbar } from './components/Toolbar';
import { ViewportGrid } from './components/ViewportGrid';
import { CoronaryWorkspace } from './components/CoronaryWorkspace';
import { createVolume, loadDicomFiles, type DicomSeriesInfo } from './core/dicomLoader';
import { initCornerstone } from './core/initCornerstone';
import { attachAdvancedInteractions, destroyToolGroups, resetCrosshairsToCenter, setupToolGroups } from './core/toolManager';

const RENDERING_ENGINE_ID = 'coronaryRenderingEngine';
const VOLUME_ID = 'cornerstoneStreamingImageVolume:coronaryVolume';
const ORTHO_VIEWPORT_IDS = ['axial', 'sagittal', 'coronal'] as const;
const VIEWPORT_IDS = ORTHO_VIEWPORT_IDS;

interface CtAppProps {
  onBack?: () => void;
  initialFiles?: File[];
}

export default function CtApp({ onBack, initialFiles }: CtAppProps = {}) {
  const renderingEngineRef = useRef<cornerstone.RenderingEngine | null>(null);
  const initialFilesConsumedRef = useRef(false);
  const advancedInteractionsCleanupRef = useRef<(() => void) | null>(null);

  const [isInitialized, setIsInitialized] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [seriesList, setSeriesList] = useState<DicomSeriesInfo[]>([]);
  const [activeSeries, setActiveSeries] = useState<DicomSeriesInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingProgress, setLoadingProgress] = useState('');
  const [workspaceResetToken, setWorkspaceResetToken] = useState(0);
  const [viewportSetupToken, setViewportSetupToken] = useState(0);

  useEffect(() => {
    const el = document.createElement('style');
    el.setAttribute('data-neodw-module', 'coronary-ct');
    el.textContent = coronaryModuleCss;
    document.head.appendChild(el);
    return () => el.remove();
  }, []);

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
        if (!mounted) {
          return;
        }
        renderingEngineRef.current = new cornerstone.RenderingEngine(RENDERING_ENGINE_ID);
        setIsInitialized(true);
      })
      .catch((initError: Error) => {
        if (!mounted) {
          return;
        }
        setError(`Failed to initialize Cornerstone: ${initError.message}`);
      });

    return () => {
      mounted = false;
      advancedInteractionsCleanupRef.current?.();
      advancedInteractionsCleanupRef.current = null;
      destroyToolGroups();
      renderingEngineRef.current?.destroy();
    };
  }, []);

  async function handleFilesLoaded(files: File[]) {
    if (!isInitialized) {
      return;
    }

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
    if (!engine) {
      return;
    }

    setActiveSeries(series);
    setIsLoading(true);
    setLoadingProgress(`Loading images: 0/${series.imageIds.length}`);

    // Yield to let React flush the viewport grid into the DOM
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

    let stage = 'initialization';
    try {
      stage = 'cleanupAdvancedInteractions';
      advancedInteractionsCleanupRef.current?.();
      advancedInteractionsCleanupRef.current = null;
      stage = 'destroyToolGroups';
      destroyToolGroups();
      stage = 'purgeCache';
      cornerstone.cache.purgeCache();

      stage = 'resolveViewportElements';
      const axialElement = document.getElementById('viewport-axial') as HTMLDivElement | null;
      const sagittalElement = document.getElementById('viewport-sagittal') as HTMLDivElement | null;
      const coronalElement = document.getElementById('viewport-coronal') as HTMLDivElement | null;

      if (!axialElement || !sagittalElement || !coronalElement) {
        throw new Error('Viewport elements not found in DOM');
      }

      stage = 'setViewports';
      engine.setViewports([
        {
          viewportId: 'axial',
          type: cornerstone.Enums.ViewportType.ORTHOGRAPHIC,
          element: axialElement,
          defaultOptions: { orientation: cornerstone.Enums.OrientationAxis.AXIAL },
        },
        {
          viewportId: 'sagittal',
          type: cornerstone.Enums.ViewportType.ORTHOGRAPHIC,
          element: sagittalElement,
          defaultOptions: { orientation: cornerstone.Enums.OrientationAxis.SAGITTAL },
        },
        {
          viewportId: 'coronal',
          type: cornerstone.Enums.ViewportType.ORTHOGRAPHIC,
          element: coronalElement,
          defaultOptions: { orientation: cornerstone.Enums.OrientationAxis.CORONAL },
        },
      ]);

      stage = 'setupToolGroups';
      setupToolGroups(RENDERING_ENGINE_ID);

      stage = 'createVolume';
      await createVolume(VOLUME_ID, series.imageIds, (loaded, total) => {
        setLoadingProgress(`Loading images: ${loaded}/${total}`);
      });

      stage = 'setVolumesForViewports';
      await cornerstone.setVolumesForViewports(engine, [{ volumeId: VOLUME_ID }], [...VIEWPORT_IDS]);

      stage = 'configureViewports';
      for (const viewportId of ORTHO_VIEWPORT_IDS) {
        const viewport = engine.getViewport(viewportId) as cornerstone.Types.IVolumeViewport | undefined;
        if (!viewport) {
          continue;
        }
        viewport.setProperties({
          voiRange: {
            lower: 300 - 600 / 2,
            upper: 300 + 600 / 2,
          },
        });
        viewport.resetCamera();
      }

      stage = 'renderViewports';
      engine.renderViewports([...VIEWPORT_IDS]);
      setViewportSetupToken((value) => value + 1);

      // Initialize crosshairs to volume center so all viewports start synchronised
      stage = 'initCrosshairs';
      try {
        resetCrosshairsToCenter(RENDERING_ENGINE_ID, VOLUME_ID);
      } catch {
        // Non-fatal: crosshairs are optional
      }

      advancedInteractionsCleanupRef.current = attachAdvancedInteractions(RENDERING_ENGINE_ID);
    } catch (seriesError: any) {
      console.error(`[loadSeries:${stage}]`, seriesError);
      setError(`Failed to load series at ${stage}: ${seriesError.message}`);
    } finally {
      setIsLoading(false);
    }
  }

  function openFilePicker() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = (event) => {
      const target = event.target as HTMLInputElement;
      if (target.files?.length) {
        handleFilesLoaded(Array.from(target.files));
      }
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
      if (target.files?.length) {
        handleFilesLoaded(Array.from(target.files));
      }
    };
    input.click();
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="header-kicker">Coronary Research Suite</p>
          <h1>QCA + CT-FFR Workbench</h1>
        </div>
        <div className="header-meta">
          {activeSeries ? (
            <>
              <span>{activeSeries.patientName}</span>
              <span className="dot">•</span>
              <span>{activeSeries.studyDescription}</span>
              <span className="dot">•</span>
              <span>
                {activeSeries.modality} / {activeSeries.numImages} images
              </span>
            </>
          ) : (
            <span>No active study</span>
          )}
        </div>
        <div className="header-actions">
          {onBack && (
            <button className="secondary-btn" onClick={onBack}>{'<- Modality'}</button>
          )}
          <button className="secondary-btn" onClick={openFilePicker} disabled={isLoading}>
            Open Files
          </button>
          <button className="secondary-btn" onClick={openFolderPicker} disabled={isLoading}>
            Open Folder
          </button>
          <ThemeToggleBtn />
        </div>
      </header>

      {activeSeries && (
        <Toolbar
          renderingEngineId={RENDERING_ENGINE_ID}
          volumeId={VOLUME_ID}
          onReset={() => {
            setWorkspaceResetToken((value) => value + 1);
            setError(null);
          }}
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
        <main className="workspace-layout">
          <SeriesPanel
            seriesList={seriesList}
            activeSeriesUID={activeSeries.seriesInstanceUID}
            onSelectSeries={loadSeries}
            isLoading={isLoading}
          />
          <div className="viewer-column">
            <ViewportGrid
              renderingEngineId={RENDERING_ENGINE_ID}
              setupToken={viewportSetupToken}
            />
          </div>
          <CoronaryWorkspace
            renderingEngineId={RENDERING_ENGINE_ID}
            volumeId={VOLUME_ID}
            series={activeSeries}
            resetToken={workspaceResetToken}
          />
        </main>
      )}

      {isLoading && (
        <div className="loading-overlay">
          <div className="loading-card">
            <div className="spinner" />
            <p>{loadingProgress || 'Loading coronary CT...'}</p>
          </div>
        </div>
      )}
    </div>
  );
}
