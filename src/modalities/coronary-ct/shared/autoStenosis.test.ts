import { describe, it, expect } from 'vitest';
import { autoDetectStenosis, type DiameterSample } from './autoStenosis';

// Build an evenly-spaced 1 mm profile from a list of diameters.
function profile(diameters: number[], stepMm = 1): DiameterSample[] {
  return diameters.map((d, i) => ({ distanceMm: i * stepMm, diameterMm: d }));
}

describe('autoDetectStenosis', () => {
  it('returns null for fewer than 5 samples', () => {
    expect(autoDetectStenosis(profile([3, 3, 3, 3]))).toBeNull();
  });

  it('returns null for a healthy uniform vessel (no stenosis)', () => {
    expect(autoDetectStenosis(profile([3, 3, 3, 3, 3, 3, 3, 3]))).toBeNull();
  });

  it('detects a clear focal stenosis and computes %DS from the reference', () => {
    // Reference ~4 mm; MLD 2 mm → ~50% diameter stenosis.
    const samples = profile([4, 4, 4, 3, 2, 3, 4, 4, 4, 4]);
    const finding = autoDetectStenosis(samples);
    expect(finding).not.toBeNull();
    expect(finding!.mldDiameterMm).toBe(2);
    expect(finding!.referenceDiameterMm).toBeGreaterThanOrEqual(4);
    expect(finding!.diameterStenosisPercent).toBeCloseTo(50, 0);
    // MLD sits at index 4 → distance 4 mm.
    expect(finding!.mldMm).toBe(4);
    // Lesion bounds bracket the MLD.
    expect(finding!.proximalMm).toBeLessThan(finding!.mldMm);
    expect(finding!.distalMm).toBeGreaterThan(finding!.mldMm);
  });

  it('rejects a shallow narrowing below the minimum %DS threshold', () => {
    // ~10% narrowing — under the default 20% floor.
    const samples = profile([4, 4, 4, 3.6, 3.6, 4, 4, 4]);
    expect(autoDetectStenosis(samples)).toBeNull();
  });

  it('honors an explicit minStenosisPercent override', () => {
    const samples = profile([4, 4, 4, 3.6, 3.6, 4, 4, 4]);
    const finding = autoDetectStenosis(samples, { minStenosisPercent: 5 });
    expect(finding).not.toBeNull();
  });

  it('rejects a lesion shorter than the minimum lesion length', () => {
    // A single deep but ultra-short dip with neighbors already recovered.
    const samples = profile([4, 4, 4, 4, 2, 4, 4, 4, 4]);
    const finding = autoDetectStenosis(samples, { minLesionLengthMm: 5 });
    expect(finding).toBeNull();
  });

  it('returns null when all diameters are invalid', () => {
    expect(autoDetectStenosis(profile([0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(autoDetectStenosis(profile([NaN, NaN, NaN, NaN, NaN, NaN]))).toBeNull();
  });
});
