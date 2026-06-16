import { describe, it, expect } from 'vitest';
import { autoSegmentCrossSectionAtPlane } from './AorticAxisDetection';
import type { TAVIVector3D } from './TAVITypes';

// Cornerstone-volume mock: identity direction, unit spacing.
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

const NZ: TAVIVector3D = { x: 0, y: 0, z: 1 };
const VY: TAVIVector3D = { x: 0, y: 1, z: 0 };

describe('autoSegmentCrossSectionAtPlane: largest-component seed + min-diameter floor', () => {
  // Scene: a big "aortic" lumen (radius 13 mm, ≈26 mm dia, 300 HU)
  // plus a tiny "calcium fleck / coronary ostium" (radius 1.5 mm, ≈3 mm dia, 300 HU)
  // sitting 8 mm to the side. The crosshair is placed BETWEEN them, closer to the fleck.
  // Old algorithm: flood-fills the nearest qualifying pixel → grabs the fleck.
  // New algorithm: labels both, picks the bigger one (the aorta).
  const aortaCenter = { x: 60, y: 60 };
  const fleckCenter = { x: 78, y: 60 }; // 18 mm to the +x of the aorta
  const vol = makeVolume([120, 120, 10], (i, j) => {
    const dA = Math.hypot(i - aortaCenter.x, j - aortaCenter.y);
    if (dA <= 13) return 300;
    const dF = Math.hypot(i - fleckCenter.x, j - fleckCenter.y);
    if (dF <= 1.5) return 300;
    return -50; // soft-tissue / background
  });

  it('picks the aorta even when the crosshair is closer to a small fleck', () => {
    // Crosshair 2 mm from fleck centre, 16 mm from aorta centre.
    const origin: TAVIVector3D = { x: 76, y: 60, z: 5 };
    const seg = autoSegmentCrossSectionAtPlane(vol, origin, NZ, VY, {
      huMin: 150, huMax: 500, gridSize: 200, pixelSpacing: 0.25,
      maxDiameterMm: 55, minDiameterMm: 15, searchRadiusMm: 25,
    });
    expect(seg).not.toBeNull();
    // Contour centroid should land on the aorta (x≈60), not the fleck (x≈78).
    const cx = seg!.contourPoints.reduce((s, p) => s + p.x, 0) / seg!.contourPoints.length;
    expect(cx).toBeGreaterThan(55);
    expect(cx).toBeLessThan(65);
  });

  it('rejects when only a tiny structure is in range (no big lumen near crosshair)', () => {
    // Volume with only the fleck — no aorta.
    const tinyOnly = makeVolume([120, 120, 10], (i, j) => {
      const d = Math.hypot(i - fleckCenter.x, j - fleckCenter.y);
      return d <= 1.5 ? 300 : -50;
    });
    const origin: TAVIVector3D = { x: 78, y: 60, z: 5 };
    const seg = autoSegmentCrossSectionAtPlane(tinyOnly, origin, NZ, VY, {
      huMin: 150, huMax: 500, gridSize: 200, pixelSpacing: 0.25,
      maxDiameterMm: 55, minDiameterMm: 15, searchRadiusMm: 25,
    });
    // 3 mm fleck is below 15 mm floor → reject. Old code would have returned it.
    expect(seg).toBeNull();
  });

  it('returns a valid contour when crosshair is correctly inside the aorta', () => {
    const origin: TAVIVector3D = { x: 60, y: 60, z: 5 };
    const seg = autoSegmentCrossSectionAtPlane(vol, origin, NZ, VY, {
      huMin: 150, huMax: 500, gridSize: 200, pixelSpacing: 0.25,
      maxDiameterMm: 55, minDiameterMm: 15, searchRadiusMm: 25,
    });
    expect(seg).not.toBeNull();
    expect(seg!.contourPoints.length).toBeGreaterThanOrEqual(10);
  });

  it('rejects components whose centroid is outside the search radius', () => {
    // Big lumen 40 mm away from the crosshair, no other contrast near it.
    const farVol = makeVolume([200, 200, 10], (i, j) => {
      const d = Math.hypot(i - 30, j - 30); // aorta centred at (30,30)
      return d <= 13 ? 300 : -50;
    });
    const origin: TAVIVector3D = { x: 100, y: 100, z: 5 }; // ~99 mm away
    const seg = autoSegmentCrossSectionAtPlane(farVol, origin, NZ, VY, {
      huMin: 150, huMax: 500, gridSize: 200, pixelSpacing: 0.25,
      maxDiameterMm: 55, minDiameterMm: 15, searchRadiusMm: 25,
    });
    expect(seg).toBeNull();
  });
});
