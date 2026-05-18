import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import type { DicomSeriesInfo } from '../core/dicomLoader';
import {
  buildView,
  epipolarLine,
  reconstructCenterline,
  viewSeparation,
  type View,
  type Vec3,
} from './geometry';

interface BiplanePanelProps {
  seriesList: DicomSeriesInfo[];
  onClose: () => void;
}

type PaneId = 'A' | 'B';

interface PaneState {
  seriesUid: string | null;
  frame: number;
  points: Array<{ u: number; v: number }>;
}

const EMPTY_PANE: PaneState = { seriesUid: null, frame: 0, points: [] };

export function BiplanePanel({ seriesList, onClose }: BiplanePanelProps) {
  const xaSeries = useMemo(
    () => seriesList.filter((s) => s.geometry != null && s.imageIds.length > 0),
    [seriesList]
  );

  const [paneA, setPaneA] = useState<PaneState>(EMPTY_PANE);
  const [paneB, setPaneB] = useState<PaneState>(EMPTY_PANE);
  const [hoverA, setHoverA] = useState<{ u: number; v: number } | null>(null);
  const [hoverB, setHoverB] = useState<{ u: number; v: number } | null>(null);
  const [points3D, setPoints3D] = useState<Vec3[]>([]);
  const [residuals, setResiduals] = useState<number[]>([]);
  const [meanRes, setMeanRes] = useState(0);
  const [maxRes, setMaxRes] = useState(0);
  const [rotation, setRotation] = useState({ yaw: 30, pitch: -20 });
  const [zoom, setZoom] = useState(1);

  // Auto-pick first two distinct series if empty
  useEffect(() => {
    if (!paneA.seriesUid && xaSeries[0]) {
      setPaneA({ seriesUid: xaSeries[0].seriesInstanceUID, frame: 0, points: [] });
    }
    if (!paneB.seriesUid && xaSeries[1]) {
      setPaneB({ seriesUid: xaSeries[1].seriesInstanceUID, frame: 0, points: [] });
    } else if (!paneB.seriesUid && xaSeries[0] && xaSeries.length === 1) {
      setPaneB({ seriesUid: xaSeries[0].seriesInstanceUID, frame: 0, points: [] });
    }
  }, [xaSeries, paneA.seriesUid, paneB.seriesUid]);

  const seriesA = xaSeries.find((s) => s.seriesInstanceUID === paneA.seriesUid) ?? null;
  const seriesB = xaSeries.find((s) => s.seriesInstanceUID === paneB.seriesUid) ?? null;

  const viewA: View | null = seriesA?.geometry ? buildView(seriesA.geometry) : null;
  const viewB: View | null = seriesB?.geometry ? buildView(seriesB.geometry) : null;

  const separation = viewA && viewB ? viewSeparation(viewA, viewB) : 0;

  const updatePane = useCallback((id: PaneId, patch: Partial<PaneState>) => {
    if (id === 'A') setPaneA((prev) => ({ ...prev, ...patch }));
    else setPaneB((prev) => ({ ...prev, ...patch }));
  }, []);

  const addPoint = useCallback((id: PaneId, p: { u: number; v: number }) => {
    if (id === 'A') setPaneA((prev) => ({ ...prev, points: [...prev.points, p] }));
    else setPaneB((prev) => ({ ...prev, points: [...prev.points, p] }));
  }, []);

  const undoPoint = useCallback((id: PaneId) => {
    if (id === 'A') setPaneA((prev) => ({ ...prev, points: prev.points.slice(0, -1) }));
    else setPaneB((prev) => ({ ...prev, points: prev.points.slice(0, -1) }));
  }, []);

  const clearPoints = useCallback((id: PaneId) => {
    if (id === 'A') setPaneA((prev) => ({ ...prev, points: [] }));
    else setPaneB((prev) => ({ ...prev, points: [] }));
  }, []);

  const reconstruct = useCallback(() => {
    if (!viewA || !viewB) return;
    const n = Math.min(paneA.points.length, paneB.points.length);
    if (n < 2) {
      setPoints3D([]);
      setResiduals([]);
      return;
    }
    const result = reconstructCenterline(viewA, paneA.points.slice(0, n), viewB, paneB.points.slice(0, n));
    setPoints3D(result.points3D);
    setResiduals(result.residuals);
    setMeanRes(result.meanResidual);
    setMaxRes(result.maxResidual);
  }, [viewA, viewB, paneA.points, paneB.points]);

  // Auto-recompute when points change
  useEffect(() => {
    reconstruct();
  }, [reconstruct]);

  const exportJson = useCallback(() => {
    if (points3D.length === 0) return;
    const payload = {
      timestamp: new Date().toISOString(),
      viewA: viewA
        ? { angles: viewA.raw, points: paneA.points, frame: paneA.frame, series: seriesA?.seriesDescription }
        : null,
      viewB: viewB
        ? { angles: viewB.raw, points: paneB.points, frame: paneB.frame, series: seriesB?.seriesDescription }
        : null,
      points3D,
      residuals,
      meanResidual: meanRes,
      maxResidual: maxRes,
      angularSeparation: separation,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `biplane-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [points3D, residuals, meanRes, maxRes, separation, viewA, viewB, paneA, paneB, seriesA, seriesB]);

  return (
    <div className="biplane-overlay">
      <div className="biplane-modal">
        <header className="biplane-header">
          <div>
            <h2>Biplane 3D Reconstruction</h2>
            <p>
              Mark <strong>matched</strong> centerline points on both views in proximal-to-distal order.
              {separation > 0 && (
                <>
                  {' '}Angular separation: <strong>{separation.toFixed(1)}°</strong>
                  {separation < 30 && <span className="biplane-warn"> (low &lt; 30°, accuracy poor)</span>}
                </>
              )}
            </p>
          </div>
          <button className="biplane-close" onClick={onClose} aria-label="Kapat">✕</button>
        </header>

        {xaSeries.length < 2 ? (
          <div className="biplane-empty">
            <p>
              Biplane reconstruction needs at least <strong>two angiography series</strong> with C-arm
              geometry tags (Positioner angles + SID/SOD). Currently loaded: <strong>{xaSeries.length}</strong>.
            </p>
            <p>Load two acquisitions from different projection angles to use this tool.</p>
          </div>
        ) : (
          <>
            <div className="biplane-panes">
              <BiplanePane
                id="A"
                label="View A"
                xaSeries={xaSeries}
                pane={paneA}
                view={viewA}
                hover={hoverA}
                hoverFromOther={
                  viewA && viewB && hoverB ? epipolarLine(viewB, hoverB, viewA) : null
                }
                onUpdate={updatePane}
                onAddPoint={addPoint}
                onHover={setHoverA}
                onUndo={undoPoint}
                onClear={clearPoints}
              />
              <BiplanePane
                id="B"
                label="View B"
                xaSeries={xaSeries}
                pane={paneB}
                view={viewB}
                hover={hoverB}
                hoverFromOther={
                  viewA && viewB && hoverA ? epipolarLine(viewA, hoverA, viewB) : null
                }
                onUpdate={updatePane}
                onAddPoint={addPoint}
                onHover={setHoverB}
                onUndo={undoPoint}
                onClear={clearPoints}
              />
            </div>

            <div className="biplane-bottom">
              <Viewer3D
                points={points3D}
                residuals={residuals}
                rotation={rotation}
                setRotation={setRotation}
                zoom={zoom}
                setZoom={setZoom}
              />
              <aside className="biplane-stats">
                <h3>Reconstruction</h3>
                <Stat label="Points" value={String(points3D.length)} />
                <Stat label="Mean residual" value={`${meanRes.toFixed(2)} mm`} />
                <Stat label="Max residual" value={`${maxRes.toFixed(2)} mm`} />
                <Stat label="Length (3D)" value={`${pathLength(points3D).toFixed(1)} mm`} />
                <div className="biplane-actions">
                  <button onClick={exportJson} disabled={points3D.length === 0}>
                    Export JSON
                  </button>
                </div>
                <p className="biplane-note">
                  Residual = perpendicular distance between back-projected rays. &lt;1 mm good, &gt;3 mm
                  re-check correspondence.
                </p>
              </aside>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface PaneProps {
  id: PaneId;
  label: string;
  xaSeries: DicomSeriesInfo[];
  pane: PaneState;
  view: View | null;
  hover: { u: number; v: number } | null;
  hoverFromOther: { p1: { u: number; v: number }; p2: { u: number; v: number } } | null;
  onUpdate: (id: PaneId, patch: Partial<PaneState>) => void;
  onAddPoint: (id: PaneId, p: { u: number; v: number }) => void;
  onHover: (p: { u: number; v: number } | null) => void;
  onUndo: (id: PaneId) => void;
  onClear: (id: PaneId) => void;
}

function BiplanePane({
  id,
  label,
  xaSeries,
  pane,
  view,
  hover,
  hoverFromOther,
  onUpdate,
  onAddPoint,
  onHover,
  onUndo,
  onClear,
}: PaneProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const series = xaSeries.find((s) => s.seriesInstanceUID === pane.seriesUid) ?? null;
  const imageId = series && pane.frame < series.imageIds.length ? series.imageIds[pane.frame] : null;
  const [loading, setLoading] = useState(false);

  // Render frame to canvas
  useEffect(() => {
    let cancelled = false;
    async function render() {
      if (!canvasRef.current || !imageId || !view) return;
      setLoading(true);
      canvasRef.current.width = view.columns;
      canvasRef.current.height = view.rows;
      try {
        await cornerstone.utilities.loadImageToCanvas({
          canvas: canvasRef.current,
          imageId,
          requestType: cornerstone.Enums.RequestType.Thumbnail,
          imageAspect: true,
        });
      } catch (err) {
        console.warn('[biplane] failed to render', err);
      }
      if (!cancelled) setLoading(false);
    }
    void render();
    return () => {
      cancelled = true;
    };
  }, [imageId, view]);

  // Render overlay (points, hover, epipolar line)
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay || !view) return;
    overlay.width = view.columns;
    overlay.height = view.rows;
    const ctx = overlay.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    if (hoverFromOther) {
      ctx.strokeStyle = '#f0b400';
      ctx.lineWidth = Math.max(1, view.columns / 800);
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(hoverFromOther.p1.u, hoverFromOther.p1.v);
      ctx.lineTo(hoverFromOther.p2.u, hoverFromOther.p2.v);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (pane.points.length > 1) {
      ctx.strokeStyle = '#2f81f7';
      ctx.lineWidth = Math.max(1, view.columns / 400);
      ctx.beginPath();
      ctx.moveTo(pane.points[0].u, pane.points[0].v);
      for (let i = 1; i < pane.points.length; i += 1) {
        ctx.lineTo(pane.points[i].u, pane.points[i].v);
      }
      ctx.stroke();
    }

    const r = Math.max(3, view.columns / 100);
    pane.points.forEach((pt, i) => {
      ctx.fillStyle = '#2f81f7';
      ctx.beginPath();
      ctx.arc(pt.u, pt.v, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1, view.columns / 1200);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = `${Math.max(10, view.columns / 50)}px sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${i + 1}`, pt.u + r + 2, pt.v);
    });

    if (hover) {
      ctx.strokeStyle = '#79c0ff';
      ctx.lineWidth = Math.max(1, view.columns / 600);
      ctx.beginPath();
      ctx.arc(hover.u, hover.v, r * 1.3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [pane.points, hover, hoverFromOther, view]);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!view) return;
      const target = e.currentTarget;
      const rect = target.getBoundingClientRect();
      const u = ((e.clientX - rect.left) / rect.width) * view.columns;
      const v = ((e.clientY - rect.top) / rect.height) * view.rows;
      onAddPoint(id, { u, v });
    },
    [id, onAddPoint, view]
  );

  const handleMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!view) return;
      const target = e.currentTarget;
      const rect = target.getBoundingClientRect();
      const u = ((e.clientX - rect.left) / rect.width) * view.columns;
      const v = ((e.clientY - rect.top) / rect.height) * view.rows;
      onHover({ u, v });
    },
    [onHover, view]
  );

  return (
    <div className="biplane-pane">
      <div className="biplane-pane-head">
        <span className="biplane-pane-label">{label}</span>
        <select
          value={pane.seriesUid ?? ''}
          onChange={(e) => onUpdate(id, { seriesUid: e.target.value, frame: 0, points: [] })}
        >
          {xaSeries.map((s) => (
            <option key={s.seriesInstanceUID} value={s.seriesInstanceUID}>
              {s.seriesDescription || s.seriesInstanceUID.slice(-12)} ·{' '}
              {s.geometry ? `${s.geometry.primaryAngle.toFixed(0)}/${s.geometry.secondaryAngle.toFixed(0)}` : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="biplane-canvas-wrap">
        <canvas ref={canvasRef} className="biplane-canvas-image" />
        <canvas
          ref={overlayRef}
          className="biplane-canvas-overlay"
          onClick={handleClick}
          onMouseMove={handleMove}
          onMouseLeave={() => onHover(null)}
        />
        {loading && <div className="biplane-loading">Loading…</div>}
      </div>
      <div className="biplane-pane-foot">
        {series && (
          <>
            <label>
              Frame
              <input
                type="range"
                min={0}
                max={Math.max(0, series.imageIds.length - 1)}
                value={pane.frame}
                onChange={(e) => onUpdate(id, { frame: Number.parseInt(e.target.value, 10) })}
              />
              <span>{pane.frame + 1}/{series.imageIds.length}</span>
            </label>
            <div className="biplane-pane-actions">
              <button onClick={() => onUndo(id)} disabled={pane.points.length === 0}>Undo</button>
              <button onClick={() => onClear(id)} disabled={pane.points.length === 0}>Clear</button>
              <span className="biplane-count">{pane.points.length} pts</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface Viewer3DProps {
  points: Vec3[];
  residuals: number[];
  rotation: { yaw: number; pitch: number };
  setRotation: (r: { yaw: number; pitch: number }) => void;
  zoom: number;
  setZoom: (z: number) => void;
}

function Viewer3D({ points, residuals, rotation, setRotation, zoom, setZoom }: Viewer3DProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draggingRef = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth * dpr;
    const h = canvas.clientHeight * dpr;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (points.length === 0) {
      ctx.fillStyle = '#7d8590';
      ctx.font = `${14 * dpr}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('Mark ≥ 2 matching points on both views', canvas.width / 2, canvas.height / 2);
      return;
    }

    // Bounding box → center & scale
    let cx = 0, cy = 0, cz = 0;
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const p of points) {
      cx += p[0]; cy += p[1]; cz += p[2];
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
      if (p[2] < minZ) minZ = p[2]; if (p[2] > maxZ) maxZ = p[2];
    }
    cx /= points.length; cy /= points.length; cz /= points.length;
    const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 10);
    const scale = (Math.min(canvas.width, canvas.height) * 0.42 * zoom) / extent;

    const yaw = rotation.yaw * Math.PI / 180;
    const pitch = rotation.pitch * Math.PI / 180;
    const cYaw = Math.cos(yaw), sYaw = Math.sin(yaw);
    const cPitch = Math.cos(pitch), sPitch = Math.sin(pitch);

    const cw = canvas.width;
    const ch = canvas.height;

    function project(p: Vec3): { x: number; y: number; depth: number } {
      const x = p[0] - cx;
      const y = p[1] - cy;
      const z = p[2] - cz;
      const x1 = cYaw * x + sYaw * y;
      const y1 = -sYaw * x + cYaw * y;
      const z1 = z;
      const y2 = cPitch * y1 - sPitch * z1;
      const z2 = sPitch * y1 + cPitch * z1;
      return {
        x: cw / 2 + x1 * scale,
        y: ch / 2 - z2 * scale,
        depth: y2,
      };
    }

    // Axis triad
    const axisLen = 20;
    const origin = project([cx, cy, cz]);
    const triads: Array<{ end: Vec3; color: string; label: string }> = [
      { end: [cx + axisLen, cy, cz], color: '#ff6b6b', label: 'L' },
      { end: [cx, cy + axisLen, cz], color: '#6bff6b', label: 'P' },
      { end: [cx, cy, cz + axisLen], color: '#6bb6ff', label: 'S' },
    ];
    for (const t of triads) {
      const end = project(t.end);
      ctx.strokeStyle = t.color;
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.moveTo(origin.x, origin.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      ctx.fillStyle = t.color;
      ctx.font = `${12 * dpr}px sans-serif`;
      ctx.fillText(t.label, end.x + 4, end.y - 4);
    }

    // Vessel polyline
    const projected = points.map(project);
    ctx.strokeStyle = '#2f81f7';
    ctx.lineWidth = 2.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(projected[0].x, projected[0].y);
    for (let i = 1; i < projected.length; i += 1) {
      ctx.lineTo(projected[i].x, projected[i].y);
    }
    ctx.stroke();

    // Points colored by residual (green→yellow→red)
    for (let i = 0; i < projected.length; i += 1) {
      const r = residuals[i] ?? 0;
      const color = residualColor(r);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(projected[i].x, projected[i].y, 4 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = '#7d8590';
    ctx.font = `${11 * dpr}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText(`drag to rotate · wheel to zoom · yaw ${rotation.yaw.toFixed(0)}° / pitch ${rotation.pitch.toFixed(0)}°`, 8 * dpr, canvas.height - 8 * dpr);
  }, [points, residuals, rotation, zoom]);

  return (
    <canvas
      ref={canvasRef}
      className="biplane-3d-canvas"
      onMouseDown={(e) => {
        draggingRef.current = { x: e.clientX, y: e.clientY, yaw: rotation.yaw, pitch: rotation.pitch };
      }}
      onMouseMove={(e) => {
        const d = draggingRef.current;
        if (!d) return;
        setRotation({
          yaw: d.yaw + (e.clientX - d.x) * 0.5,
          pitch: Math.max(-89, Math.min(89, d.pitch + (e.clientY - d.y) * 0.5)),
        });
      }}
      onMouseUp={() => { draggingRef.current = null; }}
      onMouseLeave={() => { draggingRef.current = null; }}
      onWheel={(e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        setZoom(Math.max(0.2, Math.min(5, zoom * factor)));
      }}
    />
  );
}

function residualColor(r: number): string {
  if (!Number.isFinite(r)) return '#ff5252';
  if (r < 1) return '#3fb950';
  if (r < 3) return '#f0b400';
  return '#ff5252';
}

function pathLength(points: Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    const dz = points[i][2] - points[i - 1][2];
    total += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return total;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="biplane-stat">
      <span className="biplane-stat-label">{label}</span>
      <span className="biplane-stat-value">{value}</span>
    </div>
  );
}
