import * as cornerstone from '@cornerstonejs/core';
import type { CoronaryVesselId, WorldPoint3D } from './QCATypes';

/**
 * When user clicks in a MIP/thick-slab viewport, the raw canvasToWorld
 * returns the point at the focal plane (center of slab). The bright
 * vessel they see may actually be at a different depth within the slab.
 * This helper raycasts along the viewport view-plane normal, finds the
 * highest-HU voxel within the slab, and returns its world position so
 * centerline points snap onto real anatomy visible in other views.
 */
function snapClickToMaxIntensity(
  worldPoint: cornerstone.Types.Point3,
  viewport: cornerstone.Types.IViewport,
): cornerstone.Types.Point3 {
  const camera = viewport.getCamera();
  const vpn = camera.viewPlaneNormal as cornerstone.Types.Point3 | undefined;
  if (!vpn) return worldPoint;

  // Probe range for max-intensity search along view normal.
  // Decoupled from slab thickness: thin-slice viewports (slab ~0.1mm) still
  // need depth snap so points land on the vessel lumen, not on the view plane.
  // Without this, clicks in one viewport place points at the slice depth,
  // appearing offset from the vessel when projected into other viewports.
  const slab = ('getSlabThickness' in viewport)
    ? ((viewport as cornerstone.Types.IVolumeViewport).getSlabThickness?.() ?? 0)
    : 0;
  const probeRangeMm = Math.max(slab, 8);

  // Locate the matching volume. Try viewport actors first, then fall back
  // to cache scan — some cornerstone versions use actorUID that doesn't
  // match the cached volumeId directly.
  let volume: any = null;
  const actors = (viewport as cornerstone.Types.IVolumeViewport).getActors?.() ?? [];
  for (const actor of actors) {
    const uid = (actor as any).uid || (actor as any).referencedId || (actor as any).actorUID;
    if (!uid) continue;
    const cached = cornerstone.cache.getVolume(uid);
    if (cached) { volume = cached; break; }
  }
  if (!volume) {
    const cache = cornerstone.cache as any;
    const getVolumes = cache.getVolumes || cache._volumeCache?.values;
    if (typeof getVolumes === 'function') {
      try {
        const all = Array.from(getVolumes.call(cache._volumeCache || cache)) as any[];
        volume = all.find((v: any) => {
          const inner = v?.volume || v;
          return inner?.imageData && (inner.voxelManager || inner.scalarData || typeof inner.getScalarData === 'function');
        });
        if (volume && !volume.imageData && volume.volume) volume = volume.volume;
      } catch { /* ignore */ }
    }
  }
  if (!volume?.imageData?.worldToIndex || !volume.dimensions) {
    return worldPoint;
  }

  // Resolve scalar accessor: streaming volumes expose voxelManager.getAtIJK;
  // legacy volumes expose scalarData / getScalarData().
  const vm = volume.voxelManager;
  let scalarData: ArrayLike<number> | null = volume.scalarData ?? null;
  if (!scalarData && typeof volume.getScalarData === 'function') {
    try { scalarData = volume.getScalarData(); } catch { /* ignore */ }
  }
  if (!vm?.getAtIJK && !scalarData) {
    return worldPoint;
  }
  const dims = volume.dimensions;

  const sampleHU = (p: cornerstone.Types.Point3): number => {
    const idx = volume.imageData.worldToIndex(p);
    if (!idx) return -1000;
    const i = Math.round(idx[0]);
    const j = Math.round(idx[1]);
    const k = Math.round(idx[2]);
    if (i < 0 || i >= dims[0] || j < 0 || j >= dims[1] || k < 0 || k >= dims[2]) return -1000;
    if (vm?.getAtIJK) {
      const v = vm.getAtIJK(i, j, k);
      return typeof v === 'number' ? v : -1000;
    }
    const offset = i + j * dims[0] + k * dims[0] * dims[1];
    const v = scalarData![offset];
    return typeof v === 'number' ? v : -1000;
  };

  const half = probeRangeMm * 0.5;
  const stepMm = 0.3;
  let bestHU = -Infinity;
  let bestPoint = worldPoint;
  for (let t = -half; t <= half; t += stepMm) {
    const probe: cornerstone.Types.Point3 = [
      worldPoint[0] + vpn[0] * t,
      worldPoint[1] + vpn[1] * t,
      worldPoint[2] + vpn[2] * t,
    ];
    const hu = sampleHU(probe);
    if (hu > bestHU) {
      bestHU = hu;
      bestPoint = probe;
    }
  }
  // Only snap if we actually found contrast. 120 HU covers contrast-filled
  // lumen (~200-500 HU) with margin for partial-volume edges; still rejects
  // myocardium (~40 HU) and air (-1000 HU).
  return bestHU >= 120 ? bestPoint : worldPoint;
}

