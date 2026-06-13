import { describe, expect, it } from 'vitest';
import {
  SCALPEL_AIR_HU,
  buildViewRay,
  collectPolygonRaySamples,
  intersectAabb,
  marchRangeAlongRay,
  pointInPolygon,
  readVoxelHu,
  runScalpelErase,
  shouldEraseVoxel,
  type ScalpelVolumeLike,
  type ScalpelViewportLike,
} from './scalpelRayMarch';

describe('scalpelRayMarch', () => {
  it('detects points inside a polygon', () => {
    const square: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(pointInPolygon(5, 5, square)).toBe(true);
    expect(pointInPolygon(15, 5, square)).toBe(false);
  });

  it('intersects an axis-aligned box', () => {
    const bounds = [0, 10, 0, 10, 0, 10];
    const hit = intersectAabb([5, 5, -5], [0, 0, 1], bounds);
    expect(hit).not.toBeNull();
    expect(hit!.tMin).toBeCloseTo(5);
    expect(hit!.tMax).toBeCloseTo(15);
  });

  it('builds perspective rays from camera through focal-plane target', () => {
    const cam = {
      position: [0, 0, -10] as [number, number, number],
      focalPoint: [0, 0, 0] as [number, number, number],
      parallelProjection: false,
    };
    const ray = buildViewRay(cam, [0, 0, 0]);
    expect(ray?.origin).toEqual([0, 0, -10]);
    expect(ray?.dir[2]).toBeCloseTo(1);
  });

  it('falls back to focal-distance march when AABB is missed', () => {
    const cam = {
      position: [0, 0, -100] as [number, number, number],
      focalPoint: [0, 0, 0] as [number, number, number],
      parallelProjection: false,
    };
    const worldTarget: [number, number, number] = [0, 0, 0];
    const ray = buildViewRay(cam, worldTarget)!;
    const range = marchRangeAlongRay(ray.origin, ray.dir, [50, 60, 50, 60, 50, 60], cam, worldTarget);
    expect(range).not.toBeNull();
    expect(range!.tMax).toBeGreaterThan(range!.tMin);
  });

  it('only erases tissue-range voxels', () => {
    expect(shouldEraseVoxel(-1024, SCALPEL_AIR_HU)).toBe(false);
    expect(shouldEraseVoxel(120, SCALPEL_AIR_HU)).toBe(true);
    expect(shouldEraseVoxel(SCALPEL_AIR_HU, SCALPEL_AIR_HU)).toBe(false);
  });

  it('samples interior pixels of a polygon', () => {
    const triangle: Array<[number, number]> = [[0, 0], [8, 0], [4, 8]];
    const samples = collectPolygonRaySamples(triangle, 2);
    expect(samples.length).toBeGreaterThan(0);
    for (const [x, y] of samples) {
      expect(pointInPolygon(x, y, triangle)).toBe(true);
    }
  });

  it('runScalpelErase erases tissue voxels through a mocked volume', () => {
    const dims: [number, number, number] = [10, 10, 10];
    const spacing: [number, number, number] = [1, 1, 1];
    const bounds = [0, 9, 0, 9, 0, 9];
    const scalarData = new Int16Array(dims[0] * dims[1] * dims[2]).fill(-1024);

    const tissueHu = 400;
    for (let k = 3; k <= 6; k++) {
      for (let j = 3; j <= 6; j++) {
        for (let i = 3; i <= 6; i++) {
          scalarData[k * dims[0] * dims[1] + j * dims[0] + i] = tissueHu;
        }
      }
    }

    const volume: ScalpelVolumeLike = {
      voxelManager: {
        getAtIJK: (i, j, k) => scalarData[k * dims[0] * dims[1] + j * dims[0] + i],
        setAtIJK: (i, j, k, value) => {
          scalarData[k * dims[0] * dims[1] + j * dims[0] + i] = value;
        },
        getCompleteScalarDataArray: () => scalarData,
        setCompleteScalarDataArray: (data) => {
          scalarData.set(data);
        },
      },
      imageData: {
        getDimensions: () => dims,
        getSpacing: () => spacing,
        getBounds: () => bounds,
        worldToIndex: (world) => [world[0], world[1], world[2]],
        getPointData: () => ({
          getScalars: () => ({ getData: () => scalarData }),
        }),
      },
      scalarData,
    };

    const viewport: ScalpelViewportLike = {
      getCamera: () => ({
        position: [5, 5, -20],
        focalPoint: [5, 5, 5],
        parallelProjection: false,
      }),
      canvasToWorld: ([cx, cy]) => [cx, cy, 5],
    };

    const polygon: Array<[number, number]> = [[3, 3], [7, 3], [7, 7], [3, 7]];
    const erasedVoxels: Array<[number, number, number]> = [];
    const stats = runScalpelErase(viewport, volume, polygon, {
      onVoxelErased: (ii, jj, kk) => erasedVoxels.push([ii, jj, kk]),
    });

    expect(stats).not.toBeNull();
    expect(stats!.erased).toBeGreaterThan(0);
    expect(stats!.rayHits).toBeGreaterThan(0);
    expect(stats!.mapFailures).toBe(0);
    expect(stats!.eraseValue).toBe(SCALPEL_AIR_HU);
    expect(stats!.modifiedSliceIndices.size).toBeGreaterThan(0);
    expect(erasedVoxels.length).toBe(stats!.erased);

    const center = scalarData[5 * dims[0] * dims[1] + 5 * dims[0] + 5];
    expect(center).toBe(SCALPEL_AIR_HU);
  });

  it('readVoxelHu uses VTK scalar array when getAtIJK returns null', () => {
    const dims: [number, number, number] = [4, 4, 4];
    const scalarData = new Int16Array(64).fill(250);
    const vm = { getAtIJK: () => null as number | null, setAtIJK: () => {} };
    expect(readVoxelHu(1, 1, 1, dims, vm, scalarData, null)).toBe(250);
    expect(readVoxelHu(1, 1, 1, dims, vm, null, null)).toBeNull();
  });

  it('runScalpelErase erases when getAtIJK is null but VTK scalars are populated', () => {
    const dims: [number, number, number] = [10, 10, 10];
    const scalarData = new Int16Array(dims[0] * dims[1] * dims[2]).fill(-1024);
    for (let k = 3; k <= 6; k++) {
      for (let j = 3; j <= 6; j++) {
        for (let i = 3; i <= 6; i++) {
          scalarData[k * dims[0] * dims[1] + j * dims[0] + i] = 500;
        }
      }
    }

    const volume: ScalpelVolumeLike = {
      voxelManager: {
        getAtIJK: () => null,
        setAtIJK: (i, j, k, value) => {
          scalarData[k * dims[0] * dims[1] + j * dims[0] + i] = value;
        },
        getCompleteScalarDataArray: () => scalarData,
        setCompleteScalarDataArray: (data) => scalarData.set(data),
      },
      imageData: {
        getDimensions: () => dims,
        getSpacing: () => [1, 1, 1],
        getBounds: () => [0, 9, 0, 9, 0, 9],
        worldToIndex: (world) => [world[0], world[1], world[2]],
        getPointData: () => ({
          getScalars: () => ({ getData: () => scalarData }),
        }),
      },
      scalarData,
    };

    const viewport: ScalpelViewportLike = {
      getCamera: () => ({
        position: [5, 5, -20],
        focalPoint: [5, 5, 5],
        parallelProjection: false,
      }),
      canvasToWorld: ([cx, cy]) => [cx, cy, 5],
    };

    const stats = runScalpelErase(viewport, volume, [[3, 3], [7, 3], [7, 7], [3, 7]]);
    expect(stats?.erased).toBeGreaterThan(0);
  });

  it('runScalpelErase reports mapFailures when canvasToWorld is missing', () => {
    const dims: [number, number, number] = [4, 4, 4];
    const volume: ScalpelVolumeLike = {
      voxelManager: {
        getAtIJK: () => 100,
        setAtIJK: () => {},
      },
      imageData: {
        getDimensions: () => dims,
        getSpacing: () => [1, 1, 1],
        getBounds: () => [0, 3, 0, 3, 0, 3],
        worldToIndex: (world) => world,
      },
    };

    const viewport: ScalpelViewportLike = {
      getCamera: () => ({
        position: [2, 2, -10],
        focalPoint: [2, 2, 2],
      }),
    };

    const stats = runScalpelErase(viewport, volume, [[0, 0], [3, 0], [3, 3]]);
    expect(stats?.erased).toBe(0);
    expect(stats?.mapFailures).toBeGreaterThan(0);
  });
});