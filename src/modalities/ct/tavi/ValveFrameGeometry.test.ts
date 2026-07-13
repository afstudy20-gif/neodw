import { describe, it, expect } from 'vitest';
import {
  frameProfileFor,
  positionFrame,
  buildFrameMesh,
  buildAnnulusDiscMesh,
} from './ValveFrameGeometry';
import type { TAVIVector3D } from './TAVITypes';

describe('frameProfileFor', () => {
  it('balloon-expandable produces a short uniform cylinder', () => {
    const p = frameProfileFor('Sapien 3', false, 26);
    expect(p.rings).toHaveLength(2);
    // Uniform radius (cylinder), equal to nominal label / 2.
    expect(p.rings[0].radiusMm).toBeCloseTo(13, 6);
    expect(p.rings[1].radiusMm).toBeCloseTo(13, 6);
    // Heights span 0 → totalHeight (inflow at annulus, outflow above).
    expect(p.rings[0].heightAboveAnnulusMm).toBeCloseTo(0, 6);
    expect(p.rings[1].heightAboveAnnulusMm).toBeCloseTo(p.totalHeightMm, 6);
    // A 26mm Sapien frame is short (~15mm).
    expect(p.totalHeightMm).toBeLessThan(20);
    expect(p.hasSkirt).toBe(false);
  });

  it('Sapien 3 Ultra carries a skirt', () => {
    const p = frameProfileFor('Sapien 3 Ultra', false, 23);
    expect(p.hasSkirt).toBe(true);
  });

  it('self-expanding produces a long flared frame with more rings', () => {
    const p = frameProfileFor('Evolut FX', true, 26);
    expect(p.rings.length).toBeGreaterThanOrEqual(4);
    // Outflow flares wider than the inflow.
    const inflow = p.rings[0].radiusMm;
    const outflow = p.rings[p.rings.length - 1].radiusMm;
    expect(outflow).toBeGreaterThan(inflow);
    // Self-expanding frames are long.
    expect(p.totalHeightMm).toBeGreaterThan(25);
    expect(p.hasSkirt).toBe(true);
  });

  it('Evolut 34 uses the larger height + flare', () => {
    const p34 = frameProfileFor('Evolut PRO+', true, 34);
    const p26 = frameProfileFor('Evolut PRO+', true, 26);
    expect(p34.totalHeightMm).toBeGreaterThanOrEqual(p26.totalHeightMm);
    const flare34 = p34.rings[p34.rings.length - 1].radiusMm - p34.rings[0].radiusMm;
    expect(flare34).toBeGreaterThan(0);
  });
});

describe('positionFrame', () => {
  it('places the inflow at -implantDepthMm minus the ratio cross-offset', () => {
    const profile = frameProfileFor('Sapien 3', false, 26);
    const rings = positionFrame(profile, 5, '80/20');
    // Inflow = ring[0].height(0) − annularCross − implantDepth
    // annularCross = totalHeight * subFraction = 16.3 * 0.2 = 3.26
    const annularCross = profile.totalHeightMm * 0.2;
    expect(rings[0].heightAboveAnnulusMm).toBeCloseTo(-annularCross - 5, 6);
  });

  it('inflow deepens linearly with implant depth', () => {
    const profile = frameProfileFor('Sapien 3', false, 26);
    const r0 = positionFrame(profile, 0, '80/20');
    const r10 = positionFrame(profile, 10, '80/20');
    expect(r10[0].heightAboveAnnulusMm - r0[0].heightAboveAnnulusMm).toBeCloseTo(-10, 6);
  });

  it('deeper implant shifts every ring further sub-annular', () => {
    const profile = frameProfileFor('Evolut FX', true, 29);
    const shallow = positionFrame(profile, 2, '80/20');
    const deep = positionFrame(profile, 8, '80/20');
    // Each corresponding ring is 6mm lower for the deep placement.
    for (let i = 0; i < shallow.length; i++) {
      expect(deep[i].heightAboveAnnulusMm - shallow[i].heightAboveAnnulusMm).toBeCloseTo(-6, 6);
    }
  });

  it('90/10 keeps more of the frame supra-annular than 80/20', () => {
    const profile = frameProfileFor('Evolut FX', true, 29);
    const r80 = positionFrame(profile, 5, '80/20');
    const r90 = positionFrame(profile, 5, '90/10');
    // The outflow ring sits higher (more supra-annular) for 90/10.
    const out80 = r80[r80.length - 1].heightAboveAnnulusMm;
    const out90 = r90[r90.length - 1].heightAboveAnnulusMm;
    expect(out90).toBeGreaterThan(out80);
  });

  it('does not mutate the input profile', () => {
    const profile = frameProfileFor('Sapien 3', false, 23);
    const before = profile.rings[0].heightAboveAnnulusMm;
    positionFrame(profile, 7, '80/20');
    expect(profile.rings[0].heightAboveAnnulusMm).toBe(before);
  });
});

describe('buildFrameMesh', () => {
  const basis = {
    origin: { x: 100, y: 100, z: 50 } as TAVIVector3D,
    axis: { x: 0, y: 0, z: 1 } as TAVIVector3D,
    localX: { x: 1, y: 0, z: 0 } as TAVIVector3D,
    localY: { x: 0, y: 1, z: 0 } as TAVIVector3D,
  };

  it('emits valid triangle positions + normals', () => {
    const profile = frameProfileFor('Sapien 3', false, 26);
    const rings = positionFrame(profile, 0, '80/20');
    const mesh = buildFrameMesh(rings, basis, 16);
    expect(mesh.triangleCount).toBeGreaterThan(0);
    expect(mesh.positions.length).toBe(mesh.triangleCount * 9);
    expect(mesh.normals.length).toBe(mesh.triangleCount * 9);
  });

  it('positions are in world coordinates around the annulus origin', () => {
    const profile = frameProfileFor('Sapien 3', false, 26);
    const rings = positionFrame(profile, 0, '80/20');
    const mesh = buildFrameMesh(rings, basis, 8);
    // First vertex lies on the inflow ring centred at the origin; its radius is
    // nominal/2 = 13mm, so it sits ~13mm off the origin in the XY plane.
    const x = mesh.positions[0] - basis.origin.x;
    const y = mesh.positions[1] - basis.origin.y;
    expect(Math.hypot(x, y)).toBeCloseTo(13, 1);
  });

  it('clamps radial segments to a minimum of 3', () => {
    const profile = frameProfileFor('Sapien 3', false, 26);
    const rings = positionFrame(profile, 0, '80/20');
    const mesh = buildFrameMesh(rings, basis, 0);
    expect(mesh.triangleCount).toBeGreaterThan(0);
  });
});

describe('buildAnnulusDiscMesh', () => {
  it('returns an empty mesh for fewer than 3 contour points', () => {
    const mesh = buildAnnulusDiscMesh([
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
    ]);
    expect(mesh.triangleCount).toBe(0);
  });

  it('builds a triangle fan for a closed contour', () => {
    const contour: TAVIVector3D[] = [
      { x: 10, y: 0, z: 0 },
      { x: 0, y: 10, z: 0 },
      { x: -10, y: 0, z: 0 },
      { x: 0, y: -10, z: 0 },
    ];
    const mesh = buildAnnulusDiscMesh(contour);
    expect(mesh.triangleCount).toBe(4); // n triangles for n contour points
    expect(mesh.positions.length).toBe(4 * 9);
  });
});
