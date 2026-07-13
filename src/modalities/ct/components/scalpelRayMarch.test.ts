import { describe, expect, it } from 'vitest';
import {
  SCALPEL_AIR_HU,
  buildViewRay,
  collectPolygonRaySamples,
  firstHitT,
  intersectAabb,
  marchRangeAlongRay,
  pointInPolygon,
  shouldEraseVoxel,
  eraseValueForScalarType,
} from './scalpelRayMarch';

describe('eraseValueForScalarType', () => {
  it('returns 0 (air, stored units) for unsigned arrays to avoid HU wrap-around', () => {
    expect(eraseValueForScalarType('Uint16Array')).toBe(0);
    expect(eraseValueForScalarType('Uint8Array')).toBe(0);
    expect(eraseValueForScalarType('Uint32Array')).toBe(0);
  });
  it('returns -3024 HU for signed / float arrays (maps to zero VRT opacity)', () => {
    expect(eraseValueForScalarType('Int16Array')).toBe(SCALPEL_AIR_HU);
    expect(eraseValueForScalarType('Float32Array')).toBe(SCALPEL_AIR_HU);
    expect(eraseValueForScalarType('Int8Array')).toBe(SCALPEL_AIR_HU);
  });
  it('defaults to -3024 for unknown / missing type', () => {
    expect(eraseValueForScalarType(undefined)).toBe(SCALPEL_AIR_HU);
    expect(eraseValueForScalarType(null)).toBe(SCALPEL_AIR_HU);
    expect(eraseValueForScalarType('')).toBe(SCALPEL_AIR_HU);
  });
});

describe('firstHitT', () => {
  // HU profile along a ray: air until t=5, contrast blood (300) at t=5..7, bone (900) after.
  const sampleHU = (t: number): number | null => {
    if (t < 0) return null;          // outside the volume
    if (t < 5) return -1000;         // air
    if (t < 7) return 300;           // contrast blood pool
    return 900;                      // bone
  };

  it('returns the first t whose HU falls in [minHU, maxHU]', () => {
    const t = firstHitT({ tMin: 0, tMax: 10 }, 1, sampleHU, 100, 500);
    expect(t).toBe(5); // first sample >= 100 && <= 500
  });

  it('skips out-of-volume (null) samples without treating them as hits', () => {
    const t = firstHitT({ tMin: -3, tMax: 6 }, 1, sampleHU, 100, 500);
    expect(t).toBe(5);
  });

  it('returns null when nothing along the ray is inside the window', () => {
    const t = firstHitT({ tMin: 0, tMax: 4 }, 1, sampleHU, 100, 500); // only air sampled
    expect(t).toBeNull();
  });

  it('does not stop on denser tissue past the window (bone excluded)', () => {
    // Window that only matches bone should skip the earlier blood samples.
    const t = firstHitT({ tMin: 0, tMax: 10 }, 1, sampleHU, 800, 1000);
    expect(t).toBe(7);
  });

  it('guards against non-positive step and inverted ranges', () => {
    expect(firstHitT({ tMin: 0, tMax: 10 }, 0, sampleHU, 100, 500)).toBeNull();
    expect(firstHitT({ tMin: 10, tMax: 0 }, 1, sampleHU, 100, 500)).toBeNull();
  });
});

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