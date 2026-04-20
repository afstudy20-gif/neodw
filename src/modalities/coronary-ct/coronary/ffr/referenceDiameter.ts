import type { CoronaryVesselRecord } from '../QCATypes';
import type { FFRArcSample } from './ffrTypes';

/**
 * Populate referenceDiameterMm / referenceAreaMm2 on each sample in place.
 *
 * A reference diameter represents the "healthy baseline" caliber of the
 * vessel at that arc-length, i.e. what the lumen would measure in the
 * absence of disease. In a 1D CT-FFR solver this is the anchor for the
 * Bernoulli separation-loss term (pressure drop scales with (1/A − 1/A_ref)²).
 *
 * Strategy, in order of preference:
 *   1. manual.proximalReferenceDiameterMm + distalReferenceDiameterMm →
 *      linear taper along arc length. Clinician-supervised, most reliable.
 *   2. High-percentile (default 80th) of the observed diameters along the
 *      full vessel. Focal stenoses sit well below the upper percentiles,
 *      so this estimates the non-diseased caliber. Apply a very mild taper
 *      from proximal to distal (≈15% shrink over full length) to keep
 *      physiology plausible.
 *   3. If diameters array is empty, leave reference = diameter (solver sees
 *      zero separation loss and falls back to pure Poiseuille friction).
 */
export function fillReferenceDiameter(
  record: CoronaryVesselRecord,
  samples: FFRArcSample[]
): void {
  if (samples.length === 0) return;

  const manual = record.manual;
  const prox = manual.proximalReferenceDiameterMm;
  const dist = manual.distalReferenceDiameterMm;

  const totalLength = samples[samples.length - 1].distanceMm;
  const safeTotal = Math.max(totalLength, 1e-6);

  let proxRef: number;
  let distRef: number;

  if (prox != null && dist != null && prox > 0 && dist > 0) {
    proxRef = prox;
    distRef = dist;
  } else {
    const inferred = inferReferenceFromSamples(samples);
    proxRef = prox ?? inferred.proximal;
    distRef = dist ?? inferred.distal;
  }

  // Enforce distal ≤ proximal (vessels taper, not flare, in healthy anatomy).
  if (distRef > proxRef) {
    distRef = proxRef;
  }

  for (const sample of samples) {
    const t = sample.distanceMm / safeTotal;
    const dRef = proxRef + (distRef - proxRef) * t;
    sample.referenceDiameterMm = dRef;
    const rRef = dRef / 2;
    sample.referenceAreaMm2 = Math.PI * rRef * rRef;
  }
}

/**
 * Estimate proximal/distal reference diameters when the clinician has not
 * supplied them. Uses a high percentile of observed diameters in the
 * proximal and distal halves so focal stenoses don't pollute the estimate.
 */
function inferReferenceFromSamples(samples: FFRArcSample[]): { proximal: number; distal: number } {
  if (samples.length === 0) return { proximal: 3.5, distal: 3.0 };

  const half = Math.floor(samples.length / 2);
  const proximalSlice = samples.slice(0, Math.max(half, 1)).map((s) => s.diameterMm);
  const distalSlice = samples.slice(half).map((s) => s.diameterMm);

  const proximal = percentile(proximalSlice, 0.8);
  const distal = percentile(distalSlice.length ? distalSlice : proximalSlice, 0.8);

  // Apply a mild physiological taper if the slices happen to coincide
  // (very short vessel): distal ≈ 85% of proximal.
  if (Math.abs(proximal - distal) < 1e-3) {
    return { proximal, distal: proximal * 0.85 };
  }
  return { proximal, distal };
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[idx];
}
