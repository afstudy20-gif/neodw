// ROI time-intensity / contrast-enhancement curve analysis.
//
// Modality-agnostic, pure. Given an ROI sampled across phases/timepoints
// (multi-phase CT, dynamic/perfusion series), summarize the wash-in/wash-out
// dynamics: baseline, peak enhancement, time-to-peak, up/down slopes, AUC.
// Also a small helper to reduce a voxel mask to ROI intensity statistics.

export interface ROIStats {
  meanHU: number;
  stdHU: number;
  minHU: number;
  maxHU: number;
  count: number;
}

/** Mean/σ/min/max over the given flat voxel indices. */
export function roiStats(data: ArrayLike<number>, indices: ArrayLike<number>): ROIStats {
  const count = indices.length;
  if (count === 0) return { meanHU: 0, stdHU: 0, minHU: 0, maxHU: 0, count: 0 };
  let sum = 0, min = Infinity, max = -Infinity;
  for (let i = 0; i < count; i++) {
    const v = data[indices[i]];
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / count;
  let varSum = 0;
  for (let i = 0; i < count; i++) {
    const d = data[indices[i]] - mean;
    varSum += d * d;
  }
  return { meanHU: mean, stdHU: Math.sqrt(varSum / count), minHU: min, maxHU: max, count };
}

export interface TICPoint {
  /** Acquisition time of the phase (seconds). */
  timeSec: number;
  /** ROI value at this phase (HU, or generic intensity). */
  valueHU: number;
}

export interface EnhancementCurveResult {
  baselineHU: number;
  peakHU: number;
  /** peak − baseline */
  peakEnhancementHU: number;
  /** time of the peak phase (s) */
  timeToPeakSec: number;
  /** mean up-slope baseline→peak (HU/s); 0 if peak is at t0 */
  washInSlopeHUPerSec: number;
  /** mean down-slope peak→last (HU/s, ≤0 for true wash-out); 0 if peak is last */
  washOutSlopeHUPerSec: number;
  /** area under the enhancement curve (value−baseline) over time, trapezoidal (HU·s) */
  aucHUSec: number;
  /** echoes the (time-sorted) input */
  points: TICPoint[];
}

export interface EnhancementCurveOptions {
  /** Number of leading phases averaged for the baseline. Default 1. */
  baselinePhases?: number;
}

/**
 * Compute wash-in/wash-out metrics from an ROI time-intensity curve.
 * Points are sorted by time; at least two are required.
 */
export function computeEnhancementCurve(
  points: TICPoint[],
  options: EnhancementCurveOptions = {}
): EnhancementCurveResult {
  if (points.length < 2) {
    throw new Error('computeEnhancementCurve: at least two timepoints are required');
  }
  const pts = [...points].sort((a, b) => a.timeSec - b.timeSec);
  const baselinePhases = Math.max(1, Math.min(options.baselinePhases ?? 1, pts.length));

  let baseSum = 0;
  for (let i = 0; i < baselinePhases; i++) baseSum += pts[i].valueHU;
  const baselineHU = baseSum / baselinePhases;

  let peakHU = -Infinity;
  let peakIdx = 0;
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].valueHU > peakHU) { peakHU = pts[i].valueHU; peakIdx = i; }
  }
  const timeToPeakSec = pts[peakIdx].timeSec - pts[0].timeSec;

  const washInDt = pts[peakIdx].timeSec - pts[0].timeSec;
  const washInSlopeHUPerSec = washInDt > 0 ? (peakHU - pts[0].valueHU) / washInDt : 0;

  const last = pts[pts.length - 1];
  const washOutDt = last.timeSec - pts[peakIdx].timeSec;
  const washOutSlopeHUPerSec = washOutDt > 0 ? (last.valueHU - peakHU) / washOutDt : 0;

  // Trapezoidal AUC of (value − baseline).
  let aucHUSec = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = pts[i].timeSec - pts[i - 1].timeSec;
    const a = pts[i - 1].valueHU - baselineHU;
    const b = pts[i].valueHU - baselineHU;
    aucHUSec += ((a + b) / 2) * dt;
  }

  return {
    baselineHU,
    peakHU,
    peakEnhancementHU: peakHU - baselineHU,
    timeToPeakSec,
    washInSlopeHUPerSec,
    washOutSlopeHUPerSec,
    aucHUSec,
    points: pts,
  };
}
