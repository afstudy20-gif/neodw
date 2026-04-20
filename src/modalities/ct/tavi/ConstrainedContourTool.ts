import * as cornerstone from '@cornerstonejs/core';
import { TAVIVector3D } from './TAVITypes';
import { TAVIGeometry } from './TAVIGeometry';

/**
 * ConstrainedContourTool: plane-locked point placement for annulus tracing.
 *
 * - Click in the working viewport → canvasToWorld → project onto annulus plane → store point
 * - Points are rendered as a polygon overlay on a canvas element
 * - After closing the contour, individual points can be dragged to fine-tune
 * - Dragged points are re-projected onto the annulus plane
 * - Canvas overlay redraws on CAMERA_MODIFIED events
 */

const POINT_RADIUS = 5;
const POINT_COLOR = '#58a6ff';
const POINT_COLOR_ACTIVE = '#f0883e';
const LINE_COLOR = 'rgba(88, 166, 255, 0.8)';
const LINE_COLOR_CLOSED = 'rgba(88, 166, 255, 0.95)';
const DRAG_THRESHOLD_PX = 8;

export class ConstrainedContourTool {
  private viewport: cornerstone.Types.IViewport;
  private planeNormal: TAVIVector3D;
  private planeCentroid: TAVIVector3D;
  private points: TAVIVector3D[] = [];
  private closed = false;
  private enabled = false;

  // Canvas overlay
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  // Drag state
  private dragging = false;
  private dragIndex = -1;
  private dragStartCanvas: [number, number] = [0, 0];

  // Event handler references
  private clickHandler: ((e: MouseEvent) => void) | null = null;
  private mouseDownHandler: ((e: MouseEvent) => void) | null = null;
  private mouseMoveHandler: ((e: MouseEvent) => void) | null = null;
  private mouseUpHandler: ((e: MouseEvent) => void) | null = null;
  private cameraModifiedHandler: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;

  // Hover state for visual feedback
  private hoverIndex = -1;

  constructor(
    viewport: cornerstone.Types.IViewport,
    planeNormal: TAVIVector3D,
    planeCentroid: TAVIVector3D
  ) {
    this.viewport = viewport;
    this.planeNormal = TAVIGeometry.vectorNormalize(planeNormal);
    this.planeCentroid = { ...planeCentroid };
  }

