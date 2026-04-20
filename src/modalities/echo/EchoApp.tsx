import { useCallback, useEffect, useRef, useState } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import { initCornerstone } from '../ct/core/initCornerstone';
import { loadEchoFiles, type EchoSeriesInfo } from './echoLoader';
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

type EchoTool = 'pan' | 'zoom' | 'window' | 'length' | 'angle' | 'area' | 'probe';

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
}

export default function EchoApp({ onBack, initialFiles, title }: EchoAppProps = {}) {
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
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});

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

    applyLinearInterpolation(vp);
    // Force canvas resolution to match CSS size (fixes browser NEAREST stretching of small GL canvas)
    try { engine.resize(true, true); } catch {}
    try { (vp as any).resetCamera?.({ resetPan: true, resetZoom: true, resetToCenter: true }); } catch {}
    fitImageToViewport(vp);
    vp.render();
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
    } = cornerstoneTools;
    const toolsToAdd = [PanTool, ZoomTool, WindowLevelTool, LengthTool, AngleTool, PlanarFreehandROITool, ProbeTool, StackScrollTool];
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
  }, []);

  // Apply active tool
  useEffect(() => {
    if (!toolGroupInitRef.current) return;
    const tg = cornerstoneTools.ToolGroupManager.getToolGroup(TOOL_GROUP_ID);
    if (!tg) return;
    const {
      PanTool, ZoomTool, WindowLevelTool, LengthTool, AngleTool, PlanarFreehandROITool, ProbeTool,
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
    };
    const selected = toolMap[activeTool];
    for (const name of Object.values(toolMap)) {
      if (name === selected) {
        tg.setToolActive(name, { bindings });
      } else if (name !== PanTool.toolName || activeTool !== 'pan') {
        try { tg.setToolPassive(name); } catch {}
      }
    }
    tg.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }] });
  }, [activeTool]);

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
          <div ref={viewportRef} className="echo-viewport" style={{ display: activeSeries ? 'block' : 'none' }} />

          {activeSeries && totalFrames > 1 && (
            <div className="echo-transport">
              <button onClick={() => seekFrame(frameIndex - 1)} title="Önceki frame">‹</button>
              <button onClick={() => setPlaying((p) => !p)} title={playing ? 'Duraklat' : 'Oynat'}>
                {playing ? '❚❚' : '►'}
              </button>
              <button onClick={() => seekFrame(frameIndex + 1)} title="Sonraki frame">›</button>
              <input
                type="range"
                min={0}
                max={totalFrames - 1}
                value={frameIndex}
                onChange={(e) => seekFrame(Number(e.target.value))}
              />
              <span>{frameIndex + 1} / {totalFrames}</span>
              <span style={{ opacity: 0.7 }}>FPS</span>
              <input
                type="number"
                min={1}
                max={60}
                value={fps}
                onChange={(e) => setFps(Math.max(1, Math.min(60, Number(e.target.value) || 24)))}
                style={{ width: 50, padding: '2px 4px', background: 'transparent', color: '#fff', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 4 }}
              />
            </div>
          )}
        </div>

        <aside className="echo-measure-panel">
          <h2>Araçlar &amp; Ölçümler</h2>

          <section className="echo-measure-section">
            <h3>Görüntüleme</h3>
            <div className="echo-tool-grid">
              <button className={`echo-tool-btn ${activeTool === 'pan' ? 'active' : ''}`} onClick={() => setActiveTool('pan')}>Pan</button>
              <button className={`echo-tool-btn ${activeTool === 'zoom' ? 'active' : ''}`} onClick={() => setActiveTool('zoom')}>Zoom</button>
              <button className={`echo-tool-btn ${activeTool === 'window' ? 'active' : ''}`} onClick={() => setActiveTool('window')}>W/L drag</button>
              <button className={`echo-tool-btn ${activeTool === 'probe' ? 'active' : ''}`} onClick={() => setActiveTool('probe')}>Probe</button>
            </div>
            <div style={{ marginTop: 8, fontSize: 10.5, color: 'var(--nd-text-dim)', textTransform: 'uppercase', letterSpacing: '.08em' }}>W/L Ön-ayar</div>
            <div className="echo-tool-grid" style={{ marginTop: 6 }}>
              <button className="echo-tool-btn" onClick={() => applyVoiPreset(-600, 1500)}>Akciğer</button>
              <button className="echo-tool-btn" onClick={() => applyVoiPreset(50, 400)}>Mediasten</button>
              <button className="echo-tool-btn" onClick={() => applyVoiPreset(500, 2000)}>Kemik</button>
              <button className="echo-tool-btn" onClick={() => applyVoiPreset(40, 400)}>Abdomen</button>
              <button className="echo-tool-btn" onClick={() => applyVoiPreset(50, 350)}>Yumuşak Doku</button>
              <button className="echo-tool-btn" onClick={() => resetVoi()}>Otomatik</button>
            </div>
            <div className="echo-tool-grid" style={{ marginTop: 8 }}>
              <button className="echo-tool-btn" onClick={() => rotateBy(90)}>Rotate 90°</button>
              <button className="echo-tool-btn" onClick={() => rotateBy(-90)}>Rotate -90°</button>
              <button className="echo-tool-btn" onClick={() => rotateBy(1)}>Rot +1°</button>
              <button className="echo-tool-btn" onClick={() => rotateBy(-1)}>Rot -1°</button>
              <button className="echo-tool-btn" onClick={() => mirrorActor('x')}>Mirror ↔</button>
              <button className="echo-tool-btn" onClick={() => mirrorActor('y')}>Mirror ↕</button>
              <button className="echo-tool-btn" onClick={() => stretchActor('x', 1.05)}>Genişlet ↔</button>
              <button className="echo-tool-btn" onClick={() => stretchActor('x', 1 / 1.05)}>Daralt ↔</button>
              <button className="echo-tool-btn" onClick={() => stretchActor('y', 1.05)}>Uzat ↕</button>
              <button className="echo-tool-btn" onClick={() => stretchActor('y', 1 / 1.05)}>Kısalt ↕</button>
              <button className="echo-tool-btn" onClick={() => {
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
