/**
 * 3D binary morphology + connected components on flat Uint8Array volumes.
 * All volumes are (dx, dy, dz) with index = k*dx*dy + j*dx + i.
 * Values: 0 = background, non-zero = foreground.
 */

export interface VolumeDims {
  dx: number;
  dy: number;
  dz: number;
}

/**
 * 3D chamfer distance transform (3-4-5 weights approximate Euclidean).
 * Returns Uint16Array: distance from background for each foreground voxel
 * (scaled so 3 ≈ 1 voxel axial step).
 */
export function distanceTransform3D(src: Uint8Array, dims: VolumeDims): Uint16Array {
  const { dx, dy, dz } = dims;
  const stride = dx * dy;
  const total = src.length;
  const INF = 65000;
  const dt = new Uint16Array(total);
  for (let i = 0; i < total; i++) dt[i] = src[i] ? INF : 0;

  const W_AX = 3;
  const W_ED = 4;
  const W_CO = 5;

  // Forward pass (scan k, j, i ascending)
  for (let k = 0; k < dz; k++) {
    for (let j = 0; j < dy; j++) {
      for (let i = 0; i < dx; i++) {
        const idx = k * stride + j * dx + i;
        if (!dt[idx]) continue;
        let m = dt[idx];
        // Previous slice (k-1)
        if (k > 0) {
          const kk = idx - stride;
          m = Math.min(m, dt[kk] + W_AX);
          if (j > 0) m = Math.min(m, dt[kk - dx] + W_ED);
          if (j < dy - 1) m = Math.min(m, dt[kk + dx] + W_ED);
          if (i > 0) m = Math.min(m, dt[kk - 1] + W_ED);
          if (i < dx - 1) m = Math.min(m, dt[kk + 1] + W_ED);
          if (j > 0 && i > 0) m = Math.min(m, dt[kk - dx - 1] + W_CO);
          if (j > 0 && i < dx - 1) m = Math.min(m, dt[kk - dx + 1] + W_CO);
          if (j < dy - 1 && i > 0) m = Math.min(m, dt[kk + dx - 1] + W_CO);
          if (j < dy - 1 && i < dx - 1) m = Math.min(m, dt[kk + dx + 1] + W_CO);
        }
        // Same slice, above row (j-1)
        if (j > 0) {
          const jj = idx - dx;
          m = Math.min(m, dt[jj] + W_AX);
          if (i > 0) m = Math.min(m, dt[jj - 1] + W_ED);
          if (i < dx - 1) m = Math.min(m, dt[jj + 1] + W_ED);
        }
        // Same row, left neighbor (i-1)
        if (i > 0) m = Math.min(m, dt[idx - 1] + W_AX);
        dt[idx] = m;
      }
    }
  }
  // Backward pass (scan k, j, i descending)
  for (let k = dz - 1; k >= 0; k--) {
    for (let j = dy - 1; j >= 0; j--) {
      for (let i = dx - 1; i >= 0; i--) {
        const idx = k * stride + j * dx + i;
        if (!dt[idx]) continue;
        let m = dt[idx];
        if (k < dz - 1) {
          const kk = idx + stride;
          m = Math.min(m, dt[kk] + W_AX);
          if (j > 0) m = Math.min(m, dt[kk - dx] + W_ED);
          if (j < dy - 1) m = Math.min(m, dt[kk + dx] + W_ED);
          if (i > 0) m = Math.min(m, dt[kk - 1] + W_ED);
          if (i < dx - 1) m = Math.min(m, dt[kk + 1] + W_ED);
          if (j > 0 && i > 0) m = Math.min(m, dt[kk - dx - 1] + W_CO);
          if (j > 0 && i < dx - 1) m = Math.min(m, dt[kk - dx + 1] + W_CO);
          if (j < dy - 1 && i > 0) m = Math.min(m, dt[kk + dx - 1] + W_CO);
          if (j < dy - 1 && i < dx - 1) m = Math.min(m, dt[kk + dx + 1] + W_CO);
        }
        if (j < dy - 1) {
          const jj = idx + dx;
          m = Math.min(m, dt[jj] + W_AX);
          if (i > 0) m = Math.min(m, dt[jj - 1] + W_ED);
          if (i < dx - 1) m = Math.min(m, dt[jj + 1] + W_ED);
        }
        if (i < dx - 1) m = Math.min(m, dt[idx + 1] + W_AX);
        dt[idx] = m;
      }
    }
  }
  return dt;
}

