import { describe, it, expect } from 'vitest';
import {
  SURGICAL_BIOPROSTHESES,
  resolveSurgicalBioprosthesis,
  recommendVivValveSizes,
  assessBvf,
} from './VivProsthesisDatabase';

const TAVI_FAMILIES = [
  { name: 'Sapien 3', type: 'balloon-expandable' as const, sizes: [20, 23, 26, 29] },
  { name: 'Evolut FX', type: 'self-expanding' as const, sizes: [23, 26, 29, 34] },
];

describe('SURGICAL_BIOPROSTHESES', () => {
  it('contains the common platforms', () => {
    const names = SURGICAL_BIOPROSTHESES.map((b) => b.name);
    expect(names.some((n) => /Perimount/.test(n))).toBe(true);
    expect(names.some((n) => /Mosaic/.test(n))).toBe(true);
    expect(names.some((n) => /Trifecta/.test(n))).toBe(true);
    expect(names.some((n) => /Mitroflow/.test(n))).toBe(true);
  });

  it('true inner diameters are smaller than label sizes', () => {
    for (const bp of SURGICAL_BIOPROSTHESES) {
      for (const [label, id] of Object.entries(bp.trueInnerDiameterMm)) {
        expect(id).toBeLessThan(Number(label));
      }
    }
  });
});

describe('resolveSurgicalBioprosthesis', () => {
  it('finds a known prosthesis by name', () => {
    const bp = resolveSurgicalBioprosthesis('Carpentier-Edwards Perimount Magna Ease');
    expect(bp).toBeDefined();
    expect(bp!.trueInnerDiameterMm[23]).toBe(21);
  });

  it('returns undefined for an unknown name', () => {
    expect(resolveSurgicalBioprosthesis('Nonexistent Valve')).toBeUndefined();
  });
});

describe('recommendVivValveSizes', () => {
  it('classifies an ideal fit', () => {
    // Surgical ID 23mm: Sapien 23 → cover 0% (fits). The sort picks the size
    // nearest the ideal ~2.5% cover, which for ID 23 is the 23mm Sapien.
    const recs = recommendVivValveSizes(23, [{ name: 'Sapien 3', type: 'balloon-expandable', sizes: [20, 23, 26, 29] }]);
    const sapien = recs.find((r) => r.familyName === 'Sapien 3')!;
    expect(sapien.sizeMm).toBe(23);
    expect(sapien.coverIndexPct).toBeCloseTo(0, 0);
    expect(sapien.fitStatus).toBe('fits');
  });

  it('flags undersizing (easy) when the TAVI is smaller than the ID', () => {
    const recs = recommendVivValveSizes(28, TAVI_FAMILIES);
    // ID 28: closest Sapien is 29 → cover = +3.6% (fits). To force "easy" use ID 30.
    const easy = recommendVivValveSizes(30, [{ name: 'Sapien 3', type: 'balloon-expandable', sizes: [20, 23, 26, 29] }]);
    const sapien = easy.find((r) => r.familyName === 'Sapien 3')!;
    expect(sapien.fitStatus).toBe('easy');
    expect(sapien.coverIndexPct).toBeLessThan(0);
  });

  it('flags excessive oversizing (no) when the TAVI is much larger', () => {
    const recs = recommendVivValveSizes(18, TAVI_FAMILIES);
    const worst = recs.filter((r) => r.fitStatus === 'no');
    expect(worst.length).toBeGreaterThan(0);
    expect(worst[0].coverIndexPct).toBeGreaterThan(10);
  });

  it('results are sorted by closeness to ideal cover index', () => {
    const recs = recommendVivValveSizes(22, TAVI_FAMILIES);
    for (let i = 1; i < recs.length; i++) {
      const prev = Math.abs(recs[i - 1].coverIndexPct - 2.5);
      const cur = Math.abs(recs[i].coverIndexPct - 2.5);
      expect(prev).toBeLessThanOrEqual(cur);
    }
  });

  it('every family produces exactly one recommendation', () => {
    const recs = recommendVivValveSizes(21, TAVI_FAMILIES);
    expect(recs).toHaveLength(2);
    expect(recs.map((r) => r.familyName).sort()).toEqual(['Evolut FX', 'Sapien 3']);
  });
});

describe('assessBvf', () => {
  it('reports feasibility for BVF-capable platforms', () => {
    const bp = resolveSurgicalBioprosthesis('Carpentier-Edwards Perimount Magna Ease')!;
    const res = assessBvf(bp, 23);
    expect(res.feasible).toBe(true);
    expect(res.estimatedIdGainMm).toBeGreaterThan(0);
  });

  it('reports infeasibility for non-BVF platforms', () => {
    const bp = resolveSurgicalBioprosthesis('Medtronic Hancock II')!;
    const res = assessBvf(bp, 23);
    expect(res.feasible).toBe(false);
    expect(res.estimatedIdGainMm).toBe(0);
  });
});
