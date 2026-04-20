import * as cornerstone from '@cornerstonejs/core';
import { TAVIVector3D } from './TAVITypes';
import { TAVIGeometry } from './TAVIGeometry';

/**
 * CenterlineOverlay: renders a yellow polyline with draggable control points
 * across multiple viewports (3mensio-style centerline through aortic root).
 *
 * - Control points are shown as yellow circles on every viewport
 * - Dragging a control point updates it in world coordinates and redraws all viewports
 * - The centerline is rendered as a smooth yellow line connecting all points
 * - Clicking on the centerline (between points) adds a new control point
 * - CAMERA_MODIFIED on each viewport triggers redraw
 */

const POINT_RADIUS = 6;
const POINT_COLOR = '#d4c428'; // yellow (3mensio style)
const POINT_COLOR_HOVER = '#ffe066';
const POINT_COLOR_DRAG = '#ff8800';
const LINE_COLOR = '#d4c428';
const LINE_WIDTH = 2;
const HIT_RADIUS = 10;
const LINE_HIT_DISTANCE = 6; // px distance to detect click on line segment

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

export class CenterlineOverlay {
  private renderingEngineId: string;
  private controlPoints: TAVIVector3D[] = [];
  private overlays: ViewportOverlay[] = [];
  private enabled = false;

  // Drag state
  private dragging = false;
  private dragIndex = -1;
  private hoverIndex = -1;
  private hoverViewportId: string | null = null;

  // Callback when points change
  private onPointsChanged?: (points: TAVIVector3D[]) => void;

  constructor(renderingEngineId: string) {
    this.renderingEngineId = renderingEngineId;
  }

