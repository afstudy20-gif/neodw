/**
 * Taubin mesh smoothing (λ/μ filter) for triangle-soup meshes.
 * Reference: Taubin 1995 — "Curve and Surface Smoothing without Shrinkage"
 *
 * Standard Laplacian smoothing shrinks the mesh. Taubin alternates a positive
 * scale λ step with a negative μ step (|μ| > λ), canceling shrinkage while
 * still low-pass filtering the surface.
 *
 * Input: marching cubes output (triangle soup — each triangle has 3 unique
 * vertex entries, duplicates between adjacent triangles). We:
 *   1. Deduplicate vertices (spatial hash).
 *   2. Build adjacency (vertex → list of connected vertices).
 *   3. Run N iterations of Taubin (λ step then μ step).
 *   4. Expand back to triangle soup positions + recompute per-vertex normals.
 */

import type { Mesh } from './marchingCubes';

export interface SmoothOptions {
  iterations?: number; // default 8
  lambda?: number;     // positive smoothing step, default 0.5
  mu?: number;         // negative anti-shrink step, default -0.53
}

export function taubinSmooth(mesh: Mesh, opts: SmoothOptions = {}): Mesh {
  const iters = opts.iterations ?? 8;
  const lambda = opts.lambda ?? 0.5;
  const mu = opts.mu ?? -0.53;

  if (mesh.triangleCount === 0) return mesh;

  const positions = mesh.positions;
  const vertCount = mesh.triangleCount * 3;

  // 1. Dedup via quantized spatial hash
  // Quantize to 1e-3 mm to catch MC's shared edge vertices that should be identical
  const scale = 1000;
  const index = new Int32Array(vertCount); // triangle-soup vert i → unique-vert id
  const uniquePos: number[] = [];
  const hashMap = new Map<string, number>();
  for (let v = 0; v < vertCount; v++) {
    const p0 = v * 3;
    const kx = Math.round(positions[p0] * scale);
    const ky = Math.round(positions[p0 + 1] * scale);
    const kz = Math.round(positions[p0 + 2] * scale);
    const key = `${kx},${ky},${kz}`;
    let id = hashMap.get(key);
    if (id === undefined) {
      id = uniquePos.length / 3;
      uniquePos.push(positions[p0], positions[p0 + 1], positions[p0 + 2]);
      hashMap.set(key, id);
    }
    index[v] = id;
  }
  const nUnique = uniquePos.length / 3;

  // 2. Build adjacency from triangle edges
  const adjSet: Array<Set<number>> = new Array(nUnique);
  for (let i = 0; i < nUnique; i++) adjSet[i] = new Set();
  for (let t = 0; t < mesh.triangleCount; t++) {
    const a = index[t * 3];
    const b = index[t * 3 + 1];
    const c = index[t * 3 + 2];
    if (a !== b) { adjSet[a].add(b); adjSet[b].add(a); }
    if (b !== c) { adjSet[b].add(c); adjSet[c].add(b); }
    if (c !== a) { adjSet[c].add(a); adjSet[a].add(c); }
  }
  // Flatten to arrays for fast iteration
  const adjOffsets = new Int32Array(nUnique + 1);
  let total = 0;
  for (let i = 0; i < nUnique; i++) { adjOffsets[i] = total; total += adjSet[i].size; }
  adjOffsets[nUnique] = total;
  const adjList = new Int32Array(total);
  {
    let off = 0;
    for (let i = 0; i < nUnique; i++) {
      for (const n of adjSet[i]) adjList[off++] = n;
    }
  }

  // 3. Taubin iterations — each iteration = λ step then μ step
  let pos = new Float32Array(uniquePos);
  const tmp = new Float32Array(pos.length);

  const step = (src: Float32Array, dst: Float32Array, factor: number) => {
    for (let i = 0; i < nUnique; i++) {
      const start = adjOffsets[i];
      const end = adjOffsets[i + 1];
      const deg = end - start;
      if (deg === 0) {
        dst[i * 3] = src[i * 3];
        dst[i * 3 + 1] = src[i * 3 + 1];
        dst[i * 3 + 2] = src[i * 3 + 2];
        continue;
      }
      let mx = 0, my = 0, mz = 0;
      for (let k = start; k < end; k++) {
        const n = adjList[k];
        mx += src[n * 3];
        my += src[n * 3 + 1];
        mz += src[n * 3 + 2];
      }
      mx /= deg; my /= deg; mz /= deg;
      const vx = src[i * 3], vy = src[i * 3 + 1], vz = src[i * 3 + 2];
      dst[i * 3] = vx + factor * (mx - vx);
      dst[i * 3 + 1] = vy + factor * (my - vy);
      dst[i * 3 + 2] = vz + factor * (mz - vz);
    }
  };

  for (let it = 0; it < iters; it++) {
    step(pos, tmp, lambda);
    step(tmp, pos, mu);
  }

  // 4. Expand back to triangle-soup positions + recompute per-face normals
  const newPositions = new Float32Array(vertCount * 3);
  const newNormals = new Float32Array(vertCount * 3);
  for (let v = 0; v < vertCount; v++) {
    const u = index[v];
    newPositions[v * 3] = pos[u * 3];
    newPositions[v * 3 + 1] = pos[u * 3 + 1];
    newPositions[v * 3 + 2] = pos[u * 3 + 2];
  }
  for (let t = 0; t < mesh.triangleCount; t++) {
    const o = t * 9;
    const ax = newPositions[o], ay = newPositions[o + 1], az = newPositions[o + 2];
    const bx = newPositions[o + 3], by = newPositions[o + 4], bz = newPositions[o + 5];
    const cx = newPositions[o + 6], cy = newPositions[o + 7], cz = newPositions[o + 8];
    const ex1 = bx - ax, ey1 = by - ay, ez1 = bz - az;
    const ex2 = cx - ax, ey2 = cy - ay, ez2 = cz - az;
    let nx = ey1 * ez2 - ez1 * ey2;
    let ny = ez1 * ex2 - ex1 * ez2;
    let nz = ex1 * ey2 - ey1 * ex2;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (let i = 0; i < 3; i++) {
      newNormals[o + i * 3] = nx;
      newNormals[o + i * 3 + 1] = ny;
      newNormals[o + i * 3 + 2] = nz;
    }
  }

  return {
    positions: newPositions,
    normals: newNormals,
    triangleCount: mesh.triangleCount,
  };
}
