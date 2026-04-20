import * as cornerstone from '@cornerstonejs/core';
import { TAVIVector3D } from './TAVITypes';
import { TAVIGeometry } from './TAVIGeometry';

/**
 * CuspMarkerOverlay: renders 3 colored nadir markers on double-oblique viewports.
 *
 * 3mensio-style:
 *   RC (Right Coronary cusp) = GREEN dot, label "RC"
 *   NC (Non-Coronary cusp)   = YELLOW dot, label "NC"
 *   LC (Left Coronary cusp)  = RED dot, label "LC"
 *
 * - Markers can be placed by clicking on the viewport
 * - Markers are draggable after placement
 * - Markers are visible across all registered viewports
 * - After 3 markers are placed, the annulus plane is computed
 * - CAMERA_MODIFIED triggers redraw
 */

export type CuspId = 'rc' | 'nc' | 'lc';

interface CuspMarker {
  id: CuspId;
  label: string;
  color: string;
  colorHover: string;
  point: TAVIVector3D | null;
}

const MARKER_RADIUS = 7;
const HIT_RADIUS = 12;
const LABEL_OFFSET = 14;

interface ViewportOverlay {
  viewportId: string;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  resizeObserver: ResizeObserver;
  cameraHandler: () => void;
  mouseDownHandler: (e: MouseEvent) => void;
  mouseMoveHandler: (e: MouseEvent) => void;
  mouseUpHandler: (e: MouseEvent) => void;
  clickHandler: (e: MouseEvent) => void;
}

export class CuspMarkerOverlay {
  private renderingEngineId: string;
  private markers: CuspMarker[] = [
    { id: 'lc', label: 'LCH', color: '#ef4444', colorHover: '#f87171', point: null },
    { id: 'nc', label: 'NCH', color: '#eab308', colorHover: '#facc15', point: null },
    { id: 'rc', label: 'RCH', color: '#22c55e', colorHover: '#4ade80', point: null },
  ];
  private overlays: ViewportOverlay[] = [];
  private enabled = false;

  // Which cusp to place next (null = all placed, drag-only mode)
  private activeCusp: CuspId | null = 'lc';

  // Drag state
  private dragging = false;
  private dragCuspId: CuspId | null = null;
  private hoverCuspId: CuspId | null = null;

  // Callbacks
  private onMarkerPlaced?: (id: CuspId, point: TAVIVector3D) => void;
  private onMarkerMoved?: (id: CuspId, point: TAVIVector3D) => void;
  private onAllPlaced?: (lc: TAVIVector3D, nc: TAVIVector3D, rc: TAVIVector3D) => void;

  constructor(renderingEngineId: string) {
    this.renderingEngineId = renderingEngineId;
  }

