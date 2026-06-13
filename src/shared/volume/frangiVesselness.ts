// Multiscale Hessian (Frangi) vesselness for 3D volumes.
//
// Clean-room implementation of the published Frangi et al. (1998) tubular-
// structure enhancement filter. Enhances bright tubular structures (contrast-
// filled vessels on CTA) and suppresses blobs and sheets. Modality-agnostic,
// dependency-free, pure — operates on a plain scalar array + dimensions.
//
// Per voxel: smooth at scale σ → Hessian (2nd derivatives, γ-normalized by σ²)
// → eigenvalues |λ1|≤|λ2|≤|λ3| → vesselness from the RA/RB/S ratios. The
// response is the maximum over all requested scales.

export interface FrangiOptions {
  /** Gaussian scales in voxels (vessel radii to enhance). Default [1,2,3]. */
  scales?: number[];
  /** Plate-vs-line sensitivity (RA term). Default 0.5. */
  alpha?: number;
  /** Blob-vs-line sensitivity (RB term). Default 0.5. */
  beta?: number;
  /**
   * Structureness (S term) sensitivity. If omitted, set per-scale to half the
   * maximum Hessian Frobenius norm (Frangi's adaptive `c`).
   */
  c?: number;
  /** true = bright vessels on dark background (CT angiography). Default true. */
  bright?: boolean;
}

export interface Volume3D {
  data: ArrayLike<number>;
  /** [nx, ny, nz] */
  dimensions: [number, number, number];
}

/** Eigenvalues of a symmetric 3×3 matrix via Cardano, ascending by value. */
export function symmetricEigenvalues3x3(
  a00: number, a01: number, a02: number,
  a11: number, a12: number, a22: number
): [number, number, number] {
  const p1 = a01 * a01 + a02 * a02 + a12 * a12;
  if (p1 < 1e-30) {
    const e = [a00, a11, a22];
    e.sort((x, y) => x - y);
    return [e[0], e[1], e[2]];
  }
  const q = (a00 + a11 + a22) / 3;
  const p2 = (a00 - q) ** 2 + (a11 - q) ** 2 + (a22 - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  // B = (A - qI) / p
  const b00 = (a00 - q) / p, b11 = (a11 - q) / p, b22 = (a22 - q) / p;
  const b01 = a01 / p, b02 = a02 / p, b12 = a12 / p;
  // det(B) / 2
  const detB =
    b00 * (b11 * b22 - b12 * b12) -
    b01 * (b01 * b22 - b12 * b02) +
    b02 * (b01 * b12 - b11 * b02);
  let r = detB / 2;
  if (r <= -1) r = -1; else if (r >= 1) r = 1;
  const phi = Math.acos(r) / 3;
  const eig1 = q + 2 * p * Math.cos(phi);                       // largest
  const eig3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);   // smallest
  const eig2 = 3 * q - eig1 - eig3;
  return [eig3, eig2, eig1]; // ascending
}

/** 1D Gaussian kernel (normalized), radius = ceil(3σ). */
function gaussianKernel(sigma: number): Float64Array {
  const radius = Math.max(1, Math.ceil(3 * sigma));
  const size = 2 * radius + 1;
  const k = new Float64Array(size);
  const s2 = 2 * sigma * sigma;
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / s2);
    k[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < size; i++) k[i] /= sum;
  return k;
}

/** Separable Gaussian blur along one axis (0=x,1=y,2=z) with clamped edges. */
function blurAxis(
  src: Float32Array, dst: Float32Array,
  nx: number, ny: number, nz: number,
  kernel: Float64Array, axis: 0 | 1 | 2
): void {
  const radius = (kernel.length - 1) / 2;
  const stride = axis === 0 ? 1 : axis === 1 ? nx : nx * ny;
  const limit = axis === 0 ? nx : axis === 1 ? ny : nz;
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const base = x + y * nx + z * nx * ny;
        const coord = axis === 0 ? x : axis === 1 ? y : z;
        let acc = 0;
        for (let t = -radius; t <= radius; t++) {
          let c = coord + t;
          if (c < 0) c = 0; else if (c >= limit) c = limit - 1;
          acc += src[base + (c - coord) * stride] * kernel[t + radius];
        }
        dst[base] = acc;
      }
    }
  }
}

function gaussianBlur3D(src: Float32Array, nx: number, ny: number, nz: number, sigma: number): Float32Array {
  const k = gaussianKernel(sigma);
  const a = new Float32Array(src.length);
  const b = new Float32Array(src.length);
  blurAxis(src, a, nx, ny, nz, k, 0);
  blurAxis(a, b, nx, ny, nz, k, 1);
  blurAxis(b, a, nx, ny, nz, k, 2);
  return a;
}

const idx = (x: number, y: number, z: number, nx: number, ny: number) => x + y * nx + z * nx * ny;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Compute the multiscale Frangi vesselness response for a 3D volume.
 * Returns a Float32Array (same length as input) with values in [0, 1].
 */