/**
 * Ball erosion. Chamfer 3-4-5 rim voxel has dt=3, so strict `>` required —
 * otherwise radius=1 is a no-op (rim passes dt>=3). Keep fg voxels at
 * Euclidean distance > radiusVox from bg.
 */
export function erodeBall(src: Uint8Array, dims: VolumeDims, radiusVox: number): Uint8Array {
  const dt = distanceTransform3D(src, dims);
  const threshold = radiusVox * 3;
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = dt[i] > threshold ? 1 : 0;
  return out;
}

/**
 * Ball dilation. Mirror of erode: bg rim has dt=3, so `<=` so radius=1
 * actually grows by one layer.
 */
export function dilateBall(src: Uint8Array, dims: VolumeDims, radiusVox: number): Uint8Array {
  const total = src.length;
  const inv = new Uint8Array(total);
  for (let i = 0; i < total; i++) inv[i] = src[i] ? 0 : 1;
  const dt = distanceTransform3D(inv, dims);
  const threshold = radiusVox * 3;
  const out = new Uint8Array(total);
  for (let i = 0; i < total; i++) out[i] = dt[i] <= threshold ? 1 : 0;
  return out;
}

export function erode3D(src: Uint8Array, dims: VolumeDims, iterations = 1): Uint8Array {
  const { dx, dy, dz } = dims;
  const stride = dx * dy;
  let cur = src;
  for (let it = 0; it < iterations; it++) {
    const out = new Uint8Array(cur.length);
    for (let k = 0; k < dz; k++) {
      for (let j = 0; j < dy; j++) {
        for (let i = 0; i < dx; i++) {
          const idx = k * stride + j * dx + i;
          if (!cur[idx]) continue;
          // 6-connected erosion: all neighbors must be foreground (or clamp at edge as background)
          if (
            i === 0 || i === dx - 1 ||
            j === 0 || j === dy - 1 ||
            k === 0 || k === dz - 1
          ) continue;
          if (
            cur[idx - 1] && cur[idx + 1] &&
            cur[idx - dx] && cur[idx + dx] &&
            cur[idx - stride] && cur[idx + stride]
          ) {
            out[idx] = 1;
          }
        }
      }
    }
    cur = out;
  }
  return cur;
}

export function dilate3D(src: Uint8Array, dims: VolumeDims, iterations = 1): Uint8Array {
  const { dx, dy, dz } = dims;
  const stride = dx * dy;
  let cur = src;
  for (let it = 0; it < iterations; it++) {
    const out = new Uint8Array(cur.length);
    for (let k = 0; k < dz; k++) {
      for (let j = 0; j < dy; j++) {
        for (let i = 0; i < dx; i++) {
          const idx = k * stride + j * dx + i;
          if (cur[idx]) {
            out[idx] = 1;
            continue;
          }
          if (
            (i > 0 && cur[idx - 1]) ||
            (i < dx - 1 && cur[idx + 1]) ||
            (j > 0 && cur[idx - dx]) ||
            (j < dy - 1 && cur[idx + dx]) ||
            (k > 0 && cur[idx - stride]) ||
            (k < dz - 1 && cur[idx + stride])
          ) {
            out[idx] = 1;
          }
        }
      }
    }
    cur = out;
  }
  return cur;
}

/**
 * Keep only the largest 6-connected foreground component.
 * Single BFS pass with Int32Array queue; component-size tallying.
 */
