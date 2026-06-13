import { describe, it, expect } from 'vitest';
import { snapPointToLumenCentroid, snapPointToAxialMinimum } from './AorticAxisDetection';
import type { TAVIVector3D } from './TAVITypes';

// Identity-affine volume: world (x,y,z) ↔ voxel (x,y,z) at unit spacing.
function makeVolume(dims: [number, number, number], fill: (i: number, j: number, k: number) => number) {
  const [dx, dy, dz] = dims;
  const data = new Float32Array(dx * dy * dz);
  for (let k = 0; k < dz; k++)
    for (let j = 0; j < dy; j++)
      for (let i = 0; i < dx; i++)
        data[i + j * dx + k * dx * dy] = fill(i, j, k);
  return {
    voxelManager: { getScalarData: () => data },
    dimensions: dims,
    spacing: [1, 1, 1] as [number, number, number],
    origin: [0, 0, 0] as [number, number, number],
    direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  };
}

describe('snapPointToLumenCentroid', () => {
  it('snaps a near-miss seed onto the bright lumen centroid', () => {
    // Bright (HU 350) sphere centered at (20,20,20), radius 4.
    const vol = makeVolume([40, 40, 40], (i, j, k) =>
      (i - 20) ** 2 + (j - 20) ** 2 + (k - 20) ** 2 <= 16 ? 350 : 0
    );
    const seed: TAVIVector3D = { x: 22, y: 21, z: 20 };
    const snapped = snapPointToLumenCentroid(vol, seed, { radiusMm: 5 });
    expect(snapped).not.toBeNull();
    expect(snapped!.x).toBeCloseTo(20, 0);
    expect(snapped!.y).toBeCloseTo(20, 0);
    expect(snapped!.z).toBeCloseTo(20, 0);
  });

  it('returns null when no lumen-density voxels are near (empty volume)', () => {
    const vol = makeVolume([20, 20, 20], () => 0);
    expect(snapPointToLumenCentroid(vol, { x: 10, y: 10, z: 10 })).toBeNull();
  });

  it('returns null for a non-extractable volume', () => {
    expect(snapPointToLumenCentroid({}, { x: 0, y: 0, z: 0 })).toBeNull();
  });
});

describe('snapPointToAxialMinimum', () => {
  it('snaps toward the local HU minimum along the axis', () => {
    // Column bright everywhere except a dip at k=22 (axis = +z).
    const vol = makeVolume([10, 10, 40], (_i, _j, k) => (k === 22 ? 50 : 400));
    const seed: TAVIVector3D = { x: 5, y: 5, z: 20 };
    const snapped = snapPointToAxialMinimum(vol, seed, { x: 0, y: 0, z: 1 }, { searchMm: 4, stepMm: 1, radiusMm: 0 });
    expect(snapped).not.toBeNull();
    expect(snapped!.z).toBeCloseTo(22, 0);
  });

  it('ignores a dip outside the search window', () => {
    const vol = makeVolume([10, 10, 60], (_i, _j, k) => (k === 50 ? 50 : 400));
    const seed: TAVIVector3D = { x: 5, y: 5, z: 20 };
    const snapped = snapPointToAxialMinimum(vol, seed, { x: 0, y: 0, z: 1 }, { searchMm: 4, stepMm: 1, radiusMm: 0 });
    // The dip at z=50 is far outside ±4mm; snap stays within the window.
    expect(snapped).not.toBeNull();
    expect(Math.abs(snapped!.z - 20)).toBeLessThanOrEqual(4);
  });

  it('returns null when the search is entirely out of bounds', () => {
    const vol = makeVolume([10, 10, 10], () => 300);
    const snapped = snapPointToAxialMinimum(vol, { x: 500, y: 500, z: 500 }, { x: 0, y: 0, z: 1 });
    expect(snapped).toBeNull();
  });

  it('returns null for a non-extractable volume', () => {
    expect(snapPointToAxialMinimum({}, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })).toBeNull();
  });
});
