// Biplane 3D reconstruction geometry.
//
// Coordinate convention (patient frame, LPS-like):
//   x = patient left (+)
//   y = patient posterior (+)
//   z = patient superior / cranial (+)
//
// C-arm angles (DICOM Positioner*Angle, degrees):
//   primaryAngle (alpha)   = LAO positive, RAO negative  (rotation around z)
//   secondaryAngle (beta)  = CRA positive, CAU negative  (tilt around x in rotated frame)
//
// Source position (from isocenter to X-ray source), unit vector (Dumay/Wollschlager):
//   s_hat = ( -cos(beta) * sin(alpha),
//             -cos(beta) * cos(alpha),
//              sin(beta) )
//
// SOD = distance source -> isocenter  (DistanceSourceToPatient)
// SID = distance source -> detector   (DistanceSourceToDetector)
// Detector lies at  -((SID - SOD) / SOD) * SOD = -(SID - SOD) past isocenter
// along the view direction (away from source).

import type { CArmGeometry } from '../core/dicomLoader';

export type Vec3 = [number, number, number];

export interface View {
  // Source position in patient frame, mm
  source: Vec3;
  // Detector center position in patient frame, mm
  detectorCenter: Vec3;
  // Detector basis: e_u = right on detector, e_v = up (toward cranial)
  eU: Vec3;
  eV: Vec3;
  // View direction (source -> detector), normalized
  viewDir: Vec3;
  // Image dimensions
  rows: number;
  columns: number;
  // mm per pixel at detector
  pixelSpacing: number;
  // Raw geometry copy
  raw: CArmGeometry;
}

const DEG = Math.PI / 180;

function sub(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scale(a: Vec3, s: number): Vec3 { return [a[0] * s, a[1] * s, a[2] * s]; }
function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function norm(a: Vec3): number { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); }
function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0];
}

export function buildView(geom: CArmGeometry): View {
  const alpha = geom.primaryAngle * DEG;
  const beta = geom.secondaryAngle * DEG;
  const cA = Math.cos(alpha);
  const sA = Math.sin(alpha);
  const cB = Math.cos(beta);
  const sB = Math.sin(beta);

  // Source unit vector (isocenter -> source)
  const sourceHat: Vec3 = [-cB * sA, -cB * cA, sB];
  const source = scale(sourceHat, geom.sod);

  // View direction = source -> isocenter -> detector
  const viewDir = normalize(scale(sourceHat, -1));

  // Detector center: source + SID * viewDir
  const detectorCenter = add(source, scale(viewDir, geom.sid));

  // Detector basis. e_v points toward cranial (+z) projected onto detector plane.
  const zAxis: Vec3 = [0, 0, 1];
  const zComp = dot(zAxis, viewDir);
  let eV: Vec3 = sub(zAxis, scale(viewDir, zComp));
  const eVNorm = norm(eV);
  if (eVNorm < 1e-6) {
    // Pure cranial / caudal view, fall back to +y projected
    const yAxis: Vec3 = [0, 1, 0];
    const yComp = dot(yAxis, viewDir);
    eV = normalize(sub(yAxis, scale(viewDir, yComp)));
  } else {
    eV = scale(eV, 1 / eVNorm);
  }
  // Detector u-axis = viewDir x eV (right-handed, points patient-left-ish for AP)
  const eU = normalize(cross(viewDir, eV));

  return {
    source,
    detectorCenter,
    eU,
    eV,
    viewDir,
    rows: geom.rows,
    columns: geom.columns,
    pixelSpacing: geom.pixelSpacing,
    raw: geom,
  };
}

// Project a 3D point in patient frame to pixel coordinates on detector.
// Returns null if point is behind source.
export function projectPoint(view: View, p: Vec3): { u: number; v: number } | null {
  const rel = sub(p, view.source);
  const dist = dot(rel, view.viewDir);
  if (dist <= 1e-3) return null;
  const scaleFactor = view.raw.sid / dist;
  const ptOnDetector = add(view.source, scale(rel, scaleFactor));
  const offset = sub(ptOnDetector, view.detectorCenter);
  const u = dot(offset, view.eU) / view.pixelSpacing + view.columns / 2;
  const v = -dot(offset, view.eV) / view.pixelSpacing + view.rows / 2; // image v grows downward
  return { u, v };
}