export function largestComponent(src: Uint8Array, dims: VolumeDims): Uint8Array {
  const { dx, dy, dz } = dims;
  const stride = dx * dy;
  const total = src.length;

  const labels = new Int32Array(total); // 0 = unvisited, >0 = component id
  let queue = new Int32Array(65536);
  let qHead = 0;
  let qTail = 0;
  const enqueue = (v: number) => {
    if (qTail >= queue.length) {
      const bigger = new Int32Array(queue.length * 2);
      bigger.set(queue);
      queue = bigger;
    }
    queue[qTail++] = v;
  };

  let currentLabel = 0;
  let bestLabel = 0;
  let bestSize = 0;

  for (let start = 0; start < total; start++) {
    if (!src[start] || labels[start]) continue;
    currentLabel++;
    labels[start] = currentLabel;
    qHead = qTail = 0;
    enqueue(start);
    let size = 0;
    while (qHead < qTail) {
      const idx = queue[qHead++];
      size++;
      const k = (idx / stride) | 0;
      const rem = idx - k * stride;
      const j = (rem / dx) | 0;
      const i = rem - j * dx;
      if (i + 1 < dx) {
        const n = idx + 1;
        if (src[n] && !labels[n]) { labels[n] = currentLabel; enqueue(n); }
      }
      if (i - 1 >= 0) {
        const n = idx - 1;
        if (src[n] && !labels[n]) { labels[n] = currentLabel; enqueue(n); }
      }
      if (j + 1 < dy) {
        const n = idx + dx;
        if (src[n] && !labels[n]) { labels[n] = currentLabel; enqueue(n); }
      }
      if (j - 1 >= 0) {
        const n = idx - dx;
        if (src[n] && !labels[n]) { labels[n] = currentLabel; enqueue(n); }
      }
      if (k + 1 < dz) {
        const n = idx + stride;
        if (src[n] && !labels[n]) { labels[n] = currentLabel; enqueue(n); }
      }
      if (k - 1 >= 0) {
        const n = idx - stride;
        if (src[n] && !labels[n]) { labels[n] = currentLabel; enqueue(n); }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      bestLabel = currentLabel;
    }
  }

  const out = new Uint8Array(total);
  if (bestLabel > 0) {
    for (let i = 0; i < total; i++) {
      if (labels[i] === bestLabel) out[i] = 1;
    }
  }
  return out;
}

/**
 * Keep only the 6-connected component containing the given seed voxel.
 * If seed is background or out-of-bounds, returns empty.
 */
export function componentContaining(
  src: Uint8Array,
  dims: VolumeDims,
  si: number,
  sj: number,
  sk: number
): Uint8Array {
  const { dx, dy, dz } = dims;
  const stride = dx * dy;
  const total = src.length;
  const out = new Uint8Array(total);
  if (si < 0 || si >= dx || sj < 0 || sj >= dy || sk < 0 || sk >= dz) return out;
  const seedIdx = sk * stride + sj * dx + si;
  if (!src[seedIdx]) return out;

  let queue = new Int32Array(65536);
  let qHead = 0, qTail = 0;
  const enqueue = (v: number) => {
    if (qTail >= queue.length) {
      const bigger = new Int32Array(queue.length * 2);
      bigger.set(queue);
      queue = bigger;
    }
    queue[qTail++] = v;
  };
  out[seedIdx] = 1;
  enqueue(seedIdx);
  while (qHead < qTail) {
    const idx = queue[qHead++];
    const k = (idx / stride) | 0;
    const rem = idx - k * stride;
    const j = (rem / dx) | 0;
    const i = rem - j * dx;
    if (i + 1 < dx) { const n = idx + 1; if (src[n] && !out[n]) { out[n] = 1; enqueue(n); } }
    if (i - 1 >= 0) { const n = idx - 1; if (src[n] && !out[n]) { out[n] = 1; enqueue(n); } }
    if (j + 1 < dy) { const n = idx + dx; if (src[n] && !out[n]) { out[n] = 1; enqueue(n); } }
    if (j - 1 >= 0) { const n = idx - dx; if (src[n] && !out[n]) { out[n] = 1; enqueue(n); } }
    if (k + 1 < dz) { const n = idx + stride; if (src[n] && !out[n]) { out[n] = 1; enqueue(n); } }
    if (k - 1 >= 0) { const n = idx - stride; if (src[n] && !out[n]) { out[n] = 1; enqueue(n); } }
  }
  return out;
}

/**
 * Morphological opening by reconstruction:
 *   erode N → keep only largest connected component → dilate N → AND with original.
 * Acts as distance-transform narrowing-cut surrogate: prunes thin cylindrical
 * branches (pulmonary veins) while preserving the LA body. Radius controls
 * which branches survive (≈ radius voxels × voxel spacing mm).
 */
export function trimThinBranches(
  src: Uint8Array,
  dims: VolumeDims,
  radius: number,
  seedIJK?: [number, number, number]
): Uint8Array {
  // Crop to mask bbox + pad so DT operates on a small subvolume — full-volume
  // DT on 512³ exceeds 2GB ArrayBuffer quota.
  const bbox = boundingBox(src, dims);
  const out = new Uint8Array(src.length);
  if (!bbox) return out;
  const pad = radius + 2;
  const { sub, subDims, origin } = cropWithPad(src, dims, bbox, pad);
  const eroded = erodeBall(sub, subDims, radius);

  // Prefer seed-anchored component — picks the LA core even when LV core is
  // bigger after erosion. Falls back to largest if seed erodes away.
  let core: Uint8Array | null = null;
  if (seedIJK) {
    const sCi = seedIJK[0] - origin[0];
    const sCj = seedIJK[1] - origin[1];
    const sCk = seedIJK[2] - origin[2];
    const seeded = componentContaining(eroded, subDims, sCi, sCj, sCk);
    if (countVoxels(seeded) > 0) core = seeded;
  }
  if (!core) core = largestComponent(eroded, subDims);

  const dilated = dilateBall(core, subDims, radius);
  for (let i = 0; i < sub.length; i++) {
    sub[i] = sub[i] && dilated[i] ? 1 : 0;
  }
  pasteSubvolume(out, dims, sub, subDims, origin);
  return out;
}

/**
 * Cut labelmap at a plane defined by worldOrigin + normal. Remove foreground voxels
 * on the side where (worldVoxel - origin) · normal > 0.
 * voxelToWorld: function mapping (i,j,k) → world coordinates (mm).
 */
export function cutAtPlane(
  src: Uint8Array,
  dims: VolumeDims,
  voxelToWorld: (i: number, j: number, k: number) => [number, number, number],
  planeOrigin: [number, number, number],
  planeNormal: [number, number, number]
): Uint8Array {
  const { dx, dy, dz } = dims;
  const stride = dx * dy;
  const out = new Uint8Array(src.length);
  const [nx, ny, nz] = planeNormal;
  const [ox, oy, oz] = planeOrigin;
  for (let k = 0; k < dz; k++) {
    for (let j = 0; j < dy; j++) {
      for (let i = 0; i < dx; i++) {
        const idx = k * stride + j * dx + i;
        if (!src[idx]) continue;
        const [wx, wy, wz] = voxelToWorld(i, j, k);
        const dot = (wx - ox) * nx + (wy - oy) * ny + (wz - oz) * nz;
        if (dot <= 0) out[idx] = 1;
      }
    }
  }
  return out;
}

/**
 * Compute bounding box of foreground voxels. Returns null if empty.
 */
export function boundingBox(vol: Uint8Array, dims: VolumeDims):
  { iMin: number; iMax: number; jMin: number; jMax: number; kMin: number; kMax: number } | null {
  const { dx, dy, dz } = dims;
  const stride = dx * dy;
  let iMin = dx, iMax = -1, jMin = dy, jMax = -1, kMin = dz, kMax = -1;
  let any = false;
  for (let k = 0; k < dz; k++) {
    for (let j = 0; j < dy; j++) {
      const rowBase = k * stride + j * dx;
      for (let i = 0; i < dx; i++) {
        if (vol[rowBase + i]) {
          any = true;
          if (i < iMin) iMin = i; if (i > iMax) iMax = i;
          if (j < jMin) jMin = j; if (j > jMax) jMax = j;
          if (k < kMin) kMin = k; if (k > kMax) kMax = k;
        }
      }
    }
  }
  return any ? { iMin, iMax, jMin, jMax, kMin, kMax } : null;
}

/**
 * Crop a subvolume + pad by N voxels on all sides (clamped to volume bounds).
 * Returns { sub, subDims, origin } where origin is (i,j,k) offset in full volume.
 */
export function cropWithPad(
  vol: Uint8Array,
  dims: VolumeDims,
  bbox: { iMin: number; iMax: number; jMin: number; jMax: number; kMin: number; kMax: number },
  pad: number
): { sub: Uint8Array; subDims: VolumeDims; origin: [number, number, number] } {
  const { dx, dy, dz } = dims;
  const stride = dx * dy;
  const iMin = Math.max(0, bbox.iMin - pad);
  const iMax = Math.min(dx - 1, bbox.iMax + pad);
  const jMin = Math.max(0, bbox.jMin - pad);
  const jMax = Math.min(dy - 1, bbox.jMax + pad);
  const kMin = Math.max(0, bbox.kMin - pad);
  const kMax = Math.min(dz - 1, bbox.kMax + pad);
  const sdx = iMax - iMin + 1;
  const sdy = jMax - jMin + 1;
  const sdz = kMax - kMin + 1;
  const sub = new Uint8Array(sdx * sdy * sdz);
  const sStride = sdx * sdy;
  for (let k = 0; k < sdz; k++) {
    for (let j = 0; j < sdy; j++) {
      const srcBase = (k + kMin) * stride + (j + jMin) * dx + iMin;
      const dstBase = k * sStride + j * sdx;
      for (let i = 0; i < sdx; i++) sub[dstBase + i] = vol[srcBase + i];
    }
  }
  return { sub, subDims: { dx: sdx, dy: sdy, dz: sdz }, origin: [iMin, jMin, kMin] };
}

/** Paste subvolume back into full-size output at origin offset. */
export function pasteSubvolume(
  out: Uint8Array,
  outDims: VolumeDims,
  sub: Uint8Array,
  subDims: VolumeDims,
  origin: [number, number, number]
): void {
  const { dx, dy } = outDims;
  const stride = dx * dy;
  const sStride = subDims.dx * subDims.dy;
  const [ox, oy, oz] = origin;
  for (let k = 0; k < subDims.dz; k++) {
    for (let j = 0; j < subDims.dy; j++) {
      const srcBase = k * sStride + j * subDims.dx;
      const dstBase = (k + oz) * stride + (j + oy) * dx + ox;
      for (let i = 0; i < subDims.dx; i++) out[dstBase + i] = sub[srcBase + i];
    }
  }
}

/**
 * Flat indices of all rim (boundary) voxels: foreground with ≥1 bg 6-neighbor.
 * Iterates only within mask bbox. Returned in i→j→k order.
 */
export function rimIndices(mask: Uint8Array, dims: VolumeDims): Int32Array {
  const { dx, dy, dz } = dims;
  const stride = dx * dy;
  const bbox = boundingBox(mask, dims);
  if (!bbox) return new Int32Array(0);
  const tmp: number[] = [];
  for (let k = bbox.kMin; k <= bbox.kMax; k++) {
    for (let j = bbox.jMin; j <= bbox.jMax; j++) {
      for (let i = bbox.iMin; i <= bbox.iMax; i++) {
        const idx = k * stride + j * dx + i;
        if (!mask[idx]) continue;
        if (
          (i + 1 < dx && !mask[idx + 1]) ||
          (i - 1 >= 0 && !mask[idx - 1]) ||
          (j + 1 < dy && !mask[idx + dx]) ||
          (j - 1 >= 0 && !mask[idx - dx]) ||
          (k + 1 < dz && !mask[idx + stride]) ||
          (k - 1 >= 0 && !mask[idx - stride])
        ) tmp.push(idx);
      }
    }
  }
  return new Int32Array(tmp);
}

export function countVoxels(vol: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < vol.length; i++) if (vol[i]) n++;
  return n;
}

