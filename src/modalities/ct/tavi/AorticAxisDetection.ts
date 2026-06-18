import { TAVIVector3D, TAVIPoint2D } from './TAVITypes';
import { TAVIGeometry } from './TAVIGeometry';

export interface AorticAxisResult {
  centerPoint: TAVIVector3D;
  axisDirection: TAVIVector3D;
  confidence: number;
}

/**
 * Automatic aortic axis detection from a contrast-enhanced CT volume.
 *
 * Algorithm:
 * 1. Coarse-pass HU thresholding at stride 2 to find contrast-filled voxels (100–400 HU)
 * 2. Crop to central 60% of volume to exclude chest wall, spine, etc.
 * 3. Compute centroid of qualifying voxels
 * 4. Build 3×3 covariance matrix, eigen-decompose
 * 5. Largest eigenvector = approximate aortic axis direction
 * 6. Orient LVOT→ascending aorta (superior direction)
 */

interface VolumeInfo {
  scalarData: Float32Array | Int16Array | Uint16Array;
  dimensions: [number, number, number];
  spacing: [number, number, number];
  origin: [number, number, number];
  direction: number[]; // 9-element direction cosine matrix (row-major)
}

/** Extract volume info from a Cornerstone IImageVolume */
export function extractVolumeInfo(volume: any): VolumeInfo | null {
  // Cornerstone v4.20+: voxelManager.getScalarData() is the primary accessor.
  // VoxelManager.getScalarData() THROWS (not returns null) when data is unavailable,
  // so we wrap each attempt in try-catch.
  let scalarData: Float32Array | Int16Array | Uint16Array | null = null;
  const vm = volume.voxelManager;

  // Attempt 1: voxelManager.getScalarData()
  if (vm && typeof vm.getScalarData === 'function') {
    try { scalarData = vm.getScalarData(); } catch { /* throws when no data */ }
  }
  // Attempt 2: voxelManager.getCompleteScalarDataArray()
  if (!scalarData && vm && typeof vm.getCompleteScalarDataArray === 'function') {
    try { scalarData = vm.getCompleteScalarDataArray() as any; } catch { /* noop */ }
  }
  // Attempt 3: volume.getScalarData() (older API)
  if (!scalarData && typeof volume.getScalarData === 'function') {
    try { scalarData = volume.getScalarData(); } catch { /* noop */ }
  }
  // Attempt 4: VTK imageData scalars
  if (!scalarData && volume.imageData) {
    try {
      const pointData = volume.imageData.getPointData?.();
      scalarData = pointData?.getScalars?.()?.getData?.();
    } catch { /* noop */ }
  }
  if (!scalarData) return null;

  const dimensions = volume.dimensions as [number, number, number];
  const spacing = volume.spacing as [number, number, number];
  const origin = volume.origin as [number, number, number];
  const direction = volume.direction as number[];

  if (!dimensions || !spacing || !origin || !direction) return null;

  return { scalarData, dimensions, spacing, origin, direction };
}

/** Convert IJK voxel indices to world coordinates using the volume's affine transform */
function ijkToWorld(
  i: number, j: number, k: number,
  info: VolumeInfo
): TAVIVector3D {
  const [ox, oy, oz] = info.origin;
  const [sx, sy, sz] = info.spacing;
  const d = info.direction;
  // direction is a 3×3 matrix stored row-major: [d00, d01, d02, d10, d11, d12, d20, d21, d22]
  return {
    x: ox + d[0] * sx * i + d[1] * sy * j + d[2] * sz * k,
    y: oy + d[3] * sx * i + d[4] * sy * j + d[5] * sz * k,
    z: oz + d[6] * sx * i + d[7] * sy * j + d[8] * sz * k,
  };
}

/**
 * Analytic eigendecomposition for a 3×3 symmetric matrix.
 * Returns eigenvalues (descending) and corresponding eigenvectors.
 */
export function eigenDecompose3x3Symmetric(
  a00: number, a01: number, a02: number,
  a11: number, a12: number,
  a22: number
): { values: [number, number, number]; vectors: [TAVIVector3D, TAVIVector3D, TAVIVector3D] } {
  // Use Cardano's method for the characteristic polynomial of a symmetric 3×3 matrix
  const p1 = a01 * a01 + a02 * a02 + a12 * a12;

  if (p1 < 1e-20) {
    // Matrix is diagonal
    const eigs: [number, number, number] = [a00, a11, a22];
    const vecs: [TAVIVector3D, TAVIVector3D, TAVIVector3D] = [
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 1 },
    ];
    // Sort descending by eigenvalue
    const indices = [0, 1, 2].sort((ia, ib) => eigs[ib] - eigs[ia]);
    return {
      values: [eigs[indices[0]], eigs[indices[1]], eigs[indices[2]]],
      vectors: [vecs[indices[0]], vecs[indices[1]], vecs[indices[2]]],
    };
  }

  const q = (a00 + a11 + a22) / 3;
  const p2 = (a00 - q) * (a00 - q) + (a11 - q) * (a11 - q) + (a22 - q) * (a22 - q) + 2 * p1;
  const p = Math.sqrt(p2 / 6);

  // B = (1/p) * (A - q*I)
  const b00 = (a00 - q) / p;
  const b11 = (a11 - q) / p;
  const b22 = (a22 - q) / p;
  const b01 = a01 / p;
  const b02 = a02 / p;
  const b12 = a12 / p;

  // det(B) / 2
  const detB = b00 * (b11 * b22 - b12 * b12)
             - b01 * (b01 * b22 - b12 * b02)
             + b02 * (b01 * b12 - b11 * b02);
  const halfDetB = Math.max(-1, Math.min(1, detB / 2));

  const phi = Math.acos(halfDetB) / 3;

  const eig1 = q + 2 * p * Math.cos(phi);
  const eig3 = q + 2 * p * Math.cos(phi + (2 * Math.PI / 3));
  const eig2 = 3 * q - eig1 - eig3;

  const eigenvalues: [number, number, number] = [eig1, eig2, eig3];

  // Compute eigenvectors via (A - lambda*I) null space
  function eigenvector(lambda: number): TAVIVector3D {
    const r00 = a00 - lambda, r01 = a01, r02 = a02;
    const r10 = a01, r11 = a11 - lambda, r12 = a12;
    const r20 = a02, r21 = a12, r22 = a22 - lambda;

    // Cross products of rows to find the null space
    const c0 = TAVIGeometry.vectorCross(
      { x: r00, y: r01, z: r02 },
      { x: r10, y: r11, z: r12 }
    );
    const c1 = TAVIGeometry.vectorCross(
      { x: r00, y: r01, z: r02 },
      { x: r20, y: r21, z: r22 }
    );
    const c2 = TAVIGeometry.vectorCross(
      { x: r10, y: r11, z: r12 },
      { x: r20, y: r21, z: r22 }
    );

    const l0 = TAVIGeometry.vectorLength(c0);
    const l1 = TAVIGeometry.vectorLength(c1);
    const l2 = TAVIGeometry.vectorLength(c2);

    if (l0 >= l1 && l0 >= l2) return TAVIGeometry.vectorNormalize(c0);
    if (l1 >= l2) return TAVIGeometry.vectorNormalize(c1);
    return TAVIGeometry.vectorNormalize(c2);
  }

  const vectors: [TAVIVector3D, TAVIVector3D, TAVIVector3D] = [
    eigenvector(eigenvalues[0]),
    eigenvector(eigenvalues[1]),
    eigenvector(eigenvalues[2]),
  ];

  return { values: eigenvalues, vectors };
}

