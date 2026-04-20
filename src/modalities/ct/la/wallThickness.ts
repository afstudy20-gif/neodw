/**
 * LA wall thickness map (ADAS 3D style, CT-based).
 * For each mesh vertex, ray-cast outward along the surface normal through
 * myocardium until HU drops to pericardial fat (≈ <0 HU) or lung (<-200 HU).
 * Distance traveled = local wall thickness in mm.
 *
 * Outputs per-vertex Float32Array of thickness values (same length as mesh
 * vertex count = triangleCount*3). Unmeasurable vertices (ray exits volume,
 * exceeds maxMm, or starts in non-myocardial tissue) return NaN.
 */
import * as cornerstone from '@cornerstonejs/core';
import type { Mesh } from './marchingCubes';

export interface ThicknessOptions {
  stepMm?: number;      // ray step, default 0.3 mm
  maxMm?: number;       // cap, default 8 mm (LA wall rarely >5 mm)
  fatHU?: number;       // HU threshold identifying fat/lung/air boundary, default 0
  lungHU?: number;      // hard-exit threshold (lung), default -200
  contrastHU?: number;  // upper bound — if ray re-enters contrast vessel, also stop, default 220
}

export interface ThicknessResult {
  perVertex: Float32Array;    // length = mesh.triangleCount * 3
  colors: Float32Array;       // length = mesh.triangleCount * 9 (r,g,b per vertex)
  minMm: number;
  maxMm: number;
  meanMm: number;
  measurableCount: number;
  totalVertexCount: number;
}

/**
 * Trilinear HU sampling using the source volume's voxelManager scalar array.
 */
export function makeHUSampler(sourceVolumeId: string): ((wx: number, wy: number, wz: number) => number) | null {
  const volume = cornerstone.cache.getVolume(sourceVolumeId);
  if (!volume?.imageData) return null;
  const scalarArray: ArrayLike<number> | null =
    (volume as any).voxelManager?.getCompleteScalarDataArray?.() ?? null;
  if (!scalarArray) return null;
  const dims = volume.imageData.getDimensions();
  const [dx, dy, dz] = dims;
  const stride = dx * dy;
  const imageData = volume.imageData;

  return (wx: number, wy: number, wz: number): number => {
    const ijk = imageData.worldToIndex([wx, wy, wz]);
    const fx = ijk[0], fy = ijk[1], fz = ijk[2];
    if (fx < 0 || fy < 0 || fz < 0 || fx > dx - 1 || fy > dy - 1 || fz > dz - 1) return NaN;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
    const x1 = Math.min(x0 + 1, dx - 1);
    const y1 = Math.min(y0 + 1, dy - 1);
    const z1 = Math.min(z0 + 1, dz - 1);
    const tx = fx - x0, ty = fy - y0, tz = fz - z0;
    const idx = (i: number, j: number, k: number) => k * stride + j * dx + i;
    const c000 = Number(scalarArray[idx(x0, y0, z0)]);
    const c100 = Number(scalarArray[idx(x1, y0, z0)]);
    const c010 = Number(scalarArray[idx(x0, y1, z0)]);
    const c110 = Number(scalarArray[idx(x1, y1, z0)]);
    const c001 = Number(scalarArray[idx(x0, y0, z1)]);
    const c101 = Number(scalarArray[idx(x1, y0, z1)]);
    const c011 = Number(scalarArray[idx(x0, y1, z1)]);
    const c111 = Number(scalarArray[idx(x1, y1, z1)]);
    const c00 = c000 * (1 - tx) + c100 * tx;
    const c10 = c010 * (1 - tx) + c110 * tx;
    const c01 = c001 * (1 - tx) + c101 * tx;
    const c11 = c011 * (1 - tx) + c111 * tx;
    const c0 = c00 * (1 - ty) + c10 * ty;
    const c1 = c01 * (1 - ty) + c11 * ty;
    return c0 * (1 - tz) + c1 * tz;
  };
}