/**
 * Fill 3D holes: foreground = everything except background reachable from
 * volume boundary. Background flood-fill from all edge voxels; invert; union
 * with src. Removes internal holes so erosion doesn't break shell rims.
 */
export function fillHoles3D(src: Uint8Array, dims: VolumeDims): Uint8Array {
  // Crop to bbox + pad=2 — external-bg flood needs a bg shell around mask.
  // Full-volume version allocated >500 MB; cropped fits in tens of MB.
  const bbox = boundingBox(src, dims);
  if (!bbox) return new Uint8Array(src.length);
  const { sub, subDims, origin } = cropWithPad(src, dims, bbox, 2);
  const filled = _fillHolesInSub(sub, subDims);
  const out = new Uint8Array(src.length);
  // Keep voxels already set outside bbox (shouldn't be any since bbox covers
  // all foreground), then paste filled sub back.
  for (let i = 0; i < src.length; i++) out[i] = src[i];
  pasteSubvolume(out, dims, filled, subDims, origin);
  return out;
}

function _fillHolesInSub(src: Uint8Array, dims: VolumeDims): Uint8Array {
  const { dx, dy, dz } = dims;
  const stride = dx * dy;
  const total = src.length;
  const externalBg = new Uint8Array(total); // 1 = bg reachable from outside

  let queue = new Int32Array(65536);
  let qHead = 0;
  let qTail = 0;
  const enqueue = (v: number) => {
    if (qTail >= queue.length) {
      const bigger = new Int32Array(queue.length * 2);
      bigger.set(queue);
      queue = bigger;
    }
    queue[qTail++] = v;
  };

  const pushIfBg = (i: number, j: number, k: number) => {
    if (i < 0 || i >= dx || j < 0 || j >= dy || k < 0 || k >= dz) return;
    const idx = k * stride + j * dx + i;
    if (src[idx] || externalBg[idx]) return;
    externalBg[idx] = 1;
    enqueue(idx);
  };

  // Seed from all 6 faces
  for (let j = 0; j < dy; j++) {
    for (let i = 0; i < dx; i++) {
      pushIfBg(i, j, 0);
      pushIfBg(i, j, dz - 1);
    }
  }
  for (let k = 0; k < dz; k++) {
    for (let i = 0; i < dx; i++) {
      pushIfBg(i, 0, k);
      pushIfBg(i, dy - 1, k);
    }
    for (let j = 0; j < dy; j++) {
      pushIfBg(0, j, k);
      pushIfBg(dx - 1, j, k);
    }
  }

  while (qHead < qTail) {
    const idx = queue[qHead++];
    const k = (idx / stride) | 0;
    const rem = idx - k * stride;
    const j = (rem / dx) | 0;
    const i = rem - j * dx;
    if (i + 1 < dx) { const n = idx + 1; if (!src[n] && !externalBg[n]) { externalBg[n] = 1; enqueue(n); } }
    if (i - 1 >= 0) { const n = idx - 1; if (!src[n] && !externalBg[n]) { externalBg[n] = 1; enqueue(n); } }
    if (j + 1 < dy) { const n = idx + dx; if (!src[n] && !externalBg[n]) { externalBg[n] = 1; enqueue(n); } }
    if (j - 1 >= 0) { const n = idx - dx; if (!src[n] && !externalBg[n]) { externalBg[n] = 1; enqueue(n); } }
    if (k + 1 < dz) { const n = idx + stride; if (!src[n] && !externalBg[n]) { externalBg[n] = 1; enqueue(n); } }
    if (k - 1 >= 0) { const n = idx - stride; if (!src[n] && !externalBg[n]) { externalBg[n] = 1; enqueue(n); } }
  }

  const out = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    out[i] = (src[i] || !externalBg[i]) ? 1 : 0;
  }
  return out;
}