// ── Auto Cross-Section Segmentation ──

export interface AutoSegmentResult {
  /** Ordered boundary points in world coordinates (closed contour) */
  contourPoints: TAVIVector3D[];
  /** Center of the segmented region in world coordinates */
  centerWorld: TAVIVector3D;
  /** 2D binary mask used for segmentation (for debugging) */
  maskSize: number;
}

/**
 * World-to-IJK coordinate conversion using the volume's inverse affine.
 * Returns fractional indices for trilinear interpolation.
 */
function worldToIJK(
  wx: number, wy: number, wz: number,
  info: VolumeInfo
): [number, number, number] {
  // Translate to volume origin
  const dx = wx - info.origin[0];
  const dy = wy - info.origin[1];
  const dz = wz - info.origin[2];
  const d = info.direction;
  const [sx, sy, sz] = info.spacing;

  // direction is orthonormal, so inverse = transpose
  const i = (d[0] * dx + d[3] * dy + d[6] * dz) / sx;
  const j = (d[1] * dx + d[4] * dy + d[7] * dz) / sy;
  const k = (d[2] * dx + d[5] * dy + d[8] * dz) / sz;

  return [i, j, k];
}

/**
 * Sample the volume at a world-space point using nearest-neighbor lookup.
 * Returns NaN if out of bounds.
 */
function sampleVolumeNearest(
  wx: number, wy: number, wz: number,
  info: VolumeInfo
): number {
  const [fi, fj, fk] = worldToIJK(wx, wy, wz, info);
  const i = Math.round(fi);
  const j = Math.round(fj);
  const k = Math.round(fk);
  const [dimI, dimJ, dimK] = info.dimensions;
  if (i < 0 || i >= dimI || j < 0 || j >= dimJ || k < 0 || k >= dimK) return NaN;
  return info.scalarData[i + j * dimI + k * dimI * dimJ];
}

/**
 * Auto-segment a cross-section at a given plane from a contrast-enhanced CT volume.
 *
 * Algorithm:
 * 1. Build a 2D grid on the plane (default ~200x200 at ~0.5mm resolution)
 * 2. Sample HU values from the volume at each grid point
 * 3. Threshold for contrast-filled lumen (100–400 HU, configurable)
 * 4. Flood-fill from the center pixel to isolate the lumen
 * 5. Extract boundary using contour tracing
 * 6. Convert boundary pixels back to world coordinates
 */
export function autoSegmentCrossSectionAtPlane(
  volume: any,
  planeOrigin: TAVIVector3D,
  planeNormal: TAVIVector3D,
  viewUp?: TAVIVector3D,
  options?: {
    gridSize?: number;     // pixels per side (default 200)
    pixelSpacing?: number; // mm per pixel (default 0.3)
    huMin?: number;        // HU lower threshold (default 150)
    huMax?: number;        // HU upper threshold (default 500)
    maxDiameterMm?: number; // reject if equivalent diameter exceeds this (default 55mm)
    minDiameterMm?: number; // reject if equivalent diameter below this (default 8mm)
    searchRadiusMm?: number; // only consider components whose centroid sits within this
                             // radius of the crosshair (default 25mm). Without this,
                             // tiny nearby contrast (calcium, coronary ostium) wins
                             // over a slightly off-center aorta.
  }
): AutoSegmentResult | null {
  const info = extractVolumeInfo(volume);
  if (!info) return null;

  const gridSize = options?.gridSize ?? 200;
  const pixelSpacing = options?.pixelSpacing ?? 0.3;
  const maxDiameterMm = options?.maxDiameterMm ?? 55; // ascending aorta rarely > 50mm
  const minDiameterMm = options?.minDiameterMm ?? 8;  // anything tinier is not a great-vessel lumen
  const searchRadiusMm = options?.searchRadiusMm ?? 25;

  // Build orthonormal basis on the plane
  const normal = TAVIGeometry.vectorNormalize(planeNormal);
  let up = viewUp
    ? TAVIGeometry.vectorNormalize(viewUp)
    : { x: 0, y: 1, z: 0 };

  if (Math.abs(TAVIGeometry.vectorDot(up, normal)) > 0.99) {
    up = { x: 1, y: 0, z: 0 };
  }

  const uRaw = TAVIGeometry.vectorSubtract(
    up,
    TAVIGeometry.vectorScale(normal, TAVIGeometry.vectorDot(up, normal))
  );
  const u = TAVIGeometry.vectorNormalize(uRaw);
  const v = TAVIGeometry.vectorCross(normal, u);

  const halfExtent = (gridSize * pixelSpacing) / 2;

  // Sample the volume into a 2D grid
  const grid = new Float32Array(gridSize * gridSize);
  for (let row = 0; row < gridSize; row++) {
    const vCoord = -halfExtent + (row + 0.5) * pixelSpacing;
    for (let col = 0; col < gridSize; col++) {
      const uCoord = -halfExtent + (col + 0.5) * pixelSpacing;
      const wx = planeOrigin.x + u.x * uCoord + v.x * vCoord;
      const wy = planeOrigin.y + u.y * uCoord + v.y * vCoord;
      const wz = planeOrigin.z + u.z * uCoord + v.z * vCoord;
      grid[row * gridSize + col] = sampleVolumeNearest(wx, wy, wz, info);
    }
  }

  // Sample HU at the seed pixel (== crosshair) and derive the threshold band
  // dynamically. A fixed 150–500 band assumes peak-arterial enhancement; in
  // delayed-phase or sub-optimal contrast studies the actual lumen sits at
  // 80–180 HU and gets excluded, leaving the BFS without any seed to grow
  // from. Anchor every attempt to the seed HU instead — what the clinician
  // points at IS the lumen, by definition, so [seedHU - W, seedHU + W] is
  // the safest band. Cascade widens from tight to loose so the first attempt
  // that grows into a sensibly-sized region wins.
  const centerRow0 = Math.floor(gridSize / 2);
  const centerCol0 = Math.floor(gridSize / 2);
  const seedHU = grid[centerRow0 * gridSize + centerCol0];
  if (!Number.isFinite(seedHU) || seedHU < 30) {
    console.warn(`[AutoSeg] Seed HU=${seedHU} too low — crosshair appears to be off the contrast-filled lumen`);
    return null;
  }
  const callerHuMin = options?.huMin;
  const callerHuMax = options?.huMax;
  // Tight first attempt: lumen pixels cluster within ±40 HU of the seed; the
  // wider [seed-100, seed+200] band catches the partial-volume transition
  // ring (HU drops from ~250 lumen to ~50 soft-tissue over 1–2 pixels) and
  // the boundary ends up 1–2 mm OUTSIDE the actual wall. Start tight; widen
  // only if the tight band yields no qualifying region under the seed.
  const thresholdAttempts: [number, number][] =
    callerHuMin !== undefined || callerHuMax !== undefined
      ? [[callerHuMin ?? 150, callerHuMax ?? 500]]
      : [
          [seedHU - 40, seedHU + 60],
          [seedHU - 60, seedHU + 100],
          [seedHU - 80, seedHU + 150],
          [seedHU - 100, seedHU + 200],
        ];

  for (const [huMin, huMax] of thresholdAttempts) {
    const result = _segmentWithThreshold(
      grid, gridSize, pixelSpacing, huMin, huMax, maxDiameterMm, minDiameterMm, searchRadiusMm,
      planeOrigin, u, v, halfExtent
    );
    if (result) {
      console.log(`[AutoSeg] Success with HU ${huMin}-${huMax}: ${result.contourPoints.length} points, area ~${(result as any)._areaPx * pixelSpacing * pixelSpacing}mm²`);
      return result;
    }
  }

  console.warn('[AutoSeg] All threshold attempts failed');
  return null;
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * q)));
  return sorted[idx];
}