export function computeWallThickness(
  mesh: Mesh,
  sourceVolumeId: string,
  opts: ThicknessOptions = {}
): ThicknessResult {
  const stepMm = opts.stepMm ?? 0.3;
  const maxMm = opts.maxMm ?? 8;
  const fatHU = opts.fatHU ?? 0;
  const lungHU = opts.lungHU ?? -200;
  const contrastHU = opts.contrastHU ?? 220;
  const maxSteps = Math.ceil(maxMm / stepMm);

  const sampler = makeHUSampler(sourceVolumeId);
  const vertexCount = mesh.triangleCount * 3;
  const perVertex = new Float32Array(vertexCount);
  const colors = new Float32Array(vertexCount * 3);

  if (!sampler) {
    perVertex.fill(NaN);
    colors.fill(0.5);
    return { perVertex, colors, minMm: NaN, maxMm: NaN, meanMm: NaN, measurableCount: 0, totalVertexCount: vertexCount };
  }

  // MC normals point outward from mask (fg→bg). Since LA mask = blood pool,
  // +normal direction enters myocardium. Walk +normal.
  const positions = mesh.positions;
  const normals = mesh.normals;

  let minMm = Infinity, maxMmSeen = -Infinity, sum = 0, count = 0;

  for (let v = 0; v < vertexCount; v++) {
    const p0 = v * 3;
    const px = positions[p0], py = positions[p0 + 1], pz = positions[p0 + 2];
    const nx = normals[p0], ny = normals[p0 + 1], nz = normals[p0 + 2];

    // Take first half-step to leave rim partial-volume voxel
    let thickness = NaN;
    let exited = false;
    // Skip rim: advance until HU < contrastHU (i.e., out of blood pool).
    // This handles starting vertex that lies on voxel still reading high HU.
    let t = 0;
    let insideMyo = false;
    for (let s = 1; s <= maxSteps; s++) {
      t = s * stepMm;
      const wx = px + nx * t;
      const wy = py + ny * t;
      const wz = pz + nz * t;
      const hu = sampler(wx, wy, wz);
      if (Number.isNaN(hu)) { exited = true; break; }
      if (!insideMyo) {
        // Still in blood partial-volume rim — wait for HU to drop below contrastHU
        if (hu < contrastHU) insideMyo = true;
        continue;
      }
      // In myocardium — check exit conditions
      if (hu < fatHU) { thickness = t; break; }
      if (hu < lungHU) { thickness = t; break; }
      // Re-entered contrast vessel (e.g., aorta adjacent to LA) → ambiguous, cap
      if (hu > contrastHU + 80) { thickness = t; break; }
    }
    if (!Number.isNaN(thickness)) {
      perVertex[v] = thickness;
      if (thickness < minMm) minMm = thickness;
      if (thickness > maxMmSeen) maxMmSeen = thickness;
      sum += thickness;
      count++;
    } else {
      perVertex[v] = exited ? NaN : maxMm;
    }
  }

  // Build color ramp (per vertex, RGB)
  for (let v = 0; v < vertexCount; v++) {
    const t = perVertex[v];
    const c0 = v * 3;
    if (Number.isNaN(t)) {
      colors[c0] = 0.4; colors[c0 + 1] = 0.4; colors[c0 + 2] = 0.4;
    } else {
      const [r, g, b] = thicknessToColor(t);
      colors[c0] = r; colors[c0 + 1] = g; colors[c0 + 2] = b;
    }
  }

  return {
    perVertex,
    colors,
    minMm: count > 0 ? minMm : NaN,
    maxMm: count > 0 ? maxMmSeen : NaN,
    meanMm: count > 0 ? sum / count : NaN,
    measurableCount: count,
    totalVertexCount: vertexCount,
  };
}

/**
 * Per-vertex intramyocardial fat fraction via ray-casting along vertex normals.
 * Walks 0..thickness(v) mm outward, samples HU; counts samples in fat range
 * (−190 to fatThreshold, default −30 HU) → fraction = fat_samples / total_samples.
 *
 * NaN = unmeasurable (no thickness or no sampler). 0 = no fat detected.
 */