/**
 * Paint (or erase) a 3D spherical stamp into a labelmap at voxel center (ci, cj, ck).
 * `value` = 1 for paint, 0 for erase. Mutates `data` in place; returns count changed.
 */
export function paintSphere(
  data: Uint8Array,
  dims: VolumeDims,
  ci: number,
  cj: number,
  ck: number,
  radiusVox: number,
  value: 0 | 1
): number {
  const { dx, dy, dz } = dims;
  const stride = dx * dy;
  const r2 = radiusVox * radiusVox;
  const iMin = Math.max(0, ci - radiusVox);
  const iMax = Math.min(dx - 1, ci + radiusVox);
  const jMin = Math.max(0, cj - radiusVox);
  const jMax = Math.min(dy - 1, cj + radiusVox);
  const kMin = Math.max(0, ck - radiusVox);
  const kMax = Math.min(dz - 1, ck + radiusVox);
  let changed = 0;
  for (let k = kMin; k <= kMax; k++) {
    const dk = k - ck;
    for (let j = jMin; j <= jMax; j++) {
      const dj = j - cj;
      const djk2 = dj * dj + dk * dk;
      if (djk2 > r2) continue;
      const rowBase = k * stride + j * dx;
      for (let i = iMin; i <= iMax; i++) {
        const di = i - ci;
        if (di * di + djk2 > r2) continue;
        const idx = rowBase + i;
        if (data[idx] !== value) {
          data[idx] = value;
          changed++;
        }
      }
    }
  }
  return changed;
}
