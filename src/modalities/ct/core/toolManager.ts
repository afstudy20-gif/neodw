import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
(window as any).cornerstoneTools = cornerstoneTools;
import { getToolNames } from './initCornerstone';

const MPR_TOOL_GROUP_ID = 'mprToolGroup';
const VOL3D_TOOL_GROUP_ID = 'vol3dToolGroup';

export type ToolName = 'WindowLevel' | 'Pan' | 'Zoom' | 'Length' | 'Angle' | 'CobbAngle' | 'ArrowAnnotate' | 'Bidirectional' | 'Crosshairs' | 'TrackballRotate' | 'StackScroll' | 'PlanarFreehandROI' | 'Probe';

let mprToolGroup: cornerstoneTools.Types.IToolGroup | undefined;
let vol3dToolGroup: cornerstoneTools.Types.IToolGroup | undefined;
let voiSync: cornerstoneTools.Synchronizer | undefined;
let zoomPanSync: cornerstoneTools.Synchronizer | undefined;
let isDoubleObliqueActive = false;
let doubleObliqueCenterHandler: (() => boolean) | null = null;

const MPR_VIEWPORT_IDS = ['axial', 'sagittal', 'coronal'];

export function setDoubleObliqueCenterHandler(handler: (() => boolean) | null): void {
  doubleObliqueCenterHandler = handler;
}

function stabilizeCrosshairRotation(crosshairsTool: any): void {
  if (!crosshairsTool || crosshairsTool.__neoDwRotationStabilized) return;

  const originalDrag = crosshairsTool._dragCallback?.bind(crosshairsTool);
  const originalEnd = crosshairsTool._endCallback?.bind(crosshairsTool);

  if (!originalDrag) return;

  // Cornerstone's default Crosshairs ROTATE operation rotates the linked MPR
  // triad. Keep that behavior, but avoid forcibly changing focalPoint during
  // rotation: that turns every drag tick into an implicit "center" command and
  // makes zoomed/panned images jump around inside their panels.
  const renderLinkedMprViewports = (evt: any) => {
    const enabledElement = cornerstone.getEnabledElement(evt?.detail?.element);
    const renderingEngine = enabledElement?.renderingEngine;
    if (!renderingEngine) return;

    try {
      crosshairsTool._recomputeToolCenterFromAbsoluteCameras?.({
        emitEvent: true,
        updateViewportCameras: false,
      });
    } catch {
      // Best-effort sync; rendering below still refreshes visible lines.
    }
    renderingEngine.renderViewports(MPR_VIEWPORT_IDS);
  };

  crosshairsTool._dragCallback = (evt: any) => {
    const isRotation = crosshairsTool.editData?.annotation?.data?.handles?.activeOperation === 2;
    try {
      return originalDrag(evt);
    } finally {
      if (isRotation) renderLinkedMprViewports(evt);
    }
  };

  if (originalEnd) {
    crosshairsTool._endCallback = (evt: any) => {
      const isRotation = crosshairsTool.editData?.annotation?.data?.handles?.activeOperation === 2;
      try {
        return originalEnd(evt);
      } finally {
        if (isRotation) renderLinkedMprViewports(evt);
      }
    };
  }

  crosshairsTool.__neoDwRotationStabilized = true;
}

