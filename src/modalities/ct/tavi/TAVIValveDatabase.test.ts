import { describe, it, expect } from 'vitest';
import {
  VALVE_FAMILIES,
  recommendValveSizes,
  assessBAVRisk,
  computePacemakerRiskScore,
} from './TAVIValveDatabase';

describe('VALVE_FAMILIES integrity', () => {
  it('contains all 7 expected families with non-empty size lists', () => {
    expect(VALVE_FAMILIES).toHaveLength(7);
    const names = VALVE_FAMILIES.map((f) => f.name).sort();
    expect(names).toEqual(
      ['ACURATE neo2', 'Evolut FX', 'Evolut PRO+', 'Myval', 'Navitor', 'Sapien 3', 'Sapien 3 Ultra'].sort(),
    );
    for (const f of VALVE_FAMILIES) {
      expect(f.sizes.length).toBeGreaterThan(0);
      expect(['balloon-expandable', 'self-expanding']).toContain(f.type);
    }
  });

  it('keeps perimeter-derived diameter consistent with perimeter (d = P/π) for every size', () => {
    for (const f of VALVE_FAMILIES) {
      for (const s of f.sizes) {
        expect(Math.abs(s.perimeterDiameterMin - s.perimeterMin / Math.PI)).toBeLessThan(0.15);
        expect(Math.abs(s.perimeterDiameterMax - s.perimeterMax / Math.PI)).toBeLessThan(0.15);
        expect(s.perimeterDiameterMax).toBeGreaterThan(s.perimeterDiameterMin);
        expect(s.areaMax).toBeGreaterThan(s.areaMin);
      }
    }
  });
});

describe('recommendValveSizes', () => {
  it('picks the in-range size for a mid-range annulus (Sapien 3 26mm)', () => {
    // perimeter 78mm → d ≈ 24.8mm, inside Sapien 3 26mm range (23.4–26.3)
    const recs = recommendValveSizes(78, 480);
    const s3 = recs.find((r) => r.family.name === 'Sapien 3');
    expect(s3?.fitStatus).toBe('in-range');
    expect(s3?.primarySize?.size).toBe(26);
  });

  it('returns a non-null in-range pick for every family at a typical 72mm perimeter', () => {
    const recs = recommendValveSizes(72, 410); // d ≈ 22.9mm
    expect(recs).toHaveLength(7);
    for (const r of recs) {
      expect(r.primarySize).not.toBeNull();
    }
  });

  it('flags undersized below the smallest family size and oversized above the largest', () => {
    const tiny = recommendValveSizes(40, 130); // d ≈ 12.7mm
    const s3 = tiny.find((r) => r.family.name === 'Sapien 3')!;
    expect(s3.fitStatus).toBe('undersized');
    expect(s3.primarySize?.size).toBe(20);

    const huge = recommendValveSizes(120, 1100); // d ≈ 38mm
    const s3b = huge.find((r) => r.family.name === 'Sapien 3')!;
    expect(s3b.fitStatus).toBe('oversized');
    expect(s3b.primarySize?.size).toBe(29);
  });

  it('reports PERIMETER-based oversizing for self-expanding valves and warns only on excess', () => {
    // Evolut PRO+ 23mm nominal perimeter π·23 ≈ 72.3mm. Annulus perimeter 55mm
    // → perimeter oversizing ≈ 31% (>30%).
    const recs = recommendValveSizes(55, 240); // d ≈ 17.5mm → Evolut PRO+ 23
    const ep = recs.find((r) => r.family.name === 'Evolut PRO+')!;
    expect(ep.primarySize?.size).toBe(23);
    expect(ep.oversizingMetric).toBe('perimeter');
    expect(ep.oversizingPct!).toBeGreaterThan(30);
    expect(ep.sizingWarning).toMatch(/conduction|oversizing/i);
  });

  it('does NOT false-alarm a normally-oversized self-expanding pick (perimeter vs area)', () => {
    // Perimeter 76.2mm, area 459.7mm² → Evolut 29; perimeter oversizing ≈ 20%
    // (the literature target). The old area-based math flagged ~44% — regression guard.
    const recs = recommendValveSizes(76.2, 459.7);
    const ev = recs.find((r) => r.family.name === 'Evolut FX')!;
    expect(ev.primarySize?.size).toBe(29);
    expect(ev.oversizingMetric).toBe('perimeter');
    expect(ev.oversizingPct!).toBeLessThan(25);
    expect(ev.sizingWarning).toBeUndefined();
  });

  it('suggests a self-expanding alternative for an over-oversized balloon-expandable pick', () => {
    // Sapien 3 20mm (nominal area ≈ 314mm²); area 250 → ~26% oversizing (>20%)
    const recs = recommendValveSizes(60, 250);
    const s3 = recs.find((r) => r.family.name === 'Sapien 3')!;
    expect(s3.primarySize?.size).toBe(20);
    expect(s3.sizingWarning).toMatch(/self-expanding alternative/i);
  });

  it('produces a negative cover index (embolization warning) when the annulus exceeds the valve', () => {
    // perimeter 92.3 → d ≈ 29.4mm, just over the Sapien 3 29mm nominal
    const recs = recommendValveSizes(92.3, 690);
    const s3 = recs.find((r) => r.family.name === 'Sapien 3')!;
    expect(s3.primarySize?.size).toBe(29);
    expect(s3.coverIndex!).toBeLessThan(0);
    expect(s3.sizingWarning).toMatch(/embolization|PVL/i);
  });
});

describe('assessBAVRisk', () => {
  it('flags suspected BAV for high eccentricity', () => {
    expect(assessBAVRisk(0.3, 20, 28).isSuspectedBAV).toBe(true);
  });
  it('flags suspected BAV for a high max/min ratio even at low eccentricity', () => {
    expect(assessBAVRisk(0.1, 20, 28).isSuspectedBAV).toBe(true); // ratio 1.4 > 1.3
  });
  it('does not flag a near-circular annulus', () => {
    expect(assessBAVRisk(0.1, 24, 25).isSuspectedBAV).toBe(false);
  });
});

describe('computePacemakerRiskScore', () => {
  it('scores a very short membranous septum highly', () => {
    const r = computePacemakerRiskScore({ membranousSeptumLengthMm: 1.5, isSelfExpanding: true });
    expect(r.score).toBeGreaterThanOrEqual(5); // +4 MS + 1 SE
    expect(r.factors.join(' ')).toMatch(/MS/);
  });
  it('caps the score at 10', () => {
    const r = computePacemakerRiskScore({
      membranousSeptumLengthMm: 1,
      implantDepthMm: 10,
      isSelfExpanding: true,
      hasPreExistingRBBB: true,
    });
    expect(r.score).toBe(10);
  });
  it('returns a low score for favorable anatomy', () => {
    const r = computePacemakerRiskScore({ membranousSeptumLengthMm: 8, isSelfExpanding: false });
    expect(r.score).toBe(0);
  });
});
