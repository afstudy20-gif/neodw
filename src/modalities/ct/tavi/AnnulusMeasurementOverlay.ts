import * as cornerstone from '@cornerstonejs/core';
import { TAVIVector3D, TAVIGeometryResult } from './TAVITypes';
import { TAVIGeometry } from './TAVIGeometry';

/**
 * AnnulusMeasurementOverlay: renders measurement annotations on the perpendicular
 * plane viewport (3mensio-style).
 *
 * Features:
 * - White circle/ellipse boundary fitted to the annulus contour
 * - Cusp labels (RC, NC, LC) at their projected positions
 * - Min/max diameter lines with annotations (mm)
 * - Area and perimeter text
 * - Ruler tool for custom length measurements
 * - CAMERA_MODIFIED triggers redraw
 */

const BOUNDARY_COLOR = 'rgba(255, 255, 255, 0.7)';
const BOUNDARY_WIDTH = 1.5;
const DIAMETER_COLOR_MIN = '#58a6ff';
const DIAMETER_COLOR_MAX = '#f0883e';
const RULER_COLOR = '#fff';
const TEXT_BG = 'rgba(0, 0, 0, 0.6)';
const CUSP_COLORS: Record<string, string> = {
  RC: '#22c55e',
  NC: '#eab308',
  LC: '#ef4444',
};

interface RulerMeasurement {
  start: TAVIVector3D;
  end: TAVIVector3D;
  label?: string;
  lengthMm: number;
}

export class AnnulusMeasurementOverlay {
  private renderingEngineId: string;
  private viewportId: string;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private cameraHandler: (() => void) | null = null;
  private enabled = false;

  // Annulus data
  private contourPoints: TAVIVector3D[] = [];
  private geometry: TAVIGeometryResult | null = null;
  private cuspPositions: { id: string; point: TAVIVector3D }[] = [];

  // Ruler measurements
  private rulers: RulerMeasurement[] = [];
  private activeRuler: { start: TAVIVector3D; endCanvas: [number, number] } | null = null;

  // Ruler tool state
  private rulerMode = false;
  private clickHandler: ((e: MouseEvent) => void) | null = null;
  private mouseMoveHandler: ((e: MouseEvent) => void) | null = null;

  constructor(renderingEngineId: string, viewportId: string) {
    this.renderingEngineId = renderingEngineId;
    this.viewportId = viewportId;
  }

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;

    const engine = cornerstone.getRenderingEngine(this.renderingEngineId);
    if (!engine) return;
    const vp = engine.getViewport(this.viewportId);
    if (!vp?.element) return;

    const el = vp.element;
    el.style.position = 'relative';

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'tavi-measurement-canvas';
    this.canvas.style.cssText = `
      position: absolute;
      top: 0; left: 0;
      width: 100%; height: 100%;
      pointer-events: none;
      z-index: 53;
    `;
    el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    const syncSize = () => {
      if (!this.canvas) return;
      const rect = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = rect.width * dpr;
      this.canvas.height = rect.height * dpr;
      this.canvas.style.width = `${rect.width}px`;
      this.canvas.style.height = `${rect.height}px`;
      this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.redraw();
    };

    this.resizeObserver = new ResizeObserver(syncSize);
    this.resizeObserver.observe(el);
    syncSize();