function refocusOrthoViewportsOn(point: WorldPoint3D): void {
  window.dispatchEvent(
    new CustomEvent('coronary:cursor-moved', {
      detail: { point },
    })
  );
}

const POINT_RADIUS = 5;
const ACTIVE_POINT_RADIUS = 7;
const LINE_WIDTH = 2;
const ACTIVE_LINE_WIDTH = 3;
const HIT_RADIUS = 10;
const LINE_HIT_DISTANCE = 8;
const PREVIEW_DASH = [6, 4];

interface OverlayCenterline {
  id: CoronaryVesselId;
  label: string;
  color: string;
  points: WorldPoint3D[];
}

interface ViewportOverlay {
  viewportId: string;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  resizeObserver: ResizeObserver;
  cameraHandler: () => void;
  clickHandler: (event: MouseEvent) => void;
  contextMenuHandler: (event: MouseEvent) => void;
  mouseDownHandler: (event: MouseEvent) => void;
  mouseMoveHandler: (event: MouseEvent) => void;
  mouseLeaveHandler: () => void;
  mouseUpHandler: () => void;
}

interface PointHit {
  centerlineId: CoronaryVesselId;
  pointIndex: number;
}

interface SegmentHit {
  centerlineId: CoronaryVesselId;
  segmentIndex: number;
}

export type CoronaryCenterlineMode = 'idle' | 'draw';

interface ContextMenuEvent {
  centerlineId: CoronaryVesselId;
  clientX: number;
  clientY: number;
}

interface Callbacks {
  onCenterlineSelected?: (centerlineId: CoronaryVesselId) => void;
  onCenterlinePointsChanged?: (centerlineId: CoronaryVesselId, points: WorldPoint3D[]) => void;
  onControlPointSelected?: (centerlineId: CoronaryVesselId, pointIndex: number | null) => void;
  onContextMenuRequested?: (event: ContextMenuEvent) => void;
}

export class CoronaryCenterlineOverlay {
  private renderingEngineId: string;
  private centerlines: OverlayCenterline[] = [];
  private overlays: ViewportOverlay[] = [];
  private callbacks: Callbacks = {};
  private activeCenterlineId: CoronaryVesselId | null = null;
  private selectedPointIndex: number | null = null;
  private mode: CoronaryCenterlineMode = 'idle';
  private enabled = false;

  private dragging = false;
  private dragCenterlineId: CoronaryVesselId | null = null;
  private dragPointIndex = -1;
  private hoverPoint: PointHit | null = null;
  private hoverSegment: SegmentHit | null = null;
  private previewViewportId: string | null = null;
  private previewCanvasPoint: [number, number] | null = null;

  constructor(renderingEngineId: string) {
    this.renderingEngineId = renderingEngineId;
  }

