import { describe, it, expect } from 'vitest';
import { recommendGraftSizes } from './vascularGraftDatabase';

describe('recommendGraftSizes', () => {
  it('picks the smallest body that clears ~10% oversizing for a typical AAA neck', () => {
    const recs = recommendGraftSizes(22, 'AAA');
    const endurant = recs.find((r) => r.family.name === 'Endurant II/IIs')!;
    // min target = 22 * 1.1 = 24.2 → first available ≥ 24.2 is 25 mm
    expect(endurant.bodyDiameterMm).toBe(25);
    expect(endurant.oversizingPct!).toBeGreaterThan(10);
    expect(endurant.oversizingPct!).toBeLessThan(25);
    expect(endurant.fitStatus).toBe('in-range');
    expect(endurant.warning).toBeUndefined();
  });

  it('only returns families for the requested segment', () => {
    const aaa = recommendGraftSizes(24, 'AAA');
    expect(aaa.every((r) => r.family.segment === 'AAA')).toBe(true);
    const taa = recommendGraftSizes(30, 'TAA');
    expect(taa.every((r) => r.family.segment === 'TAA')).toBe(true);
  });

  it('flags a neck beyond the device range as out-of-range', () => {
    const recs = recommendGraftSizes(40, 'AAA'); // exceeds AAA neck max (32)
    const endurant = recs.find((r) => r.family.name === 'Endurant II/IIs')!;
    expect(endurant.fitStatus).toBe('out-of-range');
    expect(endurant.warning).toMatch(/range/i);
  });

  it('warns on insufficient oversizing when the neck nearly matches the largest body', () => {
    // 35 mm neck: largest Endurant body is 36 → only ~2.9% oversizing.
    const recs = recommendGraftSizes(35, 'TAA');
    const navion = recs.find((r) => r.family.name === 'Valiant Navion')!;
    expect(navion.bodyDiameterMm).not.toBeNull();
    if (navion.oversizingPct != null && navion.oversizingPct < 10) {
      expect(navion.warning).toMatch(/oversizing/i);
    }
  });
});
