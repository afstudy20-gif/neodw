import { describe, it, expect } from 'vitest';
import { TAVIGeometry } from './TAVIGeometry';
import type { TAVIVector3D, TAVIFluoroAngleResult } from './TAVITypes';

const D2R = Math.PI / 180;

/** Beam model shared with the perpendicularity math (LPS). */
function beamFor(alphaDeg: number, betaDeg: number): TAVIVector3D {
  const a = alphaDeg * D2R;
  const b = betaDeg * D2R;
  return { x: Math.sin(a) * Math.cos(b), y: -Math.cos(a) * Math.cos(b), z: Math.sin(b) };
}

function signedLaoRao(r: TAVIFluoroAngleResult): number {
  return r.laoRaoLabel === 'LAO' ? r.laoRaoDegrees : -r.laoRaoDegrees;
}
function signedCranCaud(r: TAVIFluoroAngleResult): number {
  return r.cranialCaudalLabel === 'CRANIAL' ? r.cranialCaudalDegrees : -r.cranialCaudalDegrees;
}

describe('TAVIGeometry.fluoroAngleForBeamDirection', () => {
  it('recovers a LAO/CRANIAL beam', () => {
    const r = TAVIGeometry.fluoroAngleForBeamDirection(beamFor(20, 15));
    expect(r.laoRaoLabel).toBe('LAO');
    expect(r.cranialCaudalLabel).toBe('CRANIAL');
    expect(r.laoRaoDegrees).toBeCloseTo(20, 4);
    expect(r.cranialCaudalDegrees).toBeCloseTo(15, 4);
  });

  it('recovers a RAO/CAUDAL beam', () => {
    const r = TAVIGeometry.fluoroAngleForBeamDirection(beamFor(-30, -10));
    expect(r.laoRaoLabel).toBe('RAO');
    expect(r.cranialCaudalLabel).toBe('CAUDAL');
    expect(r.laoRaoDegrees).toBeCloseTo(30, 4);
    expect(r.cranialCaudalDegrees).toBeCloseTo(10, 4);
  });

  it('is direction-agnostic: the antiparallel beam gives the same projection', () => {
    const b = beamFor(-25, 12);
    const forward = TAVIGeometry.fluoroAngleForBeamDirection(b);
    const reversed = TAVIGeometry.fluoroAngleForBeamDirection({ x: -b.x, y: -b.y, z: -b.z });
    expect(signedLaoRao(reversed)).toBeCloseTo(signedLaoRao(forward), 4);
    expect(signedCranCaud(reversed)).toBeCloseTo(signedCranCaud(forward), 4);
  });
});

describe('TAVIGeometry.computeCuspOverlapViews', () => {
  // Tilted annulus plane with three nadirs spaced 120° on a 12 mm ring.
  const normal = TAVIGeometry.vectorNormalize({ x: 0.18, y: -0.32, z: 0.93 });
  const centroid: TAVIVector3D = { x: 5, y: 10, z: 40 };
  const basis = TAVIGeometry.planeBasisMake(normal);
  const nadir = (deg: number): TAVIVector3D => {
    const t = deg * D2R;
    const u = TAVIGeometry.vectorScale(basis.basisU, 12 * Math.cos(t));
    const v = TAVIGeometry.vectorScale(basis.basisV, 12 * Math.sin(t));
    return TAVIGeometry.vectorAdd(centroid, TAVIGeometry.vectorAdd(u, v));
  };
  const RCC = nadir(0);
  const LCC = nadir(120);
  const NCC = nadir(240);

  const views = TAVIGeometry.computeCuspOverlapViews(normal, LCC, NCC, RCC);

  it('returns all three pairwise overlap views', () => {
    expect(views).not.toBeNull();
    expect(views!.rlOverlap.isolatedCusp).toBe('N');
    expect(views!.rnOverlap.isolatedCusp).toBe('L');
    expect(views!.lnOverlap.isolatedCusp).toBe('R');
  });

  it('places every overlap view ON the line of perpendicularity (beam ⊥ annulus normal)', () => {
    for (const v of [views!.rlOverlap, views!.rnOverlap, views!.lnOverlap]) {
      const dot = TAVIGeometry.vectorDot(v.angle.planeNormal, normal);
      expect(Math.abs(dot)).toBeLessThan(1e-6);
    }
  });

  it('overlap cran/caud matches the perpendicularity formula at its lao/rao', () => {
    for (const v of [views!.rlOverlap, views!.rnOverlap, views!.lnOverlap]) {
      const alpha = signedLaoRao(v.angle) * D2R;
      const horiz = Math.sin(alpha) * normal.x - Math.cos(alpha) * normal.y;
      const expectedCranCaud = (Math.atan2(-horiz, normal.z) * 180) / Math.PI;
      expect(signedCranCaud(v.angle)).toBeCloseTo(expectedCranCaud, 3);
    }
  });

  it('keeps every view inside the physical C-arm half-space (|LAO/RAO| ≤ 90°)', () => {
    for (const v of [views!.rlOverlap, views!.rnOverlap, views!.lnOverlap]) {
      expect(v.angle.laoRaoDegrees).toBeLessThanOrEqual(90);
    }
  });

  it('returns null when the annulus normal is degenerate', () => {
    expect(TAVIGeometry.computeCuspOverlapViews({ x: 0, y: 0, z: 0 }, LCC, NCC, RCC)).toBeNull();
  });
});