function median(values: number[]): number {
  return percentile(values, 0.5);
}

function circularMedian(values: number[], index: number, radius: number): number {
  const window: number[] = [];
  const n = values.length;
  for (let offset = -radius; offset <= radius; offset++) {
    window.push(values[(index + offset + n) % n]);
  }
  return median(window);
}

function suppressLocalizedOuterSpikes(radii: number[], globalMedian: number): number[] {
  if (radii.length < 16 || !Number.isFinite(globalMedian)) return radii;

  const spikeClampMm = Math.max(1.2, globalMedian * 0.08);
  return radii.map((r, idx) => {
    const broadLocalMedian = circularMedian(radii, idx, 8);
    const narrowLocalMedian = circularMedian(radii, idx, 3);
    const localReference = Math.min(broadLocalMedian, narrowLocalMedian);

    // Narrow external attachments/calcific partial-volume streaks can be
    // brighter than the annulus boundary and create a small lobe outside the
    // valve ring. Clamp only abrupt OUTER spikes; broad, smooth eccentricity is
    // preserved because its local median rises with the true contour.
    if (r > localReference + spikeClampMm) {
      return localReference + spikeClampMm * 0.35;
    }
    return r;
  });
}

/**
 * Annulus-specific auto tracing.
 *
 * The aortic-root annulus is a poor fit for seed-threshold BFS because the
 * annular centroid often lands on leaflet/coaptation tissue rather than
 * contrast-filled lumen. This traces the bright-blood → lower-HU boundary
 * radially from the cusp-derived annulus centre. It is deliberately edge-based
 * rather than seed-based, so it can catch the contrast interface even when the
 * centre pixel is not contrast.
 */
