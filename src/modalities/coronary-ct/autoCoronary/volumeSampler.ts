import * as cornerstone from '@cornerstonejs/core';

const AIR_HU = -1000;

export interface VoxelSampler {
  sample(world: [number, number, number]): number;
  sampleIJK(i: number, j: number, k: number): number;
  worldAt(i: number, j: number, k: number): [number, number, number];
  dims: [number, number, number];
}

export function buildVoxelSampler(volume: cornerstone.Types.IImageVolume): VoxelSampler {
  const imgVol = volume as cornerstone.Types.IImageVolume & {
    imageData?: {
      worldToIndex(point: number[]): number[];
      indexToWorld(point: number[]): number[];
    };
    dimensions?: [number, number, number];
    getScalarData?(): ArrayLike<number>;
    voxelManager?: { getAtIJK(i: number, j: number, k: number): number };
  };

  if (!imgVol.imageData?.worldToIndex || !imgVol.imageData?.indexToWorld || !imgVol.dimensions) {
    throw new Error('Volume is missing imageData/dimensions — sampler unavailable.');
  }

  const dims = imgVol.dimensions;

  let scalarData: ArrayLike<number> | null = null;
  try {
    scalarData = imgVol.getScalarData?.() ?? null;
  } catch {
    scalarData = null;
  }

  const getAtIJK = imgVol.voxelManager?.getAtIJK.bind(imgVol.voxelManager);

  const sampleIJK = (i: number, j: number, k: number): number => {
    if (i < 0 || j < 0 || k < 0 || i >= dims[0] || j >= dims[1] || k >= dims[2]) return AIR_HU;
    if (scalarData) {
      return scalarData[i + j * dims[0] + k * dims[0] * dims[1]] ?? AIR_HU;
    }
    if (getAtIJK) {
      const v = getAtIJK(i, j, k) as unknown as number;
      return typeof v === 'number' && Number.isFinite(v) ? v : AIR_HU;
    }
    return AIR_HU;
  };

  return {
    sample(world) {
      const idx = imgVol.imageData!.worldToIndex(world as unknown as number[]);
      return sampleIJK(Math.round(idx[0]), Math.round(idx[1]), Math.round(idx[2]));
    },
    sampleIJK,
    worldAt(i, j, k) {
      const w = imgVol.imageData!.indexToWorld([i, j, k]);
      return [w[0], w[1], w[2]];
    },
    dims,
  };
}
