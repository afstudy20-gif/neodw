import { describe, it, expect } from 'vitest';
import { TAVIMeasurementSession, TAVIStructureSTJ } from './TAVIMeasurementSession';
import { TAVIGeometry } from './TAVIGeometry';
import type { TAVIContourSnapshot } from './TAVITypes';

// A planar STJ contour (z = 10 plane) so its centroid/normal drive sinus height.
function stjAtZ(z: number): TAVIContourSnapshot {
  return {
    worldPoints: [
      { x: -12, y: 0, z }, { x: 0, y: -12, z }, { x: 12, y: 0, z }, { x: 0, y: 12, z },
    ],
    pixelPoints: [],
    planeOrigin: { x: 0, y: 0, z },
    planeNormal: { x: 0, y: 0, z: 1 },
  };
}

describe('TAVIGeometry.sinusHeightToPlane', () => {
  it('measures perpendicular distance along the +z normal', () => {
    const h = TAVIGeometry.sinusHeightToPlane({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 1 });
    expect(h).toBeCloseTo(10, 6);
  });
  it('returns an absolute value regardless of side', () => {
    const above = TAVIGeometry.sinusHeightToPlane({ x: 0, y: 0, z: 25 }, { x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 1 });
    expect(above).toBeCloseTo(15, 6);
  });
  it('projects onto an oblique normal', () => {
    const n = { x: 1, y: 0, z: 1 }; // normalized inside
    const h = TAVIGeometry.sinusHeightToPlane({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, n);
    // (floor-origin)=(-2,0,0); dot with n̂=(.707,0,.707) = -1.414; abs
    expect(h).toBeCloseTo(Math.SQRT2, 4);
  });
});

describe('TAVIMeasurementSession per-sinus diameters', () => {
  it('computes a diameter from two world points (3-4-5 → 5mm)', () => {
    const s = new TAVIMeasurementSession();
    s.captureSinusDiameter('LCS', { x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 });
    expect(s.sinusDiameters.LCS?.diameterMm).toBeCloseTo(5, 6);
    expect(s.sinusDiameters.LCS?.heightMm).toBeUndefined(); // no STJ/floor yet
  });

  it('captures sinuses independently', () => {
    const s = new TAVIMeasurementSession();
    s.captureSinusDiameter('RCS', { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
    expect(s.sinusDiameters.RCS?.diameterMm).toBeCloseTo(10, 6);
    expect(s.sinusDiameters.LCS).toBeUndefined();
    expect(s.sinusDiameters.NCS).toBeUndefined();
  });

  it('derives sinus height once STJ geometry and a floor point exist', () => {
    const s = new TAVIMeasurementSession();
    s.captureContourSnapshot(stjAtZ(10), TAVIStructureSTJ);
    s.captureSinusDiameter('NCS', { x: -5, y: 0, z: 2 }, { x: 5, y: 0, z: 2 });
    s.captureSinusFloor('NCS', { x: 0, y: 0, z: 2 }); // 8mm below the z=10 STJ plane
    expect(s.sinusDiameters.NCS?.heightMm).toBeCloseTo(8, 4);
  });

  it('clears one sinus without touching the others', () => {
    const s = new TAVIMeasurementSession();
    s.captureSinusDiameter('LCS', { x: 0, y: 0, z: 0 }, { x: 6, y: 0, z: 0 });
    s.captureSinusDiameter('RCS', { x: 0, y: 0, z: 0 }, { x: 7, y: 0, z: 0 });
    s.clearSinusDiameter('LCS');
    expect(s.sinusDiameters.LCS).toBeUndefined();
    expect(s.sinusDiameters.RCS?.diameterMm).toBeCloseTo(7, 6);
  });

  it('reset() empties all sinus maps', () => {
    const s = new TAVIMeasurementSession();
    s.captureSinusDiameter('LCS', { x: 0, y: 0, z: 0 }, { x: 6, y: 0, z: 0 });
    s.captureSinusFloor('LCS', { x: 0, y: 0, z: 0 });
    s.reset();
    expect(Object.keys(s.sinusDiameters)).toHaveLength(0);
    expect(Object.keys(s.sinusDiameterPoints)).toHaveLength(0);
    expect(Object.keys(s.sinusFloorPoints)).toHaveLength(0);
  });

  it('emits per-sinus lines in text and CSV reports', () => {
    const s = new TAVIMeasurementSession();
    s.captureSinusDiameter('LCS', { x: 0, y: 0, z: 0 }, { x: 30, y: 0, z: 0 });
    expect(s.textReport()).toMatch(/Sinus LCS:/);
    expect(s.csvReport()).toMatch(/Sinus LCS Diameter/);
  });
});
