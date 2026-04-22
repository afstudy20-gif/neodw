import React, { useRef, useEffect, useCallback, useState } from 'react';
import { TAVIVector3D } from '../tavi/TAVITypes';
import { TAVIGeometry } from '../tavi/TAVIGeometry';

interface ValveVisualization3DProps {
  /** Annulus contour world points */
  annulusContour?: TAVIVector3D[];
  /** Annulus plane normal */
  annulusNormal?: TAVIVector3D;
  /** Annulus centroid */
  annulusCentroid?: TAVIVector3D;
  /** Cusp positions */
  cuspLCC?: TAVIVector3D;
  cuspNCC?: TAVIVector3D;
  cuspRCC?: TAVIVector3D;
  /** Aortic axis direction */
  axisDirection?: TAVIVector3D;
  /** Min/max diameters */
  minDiameter?: number;
  maxDiameter?: number;
  /** Valve height (mm) for cylinder */
  valveHeight?: number;
  /** Canvas size */
  width?: number;
  height?: number;
  /** Mesh base color as 0-1 RGB triplet. Default vivid yellow. */
  meshColor?: [number, number, number];
}

const MESH_COLOR_PRESETS: Array<{ name: string; rgb: [number, number, number] }> = [
  { name: 'Vivid Yellow', rgb: [0.98, 0.88, 0.15] },
  { name: 'Electric Cyan', rgb: [0.10, 0.85, 1.00] },
  { name: 'Hot Magenta', rgb: [1.00, 0.25, 0.75] },
  { name: 'Neon Lime', rgb: [0.55, 1.00, 0.25] },
  { name: 'Vivid Orange', rgb: [1.00, 0.55, 0.10] },
  { name: 'Aortic Blue', rgb: [0.35, 0.65, 1.00] },
];

function rgbToCss(rgb: [number, number, number], alpha: number): string {
  return `rgba(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)}, ${alpha})`;
}

interface Vec3 { x: number; y: number; z: number }

/**
 * 3D Valve Visualization — Canvas 2D isometric projection.
 * Shows a translucent aortic root model with annulus contour, valve cylinder,
 * cusp positions, and axis line. Rotatable via mouse drag.
 */
