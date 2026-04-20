import { useEffect, useState, useRef, useCallback } from 'react';
import * as cornerstone from '@cornerstonejs/core';

interface Props {
  viewportId: string;
  renderingEngineId: string;
}

const DIRECTIONS: { axis: [number, number, number]; pos: string; neg: string }[] = [
  { axis: [1, 0, 0], pos: 'L', neg: 'R' },
  { axis: [0, 1, 0], pos: 'P', neg: 'A' },
  { axis: [0, 0, 1], pos: 'S', neg: 'I' },
];

function getOrientationLabels(viewPlaneNormal: number[], viewUp: number[]) {
  const up = viewUp;
  const right = [
    up[1] * viewPlaneNormal[2] - up[2] * viewPlaneNormal[1],
    up[2] * viewPlaneNormal[0] - up[0] * viewPlaneNormal[2],
    up[0] * viewPlaneNormal[1] - up[1] * viewPlaneNormal[0],
  ];

  function getLabel(dir: number[]): string {
    let bestLabel = '';
    let bestDot = 0;
    for (const d of DIRECTIONS) {
      const dt = dir[0] * d.axis[0] + dir[1] * d.axis[1] + dir[2] * d.axis[2];
      if (Math.abs(dt) > Math.abs(bestDot)) {
        bestDot = dt;
        bestLabel = dt > 0 ? d.pos : d.neg;
      }
    }
    return bestLabel;
  }

  return {
    top: getLabel(up),
    bottom: getLabel(up.map(v => -v)),
    right: getLabel(right),
    left: getLabel(right.map(v => -v)),
  };
}

export function OrientationOverlay({ viewportId, renderingEngineId }: Props) {
  const [labels, setLabels] = useState<{ top: string; bottom: string; left: string; right: string } | null>(null);
  const cubeCanvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);

  const drawCube = useCallback((vpn: number[], up: number[]) => {
    const canvas = cubeCanvasRef.current;
    if (!canvas) return;

    const size = 50;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    const right = [
      up[1] * vpn[2] - up[2] * vpn[1],
      up[2] * vpn[0] - up[0] * vpn[2],
      up[0] * vpn[1] - up[1] * vpn[0],
    ];

    const cx = size / 2;
    const cy = size / 2;
    const s = 15;

    const project = (x: number, y: number, z: number): [number, number] => {
      const px = x * right[0] + y * right[1] + z * right[2];
      const py = -(x * up[0] + y * up[1] + z * up[2]);
      const pz = x * vpn[0] + y * vpn[1] + z * vpn[2];
      const sc = 1 + pz * 0.15;
      return [cx + px * s * sc, cy + py * s * sc];
    };

    ctx.clearRect(0, 0, size, size);

    const vertices = [
      [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
      [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
    ];
    const edges = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];

    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    for (const [a, b] of edges) {
      const [x1, y1] = project(vertices[a][0], vertices[a][1], vertices[a][2]);
      const [x2, y2] = project(vertices[b][0], vertices[b][1], vertices[b][2]);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    const faceLabels = [
      { pos: [1.4, 0, 0] as const, label: 'L', color: '#ff6b6b' },
      { pos: [-1.4, 0, 0] as const, label: 'R', color: '#ff6b6b' },
      { pos: [0, 1.4, 0] as const, label: 'P', color: '#4ecdc4' },
      { pos: [0, -1.4, 0] as const, label: 'A', color: '#4ecdc4' },
      { pos: [0, 0, 1.4] as const, label: 'S', color: '#ffe66d' },
      { pos: [0, 0, -1.4] as const, label: 'I', color: '#ffe66d' },
    ];

    ctx.font = 'bold 9px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const projected = faceLabels.map(f => {
      const [px, py] = project(f.pos[0], f.pos[1], f.pos[2]);
      const depth = f.pos[0] * vpn[0] + f.pos[1] * vpn[1] + f.pos[2] * vpn[2];
      return { ...f, px, py, depth };
    });
    projected.sort((a, b) => a.depth - b.depth);

    for (const f of projected) {
      ctx.globalAlpha = f.depth > 0 ? 1.0 : 0.3;
      ctx.fillStyle = f.color;
      ctx.fillText(f.label, f.px, f.py);
    }
    ctx.globalAlpha = 1;
  }, []);

  const updateOrientation = useCallback(() => {
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    if (!engine) return;
    const vp = engine.getViewport(viewportId);
    if (!vp) return;
    const cam = vp.getCamera();
    if (!cam.viewPlaneNormal || !cam.viewUp) return;
    setLabels(getOrientationLabels(cam.viewPlaneNormal as number[], cam.viewUp as number[]));
    drawCube(cam.viewPlaneNormal as number[], cam.viewUp as number[]);
  }, [viewportId, renderingEngineId, drawCube]);

  useEffect(() => {
    const poll = () => {
      updateOrientation();
      animRef.current = requestAnimationFrame(poll);
    };
    const timer = setTimeout(() => { animRef.current = requestAnimationFrame(poll); }, 500);
    return () => { clearTimeout(timer); cancelAnimationFrame(animRef.current); };
  }, [updateOrientation]);

  if (!labels) return null;

  return (
    <div className="orientation-overlay">
      <span className="orient-label orient-top">{labels.top}</span>
      <span className="orient-label orient-bottom">{labels.bottom}</span>
      <span className="orient-label orient-left">{labels.left}</span>
      <span className="orient-label orient-right">{labels.right}</span>
      <canvas ref={cubeCanvasRef} className="orient-cube" />
    </div>
  );
}
