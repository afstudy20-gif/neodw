/**
 * Inline WebGL 3D preview of LA mesh. Raw WebGL, no external 3D deps.
 * Flat Lambert shading, mouse-drag rotate, wheel zoom.
 * Re-meshes when `refreshKey` bumps.
 */
import { useEffect, useRef, useState } from 'react';
import { marchingCubesBinary, type Mesh } from './marchingCubes';
import { taubinSmooth } from './meshSmoothing';
import type { VolumeDims } from './morphology';

interface Props {
  data: Uint8Array;
  dims: VolumeDims;
  voxelToWorld: (i: number, j: number, k: number) => [number, number, number];
  refreshKey: number;
  width?: number | string;
  height?: number | string;
  /** If true, canvas fills 100% of parent and redraws on resize. */
  fill?: boolean;
  /** Optional per-vertex RGB colors (length = triangleCount * 9, rgb per vertex). */
  vertexColors?: Float32Array | null;
  /** Mesh base color (RGB 0-1). */
  baseColor?: [number, number, number];
  /** Background clear color (RGB 0-1). */
  bgColor?: [number, number, number];
  /** Mesh alpha (0.05–1). Values <1 enable blending + two-sided shading, hinting at hollow interior. */
  alpha?: number;
  /** Callback fired after mesh is built. Lets parent run per-vertex analysis (e.g., wall thickness). */
  onMesh?: (mesh: Mesh) => void;
  /** Optional replacement positions buffer (length = triangleCount * 9). Used to show epicardial offset surface. */
  displacedPositions?: Float32Array | null;
}

