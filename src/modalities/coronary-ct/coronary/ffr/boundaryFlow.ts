import type { CoronaryVesselRecord } from '../QCATypes';
import type { FFRArcSample, VesselFlowAllocation } from './ffrTypes';

/** Default resting myocardial flow per gram of LV mass (mL/min/g). */
export const DEFAULT_RESTING_FLOW_PER_GRAM = 1.0;

/** Default hyperemia multiplier. Doc section 6 supports 3× microvascular resistance drop. */
export const DEFAULT_HYPEREMIA_FACTOR = 3.0;

/**
 * Compute resting + hyperemic boundary flow per vessel.
 *
 * Total resting coronary flow (mL/min) is derived from LV mass via
 *   Q_rest_total = cQ × M_LV
 * where cQ ≈ 1.0 mL/min/g at rest (Gould / standard allometric value).
 * The multi-scale boundary-condition literature cited in the technical
 * document (sections 5-6) pairs this with Murray's law to distribute
 * flow across the epicardial tree: Q_i ∝ r_i^3, where r_i is a
 * representative inlet radius of vessel i.
 *
 * Hyperemic flow is obtained by multiplying by the hyperemia factor
 * (default 3.0). Invasive reality is patient-specific, but a fixed
 * factor mirrors how clinical FFR-CT platforms simulate adenosine
 * without a microvascular autoregulation model.
 */
export function allocateBoundaryFlow(
  vessels: Array<{ record: CoronaryVesselRecord; samples: FFRArcSample[] }>,
  params: {
    myocardialMassG: number;
    restingFlowPerGram?: number;
    hyperemiaFactor?: number;
  }
): VesselFlowAllocation[] {
  const restingPerGram = params.restingFlowPerGram ?? DEFAULT_RESTING_FLOW_PER_GRAM;
  const hyperemia = params.hyperemiaFactor ?? DEFAULT_HYPEREMIA_FACTOR;

  // Total resting coronary flow in mL/s.
  const totalRestingMlPerMin = Math.max(0, restingPerGram * params.myocardialMassG);
  const totalRestingMlPerSec = totalRestingMlPerMin / 60;

  if (vessels.length === 0 || totalRestingMlPerSec <= 0) {
    return vessels.map(({ record }) => ({
      vesselId: record.id,
      inletRadiusMm: 0,
      restingFlowMlPerSec: 0,
      hyperemicFlowMlPerSec: 0,
    }));
  }

  // Murray weights: use r^3 of each vessel's inlet radius.
  // Inlet radius = reference radius at the proximal end (healthy baseline),
  // falling back to observed radius if reference is not filled yet.
  const weights = vessels.map(({ samples }) => {
    const head = samples[0];
    if (!head) return 0;
    const r = (head.referenceDiameterMm || head.diameterMm) / 2;
    return Math.max(0, r) ** 3;
  });
  const weightSum = weights.reduce((a, b) => a + b, 0);

  // If the tree has no measurable inlet (all samples empty), distribute
  // uniformly so downstream solver inputs stay finite.
  const uniform = weightSum <= 0 ? 1 / Math.max(vessels.length, 1) : 0;

  return vessels.map(({ record, samples }, idx) => {
    const share = weightSum > 0 ? weights[idx] / weightSum : uniform;
    const resting = totalRestingMlPerSec * share;
    const head = samples[0];
    const inletRadiusMm = head ? (head.referenceDiameterMm || head.diameterMm) / 2 : 0;
    return {
      vesselId: record.id,
      inletRadiusMm,
      restingFlowMlPerSec: resting,
      hyperemicFlowMlPerSec: resting * hyperemia,
    };
  });
}