// Back-project a pixel (u, v) into a ray (source, direction) in patient frame.
export function backProject(view: View, u: number, v: number): { origin: Vec3; dir: Vec3 } {
  const u_mm = (u - view.columns / 2) * view.pixelSpacing;
  const v_mm = -(v - view.rows / 2) * view.pixelSpacing;
  const detectorPoint = add(
    view.detectorCenter,
    add(scale(view.eU, u_mm), scale(view.eV, v_mm))
  );
  const dir = normalize(sub(detectorPoint, view.source));
  return { origin: view.source, dir };
}

// Closest point between two rays (linear least-squares).
// Returns the midpoint of the common perpendicular segment, plus residual.
export function intersectRays(
  r1: { origin: Vec3; dir: Vec3 },
  r2: { origin: Vec3; dir: Vec3 }
): { point: Vec3; residual: number } {
  const d1 = r1.dir;
  const d2 = r2.dir;
  const w0 = sub(r1.origin, r2.origin);
  const a = dot(d1, d1);
  const b = dot(d1, d2);
  const c = dot(d2, d2);
  const d = dot(d1, w0);
  const e = dot(d2, w0);
  const denom = a * c - b * b;
  if (Math.abs(denom) < 1e-9) {
    // Parallel rays. Fall back to midpoint of origins.
    return { point: scale(add(r1.origin, r2.origin), 0.5), residual: Infinity };
  }
  const t1 = (b * e - c * d) / denom;
  const t2 = (a * e - b * d) / denom;
  const p1 = add(r1.origin, scale(d1, t1));
  const p2 = add(r2.origin, scale(d2, t2));
  const residual = norm(sub(p1, p2));
  return { point: scale(add(p1, p2), 0.5), residual };
}

export function triangulate(
  viewA: View, pA: { u: number; v: number },
  viewB: View, pB: { u: number; v: number }
): { point: Vec3; residual: number } {
  const rayA = backProject(viewA, pA.u, pA.v);
  const rayB = backProject(viewB, pB.u, pB.v);
  return intersectRays(rayA, rayB);
}

export interface BiplaneResult {
  points3D: Vec3[];
  residuals: number[];
  meanResidual: number;
  maxResidual: number;
}

export function reconstructCenterline(
  viewA: View,
  pointsA: Array<{ u: number; v: number }>,
  viewB: View,
  pointsB: Array<{ u: number; v: number }>
): BiplaneResult {
  const n = Math.min(pointsA.length, pointsB.length);
  const points3D: Vec3[] = [];
  const residuals: number[] = [];
  let sum = 0;
  let max = 0;
  for (let i = 0; i < n; i += 1) {
    const r = triangulate(viewA, pointsA[i], viewB, pointsB[i]);
    points3D.push(r.point);
    residuals.push(r.residual);
    if (Number.isFinite(r.residual)) {
      sum += r.residual;
      if (r.residual > max) max = r.residual;
    }
  }
  return {
    points3D,
    residuals,
    meanResidual: n > 0 ? sum / n : 0,
    maxResidual: max,
  };
}

// Epipolar line for point pA in view A, expressed in view B as a 2D line.
// Returns two endpoints in image-B pixel coordinates spanning the image extent.
export function epipolarLine(
  viewA: View,
  pA: { u: number; v: number },
  viewB: View
): { p1: { u: number; v: number }; p2: { u: number; v: number } } | null {
  const ray = backProject(viewA, pA.u, pA.v);
  // Two world points along ray
  const near = add(ray.origin, scale(ray.dir, viewA.raw.sod * 0.5));
  const far = add(ray.origin, scale(ray.dir, viewA.raw.sod * 1.5));
  const p1 = projectPoint(viewB, near);
  const p2 = projectPoint(viewB, far);
  if (!p1 || !p2) return null;
  return { p1, p2 };
}

// Compute view angle in degrees between two views (angular separation of source positions).
export function viewSeparation(viewA: View, viewB: View): number {
  const a = normalize(viewA.source);
  const b = normalize(viewB.source);
  const c = Math.max(-1, Math.min(1, dot(a, b)));
  return Math.acos(c) / DEG;
}

// Helpers exported for the panel renderer.
export const Vec = { add, sub, scale, dot, cross, norm, normalize };
