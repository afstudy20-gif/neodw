import { describe, it, expect } from 'vitest';
import { assessSheathFit, SFAR_THRESHOLD } from './TAVIValveDatabase';
import { TAVIMeasurementSession } from './TAVIMeasurementSession';
import type { AccessVesselId, AccessVesselResult } from './TAVITypes';

describe('assessSheathFit', () => {
  it('is feasible with comfortable margin (lumen 8, sheath 6)', () => {
    const r = assessSheathFit(8, 6, false);
    expect(r.feasibility).toBe('feasible');
    expect(r.marginMm).toBeCloseTo(2, 6);
    expect(r.sfar).toBeCloseTo(0.75, 4);
  });
  it('is borderline when margin < 1mm but SFAR ≤ 1.05 (lumen 6.5, sheath 6)', () => {
    const r = assessSheathFit(6.5, 6, false);
    expect(r.feasibility).toBe('borderline');
    expect(r.marginMm).toBeCloseTo(0.5, 6);
  });
  it('is unfavorable when SFAR > 1.05 (lumen 5.5, sheath 6)', () => {
    const r = assessSheathFit(5.5, 6, false);
    expect(r.feasibility).toBe('unfavorable');
    expect(r.sfar).toBeGreaterThan(SFAR_THRESHOLD);
  });
  it('escalates borderline → unfavorable when calcified and SFAR > 1.0 (lumen 5.9, sheath 6)', () => {
    const noCalc = assessSheathFit(5.9, 6, false);
    // 6/5.9 = 1.017 → >1.0 but ≤1.05 → borderline without calcification
    expect(noCalc.feasibility).toBe('borderline');
    const withCalc = assessSheathFit(5.9, 6, true);
    expect(withCalc.feasibility).toBe('unfavorable');
  });
  it('treats SFAR exactly at the 1.05 threshold as not-unfavorable', () => {
    // sheath/lumen = 1.05 → lumen = sheath/1.05
    const sheath = 6.3;
    const r = assessSheathFit(sheath / SFAR_THRESHOLD, sheath, false);
    expect(r.sfar).toBeCloseTo(SFAR_THRESHOLD, 6);
    expect(r.feasibility).not.toBe('unfavorable');
  });
});

describe('TAVIMeasurementSession.iliofemoralMinLumenMm', () => {
  function vessel(id: AccessVesselId, minLumen: number): AccessVesselResult {
    return {
      vesselId: id, pathPoints: [], sections: [],
      chordLengthMm: 0, pathLengthMm: 0, tortuosityIndex: 1,
      cumulativeAngulationDeg: 0, minLumenDiameterMm: minLumen, minLumenAtArcLengthMm: 0,
    };
  }

  it('returns null when no vessels are measured', () => {
    expect(new TAVIMeasurementSession().iliofemoralMinLumenMm()).toBeNull();
  });

  it('returns the minimum lumen across all measured vessels', () => {
    const s = new TAVIMeasurementSession();
    s.captureAccessVessel(vessel('iliac-left', 7.2));
    s.captureAccessVessel(vessel('iliac-right', 6.1));
    s.captureAccessVessel(vessel('abdominal-aorta', 18));
    expect(s.iliofemoralMinLumenMm()).toBeCloseTo(6.1, 6);
  });

  it('clears access vessels on clearAccessVessel and reset', () => {
    const s = new TAVIMeasurementSession();
    s.captureAccessVessel(vessel('iliac-left', 7));
    s.clearAccessVessel('iliac-left');
    expect(s.accessVessels.size).toBe(0);
    s.captureAccessVessel(vessel('iliac-right', 6));
    s.reset();
    expect(s.accessVessels.size).toBe(0);
    expect(s.iliofemoralMinLumenMm()).toBeNull();
  });

  it('emits access-vessel rows in the CSV report', () => {
    const s = new TAVIMeasurementSession();
    s.captureAccessVessel(vessel('iliac-right', 6.4));
    expect(s.csvReport()).toMatch(/Iliac R Min Lumen/);
  });
});
