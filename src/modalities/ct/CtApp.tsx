import { useState, useCallback, useRef, useEffect } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import ctModuleCss from './ct-module.css?inline';
import { useTheme } from '../../theme/ThemeProvider';
import { expandAndFilterDicom } from '../../shared/fileIntake';
// Rebind on every module eval so HMR / debug overwrites get restored
Object.defineProperty(window, '__cornerstone', {
  configurable: true,
  get: () => cornerstone,
});
import { initCornerstone, applyLinearInterpolation } from '../../shared/core/cornerstone';
import { loadDicomFiles, createVolume, DicomSeriesInfo } from './core/dicomLoader';
import { setupToolGroups, destroyToolGroups, resetCrosshairsToCenter, enterDoubleObliqueMode, exitDoubleObliqueMode, setActiveTool } from './core/toolManager';
import type { ViewportMode } from './components/ViewportGrid';
import { Toolbar } from './components/Toolbar';
import { DicomDropzone } from './components/DicomDropzone';
import { ViewportGrid } from './components/ViewportGrid';
import { WindowLevelPresets } from './components/WindowLevelPresets';
import { MetadataPanel } from './components/MetadataPanel';
import { SegmentationPanel } from './components/SegmentationPanel';
import { VolumeStats } from './components/VolumeStats';
import { RenderModeSelector } from './components/RenderModeSelector';
import { SeriesPanel } from './components/SeriesPanel';
import { TAVIPanel, TAVIPanelHandle } from './components/TAVIPanel';
import { ViewAnglePresets } from './components/ViewAnglePresets';
import { HUProbeOverlay } from './components/HUProbeOverlay';
import { DicomInfoOverlay } from './components/DicomInfoOverlay';
import { HandMRPanel, HandMRPanelHandle } from './components/HandMRPanel';
import { LeftAtriumPanel, type LeftAtriumPanelHandle } from './components/LeftAtriumPanel';
import { AortaPanel, type AortaPanelHandle } from './components/AortaPanel';
import { LAAPanel, type LAAPanelHandle } from './components/LAAPanel';
import { LVADASPanel, type LVADASPanelHandle } from './components/LVADASPanel';

const RENDERING_ENGINE_ID = 'myRenderingEngine';
const VOLUME_ID = 'cornerstoneStreamingImageVolume:myVolume';
const VIEWPORT_IDS = ['axial', 'sagittal', 'coronal', 'volume3d'];
const MPR_VIEWPORT_IDS = ['axial', 'sagittal', 'coronal'];

type RightPanel = null | '3d' | 'tavi' | 'hand-mr' | 'la' | 'aorta' | 'laa' | 'lv-adas';

interface VolumeResult {
  name: string;
  volumeCm3: number;
}

export type CtInitialPanel = null | '3d' | 'tavi' | 'hand-mr' | 'la' | 'aorta' | 'laa' | 'lv-adas';

interface CtAppProps {
  onBack?: () => void;
  initialFiles?: File[];
  initialPanel?: CtInitialPanel;
  title?: string;
}

