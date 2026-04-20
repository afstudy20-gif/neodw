/**
 * TAVR prosthesis sizing database.
 *
 * Sizing ranges are derived from manufacturer IFU charts:
 * - Edwards Sapien 3 / Sapien 3 Ultra
 * - Medtronic Evolut FX / Evolut PRO+
 *
 * Each entry maps an annular measurement range to a valve size.
 * The "recommended" flag indicates the best-fit size; adjacent sizes
 * are listed as alternatives when the patient sits at a boundary.
 */

export interface ValveSize {
  /** Nominal valve label size in mm */
  size: number;
  /** Minimum annular perimeter-derived diameter (mm) */
  perimeterDiameterMin: number;
  /** Maximum annular perimeter-derived diameter (mm) */
  perimeterDiameterMax: number;
  /** Minimum annular area (mm²) */
  areaMin: number;
  /** Maximum annular area (mm²) */
  areaMax: number;
  /** Minimum perimeter (mm) */
  perimeterMin: number;
  /** Maximum perimeter (mm) */
  perimeterMax: number;
}

export interface ValveFamily {
  name: string;
  manufacturer: string;
  type: 'balloon-expandable' | 'self-expanding';
  sizes: ValveSize[];
}

// Edwards SAPIEN 3 Ultra / Ultra RESILIA
const sapien3Ultra: ValveFamily = {
  name: 'Sapien 3 Ultra',
  manufacturer: 'Edwards Lifesciences',
  type: 'balloon-expandable',
  sizes: [
    { size: 20, perimeterDiameterMin: 18.0, perimeterDiameterMax: 20.5, areaMin: 254, areaMax: 330, perimeterMin: 56.5, perimeterMax: 64.4 },
    { size: 23, perimeterDiameterMin: 20.5, perimeterDiameterMax: 23.5, areaMin: 330, areaMax: 434, perimeterMin: 64.4, perimeterMax: 73.9 },
    { size: 26, perimeterDiameterMin: 23.5, perimeterDiameterMax: 26.5, areaMin: 434, areaMax: 552, perimeterMin: 73.9, perimeterMax: 83.3 },
    { size: 29, perimeterDiameterMin: 26.5, perimeterDiameterMax: 29.5, areaMin: 552, areaMax: 683, perimeterMin: 83.3, perimeterMax: 92.7 },
  ],
};

// Medtronic Evolut FX / Evolut PRO+
const evolutFX: ValveFamily = {
  name: 'Evolut FX',
  manufacturer: 'Medtronic',
  type: 'self-expanding',
  sizes: [
    { size: 23, perimeterDiameterMin: 18.0, perimeterDiameterMax: 20.0, areaMin: 254, areaMax: 314, perimeterMin: 56.5, perimeterMax: 62.8 },
    { size: 26, perimeterDiameterMin: 20.0, perimeterDiameterMax: 23.0, areaMin: 314, areaMax: 415, perimeterMin: 62.8, perimeterMax: 72.3 },
    { size: 29, perimeterDiameterMin: 23.0, perimeterDiameterMax: 26.0, areaMin: 415, areaMax: 531, perimeterMin: 72.3, perimeterMax: 81.7 },
    { size: 34, perimeterDiameterMin: 26.0, perimeterDiameterMax: 30.0, areaMin: 531, areaMax: 707, perimeterMin: 81.7, perimeterMax: 94.2 },
  ],
};

export const VALVE_FAMILIES: ValveFamily[] = [sapien3Ultra, evolutFX];

export interface ValveSizeRecommendation {
  family: ValveFamily;
  primarySize: ValveSize | null;
  alternativeSize: ValveSize | null;
  /** 'oversized' | 'undersized' | 'in-range' | 'out-of-range' */
  fitStatus: string;
  /** Cover index: (prosthesis_diameter - annulus_diameter) / prosthesis_diameter × 100 */
  coverIndex?: number;
  /** Oversizing percentage: (prosthesis_area / annulus_area - 1) × 100 */
  oversizingPct?: number;
  /** Sizing warning message */
  sizingWarning?: string;
}

/**
 * Given annular measurements, recommend valve sizes for each family.
 * Uses perimeter-derived diameter as the primary sizing criterion
 * (industry standard), with area as a secondary check.
 */
