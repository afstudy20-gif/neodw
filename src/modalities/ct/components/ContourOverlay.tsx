import React, { useRef, useEffect, useCallback, useState } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import { TAVIVector3D, TAVIGeometryResult } from '../tavi/TAVITypes';
import { TAVIGeometry } from '../tavi/TAVIGeometry';

/** Project a world point onto a plane defined by origin + normal */
function projectOntoPlane(point: TAVIVector3D, planeOrigin: TAVIVector3D, planeNormal: TAVIVector3D): TAVIVector3D {
  const d = (point.x - planeOrigin.x) * planeNormal.x +
            (point.y - planeOrigin.y) * planeNormal.y +
            (point.z - planeOrigin.z) * planeNormal.z;
  return {
    x: point.x - d * planeNormal.x,
    y: point.y - d * planeNormal.y,
    z: point.z - d * planeNormal.z,
  };
}

/** Catmull-Rom spline interpolation between p1 and p2 (using p0, p3 as control) */
function catmullRom(p0: [number, number], p1: [number, number], p2: [number, number], p3: [number, number], t: number): [number, number] {
  const t2 = t * t, t3 = t2 * t;
  return [
    0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
    0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
  ];
}

/** Generate smooth closed Catmull-Rom spline points through control points */
function catmullRomClosed(controlPts: [number, number][], segmentsPerSpan: number = 8): [number, number][] {
  const n = controlPts.length;
  if (n < 3) return controlPts;
  const result: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const p0 = controlPts[(i - 1 + n) % n];
    const p1 = controlPts[i];
    const p2 = controlPts[(i + 1) % n];
    const p3 = controlPts[(i + 2) % n];
    for (let s = 0; s < segmentsPerSpan; s++) {
      result.push(catmullRom(p0, p1, p2, p3, s / segmentsPerSpan));
    }
  }
  return result;
}

/** Catmull-Rom in 3D for world-space interpolation */
function catmullRom3D(
  p0: TAVIVector3D, p1: TAVIVector3D, p2: TAVIVector3D, p3: TAVIVector3D, t: number
): TAVIVector3D {
  const t2 = t * t, t3 = t2 * t;
  const interp = (a: number, b: number, c: number, d: number) =>
    0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return {
    x: interp(p0.x, p1.x, p2.x, p3.x),
    y: interp(p0.y, p1.y, p2.y, p3.y),
    z: interp(p0.z, p1.z, p2.z, p3.z),
  };
}

/** Regenerate dense contour from handle (control) points using Catmull-Rom in world space */
function regenerateContourFromHandles(handles: TAVIVector3D[], pointsPerSpan: number = 5): TAVIVector3D[] {
  const n = handles.length;
  if (n < 3) return handles;
  const result: TAVIVector3D[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = handles[(i - 1 + n) % n];
    const p1 = handles[i];
    const p2 = handles[(i + 1) % n];
    const p3 = handles[(i + 2) % n];
    for (let s = 0; s < pointsPerSpan; s++) {
      result.push(catmullRom3D(p0, p1, p2, p3, s / pointsPerSpan));
    }
  }
  return result;
}

/**
 * ContourOverlay: renders a captured cross-section contour on a Cornerstone viewport.
 *
 * The contour is defined by handle (control) points. The full contour is drawn as a
 * smooth Catmull-Rom spline through the handles. When a handle is dragged, the spline
 * updates smoothly. Dense points for geometry calculation are regenerated from the spline.
 */

interface ContourOverlayProps {
  renderingEngineId: string;
  viewportId?: string;
  /** The full contour world points (used to derive initial handles) */
  contourPoints: TAVIVector3D[];
  geometry: TAVIGeometryResult;
  planeNormal: TAVIVector3D;
  contourColor?: string;
  label?: string;
  onContourEdited?: (newPoints: TAVIVector3D[], newGeometry: TAVIGeometryResult) => void;
  /** Number of control handles (default: 16) */
  handleCount?: number;
}

const HANDLE_RADIUS = 5;
const HIT_RADIUS = 12;