  /** Start accepting clicks and rendering the overlay */
  enable(): void {
    if (this.enabled) return;
    this.enabled = true;

    const el = this.viewport.element;
    if (!el) return;

    // Create canvas overlay
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 50;
    `;
    el.style.position = 'relative';
    el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.syncCanvasSize();

    // Resize observer to keep canvas in sync
    this.resizeObserver = new ResizeObserver(() => this.syncCanvasSize());
    this.resizeObserver.observe(el);

    // Click handler for placing points (only when not closed)
    this.clickHandler = (e: MouseEvent) => {
      if (this.closed || this.dragging) return;
      if (e.button !== 0) return; // left click only

      const canvasPoint = this.eventToCanvasPoint(e);
      if (!canvasPoint) return;

      const worldPoint = this.viewport.canvasToWorld(canvasPoint as cornerstone.Types.Point2);
      if (!worldPoint) return;

      // Project onto annulus plane
      const projected = TAVIGeometry.projectPointOntoPlane(
        { x: worldPoint[0], y: worldPoint[1], z: worldPoint[2] },
        this.planeCentroid,
        this.planeNormal
      );

      this.points.push(projected);
      this.redraw();
    };

    // Mouse handlers for drag mode (only when closed)
    this.mouseDownHandler = (e: MouseEvent) => {
      if (!this.closed || e.button !== 0) return;

      const canvasPoint = this.eventToCanvasPoint(e);
      if (!canvasPoint) return;

      const hitIdx = this.hitTestPoint(canvasPoint);
      if (hitIdx >= 0) {
        this.dragging = true;
        this.dragIndex = hitIdx;
        this.dragStartCanvas = canvasPoint;
        e.preventDefault();
        e.stopPropagation();
      }
    };

    this.mouseMoveHandler = (e: MouseEvent) => {
      const canvasPoint = this.eventToCanvasPoint(e);
      if (!canvasPoint) return;

      if (this.dragging && this.dragIndex >= 0) {
        // Drag the point
        const worldPoint = this.viewport.canvasToWorld(canvasPoint as cornerstone.Types.Point2);
        if (!worldPoint) return;

        const projected = TAVIGeometry.projectPointOntoPlane(
          { x: worldPoint[0], y: worldPoint[1], z: worldPoint[2] },
          this.planeCentroid,
          this.planeNormal
        );
        this.points[this.dragIndex] = projected;
        this.redraw();
        e.preventDefault();
        e.stopPropagation();
      } else if (this.closed) {
        // Hover detection for cursor feedback
        const newHover = this.hitTestPoint(canvasPoint);
        if (newHover !== this.hoverIndex) {
          this.hoverIndex = newHover;
          this.redraw();
          // Change cursor
          if (this.canvas) {
            this.canvas.style.cursor = newHover >= 0 ? 'grab' : 'default';
          }
        }
      }
    };

    this.mouseUpHandler = (_e: MouseEvent) => {
      if (this.dragging) {
        this.dragging = false;
        this.dragIndex = -1;
      }
    };

    // Camera change handler — redraw overlay when view changes
    this.cameraModifiedHandler = () => {
      this.redraw();
    };

    // Attach click handler to the viewport element (needs pointer-events)
    // We use the viewport element itself, not the canvas overlay
    el.addEventListener('click', this.clickHandler);
    el.addEventListener('mousedown', this.mouseDownHandler);
    el.addEventListener('mousemove', this.mouseMoveHandler);
    el.addEventListener('mouseup', this.mouseUpHandler);

    // Listen for camera changes
    el.addEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, this.cameraModifiedHandler as EventListener);

    this.redraw();
  }

  /** Stop accepting input and remove the overlay */
  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;

    const el = this.viewport.element;
    if (el) {
      if (this.clickHandler) el.removeEventListener('click', this.clickHandler);
      if (this.mouseDownHandler) el.removeEventListener('mousedown', this.mouseDownHandler);
      if (this.mouseMoveHandler) el.removeEventListener('mousemove', this.mouseMoveHandler);
      if (this.mouseUpHandler) el.removeEventListener('mouseup', this.mouseUpHandler);
      if (this.cameraModifiedHandler) {
        el.removeEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, this.cameraModifiedHandler as EventListener);
      }
    }

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    if (this.canvas?.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }
    this.canvas = null;
    this.ctx = null;

    this.clickHandler = null;
    this.mouseDownHandler = null;
    this.mouseMoveHandler = null;
    this.mouseUpHandler = null;
    this.cameraModifiedHandler = null;
  }

  /** Get all placed world points */
  getWorldPoints(): TAVIVector3D[] {
    return [...this.points];
  }

  /** Get the number of placed points */
  getPointCount(): number {
    return this.points.length;
  }

  /** Whether the contour has been closed */
  isClosed(): boolean {
    return this.closed;
  }

  /** Close the contour (connect last point to first) */
  closeContour(): void {
    if (this.points.length < 3) return;
    this.closed = true;

    // Enable pointer events on canvas for drag mode
    if (this.canvas) {
      this.canvas.style.pointerEvents = 'auto';
    }

    this.redraw();
  }

  /** Remove the last placed point */
  undoLastPoint(): void {
    if (this.closed || this.points.length === 0) return;
    this.points.pop();
    this.redraw();
  }

  /** Load existing world points and set contour as closed (for editing) */
  loadPoints(points: TAVIVector3D[]): void {
    this.points = points.map(p => ({ ...p }));
    this.closed = true;
    this.hoverIndex = -1;
    this.dragIndex = -1;
    this.dragging = false;

    if (this.canvas) {
      this.canvas.style.pointerEvents = 'auto';
    }

    this.redraw();
  }

  /** Clear all points and reopen */
  clearPoints(): void {
    this.points = [];
    this.closed = false;
    this.hoverIndex = -1;
    this.dragIndex = -1;
    this.dragging = false;

    if (this.canvas) {
      this.canvas.style.pointerEvents = 'none';
      this.canvas.style.cursor = 'default';
    }

    this.redraw();
  }

  // ── Private helpers ──

  private syncCanvasSize(): void {
    if (!this.canvas) return;
    const el = this.viewport.element;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.ctx?.scale(dpr, dpr);
    this.redraw();
  }

  private eventToCanvasPoint(e: MouseEvent): [number, number] | null {
    const el = this.viewport.element;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  private hitTestPoint(canvasPoint: [number, number]): number {
    const hitRadius = POINT_RADIUS + 4;
    for (let i = 0; i < this.points.length; i++) {
      const cp = this.worldToCanvasPoint(this.points[i]);
      if (!cp) continue;
      const dx = cp[0] - canvasPoint[0];
      const dy = cp[1] - canvasPoint[1];
      if (dx * dx + dy * dy <= hitRadius * hitRadius) {
        return i;
      }
    }
    return -1;
  }

  private worldToCanvasPoint(worldPoint: TAVIVector3D): [number, number] | null {
    const result = this.viewport.worldToCanvas([worldPoint.x, worldPoint.y, worldPoint.z]);
    if (!result) return null;
    return [result[0], result[1]];
  }

  /** Redraw the entire contour overlay */
  private redraw(): void {
    const ctx = this.ctx;
    if (!ctx || !this.canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (this.points.length === 0) {
      ctx.restore();
      return;
    }

    // Project all points to canvas coordinates
    const canvasPoints: ([number, number] | null)[] = this.points.map(p => this.worldToCanvasPoint(p));

    // Draw connecting lines
    ctx.beginPath();
    ctx.strokeStyle = this.closed ? LINE_COLOR_CLOSED : LINE_COLOR;
    ctx.lineWidth = 2;
    ctx.setLineDash(this.closed ? [] : [6, 4]);

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

    if (this.closed && canvasPoints.length > 0 && canvasPoints[0]) {
      ctx.closePath();
    }
    ctx.stroke();

    // Draw points
    for (let i = 0; i < canvasPoints.length; i++) {
      const cp = canvasPoints[i];
      if (!cp) continue;

      const isHovered = i === this.hoverIndex;
      const isDragged = i === this.dragIndex && this.dragging;
      const radius = isHovered || isDragged ? POINT_RADIUS + 2 : POINT_RADIUS;
      const color = isHovered || isDragged ? POINT_COLOR_ACTIVE : POINT_COLOR;

      ctx.beginPath();
      ctx.arc(cp[0], cp[1], radius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.stroke();

      // Draw point number
      ctx.fillStyle = '#fff';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), cp[0], cp[1]);
    }

    ctx.restore();
  }
}
