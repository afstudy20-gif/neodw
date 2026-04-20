/**
 * Single-click stenosis auto-detection.
 *
 * Works on a 1D diameter profile — the common abstraction shared by the CT
 * centerline pipeline (FFRArcSample[]) and the angiographic QCA pipeline
 * (VesselContour diameters). Callers adapt their native geometry into the
 * DiameterSample shape below and receive a StenosisFinding or null.
 *
 * Algorithm
 * ---------
 * 1. Locate global minimum diameter → candidate MLD.
 * 2. Estimate a healthy reference diameter as the median of a trimmed upper
 *    quantile of the full profile (defensive against focal drops + noise).
 * 3. Walk outward from the MLD index in both directions until the lumen
 *    diameter recovers to ≥ `recoveryRatio` × reference (default 0.95) or
 *    until the vessel edge is reached.
 * 4. Reject findings whose diameter stenosis is below `minStenosisPercent`
 *    (default 20%). Returning null lets the UI keep its empty state
 *    instead of pushing noise into the Stenosis Assessment panel.
 *
 * The function is intentionally pure and UI-free so it can power both the
 * CT workspace (via arcResample samples) and the angiographic workbench
 * (via its own contour diameters).
 */
export interface DiameterSample {
  distanceMm: number;
  diameterMm: number;
}

export interface StenosisFinding {
  proximalMm: number;
  mldMm: number;
  distalMm: number;
  mldDiameterMm: number;
  referenceDiameterMm: number;
  diameterStenosisPercent: number;
}

export interface AutoStenosisOptions {
  /** Diameter recovery threshold as a fraction of reference (default 0.95). */
  recoveryRatio?: number;
  /** Minimum %DS to consider the finding real (default 20). */
  minStenosisPercent?: number;
  /** Percentile used for the reference diameter estimate (default 0.8). */
  referencePercentile?: number;
  /** Minimum lesion length in mm (default 1.5). */
  minLesionLengthMm?: number;
}

export function autoDetectStenosis(
  samples: DiameterSample[],
  options: AutoStenosisOptions = {}
): StenosisFinding | null {
  if (samples.length < 5) return null;

  const {
    recoveryRatio = 0.95,
    minStenosisPercent = 20,
    referencePercentile = 0.8,
    minLesionLengthMm = 1.5,
  } = options;

  // Reference diameter: high percentile of all valid samples — robust to
  // focal drops (stenoses) and mild tapering because the percentile walks
  // to the healthy upper band of the distribution.
  const diameters = samples
    .map((s) => s.diameterMm)
    .filter((d) => Number.isFinite(d) && d > 0);
  if (diameters.length === 0) return null;
  const reference = percentile(diameters, referencePercentile);
  if (reference <= 0) return null;

  // Locate global MLD index.
  let mldIdx = 0;
  let mldDiameter = Infinity;
  for (let i = 0; i < samples.length; i += 1) {
    const d = samples[i].diameterMm;
    if (d > 0 && d < mldDiameter) {
      mldDiameter = d;
      mldIdx = i;
    }
  }
  if (!Number.isFinite(mldDiameter) || mldDiameter <= 0) return null;

  const diameterStenosisPercent = ((reference - mldDiameter) / reference) * 100;
  if (diameterStenosisPercent < minStenosisPercent) return null;

  const recoveryThreshold = reference * recoveryRatio;

  // Walk proximal (toward index 0) until recovery or edge.
  let proximalIdx = mldIdx;
  for (let i = mldIdx - 1; i >= 0; i -= 1) {
    proximalIdx = i;
    if (samples[i].diameterMm >= recoveryThreshold) break;
  }
  // Walk distal (toward end) until recovery or edge.
  let distalIdx = mldIdx;
  for (let i = mldIdx + 1; i < samples.length; i += 1) {
    distalIdx = i;
    if (samples[i].diameterMm >= recoveryThreshold) break;
  }

  const proximalMm = samples[proximalIdx].distanceMm;
  const mldMm = samples[mldIdx].distanceMm;
  const distalMm = samples[distalIdx].distanceMm;

  // Enforce a minimum lesion length; very short "lesions" are usually
  // sampling noise or partial-volume dips, not real disease.
  if (distalMm - proximalMm < minLesionLengthMm) return null;

  return {
    proximalMm,
    mldMm,
    distalMm,
    mldDiameterMm: mldDiameter,
    referenceDiameterMm: reference,
    diameterStenosisPercent,
  };
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(q * (sorted.length - 1)))
  );
  return sorted[idx];
}
