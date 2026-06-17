import { describe, it, expect } from 'vitest';
import { autoTraceAnnulusContrastEdgeAtPlane } from './AorticAxisDetection';
import type { TAVIVector3D } from './TAVITypes';

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

describe('autoTraceAnnulusContrastEdgeAtPlane', () => {
  it('prefers the outer contrast boundary over a brighter inner leaflet edge', () => {
    const center = { x: 50, y: 50, z: 5 };
    const vol = makeVolume([100, 100, 10], (i, j) => {
      const r = Math.hypot(i - center.x, j - center.y);
      if (r >= 6 && r <= 8) return 460; // bright leaflet/calcific inner edge
      if (r > 8 && r < 10) return 70;   // low-HU gap that used to stop tracing
      if (r >= 10 && r <= 16) return 300; // contrast-filled lumen to trace
      if (r < 6) return 90;
      return -60;
    });

    const seg = autoTraceAnnulusContrastEdgeAtPlane(vol, center, NZ, VY, {
      radialCount: 128,
      radialStepMm: 0.25,
      minRadiusMm: 5.5,
      maxRadiusMm: 23,
      minDiameterMm: 12,
      maxDiameterMm: 38,
    });

    expect(seg).not.toBeNull();
    const radii = seg!.contourPoints.map((p) => Math.hypot(p.x - center.x, p.y - center.y));
    const meanRadius = radii.reduce((sum, r) => sum + r, 0) / radii.length;
    expect(meanRadius).toBeGreaterThan(14.5);
    expect(meanRadius).toBeLessThan(17.5);
  });

  it('suppresses narrow outer bright lobes that are not part of the annulus ring', () => {
    const center = { x: 60, y: 60, z: 5 };
    const vol = makeVolume([120, 120, 10], (i, j) => {
      const dx = i - center.x;
      const dy = j - center.y;
      const r = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      const appendageAngle = Math.PI / 4;
      const delta = Math.abs(Math.atan2(Math.sin(angle - appendageAngle), Math.cos(angle - appendageAngle)));

      if (r >= 10 && r <= 16) return 300;
      if (delta < 0.13 && r > 16 && r <= 22) return 290; // narrow external bright lobe
      if (r < 10) return 85;
      return -60;
    });

    const seg = autoTraceAnnulusContrastEdgeAtPlane(vol, center, NZ, VY, {
      radialCount: 128,
      radialStepMm: 0.25,
      minRadiusMm: 5.5,
      maxRadiusMm: 23,
      minDiameterMm: 12,
      maxDiameterMm: 38,
    });

    expect(seg).not.toBeNull();
    const radii = seg!.contourPoints.map((p) => Math.hypot(p.x - center.x, p.y - center.y));
    expect(Math.max(...radii)).toBeLessThan(18.5);
  });
});