export function computeFatFraction(
  mesh: Mesh,
  thickness: Float32Array,
  sourceVolumeId: string,
  opts: { stepMm?: number; fatThreshold?: number; fatFloorHU?: number } = {}
): Float32Array {
  const stepMm = opts.stepMm ?? 0.5;
  const fatThreshold = opts.fatThreshold ?? -30;
  const fatFloor = opts.fatFloorHU ?? -190;
  const n = mesh.triangleCount * 3;
  const out = new Float32Array(n);
  const sampler = makeHUSampler(sourceVolumeId);
  if (!sampler) { out.fill(NaN); return out; }
  for (let v = 0; v < n; v++) {
    const t = thickness[v];
    if (Number.isNaN(t) || t <= 0) { out[v] = NaN; continue; }
    const p0 = v * 3;
    const px = mesh.positions[p0];
    const py = mesh.positions[p0 + 1];
    const pz = mesh.positions[p0 + 2];
    const nx = mesh.normals[p0];
    const ny = mesh.normals[p0 + 1];
    const nz = mesh.normals[p0 + 2];
    const maxSteps = Math.max(1, Math.floor(t / stepMm));
    let fat = 0;
    let total = 0;
    for (let s = 1; s <= maxSteps; s++) {
      const d = s * stepMm;
      const hu = sampler(px + nx * d, py + ny * d, pz + nz * d);
      if (Number.isNaN(hu)) continue;
      total++;
      if (hu < fatThreshold && hu > fatFloor) fat++;
    }
    out[v] = total > 0 ? fat / total : 0;
  }
  return out;
}

/**
 * Yellow ramp for fat fraction. 0 → base grey, 1 → bright yellow.
 */
export function fatFractionToColor(frac: number): [number, number, number] {
  if (Number.isNaN(frac)) return [0.4, 0.4, 0.4];
  const f = Math.max(0, Math.min(1, frac));
  return [0.55 + f * 0.45, 0.55 + f * 0.40, 0.20 * (1 - f)];
}

/**
 * Clinical color ramp for LV wall thickness (ADAS-LV style CT proxy for scar).
 * <3mm → deep red (dense scar core)
 * 3–5mm → red-orange (scar / border zone)
 * 5–7mm → yellow (border zone / channel — VT substrate)
 * 7–10mm → green (healthy LV myocardium)
 * >10mm → blue (hypertrophy or measurement over-shoot into fat/lung)
 */
export function lvThicknessToColor(mm: number): [number, number, number] {
  if (mm < 3) {
    const t = Math.max(0, mm / 3);
    return [0.75 + t * 0.2, 0.05 + t * 0.15, 0.05];
  }
  if (mm < 5) {
    const t = (mm - 3) / 2;
    return [0.95, 0.20 + t * 0.45, 0.15];
  }
  if (mm < 7) {
    const t = (mm - 5) / 2;
    return [0.95, 0.65 + t * 0.25, 0.15 + t * 0.05];
  }
  if (mm < 10) {
    const t = (mm - 7) / 3;
    return [0.90 - t * 0.55, 0.90 - t * 0.05, 0.20 + t * 0.20];
  }
  const t = Math.min(1, (mm - 10) / 5);
  return [0.35 - t * 0.2, 0.85 - t * 0.45, 0.40 + t * 0.40];
}

/**
 * Clinical color ramp for LA wall thickness.
 * <2mm → red (thin, ablation risk / atrio-esophageal fistula danger)
 * 2–3mm → orange
 * 3–5mm → green (normal LA wall)
 * >5mm → blue (thick — usually signals mis-measurement into fat)
 */
export function thicknessToColor(mm: number): [number, number, number] {
  if (mm < 2) {
    // red → orange
    const t = Math.max(0, mm / 2);
    return [0.95, 0.15 + t * 0.4, 0.15];
  }
  if (mm < 3) {
    // orange → yellow-green
    const t = (mm - 2);
    return [0.95 - t * 0.55, 0.55 + t * 0.35, 0.15 + t * 0.1];
  }
  if (mm < 5) {
    // green
    const t = (mm - 3) / 2;
    return [0.4 - t * 0.2, 0.9 - t * 0.1, 0.25 + t * 0.2];
  }
  // blue-ish
  const t = Math.min(1, (mm - 5) / 3);
  return [0.2 - t * 0.1, 0.8 - t * 0.4, 0.45 + t * 0.35];
}
