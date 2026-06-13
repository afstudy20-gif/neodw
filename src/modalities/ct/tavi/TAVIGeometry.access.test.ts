import { describe, it, expect } from 'vitest';
import { TAVIGeometry } from './TAVIGeometry';
import type { TAVIVector3D } from './TAVITypes';

const P = (x: number, y: number, z = 0): TAVIVector3D => ({ x, y, z });

describe('TAVIGeometry.tortuosityIndex', () => {
  it('is 1.0 for a straight collinear path', () => {
    expect(TAVIGeometry.tortuosityIndex([P(0, 0), P(10, 0), P(20, 0)])).toBeCloseTo(1, 6);
  });
  it('exceeds 1 for a right-angle path (L=20, C=√200)', () => {
    expect(TAVIGeometry.tortuosityIndex([P(0, 0), P(0, 10), P(10, 10)])).toBeCloseTo(20 / Math.sqrt(200), 4);
  });
  it('is 1.0 for a degenerate (zero-chord) path', () => {
    expect(TAVIGeometry.tortuosityIndex([P(0, 0), P(5, 0), P(0, 0)])).toBe(1);
  });
  it('is 1.0 for empty / single-point input', () => {
    expect(TAVIGeometry.tortuosityIndex([])).toBe(1);
    expect(TAVIGeometry.tortuosityIndex([P(1, 2, 3)])).toBe(1);
  });
});

describe('TAVIGeometry.cumulativeAngulationDeg', () => {
  it('is 0° for a straight path', () => {
    expect(TAVIGeometry.cumulativeAngulationDeg([P(0, 0), P(10, 0), P(20, 0)])).toBeCloseTo(0, 4);
  });
  it('measures a single 90° bend', () => {
    expect(TAVIGeometry.cumulativeAngulationDeg([P(0, 0), P(10, 0), P(10, 10)])).toBeCloseTo(90, 3);
  });
  it('sums two 45° bends to ~90°', () => {
    // dir0 = +x; turn 45° up; turn 45° more up → total 90°
    const path = [P(0, 0), P(10, 0), P(20, 10), P(20, 30)];
    expect(TAVIGeometry.cumulativeAngulationDeg(path)).toBeCloseTo(90, 1);
  });
  it('is 0° for fewer than 3 points', () => {
    expect(TAVIGeometry.cumulativeAngulationDeg([P(0, 0), P(1, 1)])).toBe(0);
  });
});

describe('TAVIGeometry.resamplePathByArcLength', () => {
  it('emits evenly spaced samples on a straight path', () => {
    const out = TAVIGeometry.resamplePathByArcLength([P(0, 0), P(20, 0)], 5);
    // arc 0,5,10,15 then the endpoint at 20
    expect(out.map((s) => Math.round(s.arcLengthMm))).toEqual([0, 5, 10, 15, 20]);
    expect(out[0].point.x).toBeCloseTo(0, 6);
    expect(out[out.length - 1].point.x).toBeCloseTo(20, 6);
    for (const s of out) {
      expect(Math.hypot(s.tangent.x, s.tangent.y, s.tangent.z)).toBeCloseTo(1, 6);
      expect(s.tangent.x).toBeCloseTo(1, 6);
    }
  });
  it('averages the segment directions at a bend vertex', () => {
    // L-bend at (10,0): incoming +x, outgoing +y → averaged ≈ (0.707,0.707)
    const out = TAVIGeometry.resamplePathByArcLength([P(0, 0), P(10, 0), P(10, 10)], 10);
    const atVertex = out.find((s) => Math.abs(s.arcLengthMm - 10) < 1e-3);
    expect(atVertex).toBeDefined();
    expect(atVertex!.tangent.x).toBeCloseTo(Math.SQRT1_2, 3);
    expect(atVertex!.tangent.y).toBeCloseTo(Math.SQRT1_2, 3);
  });
  it('arc length is monotonically increasing', () => {
    const out = TAVIGeometry.resamplePathByArcLength([P(0, 0), P(6, 0), P(6, 8)], 3);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].arcLengthMm).toBeGreaterThan(out[i - 1].arcLengthMm);
    }
  });
});
