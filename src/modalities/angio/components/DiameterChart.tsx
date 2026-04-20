import { useEffect, useRef, useCallback } from 'react';
import type { VesselContour, QCAMeasurements, FFRResult } from '../qca/QCATypes';

interface Props {
  contour: VesselContour;
  referenceDiameters: number[];
  measurements: QCAMeasurements;
  ffrResult: FFRResult | null;
  chartMode: 'diameter' | 'area';
  lesionStartIdx?: number | null;
  lesionEndIdx?: number | null;
  onLesionBoundsChange?: (startIdx: number, endIdx: number) => void;
}

const PADDING = { top: 24, right: 50, bottom: 32, left: 40 };
const YELLOW = '#ffdd00';
const PINK = '#ff5c8a';
const WHITE = 'rgba(255,255,255,0.5)';
const GRID = 'rgba(255,255,255,0.08)';
const BG = '#0a1018';

export function DiameterChart({ contour, referenceDiameters, measurements, ffrResult, chartMode, lesionStartIdx, lesionEndIdx, onLesionBoundsChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const dragRef = useRef<'start' | 'end' | null>(null);
  const effectiveLesionStart = lesionStartIdx ?? measurements.lesionStartIndex;
  const effectiveLesionEnd = lesionEndIdx ?? measurements.lesionEndIndex;

  // Convert contour index to X pixel position on chart
  const indexToX = useCallback((idx: number, chartW: number): number => {
    const { cumulativeLength } = contour;
    const n = cumulativeLength.length;
    if (n < 2) return PADDING.left;
    const totalLen = cumulativeLength[n - 1];
    const dist = cumulativeLength[Math.min(idx, n - 1)] ?? 0;
    return PADDING.left + (dist / totalLen) * (chartW - PADDING.left - PADDING.right);
  }, [contour]);

  // Convert X pixel position to nearest contour index
  const xToIndex = useCallback((x: number, chartW: number): number => {
    const { cumulativeLength } = contour;
    const n = cumulativeLength.length;
    if (n < 2) return 0;
    const totalLen = cumulativeLength[n - 1];
    const dist = ((x - PADDING.left) / (chartW - PADDING.left - PADDING.right)) * totalLen;
    let bestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < n; i++) {
      const diff = Math.abs(cumulativeLength[i] - dist);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    }
    return bestIdx;
  }, [contour]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const hasFfr = ffrResult != null;
    const totalH = hasFfr ? 320 : 180;
    canvas.width = w * dpr;
    canvas.height = totalH * dpr;
    canvas.style.height = `${totalH}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // ── Upper chart: Diameter or Area ──
    const chartH = hasFfr ? 140 : 150;
    drawDiameterArea(ctx, w, chartH, 0, contour, referenceDiameters, measurements, chartMode);

    // ── Draw draggable lesion boundary lines ──
    const startX = indexToX(effectiveLesionStart, w);
    const endX = indexToX(effectiveLesionEnd, w);

    // Lesion region fill
    ctx.fillStyle = 'rgba(255, 107, 107, 0.12)';
    ctx.fillRect(startX, PADDING.top, endX - startX, chartH - PADDING.top - PADDING.bottom);

    // Start line (draggable)
    ctx.strokeStyle = '#ff6b6b';
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(startX, PADDING.top);
    ctx.lineTo(startX, chartH - PADDING.bottom);
    ctx.stroke();
    // Triangle handle at top
    ctx.fillStyle = '#ff6b6b';
    ctx.beginPath();
    ctx.moveTo(startX - 5, PADDING.top);
    ctx.lineTo(startX + 5, PADDING.top);
    ctx.lineTo(startX, PADDING.top + 8);
    ctx.closePath();
    ctx.fill();

    // End line (draggable)
    ctx.beginPath();
    ctx.moveTo(endX, PADDING.top);
    ctx.lineTo(endX, chartH - PADDING.bottom);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(endX - 5, PADDING.top);
    ctx.lineTo(endX + 5, PADDING.top);
    ctx.lineTo(endX, PADDING.top + 8);
    ctx.closePath();
    ctx.fill();

    // ── Lower chart: vFFR ──
    if (hasFfr && ffrResult) {
      const ffrTop = chartH + 30;
      const ffrH = totalH - ffrTop - 10;
      drawFFRChart(ctx, w, ffrH, ffrTop, contour.cumulativeLength, ffrResult);
    }
  }, [contour, referenceDiameters, measurements, ffrResult, chartMode, effectiveLesionStart, effectiveLesionEnd, indexToX]);

  // Mouse handlers for dragging lesion boundary lines
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !onLesionBoundsChange) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const w = rect.width;

    const startX = indexToX(effectiveLesionStart, w);
    const endX = indexToX(effectiveLesionEnd, w);

    if (Math.abs(x - startX) < 10) {
      dragRef.current = 'start';
      canvas.style.cursor = 'col-resize';
    } else if (Math.abs(x - endX) < 10) {
      dragRef.current = 'end';
      canvas.style.cursor = 'col-resize';
    }
  }, [indexToX, effectiveLesionStart, effectiveLesionEnd, onLesionBoundsChange]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const w = rect.width;

    if (dragRef.current && onLesionBoundsChange) {
      const idx = xToIndex(x, w);
      if (dragRef.current === 'start') {
        onLesionBoundsChange(Math.min(idx, effectiveLesionEnd - 1), effectiveLesionEnd);
      } else {
        onLesionBoundsChange(effectiveLesionStart, Math.max(idx, effectiveLesionStart + 1));
      }
      return;
    }

    // Show col-resize cursor when hovering near a boundary line
    const startX = indexToX(effectiveLesionStart, w);
    const endX = indexToX(effectiveLesionEnd, w);
    if (Math.abs(x - startX) < 10 || Math.abs(x - endX) < 10) {
      canvas.style.cursor = 'col-resize';
    } else {
      canvas.style.cursor = '';
    }
  }, [indexToX, xToIndex, effectiveLesionStart, effectiveLesionEnd, onLesionBoundsChange]);

  const handleMouseUp = useCallback(() => {
    dragRef.current = null;
    if (canvasRef.current) canvasRef.current.style.cursor = '';
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="diameter-chart-canvas"
      style={{ width: '100%' }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    />
  );
}

function drawDiameterArea(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  yOffset: number,
  contour: VesselContour,
  refDiameters: number[],
  measurements: QCAMeasurements,
  mode: 'diameter' | 'area'
): void {
  const { cumulativeLength, diameters, areas } = contour;
  const n = cumulativeLength.length;
  if (n < 2) return;

  const values = mode === 'diameter' ? diameters : areas;
  const refValues = mode === 'diameter'
    ? refDiameters
    : refDiameters.map(d => Math.PI * (d / 2) ** 2);

  const totalLen = cumulativeLength[n - 1];
  const maxVal = Math.max(...values, ...refValues) * 1.15;
  const unit = mode === 'diameter' ? 'mm' : 'mm\u00B2';

  const plotX = (dist: number) => PADDING.left + (dist / totalLen) * (w - PADDING.left - PADDING.right);
  const plotY = (val: number) => yOffset + PADDING.top + (1 - val / maxVal) * (h - PADDING.top - PADDING.bottom);

  // Background
  ctx.fillStyle = BG;
  ctx.fillRect(0, yOffset, w, h);

  // Gradient fill
  const grad = ctx.createLinearGradient(0, yOffset + PADDING.top, 0, yOffset + h - PADDING.bottom);
  grad.addColorStop(0, 'rgba(255,255,255,0.05)');
  grad.addColorStop(1, 'rgba(0,0,0,0.1)');
  ctx.fillStyle = grad;
  ctx.fillRect(PADDING.left, yOffset + PADDING.top, w - PADDING.left - PADDING.right, h - PADDING.top - PADDING.bottom);

  // Grid lines
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 0.5;
  const gridSteps = 5;
  for (let i = 0; i <= gridSteps; i++) {
    const y = yOffset + PADDING.top + (i / gridSteps) * (h - PADDING.top - PADDING.bottom);
    ctx.beginPath();
    ctx.moveTo(PADDING.left, y);
    ctx.lineTo(w - PADDING.right, y);
    ctx.stroke();
  }

  // X-axis labels
  ctx.fillStyle = WHITE;
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'center';
  const xStepMm = Math.ceil(totalLen / 8 / 5) * 5 || 5;
  for (let mm = 0; mm <= totalLen; mm += xStepMm) {
    const x = plotX(mm);
    ctx.fillText(`${mm}`, x, yOffset + h - 5);
  }
  ctx.fillText('mm', w - PADDING.right + 20, yOffset + h - 5);

  // Y-axis labels
  ctx.textAlign = 'right';
  for (let i = 0; i <= gridSteps; i++) {
    const val = (maxVal * (gridSteps - i)) / gridSteps;
    const y = yOffset + PADDING.top + (i / gridSteps) * (h - PADDING.top - PADDING.bottom);
    ctx.fillText(val.toFixed(1), PADDING.left - 4, y + 3);
  }

  // Unit label
  ctx.textAlign = 'left';
  ctx.fillText(unit, 4, yOffset + PADDING.top - 6);

  // Reference diameter line (pink)
  ctx.strokeStyle = PINK;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = plotX(cumulativeLength[i]);
    const y = plotY(refValues[i]);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Max/min dashed bounds
  const maxRef = Math.max(...refValues) * 1.05;
  const minRef = Math.min(...refValues) * 0.5;
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = 0.7;
  ctx.setLineDash([4, 4]);
  drawHorizontalLine(ctx, PADDING.left, w - PADDING.right, plotY(maxRef));
  drawHorizontalLine(ctx, PADDING.left, w - PADDING.right, plotY(minRef));
  ctx.setLineDash([]);

  // Actual diameter line (yellow)
  ctx.strokeStyle = YELLOW;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = plotX(cumulativeLength[i]);
    const y = plotY(values[i]);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  // MLD vertical marker
  const mldX = plotX(measurements.mldPosition);
  ctx.strokeStyle = YELLOW;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(mldX, yOffset + PADDING.top);
  ctx.lineTo(mldX, yOffset + h - PADDING.bottom);
  ctx.stroke();

  // Max value labels on right
  ctx.fillStyle = WHITE;
  ctx.textAlign = 'left';
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText(maxRef.toFixed(1), w - PADDING.right + 4, plotY(maxRef) + 3);
  ctx.fillText(minRef.toFixed(1), w - PADDING.right + 4, plotY(minRef) + 3);

  // Legend
  ctx.textAlign = 'right';
  const legendY = yOffset + 14;
  ctx.fillStyle = YELLOW;
  ctx.fillRect(w - 180, legendY - 6, 8, 8);
  ctx.fillText(mode === 'diameter' ? 'Diameter' : 'Area', w - 170 + 60, legendY + 1);
  ctx.fillStyle = PINK;
  ctx.fillRect(w - 100, legendY - 6, 8, 8);
  ctx.fillText('Reference', w - 90 + 58, legendY + 1);
}

function drawFFRChart(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  yOffset: number,
  cumulativeLength: number[],
  ffr: FFRResult
): void {
  const n = ffr.pullbackCurve.length;
  if (n < 2) return;

  const totalLen = cumulativeLength[cumulativeLength.length - 1];
  const plotX = (dist: number) => PADDING.left + (dist / totalLen) * (w - PADDING.left - PADDING.right);
  const plotY = (val: number) => yOffset + PADDING.top + (1 - val) * (h - PADDING.top - PADDING.bottom);

  // Background
  ctx.fillStyle = BG;
  ctx.fillRect(0, yOffset, w, h);

  // Title
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = 'bold 11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('vFFR', w / 2, yOffset + 14);

  // Grid
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 0.5;
  for (let val = 0; val <= 1; val += 0.2) {
    const y = plotY(val);
    ctx.beginPath();
    ctx.moveTo(PADDING.left, y);
    ctx.lineTo(w - PADDING.right, y);
    ctx.stroke();
  }

  // Threshold line at 0.8
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 4]);
  drawHorizontalLine(ctx, PADDING.left, w - PADDING.right, plotY(0.8));
  ctx.setLineDash([]);

  // Threshold at 1.0
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.setLineDash([6, 4]);
  drawHorizontalLine(ctx, PADDING.left, w - PADDING.right, plotY(1.0));
  ctx.setLineDash([]);

  // Y labels
  ctx.fillStyle = WHITE;
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'right';
  ctx.fillText('1.0', w - PADDING.right + 16, plotY(1.0) + 3);
  ctx.fillText('0.8', w - PADDING.right + 16, plotY(0.8) + 3);
  ctx.fillText('0', w - PADDING.right + 10, plotY(0) + 3);

  // X-axis
  ctx.textAlign = 'center';
  const xStepMm = Math.ceil(totalLen / 8 / 5) * 5 || 5;
  for (let mm = 0; mm <= totalLen; mm += xStepMm) {
    ctx.fillText(`${mm}`, plotX(mm), yOffset + h - 2);
  }
  ctx.fillText('mm', w - PADDING.right + 20, yOffset + h - 2);

  // vFFR pullback curve
  ctx.strokeStyle = YELLOW;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < n && i < cumulativeLength.length; i++) {
    const x = plotX(cumulativeLength[i]);
    const y = plotY(ffr.pullbackCurve[i]);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  // vFFR value label
  const color = ffr.isSignificant ? '#ff6b6b' : '#4ec49a';
  ctx.fillStyle = color;
  ctx.font = 'bold 12px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`vFFR = ${ffr.vffr.toFixed(2)}`, PADDING.left + 8, yOffset + h - PADDING.bottom + 14);

  // Legend
  ctx.fillStyle = YELLOW;
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'right';
  ctx.fillRect(w - 70, yOffset + h - 14, 8, 8);
  ctx.fillText('vFFR', w - 10, yOffset + h - 7);
}

function drawHorizontalLine(ctx: CanvasRenderingContext2D, x1: number, x2: number, y: number): void {
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
}