  enable(
    viewportIds: string[],
    callbacks?: {
      onMarkerPlaced?: (id: CuspId, point: TAVIVector3D) => void;
      onMarkerMoved?: (id: CuspId, point: TAVIVector3D) => void;
      onAllPlaced?: (rc: TAVIVector3D, nc: TAVIVector3D, lc: TAVIVector3D) => void;
    }
  ): void {
    if (this.enabled) this.disable();
    this.enabled = true;
    this.onMarkerPlaced = callbacks?.onMarkerPlaced;
    this.onMarkerMoved = callbacks?.onMarkerMoved;
    this.onAllPlaced = callbacks?.onAllPlaced;

    const engine = cornerstone.getRenderingEngine(this.renderingEngineId);
    if (!engine) return;

    for (const vpId of viewportIds) {
      const vp = engine.getViewport(vpId);
      if (!vp?.element) continue;

      const el = vp.element;
      el.style.position = 'relative';

      const canvas = document.createElement('canvas');
      canvas.className = 'tavi-cusp-canvas';
      canvas.style.cssText = `
        position: absolute;
        top: 0; left: 0;
        width: 100%; height: 100%;
        pointer-events: none;
        z-index: 52;
      `;
      el.appendChild(canvas);
      const ctx = canvas.getContext('2d')!;

      const syncSize = () => {
        const rect = el.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.redrawViewport(vpId);
      };

      const resizeObserver = new ResizeObserver(syncSize);
      resizeObserver.observe(el);
      syncSize();

      const cameraHandler = () => this.redrawViewport(vpId);
      el.addEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, cameraHandler as EventListener);

      const clickHandler = (e: MouseEvent) => {
        if (e.button !== 0 || this.dragging) return;
        if (!this.activeCusp) return; // all placed

        const cp = this.eventToCanvasPoint(e, el);
        if (!cp) return;

        // Don't place if clicking on an existing marker
        if (this.hitTestMarker(cp, vpId)) return;

        const worldPoint = vp.canvasToWorld(cp as cornerstone.Types.Point2);
        if (!worldPoint) return;

        const point: TAVIVector3D = { x: worldPoint[0], y: worldPoint[1], z: worldPoint[2] };
        const marker = this.markers.find(m => m.id === this.activeCusp);
        if (marker) {
          marker.point = point;
          this.onMarkerPlaced?.(marker.id, point);

          // Advance to next unplaced cusp
          this.advanceActiveCusp();
          this.redrawAll();

          // Check if all placed
          const allPlaced = this.markers.every(m => m.point !== null);
          if (allPlaced) {
            this.onAllPlaced?.(
              this.markers[0].point!,
              this.markers[1].point!,
              this.markers[2].point!
            );
          }
        }
      };

      const mouseDownHandler = (e: MouseEvent) => {
        if (e.button !== 0) return;
        const cp = this.eventToCanvasPoint(e, el);
        if (!cp) return;

        const hit = this.hitTestMarker(cp, vpId);
        if (hit) {
          this.dragging = true;
          this.dragCuspId = hit;
          canvas.style.pointerEvents = 'auto';
          canvas.style.cursor = 'grabbing';
          e.preventDefault();
          e.stopPropagation();
        }
      };

      const mouseMoveHandler = (e: MouseEvent) => {
        const cp = this.eventToCanvasPoint(e, el);
        if (!cp) return;

        if (this.dragging && this.dragCuspId) {
          const worldPoint = vp.canvasToWorld(cp as cornerstone.Types.Point2);
          if (worldPoint) {
            const marker = this.markers.find(m => m.id === this.dragCuspId);
            if (marker) {
              marker.point = { x: worldPoint[0], y: worldPoint[1], z: worldPoint[2] };
              this.onMarkerMoved?.(marker.id, marker.point);
              this.redrawAll();
            }
          }
          e.preventDefault();
          e.stopPropagation();
        } else {
          const hit = this.hitTestMarker(cp, vpId);
          const newHover = hit || null;
          if (newHover !== this.hoverCuspId) {
            this.hoverCuspId = newHover;
            canvas.style.pointerEvents = newHover ? 'auto' : 'none';
            canvas.style.cursor = newHover ? 'grab' : 'default';
            this.redrawAll();
          }
        }
      };

      const mouseUpHandler = () => {
        if (this.dragging) {
          this.dragging = false;
          this.dragCuspId = null;
          canvas.style.pointerEvents = 'none';
          canvas.style.cursor = 'default';
          this.redrawAll();

          // Re-check if all placed after drag
          const allPlaced = this.markers.every(m => m.point !== null);
          if (allPlaced) {
            this.onAllPlaced?.(
              this.markers[0].point!,
              this.markers[1].point!,
              this.markers[2].point!
            );
          }
        }
      };

      el.addEventListener('click', clickHandler);
      el.addEventListener('mousedown', mouseDownHandler);
      el.addEventListener('mousemove', mouseMoveHandler);
      document.addEventListener('mouseup', mouseUpHandler);

      this.overlays.push({
        viewportId: vpId,
        canvas, ctx, resizeObserver,
        cameraHandler, mouseDownHandler, mouseMoveHandler, mouseUpHandler, clickHandler,
      });
    }
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;