export function autoTraceAnnulusContrastEdgeAtPlane(
  volume: any,
  planeOrigin: TAVIVector3D,
  planeNormal: TAVIVector3D,
  viewUp?: TAVIVector3D,
  options?: {
    radialCount?: number;
    radialStepMm?: number;
    minRadiusMm?: number;
    maxRadiusMm?: number;
    minDiameterMm?: number;
    maxDiameterMm?: number;
  }
): AutoSegmentResult | null {
  const info = extractVolumeInfo(volume);
  if (!info) return null;

  const radialCount = options?.radialCount ?? 96;
  const radialStepMm = options?.radialStepMm ?? 0.35;
  const minRadiusMm = options?.minRadiusMm ?? 5.5;
  const maxRadiusMm = options?.maxRadiusMm ?? 22;
  const minDiameterMm = options?.minDiameterMm ?? 12;
  const maxDiameterMm = options?.maxDiameterMm ?? 38;

  const normal = TAVIGeometry.vectorNormalize(planeNormal);
  let up = viewUp ? TAVIGeometry.vectorNormalize(viewUp) : { x: 0, y: 1, z: 0 };
  if (Math.abs(TAVIGeometry.vectorDot(up, normal)) > 0.99) up = { x: 1, y: 0, z: 0 };
  const uRaw = TAVIGeometry.vectorSubtract(up, TAVIGeometry.vectorScale(normal, TAVIGeometry.vectorDot(up, normal)));
  const u = TAVIGeometry.vectorNormalize(uRaw);
  const v = TAVIGeometry.vectorCross(normal, u);

  const sampleAt = (du: number, dv: number): number =>
    sampleVolumeNearest(
      planeOrigin.x + u.x * du + v.x * dv,
      planeOrigin.y + u.y * du + v.y * dv,
      planeOrigin.z + u.z * du + v.z * dv,
      info
    );

  const centralSamples: number[] = [];
  for (let rr = 1; rr <= 12; rr += 1.0) {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
      const hu = sampleAt(Math.cos(a) * rr, Math.sin(a) * rr);
      if (Number.isFinite(hu) && hu > -200 && hu < 900) centralSamples.push(hu);
    }
  }
  if (centralSamples.length < 16) return null;

  const lumenHU = percentile(centralSamples.filter(v => v < 650), 0.85);
  const tissueHU = percentile(centralSamples, 0.18);
  if (!Number.isFinite(lumenHU) || lumenHU < 55) return null;

  // ── Pass 1: build every radial HU profile and estimate the perivascular
  // background from the OUTER third of each ray. A globally-robust background
  // (rather than a central percentile, which at the annular plane is itself
  // mostly lumen) keeps the contrast level stable regardless of whether the
  // plane centre landed on blood pool or leaflet tissue. ──
  const profiles: { r: number; hu: number }[][] = [];
  const outerSamples: number[] = [];

  for (let i = 0; i < radialCount; i++) {
    const angle = (i / radialCount) * Math.PI * 2;
    const dirU = Math.cos(angle);
    const dirV = Math.sin(angle);

    const raw: { r: number; hu: number }[] = [];
    for (let r = radialStepMm; r <= maxRadiusMm; r += radialStepMm) {
      const hu = sampleAt(dirU * r, dirV * r);
      raw.push({ r, hu: Number.isFinite(hu) ? hu : -1000 });
    }
    const smooth = raw.map((p, idx) => {
      const prev = raw[Math.max(0, idx - 1)].hu;
      const next = raw[Math.min(raw.length - 1, idx + 1)].hu;
      return { r: p.r, hu: (prev + p.hu * 2 + next) / 4 };
    });
    profiles.push(smooth);

    const outerStart = Math.floor(smooth.length * 0.7);
    for (let j = outerStart; j < smooth.length; j++) {
      if (smooth[j].hu > -400) outerSamples.push(smooth[j].hu);
    }
  }

  const backgroundHU =
    outerSamples.length >= 8 ? percentile(outerSamples, 0.4) : tissueHU;
  // Full-width-half-maximum contrast level: midpoint of background and lumen,
  // kept strictly between the two so neither a low-contrast lumen (the cap must
  // not fall below background) nor a noisy background can collapse it. Earlier
  // a `min(lumen-40, …)` cap could drop `half` below its own floor when the
  // lumen was < ~100 HU (delayed-phase scans), grossly over-sizing the contour.
  const midpoint = backgroundHU + (lumenHU - backgroundHU) * 0.5;
  const half = Math.max(backgroundHU + 20, Math.min(lumenHU - 20, midpoint));

  // ── Pass 2: per ray, take the first FWHM down-crossing — scanning OUTWARD —
  // that stays below the contrast level for a sustained span. The sustain span
  // bridges internal leaflet/calcific gaps (which return to lumen brightness
  // just beyond the notch) while still stopping at the true blood-pool exit to
  // background; this avoids both the undershoot of a naive first-crossing and
  // the overshoot of an "outermost edge" preference. Sub-step interpolation
  // places the edge exactly on the half-maximum, so the contour tracks
  // contrast. A handful of rays that bridge into a neighbouring structure are
  // bounded afterwards by the median clip + outer-spike suppression. ──
  const minIdx = Math.max(1, Math.floor(minRadiusMm / radialStepMm));
  const sustainSteps = Math.max(2, Math.round(2.25 / radialStepMm));
  // One slot per ray (NaN = ray found no contrast edge). The array MUST stay
  // angularly uniform: the circular smoothing + index-based reconstruction below
  // assume evenly spaced angles, so failed rays are interpolated rather than
  // dropped (dropping them remaps the surviving angles and distorts the shape).
  const rayRadii: number[] = new Array(radialCount).fill(NaN);
  let validCount = 0;

  for (let i = 0; i < radialCount; i++) {
    const smooth = profiles[i];
    if (smooth.length < 8) continue;

    // The down-crossing requires smooth[j] >= half, so a ray that never reaches
    // contrast yields no crossing and is skipped — no separate lumen gate is
    // needed (and gating on the inner core would wrongly reject annular lumina
    // whose centre sits on leaflet tissue, the very case this tracer targets).
    let edgeR: number | null = null;
    for (let j = minIdx; j < smooth.length - 1; j++) {
      if (smooth[j].hu < half || smooth[j + 1].hu >= half) continue;
      // Confirm the drop is sustained for ~2.25mm so we do not stop on a notch.
      let sustained = true;
      for (let k = j + 1; k <= Math.min(smooth.length - 1, j + sustainSteps); k++) {
        if (smooth[k].hu >= half) {
          sustained = false;
          break;
        }
      }
      if (!sustained) continue;
      const a = smooth[j].hu;
      const b = smooth[j + 1].hu;
      const t = (a - half) / Math.max(1e-3, a - b);
      edgeR = smooth[j].r + t * radialStepMm;
      break;
    }
    if (edgeR == null) continue;
    rayRadii[i] = Math.max(minRadiusMm, Math.min(maxRadiusMm, edgeR));
    validCount++;
  }

  if (validCount < Math.max(24, radialCount * 0.45)) return null;

  // Fill failed rays by circular linear interpolation between nearest neighbours
  // so every angular bin has a radius before smoothing/reconstruction.
  const radii = rayRadii.slice();
  for (let i = 0; i < radialCount; i++) {
    if (!Number.isNaN(rayRadii[i])) continue;
    let lo = -1, hi = -1, ld = 0, hd = 0;
    for (let d = 1; d < radialCount; d++) { const idx = (i - d + radialCount) % radialCount; if (!Number.isNaN(rayRadii[idx])) { lo = idx; ld = d; break; } }
    for (let d = 1; d < radialCount; d++) { const idx = (i + d) % radialCount; if (!Number.isNaN(rayRadii[idx])) { hi = idx; hd = d; break; } }
    if (lo >= 0 && hi >= 0) radii[i] = rayRadii[lo] + (rayRadii[hi] - rayRadii[lo]) * (ld / (ld + hd));
    else if (lo >= 0) radii[i] = rayRadii[lo];
    else if (hi >= 0) radii[i] = rayRadii[hi];
  }

  const medR = median(radii);
  if (!Number.isFinite(medR)) return null;

  const clippedRadii = radii.map(r => Math.max(medR * 0.65, Math.min(medR * 1.35, r)));
  let smoothedRadii = suppressLocalizedOuterSpikes(clippedRadii, medR);
  smoothedRadii = suppressLocalizedOuterSpikes(smoothedRadii, medR);
  for (let pass = 0; pass < 2; pass++) {
    smoothedRadii = smoothedRadii.map((_, idx) => {
      const med = circularMedian(smoothedRadii, idx, 2);
      const prev = smoothedRadii[(idx - 1 + smoothedRadii.length) % smoothedRadii.length];
      const next = smoothedRadii[(idx + 1) % smoothedRadii.length];
      return med * 0.5 + (prev + next) * 0.25;
    });
  }

  const contourPoints = smoothedRadii.map((r, idx) => {
    const angle = (idx / smoothedRadii.length) * Math.PI * 2;
    const dirU = Math.cos(angle);
    const dirV = Math.sin(angle);
    return {
      x: planeOrigin.x + u.x * dirU * r + v.x * dirV * r,
      y: planeOrigin.y + u.y * dirU * r + v.y * dirV * r,
      z: planeOrigin.z + u.z * dirU * r + v.z * dirV * r,
    };
  });

  const geo = TAVIGeometry.geometryForWorldContour(contourPoints, normal);
  if (!geo) return null;
  if (geo.equivalentDiameterMm < minDiameterMm || geo.equivalentDiameterMm > maxDiameterMm) {
    console.warn(`[AnnulusEdgeTrace] Rejected equiv diameter ${geo.equivalentDiameterMm.toFixed(1)}mm`);
    return null;
  }

  return { contourPoints, centerWorld: geo.centroid, maskSize: radialCount };
}

export interface ContourPixelSample {
  /** HU value of every grid cell whose center falls inside the polygon. */
  pixelValues: Float32Array;
  /** Area each sampled cell represents (pixelSpacing²), mm². */
  pixelAreaMm2: number;
  sampleCount: number;
}

