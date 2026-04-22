import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import { getToolNames } from './initCornerstone';
import { applyLinearInterpolation } from '../../../shared/core/cornerstone';

const MPR_TOOL_GROUP_ID = 'coronaryMprToolGroup';
const MPR_VIEWPORT_IDS = ['axial', 'sagittal', 'coronal'];

export type ToolName = 'Crosshairs' | 'WindowLevel' | 'Pan' | 'Zoom' | 'Length' | 'Probe';

let mprToolGroup: cornerstoneTools.Types.IToolGroup | undefined;
let voiSync: cornerstoneTools.Synchronizer | undefined;
let zoomPanSync: cornerstoneTools.Synchronizer | undefined;

export function setupToolGroups(renderingEngineId: string): void {
  if (mprToolGroup) return;

  const names = getToolNames();

  // === MPR Tool Group ===
  let group = cornerstoneTools.ToolGroupManager.createToolGroup(MPR_TOOL_GROUP_ID);
  if (!group) {
    cornerstoneTools.ToolGroupManager.destroyToolGroup(MPR_TOOL_GROUP_ID);
    group = cornerstoneTools.ToolGroupManager.createToolGroup(MPR_TOOL_GROUP_ID);
  }
  if (!group) throw new Error('Failed to create coronary MPR tool group');

  group.addTool(names.WindowLevel);
  group.addTool(names.Pan);
  group.addTool(names.Zoom);
  group.addTool(names.StackScroll);
  group.addTool(names.Length);
  group.addTool(names.Probe);
  group.addTool(names.Crosshairs, {
    getReferenceLineColor: (viewportId: string) => {
      const colors: Record<string, string> = {
        axial: 'rgb(255, 135, 91)',
        sagittal: 'rgb(97, 219, 251)',
        coronal: 'rgb(255, 209, 102)',
      };
      return colors[viewportId] || 'rgb(200, 200, 200)';
    },
    getReferenceLineControllable: () => true,
    // Rotation-by-dragging-line disabled to stop accidental large jumps when
    // user clicks near a reference line instead of the center handle.
    getReferenceLineDraggableRotatable: () => false,
    getReferenceLineSlabThicknessControlsOn: () => false,
    mobile: {
      enabled: false,
      opacity: 1,
      handleRadius: 6,
    },
  });

  // IMPORTANT: Add viewports BEFORE setting tools active.
  // CrosshairsTool.onSetToolActive() calls _computeToolCenter() which
  // requires >= 2 viewports to exist, otherwise it silently exits.
  for (const vpId of MPR_VIEWPORT_IDS) {
    group.addViewport(vpId, renderingEngineId);
  }

  // Crosshairs on primary click — activated FIRST so it sees all 3 viewports
  group.setToolActive(names.Crosshairs, {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
  });

  // Pan on middle-click + Shift+click
  group.setToolActive(names.Pan, {
    bindings: [
      { mouseButton: cornerstoneTools.Enums.MouseBindings.Auxiliary },
      { mouseButton: cornerstoneTools.Enums.MouseBindings.Primary, modifierKey: cornerstoneTools.Enums.KeyboardBindings.Shift },
    ],
  });

  // Zoom on right-click
  group.setToolActive(names.Zoom, {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }],
  });

  // Scroll on wheel
  group.setToolActive(names.StackScroll, {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel }],
  });

  mprToolGroup = group;

  // === Synchronizers ===
  zoomPanSync = cornerstoneTools.synchronizers.createZoomPanSynchronizer('coronaryZoomPanSync');
  voiSync = cornerstoneTools.synchronizers.createVOISynchronizer('coronaryVoiSync', {
    syncInvertState: false,
    syncColormap: false,
  });

  for (const vpId of MPR_VIEWPORT_IDS) {
    zoomPanSync.add({ renderingEngineId, viewportId: vpId });
    zoomPanSync.setOptions(vpId, { syncPan: false });
    voiSync.add({ renderingEngineId, viewportId: vpId });
  }
}

