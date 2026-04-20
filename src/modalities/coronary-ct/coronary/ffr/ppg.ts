import type { FFRPullbackPoint, VesselFFRResult } from './ffrTypes';

/**
 * Pullback Pressure Gradient index, per Collet et al. 2019 (EuroPCR /
 * PPG Global Registry). Scalar ∈ [0, 1]:
 *
 *   PPG = 0.5 × [ (max 20 mm ΔFFR / total ΔFFR)
 *               + (1 − mean functional length / total vessel length) ]
 *
 * Interpretation
 * --------------
 *   PPG → 1  ⇒ predominantly focal disease (amenable to focal stent).
 *   PPG → 0  ⇒ predominantly diffuse disease (poor post-PCI physiology).
 *
 * Functional length = contiguous arc over which FFR is actively dropping
 * (dP/ds > threshold). A long, gentle decay yields a large functional
 * length → low PPG; a tight focal lesion yields a tiny functional length
 * → high PPG.
 *
 * Edge cases:
 *   - Total ΔFFR ≈ 0 (no disease): PPG is meaningless; return 0.
 *   - Very short vessel: functional-length term collapses to 0, so the
 *     index effectively reduces to the 20 mm / total ΔFFR ratio.
 */
export function computePPGIndex(pullback: FFRPullbackPoint[]): number {
  if (pullback.length < 2) return 0;

  const first = pullback[0];
  const last = pullback[pullback.length - 1];
  const totalLengthMm = Math.max(last.distanceMm - first.distanceMm, 1e-6);
  const totalDeltaFFR = first.ffr - last.ffr;

  if (totalDeltaFFR <= 1e-3) return 0;

  // Term 1: largest ΔFFR captured by a sliding 20 mm window, normalised
  // by the total vessel ΔFFR. Focal stenoses concentrate ΔFFR inside the
  // window → this term → 1.
  let maxWindowDrop = 0;
  for (let i = 0; i < pullback.length; i += 1) {
    const base = pullback[i];
    for (let j = i + 1; j < pullback.length; j += 1) {
      const span = pullback[j].distanceMm - base.distanceMm;
      if (span > 20) break;
      const drop = base.ffr - pullback[j].ffr;
      if (drop > maxWindowDrop) maxWindowDrop = drop;
    }
  }
  const focalTerm = Math.min(maxWindowDrop / totalDeltaFFR, 1);

  // Term 2: 1 − (mean functional length / total length). "Functional"
  // segments are those with a meaningful pressure gradient, quantified by
  // dFFR/ds above a fraction of the total gradient. Using 5% of the total
  // ΔFFR per millimetre as the threshold keeps the metric stable for
  // vessels of different lengths.
  const gradientThreshold = (0.05 * totalDeltaFFR) / totalLengthMm;
  let functionalLen = 0;
  for (let i = 1; i < pullback.length; i += 1) {
    const prev = pullback[i - 1];
    const curr = pullback[i];
    const ds = curr.distanceMm - prev.distanceMm;
    if (ds <= 0) continue;
    const localGradient = (prev.ffr - curr.ffr) / ds;
    if (localGradient > gradientThreshold) {
      functionalLen += ds;
    }
  }
  const lengthTerm = 1 - Math.min(functionalLen / totalLengthMm, 1);

  return round3(0.5 * (focalTerm + lengthTerm));
}

/**
 * Fill ppgIndex on a VesselFFRResult in place.
 */
export function fillPPG(result: VesselFFRResult): void {
  result.ppgIndex = computePPGIndex(result.pullback);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