const VS = `
precision mediump float;
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec3 aColor;
uniform mat4 uMVP;
uniform mat4 uNormal;
uniform float uUseVertexColor;
varying vec3 vNormal;
varying vec3 vColor;
void main() {
  vNormal = normalize((uNormal * vec4(aNormal, 0.0)).xyz);
  vColor = mix(vec3(1.0), aColor, uUseVertexColor);
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const FS = `
precision mediump float;
varying vec3 vNormal;
varying vec3 vColor;
uniform vec3 uLightDir;
uniform vec3 uBaseColor;
uniform float uUseVertexColor;
uniform float uAlpha;
void main() {
  // Two-sided shading: flip normal on back faces so inside of hollow shell lights correctly.
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  // Three-point lighting in view space (always camera-relative → no dark side on rotate).
  // Key: straight at camera. Fill: lower-left, softer. Rim: upper-right counter-light.
  vec3 Lkey  = normalize(vec3( 0.0,  0.0,  1.0));
  vec3 Lfill = normalize(vec3(-0.4, -0.3,  0.8));
  vec3 Lrim  = normalize(vec3( 0.5,  0.7, -0.3));
  float dKey  = max(dot(n, Lkey),  0.0);
  float dFill = max(dot(n, Lfill), 0.0) * 0.5;
  float dRim  = pow(max(dot(n, Lrim), 0.0), 3.0) * 0.4;
  float ambient = 0.45;
  float lit = ambient + 0.55 * dKey + 0.35 * dFill + dRim;
  // Back-face slightly dimmer so viewer can tell interior from exterior.
  float facing = gl_FrontFacing ? 1.0 : 0.72;
  vec3 base = mix(uBaseColor, vColor, uUseVertexColor) * facing;
  gl_FragColor = vec4(base * lit, uAlpha);
}`;

type Mat4 = Float32Array;

function m4Identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
  return m;
}

function m4Multiply(a: Mat4, b: Mat4): Mat4 {
  // Column-major storage: m[col*4 + row] = element (row, col).
  // C = A * B, so C(row, col) = Σ A(row, k) * B(k, col)
  const o = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k];
      o[col * 4 + row] = s;
    }
  }
  return o;
}

function m4Perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

function m4Translate(tx: number, ty: number, tz: number): Mat4 {
  const m = m4Identity();
  m[12] = tx; m[13] = ty; m[14] = tz;
  return m;
}

function m4RotateX(a: number): Mat4 {
  const m = m4Identity();
  const c = Math.cos(a), s = Math.sin(a);
  m[5] = c; m[6] = s; m[9] = -s; m[10] = c;
  return m;
}

function m4RotateY(a: number): Mat4 {
  const m = m4Identity();
  const c = Math.cos(a), s = Math.sin(a);
  m[0] = c; m[2] = -s; m[8] = s; m[10] = c;
  return m;
}

function m4Scale(s: number): Mat4 {
  const m = m4Identity();
  m[0] = s; m[5] = s; m[10] = s;
  return m;
}

function computeCentroidBounds(positions: Float32Array): { center: [number, number, number]; radius: number } {
  let cx = 0, cy = 0, cz = 0;
  const n = positions.length / 3;
  for (let i = 0; i < positions.length; i += 3) {
    cx += positions[i]; cy += positions[i + 1]; cz += positions[i + 2];
  }
  cx /= n; cy /= n; cz /= n;
  let r2 = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const dx = positions[i] - cx;
    const dy = positions[i + 1] - cy;
    const dz = positions[i + 2] - cz;
    const d = dx * dx + dy * dy + dz * dz;
    if (d > r2) r2 = d;
  }
  return { center: [cx, cy, cz], radius: Math.sqrt(r2) };
}

interface GLState {
  gl: WebGLRenderingContext;
  prog: WebGLProgram;
  posBuf: WebGLBuffer;
  normBuf: WebGLBuffer;
  colorBuf: WebGLBuffer;
  triCount: number;
  aPos: number;
  aNormal: number;
  aColor: number;
  uMVP: WebGLUniformLocation;
  uNormal: WebGLUniformLocation;
  uLightDir: WebGLUniformLocation;
  uBaseColor: WebGLUniformLocation;
  uUseVertexColor: WebGLUniformLocation;
  uAlpha: WebGLUniformLocation;
  center: [number, number, number];
  radius: number;
  useVertexColor: boolean;
}

function initGL(canvas: HTMLCanvasElement, mesh: Mesh, vertexColors: Float32Array | null): GLState | null {
  const gl = canvas.getContext('webgl', { antialias: true, premultipliedAlpha: false });
  if (!gl) return null;
  const compile = (type: number, src: string): WebGLShader | null => {
    const s = gl.createShader(type); if (!s) return null;
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error('[LA3D] shader compile', gl.getShaderInfoLog(s));
      gl.deleteShader(s); return null;
    }
    return s;
  };
  const vs = compile(gl.VERTEX_SHADER, VS);
  const fs = compile(gl.FRAGMENT_SHADER, FS);
  if (!vs || !fs) return null;
  const prog = gl.createProgram(); if (!prog) return null;
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('[LA3D] link', gl.getProgramInfoLog(prog));
    return null;
  }
  const aPos = gl.getAttribLocation(prog, 'aPos');
  const aNormal = gl.getAttribLocation(prog, 'aNormal');
  const aColor = gl.getAttribLocation(prog, 'aColor');
  const uMVP = gl.getUniformLocation(prog, 'uMVP')!;
  const uNormal = gl.getUniformLocation(prog, 'uNormal')!;
  const uLightDir = gl.getUniformLocation(prog, 'uLightDir')!;
  const uBaseColor = gl.getUniformLocation(prog, 'uBaseColor')!;
  const uUseVertexColor = gl.getUniformLocation(prog, 'uUseVertexColor')!;
  const uAlpha = gl.getUniformLocation(prog, 'uAlpha')!;

  const posBuf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.DYNAMIC_DRAW);
  const normBuf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, normBuf);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
  const colorBuf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf);
  const defaultColors = new Float32Array(mesh.positions.length).fill(1);
  gl.bufferData(gl.ARRAY_BUFFER, vertexColors || defaultColors, gl.DYNAMIC_DRAW);

  const { center, radius } = computeCentroidBounds(mesh.positions);
  return {
    gl, prog, posBuf, normBuf, colorBuf, triCount: mesh.triangleCount,
    aPos, aNormal, aColor, uMVP, uNormal, uLightDir, uBaseColor, uUseVertexColor, uAlpha,
    center, radius, useVertexColor: !!vertexColors,
  };
}

function draw(
  state: GLState,
  canvas: HTMLCanvasElement,
  rotX: number,
  rotY: number,
  zoom: number,
  baseColor: [number, number, number] = [0.88, 0.32, 0.35],
  bgColor: [number, number, number] = [0.07, 0.08, 0.10],
  alpha: number = 1.0
) {
  const { gl, prog, posBuf, normBuf, colorBuf, triCount, aPos, aNormal, aColor,
    uMVP, uNormal, uLightDir, uBaseColor, uUseVertexColor, uAlpha, center, radius, useVertexColor } = state;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth * dpr;
  const h = canvas.clientHeight * dpr;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w; canvas.height = h;
  }
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.enable(gl.DEPTH_TEST);
  const transparent = alpha < 0.999;
  gl.clearColor(bgColor[0], bgColor[1], bgColor[2], 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  gl.useProgram(prog);

  const aspect = canvas.width / canvas.height;
  const proj = m4Perspective(Math.PI / 4, aspect, radius * 0.05, radius * 10);
  // Camera: translate to -3*radius so mesh centered, then rotate, then translate -center to origin
  const toOrigin = m4Translate(-center[0], -center[1], -center[2]);
  const scale = m4Scale(zoom);
  const rx = m4RotateX(rotX);
  const ry = m4RotateY(rotY);
  const viewDist = m4Translate(0, 0, -radius * 2.5);
  // model = Ry * Rx * Scale * toOrigin
  let model = m4Multiply(scale, toOrigin);
  model = m4Multiply(rx, model);
  model = m4Multiply(ry, model);
  const mv = m4Multiply(viewDist, model);
  const mvp = m4Multiply(proj, mv);
  gl.uniformMatrix4fv(uMVP, false, mvp);
  gl.uniformMatrix4fv(uNormal, false, mv);
  gl.uniform3f(uLightDir, 0.4, 0.5, 1.0);
  gl.uniform3f(uBaseColor, baseColor[0], baseColor[1], baseColor[2]);
  gl.uniform1f(uUseVertexColor, useVertexColor ? 1.0 : 0.0);
  gl.uniform1f(uAlpha, Math.max(0.05, Math.min(1, alpha)));

  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, normBuf);
  gl.enableVertexAttribArray(aNormal);
  gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);
  if (aColor >= 0) {
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf);
    gl.enableVertexAttribArray(aColor);
    gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, 0, 0);
  }

  if (transparent) {
    // Two-pass for correct back-over-front blending on a hollow shell.
    // Without this the viewer sees top/bottom halves appear to slide apart
    // on rotation because triangle order = buffer order, not depth order.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.enable(gl.CULL_FACE);
    // Pass 1: back faces (interior shell)
    gl.cullFace(gl.FRONT);
    gl.drawArrays(gl.TRIANGLES, 0, triCount * 3);
    // Pass 2: front faces (exterior shell) over back
    gl.cullFace(gl.BACK);
    gl.drawArrays(gl.TRIANGLES, 0, triCount * 3);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  } else {
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.disable(gl.CULL_FACE);
    gl.drawArrays(gl.TRIANGLES, 0, triCount * 3);
  }
}

/** Update per-vertex color buffer in place — no re-mesh. */
function updateColors(state: GLState, colors: Float32Array | null) {
  const { gl, colorBuf } = state;
  gl.bindBuffer(gl.ARRAY_BUFFER, colorBuf);
  if (colors) {
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
    state.useVertexColor = true;
  } else {
    state.useVertexColor = false;
  }
}

function disposeGL(state: GLState) {
  const { gl, prog, posBuf, normBuf, colorBuf } = state;
  gl.deleteBuffer(posBuf);
  gl.deleteBuffer(normBuf);
  gl.deleteBuffer(colorBuf);
  gl.deleteProgram(prog);
}

/**
 * View presets mapped to (rotX, rotY) in radians.
 * Model coords assumed = patient LPS (DICOM): +X left, +Y posterior, +Z superior.
 * Camera looks -Z; with rotX=0,rotY=0 we face +Z face = Superior view (head-down).
 *
 * For standard cardiac presets we rotate model so desired patient face points
 * toward camera (-Z face of model in camera space).
 */
const VIEW_PRESETS: { label: string; rotX: number; rotY: number }[] = [
  { label: 'AP',       rotX: -Math.PI / 2, rotY: 0 },
  { label: 'RAO 30',   rotX: -Math.PI / 2, rotY: -Math.PI / 6 },
  { label: 'LAO 30',   rotX: -Math.PI / 2, rotY: Math.PI / 6 },
  { label: 'Lateral',  rotX: -Math.PI / 2, rotY: Math.PI / 2 },
  { label: 'Superior', rotX: 0,            rotY: 0 },
];

export function LA3DView({
  data, dims, voxelToWorld, refreshKey,
  width = 320, height = 280, fill = false,
  vertexColors = null,
  baseColor = [0.88, 0.32, 0.35],
  bgColor = [0.07, 0.08, 0.10],
  alpha = 1.0,
  onMesh,
  displacedPositions = null,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<GLState | null>(null);
  // Default to AP view (standard cardiac reference)
  const [rotX, setRotX] = useState(-Math.PI / 2);
  const [rotY, setRotY] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [status, setStatus] = useState<string>('Building mesh…');
  const [smoothIters, setSmoothIters] = useState(8);

  // (Re)build mesh when refreshKey changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    setStatus('Building mesh…');
    const run = () => {
      if (cancelled) return;
      try {
        let mesh = marchingCubesBinary(data, dims, voxelToWorld);
        if (cancelled) return;
        if (mesh.triangleCount === 0) {
          setStatus('No mesh (empty mask).');
          return;
        }
        if (smoothIters > 0) {
          mesh = taubinSmooth(mesh, { iterations: smoothIters });
          if (cancelled) return;
        }
        if (stateRef.current) disposeGL(stateRef.current);
        const st = initGL(canvas, mesh, vertexColors ?? null);
        if (!st) { setStatus('WebGL init failed.'); return; }
        stateRef.current = st;
        setStatus(`${mesh.triangleCount.toLocaleString()} tris, smooth ${smoothIters}×`);
        draw(st, canvas, rotX, rotY, zoom, baseColor, bgColor, alpha);
        if (onMesh) onMesh(mesh);
      } catch (e: any) {
        setStatus(`Error: ${e?.message || e}`);
      }
    };
    const t = window.setTimeout(run, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, smoothIters]);

  // Update colors without re-mesh
  useEffect(() => {
    const canvas = canvasRef.current;
    const st = stateRef.current;
    if (!canvas || !st) return;
    updateColors(st, vertexColors ?? null);
    draw(st, canvas, rotX, rotY, zoom, baseColor, bgColor, alpha);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vertexColors]);

  // Update positions (epicardial offset) without re-mesh
  useEffect(() => {
    const canvas = canvasRef.current;
    const st = stateRef.current;
    if (!canvas || !st) return;
    const gl = st.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, st.posBuf);
    if (displacedPositions && displacedPositions.length === st.triCount * 9) {
      gl.bufferData(gl.ARRAY_BUFFER, displacedPositions, gl.DYNAMIC_DRAW);
    } else {
      // Restore: rebuild original. Marker: request rebuild via refreshKey bump from parent instead.
    }
    draw(st, canvas, rotX, rotY, zoom, baseColor, bgColor, alpha);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displacedPositions]);

  // Re-render on rotation/zoom/color change
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !stateRef.current) return;
    draw(stateRef.current, canvas, rotX, rotY, zoom, baseColor, bgColor, alpha);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rotX, rotY, zoom, baseColor[0], baseColor[1], baseColor[2], bgColor[0], bgColor[1], bgColor[2], alpha]);

  useEffect(() => () => {
    if (stateRef.current) { disposeGL(stateRef.current); stateRef.current = null; }
  }, []);

  // Resize redraw when container changes size (fill mode)
  useEffect(() => {
    if (!fill) return;
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ro = new ResizeObserver(() => {
      if (stateRef.current) draw(stateRef.current, canvas, rotX, rotY, zoom, baseColor, bgColor, alpha);
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [fill, rotX, rotY, zoom]);

  const draggingRef = useRef<{ x: number; y: number } | null>(null);
  const onMouseDown = (e: React.MouseEvent) => {
    draggingRef.current = { x: e.clientX, y: e.clientY };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!draggingRef.current) return;
    const dx = e.clientX - draggingRef.current.x;
    const dy = e.clientY - draggingRef.current.y;
    draggingRef.current = { x: e.clientX, y: e.clientY };
    setRotY((r) => r + dx * 0.01);
    setRotX((r) => Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, r + dy * 0.01)));
  };
  const onMouseUp = () => { draggingRef.current = null; };
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.max(0.2, Math.min(5, z * (e.deltaY > 0 ? 0.9 : 1.1))));
  };

  const wrapStyle: React.CSSProperties = fill
    ? { position: 'absolute', inset: 0 }
    : { position: 'relative' };
  const canvasStyle: React.CSSProperties = fill
    ? { width: '100%', height: '100%', background: '#111', cursor: draggingRef.current ? 'grabbing' : 'grab', display: 'block' }
    : { width, height, background: '#111', borderRadius: 4, cursor: draggingRef.current ? 'grabbing' : 'grab', display: 'block' };

  return (
    <div ref={wrapRef} style={wrapStyle}>
      <canvas
        ref={canvasRef}
        style={canvasStyle}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onWheel={onWheel}
      />
      {/* Preset buttons top-left */}
      <div style={{
        position: 'absolute', top: 6, left: 6,
        display: 'flex', gap: 4, flexWrap: 'wrap',
        maxWidth: 'calc(100% - 80px)',
      }}>
        {VIEW_PRESETS.map((p) => (
          <button
            key={p.label}
            onClick={() => { setRotX(p.rotX); setRotY(p.rotY); }}
            style={{
              padding: '3px 8px', fontSize: 10,
              background: 'rgba(20, 28, 40, 0.85)',
              color: '#cfe0f4',
              border: '1px solid rgba(121, 199, 255, 0.4)',
              borderRadius: 3, cursor: 'pointer',
              fontWeight: 500,
            }}
            title={`Jump to ${p.label} view`}
          >{p.label}</button>
        ))}
      </div>
      {/* Smoothing slider top-right */}
      <div style={{
        position: 'absolute', top: 6, right: 76,
        display: 'flex', alignItems: 'center', gap: 4,
        background: 'rgba(20,28,40,0.85)',
        border: '1px solid rgba(121,199,255,0.4)',
        borderRadius: 3, padding: '3px 6px',
        fontSize: 10, color: '#cfe0f4',
      }}>
        <span>Smooth</span>
        <input
          type="range" min={0} max={20} step={1}
          value={smoothIters}
          onChange={(e) => setSmoothIters(Number(e.target.value))}
          style={{ width: 60 }}
        />
        <span style={{ minWidth: 14, textAlign: 'right' }}>{smoothIters}</span>
      </div>
      {/* Orientation indicator bottom-right */}
      <OrientationIndicator rotX={rotX} rotY={rotY} />
      <div style={{ position: 'absolute', bottom: 4, left: 6, fontSize: 10, color: '#ccc', pointerEvents: 'none', textShadow: '0 0 2px black' }}>
        {status} — drag to rotate, wheel to zoom
      </div>
    </div>
  );
}

/**
 * Orientation box showing patient-axis directions after current rotation.
 * Applies (rotX, rotY) to unit axes, projects to 2D (drops Z), draws labeled lines.
 * Labels use DICOM LPS convention:
 *   +X = L (left),   -X = R (right)
 *   +Y = P (posterior), -Y = A (anterior)
 *   +Z = S (superior),  -Z = I (inferior)
 */
function OrientationIndicator({ rotX, rotY }: { rotX: number; rotY: number }) {
  const size = 64;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 10;

  // Apply rotY * rotX to a unit vector
  const transform = (x: number, y: number, z: number): [number, number, number] => {
    // rotX: y' = cy*y - sy*z, z' = sy*y + cy*z
    const cX = Math.cos(rotX), sX = Math.sin(rotX);
    const y1 = cX * y - sX * z;
    const z1 = sX * y + cX * z;
    // rotY: x'' = cy*x + sy*z, z'' = -sy*x + cy*z
    const cY = Math.cos(rotY), sY = Math.sin(rotY);
    const x2 = cY * x + sY * z1;
    const z2 = -sY * x + cY * z1;
    return [x2, y1, z2];
  };

  const axes: { dir: [number, number, number]; label: string; color: string }[] = [
    { dir: [+1, 0, 0], label: 'L', color: '#ff6b6b' },
    { dir: [-1, 0, 0], label: 'R', color: '#ff6b6b' },
    { dir: [0, +1, 0], label: 'P', color: '#6bf06b' },
    { dir: [0, -1, 0], label: 'A', color: '#6bf06b' },
    { dir: [0, 0, +1], label: 'S', color: '#6bb0ff' },
    { dir: [0, 0, -1], label: 'I', color: '#6bb0ff' },
  ];

  const projected = axes.map((a) => {
    const t = transform(a.dir[0], a.dir[1], a.dir[2]);
    // Screen: x = right, y = DOWN (flip Y)
    return { ...a, sx: cx + t[0] * r, sy: cy - t[1] * r, depth: t[2] };
  });
  // Draw deepest first (behind), frontmost last
  projected.sort((a, b) => a.depth - b.depth);

  return (
    <div style={{
      position: 'absolute', bottom: 8, right: 8,
      width: size, height: size,
      background: 'rgba(10, 16, 24, 0.8)',
      border: '1px solid rgba(121, 199, 255, 0.3)',
      borderRadius: size / 2,
      pointerEvents: 'none',
    }}>
      <svg width={size} height={size} style={{ position: 'absolute', inset: 0 }}>
        {/* Center dot */}
        <circle cx={cx} cy={cy} r={2} fill="#888" />
        {projected.map((p, i) => (
          <g key={i} opacity={0.5 + 0.5 * (p.depth + 1) / 2}>
            <line x1={cx} y1={cy} x2={p.sx} y2={p.sy} stroke={p.color} strokeWidth={1.5} />
            <text
              x={p.sx} y={p.sy}
              textAnchor="middle" dominantBaseline="middle"
              fontSize={10} fontWeight={700} fill={p.color}
              stroke="#000" strokeWidth={0.5} paintOrder="stroke"
            >{p.label}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}
