import { describe, it, expect } from 'vitest';
import { roiStats, computeEnhancementCurve, type TICPoint } from './enhancementCurve';

describe('roiStats', () => {
  it('computes mean/std/min/max over masked indices', () => {
    const data = [10, 20, 30, 40, 50];
    const s = roiStats(data, [0, 2, 4]); // 10, 30, 50
    expect(s.meanHU).toBe(30);
    expect(s.minHU).toBe(10);
    expect(s.maxHU).toBe(50);
    expect(s.count).toBe(3);
    expect(s.stdHU).toBeCloseTo(Math.sqrt((400 + 0 + 400) / 3), 6);
  });
  it('returns zeros for an empty ROI', () => {
    expect(roiStats([1, 2, 3], [])).toEqual({ meanHU: 0, stdHU: 0, minHU: 0, maxHU: 0, count: 0 });
  });
});

describe('computeEnhancementCurve', () => {
  // Baseline 40, rises to peak 240 at t=20s, washes out to 140 at t=40s.
  const curve: TICPoint[] = [
    { timeSec: 0, valueHU: 40 },
    { timeSec: 10, valueHU: 140 },
    { timeSec: 20, valueHU: 240 },
    { timeSec: 30, valueHU: 190 },
    { timeSec: 40, valueHU: 140 },
  ];

  it('finds baseline, peak, peak enhancement and time-to-peak', () => {
    const r = computeEnhancementCurve(curve);
    expect(r.baselineHU).toBe(40);
    expect(r.peakHU).toBe(240);
    expect(r.peakEnhancementHU).toBe(200);
    expect(r.timeToPeakSec).toBe(20);
  });

  it('computes wash-in (positive) and wash-out (negative) slopes', () => {
    const r = computeEnhancementCurve(curve);
    expect(r.washInSlopeHUPerSec).toBeCloseTo((240 - 40) / 20, 6); // +10 HU/s
    expect(r.washOutSlopeHUPerSec).toBeCloseTo((140 - 240) / 20, 6); // -5 HU/s
  });

  it('computes a positive AUC for an enhancing ROI', () => {
    const r = computeEnhancementCurve(curve);
    // trapezoid of (value-baseline) over [0,40]: 500+1500+1750+1250 = 5000 HU·s
    expect(r.aucHUSec).toBeCloseTo(5000, 3);
  });

  it('sorts unordered timepoints before analysis', () => {
    const shuffled = [curve[2], curve[0], curve[4], curve[1], curve[3]];
    const r = computeEnhancementCurve(shuffled);
    expect(r.points.map((p) => p.timeSec)).toEqual([0, 10, 20, 30, 40]);
    expect(r.timeToPeakSec).toBe(20);
  });

  it('averages multiple baseline phases when requested', () => {
    const r = computeEnhancementCurve(curve, { baselinePhases: 2 });
    expect(r.baselineHU).toBe((40 + 140) / 2);
  });

  it('handles a peak at the last phase (no wash-out)', () => {
    const rising: TICPoint[] = [
      { timeSec: 0, valueHU: 50 }, { timeSec: 10, valueHU: 100 }, { timeSec: 20, valueHU: 200 },
    ];
    const r = computeEnhancementCurve(rising);
    expect(r.peakHU).toBe(200);
    expect(r.washOutSlopeHUPerSec).toBe(0);
  });

  it('throws with fewer than two timepoints', () => {
    expect(() => computeEnhancementCurve([{ timeSec: 0, valueHU: 1 }])).toThrow(/two timepoints/);
  });
});
