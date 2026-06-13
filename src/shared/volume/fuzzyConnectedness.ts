// Relative fuzzy-connectedness segmentation for 3D volumes.
//
// Clean-room implementation of seeded fuzzy connectedness (Udupa & Samarasekera)
// computed as an Image Foresting Transform with an fmax (max–min) path-cost:
// the connectivity of a voxel is the strongest path from any seed, where a
// path's strength is the WEAKEST affinity link along it. Because a single weak
// link (an intensity discontinuity at a vessel wall) caps the whole path, the
// segmentation resists the leakage that plagues plain region growing.
//
// Affinity between neighbours combines homogeneity (intensity similarity) with
// object membership (closeness to the seed intensity statistics). Pure,
// dependency-free, modality-agnostic.

export interface FuzzyConnectednessOptions {
  /** Homogeneity scale (HU). Larger = more tolerant of intensity steps. Default 60. */
  homogeneitySigma?: number;
  /** Object-membership scale (HU) around the seed mean. Default 120. */
  objectSigma?: number;
  /** Connectivity threshold in [0,1] for the boolean mask. Default 0.5. */
  threshold?: number;
  /** 6- or 26-connectivity. Default 6. */
  connectivity?: 6 | 26;
}

export interface FuzzyConnectednessResult {
  /** Per-voxel fuzzy connectivity strength in [0,1]. */
  connectivity: Float32Array;
  /** Boolean object mask (connectivity ≥ threshold), 1 byte per voxel. */
  mask: Uint8Array;
  /** Voxel count in the mask. */
  objectVoxelCount: number;
  /** Mean intensity of the seed voxels used for object membership. */
  seedMean: number;
}

export interface FuzzyVolume {
  data: ArrayLike<number>;
  /** [nx, ny, nz] */
  dimensions: [number, number, number];
}

// Binary max-heap keyed by a Float32 priority array, storing voxel indices.
class MaxHeap {
  private heap: number[] = [];
  constructor(private priority: Float32Array) {}
  get size(): number { return this.heap.length; }
  push(v: number): void {
    const h = this.heap;
    h.push(v);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.priority[h[parent]] >= this.priority[h[i]]) break;
      [h[parent], h[i]] = [h[i], h[parent]];
      i = parent;
    }
  }
  pop(): number {
    const h = this.heap;
    const top = h[0];
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      const n = h.length;
      for (;;) {
        const l = 2 * i + 1, r = 2 * i + 2;
        let largest = i;
        if (l < n && this.priority[h[l]] > this.priority[h[largest]]) largest = l;
        if (r < n && this.priority[h[r]] > this.priority[h[largest]]) largest = r;
        if (largest === i) break;
        [h[largest], h[i]] = [h[i], h[largest]];
        i = largest;
      }
    }
    return top;
  }
}

const OFFSETS_6: [number, number, number][] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

function offsets26(): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if (dx || dy || dz) out.push([dx, dy, dz]);
  return out;
}

/**
 * Seeded fuzzy-connectedness segmentation. `seeds` are flat voxel indices
 * (x + y*nx + z*nx*ny) marking object interior.
 */
export function fuzzyConnectedness(
  volume: FuzzyVolume,
  seeds: number[],
  options: FuzzyConnectednessOptions = {}
): FuzzyConnectednessResult {
  const [nx, ny, nz] = volume.dimensions;
  const n = nx * ny * nz;
  if (n <= 0 || volume.data.length < n) {
    throw new Error('fuzzyConnectedness: volume data shorter than dimensions imply');
  }
  if (!seeds.length) {
    throw new Error('fuzzyConnectedness: at least one seed is required');
  }

  const homo = options.homogeneitySigma ?? 60;
  const obj = options.objectSigma ?? 120;
  const threshold = options.threshold ?? 0.5;
  const offsets = (options.connectivity ?? 6) === 26 ? offsets26() : OFFSETS_6;

  const data = volume.data;
  // Seed intensity mean for object membership.
  let seedSum = 0;
  for (const s of seeds) seedSum += data[s];
  const seedMean = seedSum / seeds.length;

  const homo2 = 2 * homo * homo;
  const obj2 = 2 * obj * obj;
  // Object membership of a voxel: Gaussian closeness to the seed mean.
  const membership = (i: number): number => Math.exp(-((data[i] - seedMean) ** 2) / obj2);
  // Affinity of an edge: homogeneity × min membership of its endpoints.
  const affinity = (a: number, b: number): number => {
    const h = Math.exp(-((data[a] - data[b]) ** 2) / homo2);
    return h * Math.min(membership(a), membership(b));
  };

  const conn = new Float32Array(n); // all 0
  const done = new Uint8Array(n);
  const heap = new MaxHeap(conn);

  for (const s of seeds) {
    conn[s] = 1;
    heap.push(s);
  }

  while (heap.size > 0) {
    const v = heap.pop();
    if (done[v]) continue;
    done[v] = 1;
    const z = (v / (nx * ny)) | 0;
    const rem = v - z * nx * ny;
    const y = (rem / nx) | 0;
    const x = rem - y * nx;
    const cv = conn[v];
    for (const [dx, dy, dz] of offsets) {
      const xx = x + dx, yy = y + dy, zz = z + dz;
      if (xx < 0 || xx >= nx || yy < 0 || yy >= ny || zz < 0 || zz >= nz) continue;
      const w = xx + yy * nx + zz * nx * ny;
      if (done[w]) continue;
      const strength = Math.min(cv, affinity(v, w));
      if (strength > conn[w]) {
        conn[w] = strength;
        heap.push(w);
      }
    }
  }

  const mask = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (conn[i] >= threshold) { mask[i] = 1; count++; }
  }

  return { connectivity: conn, mask, objectVoxelCount: count, seedMean };
}