export function setupToolGroups(renderingEngineId: string): void {
  if (mprToolGroup) return;

  const names = getToolNames();

  // === MPR Tool Group ===
  const mprGroup = cornerstoneTools.ToolGroupManager.createToolGroup(MPR_TOOL_GROUP_ID);
  if (!mprGroup) throw new Error('Failed to create MPR tool group');

  mprGroup.addTool(names.WindowLevel);
  mprGroup.addTool(names.Pan);
  // zoomToCenter keeps the focal point fixed while zooming. Default
  // anchor-zoom shifts the focal point toward the cursor, which on a
  // CrosshairsTool + ZoomPanSynchronizer setup desyncs the linked viewports:
  // only parallelScale is propagated, so A's focal point drifts while B/C stay
  // put and the crosshair lines no longer intersect at the same world point.
  mprGroup.addTool(names.Zoom, { configuration: { zoomToCenter: true } });
  mprGroup.addTool(names.StackScroll);
  mprGroup.addTool(names.Length);
  mprGroup.addTool(names.Angle);
  mprGroup.addTool(names.CobbAngle);
  mprGroup.addTool(names.ArrowAnnotate);
  mprGroup.addTool(names.Bidirectional);
  mprGroup.addTool(names.PlanarFreehandROI);
  mprGroup.addTool(names.Probe);
  mprGroup.addTool(names.Crosshairs, {
    getReferenceLineColor: (viewportId: string) => {
      const colors: Record<string, string> = {
        axial: 'rgb(200, 100, 100)',
        sagittal: 'rgb(100, 200, 100)',
        coronal: 'rgb(100, 100, 200)',
      };
      return colors[viewportId] || 'rgb(200, 200, 200)';
    },
    getReferenceLineControllable: () => true,
    getReferenceLineDraggableRotatable: () => true,
    getReferenceLineSlabThicknessControlsOn: () => false,
  });
  stabilizeCrosshairRotation(mprGroup.getToolInstance(names.Crosshairs) as any);

  // IMPORTANT: Add viewports BEFORE setting tools active.
  // CrosshairsTool.onSetToolActive() calls _computeToolCenter(this._getViewportsInfo())
  // which requires ≥2 viewports to exist, otherwise it silently exits.
  for (const vpId of MPR_VIEWPORT_IDS) {
    mprGroup.addViewport(vpId, renderingEngineId);
  }

  // Now activate tools — crosshairs will see all 3 viewports and create annotations for each
  mprGroup.setToolActive(names.Crosshairs, {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
  });
  mprGroup.setToolActive(names.Pan, {
    bindings: [
      { mouseButton: cornerstoneTools.Enums.MouseBindings.Auxiliary },
      { mouseButton: cornerstoneTools.Enums.MouseBindings.Primary, modifierKey: cornerstoneTools.Enums.KeyboardBindings.Shift },
    ],
  });
  mprGroup.setToolActive(names.Zoom, {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }],
  });
  mprGroup.setToolActive(names.StackScroll, {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel }],
  });

  mprToolGroup = mprGroup;

  // === 3D Volume Tool Group ===
  const vol3dGroup = cornerstoneTools.ToolGroupManager.createToolGroup(VOL3D_TOOL_GROUP_ID);
  if (!vol3dGroup) throw new Error('Failed to create 3D tool group');

  vol3dGroup.addTool(names.TrackballRotate);
  vol3dGroup.addTool(names.Pan);
  vol3dGroup.addTool(names.Zoom);

  vol3dGroup.addViewport('volume3d', renderingEngineId);

  vol3dGroup.setToolActive(names.TrackballRotate, {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
  });
  vol3dGroup.setToolActive(names.Pan, {
    bindings: [
      { mouseButton: cornerstoneTools.Enums.MouseBindings.Auxiliary },
      { mouseButton: cornerstoneTools.Enums.MouseBindings.Primary, modifierKey: cornerstoneTools.Enums.KeyboardBindings.Shift },
    ],
  });
  vol3dGroup.setToolActive(names.Zoom, {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }],
  });
  vol3dToolGroup = vol3dGroup;

  // === Synchronizers ===
  // Zoom + pan sync across MPR viewports
  zoomPanSync = cornerstoneTools.synchronizers.createZoomPanSynchronizer('zoomPanSync');
  for (const vpId of MPR_VIEWPORT_IDS) {
    zoomPanSync.add({ renderingEngineId, viewportId: vpId });
    zoomPanSync.setOptions(vpId, { syncPan: false });
  }

  // VOI (window/level) sync across MPR viewports
  voiSync = cornerstoneTools.synchronizers.createVOISynchronizer('voiSync', {
    syncInvertState: false,
    syncColormap: false,
  });
  for (const vpId of MPR_VIEWPORT_IDS) {
    voiSync.add({ renderingEngineId, viewportId: vpId });
  }
}

