import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { solveVesselFFR } from './ffrSolver';
import type { FFRArcSample } from './ffrTypes';

// Build a sample with matching diameter/area so callers only specify the
// hemodynamically relevant fields (distance + area + reference area).
function sample(distanceMm: number, areaMm2: number, referenceAreaMm2: number): FFRArcSample {
  const diameterMm = Math.sqrt((4 * areaMm2) / Math.PI);
  const referenceDiameterMm = Math.sqrt((4 * referenceAreaMm2) / Math.PI);
  return { distanceMm, areaMm2, diameterMm, referenceDiameterMm, referenceAreaMm2 };
}

function uniformVessel(areaMm2: number, refMm2: number, n = 11, stepMm = 5): FFRArcSample[] {
  return Array.from({ length: n }, (_, i) => sample(i * stepMm, areaMm2, refMm2));
}

const FLOW_ML_S = 1.5;
const PA_MMHG = 100;

beforeEach(() => {
  // Solver warns when physiology clamps engage; silence to keep test output clean.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('solveVesselFFR', () => {
  it('returns a trivial result for an empty sample list', () => {
    const r = solveVesselFFR('v1', 'LAD', [], FLOW_ML_S, PA_MMHG);
    expect(r.distalFFR).toBe(1.0);
    expect(r.isIschemic).toBe(false);
    expect(r.pullback).toHaveLength(1);
  });

  it('starts the pullback at the ostium with FFR = 1.0', () => {
    const r = solveVesselFFR('v1', 'LAD', uniformVessel(7, 7), FLOW_ML_S, PA_MMHG);
    expect(r.pullback[0].ffr).toBe(1.0);
    expect(r.pullback[0].pressureMmHg).toBeCloseTo(PA_MMHG, 0);
  });

  it('a healthy vessel stays non-ischemic with FFR near 1', () => {
    const r = solveVesselFFR('v1', 'LAD', uniformVessel(7, 7), FLOW_ML_S, PA_MMHG);
    expect(r.distalFFR).toBeGreaterThan(0.8);
    expect(r.distalFFR).toBeLessThanOrEqual(1.0);
    expect(r.isIschemic).toBe(false);
  });

  it('FFR is monotonically non-increasing along the pullback', () => {
    const r = solveVesselFFR('v1', 'LAD', uniformVessel(7, 7), FLOW_ML_S, PA_MMHG);
    for (let i = 1; i < r.pullback.length; i += 1) {
      expect(r.pullback[i].ffr).toBeLessThanOrEqual(r.pullback[i - 1].ffr + 1e-9);
    }
  });

  it('a tight focal stenosis drops FFR below the healthy case', () => {
    const healthy = solveVesselFFR('v1', 'LAD', uniformVessel(7, 7), FLOW_ML_S, PA_MMHG);
    // Same vessel but a tight throat (0.8 mm^2) at the midpoint vs 7 mm^2 reference.
    const diseased = uniformVessel(7, 7).map((s, i) =>
      i >= 4 && i <= 6 ? sample(s.distanceMm, 0.8, 7) : s
    );
    const r = solveVesselFFR('v1', 'LAD', diseased, FLOW_ML_S, PA_MMHG);
    expect(r.distalFFR).toBeLessThan(healthy.distalFFR);
    expect(r.maxDeltaFFR).toBeGreaterThan(healthy.maxDeltaFFR);
  });

  it('never reports a distal pressure below the ~20 mmHg physiology floor', () => {
    // Extreme tandem stenosis would push pressure negative without the floor.
    const severe = uniformVessel(0.3, 9);
    const r = solveVesselFFR('v1', 'LAD', severe, FLOW_ML_S, PA_MMHG);
    for (const p of r.pullback) {
      expect(p.pressureMmHg).toBeGreaterThanOrEqual(19.9);
    }
  });

  it('does not crash on zero-length segments (duplicate distances)', () => {
    const samples = [sample(0, 7, 7), sample(0, 7, 7), sample(5, 7, 7)];
    const r = solveVesselFFR('v1', 'LAD', samples, FLOW_ML_S, PA_MMHG);
    expect(r.pullback).toHaveLength(3);
    expect(Number.isFinite(r.distalFFR)).toBe(true);
  });
});
