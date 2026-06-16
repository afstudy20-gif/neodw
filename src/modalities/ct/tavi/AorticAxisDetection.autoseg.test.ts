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

describe('autoSegmentCrossSectionAtPlane: seeded BFS from crosshair + min-diameter floor', () => {
  // Scene: a big "aortic" lumen (radius 13 mm, ≈26 mm dia, 300 HU)
  // plus a tiny "calcium fleck / coronary ostium" (radius 1.5 mm, ≈3 mm dia, 300 HU)
  // sitting 18 mm to the side. The two structures are NOT touching.
  const aortaCenter = { x: 60, y: 60 };
  const fleckCenter = { x: 78, y: 60 }; // 18 mm to the +x of the aorta
  const vol = makeVolume([120, 120, 10], (i, j) => {
    const dA = Math.hypot(i - aortaCenter.x, j - aortaCenter.y);
    if (dA <= 13) return 300;
    const dF = Math.hypot(i - fleckCenter.x, j - fleckCenter.y);
    if (dF <= 1.5) return 300;
    return -50; // soft-tissue / background
  });

  it('segments the aorta when the crosshair sits on the aorta lumen', () => {
    const origin: TAVIVector3D = { x: 60, y: 60, z: 5 };
    const seg = autoSegmentCrossSectionAtPlane(vol, origin, NZ, VY, {
      huMin: 150, huMax: 500, gridSize: 200, pixelSpacing: 0.25,
      maxDiameterMm: 55, minDiameterMm: 15,
    });
    expect(seg).not.toBeNull();
    expect(seg!.contourPoints.length).toBeGreaterThanOrEqual(10);
    // Contour centred near the aorta.
    const cx = seg!.contourPoints.reduce((s, p) => s + p.x, 0) / seg!.contourPoints.length;
    const cy = seg!.contourPoints.reduce((s, p) => s + p.y, 0) / seg!.contourPoints.length;
    expect(cx).toBeGreaterThan(55);
    expect(cx).toBeLessThan(65);
    expect(cy).toBeGreaterThan(55);
    expect(cy).toBeLessThan(65);
  });

  it('rejects when the crosshair sits on a sub-lumen fleck (min-diameter floor)', () => {
    // Crosshair on the fleck. Seeded BFS isolates the fleck (it can't reach the
    // aorta — they're disconnected). minDiameterMm rejects it as too small.
    const origin: TAVIVector3D = { x: 78, y: 60, z: 5 };
    const seg = autoSegmentCrossSectionAtPlane(vol, origin, NZ, VY, {
      huMin: 150, huMax: 500, gridSize: 200, pixelSpacing: 0.25,
      maxDiameterMm: 55, minDiameterMm: 15,
    });
    expect(seg).toBeNull();
  });

  it('rejects when the crosshair is OFF every contrast structure', () => {
    // Crosshair in background (HU = -50, outside the 150–500 band). Seed pixel
    // not in any mask → null. Old "biggest within radius" code would have
    // grabbed the aorta from a few mm away; seeded BFS requires user alignment.
    const origin: TAVIVector3D = { x: 0, y: 0, z: 5 };
    const seg = autoSegmentCrossSectionAtPlane(vol, origin, NZ, VY, {
      huMin: 150, huMax: 500, gridSize: 200, pixelSpacing: 0.25,
      maxDiameterMm: 55, minDiameterMm: 15,
    });
    expect(seg).toBeNull();
  });

  it('segments a sub-peak / delayed-phase lumen (HU ~120) without an explicit threshold', () => {
    // Lumen at 120 HU — typical late-arterial or delayed-phase aorta. A static
    // 150–500 band would exclude every pixel and starve the BFS; the dynamic
    // seed-anchored band catches it as long as the crosshair is on the lumen.
    const dimLumen = makeVolume([120, 120, 10], (i, j) => {
      const d = Math.hypot(i - 60, j - 60);
      return d <= 13 ? 120 : -50;
    });
    const origin: TAVIVector3D = { x: 60, y: 60, z: 5 };
    const seg = autoSegmentCrossSectionAtPlane(dimLumen, origin, NZ, VY, {
      gridSize: 200, pixelSpacing: 0.25, maxDiameterMm: 55, minDiameterMm: 15,
    });
    expect(seg).not.toBeNull();
    expect(seg!.contourPoints.length).toBeGreaterThanOrEqual(10);
  });

  it('returns the aorta even if a brighter neighbour exists in the field', () => {
    // Brighter fleck (700 HU) close to the aorta but disconnected from it.
    // A "largest HU" / "brightest blob" strategy would prefer the fleck;
    // seeded BFS from the crosshair on the lumen segments the lumen.
    const mixedVol = makeVolume([120, 120, 10], (i, j) => {
      const dA = Math.hypot(i - aortaCenter.x, j - aortaCenter.y);
      if (dA <= 13) return 250;
      const dF = Math.hypot(i - fleckCenter.x, j - fleckCenter.y);
      if (dF <= 1.5) return 700;
      return -50;
    });
    const origin: TAVIVector3D = { x: 60, y: 60, z: 5 };
    const seg = autoSegmentCrossSectionAtPlane(mixedVol, origin, NZ, VY, {
      huMin: 150, huMax: 500, gridSize: 200, pixelSpacing: 0.25,
      maxDiameterMm: 55, minDiameterMm: 15,
    });
    expect(seg).not.toBeNull();
    const cx = seg!.contourPoints.reduce((s, p) => s + p.x, 0) / seg!.contourPoints.length;
    expect(cx).toBeLessThan(70); // not the fleck at x≈78
  });
});
