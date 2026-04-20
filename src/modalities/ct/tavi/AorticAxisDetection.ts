import { TAVIVector3D } from './TAVITypes';
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
  }
): AutoSegmentResult | null {
  const info = extractVolumeInfo(volume);
  if (!info) return null;

  const gridSize = options?.gridSize ?? 200;
  const pixelSpacing = options?.pixelSpacing ?? 0.3;
  const maxDiameterMm = options?.maxDiameterMm ?? 55; // ascending aorta rarely > 50mm

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

  // Try segmentation with progressively tighter thresholds
  // This handles cases where loose thresholds cause flood-fill leakage
  const thresholdAttempts: [number, number][] = [
    [options?.huMin ?? 150, options?.huMax ?? 500],
    [180, 450],
    [200, 400],
    [250, 400],
  ];

  for (const [huMin, huMax] of thresholdAttempts) {
    const result = _segmentWithThreshold(
      grid, gridSize, pixelSpacing, huMin, huMax, maxDiameterMm,
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

/** Internal: attempt segmentation with a specific HU threshold pair */
function _segmentWithThreshold(
  grid: Float32Array,
  gridSize: number,
  pixelSpacing: number,
  huMin: number,
  huMax: number,
  maxDiameterMm: number,
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

  // Flood-fill from center on eroded mask
  const centerRow = Math.floor(gridSize / 2);
  const centerCol = Math.floor(gridSize / 2);

  let seedRow = centerRow;
  let seedCol = centerCol;
  if (eroded[seedRow * gridSize + seedCol] === 0) {
    let found = false;
    for (let r = 1; r < gridSize / 4 && !found; r++) {
      for (let dr = -r; dr <= r && !found; dr++) {
        for (let dc = -r; dc <= r && !found; dc++) {
          if (Math.abs(dr) !== r && Math.abs(dc) !== r) continue;
          const sr = centerRow + dr;
          const sc = centerCol + dc;
          if (sr >= 0 && sr < gridSize && sc >= 0 && sc < gridSize && eroded[sr * gridSize + sc] === 1) {
            seedRow = sr;
            seedCol = sc;
            found = true;
          }
        }
      }
    }
    if (!found) return null;
  }

  // Flood fill on eroded mask
  const erodedFilled = new Uint8Array(eroded);
  const stack1: number[] = [seedRow * gridSize + seedCol];
  erodedFilled[seedRow * gridSize + seedCol] = 2;
  let erodedCount = 0;

  while (stack1.length > 0) {
    const idx = stack1.pop()!;
    erodedCount++;
    const r = Math.floor(idx / gridSize);
    const c = idx % gridSize;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < gridSize && nc >= 0 && nc < gridSize) {
        const nIdx = nr * gridSize + nc;
        if (erodedFilled[nIdx] === 1) {
          erodedFilled[nIdx] = 2;
          stack1.push(nIdx);
        }
      }
    }
  }

  if (erodedCount < 20) return null;

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

  let filledCount = 0;
  for (let i = 0; i < filled.length; i++) {
    if (filled[i] === 2) filledCount++;
  }

  if (filledCount < 20) return null;

  // Check area: reject if too large (leakage detected)
  const areaMm2 = filledCount * pixelSpacing * pixelSpacing;
  const equivDiameterMm = 2 * Math.sqrt(areaMm2 / Math.PI);
  if (equivDiameterMm > maxDiameterMm) {
    console.warn(`[AutoSeg] Rejected HU ${huMin}-${huMax}: equiv diameter ${equivDiameterMm.toFixed(1)}mm > max ${maxDiameterMm}mm (area=${areaMm2.toFixed(0)}mm²)`);
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

  // For each angular bin, keep only the point closest to the median radius.
  // This eliminates the zigzag artifacts from multiple boundary pixels at the same angle.
  const numBins = 72; // 5-degree bins
  const binned: [number, number][] = [];
  const binSize = boundary.length / numBins;

  for (let b = 0; b < numBins; b++) {
    const start = Math.floor(b * binSize);
    const end = Math.floor((b + 1) * binSize);
    if (start >= end) continue;

    // Compute median radius in this bin
    const radii: { r: number; c: number; dist: number }[] = [];
    for (let i = start; i < end; i++) {
      const [pr, pc] = boundary[i];
      const dist = Math.sqrt((pr - centR) ** 2 + (pc - centC) ** 2);
      radii.push({ r: pr, c: pc, dist });
    }
    radii.sort((a, b) => a.dist - b.dist);
    const median = radii[Math.floor(radii.length / 2)];
    binned.push([median.r, median.c]);
  }

  // Subsample to ~60 points
  const maxPoints = 60;
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

  // Smooth: weighted average with neighbors (3 passes)
  for (let pass = 0; pass < 3; pass++) {
    const smoothed: [number, number][] = [];
    const n = ordered.length;
    for (let i = 0; i < n; i++) {
      const prev = ordered[(i - 1 + n) % n];
      const curr = ordered[i];
      const next = ordered[(i + 1) % n];
      smoothed.push([
        prev[0] * 0.2 + curr[0] * 0.6 + next[0] * 0.2,
        prev[1] * 0.2 + curr[1] * 0.6 + next[1] * 0.2,
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