export const ContourOverlay: React.FC<ContourOverlayProps> = ({
  renderingEngineId,
  viewportId = 'axial',
  contourPoints,
  geometry,
  planeNormal,
  contourColor = '#3fb950',
  label,
  onContourEdited,
  handleCount = 16,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Extract handle points from contourPoints (evenly spaced)
  const extractHandles = useCallback((pts: TAVIVector3D[], count: number): TAVIVector3D[] => {
    if (pts.length <= count) return pts.map(p => ({ ...p }));
    const step = pts.length / count;
    return Array.from({ length: count }, (_, i) => {
      const p = pts[Math.round(i * step) % pts.length];
      return { ...p };
    });
  }, []);

  // Store handles (control points) — these are what the user drags
  const handlesRef = useRef<TAVIVector3D[]>(extractHandles(contourPoints, handleCount));
  const geometryRef = useRef<TAVIGeometryResult>(geometry);
  const planeNormalRef = useRef<TAVIVector3D>(planeNormal);
  const onContourEditedRef = useRef(onContourEdited);
  const dragStateRef = useRef<{ dragging: boolean; handleIndex: number } | null>(null);
  const [, setVersion] = useState(0);
  const bump = () => setVersion(v => v + 1);

  // Keep refs in sync with props (only when not dragging)
  useEffect(() => {
    if (!dragStateRef.current?.dragging) {
      handlesRef.current = extractHandles(contourPoints, handleCount);
    }
    geometryRef.current = geometry;
    planeNormalRef.current = planeNormal;
    onContourEditedRef.current = onContourEdited;
    bump();
  }, [contourPoints, geometry, planeNormal, onContourEdited, handleCount, extractHandles]);

  const getViewport = useCallback(() => {
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    return engine?.getViewport(viewportId) ?? null;
  }, [renderingEngineId, viewportId]);

  const worldToCanvas = useCallback((point: TAVIVector3D): [number, number] | null => {
    const vp = getViewport();
    if (!vp) return null;
    const result = vp.worldToCanvas([point.x, point.y, point.z]);
    if (!result) return null;
    return [result[0], result[1]];
  }, [getViewport]);

  const getDiameterEndpoints = useCallback((geo: TAVIGeometryResult) => {
    const c = geo.centroid;
    const majDir = geo.majorAxisDirection;
    const minDir = geo.minorAxisDirection;
    const maxR = geo.maximumDiameterMm / 2;
    const minR = geo.minimumDiameterMm / 2;
    return {
      maxStart: { x: c.x - majDir.x * maxR, y: c.y - majDir.y * maxR, z: c.z - majDir.z * maxR },
      maxEnd: { x: c.x + majDir.x * maxR, y: c.y + majDir.y * maxR, z: c.z + majDir.z * maxR },
      minStart: { x: c.x - minDir.x * minR, y: c.y - minDir.y * minR, z: c.z - minDir.z * minR },
      minEnd: { x: c.x + minDir.x * minR, y: c.y + minDir.y * minR, z: c.z + minDir.z * minR },
    };
  }, []);

  // ── Main draw function ──
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const vp = getViewport();
    if (!vp?.element) return;

    const el = vp.element;
    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth;
    const h = el.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const handles = handlesRef.current;
    const geo = geometryRef.current;
    if (!handles || handles.length < 3) return;

    // Project handle points to canvas
    const handleCanvasPts: [number, number][] = [];
    for (const p of handles) {
      const cp = worldToCanvas(p);
      if (cp) handleCanvasPts.push(cp);
      else handleCanvasPts.push([-9999, -9999]); // placeholder to keep index alignment
    }

    // Generate smooth spline through handles (in canvas space for drawing)
    const validHandlePts = handleCanvasPts.filter(p => p[0] > -9000);
    if (validHandlePts.length < 3) return;
    const splinePts = catmullRomClosed(validHandlePts, 10);

    // ── Semi-transparent fill ──
    ctx.beginPath();
    ctx.moveTo(splinePts[0][0], splinePts[0][1]);
    for (let i = 1; i < splinePts.length; i++) ctx.lineTo(splinePts[i][0], splinePts[i][1]);
    ctx.closePath();
    ctx.fillStyle = `${contourColor}18`;
    ctx.fill();

    // ── Contour outline (smooth spline) ──
    ctx.beginPath();
    ctx.moveTo(splinePts[0][0], splinePts[0][1]);
    for (let i = 1; i < splinePts.length; i++) ctx.lineTo(splinePts[i][0], splinePts[i][1]);
    ctx.closePath();
    ctx.strokeStyle = contourColor;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.stroke();

    // ── Diameter lines ──
    const diams = getDiameterEndpoints(geo);

    // Max diameter (red dashed)
    const maxS = worldToCanvas(diams.maxStart);
    const maxE = worldToCanvas(diams.maxEnd);
    if (maxS && maxE) {
      ctx.beginPath();
      ctx.moveTo(maxS[0], maxS[1]);
      ctx.lineTo(maxE[0], maxE[1]);
      ctx.strokeStyle = '#f85149';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      for (const ep of [maxS, maxE]) {
        ctx.beginPath();
        ctx.arc(ep[0], ep[1], 3, 0, Math.PI * 2);
        ctx.fillStyle = '#f85149';
        ctx.fill();
      }

      const mx = (maxS[0] + maxE[0]) / 2;
      const my = (maxS[1] + maxE[1]) / 2;
      const maxLabel = `Max: ${geo.maximumDiameterMm.toFixed(1)}mm`;
      ctx.font = 'bold 11px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 3;
      ctx.strokeText(maxLabel, mx, my - 8);
      ctx.fillStyle = '#f85149';
      ctx.fillText(maxLabel, mx, my - 8);
    }

    // Min diameter (blue dashed)
    const minS = worldToCanvas(diams.minStart);
    const minE = worldToCanvas(diams.minEnd);
    if (minS && minE) {
      ctx.beginPath();
      ctx.moveTo(minS[0], minS[1]);
      ctx.lineTo(minE[0], minE[1]);
      ctx.strokeStyle = '#58a6ff';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      for (const ep of [minS, minE]) {
        ctx.beginPath();
        ctx.arc(ep[0], ep[1], 3, 0, Math.PI * 2);
        ctx.fillStyle = '#58a6ff';
        ctx.fill();
      }

      const mx = (minS[0] + minE[0]) / 2;
      const my = (minS[1] + minE[1]) / 2;
      const minLabel = `Min: ${geo.minimumDiameterMm.toFixed(1)}mm`;
      ctx.font = 'bold 11px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 3;
      ctx.strokeText(minLabel, mx, my + 16);
      ctx.fillStyle = '#58a6ff';
      ctx.fillText(minLabel, mx, my + 16);
    }

    // ── Area label at centroid ──
    const centroidCanvas = worldToCanvas(geo.centroid);
    if (centroidCanvas) {
      const areaLabel = `${geo.areaMm2.toFixed(0)}mm²`;
      ctx.font = 'bold 12px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 3;
      ctx.strokeText(areaLabel, centroidCanvas[0], centroidCanvas[1] + 4);
      ctx.fillStyle = '#fff';
      ctx.fillText(areaLabel, centroidCanvas[0], centroidCanvas[1] + 4);
    }

    // ── Structure label ──
    if (label && centroidCanvas) {
      ctx.font = '10px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 3;
      ctx.strokeText(label, centroidCanvas[0], centroidCanvas[1] + 18);
      ctx.fillStyle = contourColor;
      ctx.fillText(label, centroidCanvas[0], centroidCanvas[1] + 18);
    }

    // ── Draggable handles ──
    if (onContourEdited) {
      for (let i = 0; i < handleCanvasPts.length; i++) {
        const [hx, hy] = handleCanvasPts[i];
        if (hx < -9000) continue;
        const isDragging = dragStateRef.current?.dragging && dragStateRef.current.handleIndex === i;

        ctx.beginPath();
        ctx.arc(hx, hy, isDragging ? HANDLE_RADIUS + 2 : HANDLE_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = isDragging ? '#fff' : contourColor;
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }, [getViewport, worldToCanvas, contourColor, label, onContourEdited, getDiameterEndpoints]);

  // ── Lifecycle: create canvas, attach to viewport, setup listeners ──
  useEffect(() => {
    const vp = getViewport();
    if (!vp?.element) return;
    const el = vp.element;

    // Create canvas
    const canvas = document.createElement('canvas');
    canvas.className = 'tavi-contour-overlay';
    canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:54;';
    el.style.position = 'relative';
    el.appendChild(canvas);
    canvasRef.current = canvas;

    redraw();

    // Camera changes
    const onCamera = () => redraw();
    el.addEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, onCamera as EventListener);

    // Resize
    const ro = new ResizeObserver(() => redraw());
    ro.observe(el);

    // ── Mouse interaction for handle dragging ──
    const eventToCanvas = (e: MouseEvent): [number, number] => {
      const rect = el.getBoundingClientRect();
      return [e.clientX - rect.left, e.clientY - rect.top];
    };

    const hitTestHandle = (cx: number, cy: number): number | null => {
      if (!onContourEditedRef.current) return null;
      const handles = handlesRef.current;
      for (let i = 0; i < handles.length; i++) {
        const cp = worldToCanvas(handles[i]);
        if (!cp) continue;
        const dx = cp[0] - cx;
        const dy = cp[1] - cy;
        if (dx * dx + dy * dy <= HIT_RADIUS * HIT_RADIUS) return i;
      }
      return null;
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0 || !onContourEditedRef.current) return;
      const [cx, cy] = eventToCanvas(e);
      const hit = hitTestHandle(cx, cy);
      if (hit !== null) {
        dragStateRef.current = { dragging: true, handleIndex: hit };
        canvas.style.pointerEvents = 'auto';
        canvas.style.cursor = 'grabbing';
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      const [cx, cy] = eventToCanvas(e);

      if (dragStateRef.current?.dragging) {
        const worldPtRaw = vp.canvasToWorld([cx, cy] as cornerstone.Types.Point2);
        if (worldPtRaw) {
          const rawPt = { x: worldPtRaw[0], y: worldPtRaw[1], z: worldPtRaw[2] };
          const centroid = geometryRef.current.centroid;
          const projPt = projectOntoPlane(rawPt, centroid, planeNormalRef.current);

          const idx = dragStateRef.current.handleIndex;
          handlesRef.current = [...handlesRef.current];
          handlesRef.current[idx] = projPt;

          // Regenerate dense contour from handles for geometry calculation
          const denseContour = regenerateContourFromHandles(handlesRef.current, 5);
          const newGeo = TAVIGeometry.geometryForWorldContour(denseContour, planeNormalRef.current);
          if (newGeo) geometryRef.current = newGeo;
          redraw();
        }
        e.preventDefault();
        e.stopPropagation();
      } else if (onContourEditedRef.current) {
        const hit = hitTestHandle(cx, cy);
        canvas.style.pointerEvents = hit !== null ? 'auto' : 'none';
        canvas.style.cursor = hit !== null ? 'grab' : 'default';
      }
    };

    const onMouseUp = () => {
      if (dragStateRef.current?.dragging) {
        dragStateRef.current = null;
        canvas.style.pointerEvents = 'none';
        canvas.style.cursor = 'default';

        // Regenerate dense contour and notify parent
        const denseContour = regenerateContourFromHandles(handlesRef.current, 5);
        const newGeo = TAVIGeometry.geometryForWorldContour(denseContour, planeNormalRef.current);
        if (newGeo && onContourEditedRef.current) {
          onContourEditedRef.current(denseContour, newGeo);
        }
        redraw();
      }
    };

    el.addEventListener('mousedown', onMouseDown);
    el.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    return () => {
      el.removeEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, onCamera as EventListener);
      el.removeEventListener('mousedown', onMouseDown);
      el.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      ro.disconnect();
      if (canvas.parentElement === el) {
        el.removeChild(canvas);
      }
      canvasRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderingEngineId, viewportId]);

  // Redraw when data changes
  useEffect(() => { redraw(); });

  return null;
};