export function frangiVesselness(volume: Volume3D, options: FrangiOptions = {}): Float32Array {
  const [nx, ny, nz] = volume.dimensions;
  const n = nx * ny * nz;
  if (n <= 0 || volume.data.length < n) {
    throw new Error('frangiVesselness: volume data shorter than dimensions imply');
  }
  const scales = options.scales ?? [1, 2, 3];
  const alpha = options.alpha ?? 0.5;
  const beta = options.beta ?? 0.5;
  const bright = options.bright ?? true;

  const src = volume.data instanceof Float32Array ? volume.data : Float32Array.from(volume.data);
  const out = new Float32Array(n); // accumulates max over scales

  for (const sigma of scales) {
    const sm = gaussianBlur3D(src as Float32Array, nx, ny, nz, sigma);
    const g = sigma * sigma; // γ-normalization (γ = 1)

    // First pass: per-voxel Hessian eigenvalues + track max Frobenius norm for adaptive c.
    const e1 = new Float32Array(n);
    const e2 = new Float32Array(n);
    const e3 = new Float32Array(n);
    let maxFrob = 0;
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const i = idx(x, y, z, nx, ny);
          const xm = idx(clamp(x - 1, 0, nx - 1), y, z, nx, ny);
          const xp = idx(clamp(x + 1, 0, nx - 1), y, z, nx, ny);
          const ym = idx(x, clamp(y - 1, 0, ny - 1), z, nx, ny);
          const yp = idx(x, clamp(y + 1, 0, ny - 1), z, nx, ny);
          const zm = idx(x, y, clamp(z - 1, 0, nz - 1), nx, ny);
          const zp = idx(x, y, clamp(z + 1, 0, nz - 1), nx, ny);
          const c0 = sm[i];
          const dxx = (sm[xp] - 2 * c0 + sm[xm]) * g;
          const dyy = (sm[yp] - 2 * c0 + sm[ym]) * g;
          const dzz = (sm[zp] - 2 * c0 + sm[zm]) * g;
          // Mixed: central difference of central differences.
          const dxy = (
            sm[idx(clamp(x + 1, 0, nx - 1), clamp(y + 1, 0, ny - 1), z, nx, ny)] -
            sm[idx(clamp(x + 1, 0, nx - 1), clamp(y - 1, 0, ny - 1), z, nx, ny)] -
            sm[idx(clamp(x - 1, 0, nx - 1), clamp(y + 1, 0, ny - 1), z, nx, ny)] +
            sm[idx(clamp(x - 1, 0, nx - 1), clamp(y - 1, 0, ny - 1), z, nx, ny)]
          ) * 0.25 * g;
          const dxz = (
            sm[idx(clamp(x + 1, 0, nx - 1), y, clamp(z + 1, 0, nz - 1), nx, ny)] -
            sm[idx(clamp(x + 1, 0, nx - 1), y, clamp(z - 1, 0, nz - 1), nx, ny)] -
            sm[idx(clamp(x - 1, 0, nx - 1), y, clamp(z + 1, 0, nz - 1), nx, ny)] +
            sm[idx(clamp(x - 1, 0, nx - 1), y, clamp(z - 1, 0, nz - 1), nx, ny)]
          ) * 0.25 * g;
          const dyz = (
            sm[idx(x, clamp(y + 1, 0, ny - 1), clamp(z + 1, 0, nz - 1), nx, ny)] -
            sm[idx(x, clamp(y + 1, 0, ny - 1), clamp(z - 1, 0, nz - 1), nx, ny)] -
            sm[idx(x, clamp(y - 1, 0, ny - 1), clamp(z + 1, 0, nz - 1), nx, ny)] +
            sm[idx(x, clamp(y - 1, 0, ny - 1), clamp(z - 1, 0, nz - 1), nx, ny)]
          ) * 0.25 * g;
          const [l1, l2, l3] = sortByAbs(symmetricEigenvalues3x3(dxx, dxy, dxz, dyy, dyz, dzz));
          e1[i] = l1; e2[i] = l2; e3[i] = l3;
          const frob = Math.sqrt(l1 * l1 + l2 * l2 + l3 * l3);
          if (frob > maxFrob) maxFrob = frob;
        }
      }
    }

    const cVal = options.c ?? (maxFrob > 0 ? maxFrob / 2 : 1e-6);
    const a2 = 2 * alpha * alpha;
    const b2 = 2 * beta * beta;
    const c2 = 2 * cVal * cVal;

    for (let i = 0; i < n; i++) {
      const l1 = e1[i], l2 = e2[i], l3 = e3[i];
      // Bright vessels: λ2, λ3 must be negative (dark→bright→dark profile).
      if (bright ? (l2 >= 0 || l3 >= 0) : (l2 <= 0 || l3 <= 0)) continue;
      const absL2 = Math.abs(l2), absL3 = Math.abs(l3);
      const RA = absL3 < 1e-12 ? 0 : absL2 / absL3;        // plate vs line
      const RB = absL2 * absL3 <= 0 ? 0 : Math.abs(l1) / Math.sqrt(absL2 * absL3); // blob vs line
      const S = Math.sqrt(l1 * l1 + l2 * l2 + l3 * l3);    // structureness
      const v =
        (1 - Math.exp(-(RA * RA) / a2)) *
        Math.exp(-(RB * RB) / b2) *
        (1 - Math.exp(-(S * S) / c2));
      if (v > out[i]) out[i] = v;
    }
  }

  return out;
}

/** Sort three eigenvalues by ascending absolute magnitude: |λ1|≤|λ2|≤|λ3|. */
function sortByAbs(e: [number, number, number]): [number, number, number] {
  const s = [e[0], e[1], e[2]];
  s.sort((a, b) => Math.abs(a) - Math.abs(b));
  return [s[0], s[1], s[2]];
}
