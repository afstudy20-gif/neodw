import React, { useRef, useEffect, useCallback } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import { TAVIVector3D } from '../tavi/TAVITypes';

/**
 * CuspTriangleOverlay: draws a filled yellow triangle on viewport(s)
 * showing the Non-Coronary Cusp (NC) region. Visual guide only.
 * Renders on ALL specified viewports, syncs with camera/zoom/pan.
 */

interface CuspTriangleOverlayProps {
  renderingEngineId: string;
  /** Viewport IDs to render on */
  viewportIds?: string[];
  /** 2-3 world points defining the NC cusp region */
  points: TAVIVector3D[];
}

export const CuspTriangleOverlay: React.FC<CuspTriangleOverlayProps> = ({
  renderingEngineId,
  viewportIds = ['axial', 'sagittal', 'coronal'],
  points,
}) => {
  const canvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const pointsRef = useRef(points);
  pointsRef.current = points;

  const getEngine = useCallback(() => {
    return cornerstone.getRenderingEngine(renderingEngineId) ?? null;
  }, [renderingEngineId]);

  const drawOnViewport = useCallback((vpId: string) => {
    const engine = getEngine();
    if (!engine) return;
    const vp = engine.getViewport(vpId);
    if (!vp?.element) return;

    const canvas = canvasRefs.current.get(vpId);
    if (!canvas) return;

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

    const pts = pointsRef.current;
    if (pts.length < 2) return;

    // Project points to canvas
    const canvasPts: [number, number][] = [];
    for (const p of pts) {
      const result = vp.worldToCanvas([p.x, p.y, p.z]);
      if (result) canvasPts.push([result[0], result[1]]);
    }
    if (canvasPts.length < 2) return;

    // 2 points: dashed line
    if (canvasPts.length === 2) {
      ctx.beginPath();
      ctx.moveTo(canvasPts[0][0], canvasPts[0][1]);
      ctx.lineTo(canvasPts[1][0], canvasPts[1][1]);
      ctx.strokeStyle = '#eab308';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 3 points: filled triangle
    if (canvasPts.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(canvasPts[0][0], canvasPts[0][1]);
      ctx.lineTo(canvasPts[1][0], canvasPts[1][1]);
      ctx.lineTo(canvasPts[2][0], canvasPts[2][1]);
      ctx.closePath();
      ctx.fillStyle = 'rgba(234, 179, 8, 0.22)';
      ctx.fill();
      ctx.strokeStyle = '#eab308';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      // "NC" label at centroid
      const cx = (canvasPts[0][0] + canvasPts[1][0] + canvasPts[2][0]) / 3;
      const cy = (canvasPts[0][1] + canvasPts[1][1] + canvasPts[2][1]) / 3;
      ctx.font = 'bold 13px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 3;
      ctx.strokeText('NC', cx, cy);
      ctx.fillStyle = '#eab308';
      ctx.fillText('NC', cx, cy);
    }

    // Vertex dots
    for (const [px, py] of canvasPts) {
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#eab308';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }, [getEngine]);

  const redrawAll = useCallback(() => {
    for (const vpId of viewportIds) drawOnViewport(vpId);
  }, [viewportIds, drawOnViewport]);

  useEffect(() => {
    const engine = getEngine();
    if (!engine) return;

    const cleanups: (() => void)[] = [];

    for (const vpId of viewportIds) {
      const vp = engine.getViewport(vpId);
      if (!vp?.element) continue;
      const el = vp.element;

      const canvas = document.createElement('canvas');
      canvas.className = 'tavi-nc-triangle-overlay';
      canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:53;';
      el.style.position = 'relative';
      el.appendChild(canvas);
      canvasRefs.current.set(vpId, canvas);

      const handler = () => drawOnViewport(vpId);
      el.addEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, handler as EventListener);
      const ro = new ResizeObserver(handler);
      ro.observe(el);

      cleanups.push(() => {
        el.removeEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, handler as EventListener);
        ro.disconnect();
        if (canvas.parentElement === el) el.removeChild(canvas);
        canvasRefs.current.delete(vpId);
      });
    }

    redrawAll();

    return () => { cleanups.forEach(fn => fn()); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderingEngineId, viewportIds.join(',')]);

  useEffect(() => { redrawAll(); });

  return null;
};