function ThemeToggleBtn() {
  const { theme, toggle } = useTheme();
  return (
    <button className="open-btn" onClick={toggle} title="Tema" aria-label="theme">
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}

export default function App({ onBack, initialFiles, initialPanel = null, title }: CtAppProps = {}) {
  const [isInitialized, setIsInitialized] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [seriesList, setSeriesList] = useState<DicomSeriesInfo[]>([]);
  const [activeSeries, setActiveSeries] = useState<DicomSeriesInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingProgress, setLoadingProgress] = useState('');
  const [showMetadata, setShowMetadata] = useState(false);
  const [showSegmentation, setShowSegmentation] = useState(false);
  const [rightPanel, setRightPanel] = useState<RightPanel>(initialPanel ?? null);
  const [reportExpanded, setReportExpanded] = useState(false);
  const [volumeResults, setVolumeResults] = useState<VolumeResult[]>([]);
  const [viewportMode, setViewportMode] = useState<ViewportMode>('standard');
  const [hide3dPanel, setHide3dPanel] = useState(true);
  const renderingEngineRef = useRef<cornerstone.RenderingEngine | null>(null);
  const taviPanelRef = useRef<TAVIPanelHandle>(null);
  const handMRPanelRef = useRef<HandMRPanelHandle>(null);
  const leftAtriumPanelRef = useRef<LeftAtriumPanelHandle>(null);
  const laFileInputRef = useRef<HTMLInputElement>(null);
  const [pendingLAAction, setPendingLAAction] = useState<null | 'save' | { load: File }>(null);
  const aortaPanelRef = useRef<AortaPanelHandle>(null);
  const aortaFileInputRef = useRef<HTMLInputElement>(null);
  const [pendingAortaAction, setPendingAortaAction] = useState<null | 'save' | { load: File }>(null);
  const laaPanelRef = useRef<LAAPanelHandle>(null);
  const laaFileInputRef = useRef<HTMLInputElement>(null);
  const [pendingLAAAction, setPendingLAAAction] = useState<null | 'save' | { load: File }>(null);
  const lvadasPanelRef = useRef<LVADASPanelHandle>(null);
  const lvadasFileInputRef = useRef<HTMLInputElement>(null);
  const [pendingLVADASAction, setPendingLVADASAction] = useState<null | 'save' | { load: File }>(null);
  const toolGroupsInitialized = useRef(false);
  const vol3dPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = document.createElement('style');
    el.setAttribute('data-neodw-module', 'ct');
    el.textContent = ctModuleCss;
    document.head.appendChild(el);
    return () => el.remove();
  }, []);

  useEffect(() => {
    initCornerstone()
      .then(() => {
        const engine = new cornerstone.RenderingEngine(RENDERING_ENGINE_ID);
        renderingEngineRef.current = engine;
        setIsInitialized(true);
      })
      .catch((err) => {
        setError(`Failed to initialize: ${err.message}`);
      });

    return () => {
      destroyToolGroups();
      renderingEngineRef.current?.destroy();
    };
  }, []);

  // When the 3D side panel is open, resize Cornerstone canvases.
  // We no longer move DOM elements — the 3D viewport stays in its grid position
  // and CSS handles visual placement.
  useEffect(() => {
    setTimeout(() => {
      renderingEngineRef.current?.resize(true, false);

      // When entering tavi-oblique mode, disable MIP on the oblique viewports
      // (Reference=axial, Working=coronal) so they show clean thin-slice cross-sections
      if (viewportMode === 'tavi-oblique') {
        const engine = renderingEngineRef.current;
        if (engine) {
          for (const vpId of ['axial', 'coronal']) {
            const vp = engine.getViewport(vpId);
            if (vp && 'setBlendMode' in vp) {
              (vp as any).setBlendMode(cornerstone.Enums.BlendModes.COMPOSITE);
              vp.render();
            }
          }
        }
      }
    }, 100);
  }, [rightPanel, viewportMode]);

  // LA / Aorta panels need the bottom-right 3D cell visible for the mesh overlay
  // (portal into #viewport-3d). Un-hide while either is active; restore on close.
  useEffect(() => {
    if (rightPanel === 'la' || rightPanel === 'aorta' || rightPanel === 'laa' || rightPanel === 'lv-adas') {
      setHide3dPanel(false);
      const t = setTimeout(resizeViewports, 60);
      return () => clearTimeout(t);
    }
    setHide3dPanel(true);
    const t = setTimeout(resizeViewports, 60);
    return () => clearTimeout(t);
  }, [rightPanel]);

  // Pending LA save/load: panel must be mounted before ref is valid.
  useEffect(() => {
    if (!pendingLAAction) return;
    if (rightPanel !== 'la') return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const h = leftAtriumPanelRef.current;
      if (!h) { requestAnimationFrame(tick); return; }
      if (pendingLAAction === 'save') h.saveSession();
      else void h.loadSessionFile(pendingLAAction.load);
      setPendingLAAction(null);
    };
    requestAnimationFrame(tick);
    return () => { cancelled = true; };
  }, [rightPanel, pendingLAAction]);

  // Pending Aorta save/load
  useEffect(() => {
    if (!pendingAortaAction) return;
    if (rightPanel !== 'aorta') return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const h = aortaPanelRef.current;
      if (!h) { requestAnimationFrame(tick); return; }
      if (pendingAortaAction === 'save') h.saveSession();
      else void h.loadSessionFile(pendingAortaAction.load);
      setPendingAortaAction(null);
    };
    requestAnimationFrame(tick);
    return () => { cancelled = true; };
  }, [rightPanel, pendingAortaAction]);

  // Pending LAA save/load
  useEffect(() => {
    if (!pendingLAAAction) return;
    if (rightPanel !== 'laa') return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const h = laaPanelRef.current;
      if (!h) { requestAnimationFrame(tick); return; }
      if (pendingLAAAction === 'save') h.saveSession();
      else void h.loadSessionFile(pendingLAAAction.load);
      setPendingLAAAction(null);
    };
    requestAnimationFrame(tick);
    return () => { cancelled = true; };
  }, [rightPanel, pendingLAAAction]);

  // Pending LV-ADAS save/load
  useEffect(() => {
    if (!pendingLVADASAction) return;
    if (rightPanel !== 'lv-adas') return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const h = lvadasPanelRef.current;
      if (!h) { requestAnimationFrame(tick); return; }
      if (pendingLVADASAction === 'save') h.saveSession();
      else void h.loadSessionFile(pendingLVADASAction.load);
      setPendingLVADASAction(null);
    };
    requestAnimationFrame(tick);
    return () => { cancelled = true; };
  }, [rightPanel, pendingLVADASAction]);

  // Auto W/L removed — user controls W/L via presets (1-9 keys) or mouse drag (W/L tool)

  // Arrow keys: scroll through slices on the last-clicked viewport
  useEffect(() => {
    if (!activeSeries) return;
    let lastClickedVpId = 'axial';

    // Track which viewport was last clicked
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      for (const vpId of MPR_VIEWPORT_IDS) {
        const el = document.getElementById(`viewport-${vpId}`);
        if (el?.contains(target)) { lastClickedVpId = vpId; break; }
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      e.preventDefault();

      const engine = renderingEngineRef.current;
      if (!engine) return;

      const step = e.shiftKey ? 5 : 1;
      const volume = cornerstone.cache.getVolume(VOLUME_ID);
      const spacing = volume?.imageData?.getSpacing?.() || [1, 1, 1];
      const sliceSpacing = Math.min(spacing[0], spacing[1], spacing[2]);

      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // Up/Down: scroll current viewport through slices
        const vp = engine.getViewport(lastClickedVpId) as cornerstone.Types.IVolumeViewport | undefined;
        if (!vp) return;
        const cam = vp.getCamera();
        if (!cam.viewPlaneNormal || !cam.focalPoint || !cam.position) return;
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        const dist = delta * step * sliceSpacing;
        const n = cam.viewPlaneNormal;
        vp.setCamera({
          ...cam,
          focalPoint: [cam.focalPoint[0] + n[0] * dist, cam.focalPoint[1] + n[1] * dist, cam.focalPoint[2] + n[2] * dist] as cornerstone.Types.Point3,
          position: [cam.position[0] + n[0] * dist, cam.position[1] + n[1] * dist, cam.position[2] + n[2] * dist] as cornerstone.Types.Point3,
        });
        vp.render();
      } else {
        // Left/Right: scroll the OTHER two viewports (not the current one)
        // This creates a cross-navigation effect
        const otherVpIds = MPR_VIEWPORT_IDS.filter(id => id !== lastClickedVpId);
        for (const vpId of otherVpIds) {
          const vp = engine.getViewport(vpId) as cornerstone.Types.IVolumeViewport | undefined;
          if (!vp) continue;
          const cam = vp.getCamera();
          if (!cam.viewPlaneNormal || !cam.focalPoint || !cam.position) continue;
          const delta = e.key === 'ArrowRight' ? 1 : -1;
          const dist = delta * step * sliceSpacing;
          const n = cam.viewPlaneNormal;
          vp.setCamera({
            ...cam,
            focalPoint: [cam.focalPoint[0] + n[0] * dist, cam.focalPoint[1] + n[1] * dist, cam.focalPoint[2] + n[2] * dist] as cornerstone.Types.Point3,
            position: [cam.position[0] + n[0] * dist, cam.position[1] + n[1] * dist, cam.position[2] + n[2] * dist] as cornerstone.Types.Point3,
          });
          vp.render();
        }
      }
    };

    document.addEventListener('mousedown', handleClick);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeSeries]);

  const handleFilesLoaded = useCallback(
    async (files: File[]) => {
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

        if (series.length > 0) {
          await loadSeries(series[0]);
        } else {
          setError('No DICOM series found in the selected files.');
        }
      } catch (err: any) {
        setError(`Failed to load DICOM files: ${err.message}`);
      } finally {
        setIsLoading(false);
      }
    },
    [isInitialized]
  );

  useEffect(() => {
    if (isInitialized && initialFiles && initialFiles.length > 0) {
      void handleFilesLoaded(initialFiles);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInitialized]);

  // Open series in 2D stack viewer (single viewport, scroll through slices)
  // Track if stack viewport is enabled
  const stackVpEnabledRef = useRef(false);

  const open2DViewer = useCallback(async (series: DicomSeriesInfo) => {
    const engine = renderingEngineRef.current;
    if (!engine) return;

    setActiveSeries(series);
    setViewportMode('stack-2d');
    setRightPanel(null);
    setIsLoading(true);

    // Wait for DOM to update (stack-2d element needs to be in DOM)
    await new Promise(r => setTimeout(r, 300));

    try {
      const stackEl = document.getElementById('viewport-stack2d');
      if (!stackEl) throw new Error('Stack viewport element not found');

      // Enable a StackViewport on the stack2d element
      // First disable if already enabled
      if (stackVpEnabledRef.current) {
        try { engine.disableElement('stack2d'); } catch {}
      }

      engine.enableElement({
        viewportId: 'stack2d',
        type: cornerstone.Enums.ViewportType.STACK,
        element: stackEl,
      });
      stackVpEnabledRef.current = true;

      // Pre-load all images for smooth scrolling
      setLoadingProgress(`Loading ${series.imageIds.length} images...`);
      await Promise.all(
        series.imageIds.map(id =>
          cornerstone.imageLoader.loadAndCacheImage(id).catch(() => null)
        )
      );

      // Set the image stack on the viewport
      const vp = engine.getViewport('stack2d') as cornerstone.Types.IStackViewport;
      await vp.setStack(series.imageIds, Math.floor(series.imageIds.length / 2));

      // Create a separate tool group for the stack viewport (no Crosshairs!)
      try {
        const csTools = (window as any).cornerstoneTools;
        // Remove old stack tool group if exists
        try { csTools.ToolGroupManager.destroyToolGroup('stackToolGroup'); } catch {}
        const stackGroup = csTools.ToolGroupManager.createToolGroup('stackToolGroup');
        if (stackGroup) {
          stackGroup.addTool(csTools.WindowLevelTool.toolName);
          stackGroup.addTool(csTools.PanTool.toolName);
          stackGroup.addTool(csTools.ZoomTool.toolName);
          stackGroup.addTool(csTools.StackScrollTool.toolName);
          stackGroup.addTool(csTools.LengthTool.toolName);
          stackGroup.addTool(csTools.AngleTool.toolName);
          stackGroup.addTool(csTools.ArrowAnnotateTool.toolName);
          stackGroup.addViewport('stack2d', RENDERING_ENGINE_ID);

          // W/L on primary, Pan on middle, Zoom on right, scroll on wheel
          stackGroup.setToolActive(csTools.WindowLevelTool.toolName, {
            bindings: [{ mouseButton: csTools.Enums.MouseBindings.Primary }],
          });
          stackGroup.setToolActive(csTools.PanTool.toolName, {
            bindings: [{ mouseButton: csTools.Enums.MouseBindings.Auxiliary }],
          });
          stackGroup.setToolActive(csTools.ZoomTool.toolName, {
            bindings: [{ mouseButton: csTools.Enums.MouseBindings.Secondary }],
          });
          stackGroup.setToolActive(csTools.StackScrollTool.toolName, {
            bindings: [{ mouseButton: csTools.Enums.MouseBindings.Wheel }],
          });
        }
      } catch (e) { console.warn('[2D] Tool group setup failed:', e); }

      engine.resize(true, false);
      vp.resetCamera();
      vp.render();
    } catch (err: any) {
      setError(`Failed to open 2D viewer: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  }, [isInitialized]);

  const loadSeries = async (series: DicomSeriesInfo) => {
    const engine = renderingEngineRef.current;
    if (!engine) return;

    setActiveSeries(series);
    // If in 2D mode, switch back to MPR and disable stack viewport
    if (viewportMode === 'stack-2d') {
      setViewportMode('standard');
      if (stackVpEnabledRef.current) {
        try {
          const csTools = (window as any).cornerstoneTools;
          try { csTools.ToolGroupManager.destroyToolGroup('stackToolGroup'); } catch {}
        } catch {}
        try { engine.disableElement('stack2d'); } catch {}
        stackVpEnabledRef.current = false;
      }
    }
    setIsLoading(true);
    setVolumeResults([]);

    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));

    try {
      destroyToolGroups();
      toolGroupsInitialized.current = false;
      cornerstone.cache.purgeCache();

      const axialEl = document.getElementById('viewport-axial') as HTMLDivElement;
      const sagittalEl = document.getElementById('viewport-sagittal') as HTMLDivElement;
      const coronalEl = document.getElementById('viewport-coronal') as HTMLDivElement;
      const vol3dEl = document.getElementById('viewport-3d') as HTMLDivElement;

      if (!axialEl || !sagittalEl || !coronalEl || !vol3dEl) {
        throw new Error('Viewport elements not found in DOM');
      }

      const viewportInputArray: cornerstone.Types.PublicViewportInput[] = [
        {
          viewportId: 'axial',
          type: cornerstone.Enums.ViewportType.ORTHOGRAPHIC,
          element: axialEl,
          defaultOptions: { orientation: cornerstone.Enums.OrientationAxis.AXIAL },
        },
        {
          viewportId: 'sagittal',
          type: cornerstone.Enums.ViewportType.ORTHOGRAPHIC,
          element: sagittalEl,
          defaultOptions: { orientation: cornerstone.Enums.OrientationAxis.SAGITTAL },
        },
        {
          viewportId: 'coronal',
          type: cornerstone.Enums.ViewportType.ORTHOGRAPHIC,
          element: coronalEl,
          defaultOptions: { orientation: cornerstone.Enums.OrientationAxis.CORONAL },
        },
        {
          viewportId: 'volume3d',
          type: cornerstone.Enums.ViewportType.VOLUME_3D,
          element: vol3dEl,
          defaultOptions: { background: [0.1, 0.1, 0.15] as cornerstone.Types.RGB },
        },
      ];

      engine.setViewports(viewportInputArray);
      setupToolGroups(RENDERING_ENGINE_ID);
      toolGroupsInitialized.current = true;

      setLoadingProgress(`Loading images: 0/${series.imageIds.length}`);
      await createVolume(VOLUME_ID, series.imageIds, (loaded, total) => {
        setLoadingProgress(`Loading images: ${loaded}/${total}`);
      });

      await cornerstone.setVolumesForViewports(engine, [{ volumeId: VOLUME_ID }], VIEWPORT_IDS);

      // Set LINEAR interpolation on all MPR viewports for better reformat quality
      for (const vpId of VIEWPORT_IDS) {
        const vp = engine.getViewport(vpId) as cornerstone.Types.IVolumeViewport | undefined;
        if (vp) {
          vp.setProperties({ interpolationType: cornerstone.Enums.InterpolationType.LINEAR });
        }
      }

      const viewport3d = engine.getViewport('volume3d') as cornerstone.Types.IVolumeViewport;
      if (viewport3d) {
        const preset3d = (series.modality?.toUpperCase() === 'MR') ? 'MR-Default' : 'CT-Chest-Contrast-Enhanced';
        viewport3d.setProperties({ preset: preset3d });
      }

      // Modality-specific defaults
      const modality = series.modality?.toUpperCase() || '';
      const isCT = modality === 'CT';
      const isMR = modality === 'MR';

      for (const vpId of MPR_VIEWPORT_IDS) {
        const vp = engine.getViewport(vpId) as cornerstone.Types.IVolumeViewport | undefined;
        if (!vp || !('setBlendMode' in vp)) continue;

        if (isCT) {
          // CT: 5mm MIP slab + coronary W/L
          (vp as any).setBlendMode(cornerstone.Enums.BlendModes.MAXIMUM_INTENSITY_BLEND);
          (vp as any).setSlabThickness(5);
          vp.setProperties({ voiRange: { lower: 0, upper: 700 } });
        } else if (isMR) {
          // MR: AVERAGE blend with thin slab for smoother through-plane appearance
          (vp as any).setBlendMode(cornerstone.Enums.BlendModes.AVERAGE_INTENSITY_BLEND);
          (vp as any).setSlabThickness(3);
          // Auto W/L from data — don't override
        }
      }

      for (const vpId of VIEWPORT_IDS) {
        const vp = engine.getViewport(vpId);
        if (vp) vp.resetCamera();
      }
      engine.renderViewports(VIEWPORT_IDS);

      setTimeout(() => {
        try { resetCrosshairsToCenter(RENDERING_ENGINE_ID); } catch { /* ignore */ }
        setTimeout(() => { try { resetCrosshairsToCenter(RENDERING_ENGINE_ID); } catch { /* ignore */ } }, 300);
      }, 500);
    } catch (err: any) {
      setError(`Failed to load series: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleVolumeCalculated = useCallback((name: string, volumeCm3: number) => {
    setVolumeResults((prev) => {
      const existing = prev.findIndex((r) => r.name === name);
      if (existing >= 0) {
        const next = [...prev];
        next[existing] = { name, volumeCm3 };
        return next;
      }
      return [...prev, { name, volumeCm3 }];
    });
  }, []);

  const resizeViewports = useCallback(() => {
    // Allow CSS layout to settle, then resize Cornerstone canvases + reset crosshairs
    setTimeout(() => {
      const engine = renderingEngineRef.current;
      if (engine) {
        engine.resize(true, false);
      }
      resetCrosshairsToCenter(RENDERING_ENGINE_ID);
    }, 150);
  }, []);

  const toggleRightPanel = useCallback((panel: RightPanel) => {
    setRightPanel((prev) => {
      const next = prev === panel ? null : panel;
      if (next === 'tavi') {
        // Open TAVI panel — preserve current crosshair position, zoom, pan, W/L
        setReportExpanded(false);

        // Save all camera states BEFORE mode switch (resize will change viewport dimensions)
        const engine = renderingEngineRef.current;
        const savedCameras: Record<string, any> = {};
        if (engine) {
          for (const vpId of MPR_VIEWPORT_IDS) {
            const vp = engine.getViewport(vpId);
            if (vp) savedCameras[vpId] = vp.getCamera();
          }
        }

        setViewportMode('tavi-crosshair');

        // After resize, restore saved cameras to preserve zoom/pan/position
        setTimeout(() => {
          if (engine) {
            engine.resize(true, false);
            for (const vpId of MPR_VIEWPORT_IDS) {
              const vp = engine.getViewport(vpId);
              if (vp && savedCameras[vpId]) {
                vp.setCamera(savedCameras[vpId]);
                vp.render();
              }
            }
          }
        }, 150);
      } else if (prev === 'tavi' && next !== 'tavi') {
        setViewportMode(next === 'hand-mr' ? 'hand-mr' : 'standard');
        setReportExpanded(false);
        exitDoubleObliqueMode(RENDERING_ENGINE_ID);
        resizeViewports();
      }
      if (next === 'hand-mr') {
        setViewportMode('hand-mr');
        setReportExpanded(false);
        setTimeout(() => {
          const engine = renderingEngineRef.current;
          if (engine) engine.resize(true, false);
        }, 150);
      } else if (prev === 'hand-mr' && next !== 'hand-mr' && next !== 'tavi') {
        setViewportMode('standard');
        resizeViewports();
      }
      return next;
    });
  }, [resizeViewports]);

  const handleTaviModeChange = useCallback((mode: ViewportMode) => {
    setViewportMode(mode);
    // Exit double-oblique when switching to any non-oblique mode
    if (mode === 'standard' || mode === 'tavi-crosshair') {
      exitDoubleObliqueMode(RENDERING_ENGINE_ID);
    }
    resizeViewports();
  }, [resizeViewports]);

  return (
    <div className="app">
      <header className="app-header">
        {onBack && (
          <button className="open-btn" onClick={onBack} title="Back to welcome">
            &larr; Back
          </button>
        )}
        <h1>{title ?? 'CT Imaging'}</h1>
        {activeSeries && (
          <div className="patient-info">
            <span>{activeSeries.patientName}</span>
            <span className="separator">|</span>
            <span>{activeSeries.studyDescription}</span>
            <span className="separator">|</span>
            <span>{activeSeries.seriesDescription}</span>
            <span className="separator">|</span>
            <span>{activeSeries.modality} - {activeSeries.numImages} images</span>
          </div>
        )}
        <div className="header-actions">
          <button className="open-btn" onClick={() => {
            const input = document.createElement('input');
            input.type = 'file'; input.multiple = true;
            input.onchange = (e) => { const t = e.target as HTMLInputElement; if (t.files?.length) handleFilesLoaded(Array.from(t.files)); };
            input.click();
          }} disabled={isLoading}>Open Files</button>
          <button className="open-btn" onClick={() => {
            const input = document.createElement('input');
            input.type = 'file'; input.webkitdirectory = true; input.multiple = true;
            input.onchange = (e) => { const t = e.target as HTMLInputElement; if (t.files?.length) handleFilesLoaded(Array.from(t.files)); };
            input.click();
          }} disabled={isLoading}>Open Folder</button>
          <button
            className="open-btn"
            onClick={() => {
              if (leftAtriumPanelRef.current) {
                leftAtriumPanelRef.current.saveSession();
              } else {
                setPendingLAAction('save');
                setRightPanel('la');
                if (viewportMode !== 'standard') setViewportMode('standard');
                resizeViewports();
              }
            }}
            disabled={isLoading || !activeSeries}
            title="Save LA segmentation as JSON (filename: patient_studyDate)"
          >Save LA</button>
          <button
            className="open-btn"
            onClick={() => laFileInputRef.current?.click()}
            disabled={isLoading || !activeSeries}
            title="Open a saved LA session JSON"
          >Open LA</button>
          <input
            ref={laFileInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              if (leftAtriumPanelRef.current) {
                void leftAtriumPanelRef.current.loadSessionFile(f);
              } else {
                setPendingLAAction({ load: f });
                setRightPanel('la');
                if (viewportMode !== 'standard') setViewportMode('standard');
                resizeViewports();
              }
              e.target.value = '';
            }}
          />
          <button
            className="open-btn"
            onClick={() => {
              if (aortaPanelRef.current) {
                aortaPanelRef.current.saveSession();
              } else {
                setPendingAortaAction('save');
                setRightPanel('aorta');
                if (viewportMode !== 'standard') setViewportMode('standard');
                resizeViewports();
              }
            }}
            disabled={isLoading || !activeSeries}
            title="Save aorta segmentation as JSON"
          >Save Ao</button>
          <button
            className="open-btn"
            onClick={() => aortaFileInputRef.current?.click()}
            disabled={isLoading || !activeSeries}
            title="Open a saved aorta session JSON"
          >Open Ao</button>
          <input
            ref={aortaFileInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              if (aortaPanelRef.current) {
                void aortaPanelRef.current.loadSessionFile(f);
              } else {
                setPendingAortaAction({ load: f });
                setRightPanel('aorta');
                if (viewportMode !== 'standard') setViewportMode('standard');
                resizeViewports();
              }
              e.target.value = '';
            }}
          />
          <button
            className="open-btn"
            onClick={() => {
              if (laaPanelRef.current) {
                laaPanelRef.current.saveSession();
              } else {
                setPendingLAAAction('save');
                setRightPanel('laa');
                if (viewportMode !== 'standard') setViewportMode('standard');
                resizeViewports();
              }
            }}
            disabled={isLoading || !activeSeries}
            title="Save LAA segmentation as JSON"
          >Save LAA</button>
          <button
            className="open-btn"
            onClick={() => laaFileInputRef.current?.click()}
            disabled={isLoading || !activeSeries}
            title="Open a saved LAA session JSON"
          >Open LAA</button>
          <input
            ref={laaFileInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              if (laaPanelRef.current) {
                void laaPanelRef.current.loadSessionFile(f);
              } else {
                setPendingLAAAction({ load: f });
                setRightPanel('laa');
                if (viewportMode !== 'standard') setViewportMode('standard');
                resizeViewports();
              }
              e.target.value = '';
            }}
          />
          <ThemeToggleBtn />
        </div>
      </header>

      {activeSeries && (
        <div className="toolbar-row">
          <Toolbar renderingEngineId={RENDERING_ENGINE_ID} isStack2D={viewportMode === 'stack-2d'}
            onSwitchToMPR={() => { if (activeSeries) loadSeries(activeSeries); }}
            onReset={() => {
            // Full baseline reset: exit TAVI mode, close panels, restore standard view
            taviPanelRef.current?.resetAll();
            exitDoubleObliqueMode(RENDERING_ENGINE_ID);
            setViewportMode('standard');
            setRightPanel(null);
            setReportExpanded(false);
            // Clear segmentation overlay
            try {
              const csTools = (window as any).cornerstoneTools;
              if (csTools?.segmentation) {
                const seg = csTools.segmentation;
                try { seg.removeSegmentationRepresentations('axial'); } catch {}
                try { seg.removeSegmentationRepresentations('sagittal'); } catch {}
                try { seg.removeSegmentationRepresentations('coronal'); } catch {}
                try { seg.removeSegmentation('huThresholdSegmentation'); } catch {}
              }
            } catch {}
            resizeViewports();
          }} />
          <div className="toolbar-divider" />
          <WindowLevelPresets renderingEngineId={RENDERING_ENGINE_ID} viewportIds={MPR_VIEWPORT_IDS} modality={activeSeries?.modality} />
          <div className="toolbar-divider" />
          {viewportMode === 'tavi-oblique' && (
            <>
              <ViewAnglePresets onAngleChange={(lao, cc) => taviPanelRef.current?.setViewingAngle(lao, cc)} />
              <div className="toolbar-divider" />
            </>
          )}
          <div style={{ flexBasis: '100%', height: 0 }} />
          <button className={`toolbar-btn ${viewportMode === 'volume-3d' ? 'active' : ''}`} onClick={() => {
            if (viewportMode === 'volume-3d') {
              // Toggle off — go back to standard
              setViewportMode('standard');
              setRightPanel(null);
              setReportExpanded(false);
              resizeViewports();
            } else {
              // Toggle on — fullscreen 3D mode
              setViewportMode('volume-3d');
              setRightPanel('3d');
              setReportExpanded(false);
              resizeViewports();
            }
          }}>3D</button>
          <button className={`toolbar-btn ${rightPanel === 'tavi' ? 'active' : ''}`} onClick={() => toggleRightPanel('tavi')}>TAVI</button>
          <button className={`toolbar-btn ${rightPanel === 'hand-mr' ? 'active' : ''}`} onClick={() => toggleRightPanel('hand-mr')}>Hand MR</button>
          <button className={`toolbar-btn ${rightPanel === 'la' ? 'active' : ''}`} onClick={() => {
            setRightPanel((prev) => {
              const next = prev === 'la' ? null : 'la';
              if (next === 'la' && viewportMode !== 'standard') {
                setViewportMode('standard');
                exitDoubleObliqueMode(RENDERING_ENGINE_ID);
              }
              resizeViewports();
              return next;
            });
          }}>LA 3D</button>
          <button className={`toolbar-btn ${rightPanel === 'aorta' ? 'active' : ''}`} onClick={() => {
            setRightPanel((prev) => {
              const next = prev === 'aorta' ? null : 'aorta';
              if (next === 'aorta' && viewportMode !== 'standard') {
                setViewportMode('standard');
                exitDoubleObliqueMode(RENDERING_ENGINE_ID);
              }
              resizeViewports();
              return next;
            });
          }}>Aorta 3D</button>
          <button className={`toolbar-btn ${rightPanel === 'laa' ? 'active' : ''}`} onClick={() => {
            setRightPanel((prev) => {
              const next = prev === 'laa' ? null : 'laa';
              if (next === 'laa' && viewportMode !== 'standard') {
                setViewportMode('standard');
                exitDoubleObliqueMode(RENDERING_ENGINE_ID);
              }
              resizeViewports();
              return next;
            });
          }}>LAA 3D</button>
          <button className={`toolbar-btn ${rightPanel === 'lv-adas' ? 'active' : ''}`} onClick={() => {
            setRightPanel((prev) => {
              const next = prev === 'lv-adas' ? null : 'lv-adas';
              if (next === 'lv-adas' && viewportMode !== 'standard') {
                setViewportMode('standard');
                exitDoubleObliqueMode(RENDERING_ENGINE_ID);
              }
              resizeViewports();
              return next;
            });
          }}>LV-ADAS</button>
        </div>
      )}

      {error && (
        <div className="error-banner">
          <span className="error-banner-icon">!</span>
          <span className="error-banner-text">{error}</span>
          <button className="error-banner-close" onClick={() => setError(null)}>×</button>
        </div>
      )}

      {!activeSeries ? (
        <DicomDropzone onFilesLoaded={handleFilesLoaded} isLoading={isLoading} />
      ) : (
        <div className={`main-content ${viewportMode === 'tavi-oblique' || viewportMode === 'tavi-crosshair' ? 'main-content--tavi-oblique' : ''} ${viewportMode === 'volume-3d' ? 'main-content--volume-3d' : ''}`}>
          {viewportMode !== 'volume-3d' && seriesList.length > 0 && (
            <SeriesPanel seriesList={seriesList} activeSeriesUID={activeSeries?.seriesInstanceUID || ''} onSelectSeries={loadSeries} onOpen2DViewer={open2DViewer} isLoading={isLoading} />
          )}

          <div style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <ViewportGrid hide3d={hide3dPanel && viewportMode === 'standard'} mode={viewportMode} />

            {/* 3D mode: overlay controls on bottom-left of viewport */}
            {viewportMode === 'volume-3d' && (
              <div className="vol3d-overlay-controls">
                <RenderModeSelector renderingEngineId={RENDERING_ENGINE_ID} volumeId={VOLUME_ID} />
              </div>
            )}

            {/* Orientation labels now handled by OrientationOverlay in ViewportGrid */}

            {/* HU value probe overlay on all viewports */}
            {activeSeries && <HUProbeOverlay renderingEngineId={RENDERING_ENGINE_ID} volumeId={VOLUME_ID} />}
            {activeSeries && (
              <DicomInfoOverlay
                renderingEngineId={RENDERING_ENGINE_ID}
                patientName={activeSeries.patientName}
                studyDescription={activeSeries.studyDescription}
                seriesDescription={activeSeries.seriesDescription}
                modality={activeSeries.modality}
              />
            )}
          </div>

          {viewportMode !== 'volume-3d' && (
            <>
              <MetadataPanel series={activeSeries} isVisible={showMetadata} onToggle={() => setShowMetadata(!showMetadata)} />

              <SegmentationPanel
                renderingEngineId={RENDERING_ENGINE_ID} volumeId={VOLUME_ID}
                isVisible={showSegmentation} onToggle={() => setShowSegmentation(!showSegmentation)}
                onVolumeCalculated={handleVolumeCalculated}
              />
            </>
          )}

          {rightPanel === 'tavi' && (
            <div className={`side-panel ${reportExpanded ? 'side-panel--report-expanded' : ''}`} style={{ width: reportExpanded ? undefined : '360px' }}>
              <div className="side-panel-tabs">
                <button className={`side-panel-tab ${!reportExpanded ? 'active' : ''}`} onClick={() => { setReportExpanded(false); taviPanelRef.current?.showCapture(); }}>TAVI</button>
                <button className={`side-panel-tab ${reportExpanded ? 'active' : ''}`} onClick={() => { setReportExpanded(true); taviPanelRef.current?.showReport(); }}>Report</button>
                <button className="side-panel-close" onClick={() => { setRightPanel(null); setReportExpanded(false); setViewportMode('standard'); exitDoubleObliqueMode(RENDERING_ENGINE_ID); resizeViewports(); }}>×</button>
              </div>

              <div className="side-panel-body" style={{ padding: 0 }}>
                <TAVIPanel
                  renderingEngineId={RENDERING_ENGINE_ID}
                  volumeId={VOLUME_ID}
                  viewportMode={viewportMode}
                  onViewportModeChange={handleTaviModeChange}
                  panelRef={taviPanelRef}
                  onReportToggle={setReportExpanded}
                />
              </div>
            </div>
          )}

          {rightPanel === 'hand-mr' && (
            <div className="side-panel" style={{ width: '360px' }}>
              <div className="side-panel-tabs">
                <button className="side-panel-tab active">Hand MR</button>
                <button className="side-panel-close" onClick={() => { setRightPanel(null); setViewportMode('standard'); resizeViewports(); }}>×</button>
              </div>
              <div className="side-panel-body" style={{ padding: 0 }}>
                <HandMRPanel
                  ref={handMRPanelRef}
                  renderingEngineId={RENDERING_ENGINE_ID}
                  volumeId={VOLUME_ID}
                  seriesList={seriesList}
                  onLoadSeries={loadSeries}
                />
              </div>
            </div>
          )}

          {rightPanel === 'la' && (
            <div className="side-panel" style={{ width: '360px' }}>
              <div className="side-panel-tabs">
                <button className="side-panel-tab active">Left Atrium 3D</button>
                <button className="side-panel-close" onClick={() => { setRightPanel(null); resizeViewports(); }}>×</button>
              </div>
              <div className="side-panel-body" style={{ padding: 0 }}>
                <LeftAtriumPanel
                  ref={leftAtriumPanelRef}
                  renderingEngineId={RENDERING_ENGINE_ID}
                  volumeId={VOLUME_ID}
                  patientName={activeSeries?.patientName}
                  studyDate={activeSeries?.studyDate}
                />
              </div>
            </div>
          )}

          {rightPanel === 'aorta' && (
            <div className="side-panel" style={{ width: '360px' }}>
              <div className="side-panel-tabs">
                <button className="side-panel-tab active">Aorta 3D</button>
                <button className="side-panel-close" onClick={() => { setRightPanel(null); resizeViewports(); }}>×</button>
              </div>
              <div className="side-panel-body" style={{ padding: 0 }}>
                <AortaPanel
                  ref={aortaPanelRef}
                  renderingEngineId={RENDERING_ENGINE_ID}
                  volumeId={VOLUME_ID}
                  patientName={activeSeries?.patientName}
                  studyDate={activeSeries?.studyDate}
                />
              </div>
            </div>
          )}

          {rightPanel === 'laa' && (
            <div className="side-panel" style={{ width: '360px' }}>
              <div className="side-panel-tabs">
                <button className="side-panel-tab active">LAA 3D</button>
                <button className="side-panel-close" onClick={() => { setRightPanel(null); resizeViewports(); }}>×</button>
              </div>
              <div className="side-panel-body" style={{ padding: 0 }}>
                <LAAPanel
                  ref={laaPanelRef}
                  renderingEngineId={RENDERING_ENGINE_ID}
                  volumeId={VOLUME_ID}
                  patientName={activeSeries?.patientName}
                  studyDate={activeSeries?.studyDate}
                />
              </div>
            </div>
          )}

          {rightPanel === 'lv-adas' && (
            <div className="side-panel" style={{ width: '360px' }}>
              <div className="side-panel-tabs">
                <button className="side-panel-tab active">LV-ADAS</button>
                <button className="side-panel-close" onClick={() => { setRightPanel(null); resizeViewports(); }}>×</button>
              </div>
              <div className="side-panel-body" style={{ padding: 0 }}>
                <LVADASPanel
                  ref={lvadasPanelRef}
                  renderingEngineId={RENDERING_ENGINE_ID}
                  volumeId={VOLUME_ID}
                  patientName={activeSeries?.patientName}
                  studyDate={activeSeries?.studyDate}
                />
              </div>
            </div>
          )}

          {volumeResults.length > 0 && <VolumeStats results={volumeResults} />}
        </div>
      )}

      {isLoading && (
        <div className="loading-overlay">
          <div className="loading-card">
            <div className="spinner" />
            <p className="loading-text">{loadingProgress || 'Loading DICOM data...'}</p>
            {loadingProgress && loadingProgress.includes('/') && (() => {
              const match = loadingProgress.match(/(\d+)\/(\d+)/);
              if (!match) return null;
              const [, loaded, total] = match;
              const pct = Math.round((Number(loaded) / Number(total)) * 100);
              return (
                <>
                  <div className="loading-progress-bar">
                    <div className="loading-progress-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <p className="loading-progress-text">{pct}%</p>
                </>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