    this.cameraHandler = () => this.redraw();
    el.addEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, this.cameraHandler as EventListener);

    // Ruler click handler
    this.clickHandler = (e: MouseEvent) => {
      if (!this.rulerMode || e.button !== 0) return;
      const cp = this.eventToCanvasPoint(e, el);
      if (!cp) return;

      const worldPoint = vp.canvasToWorld(cp as cornerstone.Types.Point2);
      if (!worldPoint) return;

      const wp: TAVIVector3D = { x: worldPoint[0], y: worldPoint[1], z: worldPoint[2] };

      if (!this.activeRuler) {
        // Start ruler
        this.activeRuler = { start: wp, endCanvas: cp };
      } else {
        // Finish ruler
        const lengthMm = TAVIGeometry.vectorDistance(this.activeRuler.start, wp);
        this.rulers.push({
          start: this.activeRuler.start,
          end: wp,
          lengthMm,
        });
        this.activeRuler = null;
        this.redraw();
      }
    };

    this.mouseMoveHandler = (e: MouseEvent) => {
      if (!this.rulerMode || !this.activeRuler) return;
      const cp = this.eventToCanvasPoint(e, el);
      if (cp) {
        this.activeRuler.endCanvas = cp;
        this.redraw();
      }
    };

    el.addEventListener('click', this.clickHandler);
    el.addEventListener('mousemove', this.mouseMoveHandler);
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;

    const engine = cornerstone.getRenderingEngine(this.renderingEngineId);
    const vp = engine?.getViewport(this.viewportId);
    const el = vp?.element;

    if (el) {
      if (this.cameraHandler) {
        el.removeEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, this.cameraHandler as EventListener);
      }
      if (this.clickHandler) el.removeEventListener('click', this.clickHandler);
      if (this.mouseMoveHandler) el.removeEventListener('mousemove', this.mouseMoveHandler);
    }

    this.resizeObserver?.disconnect();
    if (this.canvas?.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }
    this.canvas = null;
    this.ctx = null;
  }

  /** Set the annulus contour and geometry for rendering */
  setAnnulusData(contourPoints: TAVIVector3D[], geometry: TAVIGeometryResult): void {
    this.contourPoints = contourPoints;
    this.geometry = geometry;
    this.redraw();
  }

  /** Set cusp positions for labeling */
  setCuspPositions(cusps: { id: string; point: TAVIVector3D }[]): void {
    this.cuspPositions = cusps;
    this.redraw();
  }

  /** Toggle ruler measurement mode */
  setRulerMode(enabled: boolean): void {
    this.rulerMode = enabled;
    if (this.canvas) {
      this.canvas.style.pointerEvents = enabled ? 'auto' : 'none';
      this.canvas.style.cursor = enabled ? 'crosshair' : 'default';
    }
    if (!enabled) {
      this.activeRuler = null;
    }
  }

  /** Clear all ruler measurements */
  clearRulers(): void {
    this.rulers = [];
    this.activeRuler = null;
    this.redraw();
  }

  /** Get all ruler measurements */
  getRulers(): RulerMeasurement[] {
    return [...this.rulers];
  }

  /** Assign a label to the last ruler */
  labelLastRuler(label: string): void {
    if (this.rulers.length > 0) {
      this.rulers[this.rulers.length - 1].label = label;
      this.redraw();
    }
  }

  // ── Private ──

  private eventToCanvasPoint(e: MouseEvent, el: HTMLElement): [number, number] | null {
    const rect = el.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  private worldToCanvas(point: TAVIVector3D): [number, number] | null {
    const engine = cornerstone.getRenderingEngine(this.renderingEngineId);
    if (!engine) return null;
    const vp = engine.getViewport(this.viewportId);
    if (!vp) return null;
    const result = vp.worldToCanvas([point.x, point.y, point.z]);
    if (!result) return null;
    return [result[0], result[1]];
  }

  private redraw(): void {
    const ctx = this.ctx;
    if (!ctx || !this.canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Draw contour boundary (white circle/polygon)
    this.drawContourBoundary(ctx);

    // Draw min/max diameter lines
    this.drawDiameters(ctx);

    // Draw cusp labels
    this.drawCuspLabels(ctx);

    // Draw geometry text (area, perimeter, diameters)
    this.drawGeometryText(ctx, w, h);

    // Draw ruler measurements
    this.drawRulers(ctx);

    // Draw active ruler (in progress)
    this.drawActiveRuler(ctx);

    ctx.restore();
  }

  private drawContourBoundary(ctx: CanvasRenderingContext2D): void {
    if (this.contourPoints.length < 3) return;

    const canvasPoints = this.contourPoints.map(p => this.worldToCanvas(p));
    const valid = canvasPoints.filter((p): p is [number, number] => p !== null);
    if (valid.length < 3) return;

    ctx.beginPath();
    ctx.strokeStyle = BOUNDARY_COLOR;
    ctx.lineWidth = BOUNDARY_WIDTH;
    ctx.setLineDash([]);

    ctx.moveTo(valid[0][0], valid[0][1]);
    for (let i = 1; i < valid.length; i++) {
      ctx.lineTo(valid[i][0], valid[i][1]);
    }
    ctx.closePath();
    ctx.stroke();
  }

  private drawDiameters(ctx: CanvasRenderingContext2D): void {
    if (!this.geometry) return;

    const centroid = this.geometry.centroid;
    const major = this.geometry.majorAxisDirection;
    const minor = this.geometry.minorAxisDirection;
    const maxR = this.geometry.maximumDiameterMm / 2;
    const minR = this.geometry.minimumDiameterMm / 2;

    // Max diameter line (along major axis)
    const maxStart = TAVIGeometry.vectorAdd(centroid, TAVIGeometry.vectorScale(major, -maxR));
    const maxEnd = TAVIGeometry.vectorAdd(centroid, TAVIGeometry.vectorScale(major, maxR));
    this.drawDiameterLine(ctx, maxStart, maxEnd, this.geometry.maximumDiameterMm, DIAMETER_COLOR_MAX, 'max');

    // Min diameter line (along minor axis)
    const minStart = TAVIGeometry.vectorAdd(centroid, TAVIGeometry.vectorScale(minor, -minR));
    const minEnd = TAVIGeometry.vectorAdd(centroid, TAVIGeometry.vectorScale(minor, minR));
    this.drawDiameterLine(ctx, minStart, minEnd, this.geometry.minimumDiameterMm, DIAMETER_COLOR_MIN, 'min');
  }

  private drawDiameterLine(
    ctx: CanvasRenderingContext2D,
    start: TAVIVector3D,
    end: TAVIVector3D,
    lengthMm: number,
    color: string,
    _label: string
  ): void {
    const cpStart = this.worldToCanvas(start);
    const cpEnd = this.worldToCanvas(end);
    if (!cpStart || !cpEnd) return;

    // Line
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.moveTo(cpStart[0], cpStart[1]);
    ctx.lineTo(cpEnd[0], cpEnd[1]);
    ctx.stroke();

    // Endpoints
    for (const cp of [cpStart, cpEnd]) {
      ctx.beginPath();
      ctx.arc(cp[0], cp[1], 3, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }

    // Label at midpoint
    const midX = (cpStart[0] + cpEnd[0]) / 2;
    const midY = (cpStart[1] + cpEnd[1]) / 2;
    const text = `\u00D8 ${lengthMm.toFixed(1)} mm`;

    ctx.font = 'bold 12px sans-serif';
    const textWidth = ctx.measureText(text).width;

    ctx.fillStyle = TEXT_BG;
    ctx.fillRect(midX - textWidth / 2 - 4, midY - 8, textWidth + 8, 16);
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, midX, midY);
  }

  private drawCuspLabels(ctx: CanvasRenderingContext2D): void {
    for (const cusp of this.cuspPositions) {
      const cp = this.worldToCanvas(cusp.point);
      if (!cp) continue;

      const color = CUSP_COLORS[cusp.id] || '#fff';

      // Small dot
      ctx.beginPath();
      ctx.arc(cp[0], cp[1], 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Label
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 3;
      ctx.strokeText(cusp.id, cp[0], cp[1] - 8);
      ctx.fillStyle = color;
      ctx.fillText(cusp.id, cp[0], cp[1] - 8);
    }
  }

  private drawGeometryText(ctx: CanvasRenderingContext2D, w: number, _h: number): void {
    if (!this.geometry) return;

    const g = this.geometry;
    const eqDPerimeter = g.perimeterMm / Math.PI;
    const eqDArea = 2 * Math.sqrt(g.areaMm2 / Math.PI);

    const lines = [
      `Perimeter: ${g.perimeterMm.toFixed(1)} mm (equiv. \u00D8 ${eqDPerimeter.toFixed(1)} mm)`,
      `Area: ${g.areaMm2.toFixed(1)} mm\u00B2 (equiv. \u00D8 ${eqDArea.toFixed(1)} mm)`,
      `Min: ${g.minimumDiameterMm.toFixed(1)} mm | Max: ${g.maximumDiameterMm.toFixed(1)} mm`,
    ];

    ctx.font = '11px sans-serif';
    const lineHeight = 16;
    const padding = 6;
    const boxH = lines.length * lineHeight + padding * 2;
    const boxW = 280;
    const boxX = w - boxW - 8;
    const boxY = 8;

    ctx.fillStyle = TEXT_BG;
    ctx.fillRect(boxX, boxY, boxW, boxH);

    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], boxX + padding, boxY + padding + i * lineHeight);
    }
  }

  private drawRulers(ctx: CanvasRenderingContext2D): void {
    for (const ruler of this.rulers) {
      const cpStart = this.worldToCanvas(ruler.start);
      const cpEnd = this.worldToCanvas(ruler.end);
      if (!cpStart || !cpEnd) continue;

      // Line
      ctx.beginPath();
      ctx.strokeStyle = RULER_COLOR;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.moveTo(cpStart[0], cpStart[1]);
      ctx.lineTo(cpEnd[0], cpEnd[1]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Endpoints
      for (const cp of [cpStart, cpEnd]) {
        ctx.beginPath();
        ctx.arc(cp[0], cp[1], 3, 0, Math.PI * 2);
        ctx.fillStyle = RULER_COLOR;
        ctx.fill();
      }

      // Label
      const midX = (cpStart[0] + cpEnd[0]) / 2;
      const midY = (cpStart[1] + cpEnd[1]) / 2;
      const text = ruler.label
        ? `${ruler.label}: ${ruler.lengthMm.toFixed(1)} mm`
        : `${ruler.lengthMm.toFixed(1)} mm`;

      ctx.font = '11px sans-serif';
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = TEXT_BG;
      ctx.fillRect(midX - tw / 2 - 3, midY - 18, tw + 6, 16);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, midX, midY - 10);
    }
  }

  private drawActiveRuler(ctx: CanvasRenderingContext2D): void {
    if (!this.activeRuler) return;

    const cpStart = this.worldToCanvas(this.activeRuler.start);
    if (!cpStart) return;

    const cpEnd = this.activeRuler.endCanvas;

    ctx.beginPath();
    ctx.strokeStyle = RULER_COLOR;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.moveTo(cpStart[0], cpStart[1]);
    ctx.lineTo(cpEnd[0], cpEnd[1]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Start endpoint
    ctx.beginPath();
    ctx.arc(cpStart[0], cpStart[1], 3, 0, Math.PI * 2);
    ctx.fillStyle = RULER_COLOR;
    ctx.fill();
  }
}
