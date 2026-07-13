import { describe, expect, it } from 'vitest';
import { buildThresholdMask, clipRange } from './isoMask';

describe('clipRange', () => {
  it('maps 0..100% to the full inclusive index range', () => {
    expect(clipRange(0, 100, 10)).toEqual([0, 9]);
  });

  it('maps a sub-range and rounds to nearest voxel', () => {
    expect(clipRange(20, 80, 11)).toEqual([2, 8]);
  });

  it('orders lo/hi even if passed inverted', () => {
    expect(clipRange(80, 20, 11)).toEqual([2, 8]);
  });

  it('clamps out-of-bounds percentages', () => {
    expect(clipRange(-50, 200, 10)).toEqual([0, 9]);
  });
});

describe('buildThresholdMask', () => {
  const dims = { dx: 2, dy: 2, dz: 2 };
  // 8 voxels, values chosen to straddle a window.
  //            i j k -> idx           value
  const scalar = [
    -1000, // 0,0,0
    300,   // 1,0,0
    150,   // 0,1,0
    900,   // 1,1,0
    0,     // 0,0,1
    450,   // 1,0,1
    -200,  // 0,1,1
    600,   // 1,1,1
  ];

  it('selects only voxels inside [minHU, maxHU]', () => {
    const { mask, count } = buildThresholdMask(scalar, dims, 100, 500);
    // in-range: 300, 150, 450 → 3
    expect(count).toBe(3);
    expect(mask[1]).toBe(1); // 300
    expect(mask[2]).toBe(1); // 150
    expect(mask[5]).toBe(1); // 450
    expect(mask[0]).toBe(0); // -1000
    expect(mask[3]).toBe(0); // 900
  });

  it('treats the window as inclusive at both ends', () => {
    const { count } = buildThresholdMask(scalar, dims, 300, 600);
    // 300, 450, 600 → 3
    expect(count).toBe(3);
  });

  it('handles an inverted window (min > max)', () => {
    const a = buildThresholdMask(scalar, dims, 500, 100);
    const b = buildThresholdMask(scalar, dims, 100, 500);
    expect(a.count).toBe(b.count);
  });

  it('restricts selection to the clip box', () => {
    // Keep only i=1 column (xMin..xMax → index 1..1): voxels 1,3,5,7
    const clip = { xMin: 100, xMax: 100, yMin: 0, yMax: 100, zMin: 0, zMax: 100 };
    const { mask, count } = buildThresholdMask(scalar, dims, -2000, 2000, clip);
    expect(count).toBe(4);
    expect(mask[0]).toBe(0);
    expect(mask[1]).toBe(1);
    expect(mask[5]).toBe(1);
  });

  it('returns an all-zero mask when nothing is in range', () => {
    const { mask, count } = buildThresholdMask(scalar, dims, 2000, 3000);
    expect(count).toBe(0);
    expect(mask.every((v) => v === 0)).toBe(true);
  });
});
