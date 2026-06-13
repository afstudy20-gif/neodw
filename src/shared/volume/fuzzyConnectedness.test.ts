import { describe, it, expect } from 'vitest';
import { fuzzyConnectedness, type FuzzyVolume } from './fuzzyConnectedness';

const N = 10;
const flat = (x: number, y: number, z: number) => x + y * N + z * N * N;

function fill(fn: (x: number, y: number, z: number) => number): FuzzyVolume {
  const d = new Float32Array(N * N * N);
  for (let z = 0; z < N; z++)
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) d[flat(x, y, z)] = fn(x, y, z);
  return { data: d, dimensions: [N, N, N] };
}

describe('fuzzyConnectedness', () => {
  it('fills a uniform bright volume from a single seed', () => {
    const vol = fill(() => 300);
    const r = fuzzyConnectedness(vol, [flat(5, 5, 5)], { threshold: 0.5 });
    expect(r.objectVoxelCount).toBe(N * N * N);
    expect(r.connectivity[flat(0, 0, 0)]).toBeCloseTo(1, 5);
  });

  it('does NOT leak across a low-intensity wall (the key advantage over region grow)', () => {
    // Left half bright, a 2-voxel dark wall at x=4,5, right half bright.
    const vol = fill((x) => (x === 4 || x === 5 ? -200 : 300));
    const r = fuzzyConnectedness(vol, [flat(1, 5, 5)], {
      threshold: 0.5, homogeneitySigma: 40, objectSigma: 80,
    });
    expect(r.mask[flat(1, 5, 5)]).toBe(1);   // seed side included
    expect(r.mask[flat(8, 5, 5)]).toBe(0);   // far side blocked by the wall
    expect(r.mask[flat(4, 5, 5)]).toBe(0);   // wall itself excluded
  });

  it('excludes a contiguous region of dissimilar intensity (object membership)', () => {
    // Bright blob x<5 (300), adjacent contiguous region x>=5 at a very different
    // intensity (-100) — connected spatially but not part of the object.
    const vol = fill((x) => (x < 5 ? 300 : -100));
    const r = fuzzyConnectedness(vol, [flat(2, 5, 5)], {
      threshold: 0.5, homogeneitySigma: 30, objectSigma: 60,
    });
    expect(r.mask[flat(2, 5, 5)]).toBe(1);
    expect(r.mask[flat(8, 5, 5)]).toBe(0);
  });

  it('connectivity is the max-min path strength (monotonic, in [0,1])', () => {
    const vol = fill(() => 300);
    const r = fuzzyConnectedness(vol, [flat(0, 0, 0)]);
    for (const c of r.connectivity) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
    expect(r.connectivity[flat(0, 0, 0)]).toBe(1);
  });

  it('respects the threshold parameter', () => {
    const vol = fill((x) => 300 - x * 20); // gradient → connectivity decays along x
    const lo = fuzzyConnectedness(vol, [flat(0, 5, 5)], { threshold: 0.2 });
    const hi = fuzzyConnectedness(vol, [flat(0, 5, 5)], { threshold: 0.8 });
    expect(lo.objectVoxelCount).toBeGreaterThanOrEqual(hi.objectVoxelCount);
  });

  it('reports the seed mean', () => {
    const vol = fill(() => 250);
    const r = fuzzyConnectedness(vol, [flat(5, 5, 5), flat(4, 5, 5)]);
    expect(r.seedMean).toBeCloseTo(250, 5);
  });

  it('throws on no seeds or undersized data', () => {
    expect(() => fuzzyConnectedness(fill(() => 1), [])).toThrow(/seed/);
    expect(() => fuzzyConnectedness({ data: new Float32Array(5), dimensions: [10, 10, 10] }, [0]))
      .toThrow(/shorter than dimensions/);
  });
});
