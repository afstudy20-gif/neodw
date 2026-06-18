import React, { useRef, useEffect, useCallback, useState } from 'react';
import type { TAVIFluoroAngleResult, TAVICuspOverlapViews } from '../tavi/TAVITypes';
import { TAVIGeometry } from '../tavi/TAVIGeometry';

interface AngioProjectionSimulatorProps {
  /** Perpendicularity curve points */
  curve: { laoRaoDeg: number; cranialCaudalDeg: number }[];
  /** RAO projection table */
  raoTable: { raoDeg: number; cranialCaudalDeg: number; label: string }[];
  /** LAO projection table */
  laoTable: { laoDeg: number; cranialCaudalDeg: number; label: string }[];
  /** Current coplanar fluoro angle */
  coplanarAngle?: TAVIFluoroAngleResult | null;
  /** Cusp-overlap views (all on the line of perpendicularity) */
  overlapViews?: TAVICuspOverlapViews | null;
  /** Called when user selects an angle */
  onAngleSelected?: (laoRaoDeg: number, cranCaudDeg: number) => void;
  /** Width */
  width?: number;
  /** Height */
  height?: number;
}

// Plot coordinate system: RAO negative, LAO positive on X; Caudal negative, Cranial positive on Y
const PLOT_RANGE = 60; // degrees in each direction
const PADDING = { top: 44, right: 16, bottom: 36, left: 44 };

function fluoToPlot(angle: TAVIFluoroAngleResult): { x: number; y: number } {
  const x = angle.laoRaoLabel === 'LAO' ? angle.laoRaoDegrees : -angle.laoRaoDegrees;
  const y = angle.cranialCaudalLabel === 'CRANIAL' ? angle.cranialCaudalDegrees : -angle.cranialCaudalDegrees;
  return { x, y };
}