  enable(viewportIds: string[], callbacks?: Callbacks): void {
    if (this.enabled) {
      this.disable();
    }

    this.enabled = true;
    this.callbacks = callbacks || {};

    const engine = cornerstone.getRenderingEngine(this.renderingEngineId);
    if (!engine) {
      return;
    }

    for (const viewportId of viewportIds) {
      const viewport = engine.getViewport(viewportId);
      if (!viewport?.element) {
        continue;
      }

      const element = viewport.element;
      element.style.position = 'relative';

      const canvas = document.createElement('canvas');
      canvas.className = 'coronary-centerline-overlay';
      canvas.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 53;
      `;
      element.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        continue;
      }

      const syncSize = () => {
        const rect = element.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.floor(rect.width * dpr));
        canvas.height = Math.max(1, Math.floor(rect.height * dpr));
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.redrawViewport(viewportId);
      };

      const resizeObserver = new ResizeObserver(syncSize);
      resizeObserver.observe(element);
      syncSize();

      const cameraHandler = () => this.redrawViewport(viewportId);
      element.addEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, cameraHandler as EventListener);

      const clickHandler = (event: MouseEvent) => {
        if (event.button !== 0 || this.dragging) {
          return;
        }

        const canvasPoint = this.eventToCanvasPoint(event, element);
        if (!canvasPoint) {
          return;
        }

        const pointHit = this.hitTestPoint(canvasPoint, viewportId);
        if (pointHit) {
          this.setActiveSelection(pointHit.centerlineId, pointHit.pointIndex);
          event.preventDefault();
          event.stopPropagation();
          return;
        }

        const segmentHit = this.hitTestSegment(canvasPoint, viewportId);
        if (segmentHit) {
          this.callbacks.onCenterlineSelected?.(segmentHit.centerlineId);
          if (this.mode === 'draw' && this.activeCenterlineId === segmentHit.centerlineId) {
            const rawWorld = viewport.canvasToWorld(canvasPoint as cornerstone.Types.Point2);
            if (rawWorld) {
              const worldPoint = snapClickToMaxIntensity(rawWorld, viewport);
              const centerline = this.getCenterline(segmentHit.centerlineId);
              if (centerline) {
                const points = centerline.points.map((point) => ({ ...point }));
                const inserted = {
                  x: worldPoint[0],
                  y: worldPoint[1],
                  z: worldPoint[2],
                };
                points.splice(segmentHit.segmentIndex + 1, 0, inserted);
                centerline.points = points;
                this.callbacks.onCenterlinePointsChanged?.(segmentHit.centerlineId, points);
                this.callbacks.onControlPointSelected?.(
                  segmentHit.centerlineId,
                  segmentHit.segmentIndex + 1
                );
                refocusOrthoViewportsOn(inserted);
              }
            }
          }
          event.preventDefault();
          event.stopPropagation();
          return;
        }

        if (this.mode !== 'draw' || !this.activeCenterlineId) {
          return;
        }

        const rawWorld = viewport.canvasToWorld(canvasPoint as cornerstone.Types.Point2);
        if (!rawWorld) {
          return;
        }
        const worldPoint = snapClickToMaxIntensity(rawWorld, viewport);

        const centerline = this.getCenterline(this.activeCenterlineId);
        if (!centerline) {
          return;
        }

        const nextPoint = {
          x: worldPoint[0],
          y: worldPoint[1],
          z: worldPoint[2],
        };
        const nextPoints = this.extendCenterline(centerline.points, nextPoint, canvasPoint, viewportId);
        centerline.points = nextPoints;
        this.callbacks.onCenterlinePointsChanged?.(this.activeCenterlineId, nextPoints);
        this.callbacks.onControlPointSelected?.(this.activeCenterlineId, nextPoints.length - 1);
        refocusOrthoViewportsOn(nextPoint);
        event.preventDefault();
        event.stopPropagation();
      };

      const contextMenuHandler = (event: MouseEvent) => {
        const canvasPoint = this.eventToCanvasPoint(event, element);
        if (!canvasPoint) {
          return;
        }

        const pointHit = this.hitTestPoint(canvasPoint, viewportId);
        if (pointHit) {
          this.setActiveSelection(pointHit.centerlineId, pointHit.pointIndex);
          this.callbacks.onContextMenuRequested?.({
            centerlineId: pointHit.centerlineId,
            clientX: event.clientX,
            clientY: event.clientY,
          });
          event.preventDefault();
          event.stopPropagation();
          return;
        }

        const segmentHit = this.hitTestSegment(canvasPoint, viewportId);
        if (!segmentHit) {
          return;
        }

        this.callbacks.onCenterlineSelected?.(segmentHit.centerlineId);
        this.callbacks.onContextMenuRequested?.({
          centerlineId: segmentHit.centerlineId,
          clientX: event.clientX,
          clientY: event.clientY,
        });
        event.preventDefault();
        event.stopPropagation();
      };

      const mouseDownHandler = (event: MouseEvent) => {
        if (event.button !== 0) {
          return;
        }

        const canvasPoint = this.eventToCanvasPoint(event, element);
        if (!canvasPoint) {
          return;
        }

        const pointHit = this.hitTestPoint(canvasPoint, viewportId);
        if (!pointHit) {
          return;
        }

        this.dragging = true;
        this.dragCenterlineId = pointHit.centerlineId;
        this.dragPointIndex = pointHit.pointIndex;
        this.setActiveSelection(pointHit.centerlineId, pointHit.pointIndex);
        canvas.style.pointerEvents = 'auto';
        canvas.style.cursor = 'grabbing';
        event.preventDefault();
        event.stopPropagation();
      };

      const mouseMoveHandler = (event: MouseEvent) => {
        const canvasPoint = this.eventToCanvasPoint(event, element);
        if (!canvasPoint) {
          return;
        }

        this.previewViewportId = viewportId;
        this.previewCanvasPoint = canvasPoint;

        if (this.dragging && this.dragCenterlineId && this.dragPointIndex >= 0) {
          const rawWorld = viewport.canvasToWorld(canvasPoint as cornerstone.Types.Point2);
          if (!rawWorld) {
            return;
          }
          const worldPoint = snapClickToMaxIntensity(rawWorld, viewport);

          const centerline = this.getCenterline(this.dragCenterlineId);
          if (!centerline) {
            return;
          }

          const points = centerline.points.map((point) => ({ ...point }));
          points[this.dragPointIndex] = {
            x: worldPoint[0],
            y: worldPoint[1],
            z: worldPoint[2],
          };
          // Update internal state immediately so camera-triggered redraws
          // (from refocusOrthoViewportsOn) render the new point position
          // across all viewports — don't wait for the async React effect.
          centerline.points = points;
          this.callbacks.onCenterlinePointsChanged?.(this.dragCenterlineId, points);
          refocusOrthoViewportsOn(points[this.dragPointIndex]);
          event.preventDefault();
          event.stopPropagation();
          return;
        }

        this.hoverPoint = this.hitTestPoint(canvasPoint, viewportId);
        this.hoverSegment = this.hitTestSegment(canvasPoint, viewportId);
        canvas.style.pointerEvents = this.hoverPoint ? 'auto' : 'none';
        canvas.style.cursor = this.hoverPoint ? 'grab' : 'default';
        this.redrawAll();
      };

      const mouseLeaveHandler = () => {
        this.previewViewportId = null;
        this.previewCanvasPoint = null;
        this.hoverPoint = null;
        this.hoverSegment = null;
        this.redrawAll();
      };

      const mouseUpHandler = () => {
        if (!this.dragging) {
          return;
        }
        this.dragging = false;
        this.dragCenterlineId = null;
        this.dragPointIndex = -1;
        canvas.style.pointerEvents = 'none';
        canvas.style.cursor = 'default';
        this.redrawAll();
      };

      element.addEventListener('click', clickHandler);
      element.addEventListener('contextmenu', contextMenuHandler);
      element.addEventListener('mousedown', mouseDownHandler);
      element.addEventListener('mousemove', mouseMoveHandler);
      element.addEventListener('mouseleave', mouseLeaveHandler);
      document.addEventListener('mouseup', mouseUpHandler);

      this.overlays.push({
        viewportId,
        canvas,
        ctx,
        resizeObserver,
        cameraHandler,
        clickHandler,
        contextMenuHandler,
        mouseDownHandler,
        mouseMoveHandler,
        mouseLeaveHandler,
        mouseUpHandler,
      });
    }
  }

  disable(): void {
    if (!this.enabled) {
      return;
    }

    this.enabled = false;
    const engine = cornerstone.getRenderingEngine(this.renderingEngineId);

    for (const overlay of this.overlays) {
      const viewport = engine?.getViewport(overlay.viewportId);
      const element = viewport?.element;
      if (element) {
        element.removeEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, overlay.cameraHandler as EventListener);
        element.removeEventListener('click', overlay.clickHandler);
        element.removeEventListener('contextmenu', overlay.contextMenuHandler);
        element.removeEventListener('mousedown', overlay.mouseDownHandler);
        element.removeEventListener('mousemove', overlay.mouseMoveHandler);
        element.removeEventListener('mouseleave', overlay.mouseLeaveHandler);
      }
      document.removeEventListener('mouseup', overlay.mouseUpHandler);
      overlay.resizeObserver.disconnect();
      overlay.canvas.parentElement?.removeChild(overlay.canvas);
    }

    this.overlays = [];
    this.dragging = false;
    this.dragCenterlineId = null;
    this.dragPointIndex = -1;
    this.hoverPoint = null;
    this.hoverSegment = null;
    this.previewViewportId = null;
    this.previewCanvasPoint = null;
  }

  setCenterlines(centerlines: OverlayCenterline[], activeCenterlineId: CoronaryVesselId | null): void {
    this.centerlines = centerlines.map((centerline) => ({
      ...centerline,
      points: centerline.points.map((point) => ({ ...point })),
    }));
    this.activeCenterlineId = activeCenterlineId;
    this.redrawAll();
  }

  setMode(mode: CoronaryCenterlineMode): void {
    this.mode = mode;
    this.redrawAll();
  }

  setSelectedPoint(centerlineId: CoronaryVesselId | null, pointIndex: number | null): void {
    if (centerlineId !== this.activeCenterlineId) {
      this.activeCenterlineId = centerlineId;
    }
    this.selectedPointIndex = pointIndex;
    this.redrawAll();
  }

  private setActiveSelection(centerlineId: CoronaryVesselId, pointIndex: number | null): void {
    this.activeCenterlineId = centerlineId;
    this.selectedPointIndex = pointIndex;
    this.callbacks.onCenterlineSelected?.(centerlineId);
    this.callbacks.onControlPointSelected?.(centerlineId, pointIndex);
    this.redrawAll();
  }

  private getCenterline(centerlineId: CoronaryVesselId): OverlayCenterline | undefined {
    return this.centerlines.find((centerline) => centerline.id === centerlineId);
  }

  private extendCenterline(
    points: WorldPoint3D[],
    nextPoint: WorldPoint3D,
    canvasPoint: [number, number],
    viewportId: string
  ): WorldPoint3D[] {
    if (points.length < 2) {
      return [...points, nextPoint];
    }

    const firstCanvasPoint = this.worldToCanvas(points[0], viewportId);
    const lastCanvasPoint = this.worldToCanvas(points[points.length - 1], viewportId);
    if (!firstCanvasPoint || !lastCanvasPoint) {
      return [...points, nextPoint];
    }

    const distanceToFirst = Math.hypot(canvasPoint[0] - firstCanvasPoint[0], canvasPoint[1] - firstCanvasPoint[1]);
    const distanceToLast = Math.hypot(canvasPoint[0] - lastCanvasPoint[0], canvasPoint[1] - lastCanvasPoint[1]);

    if (distanceToFirst < distanceToLast) {
      return [nextPoint, ...points];
    }

    return [...points, nextPoint];
  }

  private eventToCanvasPoint(event: MouseEvent, element: HTMLElement): [number, number] {
    const rect = element.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  private worldToCanvas(point: WorldPoint3D, viewportId: string): [number, number] | null {
    const engine = cornerstone.getRenderingEngine(this.renderingEngineId);
    if (!engine) {
      return null;
    }
    const viewport = engine.getViewport(viewportId);
    if (!viewport) {
      return null;
    }
    const result = viewport.worldToCanvas([point.x, point.y, point.z]);
    if (!result) {
      return null;
    }
    return [result[0], result[1]];
  }

  private prioritizedCenterlines(): OverlayCenterline[] {
    return [...this.centerlines].sort((lhs, rhs) => {
      if (lhs.id === this.activeCenterlineId) {
        return -1;
      }
      if (rhs.id === this.activeCenterlineId) {
        return 1;
      }
      return 0;
    });
  }

  private hitTestPoint(canvasPoint: [number, number], viewportId: string): PointHit | null {
    for (const centerline of this.prioritizedCenterlines()) {
      for (let index = 0; index < centerline.points.length; index += 1) {
        const controlPoint = this.worldToCanvas(centerline.points[index], viewportId);
        if (!controlPoint) {
          continue;
        }
        const dx = controlPoint[0] - canvasPoint[0];
        const dy = controlPoint[1] - canvasPoint[1];
        if (dx * dx + dy * dy <= HIT_RADIUS * HIT_RADIUS) {
          return {
            centerlineId: centerline.id,
            pointIndex: index,
          };
        }
      }
    }

    return null;
  }

  private hitTestSegment(canvasPoint: [number, number], viewportId: string): SegmentHit | null {
    for (const centerline of this.prioritizedCenterlines()) {
      for (let index = 0; index < centerline.points.length - 1; index += 1) {
        const lhs = this.worldToCanvas(centerline.points[index], viewportId);
        const rhs = this.worldToCanvas(centerline.points[index + 1], viewportId);
        if (!lhs || !rhs) {
          continue;
        }

        const distance = this.pointToSegmentDistance(canvasPoint, lhs, rhs);
        if (distance > LINE_HIT_DISTANCE) {
          continue;
        }

        const distanceToLhs = Math.hypot(canvasPoint[0] - lhs[0], canvasPoint[1] - lhs[1]);
        const distanceToRhs = Math.hypot(canvasPoint[0] - rhs[0], canvasPoint[1] - rhs[1]);
        if (distanceToLhs <= HIT_RADIUS || distanceToRhs <= HIT_RADIUS) {
          continue;
        }

        return {
          centerlineId: centerline.id,
          segmentIndex: index,
        };
      }
    }

    return null;
  }

  private pointToSegmentDistance(
    point: [number, number],
    lhs: [number, number],
    rhs: [number, number]
  ): number {
    const dx = rhs[0] - lhs[0];
    const dy = rhs[1] - lhs[1];
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) {
      return Math.hypot(point[0] - lhs[0], point[1] - lhs[1]);
    }

    let t = ((point[0] - lhs[0]) * dx + (point[1] - lhs[1]) * dy) / lengthSquared;
    t = Math.max(0, Math.min(1, t));
    const nearestX = lhs[0] + t * dx;
    const nearestY = lhs[1] + t * dy;
    return Math.hypot(point[0] - nearestX, point[1] - nearestY);
  }

  private redrawAll(): void {
    for (const overlay of this.overlays) {
      this.redrawViewport(overlay.viewportId);
    }
  }

  private redrawViewport(viewportId: string): void {
    const overlay = this.overlays.find((entry) => entry.viewportId === viewportId);
    if (!overlay) {
      return;
    }

    const { ctx, canvas } = overlay;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    for (const centerline of this.centerlines) {
      const canvasPoints = centerline.points
        .map((point) => this.worldToCanvas(point, viewportId))
        .filter(Boolean) as Array<[number, number]>;
      if (canvasPoints.length === 0) {
        continue;
      }

      const isActive = centerline.id === this.activeCenterlineId;
      ctx.beginPath();
      ctx.setLineDash([]);
      ctx.strokeStyle = centerline.color;
      ctx.lineWidth = isActive ? ACTIVE_LINE_WIDTH : LINE_WIDTH;
      ctx.globalAlpha = isActive ? 1 : 0.75;
      ctx.moveTo(canvasPoints[0][0], canvasPoints[0][1]);
      for (let index = 1; index < canvasPoints.length; index += 1) {
        ctx.lineTo(canvasPoints[index][0], canvasPoints[index][1]);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;

      const labelAnchor = canvasPoints[canvasPoints.length - 1];
      if (centerline.label.trim()) {
        ctx.fillStyle = centerline.color;
        ctx.font = '12px "Avenir Next", sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(centerline.label, labelAnchor[0] + 10, labelAnchor[1]);
      }

      if (!isActive) {
        continue;
      }

      centerline.points.forEach((point, pointIndex) => {
        const canvasPoint = this.worldToCanvas(point, viewportId);
        if (!canvasPoint) {
          return;
        }

        const isHovered =
          this.hoverPoint?.centerlineId === centerline.id && this.hoverPoint.pointIndex === pointIndex;
        const isSelected = this.selectedPointIndex === pointIndex;
        const isDragged =
          this.dragging && this.dragCenterlineId === centerline.id && this.dragPointIndex === pointIndex;
        const radius = isSelected || isDragged ? ACTIVE_POINT_RADIUS : POINT_RADIUS;

        ctx.beginPath();
        ctx.arc(canvasPoint[0], canvasPoint[1], radius + 2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
        ctx.fill();

        ctx.beginPath();
        ctx.arc(canvasPoint[0], canvasPoint[1], radius, 0, Math.PI * 2);
        ctx.fillStyle = isDragged ? '#ffffff' : isHovered ? '#fef3c7' : centerline.color;
        ctx.fill();
        ctx.lineWidth = isSelected ? 2.5 : 1.5;
        ctx.strokeStyle = '#041019';
        ctx.stroke();
      });

      if (
        this.mode === 'draw' &&
        this.previewViewportId === viewportId &&
        this.previewCanvasPoint &&
        centerline.points.length >= 1
      ) {
        const startCanvasPoint = this.worldToCanvas(centerline.points[0], viewportId);
        const endCanvasPoint = this.worldToCanvas(centerline.points[centerline.points.length - 1], viewportId);
        const target =
          startCanvasPoint && endCanvasPoint
            ? Math.hypot(this.previewCanvasPoint[0] - startCanvasPoint[0], this.previewCanvasPoint[1] - startCanvasPoint[1]) <
              Math.hypot(this.previewCanvasPoint[0] - endCanvasPoint[0], this.previewCanvasPoint[1] - endCanvasPoint[1])
              ? startCanvasPoint
              : endCanvasPoint
            : endCanvasPoint || startCanvasPoint;

        if (target) {
          ctx.beginPath();
          ctx.strokeStyle = centerline.color;
          ctx.lineWidth = 1.5;
          ctx.setLineDash(PREVIEW_DASH);
          ctx.moveTo(target[0], target[1]);
          ctx.lineTo(this.previewCanvasPoint[0], this.previewCanvasPoint[1]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }

    if (this.mode === 'draw' && this.activeCenterlineId) {
      ctx.fillStyle = 'rgba(4, 16, 25, 0.72)';
      ctx.fillRect(0, height - 24, width, 24);
      ctx.fillStyle = '#d7e7f8';
      ctx.font = '11px "Avenir Next", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        'Left click to create or extend the active centerline. Drag a control point to modify it.',
        width / 2,
        height - 12
      );
    }

    ctx.restore();
  }
}
