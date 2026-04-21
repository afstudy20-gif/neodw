import { useCallback, useEffect, useRef, useState } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import dicomImageLoader from '@cornerstonejs/dicom-image-loader';
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
import { initCornerstone, applyLinearInterpolation } from '../../shared/core/cornerstone';
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
  const [exporting, setExporting] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playFps, setPlayFps] = useState(15);

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
      // Prefer native DICOM WindowCenter/Width (read from first image's
      // metadata). Soft tissue (WC 40 WW 400) fallback when the series
      // has no explicit VOI. Avoid the old hardcoded bone preset that
      // made most scans look dark on load.
      let nativeVoi: { lower: number; upper: number } | null = null;
      try {
        const firstImageId = series.imageIds[0];
        if (firstImageId) {
          const voiMod: any = cornerstone.metaData.get('voiLutModule', firstImageId);
          const wc = Array.isArray(voiMod?.windowCenter) ? Number(voiMod.windowCenter[0]) : Number(voiMod?.windowCenter);
          const ww = Array.isArray(voiMod?.windowWidth) ? Number(voiMod.windowWidth[0]) : Number(voiMod?.windowWidth);
          if (Number.isFinite(wc) && Number.isFinite(ww) && ww > 0) {
            nativeVoi = { lower: wc - ww / 2, upper: wc + ww / 2 };
          }
        }
      } catch { /* metadata may not be ready; fall back */ }
      if (!nativeVoi) {
        nativeVoi = { lower: 40 - 400 / 2, upper: 40 + 400 / 2 };
      }
      for (const viewportId of ORTHO_VIEWPORT_IDS) {
        const viewport = engine.getViewport(viewportId) as cornerstone.Types.IVolumeViewport | undefined;
        if (!viewport) {
          continue;
        }
        viewport.setProperties({ voiRange: nativeVoi });
        applyLinearInterpolation(viewport);
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

      // Start axial viewing at the first slice (top of the volume) rather
      // than mid-stack. resetCamera + crosshair-center both settle on the
      // volume center, which is typically around the heart/diaphragm for
      // chest CT; users expect to scroll top→bottom.
      stage = 'jumpAxialToStart';
      try {
        const axialEl = document.getElementById('viewport-axial') as HTMLDivElement | null;
        if (axialEl) {
          await cornerstone.utilities.jumpToSlice(axialEl, { imageIndex: 0, volumeId: VOLUME_ID });
          const axialVp = engine.getViewport('axial') as cornerstone.Types.IVolumeViewport | undefined;
          axialVp?.render();
        }
      } catch { /* non-fatal */ }
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

  useEffect(() => {
    if (!playing || !activeSeries) return;
    const engine = renderingEngineRef.current;
    if (!engine) return;
    const axialEl = document.getElementById('viewport-axial') as HTMLDivElement | null;
    if (!axialEl) return;
    const vp = engine.getViewport('axial') as cornerstone.Types.IVolumeViewport | undefined;
    if (!vp) return;
    const total = typeof (vp as any).getNumberOfSlices === 'function' ? (vp as any).getNumberOfSlices() : activeSeries.imageIds.length;
    if (!total || total < 2) { setPlaying(false); return; }

    let cancelled = false;
    let idx = typeof (vp as any).getSliceIndex === 'function' ? (vp as any).getSliceIndex() : 0;
    const tick = async () => {
      if (cancelled) return;
      idx = (idx + 1) % total;
      try {
        await cornerstone.utilities.jumpToSlice(axialEl, { imageIndex: idx, volumeId: VOLUME_ID });
      } catch { /* ignore */ }
      vp.render();
    };
    const handle = window.setInterval(() => { void tick(); }, Math.max(33, 1000 / Math.max(1, playFps)));
    return () => { cancelled = true; window.clearInterval(handle); };
  }, [playing, playFps, activeSeries]);

  const getAxialCanvas = useCallback((): HTMLCanvasElement | null => {
    const host = document.getElementById('viewport-axial');
    if (!host) return null;
    return (host.querySelector('canvas.cornerstone-canvas') ?? host.querySelector('canvas')) as HTMLCanvasElement | null;
  }, []);

  const gotoSeries = useCallback((delta: number) => {
    if (!activeSeries) return;
    const idx = seriesList.findIndex((s) => s.seriesInstanceUID === activeSeries.seriesInstanceUID);
    const next = seriesList[idx + delta];
    if (next) void loadSeries(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSeries, seriesList]);

  const saveAxialFrameImage = useCallback(() => {
    const canvas = getAxialCanvas();
    if (!canvas) return;
    try {
      const url = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      const name = (activeSeries?.seriesDescription || 'ccta').replace(/[^a-zA-Z0-9]/g, '_');
      a.download = `${name}_axial.png`;
      a.href = url;
      a.click();
    } catch (e) { console.warn('[CCTA saveImage] failed', e); }
  }, [getAxialCanvas, activeSeries]);

  const saveAxialVideo = useCallback(async () => {
    const engine = renderingEngineRef.current;
    const canvas = getAxialCanvas();
    if (!engine || !canvas || !activeSeries) return;
    const vp = engine.getViewport('axial') as cornerstone.Types.IVolumeViewport | undefined;
    if (!vp) return;
    const totalSlices = typeof (vp as any).getNumberOfSlices === 'function' ? (vp as any).getNumberOfSlices() : activeSeries.imageIds.length;
    if (!totalSlices || totalSlices < 2) return;
    const axialEl = document.getElementById('viewport-axial') as HTMLDivElement | null;
    if (!axialEl) return;

    setExporting('Hazırlanıyor...');
    const fps = 15;
    const stream = canvas.captureStream(fps);
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 });
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    const done = new Promise<void>((r) => { recorder.onstop = () => r(); });
    recorder.start();

    try {
      for (let i = 0; i < totalSlices; i++) {
        setExporting(`Slice ${i + 1}/${totalSlices}`);
        try {
          await cornerstone.utilities.jumpToSlice(axialEl, { imageIndex: i, volumeId: VOLUME_ID });
        } catch { /* best-effort */ }
        vp.render();
        await new Promise((r) => setTimeout(r, 1000 / fps));
      }
    } finally {
      recorder.stop();
      await done;
    }
    const blob = new Blob(chunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const name = (activeSeries.seriesDescription || 'ccta').replace(/[^a-zA-Z0-9]/g, '_');
    a.download = `${name}_axial_${totalSlices}fr.webm`;
    a.href = url;
    a.click();
    URL.revokeObjectURL(url);
    setExporting(null);
  }, [getAxialCanvas, activeSeries]);

  const exportSeriesAsDicom = useCallback(async (series: DicomSeriesInfo) => {
    const fm: any = (dicomImageLoader as any).wadouri?.fileManager;
    if (!fm) { alert('DICOM export desteklenmiyor.'); return; }
    const baseName = (series.seriesDescription || 'ccta').replace(/[^a-zA-Z0-9]/g, '_');
    const single = series.imageIds.length === 1;
    try {
      setExporting(`DICOM 0/${series.imageIds.length}`);
      for (let i = 0; i < series.imageIds.length; i++) {
        const id = series.imageIds[i].split('?')[0];
        const m = id.match(/^dicomfile:(\d+)$/);
        if (!m) continue;
        const file = fm.get(Number(m[1]));
        if (!file) continue;
        const a = document.createElement('a');
        a.download = single ? `${baseName}.dcm` : `${baseName}_${String(i + 1).padStart(4, '0')}.dcm`;
        a.href = URL.createObjectURL(file);
        a.click();
        URL.revokeObjectURL(a.href);
        if (i % 10 === 0) {
          setExporting(`DICOM ${i + 1}/${series.imageIds.length}`);
          await new Promise((r) => setTimeout(r, 10));
        }
      }
    } catch (e) {
      console.warn('[CCTA DICOM export] failed', e);
      alert('DICOM export başarısız.');
    } finally {
      setExporting(null);
    }
  }, []);

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

      {!activeSeries && !isLoading ? (
        <DicomDropzone onFilesLoaded={handleFilesLoaded} isLoading={isLoading} />
      ) : !activeSeries ? null : (
        <main className="workspace-layout">
          <SeriesPanel
            seriesList={seriesList}
            activeSeriesUID={activeSeries.seriesInstanceUID}
            onSelectSeries={loadSeries}
            onExportSeries={exportSeriesAsDicom}
            isLoading={isLoading}
          />
          <div className="viewer-column">
            <ViewportGrid
              renderingEngineId={RENDERING_ENGINE_ID}
              setupToken={viewportSetupToken}
            />
            <div className="ccta-transport">
              {seriesList.length > 1 && (
                <button
                  onClick={() => gotoSeries(-1)}
                  disabled={seriesList.findIndex((s) => s.seriesInstanceUID === activeSeries.seriesInstanceUID) === 0 || isLoading}
                  title="Önceki seri"
                >⏮</button>
              )}
              {seriesList.length > 1 && (
                <button
                  onClick={() => gotoSeries(1)}
                  disabled={seriesList.findIndex((s) => s.seriesInstanceUID === activeSeries.seriesInstanceUID) === seriesList.length - 1 || isLoading}
                  title="Sonraki seri"
                >⏭</button>
              )}
              <button
                onClick={() => setPlaying((p) => !p)}
                title={playing ? 'Duraklat' : 'Oynat (axial slice sine)'}
              >{playing ? '❚❚' : '►'}</button>
              <input
                type="number"
                min={1}
                max={60}
                value={playFps}
                onChange={(e) => setPlayFps(Math.max(1, Math.min(60, Number(e.target.value) || 15)))}
                title="FPS"
                style={{ width: 48, height: 30, padding: '0 6px', background: 'transparent', color: 'var(--nd-ink, #e2e8f0)', border: '1px solid var(--nd-line, rgba(255,255,255,0.14))', borderRadius: 6 }}
              />
              <button onClick={saveAxialFrameImage} title="Anlık görüntü kaydet (PNG)">📷</button>
              <button onClick={saveAxialVideo} disabled={!!exporting} title="Axial video kaydet (WebM)">
                {exporting ? '⏺' : '🎞'}
              </button>
              <button onClick={() => exportSeriesAsDicom(activeSeries)} disabled={!!exporting} title="Seriyi DICOM olarak indir">💾</button>
              {exporting && <span className="ccta-transport-status">{exporting}</span>}
            </div>
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
