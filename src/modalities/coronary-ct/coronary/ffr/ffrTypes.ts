import type { CoronaryVesselId, CoronaryVesselRecord } from '../QCATypes';

/**
 * Sample along a coronary centerline at a fixed arc-length interval.
 * All geometric quantities are pre-computed so the solver can stay linear.
 */
export interface FFRArcSample {
  /** Cumulative distance from the ostium (mm). */
  distanceMm: number;
  /** Lumen cross-sectional area at this sample (mm^2). */
  areaMm2: number;
  /** Effective lumen diameter at this sample (mm). */
  diameterMm: number;
  /** Disease-free reference diameter at this sample (mm). */
  referenceDiameterMm: number;
  /** Disease-free reference area at this sample (mm^2). */
  referenceAreaMm2: number;
}

/**
 * Per-vessel inputs feeding the 1D pressure-drop solver.
 */
export interface VesselFFRInput {
  vesselId: CoronaryVesselId;
  label: string;
  /** Resampled geometry from centerline + lumen contours. */
  samples: FFRArcSample[];
  /** Hyperemic volumetric flow assigned to this vessel (mL/s). */
  hyperemicFlowMlPerSec: number;
}

/**
 * Global hemodynamic assumptions for a patient-level FFR computation.
 */
export interface PatientFFRInput {
  /** Mean aortic pressure at hyperemia (mmHg). */
  meanAorticPressureMmHg: number;
  /** Estimated left-ventricular myocardial mass (g). */
  myocardialMassG: number;
  /** Resting flow per gram myocardium (mL/min/g). Default ≈ 1.0. */
  restingFlowPerGram: number;
  /** Hyperemia multiplier applied to resting flow. Default 3.0. */
  hyperemiaFactor: number;
  vessels: VesselFFRInput[];
}

/**
 * Hyperemic boundary flow for a vessel after Murray's-law splitting.
 */
export interface VesselFlowAllocation {
  vesselId: CoronaryVesselId;
  /** Representative inlet radius used by the Murray r^3 split (mm). */
  inletRadiusMm: number;
  /** Baseline resting flow (mL/s). */
  restingFlowMlPerSec: number;
  /** Flow after hyperemia factor (mL/s) — what the solver uses. */
  hyperemicFlowMlPerSec: number;
}

/**
 * One point on the simulated FFR pullback curve.
 */
export interface FFRPullbackPoint {
  distanceMm: number;
  /** Simulated pressure at this location (mmHg). */
  pressureMmHg: number;
  /** Simulated FFR (= P_local / P_aorta). */
  ffr: number;
}

/**
 * Per-vessel solver output.
 */
export interface VesselFFRResult {
  vesselId: CoronaryVesselId;
  label: string;
  pullback: FFRPullbackPoint[];
  /** FFR at the most distal sampled point. */
  distalFFR: number;
  /** Max translesional drop observed along the vessel. */
  maxDeltaFFR: number;
  /** Pullback Pressure Gradient index ∈ [0, 1]. Higher = focal disease. */
  ppgIndex: number;
  /** True when distal FFR ≤ 0.80. */
  isIschemic: boolean;
}

/**
 * Patient-level aggregate result.
 */
export interface PatientFFRResult {
  vessels: VesselFFRResult[];
  totalResting: VesselFlowAllocation[];
  meanAorticPressureMmHg: number;
  myocardialMassG: number;
  hyperemiaFactor: number;
}

/**
 * Classify an FFR value against standard clinical thresholds.
 */
export type FFRSeverity = 'normal' | 'borderline' | 'ischemic';

export function classifyFFR(ffr: number): FFRSeverity {
  if (ffr > 0.80) return 'normal';
  if (ffr > 0.75) return 'borderline';
  return 'ischemic';
}
