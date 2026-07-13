/**
 * WebGL 3D virtual valve deployment view.
 *
 * Renders the patient-specific annulus (semi-transparent disc) together with
 * the selected prosthesis' nominal stent frame (opaque, vivid) positioned at
 * the chosen implant depth. Drag to rotate, wheel to zoom. Cusp + coronary
 * ostium landmarks are drawn as small accent spheres so the operator can read
 * the frame-to-ostium and frame-to-calcium relationship at a glance.
 *
 * Reuses the inline-WebGL + mat4 + three-point-lighting approach proven in
 * LA3DView (no Three.js / dependency bloat). Unlike LA3DView, this view draws
 * MULTIPLE meshes (annulus disc, frame, landmarks) in one pass, each with its
 * own colour and alpha — so the GL state here manages an array of buffers.
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { Mesh } from '../la/marchingCubes';
import type { TAVIVector3D } from '../tavi/TAVITypes';

// ── mat4 helpers (column-major), identical to LA3DView ──

type Mat4 = Float32Array;

function m4Identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
  return m;
}
function m4Multiply(a: Mat4, b: Mat4): Mat4 {
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
  m[0] = f / aspect; m[5] = f;
  m[10] = (far + near) * nf; m[11] = -1;
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

function computeSceneBounds(positions: Float32Array[]): { center: [number, number, number]; radius: number } {
  let cx = 0, cy = 0, cz = 0, count = 0;
  for (const pos of positions) {
    for (let i = 0; i < pos.length; i += 3) {
      cx += pos[i]; cy += pos[i + 1]; cz += pos[i + 2]; count++;
    }
  }
  if (count === 0) return { center: [0, 0, 0], radius: 30 };
  cx /= count; cy /= count; cz /= count;
  let r2 = 0;
  for (const pos of positions) {
    for (let i = 0; i < pos.length; i += 3) {
      const dx = pos[i] - cx, dy = pos[i + 1] - cy, dz = pos[i + 2] - cz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > r2) r2 = d;
    }
  }
  return { center: [cx, cy, cz], radius: Math.max(5, Math.sqrt(r2)) };
}

const VS = `
precision mediump float;
attribute vec3 aPos;
attribute vec3 aNormal;
uniform mat4 uMVP;
uniform mat4 uNormal;
varying vec3 vNormal;
void main() {
  vNormal = normalize((uNormal * vec4(aNormal, 0.0)).xyz);
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const FS = `
precision mediump float;
varying vec3 vNormal;
uniform vec3 uColor;
uniform float uAlpha;
void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 Lkey  = normalize(vec3( 0.0,  0.0,  1.0));
  vec3 Lfill = normalize(vec3(-0.4, -0.3,  0.8));
  vec3 Lrim  = normalize(vec3( 0.5,  0.7, -0.3));
  float dKey  = max(dot(n, Lkey),  0.0);
  float dFill = max(dot(n, Lfill), 0.0) * 0.5;
  float dRim  = pow(max(dot(n, Lrim), 0.0), 3.0) * 0.4;
  float ambient = 0.45;
  float lit = ambient + 0.55 * dKey + 0.35 * dFill + dRim;
  float facing = gl_FrontFacing ? 1.0 : 0.72;
  gl_FragColor = vec4(uColor * facing * lit, uAlpha);
}`;

interface MeshLayer {
  mesh: Mesh;
  color: [number, number, number];
  alpha: number;
}

export type { MeshLayer };

interface GLBuffer {
  pos: WebGLBuffer;
  norm: WebGLBuffer;
  triCount: number;
}

interface GLState {
  gl: WebGLRenderingContext;
  prog: WebGLProgram;
  aPos: number;
  aNormal: number;
  uMVP: WebGLUniformLocation;
  uNormal: WebGLUniformLocation;
  uColor: WebGLUniformLocation;
  uAlpha: WebGLUniformLocation;
  buffers: GLBuffer[];
  center: [number, number, number];
  radius: number;
}

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    gl.deleteShader(s);
    return null;
  }
  return s;
}

function initGL(canvas: HTMLCanvasElement, layers: MeshLayer[]): GLState | null {
  const gl = canvas.getContext('webgl', { antialias: true, premultipliedAlpha: false });
  if (!gl) return null;
  const vs = compileShader(gl, gl.VERTEX_SHADER, VS);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FS);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;

  const buffers: GLBuffer[] = layers.map((layer) => {
    const pos = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, pos);
    gl.bufferData(gl.ARRAY_BUFFER, layer.mesh.positions, gl.STATIC_DRAW);
    const norm = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, norm);
    gl.bufferData(gl.ARRAY_BUFFER, layer.mesh.normals, gl.STATIC_DRAW);
    return { pos, norm, triCount: layer.mesh.triangleCount };
  });

  const allPos = layers.map((l) => l.mesh.positions);
  const { center, radius } = computeSceneBounds(allPos);

  return {
    gl,
    prog,
    aPos: gl.getAttribLocation(prog, 'aPos'),
    aNormal: gl.getAttribLocation(prog, 'aNormal'),
    uMVP: gl.getUniformLocation(prog, 'uMVP')!,
    uNormal: gl.getUniformLocation(prog, 'uNormal')!,
    uColor: gl.getUniformLocation(prog, 'uColor')!,
    uAlpha: gl.getUniformLocation(prog, 'uAlpha')!,
    buffers,
    center,
    radius,
  };
}

function draw(
  state: GLState,
  canvas: HTMLCanvasElement,
  rotX: number,
  rotY: number,
  zoom: number,
  layers: MeshLayer[],
  bgColor: [number, number, number],
) {
  const { gl, prog, aPos, aNormal, uMVP, uNormal, uColor, uAlpha, buffers, center, radius } = state;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth * dpr;
  const h = canvas.clientHeight * dpr;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(bgColor[0], bgColor[1], bgColor[2], 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  gl.useProgram(prog);
  const aspect = canvas.width / canvas.height;
  const proj = m4Perspective(Math.PI / 4, aspect, radius * 0.05, radius * 10);
  const toOrigin = m4Translate(-center[0], -center[1], -center[2]);
  const scale = m4Scale(zoom);
  const rx = m4RotateX(rotX);
  const ry = m4RotateY(rotY);
  const viewDist = m4Translate(0, 0, -radius * 2.5);
  let model = m4Multiply(scale, toOrigin);
  model = m4Multiply(rx, model);
  model = m4Multiply(ry, model);
  const mv = m4Multiply(viewDist, model);
  const mvp = m4Multiply(proj, mv);
  gl.uniformMatrix4fv(uMVP, false, mvp);
  gl.uniformMatrix4fv(uNormal, false, mv);

  for (let i = 0; i < buffers.length; i++) {
    const buf = buffers[i];
    const layer = layers[i];
    if (buf.triCount === 0) continue;

    gl.uniform3f(uColor, layer.color[0], layer.color[1], layer.color[2]);
    gl.uniform1f(uAlpha, Math.max(0.05, Math.min(1, layer.alpha)));

    gl.bindBuffer(gl.ARRAY_BUFFER, buf.pos);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf.norm);
    gl.enableVertexAttribArray(aNormal);
    gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);

    const transparent = layer.alpha < 0.999;
    if (transparent) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.FRONT);
      gl.drawArrays(gl.TRIANGLES, 0, buf.triCount * 3);
      gl.cullFace(gl.BACK);
      gl.drawArrays(gl.TRIANGLES, 0, buf.triCount * 3);
      gl.disable(gl.CULL_FACE);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    } else {
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.disable(gl.CULL_FACE);
      gl.drawArrays(gl.TRIANGLES, 0, buf.triCount * 3);
    }
  }
}

function disposeGL(state: GLState) {
  const { gl, prog, buffers } = state;
  for (const b of buffers) {
    gl.deleteBuffer(b.pos);
    gl.deleteBuffer(b.norm);
  }
  gl.deleteProgram(prog);
}

// ── Landmark sphere builder ──
/** Build a small UV-sphere mesh (for cusp / ostium markers), world-space. */
function buildSphereMesh(center: TAVIVector3D, radiusMm: number, segments = 12, rings = 8): Mesh {
  const positions: number[] = [];
  const normals: number[] = [];
  for (let ring = 0; ring < rings; ring++) {
    const phi0 = (ring / rings) * Math.PI;
    const phi1 = ((ring + 1) / rings) * Math.PI;
    for (let seg = 0; seg < segments; seg++) {
      const theta0 = (seg / segments) * Math.PI * 2;
      const theta1 = ((seg + 1) / segments) * Math.PI * 2;
      // 4 corners of a quad on the sphere
      const p = (phi: number, theta: number): [number, number, number] => {
        const sx = Math.sin(phi) * Math.cos(theta);
        const sy = Math.sin(phi) * Math.sin(theta);
        const sz = Math.cos(phi);
        return [center.x + sx * radiusMm, center.y + sy * radiusMm, center.z + sz * radiusMm];
      };
      const c00 = p(phi0, theta0);
      const c01 = p(phi0, theta1);
      const c11 = p(phi1, theta1);
      const c10 = p(phi1, theta0);
      // 2 triangles, shared normal = sphere normal (approx centroid direction)
      for (const tri of [[c00, c01, c11], [c00, c11, c10]]) {
        const [a, b, cc] = tri;
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const vx = cc[0] - a[0], vy = cc[1] - a[1], vz = cc[2] - a[2];
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const nlen = Math.hypot(nx, ny, nz) || 1;
        nx /= nlen; ny /= nlen; nz /= nlen;
        for (const v of tri) {
          positions.push(v[0], v[1], v[2]);
          normals.push(nx, ny, nz);
        }
      }
    }
  }
  const triCount = positions.length / 9;
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), triangleCount: triCount };
}