export function setActiveTool(name: ToolName): void {
  if (!mprToolGroup) return;

  const names = getToolNames();
  const toolName = names[name];
  if (!toolName) return;

  // In double-oblique mode, only allow Pan and Zoom — all other tools
  // would conflict with the DoubleObliqueController's direct camera control.
  if (isDoubleObliqueActive) {
    if (name === 'Pan') {
      mprToolGroup.setToolActive(names.Pan, {
        bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
      });
    } else if (name === 'Zoom') {
      mprToolGroup.setToolActive(names.Zoom, {
        bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
      });
    } else if (name === 'WindowLevel') {
      mprToolGroup.setToolActive(names.WindowLevel, {
        bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
      });
    }
    // Never re-enable Crosshairs or StackScroll in double-oblique mode
    return;
  }

  // Deactivate ALL tools before re-assigning primary binding.
  // Most drawing tools need Crosshairs fully disabled because passive
  // crosshairs can intercept clicks near existing annotations. Probe is the
  // exception: TAVI point picking still needs the crosshair visible as an
  // orientation reference, so keep it enabled (render-only).
  const hidesCrosshairs = name === 'PlanarFreehandROI' || name === 'Angle' || name === 'CobbAngle' || name === 'ArrowAnnotate' || name === 'Bidirectional';
  const allPrimaryTools = [
    names.WindowLevel, names.Length, names.Angle, names.CobbAngle,
    names.ArrowAnnotate, names.Bidirectional, names.Crosshairs,
    names.PlanarFreehandROI, names.Probe, names.Pan, names.Zoom,
  ];
  for (const t of allPrimaryTools) {
    if (t === names.Crosshairs && name !== 'Crosshairs') {
      // For drawing tools: disable crosshairs entirely so they can't intercept.
      // For navigation tools: keep crosshairs enabled (visible but non-interactive).
      if (hidesCrosshairs) {
        mprToolGroup.setToolDisabled(t);
      } else {
        mprToolGroup.setToolEnabled(t);
      }
    } else {
      mprToolGroup.setToolPassive(t);
    }
  }

  // Activate the selected tool on Primary click
  mprToolGroup.setToolActive(toolName, {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
  });

  // Re-activate Pan on middle-click and Shift+click (not Primary)
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

  // Also update stackToolGroup if it exists (2D viewer mode)
  try {
    const stackGroup = cornerstoneTools.ToolGroupManager.getToolGroup('stackToolGroup');
    if (stackGroup) {
      // Supported tools in stack group
      const stackTools = [names.WindowLevel, names.Pan, names.Zoom, names.Length, names.Angle, names.ArrowAnnotate];
      for (const t of stackTools) {
        try { stackGroup.setToolPassive(t); } catch {}
      }
      if (stackTools.includes(toolName)) {
        stackGroup.setToolActive(toolName, {
          bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
        });
      }
      // Keep Pan/Zoom/Scroll on secondary buttons
      if (name !== 'Pan') {
        try { stackGroup.setToolActive(names.Pan, { bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Auxiliary }] }); } catch {}
      }
      if (name !== 'Zoom') {
        try { stackGroup.setToolActive(names.Zoom, { bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }] }); } catch {}
      }
      try { stackGroup.setToolActive(names.StackScroll, { bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel }] }); } catch {}
    }
  } catch {}
}

export function addViewportToToolGroup(_viewportId: string, _renderingEngineId: string): void {
  // Tool groups are now set up via setupToolGroups()
}