export function recommendValveSizes(
  perimeterMm: number,
  areaMm2: number,
): ValveSizeRecommendation[] {
  const perimDiameter = perimeterMm / Math.PI;

  return VALVE_FAMILIES.map((family) => {
    let primarySize: ValveSize | null = null;
    let alternativeSize: ValveSize | null = null;
    let fitStatus = 'out-of-range';

    for (const vs of family.sizes) {
      if (perimDiameter >= vs.perimeterDiameterMin && perimDiameter <= vs.perimeterDiameterMax) {
        primarySize = vs;
        fitStatus = 'in-range';
        break;
      }
    }

    // If no exact perimeter match, find closest
    if (!primarySize) {
      const allSizes = family.sizes;
      const smallest = allSizes[0];
      const largest = allSizes[allSizes.length - 1];

      if (perimDiameter < smallest.perimeterDiameterMin) {
        primarySize = smallest;
        fitStatus = 'undersized';
      } else if (perimDiameter > largest.perimeterDiameterMax) {
        primarySize = largest;
        fitStatus = 'oversized';
      }
    }

    // Find alternative (adjacent size)
    if (primarySize) {
      const idx = family.sizes.indexOf(primarySize);
      // If near the upper boundary, suggest next size up
      if (perimDiameter > (primarySize.perimeterDiameterMin + primarySize.perimeterDiameterMax) / 2) {
        if (idx < family.sizes.length - 1) alternativeSize = family.sizes[idx + 1];
      } else {
        if (idx > 0) alternativeSize = family.sizes[idx - 1];
      }
    }

    // Compute Cover Index and Oversizing percentage
    let coverIndex: number | undefined;
    let oversizingPct: number | undefined;
    let sizingWarning: string | undefined;

    if (primarySize) {
      // Cover Index = (nominal_valve_diameter - annulus_perimeter_diameter) / nominal_valve_diameter × 100
      coverIndex = ((primarySize.size - perimDiameter) / primarySize.size) * 100;

      // Area-based oversizing: (valve_nominal_area / patient_area - 1) × 100
      const valveNominalArea = Math.PI * (primarySize.size / 2) ** 2;
      oversizingPct = (valveNominalArea / areaMm2 - 1) * 100;

      // Warnings
      if (coverIndex < 0) {
        sizingWarning = `Undersized: Cover Index ${coverIndex.toFixed(1)}% (negative). Risk of embolization and PVL.`;
      } else if (coverIndex > 20) {
        sizingWarning = `Oversized: Cover Index ${coverIndex.toFixed(1)}%. Risk of annular rupture and conduction disturbance.`;
      } else if (family.type === 'balloon-expandable' && oversizingPct > 20) {
        sizingWarning = `Area oversizing ${oversizingPct.toFixed(0)}% >20%. Consider self-expanding alternative.`;
      } else if (family.type === 'self-expanding' && oversizingPct > 25) {
        sizingWarning = `Area oversizing ${oversizingPct.toFixed(0)}% >25%. Risk of conduction disturbance.`;
      }
    }

    return { family, primarySize, alternativeSize, fitStatus, coverIndex, oversizingPct, sizingWarning };
  });
}

/**
 * Risk thresholds based on TAVR literature and the procedural manual.
 */
export interface TAVRRiskAssessment {
  coronaryObstructionRisk: 'low' | 'moderate' | 'high';
  coronaryObstructionNote: string;
  conductionDisturbanceRisk: 'low' | 'moderate' | 'high';
  conductionDisturbanceNote: string;
  annularRuptureRisk: 'low' | 'moderate' | 'high';
  annularRuptureNote: string;
}

/**
 * BAV (Bicuspid Aortic Valve) detection helper.
 * Returns warning if annulus eccentricity suggests BAV anatomy.
 */
export function assessBAVRisk(eccentricity: number, minDiameterMm: number, maxDiameterMm: number): {
  isSuspectedBAV: boolean;
  bavWarning: string;
} {
  // BAV typically shows high eccentricity (>0.25) and large min/max diameter ratio
  const ratio = maxDiameterMm / Math.max(minDiameterMm, 1);
  if (eccentricity > 0.25 || ratio > 1.3) {
    return {
      isSuspectedBAV: true,
      bavWarning: `High eccentricity (${eccentricity.toFixed(2)}, ratio ${ratio.toFixed(2)}) — consider bicuspid aortic valve (BAV). BAV requires specialized sizing: use intercommissural distance, evaluate raphe position, and consider self-expanding valve platform.`,
    };
  }
  return { isSuspectedBAV: false, bavWarning: '' };
}

/**
 * Compute pacemaker risk score (0-10 scale) based on multiple factors.
 * Higher score = higher risk of needing permanent pacemaker post-TAVR.
 */
