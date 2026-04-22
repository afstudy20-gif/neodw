import { useCallback, useEffect, useRef, useState, type Dispatch } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import { CineControls } from './CineControls';
import { renderQCASvg, clearQCASvg } from '../qca/QCASvgOverlay';
import { detectVesselContour } from '../qca/edgeDetection';
import { computeReferenceDiameters, computeQCAMeasurements } from '../qca/qcaMeasurement';
import type { Point2D, WorldPoint, QCAAction, QCASession, VesselContour } from '../qca/QCATypes';

interface Props {
  renderingEngineId: string;
  viewportId: string;
  imageCount: number;
  qcaSession: QCASession | null;
  qcaDispatch: Dispatch<QCAAction> | null;
  seriesIndex?: number;
  seriesCount?: number;
  onPrevSeries?: () => void;
  onNextSeries?: () => void;
}

export function AngioViewer({ renderingEngineId, viewportId, imageCount, qcaSession, qcaDispatch, seriesIndex, seriesCount, onPrevSeries, onNextSeries }: Props) {
  const [currentFrame, setCurrentFrame] = useState(0);
  const calibLineStartRef = useRef<Point2D | null>(null);
  const calibLineStartWorldRef = useRef<WorldPoint | null>(null);
  const mousePosRef = useRef<Point2D | null>(null);
  const dragRef = useRef<{ which: 'proximal' | 'distal' | null; contourHandle?: { side: 'left' | 'right'; index: number } | null }>({ which: null, contourHandle: null });
  const [, setTick] = useState(0);
  const bump = () => setTick(t => t + 1);

  const sessionRef = useRef(qcaSession);
  sessionRef.current = qcaSession;
  const dispatchRef = useRef(qcaDispatch);
  dispatchRef.current = qcaDispatch;

  const getViewport = useCallback((): cornerstone.Types.IStackViewport | null => {
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    return (engine?.getViewport(viewportId) as cornerstone.Types.IStackViewport) ?? null;
  }, [renderingEngineId, viewportId]);

  const onFrameChange = useCallback((index: number) => setCurrentFrame(index), []);

  // ── SVG overlay rendering ──
  // Uses cornerstone's own .svg-layer — guarantees zero drift on pan/zoom
  // because cornerstone manages the SVG coordinate system internally.

  const redraw = useCallback(() => {
    const session = sessionRef.current;
    const vp = getViewport();
    if (!vp?.element) return;

    // Use cornerstone's OWN svg-layer (inside .viewport-element).
    // This is the same SVG that LengthTool etc. use — guarantees zero drift.
    const viewportElement = vp.element.querySelector('.viewport-element');
    const svgLayer = viewportElement?.querySelector(':scope > .svg-layer') as SVGSVGElement | null;
    if (!svgLayer) return;

    if (!session) {
      clearQCASvg(svgLayer);
      return;
    }

    // worldToCanvas returns coordinates in the SAME space as the SVG layer.
    // No scaling needed — this is exactly how cornerstone's own tools work.
    const w2c = (wp: WorldPoint): Point2D | null => {
      try {
        const cp = vp.worldToCanvas(wp as cornerstone.Types.Point3);
        if (!cp || !Number.isFinite(cp[0]) || !Number.isFinite(cp[1])) return null;
        return { x: cp[0], y: cp[1] };
      } catch { return null; }
    };

    // Rubber-band: if calibration first point placed and mouse is moving
    const rb = (calibLineStartRef.current && mousePosRef.current && session.interactionMode === 'calibration-line')
      ? { start: calibLineStartRef.current, end: mousePosRef.current }
      : null;

    renderQCASvg(svgLayer, session, w2c, rb);
  }, [getViewport]);

  const redrawRef = useRef(redraw);
  redrawRef.current = redraw;

  // Redraw every React render (session changes, bumps from events)
  useEffect(() => { redrawRef.current(); });

  // ── Lifecycle: attach event listeners to cornerstone element ──
  useEffect(() => {
    const vp = getViewport();
    if (!vp?.element) return;
    const el = vp.element;

    // CRITICAL: call redraw SYNCHRONOUSLY in the event handler,
    // not via React state (bump→setState→useEffect is async and too late).
    // Cornerstone's own tools also redraw synchronously in the render callback.
    const onCamera = () => redrawRef.current();
    const onRendered = () => {
      const svp = getViewport();
      if (svp && 'getCurrentImageIdIndex' in svp) setCurrentFrame(svp.getCurrentImageIdIndex());
      redrawRef.current();
    };

    el.addEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, onCamera as EventListener);
    el.addEventListener(cornerstone.Enums.Events.IMAGE_RENDERED, onRendered as EventListener);

    const ro = new ResizeObserver(() => redrawRef.current());
    ro.observe(el);

    // ── Mouse helpers ──
    // eventToCanvas returns coords relative to vp.element (same space as worldToCanvas/canvasToWorld)
    const eventToCanvas = (e: MouseEvent): Point2D => {
      const rect = el.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    // canvasToWorld: NO scaling — cornerstone handles CSS↔buffer internally
    const canvasToWorld = (p: Point2D): WorldPoint | null => {
      try { return vp.canvasToWorld([p.x, p.y]) as WorldPoint; }
      catch { return null; }
    };

    const HIT_RADIUS = 14;
    const HANDLE_HIT_RADIUS = 10;

    type HitResult = { type: 'marker'; which: 'proximal' | 'distal' } | { type: 'contourHandle'; side: 'left' | 'right'; index: number } | null;

    const hitTest = (cx: number, cy: number): HitResult => {
      const s = sessionRef.current;
      if (!s) return null;

      // Check P/D markers first
      for (const which of ['proximal', 'distal'] as const) {
        const wp = which === 'proximal' ? s.proximalPoint : s.distalPoint;
        if (!wp) continue;
        const cp = vp.worldToCanvas(wp as cornerstone.Types.Point3);
        if (!cp) continue;
        if ((cp[0] - cx) ** 2 + (cp[1] - cy) ** 2 <= HIT_RADIUS ** 2) return { type: 'marker', which };
      }

      // Check contour handle points (blue squares)
      if (s.contour) {
        const HANDLE_STEP = Math.max(1, Math.floor(s.contour.leftBorder.length / 12));
        for (let i = 0; i < s.contour.leftBorder.length; i += HANDLE_STEP) {
          for (const side of ['left', 'right'] as const) {
            const border = side === 'left' ? s.contour.leftBorder : s.contour.rightBorder;
            if (i >= border.length) continue;
            const cp = vp.worldToCanvas(border[i] as cornerstone.Types.Point3);
            if (!cp) continue;
            if ((cp[0] - cx) ** 2 + (cp[1] - cy) ** 2 <= HANDLE_HIT_RADIUS ** 2) {
              return { type: 'contourHandle', side, index: i };
            }
          }
        }
      }

      return null;
    };

    // ── Mouse handlers ──
    const onMouseDown = (e: MouseEvent) => {
      const session = sessionRef.current;
      const dispatch = dispatchRef.current;
      if (!session || !dispatch || e.button !== 0) return;

      const pt = eventToCanvas(e);
      const mode = session.interactionMode;

      // Drag existing P/D marker or contour handle when idle
      if (mode === 'none' && (session.measurements || session.contour)) {
        const hit = hitTest(pt.x, pt.y);
        if (hit) {
          if (hit.type === 'marker') {
            dragRef.current = { which: hit.which, contourHandle: null };
          } else {
            dragRef.current = { which: null, contourHandle: { side: hit.side, index: hit.index } };
          }
          el.style.cursor = 'grabbing';
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        return;
      }
      if (mode === 'none') return;

      const wp = canvasToWorld(pt);

      if (mode === 'calibration-line') {
        console.log('[QCA] calibration-line click', pt, 'start:', calibLineStartRef.current);
        e.preventDefault();
        e.stopPropagation();
        if (!calibLineStartRef.current) {
          calibLineStartRef.current = pt;
          calibLineStartWorldRef.current = wp;
        } else {
          const start = calibLineStartRef.current;
          const startWorld = calibLineStartWorldRef.current;
          if (startWorld && wp && session.calibration) {
            const widthPx = Math.hypot(pt.x - start.x, pt.y - start.y);
            const mmPerPixel = session.calibration.catheterDiameterMm / widthPx;
            dispatch({ type: 'SET_CALIBRATION', data: { ...session.calibration, mmPerPixel, catheterPixelWidth: widthPx, catheterLine: [startWorld, wp] } });
          }
          calibLineStartRef.current = null;
          calibLineStartWorldRef.current = null;
          dispatch({ type: 'SET_INTERACTION', mode: 'none' });
        }
        e.preventDefault(); e.stopPropagation();
        return;
      }

      if (!wp) return;

      if (mode === 'place-proximal') {
        dispatch({ type: 'SET_PROXIMAL', point: wp });
        dispatch({ type: 'SET_INTERACTION', mode: 'place-centerline' });
        e.preventDefault(); e.stopPropagation();
        return;
      }
      if (mode === 'place-centerline') {
        dispatch({ type: 'ADD_CENTERLINE_POINT', point: wp });
        e.preventDefault(); e.stopPropagation();
        return;
      }
      if (mode === 'place-distal') {
        dispatch({ type: 'SET_DISTAL', point: wp });
        dispatch({ type: 'SET_INTERACTION', mode: 'none' });
        if (session.proximalPoint && session.calibration) {
          runContourDetection(session.proximalPoint, wp, session.centerlinePoints, session.calibration.mmPerPixel, vp);
        }
        e.preventDefault(); e.stopPropagation();
        return;
      }
    };

    const onDblClick = (e: MouseEvent) => {
      const session = sessionRef.current;
      const dispatch = dispatchRef.current;
      if (!session || !dispatch || session.interactionMode !== 'place-centerline') return;
      const pt = eventToCanvas(e);
      const wp = canvasToWorld(pt);
      if (!wp) return;
      dispatch({ type: 'SET_DISTAL', point: wp });
      dispatch({ type: 'SET_INTERACTION', mode: 'none' });
      if (session.proximalPoint && session.calibration) {
        runContourDetection(session.proximalPoint, wp, session.centerlinePoints, session.calibration.mmPerPixel, vp);
      }
      e.preventDefault(); e.stopPropagation();
    };

    const onMouseMove = (e: MouseEvent) => {
      const session = sessionRef.current;
      if (!session) return;

      // Dragging a P/D marker or contour handle
      if (dragRef.current.which || dragRef.current.contourHandle) {
        el.style.cursor = 'grabbing';
        mousePosRef.current = eventToCanvas(e);

        // Live update contour handle + smooth neighbors during drag
        if (dragRef.current.contourHandle && session.contour) {
          const pt = eventToCanvas(e);
          const wp = canvasToWorld(pt);
          if (wp) {
            const { side, index } = dragRef.current.contourHandle;
            const origBorder = side === 'left' ? session.contour.leftBorder : session.contour.rightBorder;
            const border = [...origBorder];
            if (index < border.length) {
              // Move the handle point
              const delta: [number, number, number] = [
                wp[0] - border[index][0],
                wp[1] - border[index][1],
                wp[2] - border[index][2],
              ];
              // Apply gaussian falloff to neighbors — smooth transition
              const HANDLE_STEP = Math.max(1, Math.floor(border.length / 12));
              const radius = Math.floor(HANDLE_STEP * 1.8); // wider influence for smoother curves
              for (let i = Math.max(0, index - radius); i <= Math.min(border.length - 1, index + radius); i++) {
                const dist = Math.abs(i - index);
                const weight = Math.exp(-(dist * dist) / (radius * radius * 0.5)); // gaussian
                border[i] = [
                  origBorder[i][0] + delta[0] * weight,
                  origBorder[i][1] + delta[1] * weight,
                  origBorder[i][2] + delta[2] * weight,
                ] as WorldPoint;
              }

              const updatedContour = { ...session.contour };
              if (side === 'left') updatedContour.leftBorder = border;
              else updatedContour.rightBorder = border;

              // Recalculate diameters
              const diameters: number[] = [];
              const mmPx = session.calibration?.mmPerPixel ?? 0.1;
              for (let i = 0; i < updatedContour.leftBorder.length && i < updatedContour.rightBorder.length; i++) {
                const lc = vp.worldToCanvas(updatedContour.leftBorder[i] as cornerstone.Types.Point3);
                const rc = vp.worldToCanvas(updatedContour.rightBorder[i] as cornerstone.Types.Point3);
                if (lc && rc) {
                  diameters.push(Math.hypot(lc[0] - rc[0], lc[1] - rc[1]) * mmPx);
                } else {
                  diameters.push(updatedContour.diameters[i] ?? 1);
                }
              }
              updatedContour.diameters = diameters;
              updatedContour.areas = diameters.map(d => Math.PI * (d / 2) ** 2);
              sessionRef.current = { ...session, contour: updatedContour };
            }
          }
        }

        redrawRef.current();
        e.preventDefault(); e.stopPropagation();
        return;
      }

      if (session.interactionMode !== 'none') {
        el.style.cursor = 'crosshair';
        mousePosRef.current = eventToCanvas(e);
        redrawRef.current();
      } else if (session.measurements || session.contour) {
        const pt = eventToCanvas(e);
        const hit = hitTest(pt.x, pt.y);
        el.style.cursor = hit ? 'grab' : '';
        mousePosRef.current = null;
      } else {
        el.style.cursor = '';
        mousePosRef.current = null;
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      if (!dragRef.current.which && !dragRef.current.contourHandle) return;
      const session = sessionRef.current;
      const dispatch = dispatchRef.current;
      if (!session || !dispatch) return;

      const pt = eventToCanvas(e);
      const wp = canvasToWorld(pt);

      if (dragRef.current.which && wp) {
        // P/D marker drag finished — only move marker, preserve contour
        if (dragRef.current.which === 'proximal') dispatch({ type: 'MOVE_PROXIMAL', point: wp });
        else dispatch({ type: 'MOVE_DISTAL', point: wp });
      } else if (dragRef.current.contourHandle && session.contour) {
        // Contour handle drag finished — commit the updated contour
        const updatedContour = sessionRef.current?.contour;
        if (updatedContour) {
          const refDiameters = computeReferenceDiameters(updatedContour);
          const measurements = computeQCAMeasurements(updatedContour, refDiameters);
          dispatch({ type: 'SET_CONTOUR', contour: updatedContour, refDiameters, measurements });
        }
      }

      dragRef.current = { which: null, contourHandle: null };
      el.style.cursor = '';
      mousePosRef.current = null;
    };

    // Right-click on contour: find nearest border point and start dragging it
    const onContextMenu = (e: MouseEvent) => {
      const session = sessionRef.current;
      if (!session?.contour || session.interactionMode !== 'none') return;

      const pt = eventToCanvas(e);
      // Find nearest border point (left or right) to the click
      let bestDist = 20; // max 20px search radius
      let bestSide: 'left' | 'right' = 'left';
      let bestIdx = -1;

      for (const side of ['left', 'right'] as const) {
        const border = side === 'left' ? session.contour.leftBorder : session.contour.rightBorder;
        for (let i = 0; i < border.length; i++) {
          const cp = vp.worldToCanvas(border[i] as cornerstone.Types.Point3);
          if (!cp) continue;
          const d = Math.hypot(cp[0] - pt.x, cp[1] - pt.y);
          if (d < bestDist) {
            bestDist = d;
            bestSide = side;
            bestIdx = i;
          }
        }
      }

      if (bestIdx >= 0) {
        e.preventDefault();
        e.stopPropagation();
        dragRef.current = { which: null, contourHandle: { side: bestSide, index: bestIdx } };
        el.style.cursor = 'grabbing';
      }
    };

    el.addEventListener('mousedown', onMouseDown, true);
    el.addEventListener('dblclick', onDblClick, true);
    el.addEventListener('contextmenu', onContextMenu, true);
    el.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    return () => {
      el.removeEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, onCamera as EventListener);
      el.removeEventListener(cornerstone.Enums.Events.IMAGE_RENDERED, onRendered as EventListener);
      el.removeEventListener('mousedown', onMouseDown, true);
      el.removeEventListener('dblclick', onDblClick, true);
      el.removeEventListener('contextmenu', onContextMenu, true);
      el.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      ro.disconnect();
      // Clean up SVG overlay
      const svgLayer = el.querySelector('.svg-layer') as SVGSVGElement | null;
      if (svgLayer) clearQCASvg(svgLayer);
    };
  }, [renderingEngineId, viewportId, getViewport, qcaSession != null]);

  // ── Contour detection ──
  function runContourDetection(proxWp: WorldPoint, distWp: WorldPoint, guideWps: WorldPoint[], mmPerPixel: number, vp: cornerstone.Types.IStackViewport) {
    const vpCanvas = vp.element?.querySelector('canvas.cornerstone-canvas') as HTMLCanvasElement | null;
    if (!vpCanvas || !dispatchRef.current) return;

    const toCanvas = (wp: WorldPoint): Point2D => {
      const cp = vp.worldToCanvas(wp as cornerstone.Types.Point3);
      return { x: cp[0], y: cp[1] };
    };
    const el = vp.element;
    const scaleX = vpCanvas.width / el.clientWidth;
    const scaleY = vpCanvas.height / el.clientHeight;
    const scale = (p: Point2D) => ({ x: p.x * scaleX, y: p.y * scaleY });
    const unscale = (p: Point2D) => ({ x: p.x / scaleX, y: p.y / scaleY });

    try {
      // Search radius in buffer-pixel space. For typical XA display at dpr=2
      // and fine calibrations (~0.03-0.05 mm/px), a 5 mm half-width corresponds
      // to ~100-150 buffer pixels. The previous default of 50 clipped the
      // scanline before reaching the background and forced the edge detector
      // to pick the dense contrast core instead of the vessel wall.
      const radiusMm = 6; // expected max half-width of coronary vessel
      const radiusBufferPx = Math.max(40, Math.round(radiusMm / (mmPerPixel / scaleX)));
      const searchRadius = Math.min(200, radiusBufferPx);
      const contour = detectVesselContour(vpCanvas, scale(toCanvas(proxWp)), scale(toCanvas(distWp)), guideWps.map(w => scale(toCanvas(w))), mmPerPixel / scaleX, searchRadius);
      const pxToWorld = (p: Point2D): WorldPoint => vp.canvasToWorld([unscale(p).x, unscale(p).y]) as WorldPoint;
      const wc: VesselContour = {
        centerline: contour.centerline.map(pxToWorld),
        leftBorder: contour.leftBorder.map(pxToWorld),
        rightBorder: contour.rightBorder.map(pxToWorld),
        diameters: contour.diameters, areas: contour.areas, cumulativeLength: contour.cumulativeLength,
      };
      const refD = computeReferenceDiameters(wc);
      const meas = computeQCAMeasurements(wc, refD);
      dispatchRef.current({ type: 'SET_CONTOUR', contour: wc, refDiameters: refD, measurements: meas });
    } catch (err) { console.error('Contour detection failed:', err); }
  }

  // Context menu suppression
  useEffect(() => {
    const h = (e: MouseEvent) => { if ((e.target as HTMLElement)?.closest('.viewport-canvas')) e.preventDefault(); };
    document.addEventListener('contextmenu', h);
    return () => document.removeEventListener('contextmenu', h);
  }, []);

  // Watch the viewport element for size changes. The initial mount often
  // reports a zero-height rect because layout has not settled yet, which
  // leaves the Cornerstone canvas stuck at its 300x150 default. When the
  // element grows we nudge the rendering engine to recompute dimensions
  // and repaint, which turns the black viewport into a live image.
  useEffect(() => {
    const el = document.getElementById('viewport-angio');
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const engine = cornerstone.getRenderingEngine(renderingEngineId);
      if (!engine) return;
      try { engine.resize(true, true); } catch { /* ignore */ }
      const vp = engine.getViewport(viewportId) as cornerstone.Types.IStackViewport | undefined;
      if (vp && el.clientHeight > 0 && el.clientWidth > 0) {
        try { vp.render(); } catch { /* ignore */ }
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [renderingEngineId, viewportId]);

  return (
    <div className="angio-viewer">
      <div className="angio-viewport-shell">
        <div id="viewport-angio" className="viewport-canvas" />
      </div>
      <CineControls
        renderingEngineId={renderingEngineId}
        viewportId={viewportId}
        imageCount={imageCount}
        currentIndex={currentFrame}
        onFrameChange={onFrameChange}
        seriesIndex={seriesIndex}
        seriesCount={seriesCount}
        onPrevSeries={onPrevSeries}
        onNextSeries={onNextSeries}
      />
    </div>
  );
}
