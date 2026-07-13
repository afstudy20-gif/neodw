import { describe, expect, it } from 'vitest';
import {
  DRR_HU_AIR,
  huToAttenuation,
  buildAttenuationOpacity,
  buildRadiographColor,
  exposureToDensity,
} from './drr';

describe('huToAttenuation', () => {
  it('is 1.0 at water (0 HU)', () => {
    expect(huToAttenuation(0)).toBeCloseTo(1.0, 6);
  });

  it('follows μ = 1 + HU/1000 above air', () => {
    expect(huToAttenuation(1000)).toBeCloseTo(2.0, 6);
    expect(huToAttenuation(500)).toBeCloseTo(1.5, 6);
    expect(huToAttenuation(-500)).toBeCloseTo(0.5, 6);
  });

  it('clamps air and below to zero attenuation', () => {
    expect(huToAttenuation(DRR_HU_AIR)).toBe(0);
    expect(huToAttenuation(-1000)).toBe(0);
    expect(huToAttenuation(-3024)).toBe(0);
  });

  it('is monotonic increasing across tissue', () => {
    const hus = [-200, 0, 40, 200, 400, 1000, 2000];
    for (let i = 1; i < hus.length; i++) {
      expect(huToAttenuation(hus[i])).toBeGreaterThan(huToAttenuation(hus[i - 1]));
    }
  });
});

describe('buildAttenuationOpacity', () => {
  it('emits a valid VTK piecewise string: count then hu/opacity pairs', () => {
    const str = buildAttenuationOpacity(0.02, [-1000, 0, 1000]);
    const parts = str.split(' ');
    expect(Number(parts[0])).toBe(6); // 3 points × 2
    expect(parts.length).toBe(1 + 6);
  });

  it('opacity tracks attenuation × density and stays in [0,1]', () => {
    const str = buildAttenuationOpacity(0.1, [0, 1000]);
    const nums = str.split(' ').slice(1).map(Number);
    // [0, 0.1*1.0] then [1000, 0.1*2.0]
    expect(nums[0]).toBe(0);
    expect(nums[1]).toBeCloseTo(0.1, 5);
    expect(nums[2]).toBe(1000);
    expect(nums[3]).toBeCloseTo(0.2, 5);
  });

  it('clamps opacity to 1 for a high density gain', () => {
    const str = buildAttenuationOpacity(10, [1000]);
    const nums = str.split(' ').slice(1).map(Number);
    expect(nums[1]).toBe(1);
  });

  it('air contributes zero opacity regardless of density', () => {
    const str = buildAttenuationOpacity(5, [-1000]);
    const nums = str.split(' ').slice(1).map(Number);
    expect(nums[1]).toBe(0);
  });
});

describe('buildRadiographColor', () => {
  it('is a flat white ramp (grayscale readout)', () => {
    const nums = buildRadiographColor().split(' ').map(Number);
    expect(nums[0]).toBe(2); // 2 control points
    expect(nums.slice(2, 5)).toEqual([1, 1, 1]); // first point white
    expect(nums.slice(6, 9)).toEqual([1, 1, 1]); // second point white
  });
});

describe('exposureToDensity', () => {
  it('increases monotonically and clamps the slider to [0,1]', () => {
    expect(exposureToDensity(-1)).toBe(exposureToDensity(0));
    expect(exposureToDensity(2)).toBe(exposureToDensity(1));
    expect(exposureToDensity(1)).toBeGreaterThan(exposureToDensity(0.5));
    expect(exposureToDensity(0.5)).toBeGreaterThan(exposureToDensity(0));
  });

  it('spans roughly two decades of exposure', () => {
    const ratio = exposureToDensity(1) / exposureToDensity(0);
    expect(ratio).toBeCloseTo(20, 5);
  });
});