/** Even-odd ray-cast point-in-polygon test on the projected 2D plane. */
function pointInPolygon2D(px: number, py: number, poly: TAVIPoint2D[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersects = (yi > py) !== (yj > py) &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Rasterize HU values inside a world-space contour by projecting it onto its
 * own plane (same basis convention as TAVIGeometry area/perimeter), walking a
 * regular grid over the polygon interior, and sampling the volume at each cell
 * center with nearest-neighbour lookup.
 *
 * Used to drive 2D Agatston scoring for annulus / LVOT / per-cusp regions.
 * Nearest-neighbour (not trilinear) is deliberate: Agatston is defined on
 * native voxels, and HU smoothing would corrupt the 130/200/300/400 bands.
 *
 * @returns null if the volume is unreadable or fewer than 4 cells sampled.
 */
export function samplePixelValuesInWorldContour(
  volume: any,
  worldPoints: TAVIVector3D[],
  planeNormal: TAVIVector3D,
  options?: { pixelSpacing?: number; padMm?: number }
): ContourPixelSample | null {
  if (!worldPoints || worldPoints.length < 3) return null;
  const info = extractVolumeInfo(volume);
  if (!info) return null;

  const pixelSpacing = options?.pixelSpacing ?? 0.5;
  const padMm = options?.padMm ?? 2;

  // Centroid (plane origin) = mean of contour points.
  const centroid: TAVIVector3D = { x: 0, y: 0, z: 0 };
  for (const p of worldPoints) {
    centroid.x += p.x; centroid.y += p.y; centroid.z += p.z;
  }
  centroid.x /= worldPoints.length;
  centroid.y /= worldPoints.length;
  centroid.z /= worldPoints.length;

  const basis = TAVIGeometry.planeBasisMake(planeNormal);
  const poly2D = worldPoints.map((p) => TAVIGeometry.projectWorldPointWithBasis(p, centroid, basis));

  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const q of poly2D) {
    if (q.x < minU) minU = q.x;
    if (q.x > maxU) maxU = q.x;
    if (q.y < minV) minV = q.y;
    if (q.y > maxV) maxV = q.y;
  }
  if (!Number.isFinite(minU) || !Number.isFinite(minV)) return null;
  minU -= padMm; minV -= padMm; maxU += padMm; maxV += padMm;

  const values: number[] = [];
  for (let u = minU; u <= maxU; u += pixelSpacing) {
    for (let v = minV; v <= maxV; v += pixelSpacing) {
      if (!pointInPolygon2D(u, v, poly2D)) continue;
      const wx = centroid.x + basis.basisU.x * u + basis.basisV.x * v;
      const wy = centroid.y + basis.basisU.y * u + basis.basisV.y * v;
      const wz = centroid.z + basis.basisU.z * u + basis.basisV.z * v;
      const hu = sampleVolumeNearest(wx, wy, wz, info);
      if (!Number.isNaN(hu)) values.push(hu);
    }
  }

  if (values.length < 4) return null;
  return {
    pixelValues: Float32Array.from(values),
    pixelAreaMm2: pixelSpacing * pixelSpacing,
    sampleCount: values.length,
  };
}

/**
 * Snap a clicked coronary-ostium seed onto the contrast-filled lumen centroid
 * within a small sphere, improving reproducibility of coronary-height picks.
 * Returns null on any failure so the caller keeps the raw click.
 */
export function snapPointToLumenCentroid(
  volume: any,
  seed: TAVIVector3D,
  opts?: { radiusMm?: number; huMin?: number; huMax?: number }
): TAVIVector3D | null {
  const info = extractVolumeInfo(volume);
  if (!info) return null;
  const radiusMm = opts?.radiusMm ?? 3;
  const huMin = opts?.huMin ?? 200;
  const huMax = opts?.huMax ?? 600;
  const [sx, sy, sz] = info.spacing;
  const ri = Math.max(1, Math.round(radiusMm / sx));
  const rj = Math.max(1, Math.round(radiusMm / sy));
  const rk = Math.max(1, Math.round(radiusMm / sz));
  const [ci, cj, ck] = worldToIJK(seed.x, seed.y, seed.z, info).map(Math.round) as [number, number, number];

  let sumX = 0, sumY = 0, sumZ = 0, count = 0;
  for (let k = ck - rk; k <= ck + rk; k++) {
    for (let j = cj - rj; j <= cj + rj; j++) {
      for (let i = ci - ri; i <= ci + ri; i++) {
        const wx = info.origin[0] + info.direction[0] * sx * i + info.direction[1] * sy * j + info.direction[2] * sz * k;
        const wy = info.origin[1] + info.direction[3] * sx * i + info.direction[4] * sy * j + info.direction[5] * sz * k;
        const wz = info.origin[2] + info.direction[6] * sx * i + info.direction[7] * sy * j + info.direction[8] * sz * k;
        // Spherical crop in world space.
        if ((wx - seed.x) ** 2 + (wy - seed.y) ** 2 + (wz - seed.z) ** 2 > radiusMm * radiusMm) continue;
        const hu = sampleVolumeNearest(wx, wy, wz, info);
        if (Number.isNaN(hu) || hu < huMin || hu > huMax) continue;
        sumX += wx; sumY += wy; sumZ += wz; count++;
      }
    }
  }
  if (count < 8) return null;
  return { x: sumX / count, y: sumY / count, z: sumZ / count };
}

/**
 * Snap a cusp/sinus nadir seed toward the local minimum-HU point along the
 * aortic axis within a small window (the leaflet hinge sits at the bright-blood
 * → wall transition). Heuristic assist; the marker stays draggable afterward.
 * Returns null on failure so the caller keeps the raw click.
 */
export function snapPointToAxialMinimum(
  volume: any,
  seed: TAVIVector3D,
  axisDirection: TAVIVector3D,
  opts?: { searchMm?: number; stepMm?: number; radiusMm?: number }
): TAVIVector3D | null {
  const info = extractVolumeInfo(volume);
  if (!info) return null;
  const dir = TAVIGeometry.vectorNormalize(axisDirection);
  if (TAVIGeometry.vectorIsZero(dir)) return null;
  const searchMm = opts?.searchMm ?? 4;
  const stepMm = opts?.stepMm ?? 0.5;
  const radiusMm = opts?.radiusMm ?? 1.5;

  // Neighbourhood offsets — explicit list so a zero radius means a single
  // sample rather than a zero-step infinite loop.
  const offsets = radiusMm > 0 ? [-radiusMm, 0, radiusMm] : [0];
  const step = stepMm > 0 ? stepMm : 0.5;

  let bestT = 0;
  let bestMean = Infinity;
  let anyValid = false;
  for (let t = -searchMm; t <= searchMm; t += step) {
    const c = TAVIGeometry.vectorAdd(seed, TAVIGeometry.vectorScale(dir, t));
    let sum = 0, n = 0;
    for (const dz of offsets) {
      for (const dy of offsets) {
        for (const dx of offsets) {
          const hu = sampleVolumeNearest(c.x + dx, c.y + dy, c.z + dz, info);
          if (!Number.isNaN(hu)) { sum += hu; n++; }
        }
      }
    }
    if (n === 0) continue;
    anyValid = true;
    const mean = sum / n;
    if (mean < bestMean) { bestMean = mean; bestT = t; }
  }
  if (!anyValid) return null;
  return TAVIGeometry.vectorAdd(seed, TAVIGeometry.vectorScale(dir, bestT));
}

/** Internal: attempt segmentation with a specific HU threshold pair */
function _segmentWithThreshold(
  grid: Float32Array,
  gridSize: number,
  pixelSpacing: number,
  huMin: number,
  huMax: number,
  maxDiameterMm: number,
  minDiameterMm: number,
  searchRadiusMm: number,
  planeOrigin: TAVIVector3D,
  u: TAVIVector3D,
  v: TAVIVector3D,
  halfExtent: number,
): (AutoSegmentResult & { _areaPx: number }) | null {
  // Binary threshold mask
  const mask = new Uint8Array(gridSize * gridSize);
  for (let i = 0; i < grid.length; i++) {
    const hu = grid[i];
    mask[i] = (!isNaN(hu) && hu >= huMin && hu <= huMax) ? 1 : 0;
  }

  // Morphological erosion (1 pixel) to disconnect touching structures
  const eroded = new Uint8Array(gridSize * gridSize);
  for (let r = 1; r < gridSize - 1; r++) {
    for (let c = 1; c < gridSize - 1; c++) {
      if (mask[r * gridSize + c] === 1 &&
          mask[(r - 1) * gridSize + c] === 1 &&
          mask[(r + 1) * gridSize + c] === 1 &&
          mask[r * gridSize + (c - 1)] === 1 &&
          mask[r * gridSize + (c + 1)] === 1) {
        eroded[r * gridSize + c] = 1;
      }
    }
  }

  // ── Seeded flood-fill from the crosshair ──
  // The crosshair sits at the grid centre by construction. We BFS from there
  // and grow into the eroded mask. This is the LA-segmentation pattern: the
  // user has already aligned the crosshair to the structure of interest, so
  // we segment exactly what they clicked — never a nearby brighter object,
  // never a distant larger blob. If the seed pixel itself isn't in the mask
  // (crosshair off-lumen or HU threshold too tight), we fall back to the
  // pre-erosion mask once, then give up. `searchRadiusMm` is no longer used
  // for component selection — kept on the signature for backward compatibility.
  void searchRadiusMm;

  const centerRow = Math.floor(gridSize / 2);
  const centerCol = Math.floor(gridSize / 2);
  const seedIdx = centerRow * gridSize + centerCol;
  const seedSource = eroded[seedIdx] === 1 ? eroded : (mask[seedIdx] === 1 ? mask : null);
  if (!seedSource) return null;

  const erodedFilled = new Uint8Array(eroded);
  const seedStack: number[] = [seedIdx];
  erodedFilled[seedIdx] = 2;
  let seedCount = 0;
  while (seedStack.length > 0) {
    const idx = seedStack.pop()!;
    seedCount++;
    const r = Math.floor(idx / gridSize);
    const c = idx % gridSize;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= gridSize || nc < 0 || nc >= gridSize) continue;
      const nIdx = nr * gridSize + nc;
      if (erodedFilled[nIdx] !== 2 && seedSource[nIdx] === 1) {
        erodedFilled[nIdx] = 2;
        seedStack.push(nIdx);
      }
    }
  }

  if (seedCount < 20) return null;

  // Now dilate back: use the original mask but only pixels that are 4-connected to the eroded fill
  // This recovers the boundary precision lost by erosion
  const filled = new Uint8Array(gridSize * gridSize);
  const stack2: number[] = [];

  // Seed from the eroded filled region
  for (let i = 0; i < gridSize * gridSize; i++) {
    if (erodedFilled[i] === 2 && mask[i] === 1) {
      filled[i] = 2;
      stack2.push(i);
    }
  }

  // Grow into original mask (dilation back)
  while (stack2.length > 0) {
    const idx = stack2.pop()!;
    const r = Math.floor(idx / gridSize);
    const c = idx % gridSize;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < gridSize && nc >= 0 && nc < gridSize) {
        const nIdx = nr * gridSize + nc;
        if (filled[nIdx] === 0 && mask[nIdx] === 1) {
          filled[nIdx] = 2;
          stack2.push(nIdx);
        }
      }
    }
  }

  // ── Fill SMALL interior holes (calcium plaque, micro non-contrast pixels) ──
  // The HU band excludes calcium (>>seedHU + 100) and any sub-threshold pixel
  // inside the lumen, creating internal "holes" the boundary tracer would
  // otherwise wrap around — indenting into the lumen at every calcified spot.
  //
  // The fill is SIZE-CAPPED so it stays safe for asymmetric lumens (sinus
  // Valsalva, horseshoe-shaped aortic root cross-sections). When the lumen
  // partially encircles a non-contrast pocket — peri-valvular fat, the gap
  // between aorta and pulmonary artery — that pocket appears as a "hole" too,
  // and unconditionally filling it bulges the contour outward into mediastinum.
  // A 25 mm² cap (~5.6 mm equivalent diameter) keeps calcium plaque in but
  // leaves real anatomical pockets out.
  const holeAreaCapMm2 = 25;
  const holeMaxPx = Math.max(4, Math.floor(holeAreaCapMm2 / (pixelSpacing * pixelSpacing)));

  const exterior = new Uint8Array(gridSize * gridSize);
  const exteriorStack: number[] = [];
  for (let c = 0; c < gridSize; c++) {
    if (filled[c] !== 2) { exterior[c] = 1; exteriorStack.push(c); }
    const bottom = (gridSize - 1) * gridSize + c;
    if (filled[bottom] !== 2) { exterior[bottom] = 1; exteriorStack.push(bottom); }
  }
  for (let r = 0; r < gridSize; r++) {
    const left = r * gridSize;
    if (filled[left] !== 2) { exterior[left] = 1; exteriorStack.push(left); }
    const right = left + gridSize - 1;
    if (filled[right] !== 2) { exterior[right] = 1; exteriorStack.push(right); }
  }
  while (exteriorStack.length > 0) {
    const idx = exteriorStack.pop()!;
    const r = Math.floor(idx / gridSize);
    const c = idx % gridSize;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= gridSize || nc < 0 || nc >= gridSize) continue;
      const nIdx = nr * gridSize + nc;
      if (exterior[nIdx] === 0 && filled[nIdx] !== 2) {
        exterior[nIdx] = 1;
        exteriorStack.push(nIdx);
      }
    }
  }

  // Group remaining non-filled, non-exterior pixels into connected interior
  // holes. Fill only the holes whose area stays under holeMaxPx.
  const holeLabel = new Int32Array(gridSize * gridSize);
  for (let i = 0; i < filled.length; i++) {
    if (filled[i] === 2 || exterior[i] === 1 || holeLabel[i] !== 0) continue;
    const cluster: number[] = [];
    const stack: number[] = [i];
    holeLabel[i] = 1;
    while (stack.length > 0) {
      const idx = stack.pop()!;
      cluster.push(idx);
      const r = Math.floor(idx / gridSize);
      const c = idx % gridSize;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= gridSize || nc < 0 || nc >= gridSize) continue;
        const nIdx = nr * gridSize + nc;
        if (holeLabel[nIdx] === 0 && filled[nIdx] !== 2 && exterior[nIdx] === 0) {
          holeLabel[nIdx] = 1;
          stack.push(nIdx);
        }
      }
    }
    if (cluster.length <= holeMaxPx) {
      for (const idx of cluster) filled[idx] = 2;
    }
  }

  let filledCount = 0;
  for (let i = 0; i < filled.length; i++) {
    if (filled[i] === 2) filledCount++;
  }

  if (filledCount < 20) return null;

  // Check area: reject if too large (leakage detected) OR too small (latched
  // onto a calcium fleck / coronary branch instead of a great-vessel lumen).
  const areaMm2 = filledCount * pixelSpacing * pixelSpacing;
  const equivDiameterMm = 2 * Math.sqrt(areaMm2 / Math.PI);
  if (equivDiameterMm > maxDiameterMm) {
    console.warn(`[AutoSeg] Rejected HU ${huMin}-${huMax}: equiv diameter ${equivDiameterMm.toFixed(1)}mm > max ${maxDiameterMm}mm (area=${areaMm2.toFixed(0)}mm²)`);
    return null;
  }
  if (equivDiameterMm < minDiameterMm) {
    console.warn(`[AutoSeg] Rejected HU ${huMin}-${huMax}: equiv diameter ${equivDiameterMm.toFixed(1)}mm < min ${minDiameterMm}mm (likely calcium/coronary, not lumen)`);
    return null;
  }

  // ── Extract boundary pixels (filled=2 with at least one non-2 neighbor) ──
  const boundary: [number, number][] = [];
  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      if (filled[r * gridSize + c] !== 2) continue;
      let isBoundary = false;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= gridSize || nc < 0 || nc >= gridSize || filled[nr * gridSize + nc] !== 2) {
          isBoundary = true;
          break;
        }
      }
      if (isBoundary) boundary.push([r, c]);
    }
  }

  if (boundary.length < 8) return null;

  // Compute centroid of boundary
  let centR = 0, centC = 0;
  for (const [r, c] of boundary) {
    centR += r;
    centC += c;
  }
  centR /= boundary.length;
  centC /= boundary.length;

  // Sort by angle from centroid
  boundary.sort((a, b) => {
    const angleA = Math.atan2(a[0] - centR, a[1] - centC);
    const angleB = Math.atan2(b[0] - centR, b[1] - centC);
    return angleA - angleB;
  });

  // For each angular bin, keep the OUTERMOST point in that bin (75th-percentile
  // radius, not median). The lumen-soft-tissue HU contrast is sharp, so the
  // outermost boundary pixel in each angle slot is the real edge; median
  // pulled the contour inward whenever the boundary had any inward jaggedness
  // from contrast speckle, leaving a visible gap between the contour and the
  // true lumen wall. Use 75th percentile (not strict max) to suppress single-
  // pixel outliers from noise. Higher angular resolution (120 bins ≈ 3°)
  // preserves fine boundary detail.
  const numBins = 120;
  const binned: [number, number][] = [];
  const binSize = boundary.length / numBins;

  for (let b = 0; b < numBins; b++) {
    const start = Math.floor(b * binSize);
    const end = Math.floor((b + 1) * binSize);
    if (start >= end) continue;

    const radii: { r: number; c: number; dist: number }[] = [];
    for (let i = start; i < end; i++) {
      const [pr, pc] = boundary[i];
      const dist = Math.sqrt((pr - centR) ** 2 + (pc - centC) ** 2);
      radii.push({ r: pr, c: pc, dist });
    }
    radii.sort((a, b) => a.dist - b.dist);
    const q75Idx = Math.min(radii.length - 1, Math.floor(radii.length * 0.75));
    const pick = radii[q75Idx];
    binned.push([pick.r, pick.c]);
  }

  // Subsample to ~80 points (was 60 — keep more detail with the finer bins).
  const maxPoints = 80;
  let ordered: [number, number][];
  if (binned.length > maxPoints) {
    ordered = [];
    const step = binned.length / maxPoints;
    for (let i = 0; i < maxPoints; i++) {
      ordered.push(binned[Math.floor(i * step)]);
    }
  } else {
    ordered = binned;
  }

  // Light smoothing: ONE pass with low-weight neighbours [0.15, 0.7, 0.15].
  // The previous 3-pass / [0.2, 0.6, 0.2] kernel was effectively a Gaussian
  // blur with sigma ≈ 1.5 bins (~5° on the circumference) — enough to round
  // off cusp pockets and pull the contour inward by ~1–2 mm.
  for (let pass = 0; pass < 1; pass++) {
    const smoothed: [number, number][] = [];
    const n = ordered.length;
    for (let i = 0; i < n; i++) {
      const prev = ordered[(i - 1 + n) % n];
      const curr = ordered[i];
      const next = ordered[(i + 1) % n];
      smoothed.push([
        prev[0] * 0.15 + curr[0] * 0.7 + next[0] * 0.15,
        prev[1] * 0.15 + curr[1] * 0.7 + next[1] * 0.15,
      ]);
    }
    ordered = smoothed;
  }

  // Convert pixel coordinates back to world
  const contourPoints: TAVIVector3D[] = ordered.map(([row, col]) => {
    const uCoord = -halfExtent + (col + 0.5) * pixelSpacing;
    const vCoord = -halfExtent + (row + 0.5) * pixelSpacing;
    return {
      x: planeOrigin.x + u.x * uCoord + v.x * vCoord,
      y: planeOrigin.y + u.y * uCoord + v.y * vCoord,
      z: planeOrigin.z + u.z * uCoord + v.z * vCoord,
    };
  });

  const centerUCoord = -halfExtent + (centC + 0.5) * pixelSpacing;
  const centerVCoord = -halfExtent + (centR + 0.5) * pixelSpacing;
  const centerWorld: TAVIVector3D = {
    x: planeOrigin.x + u.x * centerUCoord + v.x * centerVCoord,
    y: planeOrigin.y + u.y * centerUCoord + v.y * centerVCoord,
    z: planeOrigin.z + u.z * centerUCoord + v.z * centerVCoord,
  };

  return { contourPoints, centerWorld, maskSize: gridSize, _areaPx: filledCount } as any;
}

