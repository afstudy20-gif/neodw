import type { VoxelSampler } from './volumeSampler';
import type { WorldPoint3D } from '../coronary/QCATypes';

const AORTA_HU_MIN = 180;
const AORTA_HU_MAX = 600;
const MIN_BLOB_VOXELS = 80;

interface Blob {
  i: number;
  j: number;
  size: number;
}

function findAxialBlobs(sampler: VoxelSampler, k: number, visited: Uint8Array): Blob[] {
  const [w, h] = sampler.dims;
  visited.fill(0);
  const blobs: Blob[] = [];
  const stack: number[] = [];

  for (let j = 0; j < h; j += 1) {
    for (let i = 0; i < w; i += 1) {
      const idx = i + j * w;
      if (visited[idx]) continue;
      const hu = sampler.sampleIJK(i, j, k);
      if (hu < AORTA_HU_MIN || hu > AORTA_HU_MAX) {
        visited[idx] = 1;
        continue;
      }
      let sumI = 0;
      let sumJ = 0;
      let count = 0;
      stack.push(i, j);
      visited[idx] = 1;
      while (stack.length) {
        const pj = stack.pop()!;
        const pi = stack.pop()!;
        sumI += pi;
        sumJ += pj;
        count += 1;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = pi + di;
          const nj = pj + dj;
          if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
          const nIdx = ni + nj * w;
          if (visited[nIdx]) continue;
          const nhu = sampler.sampleIJK(ni, nj, k);
          if (nhu < AORTA_HU_MIN || nhu > AORTA_HU_MAX) {
            visited[nIdx] = 1;
            continue;
          }
          visited[nIdx] = 1;
          stack.push(ni, nj);
        }
      }
      if (count >= MIN_BLOB_VOXELS) {
        blobs.push({ i: sumI / count, j: sumJ / count, size: count });
      }
    }
  }
  return blobs;
}

export interface AortaTrace {
  centerline: WorldPoint3D[];
  rootWorld: WorldPoint3D;
  rootIJK: [number, number, number];
}

// Trace the ascending aorta by scanning from upper-chest slices downward and
// tracking the largest HU-bright connected blob that remains close to the
// previous slice's centroid. Root (ostia level) is the deepest valid slice.
export function detectAortaCenterline(sampler: VoxelSampler): AortaTrace | null {
  const [w, h, d] = sampler.dims;
  const visited = new Uint8Array(w * h);
  const centerline: WorldPoint3D[] = [];

  const kStart = Math.max(0, Math.floor(d * 0.15));
  const kEnd = Math.min(d - 1, Math.floor(d * 0.9));
  const kStep = Math.max(1, Math.floor(d / 40));

  let prev: Blob | null = null;
  let lastIJK: [number, number, number] | null = null;

  for (let k = kStart; k <= kEnd; k += kStep) {
    const blobs = findAxialBlobs(sampler, k, visited);
    if (blobs.length === 0) continue;

    let pick = blobs[0];
    if (prev) {
      let bestDist = Infinity;
      for (const b of blobs) {
        const dx = b.i - prev.i;
        const dy = b.j - prev.j;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          pick = b;
        }
      }
    } else {
      for (const b of blobs) if (b.size > pick.size) pick = b;
    }

    const ci = Math.round(pick.i);
    const cj = Math.round(pick.j);
    const world = sampler.worldAt(ci, cj, k);
    centerline.push({ x: world[0], y: world[1], z: world[2] });
    lastIJK = [ci, cj, k];
    prev = pick;
  }

  if (centerline.length < 3 || !lastIJK) return null;
  return {
    centerline,
    rootWorld: centerline[centerline.length - 1],
    rootIJK: lastIJK,
  };
}