    const engine = cornerstone.getRenderingEngine(this.renderingEngineId);
    for (const overlay of this.overlays) {
      const vp = engine?.getViewport(overlay.viewportId);
      const el = vp?.element;
      if (el) {
        el.removeEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, overlay.cameraHandler as EventListener);
        el.removeEventListener('click', overlay.clickHandler);
        el.removeEventListener('mousedown', overlay.mouseDownHandler);
        el.removeEventListener('mousemove', overlay.mouseMoveHandler);
      }
      document.removeEventListener('mouseup', overlay.mouseUpHandler);
      overlay.resizeObserver.disconnect();
      if (overlay.canvas.parentElement) {
        overlay.canvas.parentElement.removeChild(overlay.canvas);
      }
    }
    this.overlays = [];
    this.dragging = false;
    this.dragCuspId = null;
    this.hoverCuspId = null;
  }

  /** Set the next cusp to be placed */
  setActiveCusp(cusp: CuspId | null): void {
    this.activeCusp = cusp;
    this.redrawAll();
  }

  /** Get which cusp is next to place */
  getActiveCusp(): CuspId | null {
    return this.activeCusp;
  }

  /** Get a marker's world point */
  getMarkerPoint(id: CuspId): TAVIVector3D | null {
    return this.markers.find(m => m.id === id)?.point || null;
  }

  /** Set a marker programmatically */
  setMarkerPoint(id: CuspId, point: TAVIVector3D): void {
    const marker = this.markers.find(m => m.id === id);
    if (marker) {
      marker.point = { ...point };
      this.redrawAll();
    }
  }

  /** Clear all markers */
  clearMarkers(): void {
    for (const m of this.markers) m.point = null;
    this.activeCusp = 'lc';
    this.redrawAll();
  }

  /** Remove the last placed marker (unpick) */
  undoLastMarker(): void {
    // Find the last placed marker in reverse order
    const order: CuspId[] = ['lc', 'nc', 'rc'];
    for (let i = order.length - 1; i >= 0; i--) {
      const marker = this.markers.find(m => m.id === order[i]);
      if (marker?.point) {
        marker.point = null;
        this.activeCusp = order[i];
        this.redrawAll();
        return;
      }
    }
  }

  /** Remove a specific marker */
  removeMarker(id: CuspId): void {
    const marker = this.markers.find(m => m.id === id);
    if (marker) {
      marker.point = null;
      // Reset active to the first unplaced
      this.advanceActiveCusp();
      if (!this.activeCusp) this.activeCusp = id;
      this.redrawAll();
    }
  }

  /** Check if all 3 markers are placed */
  allPlaced(): boolean {
    return this.markers.every(m => m.point !== null);
  }

  /** Compute annulus plane from 3 markers (returns null if not all placed) */
  computeAnnulusPlane(): { normal: TAVIVector3D; centroid: TAVIVector3D } | null {
    if (!this.allPlaced()) return null;
    const rc = this.markers[0].point!;
    const nc = this.markers[1].point!;
    const lc = this.markers[2].point!;
    return TAVIGeometry.planeFromThreePoints(rc, nc, lc);
  }

  // ── Private ──

  private advanceActiveCusp(): void {
    const order: CuspId[] = ['lc', 'nc', 'rc'];
    const next = order.find(id => {
      const m = this.markers.find(mk => mk.id === id);
      return m && !m.point;
    });
    this.activeCusp = next || null;
  }

  private eventToCanvasPoint(e: MouseEvent, el: HTMLElement): [number, number] | null {
    const rect = el.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  private worldToCanvas(point: TAVIVector3D, viewportId: string): [number, number] | null {
    const engine = cornerstone.getRenderingEngine(this.renderingEngineId);
    if (!engine) return null;
    const vp = engine.getViewport(viewportId);
    if (!vp) return null;
    const result = vp.worldToCanvas([point.x, point.y, point.z]);
    if (!result) return null;
    return [result[0], result[1]];
  }

  private hitTestMarker(canvasPoint: [number, number], viewportId: string): CuspId | null {
    for (const marker of this.markers) {
      if (!marker.point) continue;
      const cp = this.worldToCanvas(marker.point, viewportId);
      if (!cp) continue;
      const dx = cp[0] - canvasPoint[0];
      const dy = cp[1] - canvasPoint[1];
      if (dx * dx + dy * dy <= HIT_RADIUS * HIT_RADIUS) {
        return marker.id;
      }
    }
    return null;
  }

  private redrawAll(): void {
    for (const overlay of this.overlays) {
      this.redrawViewport(overlay.viewportId);
    }
  }

  private redrawViewport(viewportId: string): void {
    const overlay = this.overlays.find(o => o.viewportId === viewportId);
    if (!overlay) return;

    const { ctx, canvas } = overlay;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Draw each placed marker
    for (const marker of this.markers) {
      if (!marker.point) continue;

      const cp = this.worldToCanvas(marker.point, viewportId);
      if (!cp) continue;

      const isHovered = marker.id === this.hoverCuspId;
      const isDragged = marker.id === this.dragCuspId && this.dragging;
      const radius = isHovered || isDragged ? MARKER_RADIUS + 2 : MARKER_RADIUS;
      const color = isHovered || isDragged ? marker.colorHover : marker.color;

      // Outer glow
      ctx.beginPath();
      ctx.arc(cp[0], cp[1], radius + 3, 0, Math.PI * 2);
      ctx.fillStyle = `${marker.color}40`; // 25% opacity
      ctx.fill();

      // Filled circle
      ctx.beginPath();
      ctx.arc(cp[0], cp[1], radius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.stroke();

      // Label
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 3;
      ctx.strokeText(marker.label, cp[0], cp[1] - LABEL_OFFSET);
      ctx.fillText(marker.label, cp[0], cp[1] - LABEL_OFFSET);
    }

    // Draw placement hint
    if (this.activeCusp) {
      const activeMarker = this.markers.find(m => m.id === this.activeCusp);
      if (activeMarker) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(0, h - 28, w, 28);
        ctx.fillStyle = activeMarker.color;
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(
          `Click to place ${activeMarker.label} (${activeMarker.id === 'rc' ? 'Right Coronary' : activeMarker.id === 'nc' ? 'Non-Coronary' : 'Left Coronary'}) cusp nadir`,
          w / 2,
          h - 14
        );
      }
    }

    ctx.restore();
  }
}
