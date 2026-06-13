import { describe, it, expect } from 'vitest';
import {
  sphereVolumeFromDiameterMm,
  ellipsoidVolumeMm3,
  mlFromMm3,
  volumeChange,
  doublingTimeDays,
} from './lesionVolume';

describe('sphereVolumeFromDiameterMm', () => {
  it('matches π·d³/6', () => {
    expect(sphereVolumeFromDiameterMm(10)).toBeCloseTo((Math.PI * 1000) / 6, 6);
  });
  it('is 0 for non-positive diameters', () => {
    expect(sphereVolumeFromDiameterMm(0)).toBe(0);
    expect(sphereVolumeFromDiameterMm(-5)).toBe(0);
  });
});

describe('ellipsoidVolumeMm3', () => {
  it('matches π/6·a·b·c with three diameters', () => {
    expect(ellipsoidVolumeMm3(10, 20, 30)).toBeCloseTo((Math.PI / 6) * 6000, 6);
  });
  it('falls back to the smaller diameter for the third axis', () => {
    expect(ellipsoidVolumeMm3(10, 20)).toBeCloseTo((Math.PI / 6) * 10 * 20 * 10, 6);
  });
  it('equals the sphere formula when all diameters are equal', () => {
    expect(ellipsoidVolumeMm3(8, 8, 8)).toBeCloseTo(sphereVolumeFromDiameterMm(8), 6);
  });
});

describe('mlFromMm3', () => {
  it('converts 1000 mm³ to 1 mL', () => {
    expect(mlFromMm3(1000)).toBe(1);
  });
});

describe('volumeChange', () => {
  it('computes delta, percent, and fold for growth', () => {
    const r = volumeChange(100, 150);
    expect(r.deltaMm3).toBe(50);
    expect(r.percentChange).toBeCloseTo(50, 6);
    expect(r.foldChange).toBeCloseTo(1.5, 6);
  });
  it('handles shrinkage (negative percent)', () => {
    const r = volumeChange(200, 150);
    expect(r.percentChange).toBeCloseTo(-25, 6);
  });
  it('returns null ratios when the baseline is 0', () => {
    const r = volumeChange(0, 100);
    expect(r.deltaMm3).toBe(100);
    expect(r.percentChange).toBeNull();
    expect(r.foldChange).toBeNull();
  });
});

describe('doublingTimeDays', () => {
  it('returns the interval when volume exactly doubles', () => {
    expect(doublingTimeDays(100, 200, 90)).toBeCloseTo(90, 6);
  });
  it('scales with the growth ratio', () => {
    // quadrupling over 90 days → doubling time 45 days
    expect(doublingTimeDays(100, 400, 90)).toBeCloseTo(45, 6);
  });
  it('returns null for non-growth or invalid inputs', () => {
    expect(doublingTimeDays(200, 150, 90)).toBeNull(); // shrinking
    expect(doublingTimeDays(100, 100, 90)).toBeNull(); // stable
    expect(doublingTimeDays(0, 100, 90)).toBeNull();
    expect(doublingTimeDays(100, 200, 0)).toBeNull();
  });
});
