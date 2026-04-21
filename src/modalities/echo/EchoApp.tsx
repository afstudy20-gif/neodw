import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import { initCornerstone } from '../ct/core/initCornerstone';
import { loadEchoFiles, getDopplerSpectralRegion, type EchoSeriesInfo } from './echoLoader';
import { useTheme } from '../../theme/ThemeProvider';
import { expandAndFilterDicom } from '../../shared/fileIntake';
import echoModuleCss from './echo-module.css?inline';

type DicomSeriesInfo = EchoSeriesInfo;

function ThemeToggleBtn() {
  const { theme, toggle } = useTheme();
  return (
    <button className="echo-tool-btn" onClick={toggle} title="Tema" aria-label="theme">
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}

const RENDERING_ENGINE_ID = 'echoRenderingEngine';
const VIEWPORT_ID = 'echo-main';
const TOOL_GROUP_ID = 'echoToolGroup';

async function generateThumbnails(
  series: DicomSeriesInfo[],
  onReady: (seriesUid: string, dataUrl: string) => void
): Promise<void> {
  for (const s of series) {
    try {
      const firstId = s.imageIds[0];
      if (!firstId) continue;
      const image: any = await cornerstone.imageLoader.loadAndCacheImage(firstId);
      const canvas = document.createElement('canvas');
      const w = 96;
      const srcW = image?.width ?? image?.columns ?? 256;
      const srcH = image?.height ?? image?.rows ?? 256;
      const h = Math.max(1, Math.round((w * srcH) / Math.max(1, srcW)));
      canvas.width = w;
      canvas.height = h;
      const util: any = (cornerstone as any).utilities;
      if (util?.renderToCanvas) {
        await util.renderToCanvas(canvas, image);
      } else {
        // Fallback: manual normalize pixel data and draw
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        const pixelData: any = image.getPixelData?.() ?? image.imageFrame?.pixelData;
        if (!pixelData) continue;
        const tmp = document.createElement('canvas');
        tmp.width = srcW;
        tmp.height = srcH;
        const tctx = tmp.getContext('2d');
        if (!tctx) continue;
        const imgData = tctx.createImageData(srcW, srcH);
        const d = imgData.data;
        const minP = image.minPixelValue ?? 0;
        const maxP = image.maxPixelValue ?? 255;
        const range = Math.max(1, maxP - minP);
        const channels = (pixelData.length / (srcW * srcH)) | 0;
        for (let i = 0, j = 0; i < pixelData.length; i += channels, j += 4) {
          if (channels >= 3) {
            d[j] = pixelData[i];
            d[j + 1] = pixelData[i + 1];
            d[j + 2] = pixelData[i + 2];
          } else {
            const v = Math.max(0, Math.min(255, Math.round(((pixelData[i] - minP) / range) * 255)));
            d[j] = v; d[j + 1] = v; d[j + 2] = v;
          }
          d[j + 3] = 255;
        }
        tctx.putImageData(imgData, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(tmp, 0, 0, w, h);
      }
      onReady(s.seriesInstanceUID, canvas.toDataURL('image/jpeg', 0.78));
    } catch (e) {
      console.warn('[Echo thumbnail] failed', e);
    }
  }
}

// Cornerstone3D StackViewport.resetCamera tends to fit stack images by height.
// For echo cine we want the full raster visible, independent of measurement
// calibration, so fit using image pixel dimensions rather than world spacing.
function fitImageToViewport(vp: any) {
  try {
    const image = vp.getImage?.() ?? null;
    const imgData = vp.getImageData?.();
    const dims = imgData?.dimensions ?? imgData?.imageData?.getDimensions?.();
    let imgW = image?.width ?? image?.columns ?? dims?.[0];
    let imgH = image?.height ?? image?.rows ?? dims?.[1];
    if (!imgW || !imgH) return;
    // Swap dims if rotated 90° or 270°
    const rot = (vp.getRotation?.() ?? 0) as number;
    if (Math.abs(rot % 180) === 90) {
      const t = imgW; imgW = imgH; imgH = t;
    }
    const canvas = vp.canvas ?? vp.getCanvas?.();
    const cw = canvas?.clientWidth || canvas?.width || 800;
    const ch = canvas?.clientHeight || canvas?.height || 600;
    const imgAR = imgW / imgH;
    const vpAR = cw / ch;
    if (imgAR > vpAR) {
      const parallelScale = imgW / (2 * vpAR);
      const camera = vp.getCamera?.();
      vp.setCamera?.({ ...camera, parallelScale });
      console.log(`[Echo fit] img ${imgW}x${imgH}px (rot=${rot}) ar=${imgAR.toFixed(2)} vp ${cw}x${ch} ar=${vpAR.toFixed(2)} → parallelScale=${parallelScale.toFixed(2)}`);
    }
  } catch (e) {
    console.warn('[Echo fit] failed', e);
  }
}

let loggedActorOnce = false;
function applyLinearInterpolation(vp: any) {
  try {
    const InterpEnum = (cornerstone.Enums as any).InterpolationType;
    const linear = InterpEnum?.LINEAR ?? 1;
    vp.setProperties?.({ interpolationType: linear });
  } catch {}
  try {
    const actors = vp.getActors?.() ?? [];
    if (!loggedActorOnce && actors.length > 0) {
      loggedActorOnce = true;
      const actor = actors[0].actor ?? actors[0];
      const prop = actor?.getProperty?.();
      console.log('[Echo actor]', {
        actorType: actor?.getClassName?.(),
        hasProp: !!prop,
        propType: prop?.getClassName?.(),
        setInterpolationToLinear: typeof prop?.setInterpolationTypeToLinear,
        setInterpolationType: typeof prop?.setInterpolationType,
        getInterpolationType: prop?.getInterpolationType?.(),
      });
    }
    for (const entry of actors) {
      const actor = entry.actor ?? entry;
      const prop = actor?.getProperty?.();
      if (prop?.setInterpolationTypeToLinear) prop.setInterpolationTypeToLinear();
      else if (prop?.setInterpolationType) prop.setInterpolationType(1);
      // Also try VTK image mapper sampler state
      const mapper = actor?.getMapper?.();
      if (mapper?.setSampleDistance) { /* no-op for 2D */ }
    }
  } catch {}
}

type EchoTool = 'pan' | 'zoom' | 'window' | 'length' | 'angle' | 'area' | 'probe' | 'arrow' | 'text' | 'spectral';

// Doppler spectral calibration stored in image-pixel space so pan/zoom
// doesn't alter the velocity scale. Canvas positions derived per render.
interface DopplerCal {
  baselineImagePxY: number;
  mpsPerImagePx: number;
  source: 'auto' | 'manual';
}
interface DopplerReadout {
  id: string;
  imagePxY: number;
  velocityMps: number;
  pressureMmHg: number;
  imageId?: string;
}

interface Measurement {
  id: string;
  kind: 'length' | 'angle' | 'area' | 'probe';
  label: string;
  value: string;
}

interface EchoAppProps {
  onBack?: () => void;
  initialFiles?: File[];
  title?: string;
  /** UI profile. 'echo' keeps ultrasound/Doppler tools; 'xray' hides
   *  cine/Doppler and defaults to W/L drag on primary button. */
  mode?: 'echo' | 'xray';
}

export default function EchoApp({ onBack, initialFiles, title, mode = 'echo' }: EchoAppProps = {}) {
  const isXray = mode === 'xray';
  const viewportRef = useRef<HTMLDivElement>(null);
  const renderingEngineRef = useRef<cornerstone.RenderingEngine | null>(null);
  const toolGroupInitRef = useRef(false);
  const initialFilesConsumedRef = useRef(false);

  const [isInitialized, setIsInitialized] = useState(false);
  const [seriesList, setSeriesList] = useState<DicomSeriesInfo[]>([]);
  const [activeSeries, setActiveSeries] = useState<DicomSeriesInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(24);
  const [activeTool, setActiveTool] = useState<EchoTool>('pan');
  const activeToolRef = useRef<EchoTool>('pan');
  useEffect(() => { activeToolRef.current = activeTool; }, [activeTool]);
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [annoColor, setAnnoColor] = useState<string>('#ffd43b');
  const [annoFontSize, setAnnoFontSize] = useState<number>(14);
  const [annoFontFamily, setAnnoFontFamily] = useState<string>('Inter, system-ui, sans-serif');
  const [exporting, setExporting] = useState<string | null>(null);
  const [textEditor, setTextEditor] = useState<{ canvasX: number; canvasY: number; worldPt: [number, number, number]; value: string } | null>(null);
  const textEditorRef = useRef<HTMLInputElement | null>(null);
  interface TextAnno { id: string; worldPt: [number, number, number]; text: string; color: string; fontSize: number; fontFamily: string; imageId?: string; }
  const [textAnnos, setTextAnnos] = useState<TextAnno[]>([]);
  const [overlayTick, setOverlayTick] = useState(0);
  const [dopplerCal, setDopplerCal] = useState<DopplerCal | null>(null);
  const [calibStage, setCalibStage] = useState<'idle' | 'baseline' | 'ref'>('idle');
  const calibBaselineRef = useRef<number | null>(null);
  const [crosshairY, setCrosshairY] = useState<number | null>(null);
  const [liveReadout, setLiveReadout] = useState<DopplerReadout | null>(null);
  const [readouts, setReadouts] = useState<DopplerReadout[]>([]);

  // Inject module CSS
  useEffect(() => {
    const el = document.createElement('style');
    el.setAttribute('data-neodw-module', 'echo');
    el.textContent = echoModuleCss;
    document.head.appendChild(el);
    return () => el.remove();
  }, []);

  // Init cornerstone
  useEffect(() => {
    let mounted = true;
    initCornerstone()
      .then(() => {
        if (!mounted) return;
        const engine = new cornerstone.RenderingEngine(RENDERING_ENGINE_ID);
        renderingEngineRef.current = engine;
        setIsInitialized(true);
      })
      .catch((err) => setError(`Init failed: ${err?.message || err}`));
    const onResize = () => {
      try { renderingEngineRef.current?.resize(true, true); } catch {}
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      mounted = false;
      if (toolGroupInitRef.current) {
        try { cornerstoneTools.ToolGroupManager.destroyToolGroup(TOOL_GROUP_ID); } catch {}
        toolGroupInitRef.current = false;
      }
      renderingEngineRef.current?.destroy();
      renderingEngineRef.current = null;
    };
  }, []);

  // Load initial files
  useEffect(() => {
    if (!isInitialized || initialFilesConsumedRef.current) return;
    if (initialFiles && initialFiles.length > 0) {
      initialFilesConsumedRef.current = true;
      void handleFiles(initialFiles);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInitialized]);

  const handleFiles = useCallback(async (files: File[]) => {
    if (!isInitialized) return;
    setIsLoading(true);
    setError(null);
    try {
      const expanded = await expandAndFilterDicom(files);
      if (expanded.length === 0) {
        setError('Hiç DICOM dosyası bulunamadı (ZIP/RAR içinde de değil).');
        setIsLoading(false);
        return;
      }
      const series = await loadEchoFiles(expanded);
      setSeriesList(series);
      if (series.length > 0) {
        await openSeries(series[0]);
      } else {
        setError('No DICOM found.');
      }
      // Generate thumbnails in background
      void generateThumbnails(series, (uid, url) => {
        setThumbnails((prev) => ({ ...prev, [uid]: url }));
      });
    } catch (err: any) {
      setError(`Load failed: ${err?.message || err}`);
    } finally {
      setIsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInitialized]);

  const openSeries = useCallback(async (series: DicomSeriesInfo) => {
    const engine = renderingEngineRef.current;
    const el = viewportRef.current;
    if (!engine || !el) return;

    // Make the viewport div visible BEFORE enabling cornerstone on it.
    // The JSX toggles `display: activeSeries ? 'block' : 'none'` and
    // enabling a display:none element gives cornerstone a zero-sized
    // canvas. Static single-frame images then stay blank until the user
    // triggers anything that forces a re-render. Flip activeSeries first,
    // wait two RAFs for layout, then enable.
    setActiveSeries(series);
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

    engine.enableElement({
      viewportId: VIEWPORT_ID,
      type: cornerstone.Enums.ViewportType.STACK,
      element: el,
      defaultOptions: { background: [0, 0, 0] as [number, number, number] },
    });

    let imageIds = series.imageIds;
    console.log(`[Echo openSeries] imageIds count=${imageIds.length}, first=${imageIds[0]?.substring(0, 80)}`);

    const vp = engine.getViewport(VIEWPORT_ID) as cornerstone.Types.IStackViewport;
    await vp.setStack(imageIds, 0);

    // Fallback multiframe expansion (GE Vivid hybrid files: private blocks may hide NumberOfFrames from dicom-parser)
    if (imageIds.length === 1) {
      try {
        const img: any = await cornerstone.imageLoader.loadAndCacheImage(imageIds[0]);
        const n = Number(img?.numberOfFrames ?? img?.data?.intString?.('x00280008') ?? 1);
        console.log(`[Echo fallback] loaded image numberOfFrames=${n}`);
        if (n > 1) {
          const base = imageIds[0].includes('?frame=')
            ? imageIds[0].replace(/\?frame=\d+.*$/, '')
            : imageIds[0];
          imageIds = Array.from({ length: n }, (_, i) => `${base}?frame=${i}`);
          series = { ...series, imageIds, numImages: n };
          await vp.setStack(imageIds, 0);
          setActiveSeries(series);
          console.log(`[Echo fallback] expanded to ${n} frames`);
        }
      } catch (e) {
        console.warn('[Echo fallback] failed', e);
      }
    }

    // Force an explicit setImageIdIndex so cornerstone actually loads the
    // pixel data and runs the draw pipeline for frame 0. setStack alone
    // can register the stack without triggering the first render, leaving
    // the canvas black until the user clicks play (which itself issues
    // setImageIdIndex). Observed on DX radiographs.
    try { await vp.setImageIdIndex(0); } catch { /* ignore */ }

    // For radiographs (DX/CR/MG/RF) cornerstone's auto VOI is often
    // degenerate (lower == upper) leaving the canvas completely black.
    // Apply DICOM window tags if present, otherwise fall back to a wide
    // percentile range on raw pixels. Also honor MONOCHROME1 inversion.
    try {
      const modU2 = (series.modality || '').toUpperCase();
      if (['DX', 'CR', 'MG', 'RF'].includes(modU2)) {
        const firstId = series.imageIds[0];
        const image: any = await cornerstone.imageLoader.loadAndCacheImage(firstId);
        const photometric = image?.photometricInterpretation || image?.imageFrame?.photometricInterpretation;
        if (photometric === 'MONOCHROME1') {
          try { (vp as any).setProperties?.({ invert: true }); } catch {}
        }
        // Preferred: DICOM WindowCenter/Width. Both series meta and
        // image meta may carry them.
        const wc = series.windowCenter ?? image?.windowCenter;
        const ww = series.windowWidth ?? image?.windowWidth;
        const wcN = Array.isArray(wc) ? Number(wc[0]) : Number(wc);
        const wwN = Array.isArray(ww) ? Number(ww[0]) : Number(ww);
        if (Number.isFinite(wcN) && Number.isFinite(wwN) && wwN > 0) {
          try { (vp as any).setProperties?.({ voiRange: { lower: wcN - wwN / 2, upper: wcN + wwN / 2 } }); } catch {}
        } else {
          const pixels: ArrayLike<number> | undefined =
            image?.getPixelData?.() ?? image?.imageFrame?.pixelData;
          if (pixels && pixels.length > 0) {
            const stride = Math.max(1, Math.floor(pixels.length / 100000));
            const sample: number[] = [];
            for (let i = 0; i < pixels.length; i += stride) sample.push(pixels[i]);
            sample.sort((a, b) => a - b);
            const lower = sample[Math.floor(sample.length * 0.005)];
            const upper = sample[Math.floor(sample.length * 0.995)];
            if (Number.isFinite(lower) && Number.isFinite(upper) && upper > lower) {
              try { (vp as any).setProperties?.({ voiRange: { lower, upper } }); } catch {}
            }
          }
        }
      }
    } catch (e) { console.warn('[Echo xray-voi]', e); }

    applyLinearInterpolation(vp);
    // Force canvas resolution to match CSS size (fixes browser NEAREST stretching of small GL canvas)
    try { engine.resize(true, true); } catch {}
    try { (vp as any).resetCamera?.({ resetPan: true, resetZoom: true, resetToCenter: true }); } catch {}
    fitImageToViewport(vp);
    vp.render();

    // Workaround: on multi-frame DX/CR/MG/RF the initial setImageIdIndex(0)
    // registers the stack but doesn't always trigger the actor/texture
    // rebuild, so the canvas stays black until the user hits play (which
    // cycles indices). Toggle the index once to force that rebuild.
    if (imageIds.length > 1) {
      try {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        await vp.setImageIdIndex(1);
        await vp.setImageIdIndex(0);
        vp.render();
      } catch { /* ignore */ }
    } else {
      // Single-frame: re-issue the same index after a frame to force the
      // actor to pick up the loaded image.
      try {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        await vp.setImageIdIndex(0);
        vp.render();
      } catch { /* ignore */ }
    }
    setTimeout(() => {
      try { engine.resize(true, true); } catch {}
      try { (vp as any).resetCamera?.({ resetPan: true, resetZoom: true, resetToCenter: true }); } catch {}
      fitImageToViewport(vp);
      applyLinearInterpolation(vp);
      vp.render();
    }, 80);
    setTimeout(() => {
      try { engine.resize(true, true); } catch {}
      try { (vp as any).resetCamera?.({ resetPan: true, resetZoom: true, resetToCenter: true }); } catch {}
      fitImageToViewport(vp);
      applyLinearInterpolation(vp);
      vp.render();
    }, 300);

    // Subscribe to image-rendered to keep linear filter applied across re-renders
    try {
      const evt = (cornerstone as any).Enums?.Events?.IMAGE_RENDERED ?? 'CORNERSTONE_IMAGE_RENDERED';
      const onRendered = () => applyLinearInterpolation(vp);
      (el as any).__neodwRenderHandler?.();
      const handler = () => onRendered();
      el.addEventListener(evt, handler);
      (el as any).__neodwRenderHandler = () => el.removeEventListener(evt, handler);
    } catch {}

    // Diagnostic: verify spacing picked up
    try {
      const imgData: any = (vp as any).getImageData?.();
      const spacing = imgData?.spacing || imgData?.imageData?.getSpacing?.();
      const dims = imgData?.dimensions || imgData?.imageData?.getDimensions?.();
      console.log('[Echo] vp imageData spacing=', spacing, 'dimensions=', dims);
    } catch (e) {
      console.warn('[Echo] getImageData failed', e);
    }

    // Pre-cache all frames in parallel for smooth cine playback
    void Promise.all(
      imageIds.map((id) => cornerstone.imageLoader.loadAndCacheImage(id).catch(() => null))
    );

    const {
      PanTool,
      ZoomTool,
      WindowLevelTool,
      LengthTool,
      AngleTool,
      PlanarFreehandROITool,
      ProbeTool,
      StackScrollTool,
      ArrowAnnotateTool,
    } = cornerstoneTools;
    const toolsToAdd = [PanTool, ZoomTool, WindowLevelTool, LengthTool, AngleTool, PlanarFreehandROITool, ProbeTool, StackScrollTool, ArrowAnnotateTool];
    for (const T of toolsToAdd) {
      try { cornerstoneTools.addTool(T); } catch {}
    }
    let tg = cornerstoneTools.ToolGroupManager.getToolGroup(TOOL_GROUP_ID);
    if (!tg) {
      tg = cornerstoneTools.ToolGroupManager.createToolGroup(TOOL_GROUP_ID) ?? null;
    }
    if (tg) {
      // Add tools if not present (safe to call even if already added)
      for (const T of toolsToAdd) {
        try { tg.addTool(T.toolName); } catch {}
      }
      // Always (re-)associate viewport after enableElement
      try { tg.addViewport(VIEWPORT_ID, RENDERING_ENGINE_ID); } catch {}
      // Fixed bindings: zoom=right, scroll=wheel. Primary binding managed by activeTool effect.
      tg.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }] });
      tg.setToolActive(StackScrollTool.toolName, { bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel }] });
    }
    toolGroupInitRef.current = true;
    setActiveSeries(series);
    setFrameIndex(0);
    // Auto-set FPS from decoded cine rate when available
    const rate = series.cineRate;
    if (rate && rate > 0 && rate < 120) {
      setFps(Math.round(rate));
    }
    // Default primary-button tool: xray profile (or DX/CR/MG/RF modality)
    // → W/L drag; everything else → pan. Right-click stays zoom.
    const modU = (series.modality || '').toUpperCase();
    if (isXray || ['DX', 'CR', 'MG', 'RF'].includes(modU)) {
      setActiveTool('window');
    } else {
      setActiveTool('pan');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isXray]);

  const getViewportCanvas = useCallback((): HTMLCanvasElement | null => {
    const el = viewportRef.current;
    if (!el) return null;
    return (el.querySelector('canvas.cornerstone-canvas') ?? el.querySelector('canvas')) as HTMLCanvasElement | null;
  }, []);

  const saveCurrentFrameImage = useCallback(() => {
    const canvas = getViewportCanvas();
    if (!canvas) return;
    try {
      const url = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      const name = (activeSeries?.seriesDescription || 'echo').replace(/[^a-zA-Z0-9]/g, '_');
      a.download = `${name}_frame${frameIndex + 1}.png`;
      a.href = url;
      a.click();
    } catch (e) { console.warn('[Echo saveImage] failed', e); }
  }, [getViewportCanvas, activeSeries, frameIndex]);

  const saveSeriesAsDicom = useCallback(async () => {
    const series = activeSeries;
    if (!series) return;
    const wadouriIds = series.imageIds
      .map((id) => id.split('?')[0])
      .filter((id) => id.startsWith('wadouri:'));
    const uniqueBases = Array.from(new Set(wadouriIds));
    if (uniqueBases.length === 0) {
      alert('Bu seri için DICOM export desteklenmiyor (proprietary/decoded cine).');
      return;
    }
    const baseName = (series.seriesDescription || 'echo').replace(/[^a-zA-Z0-9]/g, '_');
    try {
      for (let i = 0; i < uniqueBases.length; i++) {
        const blobUrl = uniqueBases[i].replace(/^wadouri:/, '');
        const resp = await fetch(blobUrl);
        const blob = await resp.blob();
        const a = document.createElement('a');
        a.download = uniqueBases.length > 1 ? `${baseName}_${i + 1}.dcm` : `${baseName}.dcm`;
        a.href = URL.createObjectURL(blob);
        a.click();
        URL.revokeObjectURL(a.href);
      }
    } catch (e) {
      console.warn('[Echo DICOM export] failed', e);
      alert('DICOM export başarısız.');
    }
  }, [activeSeries]);

  const saveCineAsVideo = useCallback(async () => {
    const series = activeSeries;
    const canvas = getViewportCanvas();
    const engine = renderingEngineRef.current;
    if (!series || !canvas || !engine || series.imageIds.length < 2) return;
    const vp = engine.getViewport(VIEWPORT_ID) as cornerstone.Types.IStackViewport;
    if (!vp) return;

    setExporting('Hazırlanıyor...');
    const stream = canvas.captureStream(fps);
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 });
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    const done = new Promise<void>((r) => { recorder.onstop = () => r(); });
    recorder.start();

    const wasPlaying = playing;
    setPlaying(false);
    try {
      for (let i = 0; i < series.imageIds.length; i++) {
        setExporting(`Frame ${i + 1}/${series.imageIds.length}`);
        try { await vp.setImageIdIndex(i); } catch {}
        vp.render();
        await new Promise((r) => setTimeout(r, 1000 / Math.max(1, fps)));
      }
    } finally {
      recorder.stop();
      await done;
      if (wasPlaying) setPlaying(true);
    }
    const blob = new Blob(chunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const name = (series.seriesDescription || 'echo').replace(/[^a-zA-Z0-9]/g, '_');
    a.download = `${name}_${series.imageIds.length}fr.webm`;
    a.href = url;
    a.click();
    URL.revokeObjectURL(url);
    setExporting(null);
  }, [activeSeries, getViewportCanvas, fps, playing]);

  const commitTextAnnotation = useCallback((text: string) => {
    const ed = textEditor;
    if (!ed) return;
    const trimmed = text.trim();
    if (!trimmed) { setTextEditor(null); return; }
    const engine = renderingEngineRef.current;
    const vp = engine?.getViewport(VIEWPORT_ID) as cornerstone.Types.IStackViewport | undefined;
    const imageId = (vp as any)?.getCurrentImageId?.();
    const id = (crypto as any).randomUUID ? (crypto as any).randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);
    setTextAnnos((prev) => [
      ...prev,
      { id, worldPt: ed.worldPt, text: trimmed, color: annoColor, fontSize: annoFontSize, fontFamily: annoFontFamily, imageId },
    ]);
    setTextEditor(null);
  }, [textEditor, annoColor, annoFontSize, annoFontFamily]);

  const gotoSeries = useCallback((delta: number) => {
    if (!activeSeries) return;
    const idx = seriesList.findIndex((s) => s.seriesInstanceUID === activeSeries.seriesInstanceUID);
    const next = seriesList[idx + delta];
    if (next) {
      setPlaying(true);
      void openSeries(next);
    }
  }, [activeSeries, seriesList, openSeries]);

  // Apply active tool
  useEffect(() => {
    if (!toolGroupInitRef.current) return;
    const tg = cornerstoneTools.ToolGroupManager.getToolGroup(TOOL_GROUP_ID);
    if (!tg) return;
    const {
      PanTool, ZoomTool, WindowLevelTool, LengthTool, AngleTool, PlanarFreehandROITool, ProbeTool, ArrowAnnotateTool,
    } = cornerstoneTools;
    const bindings = [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }];
    const toolMap: Record<EchoTool, string> = {
      pan: PanTool.toolName,
      zoom: ZoomTool.toolName,
      window: WindowLevelTool.toolName,
      length: LengthTool.toolName,
      angle: AngleTool.toolName,
      area: PlanarFreehandROITool.toolName,
      probe: ProbeTool.toolName,
      arrow: ArrowAnnotateTool.toolName,
      text: '', // Placed via custom mousedown handler — ArrowAnnotateTool must stay passive here
      spectral: '', // Doppler measurement handled by custom capture-phase listener
    };
    // Arrow mode: empty text (single space so annotation isn't discarded).
    try {
      (tg as any).setToolConfiguration?.(ArrowAnnotateTool.toolName, {
        getTextCallback: (done: (t: string) => void) => done(' '),
      });
    } catch {}
    const selected = toolMap[activeTool];
    for (const name of Object.values(toolMap)) {
      if (!name) continue;
      if (name === selected) {
        tg.setToolActive(name, { bindings });
      } else if (name !== PanTool.toolName || activeTool !== 'pan') {
        try { tg.setToolPassive(name); } catch {}
      }
    }
    // Text / spectral mode: make all primary-button tools passive so our
    // custom mousedown handlers own left-click.
    if (activeTool === 'text' || activeTool === 'spectral') {
      try { tg.setToolPassive(ArrowAnnotateTool.toolName); } catch {}
      try { tg.setToolPassive(PanTool.toolName); } catch {}
    }
    tg.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }] });
  }, [activeTool]);

  // Block the native right-click context menu on the viewport so
  // cornerstone's ZoomTool (bound to the secondary mouse button) can
  // receive the full mousedown→mousemove→mouseup drag without the
  // browser popping up its own menu on mousedown.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const stop = (e: Event) => e.preventDefault();
    el.addEventListener('contextmenu', stop);
    return () => el.removeEventListener('contextmenu', stop);
  }, [activeSeries]);

  // Keep DOM text overlay positions in sync with viewport pan/zoom/frame changes.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const bump = () => setOverlayTick((n) => n + 1);
    const camEvt = (cornerstone as any).Enums?.Events?.CAMERA_MODIFIED ?? 'CORNERSTONE_CAMERA_MODIFIED';
    const rendEvt = (cornerstone as any).Enums?.Events?.IMAGE_RENDERED ?? 'CORNERSTONE_IMAGE_RENDERED';
    el.addEventListener(camEvt, bump as EventListener);
    el.addEventListener(rendEvt, bump as EventListener);
    const ro = new ResizeObserver(bump);
    ro.observe(el);
    return () => {
      el.removeEventListener(camEvt, bump as EventListener);
      el.removeEventListener(rendEvt, bump as EventListener);
      ro.disconnect();
    };
  }, [activeSeries]);

  // ─── Doppler spectral helpers ───
  const getViewportForSpectral = useCallback((): cornerstone.Types.IStackViewport | null => {
    const engine = renderingEngineRef.current;
    return (engine?.getViewport(VIEWPORT_ID) as cornerstone.Types.IStackViewport | undefined) ?? null;
  }, []);

  const imagePxYToCanvasY = useCallback((imagePxY: number): number | null => {
    const vp = getViewportForSpectral();
    if (!vp) return null;
    try {
      const img: any = (vp as any).getImageData?.();
      if (!img) return null;
      const origin = img.origin ?? img.imageData?.getOrigin?.();
      const spacing = img.spacing ?? img.imageData?.getSpacing?.();
      if (!origin || !spacing) return null;
      const worldY = origin[1] + imagePxY * spacing[1];
      const cp = vp.worldToCanvas([origin[0], worldY, origin[2]] as any) as number[];
      return Number.isFinite(cp?.[1]) ? cp[1] : null;
    } catch { return null; }
  }, [getViewportForSpectral]);

  const canvasYToImagePxY = useCallback((canvasY: number): number | null => {
    const vp = getViewportForSpectral();
    if (!vp) return null;
    try {
      const img: any = (vp as any).getImageData?.();
      if (!img) return null;
      const origin = img.origin ?? img.imageData?.getOrigin?.();
      const spacing = img.spacing ?? img.imageData?.getSpacing?.();
      if (!origin || !spacing) return null;
      // Use any x (e.g. canvas center) since we only care about Y
      const el = viewportRef.current;
      const x = el ? el.clientWidth / 2 : 0;
      const wp = vp.canvasToWorld([x, canvasY]) as number[];
      return (wp[1] - origin[1]) / spacing[1];
    } catch { return null; }
  }, [getViewportForSpectral]);

  // Auto-calibration from DICOM Ultrasound Region (type 3/4 = Doppler spectrum).
  useEffect(() => {
    if (activeTool !== 'spectral' || !activeSeries) return;
    const vp = getViewportForSpectral();
    const imageId: string | undefined = (vp as any)?.getCurrentImageId?.();
    if (!imageId) return;
    const region = getDopplerSpectralRegion(imageId);
    if (region && !dopplerCal) {
      setDopplerCal({
        baselineImagePxY: region.refPixelY0,
        mpsPerImagePx: region.mpsPerImagePx,
        source: 'auto',
      });
      console.log('[Doppler] auto-cal from DICOM region', region);
    }
  }, [activeTool, activeSeries, frameIndex, dopplerCal, getViewportForSpectral]);

  const computeVelocityForCanvasY = useCallback((canvasY: number): { v: number; p: number; imagePxY: number } | null => {
    if (!dopplerCal) return null;
    const imgY = canvasYToImagePxY(canvasY);
    if (imgY == null) return null;
    const v = Math.abs(imgY - dopplerCal.baselineImagePxY) * dopplerCal.mpsPerImagePx;
    const p = 4 * v * v; // Simplified Bernoulli: ΔP = 4·v²
    return { v, p, imagePxY: imgY };
  }, [dopplerCal, canvasYToImagePxY]);

  /**
   * Sub-pixel refinement: sample a vertical luminance column of the
   * underlying viewport canvas around the clicked Y, find the brightest
   * row (spectrum envelope peak on the side matching the user's click
   * relative to the baseline), and parabolically interpolate across the
   * peak and its two neighbors to extract a fractional canvas-Y.
   */
  const refineCanvasYSubPixel = useCallback((canvasX: number, canvasY: number, searchRadius = 12): number => {
    const el = viewportRef.current;
    if (!el) return canvasY;
    const canvas = (el.querySelector('canvas.cornerstone-canvas') ?? el.querySelector('canvas')) as HTMLCanvasElement | null;
    if (!canvas) return canvasY;
    const dpr = canvas.width / Math.max(1, el.clientWidth);
    const cx = Math.round(canvasX * dpr);
    const cyBuf = Math.round(canvasY * dpr);
    const radBuf = Math.max(3, Math.round(searchRadius * dpr));
    const y0 = Math.max(0, cyBuf - radBuf);
    const y1 = Math.min(canvas.height - 1, cyBuf + radBuf);
    if (y1 <= y0) return canvasY;

    let ctx: CanvasRenderingContext2D | null = null;
    try { ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | null; } catch {}
    // WebGL canvases (Cornerstone uses VTK.js -> WebGL by default) won't
    // expose a 2D context. Read via readPixels fallback via drawImage.
    if (!ctx) {
      try {
        const tmp = document.createElement('canvas');
        tmp.width = 1; tmp.height = y1 - y0 + 1;
        const tctx = tmp.getContext('2d');
        if (!tctx) return canvasY;
        tctx.drawImage(canvas, cx, y0, 1, tmp.height, 0, 0, 1, tmp.height);
        const data = tctx.getImageData(0, 0, 1, tmp.height).data;
        return pickPeakFromLumaColumn(data, y0, cyBuf, dpr);
      } catch { return canvasY; }
    }
    try {
      const data = ctx.getImageData(cx, y0, 1, y1 - y0 + 1).data;
      return pickPeakFromLumaColumn(data, y0, cyBuf, dpr);
    } catch { return canvasY; }

    function pickPeakFromLumaColumn(data: Uint8ClampedArray, startY: number, seedY: number, dprLocal: number): number {
      const n = data.length / 4;
      let bestIdx = -1;
      let bestLuma = -1;
      for (let i = 0; i < n; i++) {
        const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
        // Rec.709 luma
        const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (y > bestLuma) { bestLuma = y; bestIdx = i; }
      }
      if (bestIdx < 0) return seedY / dprLocal;
      // Parabolic interpolation between (idx-1, idx, idx+1) luminance samples
      let subOffset = 0;
      if (bestIdx > 0 && bestIdx < n - 1) {
        const yl = 0.2126 * data[(bestIdx - 1) * 4] + 0.7152 * data[(bestIdx - 1) * 4 + 1] + 0.0722 * data[(bestIdx - 1) * 4 + 2];
        const yc = bestLuma;
        const yr = 0.2126 * data[(bestIdx + 1) * 4] + 0.7152 * data[(bestIdx + 1) * 4 + 1] + 0.0722 * data[(bestIdx + 1) * 4 + 2];
        const denom = (yl - 2 * yc + yr);
        if (Math.abs(denom) > 1e-6) subOffset = 0.5 * (yl - yr) / denom;
        if (subOffset < -1) subOffset = -1;
        if (subOffset > 1) subOffset = 1;
      }
      const refinedBuf = startY + bestIdx + subOffset;
      return refinedBuf / dprLocal;
    }
  }, []);

  // Capture-phase mousedown + mousemove for spectral tool: calibration clicks,
  // crosshair tracking, and readout locking.
  useEffect(() => {
    if (activeTool !== 'spectral') return;
    const el = viewportRef.current;
    if (!el) return;

    const onMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const rawCanvasY = e.clientY - rect.top;
      // Refinement strategy depends on mode:
      //  - Measurement (idle + calibrated): snap to brightest spectrum column
      //    around cursor X (envelope peak).
      //  - Calibration: snap to nearest tick on the right-side velocity axis
      //    (ticks are bright short lines in a narrow right-edge strip).
      let refinedCanvasY: number;
      if (calibStage !== 'idle') {
        const axisX = Math.max(0, (el.clientWidth ?? rawCanvasY) - 15);
        refinedCanvasY = refineCanvasYSubPixel(axisX, rawCanvasY, 40);
      } else {
        // Post-calibration measurement: crosshair follows cursor exactly.
        refinedCanvasY = rawCanvasY;
      }
      void canvasX;
      setCrosshairY(refinedCanvasY);
      const r = computeVelocityForCanvasY(refinedCanvasY);
      if (r) {
        const vp = getViewportForSpectral();
        const imageId: string | undefined = (vp as any)?.getCurrentImageId?.();
        setLiveReadout({
          id: 'live',
          imagePxY: r.imagePxY,
          velocityMps: r.v,
          pressureMmHg: r.p,
          imageId,
        });
      } else {
        setLiveReadout(null);
      }
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const rect = el.getBoundingClientRect();
      const canvasY = e.clientY - rect.top;

      // Manual calibration flow — snap to nearest right-axis tick line.
      if (calibStage === 'baseline' || calibStage === 'ref') {
        const axisX = Math.max(0, el.clientWidth - 15);
        const snappedY = refineCanvasYSubPixel(axisX, canvasY, 40);
        if (calibStage === 'baseline') {
          const imgY = canvasYToImagePxY(snappedY);
          if (imgY == null) return;
          calibBaselineRef.current = imgY;
          setCalibStage('ref');
          return;
        }
        // calibStage === 'ref'
        const imgY = canvasYToImagePxY(snappedY);
        const baseImgY = calibBaselineRef.current;
        if (imgY == null || baseImgY == null) { setCalibStage('idle'); return; }
        const ans = window.prompt('Bu satır için referans hız (m/s):', '1.0');
        if (!ans) { setCalibStage('idle'); calibBaselineRef.current = null; return; }
        const vRef = Math.abs(parseFloat(ans));
        if (!Number.isFinite(vRef) || vRef <= 0) { setCalibStage('idle'); calibBaselineRef.current = null; return; }
        const dy = Math.abs(imgY - baseImgY);
        if (dy < 1) { setCalibStage('idle'); calibBaselineRef.current = null; return; }
        setDopplerCal({
          baselineImagePxY: baseImgY,
          mpsPerImagePx: vRef / dy,
          source: 'manual',
        });
        setCalibStage('idle');
        calibBaselineRef.current = null;
        return;
      }

      // After calibration: click locks the crosshair as a readout (raw Y, no snap)
      if (!dopplerCal) return;
      const r = computeVelocityForCanvasY(canvasY);
      if (!r) return;
      const vp = getViewportForSpectral();
      const imageId: string | undefined = (vp as any)?.getCurrentImageId?.();
      const id = (crypto as any).randomUUID ? (crypto as any).randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);
      setReadouts((prev) => [...prev, { id, imagePxY: r.imagePxY, velocityMps: r.v, pressureMmHg: r.p, imageId }]);
    };

    const onLeave = () => { setCrosshairY(null); setLiveReadout(null); };

    el.addEventListener('mousedown', onDown, true);
    el.addEventListener('mousemove', onMove);
    el.addEventListener('mouseleave', onLeave);
    return () => {
      el.removeEventListener('mousedown', onDown, true);
      el.removeEventListener('mousemove', onMove);
      el.removeEventListener('mouseleave', onLeave);
    };
  }, [activeTool, calibStage, dopplerCal, computeVelocityForCanvasY, canvasYToImagePxY, getViewportForSpectral, refineCanvasYSubPixel]);

  // In 'text' mode: intercept mousedown BEFORE ArrowAnnotateTool sees it,
  // prompt for text, and place a ready-built annotation programmatically.
  // This avoids the visible arrow appearing during the drag.
  useEffect(() => {
    if (activeTool !== 'text') return;
    const el = viewportRef.current;
    if (!el) return;

    const handler = (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      const engine = renderingEngineRef.current;
      const vp = engine?.getViewport(VIEWPORT_ID) as cornerstone.Types.IStackViewport | undefined;
      if (!vp) return;

      const rect = el.getBoundingClientRect();
      const canvasPt: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
      let worldPt: [number, number, number];
      try { worldPt = vp.canvasToWorld(canvasPt) as [number, number, number]; } catch { return; }

      setTextEditor({ canvasX: canvasPt[0], canvasY: canvasPt[1], worldPt, value: '' });
      setTimeout(() => textEditorRef.current?.focus(), 0);
    };

    el.addEventListener('mousedown', handler, true);
    return () => el.removeEventListener('mousedown', handler, true);
  }, [activeTool]);

  // In 'text' mode: collapse arrow to zero length AND force its color
  // transparent so only the text label renders. textBoxColor stays from
  // global style, so the label color stays visible.
  useEffect(() => {
    const evt = (cornerstoneTools as any).Enums?.Events?.ANNOTATION_COMPLETED ?? 'ANNOTATION_COMPLETED';
    const handler = (e: any) => {
      if (activeToolRef.current !== 'text') return;
      const anno = e?.detail?.annotation;
      const pts = anno?.data?.handles?.points;
      if (pts && pts.length >= 2) pts[0] = [...pts[1]];
      const uid = anno?.annotationUID;
      try {
        const api: any = (cornerstoneTools as any).annotation;
        const setStyle = api?.config?.style?.setAnnotationStyle
          ?? api?.config?.style?.setAnnotationToolStyles
          ?? api?.config?.style?.setAnnotationUIDStyles;
        if (uid && setStyle) {
          setStyle.call(api.config.style, uid, {
            color: 'transparent',
            colorHighlighted: 'transparent',
            colorSelected: 'transparent',
            colorLocked: 'transparent',
            lineWidth: 0,
            lineDash: '',
          });
        }
      } catch {}
      try { renderingEngineRef.current?.render(); } catch {}
    };
    try {
      (cornerstoneTools as any).eventTarget?.addEventListener?.(evt, handler);
    } catch {}
    return () => {
      try {
        (cornerstoneTools as any).eventTarget?.removeEventListener?.(evt, handler);
      } catch {}
    };
  }, []);

  // Apply annotation visual style (color + font) globally
  useEffect(() => {
    try {
      const cfg: any = (cornerstoneTools as any).annotation?.config?.style;
      if (!cfg?.setDefaultToolStyles && !cfg?.setGlobalStyle && !cfg?.setDefaultStyles) return;
      const styleObj = {
        color: annoColor,
        colorSelected: annoColor,
        colorHighlighted: annoColor,
        colorLocked: annoColor,
        lineWidth: 2,
        textBoxFontSize: `${annoFontSize}px`,
        textBoxFontFamily: annoFontFamily,
        textBoxColor: annoColor,
        textBoxColorSelected: annoColor,
        textBoxColorLocked: annoColor,
      };
      if (cfg.setDefaultToolStyles) cfg.setDefaultToolStyles(styleObj);
      else if (cfg.setGlobalStyle) cfg.setGlobalStyle(styleObj);
      else if (cfg.setDefaultStyles) cfg.setDefaultStyles(styleObj);
      // Force redraw
      const engine = renderingEngineRef.current;
      engine?.render();
    } catch (e) {
      console.warn('[Echo anno-style] failed', e);
    }
  }, [annoColor, annoFontSize, annoFontFamily]);

  // Cine playback — recursive setTimeout w/ async setImageIdIndex
  useEffect(() => {
    if (!playing || !activeSeries) return;
    const engine = renderingEngineRef.current;
    if (!engine) return;
    const vp = engine.getViewport(VIEWPORT_ID) as cornerstone.Types.IStackViewport | undefined;
    if (!vp) return;
    const total = activeSeries.imageIds.length;
    if (total <= 1) return;

    let alive = true;
    let timer: number | null = null;
    let i = frameIndex;

    const delay = Math.max(16, Math.round(1000 / fps));
    const targetSeriesUid = activeSeries.seriesInstanceUID;

    console.log(`[Echo cine] start: total=${total} fps=${fps} delay=${delay}ms`);
    const tick = async () => {
      if (!alive) return;
      const eng = renderingEngineRef.current;
      const liveVp = eng?.getViewport(VIEWPORT_ID) as cornerstone.Types.IStackViewport | undefined;
      if (!liveVp) { alive = false; return; }
      i = (i + 1) % total;
      try {
        await liveVp.setImageIdIndex(i);
        applyLinearInterpolation(liveVp);
        liveVp.render();
      } catch (e) {
        alive = false;
        return;
      }
      if (!alive) return;
      setFrameIndex(i);
      timer = window.setTimeout(tick, delay);
    };
    void targetSeriesUid;

    timer = window.setTimeout(tick, delay);

    return () => {
      alive = false;
      if (timer != null) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, activeSeries, fps]);

  const seekFrame = useCallback(async (next: number) => {
    const engine = renderingEngineRef.current;
    if (!engine || !activeSeries) return;
    const vp = engine.getViewport(VIEWPORT_ID) as cornerstone.Types.IStackViewport | undefined;
    if (!vp) return;
    const clamped = Math.max(0, Math.min(activeSeries.imageIds.length - 1, next));
    try {
      await vp.setImageIdIndex(clamped);
      applyLinearInterpolation(vp);
      vp.render();
    } catch (e) {
      console.warn('[Echo] seek failed', e);
    }
    setFrameIndex(clamped);
  }, [activeSeries]);

  // Collect measurements on tool change
  useEffect(() => {
    const id = setInterval(collectMeasurements, 600);
    return () => clearInterval(id);
  }, []);

  const collectMeasurements = useCallback(() => {
    try {
      const annotations = cornerstoneTools.annotation.state.getAllAnnotations();
      const mapped: Measurement[] = annotations.map((a: any, i: number) => {
        const name: string = a?.metadata?.toolName || 'tool';
        const stats = a?.data?.cachedStats || {};
        const firstKey = Object.keys(stats)[0];
        const s = firstKey ? stats[firstKey] : {};
        let kind: Measurement['kind'] = 'probe';
        let label = name;
        let value = '';
        if (name === 'Length') {
          kind = 'length';
          label = 'Length';
          value = s.length ? `${s.length.toFixed(2)} mm` : '';
        } else if (name === 'Angle') {
          kind = 'angle';
          label = 'Angle';
          value = s.angle ? `${s.angle.toFixed(1)}°` : '';
        } else if (name === 'PlanarFreehandROI') {
          kind = 'area';
          label = 'Area';
          value = s.area ? `${s.area.toFixed(2)} mm²` : '';
        } else if (name === 'Probe') {
          kind = 'probe';
          label = 'HU';
          value = s.value !== undefined ? `${s.value.toFixed(1)}` : '';
        }
        return { id: a?.annotationUID || String(i), kind, label, value };
      }).filter((m) => m.value);
      setMeasurements(mapped);
    } catch {
      // ignore
    }
  }, []);

  const clearMeasurements = useCallback(() => {
    try {
      cornerstoneTools.annotation.state.getAnnotationManager().removeAllAnnotations();
      const engine = renderingEngineRef.current;
      engine?.render();
      setMeasurements([]);
      setTextAnnos([]);
    } catch {}
  }, []);

  function pickFiles(folder: boolean) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (folder) (input as any).webkitdirectory = true;
    input.onchange = (e) => {
      const t = e.target as HTMLInputElement;
      if (t.files?.length) void handleFiles(Array.from(t.files));
    };
    input.click();
  }

  const totalFrames = activeSeries?.imageIds.length ?? 0;

  const setCenterOrigin = (actor: any) => {
    try {
      const mapper = actor?.getMapper?.();
      const input = mapper?.getInputData?.();
      const dims = input?.getDimensions?.();
      const spacing = input?.getSpacing?.();
      if (!dims || !spacing) return;
      // Actor origin = center of image in world coords so scale/mirror pivot around middle
      const cx = (dims[0] - 1) * spacing[0] * 0.5;
      const cy = (dims[1] - 1) * spacing[1] * 0.5;
      actor?.setOrigin?.(cx, cy, 0);
      const pos = actor?.getPosition?.() ?? [0, 0, 0];
      // Translate so center-of-scale stays at image center
      actor?.setPosition?.(pos[0], pos[1], pos[2]);
    } catch {}
  };

  const applyActorTransform = (mutate: (actor: any) => void) => {
    const eng = renderingEngineRef.current;
    const vp = eng?.getViewport(VIEWPORT_ID) as any;
    if (!vp) return;
    try {
      const actors = vp.getActors?.() ?? [];
      for (const entry of actors) {
        const actor = entry.actor ?? entry;
        setCenterOrigin(actor);
        mutate(actor);
        actor?.modified?.();
      }
      vp.render();
    } catch (e) {
      console.warn('[Echo transform] failed', e);
    }
  };

  const stretchActor = (axis: 'x' | 'y', factor: number) => {
    applyActorTransform((actor) => {
      const curScale = actor?.getScale?.() ?? [1, 1, 1];
      const sx = axis === 'x' ? curScale[0] * factor : curScale[0];
      const sy = axis === 'y' ? curScale[1] * factor : curScale[1];
      actor?.setScale?.(sx, sy, curScale[2] ?? 1);
    });
  };

  const mirrorActor = (axis: 'x' | 'y') => {
    applyActorTransform((actor) => {
      const curScale = actor?.getScale?.() ?? [1, 1, 1];
      const sx = axis === 'x' ? -curScale[0] : curScale[0];
      const sy = axis === 'y' ? -curScale[1] : curScale[1];
      actor?.setScale?.(sx, sy, curScale[2] ?? 1);
    });
  };

  const applyVoiPreset = (wc: number, ww: number) => {
    const eng = renderingEngineRef.current;
    const vp = eng?.getViewport(VIEWPORT_ID) as any;
    if (!vp) return;
    try {
      vp.setProperties?.({ voiRange: { lower: wc - ww / 2, upper: wc + ww / 2 } });
      vp.render();
    } catch (e) { console.warn('[Echo voi]', e); }
  };

  const resetVoi = () => {
    const eng = renderingEngineRef.current;
    const vp = eng?.getViewport(VIEWPORT_ID) as any;
    if (!vp) return;
    try {
      vp.resetProperties?.();
      vp.render();
    } catch (e) { console.warn('[Echo voi reset]', e); }
  };

  const rotateBy = (deg: number) => {
    const eng = renderingEngineRef.current;
    const vp = eng?.getViewport(VIEWPORT_ID) as any;
    if (!vp) return;
    const cur = (vp.getRotation?.() ?? 0) as number;
    vp.setRotation?.(((cur + deg) % 360 + 360) % 360);
    vp.render();
  };

  return (
    <div className="echo-app">
      <header className="echo-header">
        {onBack && (
          <button className="echo-tool-btn" onClick={onBack}>&larr; Geri</button>
        )}
        <h1>{title ?? 'Ekokardiyografi / Ultrason'}</h1>
        <div className="echo-header-actions">
          <button className="echo-tool-btn" onClick={() => pickFiles(false)} disabled={isLoading}>Dosya Aç</button>
          <button className="echo-tool-btn" onClick={() => pickFiles(true)} disabled={isLoading}>Klasör Aç</button>
          <ThemeToggleBtn />
        </div>
      </header>

      {error && (
        <div style={{ padding: '10px 16px', background: 'rgba(255, 80, 80, 0.12)', color: 'var(--nd-danger)', fontSize: 12 }}>
          {error}
        </div>
      )}

      <div className="echo-body">
        <aside className="echo-sidebar">
          <h2>Seriler</h2>
          {seriesList.length === 0 ? (
            <p className="echo-empty">Henüz seri yok. DICOM dosyası açın.</p>
          ) : seriesList.map((s) => {
            const thumb = thumbnails[s.seriesInstanceUID];
            return (
              <button
                key={s.seriesInstanceUID}
                className={`echo-series-item ${activeSeries?.seriesInstanceUID === s.seriesInstanceUID ? 'active' : ''}`}
                onClick={() => void openSeries(s)}
              >
                <div className="echo-thumb">
                  {thumb ? (
                    <img src={thumb} alt="thumb" />
                  ) : (
                    <div className="echo-thumb-placeholder" />
                  )}
                </div>
                <div className="echo-series-meta">
                  <div style={{ fontWeight: 600 }}>{s.seriesDescription || 'Series'}</div>
                  <div style={{ color: 'var(--nd-text-dim)', fontSize: 11 }}>{s.modality} · {s.numImages} frame</div>
                </div>
              </button>
            );
          })}
        </aside>

        <div
          className="echo-viewport-wrap"
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const files = Array.from(e.dataTransfer.files);
            if (files.length) void handleFiles(files);
          }}
        >
         <div className="echo-viewport-area">
          {!activeSeries && !isLoading && (
            <div className={`echo-dropzone ${dragOver ? 'active' : ''}`}>
              <h3>Eko / USG DICOM Yükle</h3>
              <p>Dosyaları buraya sürükleyin veya başlıktan "Dosya Aç" ile seçin.</p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="echo-tool-btn active" onClick={() => pickFiles(false)}>Dosya Aç</button>
                <button className="echo-tool-btn" onClick={() => pickFiles(true)}>Klasör Aç</button>
              </div>
            </div>
          )}
          {isLoading && <div className="echo-empty" style={{ color: '#fff' }}>Yükleniyor...</div>}
          <div ref={viewportRef} className="echo-viewport" data-tool={activeTool} style={{ display: activeSeries ? 'block' : 'none' }} />

          {activeSeries && textAnnos.length > 0 && (() => {
            const engine = renderingEngineRef.current;
            const vp = engine?.getViewport(VIEWPORT_ID) as cornerstone.Types.IStackViewport | undefined;
            if (!vp) return null;
            const currentImageId: string | undefined = (vp as any).getCurrentImageId?.();
            void overlayTick;
            return textAnnos.map((a) => {
              if (a.imageId && currentImageId && a.imageId !== currentImageId) return null;
              let cp: number[]; try { cp = vp.worldToCanvas(a.worldPt as any) as number[]; } catch { return null; }
              if (!cp || !Number.isFinite(cp[0]) || !Number.isFinite(cp[1])) return null;
              return (
                <div
                  key={a.id}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setTextAnnos((prev) => prev.filter((x) => x.id !== a.id));
                  }}
                  onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const el = viewportRef.current;
                    const vpLocal = engine?.getViewport(VIEWPORT_ID) as cornerstone.Types.IStackViewport | undefined;
                    if (!el || !vpLocal) return;
                    const rect = el.getBoundingClientRect();
                    const startCanvas: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
                    const startAnnoCanvas = vpLocal.worldToCanvas(a.worldPt as any) as number[];
                    const dx0 = startCanvas[0] - startAnnoCanvas[0];
                    const dy0 = startCanvas[1] - startAnnoCanvas[1];
                    let moved = false;
                    const onMove = (ev: MouseEvent) => {
                      const nx = ev.clientX - rect.left - dx0;
                      const ny = ev.clientY - rect.top - dy0;
                      try {
                        const newWorld = vpLocal.canvasToWorld([nx, ny]) as [number, number, number];
                        moved = true;
                        setTextAnnos((prev) => prev.map((x) => x.id === a.id ? { ...x, worldPt: newWorld } : x));
                      } catch {}
                    };
                    const onUp = () => {
                      window.removeEventListener('mousemove', onMove);
                      window.removeEventListener('mouseup', onUp);
                      if (!moved) {
                        // Treat as click → enter edit mode
                        const cpNow = vpLocal.worldToCanvas(a.worldPt as any) as number[];
                        setTextAnnos((prev) => prev.filter((x) => x.id !== a.id));
                        setTextEditor({ canvasX: cpNow[0], canvasY: cpNow[1], worldPt: a.worldPt, value: a.text });
                        setTimeout(() => {
                          textEditorRef.current?.focus();
                          textEditorRef.current?.select();
                        }, 0);
                      }
                    };
                    window.addEventListener('mousemove', onMove);
                    window.addEventListener('mouseup', onUp);
                  }}
                  onDoubleClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const vpLocal = engine?.getViewport(VIEWPORT_ID) as cornerstone.Types.IStackViewport | undefined;
                    if (!vpLocal) return;
                    const cpNow = vpLocal.worldToCanvas(a.worldPt as any) as number[];
                    setTextAnnos((prev) => prev.filter((x) => x.id !== a.id));
                    setTextEditor({ canvasX: cpNow[0], canvasY: cpNow[1], worldPt: a.worldPt, value: a.text });
                    setTimeout(() => {
                      textEditorRef.current?.focus();
                      textEditorRef.current?.select();
                    }, 0);
                  }}
                  title="Sürükle: taşı · Çift tık: düzenle · Sağ tık: sil"
                  style={{
                    position: 'absolute',
                    left: cp[0],
                    top: cp[1],
                    transform: 'translate(0, -50%)',
                    color: a.color,
                    font: `${a.fontSize}px ${a.fontFamily}`,
                    fontWeight: 600,
                    textShadow: '0 1px 2px rgba(0,0,0,0.85)',
                    pointerEvents: 'auto',
                    cursor: 'move',
                    whiteSpace: 'nowrap',
                    zIndex: 15,
                    userSelect: 'none',
                    padding: '2px 4px',
                  }}
                >{a.text}</div>
              );
            });
          })()}

          {/* Doppler spectral overlays */}
          {activeTool === 'spectral' && activeSeries && (() => {
            const vp = getViewportForSpectral();
            const el = viewportRef.current;
            const width = el?.clientWidth ?? 0;
            const nodes: ReactNode[] = [];
            void overlayTick;

            // Locked readouts (horizontal lines with labels)
            if (vp) {
              const currentImageId: string | undefined = (vp as any).getCurrentImageId?.();
              for (const r of readouts) {
                if (r.imageId && currentImageId && r.imageId !== currentImageId) continue;
                const cy = imagePxYToCanvasY(r.imagePxY);
                if (cy == null) continue;
                nodes.push(
                  <div key={r.id} style={{ position: 'absolute', left: 0, top: cy, width, pointerEvents: 'none', zIndex: 14 }}>
                    <div style={{ position: 'absolute', left: 0, top: 0, width, height: 1, background: '#51cf66', opacity: 0.8 }} />
                    <span
                      style={{
                        position: 'absolute', left: 8, top: -10, background: 'rgba(0,0,0,0.7)', color: '#51cf66',
                        padding: '1px 6px', borderRadius: 3, fontSize: 11, fontFamily: 'ui-monospace, monospace',
                        pointerEvents: 'auto',
                      }}
                      onContextMenu={(e) => { e.preventDefault(); setReadouts((prev) => prev.filter((x) => x.id !== r.id)); }}
                      title="Sağ tık: sil"
                    >
                      v {r.velocityMps.toFixed(2)} m/s · p {r.pressureMmHg.toFixed(1)} mmHg
                    </span>
                  </div>
                );
              }

              // Baseline line (from calibration)
              if (dopplerCal) {
                const by = imagePxYToCanvasY(dopplerCal.baselineImagePxY);
                if (by != null) {
                  nodes.push(
                    <div key="baseline" style={{ position: 'absolute', left: 0, top: by, width, height: 1, background: 'rgba(255,212,59,0.6)', borderTop: '1px dashed rgba(255,212,59,0.9)', pointerEvents: 'none', zIndex: 12 }}>
                      <span style={{ position: 'absolute', left: 4, top: -14, color: '#ffd43b', fontSize: 10, fontFamily: 'ui-monospace, monospace', textShadow: '0 1px 2px #000' }}>0 m/s</span>
                    </div>
                  );
                }
              }
            }

            // Live crosshair
            if (crosshairY != null) {
              nodes.push(
                <div key="live-crosshair" style={{ position: 'absolute', left: 0, top: crosshairY, width, height: 1, background: '#4dabf7', pointerEvents: 'none', zIndex: 13 }} />
              );
            }

            // Calibration instruction banner
            if (calibStage !== 'idle') {
              nodes.push(
                <div key="calib-banner" style={{ position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)', background: 'rgba(255,212,59,0.92)', color: '#000', padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 700, zIndex: 20 }}>
                  {calibStage === 'baseline' ? '1/2: Baseline (0 m/s) satırına tıkla' : '2/2: Bilinen hız satırına tıkla'}
                </div>
              );
            }

            // Live readout card top-left
            if (liveReadout || dopplerCal) {
              nodes.push(
                <div key="readout-card" style={{
                  position: 'absolute', top: 8, left: 8, zIndex: 20,
                  background: 'rgba(0,0,0,0.85)', color: '#fff', padding: '6px 10px',
                  borderRadius: 6, border: '1px solid rgba(255,255,255,0.2)',
                  fontFamily: 'ui-monospace, monospace', fontSize: 12, lineHeight: 1.35, minWidth: 140,
                }}>
                  {liveReadout ? (
                    <>
                      <div><span style={{ color: '#4dabf7' }}>v</span> {liveReadout.velocityMps.toFixed(2)} m/s</div>
                      <div><span style={{ color: '#4dabf7' }}>p</span> {liveReadout.pressureMmHg.toFixed(2)} mmHg</div>
                    </>
                  ) : (
                    <div style={{ opacity: 0.6 }}>Fare ile satır hizala</div>
                  )}
                </div>
              );
            } else if (activeTool === 'spectral' && !dopplerCal && calibStage === 'idle') {
              nodes.push(
                <div key="no-cal-hint" style={{
                  position: 'absolute', top: 8, left: 8, zIndex: 20,
                  background: 'rgba(0,0,0,0.85)', color: '#ffd43b', padding: '6px 10px',
                  borderRadius: 6, border: '1px solid #ffd43b', fontSize: 11, maxWidth: 240,
                }}>
                  Auto-calibration yok. "Kalibre Et" ile manuel ayarla.
                </div>
              );
            }

            return nodes;
          })()}

          {textEditor && (
            <div
              className="echo-text-editor"
              style={{
                position: 'absolute',
                left: textEditor.canvasX,
                top: textEditor.canvasY,
                transform: 'translate(0, -50%)',
                zIndex: 20,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: 'rgba(0,0,0,0.82)',
                padding: '6px 8px',
                borderRadius: 6,
                border: `1px solid ${annoColor}`,
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <input
                ref={textEditorRef}
                type="text"
                value={textEditor.value}
                placeholder="Yazı..."
                onChange={(e) => setTextEditor({ ...textEditor, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitTextAnnotation(textEditor.value); }
                  else if (e.key === 'Escape') { e.preventDefault(); setTextEditor(null); }
                }}
                style={{
                  background: 'transparent',
                  color: annoColor,
                  border: 'none',
                  outline: 'none',
                  font: `${annoFontSize}px ${annoFontFamily}`,
                  minWidth: 160,
                  padding: 0,
                }}
              />
              <button
                onClick={() => commitTextAnnotation(textEditor.value)}
                title="Ekle (Enter)"
                style={{ background: annoColor, color: '#000', border: 'none', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}
              >OK</button>
              <button
                onClick={() => setTextEditor(null)}
                title="İptal (Esc)"
                style={{ background: 'transparent', color: '#fff', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 4, padding: '2px 6px', cursor: 'pointer', fontSize: 11 }}
              >✕</button>
            </div>
          )}
         </div>

        {activeSeries && (() => {
          // Only US / XA / IVUS / OCT are true cine modalities. DX, CR, MG, RF
          // are single-shot radiographs (often stored as 2-frame paired views
          // or L/R) — never auto-play those; cine controls only add flicker.
          const mod = (activeSeries.modality || '').toUpperCase();
          const isCine = ['US', 'XA', 'IVUS', 'OCT'].includes(mod);
          const showCine = isCine && totalFrames > 1;
          const multiFrameNav = totalFrames > 1; // prev/next frame navigation (works for any modality)
          return (
            <div className="echo-transport echo-transport-bar">
              {seriesList.length > 1 && (
                <button
                  onClick={() => gotoSeries(-1)}
                  disabled={seriesList.findIndex((s) => s.seriesInstanceUID === activeSeries.seriesInstanceUID) === 0}
                  title="Önceki seri"
                >⏮</button>
              )}
              {multiFrameNav && <>
                <button onClick={() => seekFrame(frameIndex - 1)} title="Önceki frame">‹</button>
                {showCine && (
                  <button onClick={() => setPlaying((p) => !p)} title={playing ? 'Duraklat' : 'Oynat'}>
                    {playing ? '❚❚' : '►'}
                  </button>
                )}
                <button onClick={() => seekFrame(frameIndex + 1)} title="Sonraki frame">›</button>
              </>}
              {seriesList.length > 1 && (
                <button
                  onClick={() => gotoSeries(1)}
                  disabled={seriesList.findIndex((s) => s.seriesInstanceUID === activeSeries.seriesInstanceUID) === seriesList.length - 1}
                  title="Sonraki seri"
                >⏭</button>
              )}
              {multiFrameNav && (
                <input
                  type="range"
                  min={0}
                  max={totalFrames - 1}
                  value={frameIndex}
                  onChange={(e) => seekFrame(Number(e.target.value))}
                />
              )}
              <span>{frameIndex + 1} / {totalFrames}</span>
              {showCine && <>
                <span style={{ opacity: 0.7 }}>FPS</span>
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={fps}
                  onChange={(e) => setFps(Math.max(1, Math.min(60, Number(e.target.value) || 24)))}
                  style={{ width: 50, padding: '2px 4px', background: 'transparent', color: '#fff', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 4 }}
                />
              </>}
              <button onClick={saveCurrentFrameImage} title="Resim Kaydet (PNG)">📷</button>
              {showCine && (
                <button onClick={saveCineAsVideo} disabled={!!exporting} title="Video Kaydet (WebM)">
                  {exporting ? '⏺' : '🎞'}
                </button>
              )}
              <button onClick={saveSeriesAsDicom} title="DICOM İndir (.dcm)">💾</button>
              {exporting && <span style={{ fontSize: 11, opacity: 0.8 }}>{exporting}</span>}
            </div>
          );
        })()}
        </div>

        <aside className="echo-measure-panel">
          <h2>Araçlar &amp; Ölçümler</h2>

          <section className="echo-measure-section">
            <h3>W/L Ön-Ayar</h3>
            <div className="echo-tool-grid cols-3">
              <button className="echo-tool-btn" onClick={() => applyVoiPreset(-600, 1500)}>Akciğer</button>
              <button className="echo-tool-btn" onClick={() => applyVoiPreset(50, 400)}>Mediasten</button>
              <button className="echo-tool-btn" onClick={() => applyVoiPreset(500, 2000)}>Kemik</button>
              <button className="echo-tool-btn" onClick={() => applyVoiPreset(40, 400)}>Abdomen</button>
              <button className="echo-tool-btn" onClick={() => applyVoiPreset(50, 350)}>Yumuşak</button>
              <button className="echo-tool-btn" onClick={() => resetVoi()}>Otomatik</button>
            </div>
            <div className="echo-tool-grid" style={{ marginTop: 4 }}>
              <button
                className="echo-tool-btn"
                style={{ gridColumn: '1 / -1' }}
                onClick={() => resetVoi()}
                title="W/L'yi DICOM varsayılanına / auto-hesaba döndür"
              >W/L Reset</button>
            </div>
          </section>

          <section className="echo-measure-section">
            <h3>Görüntüleme</h3>
            <div className="echo-tool-grid cols-2">
              <button className={`echo-tool-btn ${activeTool === 'pan' ? 'active' : ''}`} onClick={() => setActiveTool('pan')}>Pan</button>
              <button className={`echo-tool-btn ${activeTool === 'zoom' ? 'active' : ''}`} onClick={() => setActiveTool('zoom')}>Zoom</button>
            </div>

            <div className="echo-sub-label">Rotasyon</div>
            <div className="echo-tool-grid cols-4">
              <button className="echo-tool-btn" onClick={() => rotateBy(90)}>⟳ 90°</button>
              <button className="echo-tool-btn" onClick={() => rotateBy(-90)}>⟲ 90°</button>
              <button className="echo-tool-btn" onClick={() => rotateBy(1)}>⟳ 1°</button>
              <button className="echo-tool-btn" onClick={() => rotateBy(-1)}>⟲ 1°</button>
            </div>

            <div className="echo-sub-label">Mirror</div>
            <div className="echo-tool-grid cols-2">
              <button className="echo-tool-btn" onClick={() => mirrorActor('x')}>↔</button>
              <button className="echo-tool-btn" onClick={() => mirrorActor('y')}>↕</button>
            </div>

            <div className="echo-sub-label">Genişlet / Daralt</div>
            <div className="echo-tool-grid cols-4">
              <button className="echo-tool-btn" onClick={() => stretchActor('x', 1.05)}>↔ +</button>
              <button className="echo-tool-btn" onClick={() => stretchActor('x', 1 / 1.05)}>↔ −</button>
              <button className="echo-tool-btn" onClick={() => stretchActor('y', 1.05)}>↕ +</button>
              <button className="echo-tool-btn" onClick={() => stretchActor('y', 1 / 1.05)}>↕ −</button>
            </div>

            <div className="echo-tool-grid" style={{ marginTop: 6 }}>
              <button className="echo-tool-btn" style={{ gridColumn: '1 / -1' }} onClick={() => {
                const eng = renderingEngineRef.current;
                const vp = eng?.getViewport(VIEWPORT_ID) as any;
                if (!vp) return;
                try { vp.resetCamera?.({ resetPan: true, resetZoom: true, resetToCenter: true }); } catch {}
                try { vp.setRotation?.(0); } catch {}
                applyActorTransform((actor) => actor?.setScale?.(1, 1, 1));
                fitImageToViewport(vp);
                vp.render();
              }}>Reset View</button>
            </div>
          </section>

          <section className="echo-measure-section">
            <h3>Ölçüm</h3>
            <div className="echo-tool-grid">
              <button className={`echo-tool-btn ${activeTool === 'length' ? 'active' : ''}`} onClick={() => setActiveTool('length')}>Uzunluk</button>
              <button className={`echo-tool-btn ${activeTool === 'angle' ? 'active' : ''}`} onClick={() => setActiveTool('angle')}>Açı</button>
              <button className={`echo-tool-btn ${activeTool === 'area' ? 'active' : ''}`} onClick={() => setActiveTool('area')}>Alan (ROI)</button>
              <button className="echo-tool-btn" onClick={clearMeasurements}>Temizle</button>
            </div>
          </section>

          <section className="echo-measure-section">
            <h3>Annotation</h3>
            <div className="echo-tool-grid cols-3">
              <button className={`echo-tool-btn ${activeTool === 'arrow' ? 'active' : ''}`} onClick={() => setActiveTool('arrow')} title="Sürükleyerek ok çiz">Ok</button>
              <button className={`echo-tool-btn ${activeTool === 'text' ? 'active' : ''}`} onClick={() => setActiveTool('text')} title="Sürükle, bırak, yazı gir">Yazı</button>
              <button className="echo-tool-btn" onClick={clearMeasurements} title="Tüm annotation/ölçüm temizle">Temizle</button>
            </div>
            <div className="echo-sub-label">Renk</div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {['#ffd43b', '#ff6b6b', '#51cf66', '#4dabf7', '#ffffff', '#000000'].map((c) => (
                <button
                  key={c}
                  onClick={() => setAnnoColor(c)}
                  title={c}
                  style={{
                    width: 22, height: 22, borderRadius: 4, border: annoColor === c ? '2px solid var(--nd-accent)' : '1px solid var(--nd-border)',
                    background: c, cursor: 'pointer', padding: 0,
                  }}
                />
              ))}
              <input
                type="color"
                value={annoColor}
                onChange={(e) => setAnnoColor(e.target.value)}
                style={{ width: 26, height: 22, border: '1px solid var(--nd-border)', borderRadius: 4, padding: 0, background: 'transparent', cursor: 'pointer' }}
              />
            </div>
            <div className="echo-sub-label">Yazı</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select
                value={annoFontFamily}
                onChange={(e) => setAnnoFontFamily(e.target.value)}
                style={{ flex: 1, padding: '3px 5px', background: 'var(--nd-bg)', color: 'var(--nd-text)', border: '1px solid var(--nd-border)', borderRadius: 4, fontSize: 11 }}
              >
                <option value="Inter, system-ui, sans-serif">Sans</option>
                <option value="Georgia, serif">Serif</option>
                <option value="ui-monospace, Menlo, monospace">Mono</option>
              </select>
              <input
                type="number"
                min={8}
                max={48}
                value={annoFontSize}
                onChange={(e) => setAnnoFontSize(Math.max(8, Math.min(48, Number(e.target.value) || 14)))}
                style={{ width: 46, padding: '3px 5px', background: 'var(--nd-bg)', color: 'var(--nd-text)', border: '1px solid var(--nd-border)', borderRadius: 4, fontSize: 11 }}
                title="Punto"
              />
            </div>
          </section>

          {!isXray && (
          <section className="echo-measure-section">
            <h3>Doppler / Spektral</h3>
            <div className="echo-tool-grid cols-2">
              <button
                className={`echo-tool-btn ${activeTool === 'spectral' ? 'active' : ''}`}
                onClick={() => setActiveTool('spectral')}
                title="Yatay crosshair; hız (m/s) ve Bernoulli basıncı (mmHg)"
              >Crosshair</button>
              <button
                className="echo-tool-btn"
                onClick={() => {
                  setDopplerCal(null);
                  setReadouts([]);
                  setCalibStage('baseline');
                  calibBaselineRef.current = null;
                  setActiveTool('spectral');
                }}
                title="Manuel kalibrasyon: 1) baseline satırı · 2) bilinen hız satırı"
              >Kalibre Et</button>
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--nd-text-dim)', marginTop: 6, lineHeight: 1.4 }}>
              {dopplerCal
                ? <>
                    <div><b>{(dopplerCal.mpsPerImagePx * 100).toFixed(3)}</b> m/s / 100px · <i>{dopplerCal.source === 'auto' ? 'DICOM auto' : 'manuel'}</i></div>
                  </>
                : <div style={{ color: '#ff6b6b' }}>Kalibrasyon yok</div>}
              {calibStage === 'baseline' && <div style={{ color: '#ffd43b' }}>1/2: Baseline (0 m/s) satırına tıkla</div>}
              {calibStage === 'ref' && <div style={{ color: '#ffd43b' }}>2/2: Bilinen hız satırına tıkla</div>}
            </div>
            {readouts.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <button className="echo-tool-btn" style={{ width: '100%' }} onClick={() => setReadouts([])}>Ölçümleri Temizle ({readouts.length})</button>
              </div>
            )}
          </section>
          )}

          <section className="echo-measure-section">
            <h3>Sonuçlar</h3>
            {measurements.length === 0 ? (
              <p className="echo-empty">Henüz ölçüm yok.</p>
            ) : (
              <ul className="echo-measure-list">
                {measurements.map((m) => (
                  <li key={m.id}>
                    <span>{m.label}</span>
                    <span className="value">{m.value}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="echo-measure-section">
            <h3>Seri Bilgisi</h3>
            {activeSeries ? (
              <div style={{ fontSize: 11, color: 'var(--nd-text-dim)', lineHeight: 1.6 }}>
                <div><b>Hasta:</b> {activeSeries.patientName || '-'}</div>
                <div><b>Çalışma:</b> {activeSeries.studyDescription || '-'}</div>
                <div><b>Modalite:</b> {activeSeries.modality || '-'}</div>
                <div><b>Frame:</b> {activeSeries.numImages}</div>
                {(activeSeries as any).geCineDecoded && (
                  <div style={{ marginTop: 10, padding: 10, background: 'rgba(50, 150, 80, 0.08)', border: '1px solid rgba(50, 150, 80, 0.3)', borderRadius: 8, color: 'var(--nd-accent)', fontSize: 11, lineHeight: 1.5 }}>
                    ✓ <b>GE Vivid cine decoded</b> (reverse-engineered SlicerHeart algorithm). {activeSeries.numImages} frame · {(activeSeries as any).frameTimeMs ? `${(1000 / (activeSeries as any).frameTimeMs).toFixed(1)} fps` : ''}
                  </div>
                )}
                {(activeSeries as any).hasGEPrivateCine && !(activeSeries as any).geCineDecoded && (
                  <div style={{ marginTop: 10, padding: 10, background: 'rgba(217, 45, 32, 0.08)', border: '1px solid rgba(217, 45, 32, 0.3)', borderRadius: 8, color: 'var(--nd-danger)', fontSize: 11, lineHeight: 1.5 }}>
                    ⚠ <b>GE Vivid proprietary cine</b> saptandı ama decode edilemedi (muhtemelen 3D/volumetric format). 2D cine için desteklenir; 3D için EchoPAC gerekli.
                  </div>
                )}
              </div>
            ) : (
              <p className="echo-empty">Seri seçilmedi.</p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