export function setActiveTool(name: ToolName): void {
  if (!mprToolGroup) return;

  const names = getToolNames();
  const selectedTool = names[name];
  if (!selectedTool) return;

  // Drawing tools (Probe) need Crosshairs fully disabled because Passive
  // crosshairs can intercept clicks near existing annotations.
  const isDrawingTool = name === 'Probe';
  const allPrimaryTools = [
    names.WindowLevel, names.Length, names.Crosshairs,
    names.Probe, names.Pan, names.Zoom,
  ];

  for (const t of allPrimaryTools) {
    if (t === names.Crosshairs && name !== 'Crosshairs') {
      if (isDrawingTool) {
        mprToolGroup.setToolDisabled(t);
      } else {
        mprToolGroup.setToolEnabled(t);
      }
    } else {
      mprToolGroup.setToolPassive(t);
    }
  }

  // Activate the selected tool on Primary click
  mprToolGroup.setToolActive(selectedTool, {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
  });

  // Re-activate Pan on middle-click + Shift+click
  if (name !== 'Pan') {
    mprToolGroup.setToolActive(names.Pan, {
      bindings: [
        { mouseButton: cornerstoneTools.Enums.MouseBindings.Auxiliary },
        { mouseButton: cornerstoneTools.Enums.MouseBindings.Primary, modifierKey: cornerstoneTools.Enums.KeyboardBindings.Shift },
      ],
    });
  }

  // Re-activate Zoom on right-click
  if (name !== 'Zoom') {
    mprToolGroup.setToolActive(names.Zoom, {
      bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }],
    });
  }

  // Scroll always on wheel
  mprToolGroup.setToolActive(names.StackScroll, {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel }],
  });
}

export function centerViewportsOnCrosshairs(renderingEngineId: string): void {
  if (!mprToolGroup) return;

  const engine = cornerstone.getRenderingEngine(renderingEngineId);
  if (!engine) return;

  const names = getToolNames();
  let center: cornerstone.Types.Point3 | null = null;

  const csTool = mprToolGroup.getToolInstance(names.Crosshairs) as any;
  if (csTool?.toolCenter) {
    center = csTool.toolCenter as cornerstone.Types.Point3;
  }

  // Fallback: read from annotation
  if (!center) {
    for (const vpId of MPR_VIEWPORT_IDS) {
      const vp = engine.getViewport(vpId);
      if (!vp?.element) continue;
      const anns = cornerstoneTools.annotation.state.getAnnotations(names.Crosshairs, vp.element);
      if (anns?.length > 0) {
        const tc = anns[0].data?.handles?.toolCenter;
        if (tc) { center = tc as cornerstone.Types.Point3; break; }
      }
    }
  }

  if (!center) return;

  for (const vpId of MPR_VIEWPORT_IDS) {
    const vp = engine.getViewport(vpId);
    if (!vp) continue;
    const cam = vp.getCamera();
    if (!cam.viewPlaneNormal || !cam.focalPoint) continue;

    const vpn = cam.viewPlaneNormal;
    const dist = cam.position && cam.focalPoint
      ? Math.hypot(
          cam.position[0] - cam.focalPoint[0],
          cam.position[1] - cam.focalPoint[1],
          cam.position[2] - cam.focalPoint[2]
        )
      : 1000;

    vp.setCamera({
      focalPoint: center,
      position: [
        center[0] + vpn[0] * dist,
        center[1] + vpn[1] * dist,
        center[2] + vpn[2] * dist,
      ] as cornerstone.Types.Point3,
    });
    vp.render();
  }
}