export const AngioProjectionSimulator: React.FC<AngioProjectionSimulatorProps> = ({
  curve,
  raoTable,
  laoTable,
  coplanarAngle,
  overlapViews,
  onAngleSelected,
  width: propWidth,
  height: propHeight = 340,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [selectedAngle, setSelectedAngle] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [hoverAngle, setHoverAngle] = useState<{ x: number; y: number } | null>(null);

  // Auto-size to container width
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const width = propWidth || containerWidth || 340;
  const height = propHeight;

  const plotW = width - PADDING.left - PADDING.right;
  const plotH = height - PADDING.top - PADDING.bottom;

  const degToX = useCallback((deg: number) => PADDING.left + ((deg + PLOT_RANGE) / (2 * PLOT_RANGE)) * plotW, [plotW]);
  const degToY = useCallback((deg: number) => PADDING.top + ((PLOT_RANGE - deg) / (2 * PLOT_RANGE)) * plotH, [plotH]);
  const xToDeg = useCallback((px: number) => ((px - PADDING.left) / plotW) * (2 * PLOT_RANGE) - PLOT_RANGE, [plotW]);
  const yToDeg = useCallback((py: number) => PLOT_RANGE - ((py - PADDING.top) / plotH) * (2 * PLOT_RANGE), [plotH]);

  // Find nearest curve point for a given laoRao degree
  const nearestCurvePoint = useCallback((laoRaoDeg: number): { laoRaoDeg: number; cranialCaudalDeg: number } | null => {
    if (curve.length === 0) return null;
    let best = curve[0];
    let bestDist = Math.abs(curve[0].laoRaoDeg - laoRaoDeg);
    for (const p of curve) {
      const d = Math.abs(p.laoRaoDeg - laoRaoDeg);
      if (d < bestDist) { best = p; bestDist = d; }
    }
    return best;
  }, [curve]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = '#0a0e14';
    ctx.fillRect(0, 0, width, height);

    // Plot area
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(PADDING.left, PADDING.top, plotW, plotH);

    // Grid
    ctx.strokeStyle = '#1c2333';
    ctx.lineWidth = 0.5;
    for (let d = -PLOT_RANGE; d <= PLOT_RANGE; d += 10) {
      const x = degToX(d);
      const y = degToY(d);
      ctx.beginPath();
      ctx.moveTo(x, PADDING.top);
      ctx.lineTo(x, PADDING.top + plotH);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(PADDING.left, y);
      ctx.lineTo(PADDING.left + plotW, y);
      ctx.stroke();
    }

    // Zero axes (thicker)
    ctx.strokeStyle = '#30363d';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(degToX(0), PADDING.top);
    ctx.lineTo(degToX(0), PADDING.top + plotH);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(PADDING.left, degToY(0));
    ctx.lineTo(PADDING.left + plotW, degToY(0));
    ctx.stroke();

    // Axis labels
    ctx.fillStyle = '#8b949e';
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('RAO', PADDING.left + 20, PADDING.top + plotH + 28);
    ctx.fillText('LAO', PADDING.left + plotW - 20, PADDING.top + plotH + 28);
    ctx.save();
    ctx.translate(12, PADDING.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Caudal ← → Cranial', 0, 0);
    ctx.restore();

    // Tick labels
    ctx.fillStyle = '#6e7681';
    ctx.font = '8px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    for (let d = -PLOT_RANGE; d <= PLOT_RANGE; d += 20) {
      if (d === 0) continue;
      ctx.fillText(`${Math.abs(d)}°`, degToX(d), PADDING.top + plotH + 14);
    }
    ctx.textAlign = 'right';
    for (let d = -PLOT_RANGE; d <= PLOT_RANGE; d += 20) {
      if (d === 0) continue;
      ctx.fillText(`${Math.abs(d)}°`, PADDING.left - 6, degToY(d) + 3);
    }

    // ── Perpendicularity curve (yellow) ──
    if (curve.length > 0) {
      ctx.strokeStyle = '#d29922';
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let started = false;
      for (const p of curve) {
        if (p.laoRaoDeg < -PLOT_RANGE || p.laoRaoDeg > PLOT_RANGE) continue;
        const x = degToX(p.laoRaoDeg);
        const y = degToY(p.cranialCaudalDeg);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Glow effect
      ctx.strokeStyle = 'rgba(210, 153, 34, 0.2)';
      ctx.lineWidth = 8;
      ctx.beginPath();
      started = false;
      for (const p of curve) {
        if (p.laoRaoDeg < -PLOT_RANGE || p.laoRaoDeg > PLOT_RANGE) continue;
        const x = degToX(p.laoRaoDeg);
        const y = degToY(p.cranialCaudalDeg);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // ── Marker labels with greedy collision avoidance ──
    // Dots/markers are drawn immediately; their text labels are queued and
    // placed in a single prioritized pass so dense ticks never overprint.
    const placedBoxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
    type LabelReq = { text: string; ax: number; ay: number; color: string; bold: boolean; priority: number };
    const labelReqs: LabelReq[] = [];
    const inPlot = (x: number, y: number) =>
      x >= PADDING.left && x <= PADDING.left + plotW && y >= PADDING.top && y <= PADDING.top + plotH;

    // ── RAO projection ticks (origin de-duplicated → "AP") ──
    for (const entry of raoTable) {
      const x = degToX(-entry.raoDeg);
      const y = degToY(entry.cranialCaudalDeg);
      if (!inPlot(x, y)) continue;
      ctx.fillStyle = '#58a6ff';
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0d1117';
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fill();
      labelReqs.push({
        text: entry.raoDeg === 0 ? 'AP' : `R${entry.raoDeg}`,
        ax: x, ay: y, color: '#58a6ff', bold: false, priority: entry.raoDeg === 0 ? 2 : 1,
      });
    }

    // ── LAO projection ticks (skip 0 — origin already drawn as AP) ──
    for (const entry of laoTable) {
      if (entry.laoDeg === 0) continue;
      const x = degToX(entry.laoDeg);
      const y = degToY(entry.cranialCaudalDeg);
      if (!inPlot(x, y)) continue;
      ctx.fillStyle = '#bc8cff';
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0d1117';
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fill();
      labelReqs.push({ text: `L${entry.laoDeg}`, ax: x, ay: y, color: '#bc8cff', bold: false, priority: 1 });
    }

    // ── Cusp-overlap views (all sit ON the perpendicularity curve) ──
    // Labelled by the overlapping pair; R/L overlap (isolates NCC) is the
    // self-expanding "cusp-overlap" working view, so it is emphasised.
    if (overlapViews) {
      const cuspColor: Record<'L' | 'R' | 'N', string> = { R: '#3fb950', L: '#f85149', N: '#d29922' };
      const markers = [
        { v: overlapViews.rlOverlap, key: 'rl' as const },
        { v: overlapViews.rnOverlap, key: 'rn' as const },
        { v: overlapViews.lnOverlap, key: 'ln' as const },
      ];
      for (const { v } of markers) {
        const p = fluoToPlot(v.angle);
        const x = degToX(p.x);
        const y = degToY(p.y);
        if (!inPlot(x, y)) continue;
        const isKey = v.isolatedCusp === 'N'; // R/L overlap
        const color = cuspColor[v.isolatedCusp];
        if (isKey) {
          ctx.strokeStyle = 'rgba(63, 185, 80, 0.25)';
          ctx.lineWidth = 6;
          ctx.beginPath();
          ctx.arc(x, y, 7, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, isKey ? 6 : 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fill();
        labelReqs.push({
          text: `${v.overlapPair[0]}/${v.overlapPair[1]}`,
          ax: x, ay: y, color, bold: isKey, priority: isKey ? 4 : 3,
        });
      }
    }

    // ── Place queued labels (highest priority first; drop if no clear slot) ──
    const placeLabel = (req: LabelReq) => {
      ctx.font = `${req.bold ? 'bold ' : ''}9px -apple-system, sans-serif`;
      const w = ctx.measureText(req.text).width;
      const h = 10;
      const candidates: [number, number][] = [
        [req.ax + 8, req.ay + 3],
        [req.ax - 8 - w, req.ay + 3],
        [req.ax - w / 2, req.ay - 9],
        [req.ax - w / 2, req.ay + 15],
      ];
      for (const [lx, ly] of candidates) {
        const box = { x0: lx - 1, y0: ly - h, x1: lx + w + 1, y1: ly + 2 };
        if (box.x0 < PADDING.left || box.x1 > PADDING.left + plotW) continue;
        if (box.y0 < PADDING.top || box.y1 > PADDING.top + plotH) continue;
        const hit = placedBoxes.some(
          (b) => !(box.x1 < b.x0 || box.x0 > b.x1 || box.y1 < b.y0 || box.y0 > b.y1)
        );
        if (hit) continue;
        placedBoxes.push(box);
        ctx.fillStyle = req.color;
        ctx.textAlign = 'left';
        ctx.fillText(req.text, lx, ly);
        return;
      }
    };
    labelReqs.sort((a, b) => b.priority - a.priority);
    for (const req of labelReqs) placeLabel(req);

    // ── Coplanar angle marker (main blue circle) ──
    if (coplanarAngle) {
      const p = fluoToPlot(coplanarAngle);
      const x = degToX(p.x);
      const y = degToY(p.y);
      // Pulsing ring
      ctx.strokeStyle = '#58a6ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#58a6ff';
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // ── Hover crosshair ──
    const displayAngle = hoverAngle || selectedAngle;
    if (displayAngle) {
      const x = degToX(displayAngle.x);
      const y = degToY(displayAngle.y);

      // Crosshair lines
      ctx.strokeStyle = 'rgba(248, 81, 73, 0.4)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, PADDING.top);
      ctx.lineTo(x, PADDING.top + plotH);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(PADDING.left, y);
      ctx.lineTo(PADDING.left + plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Marker
      ctx.fillStyle = '#f85149';
      ctx.strokeStyle = '#0d1117';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // ── C-arm mannequin (bottom-right inset) ──
    const activeAngle = displayAngle || (coplanarAngle ? fluoToPlot(coplanarAngle) : null);
    if (activeAngle) {
      drawCarmMannequin(ctx, width - 60, PADDING.top + plotH - 50, 40, activeAngle.x, activeAngle.y);
    }

    // ── Header angle readout ──
    ctx.fillStyle = '#e6edf3';
    ctx.font = 'bold 12px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Angio Projection', width / 2, 16);

    // Current angle readout
    if (activeAngle) {
      const laoRaoLabel = activeAngle.x >= 0 ? 'LAO' : 'RAO';
      const cranCaudLabel = activeAngle.y >= 0 ? 'Cranial' : 'Caudal';
      ctx.fillStyle = '#8b949e';
      ctx.font = '11px -apple-system, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`${laoRaoLabel}: ${Math.abs(activeAngle.x).toFixed(0)}°`, PADDING.left, 36);
      ctx.textAlign = 'right';
      ctx.fillText(`${cranCaudLabel}: ${Math.abs(activeAngle.y).toFixed(0)}°`, width - PADDING.right, 36);
    }

  }, [curve, raoTable, laoTable, coplanarAngle, overlapViews, selectedAngle, hoverAngle, width, height, degToX, degToY, plotW, plotH]);

  useEffect(() => {
    draw();
  }, [draw]);

  // ── Mouse interaction ──
  const getPlotCoords = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    // Check if within plot area
    if (px < PADDING.left || px > PADDING.left + plotW) return null;
    if (py < PADDING.top || py > PADDING.top + plotH) return null;
    return { x: xToDeg(px), y: yToDeg(py) };
  }, [plotW, plotH, xToDeg, yToDeg]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const coords = getPlotCoords(e);
    if (!coords) return;
    // Snap to nearest point on the curve
    const nearestPt = nearestCurvePoint(coords.x);
    if (nearestPt) {
      const snapped = { x: nearestPt.laoRaoDeg, y: nearestPt.cranialCaudalDeg };
      setSelectedAngle(snapped);
      setIsDragging(true);
      onAngleSelected?.(snapped.x, snapped.y);
    }
  }, [getPlotCoords, nearestCurvePoint, onAngleSelected]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const coords = getPlotCoords(e);
    if (!coords) { setHoverAngle(null); return; }
    const nearestPt = nearestCurvePoint(coords.x);
    if (nearestPt) {
      const snapped = { x: nearestPt.laoRaoDeg, y: nearestPt.cranialCaudalDeg };
      setHoverAngle(snapped);
      if (isDragging) {
        setSelectedAngle(snapped);
        onAngleSelected?.(snapped.x, snapped.y);
      }
    }
  }, [getPlotCoords, nearestCurvePoint, isDragging, onAngleSelected]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHoverAngle(null);
    setIsDragging(false);
  }, []);

  return (
    <div className="angio-simulator" ref={containerRef}>
      <canvas
        ref={canvasRef}
        style={{ cursor: 'crosshair', borderRadius: 'var(--radius-md)' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
      />
      {/* Legend */}
      <div className="angio-legend">
        <span className="angio-legend-item"><span className="angio-legend-swatch" style={{ background: '#d29922' }} /> Perpendicularity</span>
        <span className="angio-legend-item"><span className="angio-legend-swatch" style={{ background: '#58a6ff' }} /> RAO</span>
        <span className="angio-legend-item"><span className="angio-legend-swatch" style={{ background: '#bc8cff' }} /> LAO</span>
        {overlapViews && (
          <>
            <span className="angio-legend-item"><span className="angio-legend-swatch angio-legend-ring" style={{ borderColor: '#3fb950' }} /> R/L overlap (NCC)</span>
            <span className="angio-legend-item"><span className="angio-legend-swatch angio-legend-ring" style={{ borderColor: '#f85149' }} /> R/N overlap (LCC)</span>
            <span className="angio-legend-item"><span className="angio-legend-swatch angio-legend-ring" style={{ borderColor: '#d29922' }} /> L/N overlap (RCC)</span>
          </>
        )}
      </div>
    </div>
  );
};

// ── C-arm mannequin drawing ──

function drawCarmMannequin(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  laoRaoDeg: number,
  cranCaudDeg: number,
) {
  const s = size / 2;

  ctx.save();
  ctx.translate(cx, cy);

  // Background circle
  ctx.fillStyle = 'rgba(13, 17, 23, 0.8)';
  ctx.beginPath();
  ctx.arc(0, 0, s, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#30363d';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Patient body (top-down view, simplified ellipse)
  ctx.fillStyle = '#1c2333';
  ctx.beginPath();
  ctx.ellipse(0, 0, s * 0.3, s * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#484f58';
  ctx.lineWidth = 0.5;
  ctx.stroke();

  // Head indicator (small circle at top)
  ctx.fillStyle = '#484f58';
  ctx.beginPath();
  ctx.arc(0, -s * 0.6, s * 0.1, 0, Math.PI * 2);
  ctx.fill();

  // C-arm arc
  const armAngleRad = (laoRaoDeg * Math.PI) / 180;
  const tiltRad = (cranCaudDeg * Math.PI) / 180;

  // Draw the C-arm as an arc that rotates around the patient
  const arcRadius = s * 0.85;
  const arcStart = armAngleRad - Math.PI * 0.4;
  const arcEnd = armAngleRad + Math.PI * 0.4;

  // Compress arc vertically based on tilt (perspective)
  const tiltFactor = Math.cos(tiltRad) * 0.3 + 0.7;
  ctx.save();
  ctx.scale(1, tiltFactor);

  ctx.strokeStyle = '#58a6ff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, arcRadius, arcStart - Math.PI / 2, arcEnd - Math.PI / 2);
  ctx.stroke();

  // Tube (source) - at one end of the arc
  const tubeX = arcRadius * Math.cos(arcStart - Math.PI / 2);
  const tubeY = arcRadius * Math.sin(arcStart - Math.PI / 2);
  ctx.fillStyle = '#58a6ff';
  ctx.beginPath();
  ctx.arc(tubeX, tubeY, 3, 0, Math.PI * 2);
  ctx.fill();

  // Detector - at the other end
  const detX = arcRadius * Math.cos(arcEnd - Math.PI / 2);
  const detY = arcRadius * Math.sin(arcEnd - Math.PI / 2);
  ctx.fillStyle = '#58a6ff';
  ctx.fillRect(detX - 4, detY - 3, 8, 6);

  ctx.restore();

  // Angle text
  ctx.fillStyle = '#6e7681';
  ctx.font = '7px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  const lrLabel = laoRaoDeg >= 0 ? 'LAO' : 'RAO';
  const ccLabel = cranCaudDeg >= 0 ? 'CRA' : 'CAU';
  ctx.fillText(`${lrLabel}${Math.abs(laoRaoDeg).toFixed(0)}°`, 0, s + 10);
  ctx.fillText(`${ccLabel}${Math.abs(cranCaudDeg).toFixed(0)}°`, 0, s + 19);

  ctx.restore();
}
