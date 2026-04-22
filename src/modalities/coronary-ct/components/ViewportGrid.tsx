import { useEffect, useMemo, useRef, useState } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import { applyLinearInterpolation } from '../../../shared/core/cornerstone';
import {
  normalize as normalizeVec3,
  cross as crossVec3,
  rotateAroundAxis as rotateAroundAxisVec3,
  type Vec3,
} from '../coronary/QCAGeometry';
import { OrientationOverlay } from './OrientationOverlay';

type OrthoViewportName = 'axial' | 'sagittal' | 'coronal';
type ViewportName = OrthoViewportName;
type ViewMode = 'mpr' | 'mip' | 'axial-slices';

interface ViewportPresentation {
  mode: ViewMode;
  mipThicknessMm: number;
  pivotEnabled: boolean;
}

interface PivotDragState {
  viewportKey: OrthoViewportName;
  pivot: cornerstone.Types.Point3;
  viewPlaneNormal: cornerstone.Types.Point3;
  viewUp: cornerstone.Types.Point3;
  distance: number;
  startClientX: number;
  startClientY: number;
}

const ORTHO_VIEWPORTS: {
  id: string;
  key: OrthoViewportName;
  label: string;
  orientation: cornerstone.Enums.OrientationAxis;
}[] = [
  { id: 'viewport-axial', key: 'axial', label: 'Axial', orientation: cornerstone.Enums.OrientationAxis.AXIAL },
  {
    id: 'viewport-sagittal',
    key: 'sagittal',
    label: 'Sagittal',
    orientation: cornerstone.Enums.OrientationAxis.SAGITTAL,
  },
  {
    id: 'viewport-coronal',
    key: 'coronal',
    label: 'Coronal',
    orientation: cornerstone.Enums.OrientationAxis.CORONAL,
  },
];

const DEFAULT_PRESENTATIONS: Record<OrthoViewportName, ViewportPresentation> = {
  axial: { mode: 'mpr', mipThicknessMm: 14, pivotEnabled: false },
  sagittal: { mode: 'mpr', mipThicknessMm: 16, pivotEnabled: false },
  coronal: { mode: 'mpr', mipThicknessMm: 16, pivotEnabled: false },
};

interface Props {
  renderingEngineId: string;
  setupToken: number;
}

function clonePresentations() {
  return {
    axial: { ...DEFAULT_PRESENTATIONS.axial },
    sagittal: { ...DEFAULT_PRESENTATIONS.sagittal },
    coronal: { ...DEFAULT_PRESENTATIONS.coronal },
  } satisfies Record<OrthoViewportName, ViewportPresentation>;
}

function normalize(vector: cornerstone.Types.Point3): cornerstone.Types.Point3 {
  return normalizeVec3(vector as Vec3) as cornerstone.Types.Point3;
}

function cross(lhs: cornerstone.Types.Point3, rhs: cornerstone.Types.Point3): cornerstone.Types.Point3 {
  return crossVec3(lhs as Vec3, rhs as Vec3) as cornerstone.Types.Point3;
}

function rotateAroundAxis(
  vector: cornerstone.Types.Point3,
  axis: cornerstone.Types.Point3,
  angleRad: number
): cornerstone.Types.Point3 {
  return rotateAroundAxisVec3(vector as Vec3, axis as Vec3, angleRad) as cornerstone.Types.Point3;
}

function labelForMode(mode: ViewMode): string {
  if (mode === 'mpr') {
    return 'MPR View';
  }
  if (mode === 'mip') {
    return 'MIP View';
  }
  return 'Axial Slices View';
}

function isVolumeViewport(
  viewport: cornerstone.Types.IViewport | undefined
): viewport is cornerstone.Types.IVolumeViewport {
  return Boolean(viewport && 'setBlendMode' in viewport && 'setOrientation' in viewport);
}

