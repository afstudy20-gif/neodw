import type { FFRArcSample, FFRPullbackPoint, VesselFFRResult } from './ffrTypes';
import { classifyFFR } from './ffrTypes';

/** Blood dynamic viscosity (Pa·s). ~0.0035 at body temp and hematocrit. */
const BLOOD_VISCOSITY_PA_S = 0.0035;
/** Blood density (kg/m³). */
const BLOOD_DENSITY_KG_M3 = 1050;
/** Separation-loss coefficient (Young–Tsai class). Empiric ≈ 1.3 for coronaries. */
const SEPARATION_COEFF = 1.3;
/** mmHg ↔ Pa conversion. */
const MMHG_PER_PA = 1 / 133.322;
const PA_PER_MMHG = 133.322;

/**
 * Solve the 1D steady hyperemic pressure field along a single vessel.
 *
 * Momentum equation integrated along arc length s, with Q held constant
 * (incompressible, single-outlet simplification — branch flow is handled
 * upstream by boundaryFlow.ts):
 *
 *   dP/ds = −[ 8π·μ·V / A   +  (K_sep · ρ / 2) · (A_ref/A − 1)² · V² / ds ]
 *
 * Discretised per segment of length ds:
 *   ΔP_visc   = 8π·μ·ds·V / A²
 *   ΔP_separation = (K_sep · ρ / 2) · (A_ref/A − 1)² · V²
 *   P_{i+1}   = P_i − ΔP_visc − ΔP_separation
 *
 * V and A are taken at sample i. The separation term vanishes where the
 * lumen matches the reference caliber — i.e. no disease → pure Poiseuille.
 *
 * All arithmetic is in SI inside the solver; lengths come in as mm and
 * areas as mm² so we convert at the boundary.
 */
export function solveVesselFFR(
  vesselId: string,
  label: string,
  samples: FFRArcSample[],
  hyperemicFlowMlPerSec: number,
  meanAorticPressureMmHg: number
): VesselFFRResult {
  if (samples.length === 0) {
    return emptyResult(vesselId, label, meanAorticPressureMmHg);
  }

  const Pa_Pa = meanAorticPressureMmHg * PA_PER_MMHG;
  const Q_m3_s = hyperemicFlowMlPerSec * 1e-6; // mL/s → m³/s

  const pullback: FFRPullbackPoint[] = [];
  let pressurePa = Pa_Pa;

  // Initial point = ostium, full aortic pressure.
  pullback.push({
    distanceMm: samples[0].distanceMm,
    pressureMmHg: pressurePa * MMHG_PER_PA,
    ffr: 1.0,
  });

  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1];
    const curr = samples[i];

    const ds_m = Math.max((curr.distanceMm - prev.distanceMm) * 1e-3, 0);
    if (ds_m <= 0) {
      pullback.push({
        distanceMm: curr.distanceMm,
        pressureMmHg: pressurePa * MMHG_PER_PA,
        ffr: pressurePa / Pa_Pa,
      });
      continue;
    }

    // Use prev sample's geometry for segment integration.
    const A_m2 = Math.max(prev.areaMm2 * 1e-6, 1e-10);
    const Aref_m2 = Math.max(prev.referenceAreaMm2 * 1e-6, A_m2);

    const V = Q_m3_s / A_m2; // m/s

    const dPviscous =
      (8 * Math.PI * BLOOD_VISCOSITY_PA_S * ds_m * V) / A_m2;

    const areaRatioDeficit = Aref_m2 / A_m2 - 1;
    const dPseparation =
      (SEPARATION_COEFF * BLOOD_DENSITY_KG_M3 / 2) *
      areaRatioDeficit * areaRatioDeficit *
      V * V;

    pressurePa -= dPviscous + dPseparation;

    // Physiology floor: coronary collateral / perfusion means distal
    // pressure cannot go below ~20 mmHg without the vessel closing.
    // Without this the solver can produce negative FFR for very tight
    // tandem stenoses, which is non-physical.
    if (pressurePa < 20 * PA_PER_MMHG) {
      pressurePa = 20 * PA_PER_MMHG;
    }

    pullback.push({
      distanceMm: curr.distanceMm,
      pressureMmHg: pressurePa * MMHG_PER_PA,
      ffr: pressurePa / Pa_Pa,
    });
  }

  const distal = pullback[pullback.length - 1];
  const maxDelta = maxDeltaFFR(pullback);

  return {
    vesselId,
    label,
    pullback,
    distalFFR: round3(distal.ffr),
    maxDeltaFFR: round3(maxDelta),
    ppgIndex: 0, // filled by ppg.ts
    isIschemic: classifyFFR(distal.ffr) === 'ischemic',
  };
}

function maxDeltaFFR(pullback: FFRPullbackPoint[]): number {
  if (pullback.length < 2) return 0;
  let maxDrop = 0;
  // Sliding 10 mm window captures focal lesion-level gradients;
  // matches clinical ΔFFR definitions (translesional drop).
  for (let i = 0; i < pullback.length; i += 1) {
    const base = pullback[i];
    for (let j = i + 1; j < pullback.length; j += 1) {
      const span = pullback[j].distanceMm - base.distanceMm;
      if (span > 10) break;
      const drop = base.ffr - pullback[j].ffr;
      if (drop > maxDrop) maxDrop = drop;
    }
  }
  return maxDrop;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function emptyResult(
  vesselId: string,
  label: string,
  meanAorticPressureMmHg: number
): VesselFFRResult {
  return {
    vesselId,
    label,
    pullback: [
      { distanceMm: 0, pressureMmHg: meanAorticPressureMmHg, ffr: 1.0 },
    ],
    distalFFR: 1.0,
    maxDeltaFFR: 0,
    ppgIndex: 0,
    isIschemic: false,
  };
}