export interface ValveDeploy3DProps {
  /** Mesh layers to render, in draw order (first = backmost). */
  layers: MeshLayer[];
  width?: number | string;
  height?: number | string;
  /** Bump to force a full GL rebuild (mesh changed). */
  refreshKey: number | string;
  bgColor?: [number, number, number];
  /** Optional landmarks rendered as small accent spheres. */
  landmarks?: { point: TAVIVector3D; color: [number, number, number]; radiusMm?: number }[];
}

export const ValveDeploy3D: React.FC<ValveDeploy3DProps> = ({
  layers: baseLayers,
  width = '100%',
  height = 340,
  refreshKey,
  bgColor = [0.04, 0.05, 0.08],
  landmarks = [],
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<GLState | null>(null);
  const [rotX, setRotX] = useState(-Math.PI / 2.3); // slight tilt → near en-face
  const [rotY, setRotY] = useState(0.25);
  const [zoom, setZoom] = useState(1);

  // Merge base layers + landmark spheres so they share the scene bounds + pass.
  const layers: MeshLayer[] = [
    ...baseLayers,
    ...landmarks.map((lm) => ({
      mesh: buildSphereMesh(lm.point, lm.radiusMm ?? 1.5),
      color: lm.color,
      alpha: 1.0,
    })),
  ];

  // (Re)build GL when meshes change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      if (stateRef.current) {
        disposeGL(stateRef.current);
        stateRef.current = null;
      }
      if (layers.every((l) => l.mesh.triangleCount === 0)) return;
      const st = initGL(canvas, layers);
      if (!st) return;
      stateRef.current = st;
      draw(st, canvas, rotX, rotY, zoom, layers, bgColor);
    };
    const t = window.setTimeout(run, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // Re-draw on camera change (no rebuild).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !stateRef.current) return;
    draw(stateRef.current, canvas, rotX, rotY, zoom, layers, bgColor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rotX, rotY, zoom]);

  // Dispose on unmount.
  useEffect(() => () => {
    if (stateRef.current) {
      disposeGL(stateRef.current);
      stateRef.current = null;
    }
  }, []);

  const draggingRef = useRef<{ x: number; y: number } | null>(null);
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    draggingRef.current = { x: e.clientX, y: e.clientY };
  }, []);
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!draggingRef.current) return;
    const dx = e.clientX - draggingRef.current.x;
    const dy = e.clientY - draggingRef.current.y;
    draggingRef.current = { x: e.clientX, y: e.clientY };
    setRotY((r) => r + dx * 0.01);
    setRotX((r) => Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, r + dy * 0.01)));
  }, []);
  const onMouseUp = useCallback(() => { draggingRef.current = null; }, []);
  const onWheel = useCallback((e: React.WheelEvent) => {
    setZoom((z) => Math.max(0.2, Math.min(5, z * (e.deltaY > 0 ? 0.9 : 1.1))));
  }, []);

  return (
    <div style={{ position: 'relative', width, height }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', background: '#0a0e14', borderRadius: 4, cursor: draggingRef.current ? 'grabbing' : 'grab', display: 'block' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onWheel={onWheel}
      />
      <div style={{ position: 'absolute', bottom: 4, left: 6, fontSize: 10, color: '#ccc', pointerEvents: 'none', textShadow: '0 0 2px black' }}>
        drag to rotate · wheel to zoom
      </div>
    </div>
  );
};