/**
 * Detect the aortic axis from a LOCAL region around a seed point.
 * This crops to a ~60mm cube around the seed so PCA finds the aortic root axis
 * specifically, rather than the descending aorta or other vertical structures.
 */
export function detectAorticAxisLocal(
  volume: any,
  seedPoint: TAVIVector3D,
  radiusMm = 35
): AorticAxisResult | null {
  const info = extractVolumeInfo(volume);
  if (!info) return null;

  const [dimI, dimJ, dimK] = info.dimensions;
  if (dimI * dimJ * dimK === 0) return null;

  // Convert seed point to IJK
  const [si, sj, sk] = worldToIJK(seedPoint.x, seedPoint.y, seedPoint.z, info);

  // Compute radius in voxels for each axis
  const ri = Math.ceil(radiusMm / info.spacing[0]);
  const rj = Math.ceil(radiusMm / info.spacing[1]);
  const rk = Math.ceil(radiusMm / info.spacing[2]);

  const iMin = Math.max(0, Math.floor(si) - ri);
  const iMax = Math.min(dimI, Math.floor(si) + ri);
  const jMin = Math.max(0, Math.floor(sj) - rj);
  const jMax = Math.min(dimJ, Math.floor(sj) + rj);
  const kMin = Math.max(0, Math.floor(sk) - rk);
  const kMax = Math.min(dimK, Math.floor(sk) + rk);

  console.log(`[AxisDetect] Local region: i[${iMin}-${iMax}] j[${jMin}-${jMax}] k[${kMin}-${kMax}] (seed IJK: ${si.toFixed(0)},${sj.toFixed(0)},${sk.toFixed(0)}, radius=${radiusMm}mm)`);

  // Tighter HU range targets contrast-filled aortic lumen specifically
  const HU_MIN = 200;
  const HU_MAX = 600;
  const stride = 1; // full resolution in local region

  let sumX = 0, sumY = 0, sumZ = 0;
  let count = 0;
  const qualifyingPoints: TAVIVector3D[] = [];

  for (let k = kMin; k < kMax; k += stride) {
    for (let j = jMin; j < jMax; j += stride) {
      for (let i = iMin; i < iMax; i += stride) {
        const idx = i + j * dimI + k * dimI * dimJ;
        const hu = info.scalarData[idx];
        if (hu >= HU_MIN && hu <= HU_MAX) {
          const wp = ijkToWorld(i, j, k, info);
          // Additional distance check in world space (spherical crop)
          const dx = wp.x - seedPoint.x;
          const dy = wp.y - seedPoint.y;
          const dz = wp.z - seedPoint.z;
          if (dx * dx + dy * dy + dz * dz > radiusMm * radiusMm) continue;

          qualifyingPoints.push(wp);
          sumX += wp.x;
          sumY += wp.y;
          sumZ += wp.z;
          count++;
        }
      }
    }
  }

  console.log(`[AxisDetect] Found ${count} qualifying voxels in local region`);
  if (count < 200) return null;

  const centroid: TAVIVector3D = { x: sumX / count, y: sumY / count, z: sumZ / count };

  // Build covariance matrix
  let cov00 = 0, cov01 = 0, cov02 = 0;
  let cov11 = 0, cov12 = 0, cov22 = 0;

  for (const p of qualifyingPoints) {
    const dx = p.x - centroid.x;
    const dy = p.y - centroid.y;
    const dz = p.z - centroid.z;
    cov00 += dx * dx;
    cov01 += dx * dy;
    cov02 += dx * dz;
    cov11 += dy * dy;
    cov12 += dy * dz;
    cov22 += dz * dz;
  }
  cov00 /= count; cov01 /= count; cov02 /= count;
  cov11 /= count; cov12 /= count; cov22 /= count;

  const { values, vectors } = eigenDecompose3x3Symmetric(cov00, cov01, cov02, cov11, cov12, cov22);

  let axisDirection = vectors[0];
  const eigenSum = Math.abs(values[0]) + Math.abs(values[1]) + Math.abs(values[2]);
  const confidence = eigenSum > 0 ? Math.abs(values[0]) / eigenSum : 0;

  // Orient: axis should point from LVOT (inferior) toward ascending aorta (superior)
  const volUp: TAVIVector3D = {
    x: info.direction[2],
    y: info.direction[5],
    z: info.direction[8],
  };
  if (TAVIGeometry.vectorDot(axisDirection, volUp) < 0) {
    axisDirection = TAVIGeometry.vectorScale(axisDirection, -1);
  }
  axisDirection = TAVIGeometry.vectorNormalize(axisDirection);

  console.log(`[AxisDetect] Local axis: dir=${JSON.stringify(axisDirection)}, confidence=${confidence.toFixed(3)}, centroid=${JSON.stringify(centroid)}`);

  return { centerPoint: centroid, axisDirection, confidence };
}

