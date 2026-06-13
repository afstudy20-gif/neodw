import { describe, it, expect } from 'vitest';
import { samplePixelValuesInWorldContour } from './AorticAxisDetection';
import { TAVIGeometry } from './TAVIGeometry';
import type { TAVIVector3D } from './TAVITypes';

// Minimal Cornerstone-volume mock that extractVolumeInfo() understands:
// identity direction so world (x,y,z) → ijk = (x,y,z) at unit spacing/origin 0.
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

// Axis-aligned square contour at z=k on the +z plane.
function squareAtZ(cx: number, cy: number, half: number, z: number): TAVIVector3D[] {
  return [
    { x: cx - half, y: cy - half, z },
    { x: cx + half, y: cy - half, z },
    { x: cx + half, y: cy + half, z },
    { x: cx - half, y: cy + half, z },
  ];
}

const NZ: TAVIVector3D = { x: 0, y: 0, z: 1 };

describe('samplePixelValuesInWorldContour', () => {
  it('samples a constant-HU block to a uniform pixel array', () => {
    const vol = makeVolume([40, 40, 10], () => 300);
    const contour = squareAtZ(20, 20, 8, 5);
    const s = samplePixelValuesInWorldContour(vol, contour, NZ, { pixelSpacing: 0.5, padMm: 0 });
    expect(s).not.toBeNull();
    expect(s!.pixelAreaMm2).toBeCloseTo(0.25, 6);
    expect(s!.sampleCount).toBeGreaterThan(900); // ~16x16mm / 0.25mm² ≈ 1089
    expect(Array.from(s!.pixelValues).every((v) => v === 300)).toBe(true);
  });

  it('feeds the Agatston pipeline end-to-end for an embedded dense block', () => {
    // base 50 HU, with a 6×6mm 500-HU block centred at (20,20)
    const vol = makeVolume([40, 40, 10], (i, j) =>
      i >= 17 && i <= 23 && j >= 17 && j <= 23 ? 500 : 50
    );
    const contour = squareAtZ(20, 20, 9, 5);
    const s = samplePixelValuesInWorldContour(vol, contour, NZ, { pixelSpacing: 0.5, padMm: 0 })!;
    const ca = TAVIGeometry.calciumResultForPixelValues(s.pixelValues, s.pixelAreaMm2, 850);
    // Only the dense block contributes (density factor 4 for ≥400 HU).
    expect(ca.agatstonScore2D).toBeGreaterThan(0);
    expect(ca.samplesAboveThreshold).toBe(0); // 500 < 850 threshold, but still scores Agatston
    // Dense block spans voxels i,j ∈ [17,23] → ~7×7mm = ~49mm², ×4 density ≈ 196.
    // Allow a wide band for nearest-neighbour grid discretization.
    expect(ca.agatstonScore2D).toBeGreaterThan(150);
    expect(ca.agatstonScore2D).toBeLessThan(260);
  });

  it('excludes the notch of a concave (L-shaped) polygon', () => {
    const vol = makeVolume([40, 40, 10], () => 200);
    // L-shape: full bottom strip + left column, notch in the top-right.
    const L: TAVIVector3D[] = [
      { x: 10, y: 10, z: 5 },
      { x: 30, y: 10, z: 5 },
      { x: 30, y: 18, z: 5 },
      { x: 18, y: 18, z: 5 },
      { x: 18, y: 30, z: 5 },
      { x: 10, y: 30, z: 5 },
    ];
    const s = samplePixelValuesInWorldContour(vol, L, NZ, { pixelSpacing: 1, padMm: 0 })!;
    // A point in the notch (x≈25, y≈25) must NOT be sampled; full bbox would be
    // 20×20=400, the L-shape is much less.
    expect(s.sampleCount).toBeLessThan(330);
    expect(s.sampleCount).toBeGreaterThan(150);
  });

  it('returns null when the contour falls outside the volume', () => {
    const vol = makeVolume([40, 40, 10], () => 100);
    const contour = squareAtZ(500, 500, 5, 5); // far outside
    expect(samplePixelValuesInWorldContour(vol, contour, NZ, { pixelSpacing: 0.5 })).toBeNull();
  });

  it('returns null for a degenerate contour (<3 points)', () => {
    const vol = makeVolume([10, 10, 10], () => 100);
    expect(samplePixelValuesInWorldContour(vol, [{ x: 0, y: 0, z: 0 }], NZ)).toBeNull();
  });
});
