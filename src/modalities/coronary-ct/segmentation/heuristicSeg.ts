// Coronary tree segmentation — heuristic fallback (HU window + 3D flood fill).
//
// This is the deterministic placeholder used when no neural model is loaded.
// It produces a binary mask from a seed point: voxels with HU in [huMin, huMax]
// reachable from the seed via 26-connected flood fill.
//
// Output mask is Uint8Array matching the input volume layout, 1 = vessel, 0 = bg.
// Caller responsible for binding into cornerstone segmentation labelmap.

export interface HeuristicSegInput {
  scalarData: Float32Array | Int16Array | Uint16Array;
  dims: [number, number, number]; // [cols, rows, slices]
  spacing: [number, number, number]; // mm
  huMin: number;
  huMax: number;
  seed: [number, number, number]; // ijk
  maxVoxels?: number; // safety cap
}

export interface HeuristicSegResult {
  mask: Uint8Array;
  voxelCount: number;
  volumeMl: number;
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
  truncated: boolean;
}

const DEFAULT_MAX_VOXELS = 5_000_000;

export function heuristicCoronarySeg(input: HeuristicSegInput): HeuristicSegResult {
  const { scalarData, dims, spacing, huMin, huMax, seed } = input;
  const maxVoxels = input.maxVoxels ?? DEFAULT_MAX_VOXELS;
  const [cols, rows, slices] = dims;
  const sliceSize = cols * rows;
  const total = sliceSize * slices;

  const mask = new Uint8Array(total);
  const [sx, sy, sz] = seed;

  if (sx < 0 || sy < 0 || sz < 0 || sx >= cols || sy >= rows || sz >= slices) {
    return { mask, voxelCount: 0, volumeMl: 0, bbox: null, truncated: false };
  }

  const seedIdx = sz * sliceSize + sy * cols + sx;
  const seedHu = scalarData[seedIdx];
  if (seedHu < huMin || seedHu > huMax) {
    return { mask, voxelCount: 0, volumeMl: 0, bbox: null, truncated: false };
  }

  const stack: number[] = [seedIdx];
  mask[seedIdx] = 1;

  let minX = sx, maxX = sx;
  let minY = sy, maxY = sy;
  let minZ = sz, maxZ = sz;
  let count = 0;
  let truncated = false;

  while (stack.length > 0) {
    if (count >= maxVoxels) {
      truncated = true;
      break;
    }
    const idx = stack.pop()!;
    count += 1;
    const z = Math.floor(idx / sliceSize);
    const rem = idx - z * sliceSize;
    const y = Math.floor(rem / cols);
    const x = rem - y * cols;

    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;

    for (let dz = -1; dz <= 1; dz += 1) {
      const nz = z + dz;
      if (nz < 0 || nz >= slices) continue;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= rows) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= cols) continue;
          const nIdx = nz * sliceSize + ny * cols + nx;
          if (mask[nIdx]) continue;
          const hu = scalarData[nIdx];
          if (hu < huMin || hu > huMax) continue;
          mask[nIdx] = 1;
          stack.push(nIdx);
        }
      }
    }
  }

  const voxelMm3 = spacing[0] * spacing[1] * spacing[2];
  const volumeMl = (count * voxelMm3) / 1000;

  return {
    mask,
    voxelCount: count,
    volumeMl,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    truncated,
  };
}
