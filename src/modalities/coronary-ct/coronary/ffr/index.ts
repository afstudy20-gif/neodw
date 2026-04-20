import type { CoronaryVesselRecord } from '../QCATypes';
import type { PatientFFRResult, VesselFFRResult } from './ffrTypes';
import {
  DEFAULT_HYPEREMIA_FACTOR,
  DEFAULT_RESTING_FLOW_PER_GRAM,
  allocateBoundaryFlow,
} from './boundaryFlow';
import { resampleCenterline } from './arcResample';
import { fillReferenceDiameter } from './referenceDiameter';
import { solveVesselFFR } from './ffrSolver';
import { fillPPG } from './ppg';

export * from './ffrTypes';
export { DEFAULT_HYPEREMIA_FACTOR, DEFAULT_RESTING_FLOW_PER_GRAM } from './boundaryFlow';
export { DEFAULT_ARC_STEP_MM } from './arcResample';

export interface ComputePatientFFRParams {
  records: CoronaryVesselRecord[];
  meanAorticPressureMmHg: number;
  myocardialMassG: number;
  restingFlowPerGram?: number;
  hyperemiaFactor?: number;
  arcStepMm?: number;
}

/**
 * End-to-end CT-FFR pipeline for a set of vessels belonging to one patient.
 *
 * Order of operations mirrors the sections of the reference document:
 *   1. Geometry extraction (arcResample) – sections 3 & 4.
 *   2. Reference caliber assignment (referenceDiameter).
 *   3. Boundary flow / Murray split (boundaryFlow) – section 5.
 *   4. 1D hyperemic pressure solve (ffrSolver) – section 4 + 5.
 *   5. Hemodynamic indices (ppg) – section 7.
 *
 * Vessels with fewer than two centerline points are skipped; the patient
 * result still includes flow allocations for every input vessel so the UI
 * can show "insufficient geometry" hints.
 */
export function computePatientFFR(params: ComputePatientFFRParams): PatientFFRResult {
  const {
    records,
    meanAorticPressureMmHg,
    myocardialMassG,
    restingFlowPerGram = DEFAULT_RESTING_FLOW_PER_GRAM,
    hyperemiaFactor = DEFAULT_HYPEREMIA_FACTOR,
    arcStepMm,
  } = params;

  const prepared = records.map((record) => {
    const samples = resampleCenterline(record, arcStepMm);
    fillReferenceDiameter(record, samples);
    return { record, samples };
  });

  const allocations = allocateBoundaryFlow(prepared, {
    myocardialMassG,
    restingFlowPerGram,
    hyperemiaFactor,
  });
  const flowById = new Map(allocations.map((a) => [a.vesselId, a]));

  const vessels: VesselFFRResult[] = [];
  for (const { record, samples } of prepared) {
    const flow = flowById.get(record.id);
    const hyperemicFlow = flow?.hyperemicFlowMlPerSec ?? 0;
    const result = solveVesselFFR(
      record.id,
      record.label,
      samples,
      hyperemicFlow,
      meanAorticPressureMmHg
    );
    fillPPG(result);
    vessels.push(result);
  }

  return {
    vessels,
    totalResting: allocations,
    meanAorticPressureMmHg,
    myocardialMassG,
    hyperemiaFactor,
  };
}