// Reset crosshairs to volume center and sync all viewports
export function resetCrosshairsToCenter(renderingEngineId: string): void {
  if (!mprToolGroup) return;
  if (isDoubleObliqueActive) return;

  const engine = cornerstone.getRenderingEngine(renderingEngineId);
  if (!engine) return;

  const names = getToolNames();

  const crosshairsTool = mprToolGroup.getToolInstance(names.Crosshairs) as any;
  if (!crosshairsTool) {
    console.warn('[Crosshairs] Tool instance not found');
    return;
  }

  // Compute the true volume center from the volume's image data bounds.
  // Each viewport's focalPoint can differ — use the volume itself.
  let volumeCenter: number[] | null = null;
  const volume = cornerstone.cache.getVolume('cornerstoneStreamingImageVolume:myVolume');
  if (volume) {
    const bounds = (volume as any).imageData?.getBounds?.();
    if (bounds && bounds.length === 6) {
      volumeCenter = [
        (bounds[0] + bounds[1]) / 2,
        (bounds[2] + bounds[3]) / 2,
        (bounds[4] + bounds[5]) / 2,
      ];
    }
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
    // Move camera so focal point is at volume center, preserving viewPlaneNormal and distance
    const distance = cam.position && cam.focalPoint
      ? Math.sqrt(
          (cam.position[0] - cam.focalPoint[0]) ** 2 +
          (cam.position[1] - cam.focalPoint[1]) ** 2 +
          (cam.position[2] - cam.focalPoint[2]) ** 2
        )
      : 1000;
    const vpn = cam.viewPlaneNormal || [0, 0, 1];
    vp.setCamera({
      focalPoint: volumeCenter as cornerstone.Types.Point3,
      position: [
        volumeCenter[0] + vpn[0] * distance,
        volumeCenter[1] + vpn[1] * distance,
        volumeCenter[2] + vpn[2] * distance,
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
  for (const vpId of MPR_VIEWPORT_IDS) {
    const vp = engine.getViewport(vpId);
    if (!vp?.element) continue;
    const annotations = cornerstoneTools.annotation.state.getAnnotations(names.Crosshairs, vp.element);
    if (annotations) {
      for (const ann of annotations) {
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

/** Enter double-oblique mode for TAVI planning: disable crosshairs and stack scroll */
export function enterDoubleObliqueMode(renderingEngineId?: string): void {
  if (!mprToolGroup) return;
  isDoubleObliqueActive = true;
  const names = getToolNames();

  // CRITICAL: Disable crosshairs entirely — even Passive crosshairs listen to
  // CAMERA_MODIFIED events and reset viewport orientations via their internal
  // synchronization logic. This conflicts with the DoubleObliqueController
  // which directly sets camera parameters.
  mprToolGroup.setToolDisabled(names.Crosshairs);
  // Disable stack scroll — the controller handles wheel events
  mprToolGroup.setToolDisabled(names.StackScroll);
  // Disable window/level on primary — we don't want accidental WL changes
  mprToolGroup.setToolPassive(names.WindowLevel);
  // Disable drawing tools
  mprToolGroup.setToolPassive(names.PlanarFreehandROI);
  mprToolGroup.setToolPassive(names.Probe);
  mprToolGroup.setToolPassive(names.Length);

  // Remove viewports from synchronizers to prevent them from interfering
  // with the DoubleObliqueController's direct camera manipulation.
  if (zoomPanSync && renderingEngineId) {
    for (const vpId of MPR_VIEWPORT_IDS) {
      zoomPanSync.remove({ renderingEngineId, viewportId: vpId });
    }
  }

  // Keep Pan on middle-click and Zoom on right-click
  mprToolGroup.setToolActive(names.Pan, {
    bindings: [
      { mouseButton: cornerstoneTools.Enums.MouseBindings.Auxiliary },
      { mouseButton: cornerstoneTools.Enums.MouseBindings.Primary, modifierKey: cornerstoneTools.Enums.KeyboardBindings.Shift },
    ],
  });
  mprToolGroup.setToolActive(names.Zoom, {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }],
  });
}

/** Exit double-oblique mode: restore standard crosshair-based tool configuration */
export function exitDoubleObliqueMode(renderingEngineId: string): void {
  if (!mprToolGroup) return;
  isDoubleObliqueActive = false;
  const names = getToolNames();

  // Re-add viewports to synchronizers
  if (zoomPanSync) {
    for (const vpId of MPR_VIEWPORT_IDS) {
      zoomPanSync.add({ renderingEngineId, viewportId: vpId });
      zoomPanSync.setOptions(vpId, { syncPan: false });
    }
  }

  // Re-enable crosshairs as primary tool
  mprToolGroup.setToolActive(names.Crosshairs, {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
  });
  mprToolGroup.setToolActive(names.Pan, {
    bindings: [
      { mouseButton: cornerstoneTools.Enums.MouseBindings.Auxiliary },
      { mouseButton: cornerstoneTools.Enums.MouseBindings.Primary, modifierKey: cornerstoneTools.Enums.KeyboardBindings.Shift },
    ],
  });
  mprToolGroup.setToolActive(names.Zoom, {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }],
  });
  mprToolGroup.setToolActive(names.StackScroll, {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel }],
  });

  // Reset crosshairs to center
  resetCrosshairsToCenter(renderingEngineId);
}

/** Enable probe tool for point picking (used during cusp/coronary clicking in TAVI mode). */
export function enableProbeTool(): void {
  if (!mprToolGroup) return;
  const names = getToolNames();

  // Deactivate all tools from primary binding while keeping crosshairs visible
  // as a render-only reference in standard/TAVI crosshair mode.
  const allPrimaryTools = [
    names.WindowLevel, names.Length, names.Crosshairs,
    names.PlanarFreehandROI, names.Pan, names.Zoom,
  ];
  for (const t of allPrimaryTools) {
    if (t === names.Crosshairs) {
      if (!isDoubleObliqueActive) {
        mprToolGroup.setToolEnabled(t);
      }
    } else {
      mprToolGroup.setToolPassive(t);
    }
  }

  // Activate Probe on primary click
  mprToolGroup.setToolActive(names.Probe, {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
  });

  // Keep Pan on middle-click and Zoom on right-click
  mprToolGroup.setToolActive(names.Pan, {
    bindings: [
      { mouseButton: cornerstoneTools.Enums.MouseBindings.Auxiliary },
      { mouseButton: cornerstoneTools.Enums.MouseBindings.Primary, modifierKey: cornerstoneTools.Enums.KeyboardBindings.Shift },
    ],
  });
  mprToolGroup.setToolActive(names.Zoom, {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }],
  });
}