export function computePacemakerRiskScore(params: {
  membranousSeptumLengthMm?: number | null;
  implantDepthMm?: number | null;
  isSelfExpanding: boolean;
  hasPreExistingRBBB?: boolean;
}): { score: number; factors: string[] } {
  let score = 0;
  const factors: string[] = [];

  if (params.membranousSeptumLengthMm != null) {
    if (params.membranousSeptumLengthMm < 2) { score += 4; factors.push('Very short MS (<2mm)'); }
    else if (params.membranousSeptumLengthMm < 4) { score += 3; factors.push('Short MS (<4mm)'); }
    else if (params.membranousSeptumLengthMm < 6) { score += 1; factors.push('Borderline MS (4-6mm)'); }
  }

  if (params.implantDepthMm != null) {
    // Deeper implant = higher risk (>6mm considered deep)
    if (params.implantDepthMm > 8) { score += 3; factors.push('Deep implant (>8mm)'); }
    else if (params.implantDepthMm > 6) { score += 2; factors.push('Moderate depth (6-8mm)'); }
  }

  if (params.isSelfExpanding) { score += 1; factors.push('Self-expanding valve'); }
  if (params.hasPreExistingRBBB) { score += 2; factors.push('Pre-existing RBBB'); }

  return { score: Math.min(score, 10), factors };
}

export function assessTAVRRisks(params: {
  leftCoronaryHeightMm?: number | null;
  rightCoronaryHeightMm?: number | null;
  membranousSeptumLengthMm?: number | null;
  annulusCalcificationGrade: number;
  cuspCalcificationGrade: number;
  sinusWidthMm?: number | null;
  perimeterDerivedDiameterMm?: number | null;
}): TAVRRiskAssessment {
  // Coronary obstruction risk
  let coronaryRisk: 'low' | 'moderate' | 'high' = 'low';
  let coronaryNote = 'Coronary heights adequate';

  const minCoronaryHeight = Math.min(
    params.leftCoronaryHeightMm ?? 999,
    params.rightCoronaryHeightMm ?? 999,
  );

  // Combined coronary + SOV assessment
  const hasNarrowSOV = params.sinusWidthMm != null && params.sinusWidthMm < 30;

  if (minCoronaryHeight < 10) {
    coronaryRisk = 'high';
    coronaryNote = `Coronary height <10mm (${minCoronaryHeight.toFixed(1)}mm)`;
    if (hasNarrowSOV) coronaryNote += ` + narrow SOV (${params.sinusWidthMm!.toFixed(0)}mm)`;
    coronaryNote += ' — high risk of coronary obstruction. Consider BASILICA or coronary protection strategy.';
  } else if (minCoronaryHeight < 12 || (minCoronaryHeight < 14 && hasNarrowSOV)) {
    coronaryRisk = 'moderate';
    coronaryNote = `Coronary height ${minCoronaryHeight.toFixed(1)}mm`;
    if (hasNarrowSOV) coronaryNote += `, SOV ${params.sinusWidthMm!.toFixed(0)}mm`;
    coronaryNote += ' — evaluate leaflet length and calcification for obstruction risk.';
  }

  // Conduction disturbance risk (based on membranous septum length)
  let conductionRisk: 'low' | 'moderate' | 'high' = 'low';
  let conductionNote = 'Membranous septum not measured';

  if (params.membranousSeptumLengthMm != null) {
    if (params.membranousSeptumLengthMm < 4) {
      conductionRisk = 'high';
      conductionNote = `Short membranous septum (${params.membranousSeptumLengthMm.toFixed(1)}mm <4mm) — high risk of post-procedural heart block. Consider temporary pacemaker standby.`;
    } else if (params.membranousSeptumLengthMm < 6) {
      conductionRisk = 'moderate';
      conductionNote = `Membranous septum ${params.membranousSeptumLengthMm.toFixed(1)}mm — moderate conduction risk. Monitor post-implant.`;
    } else {
      conductionNote = `Membranous septum ${params.membranousSeptumLengthMm.toFixed(1)}mm — low conduction risk.`;
    }
  }

  // Annular rupture risk
  let ruptureRisk: 'low' | 'moderate' | 'high' = 'low';
  let ruptureNote = 'Standard risk profile';

  if (params.annulusCalcificationGrade >= 3) {
    ruptureRisk = 'high';
    ruptureNote = 'Severe annular calcification — elevated risk of annular rupture with balloon-expandable valves. Consider self-expanding platform.';
  } else if (params.annulusCalcificationGrade >= 2 && params.cuspCalcificationGrade >= 2) {
    ruptureRisk = 'moderate';
    ruptureNote = 'Moderate annular + cusp calcification — careful sizing and gradual balloon inflation recommended.';
  }

  return {
    coronaryObstructionRisk: coronaryRisk,
    coronaryObstructionNote: coronaryNote,
    conductionDisturbanceRisk: conductionRisk,
    conductionDisturbanceNote: conductionNote,
    annularRuptureRisk: ruptureRisk,
    annularRuptureNote: ruptureNote,
  };
}
