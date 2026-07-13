/**
 * Build a binary iso-mask from a CT volume for STL export.
 *
 * The mask selects voxels whose value lies inside a HU window and (optionally)
 * inside a percentage bounding box — i.e. exactly the "cropped area at an
 * arbitrary threshold" the 3D panel is showing. The resulting Uint8Array feeds
 * marchingCubesBinary to produce the surface mesh.
 *
 * Pure and GPU-independent so it can be unit-tested without a volume/WebGL.
 */

export interface ClipPct {
  xMin: number; xMax: number;
  yMin: number; yMax: number;
  zMin: number; zMax: number;
}

export interface MaskDims {
  dx: number; dy: number; dz: number;
}

export interface MaskResult {
  mask: Uint8Array;
  count: number;
}

/**
 * Convert a clip percentage (0..100) along an axis of `n` voxels to an inclusive
 * index range. Always returns lo ≤ hi within [0, n-1].
 */
export function clipRange(pctLo: number, pctHi: number, n: number): [number, number] {
  const lo = Math.max(0, Math.min(n - 1, Math.round((Math.min(pctLo, pctHi) / 100) * (n - 1))));
  const hi = Math.max(0, Math.min(n - 1, Math.round((Math.max(pctLo, pctHi) / 100) * (n - 1))));
  return [lo, hi];
}

/**
 * Select voxels with `minHU ≤ value ≤ maxHU`, restricted to `clip` if given.
 * `scalar` is the volume's stored/HU scalar array in (k·dy + j)·dx + i order.
 */
export function buildThresholdMask(
  scalar: ArrayLike<number>,
  dims: MaskDims,
  minHU: number,
  maxHU: number,
  clip?: ClipPct | null,
): MaskResult {
  const { dx, dy, dz } = dims;
  const lo = Math.min(minHU, maxHU);
  const hi = Math.max(minHU, maxHU);
  const mask = new Uint8Array(dx * dy * dz);

  const [iLo, iHi] = clip ? clipRange(clip.xMin, clip.xMax, dx) : [0, dx - 1];
  const [jLo, jHi] = clip ? clipRange(clip.yMin, clip.yMax, dy) : [0, dy - 1];
  const [kLo, kHi] = clip ? clipRange(clip.zMin, clip.zMax, dz) : [0, dz - 1];

  const stride = dx * dy;
  let count = 0;
  for (let k = kLo; k <= kHi; k++) {
    for (let j = jLo; j <= jHi; j++) {
      const row = k * stride + j * dx;
      for (let i = iLo; i <= iHi; i++) {
        const v = scalar[row + i];
        if (v >= lo && v <= hi) {
          mask[row + i] = 1;
          count++;
        }
      }
    }
  }
  return { mask, count };
}