/** Disable probe tool back to passive and re-enable Crosshairs */
export function disableProbeTool(): void {
  if (!mprToolGroup) return;
  const names = getToolNames();
  mprToolGroup.setToolPassive(names.Probe);
  // Re-enable crosshairs if not in double-oblique mode
  if (!isDoubleObliqueActive) {
    mprToolGroup.setToolActive(names.Crosshairs, {
      bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
    });
  }
}

/**
 * Center every MPR viewport on the crosshair and divide parallelScale by
 * `zoomFactor`. Same crosshair-locate logic as `centerViewportsOnCrosshairs`,
 * just with an extra zoom step so a single button click can punch into the
 * structure under the cursor (e.g. the aortic root) without manual zooming.
 */
export function zoomMPRToCrosshair(renderingEngineId: string, zoomFactor: number): void {
  if (!mprToolGroup) return;
  const engine = cornerstone.getRenderingEngine(renderingEngineId);
  if (!engine) return;

  if (isDoubleObliqueActive) {
    for (const vpId of MPR_VIEWPORT_IDS) {
      const vp = engine.getViewport(vpId);
      if (!vp) continue;
      const cam = vp.getCamera();
      if (typeof cam.parallelScale !== 'number') continue;
      vp.setCamera({ ...cam, parallelScale: cam.parallelScale / zoomFactor });
      vp.render();
    }
    return;
  }

  const names = getToolNames();
  let center: cornerstone.Types.Point3 | null = null;
  const csTool = mprToolGroup.getToolInstance(names.Crosshairs) as any;
  if (csTool?.toolCenter) center = csTool.toolCenter as cornerstone.Types.Point3;
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

  // Snapshot every viewport's CURRENT camera state BEFORE we mutate any of
  // them. ZoomPanSynchronizer auto-propagates parallelScale across the MPR
  // group, so reading cam.parallelScale from viewport B AFTER viewport A's
  // setCamera fires returns the already-divided value — the original loop
  // ended up dividing /6 once per viewport (≈216× total instead of 6×).
  const snapshots: Array<{
    vp: cornerstone.Types.IViewport;
    vpn: cornerstone.Types.Point3;
    dist: number;
    targetScale: number | undefined;
  }> = [];
  for (const vpId of MPR_VIEWPORT_IDS) {
    const vp = engine.getViewport(vpId);
    if (!vp) continue;
    const cam = vp.getCamera();
    if (!cam.viewPlaneNormal || !cam.focalPoint) continue;
    const dist = cam.position && cam.focalPoint
      ? Math.sqrt(
          (cam.position[0] - cam.focalPoint[0]) ** 2 +
          (cam.position[1] - cam.focalPoint[1]) ** 2 +
          (cam.position[2] - cam.focalPoint[2]) ** 2
        )
      : 1000;
    snapshots.push({
      vp,
      vpn: cam.viewPlaneNormal as cornerstone.Types.Point3,
      dist,
      targetScale: typeof cam.parallelScale === 'number'
        ? cam.parallelScale / zoomFactor
        : undefined,
    });
  }

  for (const { vp, vpn, dist, targetScale } of snapshots) {
    vp.setCamera({
      focalPoint: center,
      position: [
        center[0] + vpn[0] * dist,
        center[1] + vpn[1] * dist,
        center[2] + vpn[2] * dist,
      ] as cornerstone.Types.Point3,
      ...(targetScale !== undefined ? { parallelScale: targetScale } : {}),
    });
    vp.render();
  }
}

