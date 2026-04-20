import type { Point2D, WorldPoint, QCASession } from './QCATypes';

const YELLOW = '#ffdd00';
const YELLOW_ALPHA = 'rgba(255, 221, 0, 0.6)';
const PINK = '#ff5c8a';
const GREEN = '#4ec49a';
const WHITE = 'rgba(255,255,255,0.85)';
const MARKER_RADIUS = 6;

/** Converts a world point to canvas (CSS pixel) coordinates. */
export type WorldToCanvasFn = (wp: WorldPoint) => Point2D | null;

/**
 * Render all QCA overlays on a canvas element overlaying the viewport.
 * All stored points are in world coordinates; w2c converts them to canvas space
 * so that the overlay follows pan/zoom automatically.
 */
export function renderQCAOverlay(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  session: QCASession,
  dpr: number,
  w2c: WorldToCanvasFn
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width * dpr, height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Calibration line
  if (session.calibration?.catheterLine) {
    const [wp1, wp2] = session.calibration.catheterLine;
    const p1 = w2c(wp1);
    const p2 = w2c(wp2);
    if (p1 && p2) {
      drawCalibrationLine(ctx, p1, p2, session.calibration.mmPerPixel, session.calibration.catheterPixelWidth);
    }
  }

  // Vessel contour
  if (session.contour) {
    const cl = projectAll(session.contour.centerline, w2c);
    const lb = projectAll(session.contour.leftBorder, w2c);
    const rb = projectAll(session.contour.rightBorder, w2c);

    if (lb.length > 1 && rb.length > 1) {
      drawContour(ctx, lb, rb);
    }

    // Centerline (thin dashed)
    if (cl.length > 1) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      drawPath(ctx, cl);
      ctx.setLineDash([]);
    }

    // Lesion highlight
    if (session.measurements && lb.length > 1) {
      const { lesionStartIndex, lesionEndIndex } = session.measurements;
      drawLesionHighlight(ctx, lb, rb, lesionStartIndex, lesionEndIndex);
    }

    // MLD marker
    if (session.measurements) {
      const mldIdx = session.measurements.mldIndex;
      if (mldIdx >= 0 && mldIdx < cl.length) {
        drawMarker(ctx, cl[mldIdx], WHITE, 'MLD');
      }
    }
  }

  // P and D markers
  if (session.proximalPoint) {
    const p = w2c(session.proximalPoint);
    if (p) drawMarker(ctx, p, YELLOW, 'P');
  }
  if (session.distalPoint) {
    const p = w2c(session.distalPoint);
    if (p) drawMarker(ctx, p, YELLOW, 'D');
  }

  // Centerline user guide points
  for (const wp of session.centerlinePoints) {
    const p = w2c(wp);
    if (!p) continue;
    ctx.fillStyle = 'rgba(121, 199, 255, 0.7)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Project an array of WorldPoints to canvas Point2D. Drops null projections. */
function projectAll(wps: WorldPoint[], w2c: WorldToCanvasFn): Point2D[] {
  const result: Point2D[] = [];
  for (const wp of wps) {
    const p = w2c(wp);
    if (p) result.push(p);
  }
  return result;
}

function drawCalibrationLine(ctx: CanvasRenderingContext2D, start: Point2D, end: Point2D, mmPerPixel: number, widthPx: number): void {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);

  // Edge-to-edge line
  ctx.strokeStyle = GREEN;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();

  // Edge circles
  for (const pt of [start, end]) {
    ctx.fillStyle = GREEN;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Perpendicular ticks
  if (len > 5) {
    const nx = -dy / len;
    const ny = dx / len;
    const tickLen = 14;
    ctx.strokeStyle = GREEN;
    ctx.lineWidth = 1.5;
    for (const pt of [start, end]) {
      ctx.beginPath();
      ctx.moveTo(pt.x + nx * tickLen, pt.y + ny * tickLen);
      ctx.lineTo(pt.x - nx * tickLen, pt.y - ny * tickLen);
      ctx.stroke();
    }
  }

  // Label
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  ctx.font = 'bold 12px ui-monospace, SFMono-Regular, Menlo, monospace';
  const label1 = `${mmPerPixel.toFixed(4)} mm/px`;
  const label2 = `(${widthPx.toFixed(0)} px detected)`;
  const tw = Math.max(ctx.measureText(label1).width, ctx.measureText(label2).width);

  ctx.fillStyle = 'rgba(4, 10, 16, 0.8)';
  ctx.fillRect(midX + 10, midY - 24, tw + 12, 34);
  ctx.fillStyle = GREEN;
  ctx.fillText(label1, midX + 16, midY - 8);
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = 'rgba(78, 196, 154, 0.7)';
  ctx.fillText(label2, midX + 16, midY + 4);
}

function drawContour(ctx: CanvasRenderingContext2D, left: Point2D[], right: Point2D[]): void {
  ctx.strokeStyle = YELLOW;
  ctx.lineWidth = 1.5;
  drawPath(ctx, left);
  drawPath(ctx, right);

  // Perpendicular ticks
  ctx.strokeStyle = YELLOW_ALPHA;
  ctx.lineWidth = 0.8;
  const step = Math.max(1, Math.floor(left.length / 20));
  for (let i = 0; i < left.length; i += step) {
    if (i < right.length) {
      ctx.beginPath();
      ctx.moveTo(left[i].x, left[i].y);
      ctx.lineTo(right[i].x, right[i].y);
      ctx.stroke();
    }
  }
}

function drawPath(ctx: CanvasRenderingContext2D, points: Point2D[]): void {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();
}

function drawLesionHighlight(ctx: CanvasRenderingContext2D, left: Point2D[], right: Point2D[], startIdx: number, endIdx: number): void {
  if (startIdx >= endIdx || startIdx >= left.length) return;
  const end = Math.min(endIdx, left.length - 1, right.length - 1);
  ctx.fillStyle = 'rgba(255, 107, 107, 0.15)';
  ctx.beginPath();
  ctx.moveTo(left[startIdx].x, left[startIdx].y);
  for (let i = startIdx; i <= end; i++) ctx.lineTo(left[i].x, left[i].y);
  for (let i = end; i >= startIdx; i--) ctx.lineTo(right[i].x, right[i].y);
  ctx.closePath();
  ctx.fill();
}

function drawMarker(ctx: CanvasRenderingContext2D, point: Point2D, color: string, label: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(point.x, point.y, MARKER_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.font = 'bold 14px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = color;
  ctx.textBaseline = 'bottom';
  ctx.fillText(label, point.x + MARKER_RADIUS + 4, point.y - MARKER_RADIUS);
  ctx.textBaseline = 'alphabetic';
}
