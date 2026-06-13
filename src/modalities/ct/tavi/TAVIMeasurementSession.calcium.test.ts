import { describe, it, expect } from 'vitest';
import { TAVIMeasurementSession, TAVIStructureAnnulus } from './TAVIMeasurementSession';
import type { TAVIContourSnapshot } from './TAVITypes';

// A square annulus contour (z-plane) carrying pre-sampled HU pixels.
function annulusSnapshotWith(pixelValues: Float32Array): TAVIContourSnapshot {
  return {
    worldPoints: [
      { x: -10, y: -10, z: 0 }, { x: 10, y: -10, z: 0 },
      { x: 10, y: 10, z: 0 }, { x: -10, y: 10, z: 0 },
    ],
    pixelPoints: [],
    planeOrigin: { x: 0, y: 0, z: 0 },
    planeNormal: { x: 0, y: 0, z: 1 },
    pixelValues,
    pixelAreaMm2: 0.25,
  };
}

describe('TAVIMeasurementSession calcium reactivity', () => {
  it('revives the (previously dead) annulus calcium path when pixels are present', () => {
    const s = new TAVIMeasurementSession();
    s.captureContourSnapshot(annulusSnapshotWith(Float32Array.from([500, 500, 50])), TAVIStructureAnnulus);
    expect(s.annulusCalcium).not.toBeNull();
    expect(s.annulusCalcium!.agatstonScore2D).toBeGreaterThan(0);
  });

  it('captures per-cusp samples and converts them to Agatston', () => {
    const s = new TAVIMeasurementSession();
    s.captureCuspCalciumSample('lcc', Float32Array.from([450, 450, 60]), 0.25);
    expect(s.cuspCalciumLCC).not.toBeNull();
    expect(s.cuspCalciumLCC!.agatstonScore2D).toBeGreaterThan(0);
    expect(s.cuspCalciumRCC).toBeNull();
  });

  it('re-runs scoring on calciumThresholdHU change without altering Agatston', () => {
    const s = new TAVIMeasurementSession();
    s.captureCuspCalciumSample('rcc', Float32Array.from([900, 900, 900, 50]), 0.25);
    const agatstonBefore = s.cuspCalciumRCC!.agatstonScore2D;
    const denseBefore = s.cuspCalciumRCC!.samplesAboveThreshold;
    s.calciumThresholdHU = 1200;
    s.recompute();
    expect(s.cuspCalciumRCC!.agatstonScore2D).toBe(agatstonBefore); // bands are fixed
    expect(s.cuspCalciumRCC!.samplesAboveThreshold).toBeLessThan(denseBefore); // threshold rose
  });

  it('keeps the aggregate cusp grade in sync with the per-cusp max for risk scoring', () => {
    const s = new TAVIMeasurementSession();
    s.cuspCalcificationGradeNCC = 3;
    s.recompute();
    expect(s.cuspCalcificationGrade).toBe(3);
  });

  it('clears all calcium state on reset()', () => {
    const s = new TAVIMeasurementSession();
    s.captureCuspCalciumSample('lcc', Float32Array.from([500]), 0.25);
    s.cuspCalcificationGradeLCC = 2;
    s.reset();
    expect(s.cuspCalciumLCC).toBeNull();
    expect(s.cuspPixelSampleLCC).toBeNull();
    expect(s.cuspCalcificationGradeLCC).toBe(0);
    expect(s.cuspCalcificationGrade).toBe(0);
  });

  it('emits per-cusp + LVOT lines in text and CSV reports when populated', () => {
    const s = new TAVIMeasurementSession();
    s.captureCuspCalciumSample('lcc', Float32Array.from([500, 500]), 0.25);
    s.captureLvotCalciumSample(Float32Array.from([450, 450]), 0.25);
    const text = s.textReport();
    expect(text).toMatch(/LCC/);
    expect(text).toMatch(/LVOT Agatston/);
    const csv = s.csvReport();
    expect(csv).toMatch(/LCC Agatston 2D/);
    expect(csv).toMatch(/LVOT Agatston 2D/);
  });
});