  /** Initialize with viewport IDs to attach overlays to */
  enable(viewportIds: string[], initialPoints?: TAVIVector3D[], onPointsChanged?: (points: TAVIVector3D[]) => void): void {
    if (this.enabled) this.disable();
    this.enabled = true;
    this.onPointsChanged = onPointsChanged;

    if (initialPoints) {
      this.controlPoints = initialPoints.map(p => ({ ...p }));
    }

    const engine = cornerstone.getRenderingEngine(this.renderingEngineId);
    if (!engine) return;

    for (const vpId of viewportIds) {
      const vp = engine.getViewport(vpId);
      if (!vp?.element) continue;

      const el = vp.element;
      el.style.position = 'relative';

      // Create canvas overlay
      const canvas = document.createElement('canvas');
      canvas.className = 'tavi-centerline-canvas';
      canvas.style.cssText = `
        position: absolute;
        top: 0; left: 0;
        width: 100%; height: 100%;
        pointer-events: none;
        z-index: 51;
      `;
      el.appendChild(canvas);
      const ctx = canvas.getContext('2d')!;

      // Sync canvas size
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

      // Camera change handler
      const cameraHandler = () => this.redrawViewport(vpId);
      el.addEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, cameraHandler as EventListener);

      // Mouse handlers for dragging control points
      const mouseDownHandler = (e: MouseEvent) => {
        if (e.button !== 0) return;
        const cp = this.eventToCanvasPoint(e, el);
        if (!cp) return;

        const hitIdx = this.hitTestPoint(cp, vpId);
        if (hitIdx >= 0) {
          this.dragging = true;
          this.dragIndex = hitIdx;
          canvas.style.pointerEvents = 'auto';
          canvas.style.cursor = 'grabbing';
          e.preventDefault();
          e.stopPropagation();
        }
      };

      const mouseMoveHandler = (e: MouseEvent) => {
        const cp = this.eventToCanvasPoint(e, el);
        if (!cp) return;

        if (this.dragging && this.dragIndex >= 0) {
          const worldPoint = vp.canvasToWorld(cp as cornerstone.Types.Point2);
          if (worldPoint) {
            this.controlPoints[this.dragIndex] = {
              x: worldPoint[0], y: worldPoint[1], z: worldPoint[2],
            };
            this.redrawAll();
            this.onPointsChanged?.(this.getPoints());
          }
          e.preventDefault();
          e.stopPropagation();
        } else {
          // Hover detection
          const newHover = this.hitTestPoint(cp, vpId);
          if (newHover !== this.hoverIndex || this.hoverViewportId !== vpId) {
            this.hoverIndex = newHover;
            this.hoverViewportId = vpId;
            canvas.style.pointerEvents = newHover >= 0 ? 'auto' : 'none';
            canvas.style.cursor = newHover >= 0 ? 'grab' : 'default';
            this.redrawAll();
          }
        }
      };

      const mouseUpHandler = (_e: MouseEvent) => {
        if (this.dragging) {
          this.dragging = false;
          this.dragIndex = -1;
          canvas.style.pointerEvents = 'none';
          canvas.style.cursor = 'default';
          this.redrawAll();
        }
      };

      // Click handler: click on the line to insert a new control point
      const clickHandler = (e: MouseEvent) => {
        if (e.button !== 0 || this.dragging) return;
        const cp = this.eventToCanvasPoint(e, el);
        if (!cp) return;

        // Check if clicking on a line segment
        const segIdx = this.hitTestLineSegment(cp, vpId);
        if (segIdx >= 0) {
          const worldPoint = vp.canvasToWorld(cp as cornerstone.Types.Point2);
          if (worldPoint) {
            // Insert a new control point between segIdx and segIdx+1
            this.controlPoints.splice(segIdx + 1, 0, {
              x: worldPoint[0], y: worldPoint[1], z: worldPoint[2],
            });
            this.redrawAll();
            this.onPointsChanged?.(this.getPoints());
          }
        }
      };

      el.addEventListener('mousedown', mouseDownHandler);
      el.addEventListener('mousemove', mouseMoveHandler);
      document.addEventListener('mouseup', mouseUpHandler);
      el.addEventListener('click', clickHandler);

      this.overlays.push({
        viewportId: vpId,
        canvas,
        ctx,
        resizeObserver,
        cameraHandler,
        mouseDownHandler,
        mouseMoveHandler,
        mouseUpHandler,
        clickHandler,
      });
    }
  }

  /** Remove all overlays and event listeners */
  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;

    const engine = cornerstone.getRenderingEngine(this.renderingEngineId);

    for (const overlay of this.overlays) {
      const vp = engine?.getViewport(overlay.viewportId);
      const el = vp?.element;

      if (el) {
        el.removeEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, overlay.cameraHandler as EventListener);
        el.removeEventListener('mousedown', overlay.mouseDownHandler);
        el.removeEventListener('mousemove', overlay.mouseMoveHandler);
        el.removeEventListener('click', overlay.clickHandler);
      }
      document.removeEventListener('mouseup', overlay.mouseUpHandler);
      overlay.resizeObserver.disconnect();

      if (overlay.canvas.parentElement) {
        overlay.canvas.parentElement.removeChild(overlay.canvas);
      }
    }
    this.overlays = [];
    this.dragging = false;
    this.dragIndex = -1;
    this.hoverIndex = -1;
  }

  /** Set control points programmatically */
  setPoints(points: TAVIVector3D[]): void {
    this.controlPoints = points.map(p => ({ ...p }));
    this.redrawAll();
  }

  /** Get current control points */
  getPoints(): TAVIVector3D[] {
    return this.controlPoints.map(p => ({ ...p }));
  }

  /** Remove a control point by index */
  removePoint(index: number): void {
    if (index >= 0 && index < this.controlPoints.length) {
      this.controlPoints.splice(index, 1);
      this.redrawAll();
      this.onPointsChanged?.(this.getPoints());
    }
  }

  /** Compute the centerline direction at a given point (tangent) */
  getDirectionAtPoint(index: number): TAVIVector3D | null {
    if (this.controlPoints.length < 2) return null;
    const pts = this.controlPoints;

    let tangent: TAVIVector3D;
    if (index === 0) {
      tangent = TAVIGeometry.vectorSubtract(pts[1], pts[0]);
    } else if (index >= pts.length - 1) {
      tangent = TAVIGeometry.vectorSubtract(pts[pts.length - 1], pts[pts.length - 2]);
    } else {
      tangent = TAVIGeometry.vectorSubtract(pts[index + 1], pts[index - 1]);
    }
    return TAVIGeometry.vectorNormalize(tangent);
  }

  /** Get the total length of the centerline in mm */
  getTotalLength(): number {
    let len = 0;
    for (let i = 1; i < this.controlPoints.length; i++) {
      len += TAVIGeometry.vectorDistance(this.controlPoints[i - 1], this.controlPoints[i]);
    }
    return len;
  }

  /** Get the cumulative length to a given point index */
  getLengthToPoint(index: number): number {
    let len = 0;
    for (let i = 1; i <= Math.min(index, this.controlPoints.length - 1); i++) {
      len += TAVIGeometry.vectorDistance(this.controlPoints[i - 1], this.controlPoints[i]);
    }
    return len;
  }

  // ── Private helpers ──

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

  private hitTestPoint(canvasPoint: [number, number], viewportId: string): number {
    for (let i = 0; i < this.controlPoints.length; i++) {
      const cp = this.worldToCanvas(this.controlPoints[i], viewportId);
      if (!cp) continue;
      const dx = cp[0] - canvasPoint[0];
      const dy = cp[1] - canvasPoint[1];
      if (dx * dx + dy * dy <= HIT_RADIUS * HIT_RADIUS) {
        return i;
      }
    }
    return -1;
  }

  /** Find which line segment the point is near (returns segment start index, or -1) */
  private hitTestLineSegment(canvasPoint: [number, number], viewportId: string): number {
    for (let i = 0; i < this.controlPoints.length - 1; i++) {
      const a = this.worldToCanvas(this.controlPoints[i], viewportId);
      const b = this.worldToCanvas(this.controlPoints[i + 1], viewportId);
      if (!a || !b) continue;

      const dist = this.pointToSegmentDistance(canvasPoint, a, b);
      if (dist <= LINE_HIT_DISTANCE) {
        // Make sure we're not near a control point (avoid double-trigger)
        const distA = Math.hypot(canvasPoint[0] - a[0], canvasPoint[1] - a[1]);
        const distB = Math.hypot(canvasPoint[0] - b[0], canvasPoint[1] - b[1]);
        if (distA > HIT_RADIUS && distB > HIT_RADIUS) {
          return i;
        }
      }
    }
    return -1;
  }

  private pointToSegmentDistance(p: [number, number], a: [number, number], b: [number, number]): number {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);

    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const nearestX = a[0] + t * dx;
    const nearestY = a[1] + t * dy;
    return Math.hypot(p[0] - nearestX, p[1] - nearestY);
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

    if (this.controlPoints.length === 0) {
      ctx.restore();
      return;
    }

    // Project all points to canvas coordinates for this viewport
    const canvasPoints = this.controlPoints.map(p => this.worldToCanvas(p, viewportId));

    // Draw connecting line
    if (canvasPoints.length >= 2) {
      ctx.beginPath();
      ctx.strokeStyle = LINE_COLOR;
      ctx.lineWidth = LINE_WIDTH;
      ctx.setLineDash([]);

      let started = false;
      for (const cp of canvasPoints) {
        if (!cp) continue;
        if (!started) {
          ctx.moveTo(cp[0], cp[1]);
          started = true;
        } else {
          ctx.lineTo(cp[0], cp[1]);
        }
      }
      ctx.stroke();
    }

    // Draw control points
    for (let i = 0; i < canvasPoints.length; i++) {
      const cp = canvasPoints[i];
      if (!cp) continue;

      const isHovered = i === this.hoverIndex && viewportId === this.hoverViewportId;
      const isDragged = i === this.dragIndex && this.dragging;
      const radius = isHovered || isDragged ? POINT_RADIUS + 2 : POINT_RADIUS;
      const color = isDragged ? POINT_COLOR_DRAG : isHovered ? POINT_COLOR_HOVER : POINT_COLOR;

      // Outer glow
      ctx.beginPath();
      ctx.arc(cp[0], cp[1], radius + 2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(212, 196, 40, 0.3)';
      ctx.fill();

      // Filled circle
      ctx.beginPath();
      ctx.arc(cp[0], cp[1], radius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.stroke();
    }

    // Draw "Click to add control point" hint at bottom if few points
    if (this.controlPoints.length < 3) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.fillRect(0, h - 24, w, 24);
      ctx.fillStyle = '#d4c428';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Click the centerline to add a control point.', w / 2, h - 12);
    }

    ctx.restore();
  }
}
