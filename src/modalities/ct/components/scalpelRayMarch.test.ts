import { describe, expect, it } from 'vitest';
import {
  SCALPEL_AIR_HU,
  buildViewRay,
  collectPolygonRaySamples,
  intersectAabb,
  marchRangeAlongRay,
  pointInPolygon,
  shouldEraseVoxel,
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
});