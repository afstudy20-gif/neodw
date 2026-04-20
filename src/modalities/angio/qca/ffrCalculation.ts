import type { VesselContour, FFRResult } from './QCATypes';

// Physical constants
const BLOOD_VISCOSITY = 0.035;    // dyn·s/cm² (= 0.0035 Pa·s)
const BLOOD_DENSITY = 1.05;       // g/cm³ (= 1050 kg/m³)
const HYPEREMIC_VELOCITY = 0.35;  // m/s (fixed-flow model, fQFR)

/**
 * Convert mmHg to dyn/cm² (CGS pressure units).
 * 1 mmHg = 1333.22 dyn/cm²
 */
function mmHgToDynPerCm2(mmHg: number): number {
  return mmHg * 1333.22;
}

/**
 * Convert dyn/cm² to mmHg.
 */
function dynPerCm2ToMmHg(dynPerCm2: number): number {
  return dynPerCm2 / 1333.22;
}

/**
 * Calculate angio-derived FFR (vFFR) using the fixed-flow QFR model.
 *
 * Based on the Poiseuille + Bernoulli pressure drop computation:
 *   deltaP = f_viscous * V + f_expansion * V²
 *
 * For each subsegment:
 *   f_viscous = 8 * pi * mu * ds / A²   (Poiseuille friction)
 *   f_expansion = rho/2 * Ke * (1/A_i - 1/A_ref)²  (expansion/contraction loss)
 *
 * vFFR_i = (Pa - cumulative_deltaP_i) / Pa
 *
 * @param contour - Vessel contour with diameter/area measurements
 * @param referenceDiameters - Interpolated reference diameters (mm)
 * @param aorticPressure - Aortic pressure in mmHg (default 100)
 * @returns FFRResult with pullback curve and distal vFFR
 */
export function calculateVFFR(
  contour: VesselContour,
  referenceDiameters: number[],
  aorticPressure: number = 100
): FFRResult {
  const { areas, cumulativeLength } = contour;
  const n = areas.length;

  if (n < 3) {
    return {
      vffr: 1.0,
      pullbackCurve: new Array(n).fill(1.0),
      aoPress: aorticPressure,
      isSignificant: false,
    };
  }

  // Reference areas from reference diameters
  const refAreas = referenceDiameters.map(d => Math.PI * (d / 2) ** 2);

  // Convert units: mm -> cm for CGS system
  const V_cm = HYPEREMIC_VELOCITY * 100; // m/s -> cm/s
  const mu = BLOOD_VISCOSITY;             // dyn·s/cm²
  const rho = BLOOD_DENSITY;              // g/cm³

  const Pa_dyn = mmHgToDynPerCm2(aorticPressure);
  const pullbackCurve: number[] = [1.0]; // starts at 1.0 proximally
  let cumulativeDeltaP = 0;

  // Expansion loss coefficient (empiric, typically 0.5-1.0)
  const Ke = 0.5;

  for (let i = 1; i < n; i++) {
    // Subsegment length in cm
    const ds_cm = (cumulativeLength[i] - cumulativeLength[i - 1]) / 10;
    if (ds_cm <= 0) {
      pullbackCurve.push(pullbackCurve[pullbackCurve.length - 1]);
      continue;
    }

    // Cross-sectional area at this point (mm² -> cm²)
    // Clamp minimum area to prevent numerical explosion
    const minArea_cm2 = 0.005; // ~0.25mm diameter minimum
    const A_cm2 = Math.max(areas[i] / 100, minArea_cm2);
    const Aref_cm2 = Math.max((refAreas[i] ?? areas[i]) / 100, minArea_cm2);

    // Poiseuille viscous friction loss
    const f_viscous = (8 * Math.PI * mu * ds_cm) / (A_cm2 * A_cm2);

    // Bernoulli expansion/contraction loss
    const areaRatioDiff = (1 / A_cm2 - 1 / Aref_cm2);
    const f_expansion = (rho / 2) * Ke * areaRatioDiff * areaRatioDiff * ds_cm;

    // Pressure drop for this subsegment — cap per-segment drop to prevent blowup
    const deltaP = Math.min(f_viscous * V_cm + f_expansion * V_cm * V_cm, Pa_dyn * 0.05);
    cumulativeDeltaP += deltaP;

    // vFFR at this point
    const vffr_i = Math.max(0, (Pa_dyn - cumulativeDeltaP) / Pa_dyn);
    pullbackCurve.push(vffr_i);
  }

  const distalVFFR = pullbackCurve[pullbackCurve.length - 1];

  return {
    vffr: Math.round(distalVFFR * 100) / 100,
    pullbackCurve,
    aoPress: aorticPressure,
    isSignificant: distalVFFR <= 0.80,
  };
}