export function ViewportGrid({ renderingEngineId, setupToken }: Props) {
  const [expanded, setExpanded] = useState<ViewportName | null>(null);
  const [layout, setLayout] = useState<'single' | 'mpr' | 'quad'>('single');
  const [syncMode, setSyncMode] = useState<boolean>(true);
  const [presentations, setPresentations] = useState<Record<OrthoViewportName, ViewportPresentation>>(
    clonePresentations
  );
  const [shiftPivotActive, setShiftPivotActive] = useState(false);
  const dragStateRef = useRef<PivotDragState | null>(null);
  const previousModesRef = useRef<Record<OrthoViewportName, ViewMode>>({
    axial: 'mpr',
    sagittal: 'mpr',
    coronal: 'mpr',
  });

  const viewportMap = useMemo(
    () =>
      ORTHO_VIEWPORTS.reduce((accumulator, entry) => {
        accumulator[entry.key] = entry;
        return accumulator;
      }, {} as Record<OrthoViewportName, (typeof ORTHO_VIEWPORTS)[number]>),
    []
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      const engine = cornerstone.getRenderingEngine(renderingEngineId);
      engine?.resize(true, false);
    }, 80);

    return () => clearTimeout(timer);
  }, [expanded, layout, renderingEngineId]);

  useEffect(() => {
    function handleLayoutChange(event: Event) {
      const detail = (event as CustomEvent).detail;
      if (detail === 'single' || detail === 'mpr' || detail === 'quad') setLayout(detail);
    }
    window.addEventListener('ccta:layout', handleLayoutChange);
    return () => window.removeEventListener('ccta:layout', handleLayoutChange);
  }, []);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('ccta:layout-state', { detail: layout }));
  }, [layout]);

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setExpanded(null);
      }
      if (event.key === 'Shift') {
        setShiftPivotActive(true);
      }
    }

    function handleKeyup(event: KeyboardEvent) {
      if (event.key === 'Shift') {
        setShiftPivotActive(false);
      }
    }

    function handleBlur() {
      setShiftPivotActive(false);
    }

    window.addEventListener('keydown', handleKeydown);
    window.addEventListener('keyup', handleKeyup);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeydown);
      window.removeEventListener('keyup', handleKeyup);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  useEffect(() => {
    function handleCursorMoved(event: Event) {
      const detail = (event as CustomEvent).detail;
      const point = detail.point;
      if (!point) return;

      const engine = cornerstone.getRenderingEngine(renderingEngineId);
      if (!engine) return;

      ORTHO_VIEWPORTS.forEach((vp) => {
        const viewport = engine.getViewport(vp.key);
        if (viewport && isVolumeViewport(viewport)) {
          const camera = viewport.getCamera();
          if (!camera.position || !camera.focalPoint || !camera.viewPlaneNormal) return;

          const distance = Math.hypot(
            camera.position[0] - camera.focalPoint[0],
            camera.position[1] - camera.focalPoint[1],
            camera.position[2] - camera.focalPoint[2]
          );

          viewport.setCamera({
            focalPoint: [point.x, point.y, point.z],
            position: [
              point.x + camera.viewPlaneNormal[0] * distance,
              point.y + camera.viewPlaneNormal[1] * distance,
              point.z + camera.viewPlaneNormal[2] * distance,
            ],
          });
          viewport.render();
        }
      });
    }

    window.addEventListener('coronary:cursor-moved', handleCursorMoved);
    return () => window.removeEventListener('coronary:cursor-moved', handleCursorMoved);
  }, [renderingEngineId]);

  useEffect(() => {
    function handleContextMenu(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.viewport-canvas, .viewport-element')) {
        event.preventDefault();
      }
    }

    document.addEventListener('contextmenu', handleContextMenu);
    return () => document.removeEventListener('contextmenu', handleContextMenu);
  }, []);

  useEffect(() => {
    function handleMiddleClick(event: MouseEvent) {
      if (event.button !== 1) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (target?.closest('.viewport-canvas, .viewport-element')) {
        event.preventDefault();
        event.stopPropagation();
      }
    }

    document.addEventListener('mousedown', handleMiddleClick);
    document.addEventListener('auxclick', handleMiddleClick);

    return () => {
      document.removeEventListener('mousedown', handleMiddleClick);
      document.removeEventListener('auxclick', handleMiddleClick);
    };
  }, []);

  useEffect(() => {
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    if (!engine) {
      return;
    }

    const applyPresentation = (viewportKey: OrthoViewportName) => {
      const viewport = engine.getViewport(viewportKey);
      if (!isVolumeViewport(viewport)) {
        return false;
      }

      const config = presentations[viewportKey];
      const previousMode = previousModesRef.current[viewportKey];
      const baseOrientation = viewportMap[viewportKey].orientation;

      if (config.mode === 'axial-slices') {
        // Only reset orientation on first entry, not every render — avoids
        // resetting camera which breaks crosshair synchronisation.
        if (previousMode !== 'axial-slices') {
          viewport.setOrientation(cornerstone.Enums.OrientationAxis.AXIAL);
        }
        viewport.setBlendMode(cornerstone.Enums.BlendModes.COMPOSITE);
        viewport.setSlabThickness(0.1);
      } else {
        if (previousMode === 'axial-slices') {
          viewport.setOrientation(baseOrientation);
        }

        if (config.mode === 'mip') {
          viewport.setBlendMode(cornerstone.Enums.BlendModes.MAXIMUM_INTENSITY_BLEND);
          viewport.setSlabThickness(config.mipThicknessMm);
        } else {
          viewport.setBlendMode(cornerstone.Enums.BlendModes.COMPOSITE);
          viewport.setSlabThickness(0.1);
        }
      }

      applyLinearInterpolation(viewport);
      viewport.render();
      previousModesRef.current[viewportKey] = config.mode;
      return true;
    };

    const applyAll = () => {
      let anyApplied = false;
      for (const viewport of ORTHO_VIEWPORTS) {
        anyApplied = applyPresentation(viewport.key) || anyApplied;
      }
      return anyApplied;
    };

    const timeoutId = window.setTimeout(() => {
      if (!applyAll()) {
        window.setTimeout(applyAll, 300);
      }
    }, 120);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [presentations, renderingEngineId, setupToken, viewportMap]);

  useEffect(() => {
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    if (!engine) {
      return;
    }

    const cleanup: Array<() => void> = [];

    for (const viewportEntry of ORTHO_VIEWPORTS) {
      const element = document.getElementById(viewportEntry.id);
      if (!element) {
        continue;
      }

      const handleMouseDown = (event: MouseEvent) => {
        if (event.button !== 0) {
          return;
        }

        const config = presentations[viewportEntry.key];
        const pivotRequested = config.mode !== 'axial-slices' && (config.pivotEnabled || event.shiftKey);
        if (!pivotRequested) {
          return;
        }

        const viewport = engine.getViewport(viewportEntry.key);
        if (!isVolumeViewport(viewport)) {
          return;
        }

        const camera = viewport.getCamera();
        if (!camera.focalPoint || !camera.position || !camera.viewPlaneNormal || !camera.viewUp) {
          return;
        }

        dragStateRef.current = {
          viewportKey: viewportEntry.key,
          pivot: [...camera.focalPoint] as cornerstone.Types.Point3,
          viewPlaneNormal: [...camera.viewPlaneNormal] as cornerstone.Types.Point3,
          viewUp: [...camera.viewUp] as cornerstone.Types.Point3,
          distance: Math.hypot(
            camera.position[0] - camera.focalPoint[0],
            camera.position[1] - camera.focalPoint[1],
            camera.position[2] - camera.focalPoint[2]
          ),
          startClientX: event.clientX,
          startClientY: event.clientY,
        };

        event.preventDefault();
        event.stopPropagation();
      };

      element.addEventListener('mousedown', handleMouseDown, true);
      cleanup.push(() => element.removeEventListener('mousedown', handleMouseDown, true));
    }

    const handleMouseMove = (event: MouseEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState) {
        return;
      }

      const viewport = engine.getViewport(dragState.viewportKey);
      if (!isVolumeViewport(viewport)) {
        return;
      }

      const deltaX = event.clientX - dragState.startClientX;
      const deltaY = event.clientY - dragState.startClientY;
      const yaw = (deltaX * Math.PI) / 540;
      const pitch = (deltaY * Math.PI) / 540;

      const up0 = normalize(dragState.viewUp);
      const normal0 = normalize(dragState.viewPlaneNormal);
      const right0 = normalize(cross(up0, normal0));

      const yawedNormal = normalize(rotateAroundAxis(normal0, up0, yaw));
      const yawedRight = normalize(rotateAroundAxis(right0, up0, yaw));
      const pitchedNormal = normalize(rotateAroundAxis(yawedNormal, yawedRight, pitch));
      let pitchedUp = normalize(rotateAroundAxis(up0, yawedRight, pitch));
      const correctedRight = normalize(cross(pitchedUp, pitchedNormal));
      pitchedUp = normalize(cross(pitchedNormal, correctedRight));

      viewport.setCamera({
        focalPoint: dragState.pivot,
        position: [
          dragState.pivot[0] + pitchedNormal[0] * dragState.distance,
          dragState.pivot[1] + pitchedNormal[1] * dragState.distance,
          dragState.pivot[2] + pitchedNormal[2] * dragState.distance,
        ] as cornerstone.Types.Point3,
        viewUp: pitchedUp,
      });
      viewport.render();

      event.preventDefault();
      event.stopPropagation();
    };

    const handleMouseUp = () => {
      dragStateRef.current = null;
    };

    window.addEventListener('mousemove', handleMouseMove, true);
    window.addEventListener('mouseup', handleMouseUp, true);
    cleanup.push(() => window.removeEventListener('mousemove', handleMouseMove, true));
    cleanup.push(() => window.removeEventListener('mouseup', handleMouseUp, true));

    return () => {
      cleanup.forEach((entry) => entry());
      dragStateRef.current = null;
    };
  }, [presentations, renderingEngineId]);

  function updatePresentation(
    viewportKey: OrthoViewportName,
    patch: Partial<ViewportPresentation>
  ) {
    // Sync mode fans mode + slab thickness across all orthos. pivotEnabled
    // stays local because it is a viewport-specific interaction flag.
    const sharedPatch: Partial<ViewportPresentation> = {};
    if ('mode' in patch) sharedPatch.mode = patch.mode;
    if ('mipThicknessMm' in patch) sharedPatch.mipThicknessMm = patch.mipThicknessMm;
    const broadcast = syncMode && Object.keys(sharedPatch).length > 0;

    setPresentations((current) => {
      const next = { ...current };
      if (broadcast) {
        for (const key of Object.keys(next) as OrthoViewportName[]) {
          next[key] = { ...next[key], ...sharedPatch };
        }
        next[viewportKey] = { ...next[viewportKey], ...patch };
      } else {
        next[viewportKey] = { ...next[viewportKey], ...patch };
      }
      return next;
    });
  }

  return (
    <div className={`viewport-grid layout-${layout} ${expanded ? 'expanded' : ''}`}>
      {layout === 'mpr' && (
        <div className="viewport-grid-toolbar">
          <label className="sync-toggle" title="When on, switching a viewport to MIP applies the same mode and slab thickness to all MPR viewports.">
            <input
              type="checkbox"
              checked={syncMode}
              onChange={(event) => setSyncMode(event.target.checked)}
            />
            <span>Sync view mode + slab</span>
          </label>
        </div>
      )}
      {ORTHO_VIEWPORTS.map((viewport) => {
        const hidden = (expanded != null && expanded !== viewport.key) || (layout === 'single' && viewport.key !== 'axial');
        const presentation = presentations[viewport.key];
        const pivotTemporarilyActive = shiftPivotActive && presentation.mode !== 'axial-slices';
        return (
          <section
            key={viewport.key}
            data-viewport={viewport.key}
            className={`viewport-shell ${hidden ? 'hidden' : ''} ${
              expanded === viewport.key ? 'focused' : ''
            }`}
          >
            <div className="viewport-header">
              <div className="viewport-header-copy">
                <span>{labelForMode(presentation.mode)}</span>
                <small>{viewport.label}</small>
              </div>

              <div className="viewport-controls">
                <select
                  className="viewport-select"
                  value={presentation.mode}
                  onChange={(event) =>
                    updatePresentation(viewport.key, {
                      mode: event.target.value as ViewMode,
                      pivotEnabled:
                        event.target.value === 'axial-slices'
                          ? false
                          : presentations[viewport.key].pivotEnabled,
                    })
                  }
                >
                  <option value="mpr">MPR</option>
                  <option value="mip">MIP</option>
                  <option value="axial-slices">Axial Slices</option>
                </select>

                {presentation.mode === 'mip' && (
                  <label className="viewport-inline-field">
                    <span>Slab</span>
                    <input
                      type="number"
                      min="2"
                      max="80"
                      step="1"
                      value={presentation.mipThicknessMm}
                      onChange={(event) =>
                        updatePresentation(viewport.key, {
                          mipThicknessMm: Math.max(2, Number(event.target.value) || 2),
                        })
                      }
                    />
                  </label>
                )}

                <button
                  className={`ghost-btn ${
                    presentation.pivotEnabled || pivotTemporarilyActive ? 'active' : ''
                  }`}
                  disabled={presentation.mode === 'axial-slices'}
                  title={
                    presentation.mode === 'axial-slices'
                      ? 'Pivot is not available in Axial Slices view'
                      : 'Toggle Pivot mode. Hold Shift for temporary Pivot.'
                  }
                  onClick={() =>
                    updatePresentation(viewport.key, {
                      pivotEnabled: !presentation.pivotEnabled,
                    })
                  }
                >
                  Pivot
                </button>

                <button
                  className="ghost-btn"
                  onClick={() => setExpanded(expanded === viewport.key ? null : viewport.key)}
                >
                  {expanded === viewport.key ? 'Exit' : 'Expand'}
                </button>
              </div>
            </div>

            <div className="viewport-mode-strip">
              {presentation.mode === 'axial-slices'
                ? 'Axial Slices uses original slice orientation. Pivot is disabled in this view.'
                : presentation.pivotEnabled
                  ? 'Pivot mode active. Drag with the left mouse button to tilt the viewed plane.'
                  : 'Hold Shift for temporary Pivot, or toggle Pivot to drag the viewed plane around the crosshair.'}
            </div>

            <div className="viewport-frame">
              <div
                id={viewport.id}
                className={`viewport-canvas viewport-mode-${presentation.mode}`}
                data-viewport-id={viewport.key}
              />
              <OrientationOverlay viewportId={viewport.key} renderingEngineId={renderingEngineId} />
            </div>
          </section>
        );
      })}
    </div>
  );
}
