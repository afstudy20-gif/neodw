/**
 * AHA 17-segment model for LV myocardium.
 * Basal ring: segments 1-6 (60° each, seg 1 = anterior at 12 o'clock).
 * Mid ring:   segments 7-12 (60° each).
 * Apical ring: segments 13-16 (90° each, seg 13 = anterior).
 * Apex:       segment 17 (tip, level < 0.05).
 *
 * Long-axis derived from MV plane (3 user points) if available, else PCA fallback.
 * Anterior reference direction: anatomic −Y (LPS posterior→anterior) projected onto short-axis plane.
 */
import type { Mesh } from './marchingCubes';

export interface SegStat {
  segment: number;
  meanMm: number;
  minMm: number;
  maxMm: number;
  count: number;
}

export interface LongAxis {
  base: [number, number, number];
  apex: [number, number, number];
  longAxis: [number, number, number];
  anteriorRef: [number, number, number];
}

function sub3(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot3(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross3(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm3(a: [number, number, number]): [number, number, number] {
  const m = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / m, a[1] / m, a[2] / m];
}

export function computeLongAxisFromMV(
  mvPoints: Array<[number, number, number]>,
  mesh: Mesh,
  flip = false
): LongAxis | null {
  if (mvPoints.length !== 3 || mesh.triangleCount === 0) return null;
  const [p1, p2, p3] = mvPoints;
  let n = cross3(sub3(p2, p1), sub3(p3, p1));
  const nmag = Math.hypot(n[0], n[1], n[2]);
  if (nmag < 1e-6) return null;
  n = [n[0] / nmag, n[1] / nmag, n[2] / nmag];
  if (flip) n = [-n[0], -n[1], -n[2]];

  const base: [number, number, number] = [
    (p1[0] + p2[0] + p3[0]) / 3,
    (p1[1] + p2[1] + p3[1]) / 3,
    (p1[2] + p2[2] + p3[2]) / 3,
  ];

  // Ensure n points toward LV cavity: use mesh centroid; if centroid is on +n side, flip.
  const vertexCount = mesh.triangleCount * 3;
  let cx = 0, cy = 0, cz = 0;
  for (let v = 0; v < vertexCount; v++) {
    const p0 = v * 3;
    cx += mesh.positions[p0];
    cy += mesh.positions[p0 + 1];
    cz += mesh.positions[p0 + 2];
  }
  cx /= vertexCount; cy /= vertexCount; cz /= vertexCount;
  const centroidDot = (cx - base[0]) * n[0] + (cy - base[1]) * n[1] + (cz - base[2]) * n[2];
  // n should point FROM base TOWARD apex. Centroid is inside LV cavity between base+apex, so centroidDot > 0.
  if (centroidDot < 0) n = [-n[0], -n[1], -n[2]];

  // Apex = vertex with max projection along n (farthest toward apex)
  let apexIdx = 0;
  let maxDot = -Infinity;
  for (let v = 0; v < vertexCount; v++) {
    const p0 = v * 3;
    const d = (mesh.positions[p0] - base[0]) * n[0]
            + (mesh.positions[p0 + 1] - base[1]) * n[1]
            + (mesh.positions[p0 + 2] - base[2]) * n[2];
    if (d > maxDot) { maxDot = d; apexIdx = v; }
  }
  const ap = apexIdx * 3;
  const apex: [number, number, number] = [
    mesh.positions[ap], mesh.positions[ap + 1], mesh.positions[ap + 2],
  ];

  const longAxis = norm3([base[0] - apex[0], base[1] - apex[1], base[2] - apex[2]]);
  // Anterior ref = anatomic anterior (−Y in LPS) projected onto short-axis plane
  let ant: [number, number, number] = [0, -1, 0];
  const d = dot3(ant, longAxis);
  ant = [ant[0] - d * longAxis[0], ant[1] - d * longAxis[1], ant[2] - d * longAxis[2]];
  const anteriorRef = norm3(ant);
  return { base, apex, longAxis, anteriorRef };
}

export function computeLongAxisPCA(mesh: Mesh): LongAxis | null {
  const vertexCount = mesh.triangleCount * 3;
  if (vertexCount < 6) return null;
  let cx = 0, cy = 0, cz = 0;
  for (let v = 0; v < vertexCount; v++) {
    const p0 = v * 3;
    cx += mesh.positions[p0]; cy += mesh.positions[p0 + 1]; cz += mesh.positions[p0 + 2];
  }
  cx /= vertexCount; cy /= vertexCount; cz /= vertexCount;
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let v = 0; v < vertexCount; v++) {
    const p0 = v * 3;
    const dx = mesh.positions[p0] - cx;
    const dy = mesh.positions[p0 + 1] - cy;
    const dz = mesh.positions[p0 + 2] - cz;
    xx += dx * dx; yy += dy * dy; zz += dz * dz;
    xy += dx * dy; xz += dx * dz; yz += dy * dz;
  }
  // Power-iteration for dominant eigenvector of 3x3 covariance
  let vx = 1, vy = 0, vz = 0;
  for (let k = 0; k < 40; k++) {
    const nx = xx * vx + xy * vy + xz * vz;
    const ny = xy * vx + yy * vy + yz * vz;
    const nz = xz * vx + yz * vy + zz * vz;
    const m = Math.hypot(nx, ny, nz) || 1;
    vx = nx / m; vy = ny / m; vz = nz / m;
  }
  // Extremes along axis
  let minD = Infinity, maxD = -Infinity, minIdx = 0, maxIdx = 0;
  for (let v = 0; v < vertexCount; v++) {
    const p0 = v * 3;
    const d = (mesh.positions[p0] - cx) * vx + (mesh.positions[p0 + 1] - cy) * vy + (mesh.positions[p0 + 2] - cz) * vz;
    if (d < minD) { minD = d; minIdx = v; }
    if (d > maxD) { maxD = d; maxIdx = v; }
  }
  // Heuristic: apex end has fewer vertices within a small radius — tightest cross-section.
  // Cheap check: pick the end farther from centroid. PCA endpoints are symmetric about centroid,
  // so use ring-cross-section vertex count within 10mm of each endpoint.
  const countNear = (idx: number): number => {
    const p0 = idx * 3;
    const ex = mesh.positions[p0], ey = mesh.positions[p0 + 1], ez = mesh.positions[p0 + 2];
    let c = 0;
    const r2 = 100; // 10mm
    for (let v = 0; v < vertexCount; v += 4) {
      const q0 = v * 3;
      const dx = mesh.positions[q0] - ex, dy = mesh.positions[q0 + 1] - ey, dz = mesh.positions[q0 + 2] - ez;
      if (dx * dx + dy * dy + dz * dz < r2) c++;
    }
    return c;
  };
  const cntMin = countNear(minIdx);
  const cntMax = countNear(maxIdx);
  const apexEnd = cntMin < cntMax ? minIdx : maxIdx;
  const baseEnd = apexEnd === minIdx ? maxIdx : minIdx;
  const apex: [number, number, number] = [mesh.positions[apexEnd * 3], mesh.positions[apexEnd * 3 + 1], mesh.positions[apexEnd * 3 + 2]];
  const base: [number, number, number] = [mesh.positions[baseEnd * 3], mesh.positions[baseEnd * 3 + 1], mesh.positions[baseEnd * 3 + 2]];
  const longAxis = norm3([base[0] - apex[0], base[1] - apex[1], base[2] - apex[2]]);
  let ant: [number, number, number] = [0, -1, 0];
  const dAnt = dot3(ant, longAxis);
  ant = [ant[0] - dAnt * longAxis[0], ant[1] - dAnt * longAxis[1], ant[2] - dAnt * longAxis[2]];
  return { base, apex, longAxis, anteriorRef: norm3(ant) };
}

export function computeSegmentStats(
  mesh: Mesh,
  perVertex: Float32Array,
  la: LongAxis
): SegStat[] {
  const positions = mesh.positions;
  const vertexCount = mesh.triangleCount * 3;
  const totalLen = dot3(sub3(la.base, la.apex), la.longAxis);
  const right = cross3(la.longAxis, la.anteriorRef); // patient-left direction in short-axis plane

  const segs: SegStat[] = [];
  for (let i = 1; i <= 17; i++) {
    segs.push({ segment: i, meanMm: NaN, minMm: Infinity, maxMm: -Infinity, count: 0 });
  }
  const sums = new Float64Array(18);

  for (let v = 0; v < vertexCount; v++) {
    const t = perVertex[v];
    if (Number.isNaN(t)) continue;
    const p0 = v * 3;
    const vx = positions[p0] - la.apex[0];
    const vy = positions[p0 + 1] - la.apex[1];
    const vz = positions[p0 + 2] - la.apex[2];
    const lvl = (vx * la.longAxis[0] + vy * la.longAxis[1] + vz * la.longAxis[2]) / totalLen;

    let seg = 17;
    if (lvl > 0.05) {
      const proj = vx * la.longAxis[0] + vy * la.longAxis[1] + vz * la.longAxis[2];
      const sx = vx - proj * la.longAxis[0];
      const sy = vy - proj * la.longAxis[1];
      const sz = vz - proj * la.longAxis[2];
      const cAnt = sx * la.anteriorRef[0] + sy * la.anteriorRef[1] + sz * la.anteriorRef[2];
      const cRgt = sx * right[0] + sy * right[1] + sz * right[2];
      // atan2(right, anterior): 0 = anterior (12 o'clock), +π/2 = patient-left (9 o'clock in bullseye).
      // Bullseye convention: clockwise from anterior as seg 1. Flip sign of right so clockwise = increasing angle.
      let ang = Math.atan2(-cRgt, cAnt);
      if (ang < 0) ang += 2 * Math.PI;
      const deg = ang * 180 / Math.PI;

      if (lvl >= 0.66) {
        // Basal: seg 1 = anterior centered at 0°. Subtract 30° so seg 1 spans (-30°, +30°).
        const a = (deg + 30) % 360;
        seg = 1 + Math.min(5, Math.floor(a / 60));
      } else if (lvl >= 0.33) {
        const a = (deg + 30) % 360;
        seg = 7 + Math.min(5, Math.floor(a / 60));
      } else {
        // Apical: seg 13 = anterior centered at 0°. Subtract 45° so seg 13 spans (-45°, +45°).
        const a = (deg + 45) % 360;
        seg = 13 + Math.min(3, Math.floor(a / 90));
      }
    }

    const s = segs[seg - 1];
    s.count++;
    sums[seg] += t;
    if (t < s.minMm) s.minMm = t;
    if (t > s.maxMm) s.maxMm = t;
  }

  for (let i = 0; i < 17; i++) {
    const s = segs[i];
    if (s.count > 0) s.meanMm = sums[i + 1] / s.count;
    else { s.minMm = NaN; s.maxMm = NaN; }
  }
  return segs;
}