export const ValveVisualization3D: React.FC<ValveVisualization3DProps> = ({
  annulusContour,
  annulusNormal,
  annulusCentroid,
  cuspLCC,
  cuspNCC,
  cuspRCC,
  axisDirection,
  minDiameter,
  maxDiameter,
  valveHeight = 26,
  width: propWidth,
  height: propHeight = 280,
  meshColor: propMeshColor,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [rotX, setRotX] = useState(-30); // degrees
  const [meshColor, setMeshColor] = useState<[number, number, number]>(propMeshColor ?? [0.98, 0.88, 0.15]);

  // Auto-size to container width
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const width = propWidth || containerWidth || 320;
  const height = propHeight;
  const [rotZ, setRotZ] = useState(20);  // degrees
  const isDragging = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });

  // 3D → 2D projection with rotation
  const project = useCallback((p: Vec3, cx: number, cy: number, scale: number): { x: number; y: number; z: number } => {
    // Center around annulus centroid
    const c = annulusCentroid || { x: 0, y: 0, z: 0 };
    let px = p.x - c.x;
    let py = p.y - c.y;
    let pz = p.z - c.z;

    // Rotate around Z axis
    const rz = (rotZ * Math.PI) / 180;
    const cosZ = Math.cos(rz), sinZ = Math.sin(rz);
    const x1 = px * cosZ - py * sinZ;
    const y1 = px * sinZ + py * cosZ;
    const z1 = pz;

    // Rotate around X axis (tilt)
    const rx = (rotX * Math.PI) / 180;
    const cosX = Math.cos(rx), sinX = Math.sin(rx);
    const x2 = x1;
    const y2 = y1 * cosX - z1 * sinX;
    const z2 = y1 * sinX + z1 * cosX;

    // Isometric projection
    return {
      x: cx + x2 * scale,
      y: cy - z2 * scale, // flip Y for screen coords
      z: y2, // depth for z-ordering
    };
  }, [rotX, rotZ, annulusCentroid]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !annulusCentroid) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    const cx = width / 2;
    const cy = height / 2 + 10;
    const avgDiam = ((minDiameter || 27) + (maxDiameter || 30)) / 2;
    const scale = Math.min(width, height) / (avgDiam * 4.5);

    // Background
    ctx.fillStyle = '#0a0e14';
    ctx.fillRect(0, 0, width, height);

    // Title
    ctx.fillStyle = '#e6edf3';
    ctx.font = 'bold 12px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Aortic Root — Valve View', cx, 16);

    const normal = annulusNormal || { x: 0, y: 0, z: 1 };
    const axis = axisDirection || normal;

    // ── Axis line ──
    const axLen = valveHeight * 1.5;
    const axP1 = project(
      TAVIGeometry.vectorAdd(annulusCentroid, TAVIGeometry.vectorScale(axis, axLen)),
      cx, cy, scale
    );
    const axP2 = project(
      TAVIGeometry.vectorAdd(annulusCentroid, TAVIGeometry.vectorScale(axis, -axLen * 0.5)),
      cx, cy, scale
    );
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(axP1.x, axP1.y);
    ctx.lineTo(axP2.x, axP2.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // ── Valve cylinder wireframe ──
    // Generate two ellipses: annulus level (bottom) and top of valve
    const nRings = 2;
    const ringHeights = [0, valveHeight];
    const nSegments = 36;

    // Create a local coordinate system on the annulus plane
    const helper = Math.abs(normal.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
    const localX = TAVIGeometry.vectorNormalize(TAVIGeometry.vectorCross(helper, normal));
    const localY = TAVIGeometry.vectorNormalize(TAVIGeometry.vectorCross(normal, localX));

    for (let ring = 0; ring < nRings; ring++) {
      const h = ringHeights[ring];
      const ringCenter = TAVIGeometry.vectorAdd(annulusCentroid, TAVIGeometry.vectorScale(axis, h));
      const r = avgDiam / 2;

      const points2D: { x: number; y: number }[] = [];
      for (let i = 0; i <= nSegments; i++) {
        const theta = (i / nSegments) * Math.PI * 2;
        const p3d: Vec3 = {
          x: ringCenter.x + localX.x * Math.cos(theta) * r + localY.x * Math.sin(theta) * r,
          y: ringCenter.y + localX.y * Math.cos(theta) * r + localY.y * Math.sin(theta) * r,
          z: ringCenter.z + localX.z * Math.cos(theta) * r + localY.z * Math.sin(theta) * r,
        };
        const p2d = project(p3d, cx, cy, scale);
        points2D.push(p2d);
      }

      // Draw ring
      ctx.strokeStyle = rgbToCss(meshColor, ring === 0 ? 0.9 : 0.5);
      ctx.lineWidth = ring === 0 ? 2 : 1;
      ctx.beginPath();
      for (let i = 0; i < points2D.length; i++) {
        if (i === 0) ctx.moveTo(points2D[i].x, points2D[i].y);
        else ctx.lineTo(points2D[i].x, points2D[i].y);
      }
      ctx.stroke();

      // Fill with translucent color
      ctx.fillStyle = rgbToCss(meshColor, ring === 0 ? 0.25 : 0.12);
      ctx.fill();
    }

    // Vertical lines connecting rings (4 lines at 90° intervals)
    for (let i = 0; i < 4; i++) {
      const theta = (i / 4) * Math.PI * 2;
      const r = avgDiam / 2;
      const bottomCenter = annulusCentroid;
      const topCenter = TAVIGeometry.vectorAdd(annulusCentroid, TAVIGeometry.vectorScale(axis, valveHeight));

      const bottom3d: Vec3 = {
        x: bottomCenter.x + localX.x * Math.cos(theta) * r + localY.x * Math.sin(theta) * r,
        y: bottomCenter.y + localX.y * Math.cos(theta) * r + localY.y * Math.sin(theta) * r,
        z: bottomCenter.z + localX.z * Math.cos(theta) * r + localY.z * Math.sin(theta) * r,
      };
      const top3d: Vec3 = {
        x: topCenter.x + localX.x * Math.cos(theta) * r + localY.x * Math.sin(theta) * r,
        y: topCenter.y + localX.y * Math.cos(theta) * r + localY.y * Math.sin(theta) * r,
        z: topCenter.z + localX.z * Math.cos(theta) * r + localY.z * Math.sin(theta) * r,
      };

      const bp = project(bottom3d, cx, cy, scale);
      const tp = project(top3d, cx, cy, scale);

      ctx.strokeStyle = rgbToCss(meshColor, 0.4);
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(bp.x, bp.y);
      ctx.lineTo(tp.x, tp.y);
      ctx.stroke();
    }

    // ── Annulus contour (if available) ──
    if (annulusContour && annulusContour.length > 3) {
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < annulusContour.length; i++) {
        const p = project(annulusContour[i], cx, cy, scale);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.stroke();
    }

    // ── Cusp markers ──
    const cusps: { point: Vec3; label: string; color: string }[] = [];
    if (cuspLCC) cusps.push({ point: cuspLCC, label: 'LC', color: '#f85149' });
    if (cuspNCC) cusps.push({ point: cuspNCC, label: 'NC', color: '#d29922' });
    if (cuspRCC) cusps.push({ point: cuspRCC, label: 'RC', color: '#3fb950' });

    for (const cusp of cusps) {
      const p = project(cusp.point, cx, cy, scale);
      // Filled circle
      ctx.fillStyle = cusp.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fill();
      // Label
      ctx.fillStyle = cusp.color;
      ctx.font = 'bold 11px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(cusp.label, p.x, p.y - 10);
    }

    // ── Diameter info ──
    ctx.fillStyle = '#6e7681';
    ctx.font = '9px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    if (minDiameter && maxDiameter) {
      ctx.fillText(`${minDiameter.toFixed(1)} × ${maxDiameter.toFixed(1)} mm`, cx, height - 8);
    }

  }, [annulusContour, annulusNormal, annulusCentroid, cuspLCC, cuspNCC, cuspRCC,
    axisDirection, minDiameter, maxDiameter, valveHeight, width, height, rotX, rotZ, project, meshColor]);

  useEffect(() => { draw(); }, [draw]);

  // Mouse drag rotation
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true;
    lastMouse.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging.current) return;
    const dx = e.clientX - lastMouse.current.x;
    const dy = e.clientY - lastMouse.current.y;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    setRotZ(prev => prev + dx * 0.5);
    setRotX(prev => Math.max(-89, Math.min(89, prev + dy * 0.5)));
  }, []);

  const handleMouseUp = useCallback(() => { isDragging.current = false; }, []);

  if (!annulusCentroid) {
    return (
      <div className="valve-viz-3d">
        <p className="tavi-step-hint">No annulus data available for 3D visualization.</p>
      </div>
    );
  }

  return (
    <div className="valve-viz-3d" ref={containerRef} style={{ width: '100%' }}>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ fontSize: 10, color: 'var(--text-soft)', alignSelf: 'center', marginRight: 4 }}>Mesh:</span>
        {MESH_COLOR_PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            onClick={() => setMeshColor(p.rgb)}
            title={p.name}
            style={{
              width: 18,
              height: 18,
              borderRadius: 4,
              cursor: 'pointer',
              background: rgbToCss(p.rgb, 1),
              border:
                meshColor[0] === p.rgb[0] && meshColor[1] === p.rgb[1] && meshColor[2] === p.rgb[2]
                  ? '2px solid var(--text)'
                  : '1px solid var(--line)',
              padding: 0,
            }}
          />
        ))}
      </div>
      <canvas
        ref={canvasRef}
        style={{ width, height, cursor: 'grab', borderRadius: 'var(--radius-md)' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      />
    </div>
  );
};