/**
 * Detect the aortic axis from a contrast-enhanced CT volume (global search).
 * Returns the center point and axis direction, or null if detection fails.
 */
export function detectAorticAxis(volume: any): AorticAxisResult | null {
  const info = extractVolumeInfo(volume);
  if (!info) return null;

  const [dimI, dimJ, dimK] = info.dimensions;
  const totalVoxels = dimI * dimJ * dimK;
  if (totalVoxels === 0) return null;

  // Crop to central 60% to exclude chest wall, spine, etc.
  const cropFraction = 0.2; // skip 20% on each side
  const iMin = Math.floor(dimI * cropFraction);
  const iMax = Math.ceil(dimI * (1 - cropFraction));
  const jMin = Math.floor(dimJ * cropFraction);
  const jMax = Math.ceil(dimJ * (1 - cropFraction));
  const kMin = Math.floor(dimK * cropFraction);
  const kMax = Math.ceil(dimK * (1 - cropFraction));

  // Coarse pass: stride 2, collect contrast-filled voxels (100–400 HU)
  const HU_MIN = 100;
  const HU_MAX = 400;
  const stride = 2;

  // Accumulate in world coordinates for centroid and covariance
  let sumX = 0, sumY = 0, sumZ = 0;
  let count = 0;

  // First pass: compute centroid
  const qualifyingPoints: TAVIVector3D[] = [];

  for (let k = kMin; k < kMax; k += stride) {
    for (let j = jMin; j < jMax; j += stride) {
      for (let i = iMin; i < iMax; i += stride) {
        const idx = i + j * dimI + k * dimI * dimJ;
        const hu = info.scalarData[idx];
        if (hu >= HU_MIN && hu <= HU_MAX) {
          const wp = ijkToWorld(i, j, k, info);
          qualifyingPoints.push(wp);
          sumX += wp.x;
          sumY += wp.y;
          sumZ += wp.z;
          count++;
        }
      }
    }
  }

  // Need sufficient voxels for a reliable estimate
  if (count < 500) return null;

  const centroid: TAVIVector3D = {
    x: sumX / count,
    y: sumY / count,
    z: sumZ / count,
  };

  // Build 3×3 covariance matrix
  let cov00 = 0, cov01 = 0, cov02 = 0;
  let cov11 = 0, cov12 = 0, cov22 = 0;

  for (const p of qualifyingPoints) {
    const dx = p.x - centroid.x;
    const dy = p.y - centroid.y;
    const dz = p.z - centroid.z;
    cov00 += dx * dx;
    cov01 += dx * dy;
    cov02 += dx * dz;
    cov11 += dy * dy;
    cov12 += dy * dz;
    cov22 += dz * dz;
  }

  cov00 /= count;
  cov01 /= count;
  cov02 /= count;
  cov11 /= count;
  cov12 /= count;
  cov22 /= count;

  // Eigen-decompose to find principal axis
  const { values, vectors } = eigenDecompose3x3Symmetric(
    cov00, cov01, cov02,
    cov11, cov12,
    cov22
  );

  // The eigenvector with the largest eigenvalue is the principal axis
  let axisDirection = vectors[0];

  // Compute confidence as ratio of largest eigenvalue to sum
  const eigenSum = Math.abs(values[0]) + Math.abs(values[1]) + Math.abs(values[2]);
  const confidence = eigenSum > 0 ? Math.abs(values[0]) / eigenSum : 0;

  // Orient axis so it points from inferior to superior (LVOT → ascending aorta).
  // In DICOM LPS, the S (superior) direction is typically along the positive
  // direction of the patient's head-foot axis. The volume's direction matrix
  // encodes this, but as a heuristic: if the axis has a strong z-component,
  // ensure it points in the direction that makes anatomical sense.
  // For most cardiac CT, the aorta goes from inferior-posterior to superior-anterior,
  // so we orient the axis to have a generally "upward" component.
  // We compute the "up" direction from the volume's direction matrix (3rd column = k-axis direction).
  const volUp: TAVIVector3D = {
    x: info.direction[2],
    y: info.direction[5],
    z: info.direction[8],
  };
  if (TAVIGeometry.vectorDot(axisDirection, volUp) < 0) {
    axisDirection = TAVIGeometry.vectorScale(axisDirection, -1);
  }

  axisDirection = TAVIGeometry.vectorNormalize(axisDirection);

  return {
    centerPoint: centroid,
    axisDirection,
    confidence,
  };
}