export function resetCrosshairsToCenter(renderingEngineId: string, volumeId: string): void {
  if (!mprToolGroup) return;

  const engine = cornerstone.getRenderingEngine(renderingEngineId);
  if (!engine) return;

  const names = getToolNames();
  const crosshairsTool = mprToolGroup.getToolInstance(names.Crosshairs) as any;
  if (!crosshairsTool) return;

  // Compute volume center from image data bounds
  let volumeCenter: number[] | null = null;
  const volume = cornerstone.cache.getVolume(volumeId);
  const bounds = (volume as any)?.imageData?.getBounds?.();
  if (bounds && bounds.length === 6) {
    volumeCenter = [
      (bounds[0] + bounds[1]) / 2,
      (bounds[2] + bounds[3]) / 2,
      (bounds[4] + bounds[5]) / 2,
    ];
  }

  // Fallback: average all viewport focal points
  if (!volumeCenter) {
    const focalPoints = MPR_VIEWPORT_IDS
      .map((vpId) => engine.getViewport(vpId)?.getCamera()?.focalPoint)
      .filter(Boolean) as cornerstone.Types.Point3[];
    if (focalPoints.length > 0) {
      volumeCenter = [
        focalPoints.reduce((s, p) => s + p[0], 0) / focalPoints.length,
        focalPoints.reduce((s, p) => s + p[1], 0) / focalPoints.length,
        focalPoints.reduce((s, p) => s + p[2], 0) / focalPoints.length,
      ];
    }
  }

  if (!volumeCenter) return;

  // Set each viewport's camera focal point to the volume center
  for (const vpId of MPR_VIEWPORT_IDS) {
    const vp = engine.getViewport(vpId);
    if (!vp) continue;
    const cam = vp.getCamera();
    const vpn = cam.viewPlaneNormal || [0, 0, 1];
    const dist = cam.position && cam.focalPoint
      ? Math.hypot(
          cam.position[0] - cam.focalPoint[0],
          cam.position[1] - cam.focalPoint[1],
          cam.position[2] - cam.focalPoint[2]
        )
      : 1000;
    vp.setCamera({
      focalPoint: volumeCenter as cornerstone.Types.Point3,
      position: [
        volumeCenter[0] + vpn[0] * dist,
        volumeCenter[1] + vpn[1] * dist,
        volumeCenter[2] + vpn[2] * dist,
      ] as cornerstone.Types.Point3,
    });
  }

  // Initialize crosshairs annotation for each viewport
  for (const vpId of MPR_VIEWPORT_IDS) {
    try {
      crosshairsTool.initializeViewport({ renderingEngineId, viewportId: vpId });
    } catch {
      // ignore if already initialized
    }
  }

  // Set the shared tool center so all crosshairs converge at the same point
  crosshairsTool.toolCenter = [...volumeCenter];

  // Also update toolCenter on each viewport's crosshair annotation
  for (const vpId of MPR_VIEWPORT_IDS) {
    const vp = engine.getViewport(vpId);
    if (!vp?.element) continue;
    const anns = cornerstoneTools.annotation.state.getAnnotations(names.Crosshairs, vp.element);
    if (anns) {
      for (const ann of anns) {
        if (ann.data?.handles) {
          ann.data.handles.toolCenter = [...volumeCenter] as cornerstone.Types.Point3;
        }
      }
    }
  }

  // Recompute reference lines from the updated center
  if (typeof crosshairsTool.computeToolCenter === 'function') {
    crosshairsTool.computeToolCenter();
  }

  engine.renderViewports(MPR_VIEWPORT_IDS);
}

/**
 * Attaches advanced clinical interaction listeners.
 * Ctrl + Middle + Wheel -> Dynamic Slab Thickness
 */
export function attachAdvancedInteractions(renderingEngineId: string): () => void {
  const engine = cornerstone.getRenderingEngine(renderingEngineId);
  if (!engine) return () => {};

  const handleWheel = (evt: WheelEvent) => {
    if (!evt.ctrlKey || !(evt.buttons & 4)) return;
    evt.preventDefault();
    evt.stopPropagation();

    const targetElement = evt.currentTarget as HTMLElement;
    const viewportId = targetElement.getAttribute('data-viewport-id');
    if (!viewportId) return;

    const viewport = engine.getViewport(viewportId) as cornerstone.Types.IVolumeViewport;
    if (!viewport) return;

    const delta = evt.deltaY > 0 ? 1 : -1;
    const currentSlab = (viewport as any).getSlabThickness?.() || 0;
    const nextSlab = Math.max(0, currentSlab + delta * 2);
    viewport.setSlabThickness(nextSlab);
    applyLinearInterpolation(viewport);
    viewport.render();
  };

  const viewports = MPR_VIEWPORT_IDS.map(id => document.getElementById(`viewport-${id}`));
  viewports.forEach(v => {
    if (v) v.addEventListener('wheel', handleWheel, { passive: false });
  });

  return () => {
    viewports.forEach(v => {
      if (v) v.removeEventListener('wheel', handleWheel);
    });
  };
}

export function destroyToolGroups(): void {
  if (zoomPanSync) {
    cornerstoneTools.SynchronizerManager.destroySynchronizer(zoomPanSync.id);
    zoomPanSync = undefined;
  }
  if (voiSync) {
    cornerstoneTools.SynchronizerManager.destroySynchronizer(voiSync.id);
    voiSync = undefined;
  }
  if (mprToolGroup) {
    cornerstoneTools.ToolGroupManager.destroyToolGroup(MPR_TOOL_GROUP_ID);
    mprToolGroup = undefined;
  }
}