/** Center all MPR viewports on the current crosshair intersection point */
export function centerViewportsOnCrosshairs(renderingEngineId: string): void {
  if (!mprToolGroup) return;
  if (isDoubleObliqueActive) {
    try {
      if (doubleObliqueCenterHandler?.()) return;
    } catch (error) {
      console.warn('[DoubleOblique] Center handler failed', error);
    }
    return;
  }

  const engine = cornerstone.getRenderingEngine(renderingEngineId);
  if (!engine) return;

  const names = getToolNames();

  // Get the crosshair tool center
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

  // Set each viewport's focal point to the crosshair center,
  // keeping the current viewPlaneNormal and zoom level
  for (const vpId of MPR_VIEWPORT_IDS) {
    const vp = engine.getViewport(vpId);
    if (!vp) continue;
    const cam = vp.getCamera();
    if (!cam.viewPlaneNormal || !cam.focalPoint) continue;

    const vpn = cam.viewPlaneNormal;
    const dist = cam.position && cam.focalPoint
      ? Math.sqrt(
          (cam.position[0] - cam.focalPoint[0]) ** 2 +
          (cam.position[1] - cam.focalPoint[1]) ** 2 +
          (cam.position[2] - cam.focalPoint[2]) ** 2
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

export function destroyToolGroups(): void {
  isDoubleObliqueActive = false;
  doubleObliqueCenterHandler = null;
  // Must use SynchronizerManager.destroySynchronizer to remove from registry,
  // not just synchronizer.destroy() which only cleans up listeners
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
  if (vol3dToolGroup) {
    cornerstoneTools.ToolGroupManager.destroyToolGroup(VOL3D_TOOL_GROUP_ID);
    vol3dToolGroup = undefined;
  }
}
