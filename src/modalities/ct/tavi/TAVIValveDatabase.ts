/**
 * TAVR prosthesis sizing database.
 *
 * Sizing ranges are derived from manufacturer IFU charts:
 * - Edwards Sapien 3 / Sapien 3 Ultra (balloon-expandable)
 * - Medtronic Evolut FX / Evolut PRO+ (self-expanding)
 * - Boston Scientific ACURATE neo2 (self-expanding)
 * - Abbott Navitor (self-expanding)
 * - Meril Myval (balloon-expandable)
 *
 * Each entry maps an annular measurement range to a valve size.
 * The "recommended" flag indicates the best-fit size; adjacent sizes
 * are listed as alternatives when the patient sits at a boundary.
 *
 * ⚠ CLINICAL SAFETY: the numeric ranges below are nominal/typical values
 * assembled from manufacturer literature and TAVI sizing references. IFU
 * revisions differ by region (US/CE). They MUST be independently verified
 * against the current, region-specific manufacturer Instructions-For-Use
 * before any clinical use. Research use only — not for clinical decisions.
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
  /** Expandable delivery-sheath outer diameter (mm). IFU reference — verify. */
  sheathOuterDiameterMm?: number;
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
    { size: 20, perimeterDiameterMin: 18.0, perimeterDiameterMax: 20.5, areaMin: 254, areaMax: 330, perimeterMin: 56.5, perimeterMax: 64.4, sheathOuterDiameterMm: 6.0 },
    { size: 23, perimeterDiameterMin: 20.5, perimeterDiameterMax: 23.5, areaMin: 330, areaMax: 434, perimeterMin: 64.4, perimeterMax: 73.9, sheathOuterDiameterMm: 6.0 },
    { size: 26, perimeterDiameterMin: 23.5, perimeterDiameterMax: 26.5, areaMin: 434, areaMax: 552, perimeterMin: 73.9, perimeterMax: 83.3, sheathOuterDiameterMm: 6.0 },
    { size: 29, perimeterDiameterMin: 26.5, perimeterDiameterMax: 29.5, areaMin: 552, areaMax: 683, perimeterMin: 83.3, perimeterMax: 92.7, sheathOuterDiameterMm: 6.7 },
  ],
};

// Medtronic Evolut FX / Evolut PRO+
const evolutFX: ValveFamily = {
  name: 'Evolut FX',
  manufacturer: 'Medtronic',
  type: 'self-expanding',
  sizes: [
    { size: 23, perimeterDiameterMin: 18.0, perimeterDiameterMax: 20.0, areaMin: 254, areaMax: 314, perimeterMin: 56.5, perimeterMax: 62.8, sheathOuterDiameterMm: 6.0 },
    { size: 26, perimeterDiameterMin: 20.0, perimeterDiameterMax: 23.0, areaMin: 314, areaMax: 415, perimeterMin: 62.8, perimeterMax: 72.3, sheathOuterDiameterMm: 6.0 },
    { size: 29, perimeterDiameterMin: 23.0, perimeterDiameterMax: 26.0, areaMin: 415, areaMax: 531, perimeterMin: 72.3, perimeterMax: 81.7, sheathOuterDiameterMm: 6.0 },
    { size: 34, perimeterDiameterMin: 26.0, perimeterDiameterMax: 30.0, areaMin: 531, areaMax: 707, perimeterMin: 81.7, perimeterMax: 94.2, sheathOuterDiameterMm: 6.7 },
  ],
};

// Edwards SAPIEN 3 (non-Ultra), balloon-expandable
const sapien3: ValveFamily = {
  name: 'Sapien 3',
  manufacturer: 'Edwards Lifesciences',
  type: 'balloon-expandable',
  sizes: [
    { size: 20, perimeterDiameterMin: 18.6, perimeterDiameterMax: 20.9, areaMin: 273, areaMax: 345, perimeterMin: 58.6, perimeterMax: 65.8, sheathOuterDiameterMm: 6.0 },
    { size: 23, perimeterDiameterMin: 20.7, perimeterDiameterMax: 23.4, areaMin: 338, areaMax: 430, perimeterMin: 65.2, perimeterMax: 73.5, sheathOuterDiameterMm: 6.0 },
    { size: 26, perimeterDiameterMin: 23.4, perimeterDiameterMax: 26.3, areaMin: 430, areaMax: 546, perimeterMin: 73.5, perimeterMax: 82.8, sheathOuterDiameterMm: 6.0 },
    { size: 29, perimeterDiameterMin: 26.2, perimeterDiameterMax: 29.5, areaMin: 540, areaMax: 683, perimeterMin: 82.4, perimeterMax: 92.7, sheathOuterDiameterMm: 6.7 },
  ],
};

// Medtronic Evolut PRO+, self-expanding
const evolutProPlus: ValveFamily = {
  name: 'Evolut PRO+',
  manufacturer: 'Medtronic',
  type: 'self-expanding',
  sizes: [
    { size: 23, perimeterDiameterMin: 18.0, perimeterDiameterMax: 20.0, areaMin: 254, areaMax: 314, perimeterMin: 56.5, perimeterMax: 62.8, sheathOuterDiameterMm: 6.0 },
    { size: 26, perimeterDiameterMin: 20.0, perimeterDiameterMax: 23.0, areaMin: 314, areaMax: 415, perimeterMin: 62.8, perimeterMax: 72.3, sheathOuterDiameterMm: 6.0 },
    { size: 29, perimeterDiameterMin: 23.0, perimeterDiameterMax: 26.0, areaMin: 415, areaMax: 531, perimeterMin: 72.3, perimeterMax: 81.7, sheathOuterDiameterMm: 6.0 },
    { size: 34, perimeterDiameterMin: 26.0, perimeterDiameterMax: 30.0, areaMin: 531, areaMax: 707, perimeterMin: 81.7, perimeterMax: 94.2, sheathOuterDiameterMm: 6.7 },
  ],
};

// Boston Scientific ACURATE neo2, self-expanding (labels S/M/L → 23/25/27)
const acurateNeo2: ValveFamily = {
  name: 'ACURATE neo2',
  manufacturer: 'Boston Scientific',
  type: 'self-expanding',
  sizes: [
    { size: 23, perimeterDiameterMin: 21.0, perimeterDiameterMax: 23.0, areaMin: 346, areaMax: 415, perimeterMin: 66.0, perimeterMax: 72.3, sheathOuterDiameterMm: 6.0 },
    { size: 25, perimeterDiameterMin: 23.0, perimeterDiameterMax: 25.0, areaMin: 415, areaMax: 491, perimeterMin: 72.3, perimeterMax: 78.5, sheathOuterDiameterMm: 6.0 },
    { size: 27, perimeterDiameterMin: 25.0, perimeterDiameterMax: 27.0, areaMin: 491, areaMax: 573, perimeterMin: 78.5, perimeterMax: 84.8, sheathOuterDiameterMm: 6.5 },
  ],
};

// Abbott Navitor, self-expanding
const navitor: ValveFamily = {
  name: 'Navitor',
  manufacturer: 'Abbott',
  type: 'self-expanding',
  sizes: [
    { size: 23, perimeterDiameterMin: 19.0, perimeterDiameterMax: 21.0, areaMin: 284, areaMax: 346, perimeterMin: 59.7, perimeterMax: 66.0, sheathOuterDiameterMm: 6.0 },
    { size: 25, perimeterDiameterMin: 21.0, perimeterDiameterMax: 23.0, areaMin: 346, areaMax: 415, perimeterMin: 66.0, perimeterMax: 72.3, sheathOuterDiameterMm: 6.0 },
    { size: 27, perimeterDiameterMin: 23.0, perimeterDiameterMax: 25.0, areaMin: 415, areaMax: 491, perimeterMin: 72.3, perimeterMax: 78.5, sheathOuterDiameterMm: 6.5 },
    { size: 29, perimeterDiameterMin: 25.0, perimeterDiameterMax: 27.0, areaMin: 491, areaMax: 573, perimeterMin: 78.5, perimeterMax: 84.8, sheathOuterDiameterMm: 6.5 },
  ],
};

// Meril Myval / Myval Octacor (balloon-expandable). Myval's distinguishing
// feature is its fine size matrix: conventional (20/23/26/29), intermediate
// (21.5/24.5/27.5) and extra-large (30.5/32) sizes. The annular bands below are
// contiguous 1.5 mm perimeter-diameter steps with area/perimeter kept internally
// consistent (perimeter = π·d, area = π·d²/4). ⚠ These intermediate bands are
// interpolated — verify against the current Meril Navigator / IFU matrix before
// clinical use (see the file-level safety note).
const myval: ValveFamily = {
  name: 'Myval',
  manufacturer: 'Meril Life Sciences',
  type: 'balloon-expandable',
  sizes: [
    { size: 20.0, perimeterDiameterMin: 18.0, perimeterDiameterMax: 19.5, areaMin: 254, areaMax: 299, perimeterMin: 56.5, perimeterMax: 61.3, sheathOuterDiameterMm: 6.0 },
    { size: 21.5, perimeterDiameterMin: 19.5, perimeterDiameterMax: 21.0, areaMin: 299, areaMax: 346, perimeterMin: 61.3, perimeterMax: 66.0, sheathOuterDiameterMm: 6.0 },
    { size: 23.0, perimeterDiameterMin: 21.0, perimeterDiameterMax: 22.5, areaMin: 346, areaMax: 398, perimeterMin: 66.0, perimeterMax: 70.7, sheathOuterDiameterMm: 6.0 },
    { size: 24.5, perimeterDiameterMin: 22.5, perimeterDiameterMax: 24.0, areaMin: 398, areaMax: 452, perimeterMin: 70.7, perimeterMax: 75.4, sheathOuterDiameterMm: 6.0 },
    { size: 26.0, perimeterDiameterMin: 24.0, perimeterDiameterMax: 25.5, areaMin: 452, areaMax: 511, perimeterMin: 75.4, perimeterMax: 80.1, sheathOuterDiameterMm: 6.5 },
    { size: 27.5, perimeterDiameterMin: 25.5, perimeterDiameterMax: 27.0, areaMin: 511, areaMax: 573, perimeterMin: 80.1, perimeterMax: 84.8, sheathOuterDiameterMm: 6.5 },
    { size: 29.0, perimeterDiameterMin: 27.0, perimeterDiameterMax: 28.5, areaMin: 573, areaMax: 638, perimeterMin: 84.8, perimeterMax: 89.5, sheathOuterDiameterMm: 6.5 },
    { size: 30.5, perimeterDiameterMin: 28.5, perimeterDiameterMax: 30.0, areaMin: 638, areaMax: 707, perimeterMin: 89.5, perimeterMax: 94.2, sheathOuterDiameterMm: 6.5 },
    { size: 32.0, perimeterDiameterMin: 30.0, perimeterDiameterMax: 31.5, areaMin: 707, areaMax: 779, perimeterMin: 94.2, perimeterMax: 99.0, sheathOuterDiameterMm: 6.5 },
  ],
};

export const VALVE_FAMILIES: ValveFamily[] = [
  sapien3,
  sapien3Ultra,
  evolutFX,
  evolutProPlus,
  acurateNeo2,
  navitor,
  myval,
];

/**
 * Resolve a user selection (family name + nominal size) back to its family and
 * size entries in VALVE_FAMILIES. Returns null when the selection no longer
 * matches the database (e.g. after a vendor rename / IFU revision). Used by the
 * virtual deployment view and device-type-aware risk scoring.
 */
export function resolveSelectedValve(
  familyName: string,
  sizeMm: number,
): { family: ValveFamily; size: ValveSize } | null {
  const family = VALVE_FAMILIES.find((f) => f.name === familyName);
  if (!family) return null;
  // Match on exact nominal size label. Myval uses 0.5mm increments, so a small
  // epsilon guards against float compare noise.
  const size = family.sizes.find(
    (s) => Math.abs(s.size - sizeMm) < 0.01,
  );
  if (!size) return null;
  return { family, size };
}

export interface ValveSizeRecommendation {
  family: ValveFamily;
  primarySize: ValveSize | null;
  alternativeSize: ValveSize | null;
  /** 'oversized' | 'undersized' | 'in-range' | 'out-of-range' */
  fitStatus: string;
  /** Cover index: (prosthesis_diameter - annulus_diameter) / prosthesis_diameter × 100 */
  coverIndex?: number;
  /**
   * Headline oversizing percentage, computed by the metric the manufacturer
   * sizes the device with: AREA for balloon-expandable (Edwards/Meril),
   * PERIMETER for self-expanding (Medtronic/Abbott/Boston). Mixing the two
   * inflates self-expanding oversizing roughly twofold (area scales with d²).
   */
  oversizingPct?: number;
  /** Which metric `oversizingPct` was computed from. */
  oversizingMetric?: 'area' | 'perimeter';
  /** Sizing warning message */
  sizingWarning?: string;
}

/**
 * Given annular measurements, recommend valve sizes for each family.
 *
 * Sizing criterion follows the manufacturer: balloon-expandable valves
 * (Edwards Sapien, Meril Myval) are sized by annular AREA; self-expanding
 * valves (Medtronic Evolut, Abbott Navitor, Boston ACURATE) by annular
 * PERIMETER. Oversizing is likewise reported in the matching metric — the two
 * are NOT interchangeable (area scales with diameter², so an area figure
 * roughly doubles the equivalent perimeter oversizing).
 */
export function recommendValveSizes(
  perimeterMm: number,
  areaMm2: number,
): ValveSizeRecommendation[] {
  const perimDiameter = perimeterMm / Math.PI;

  return VALVE_FAMILIES.map((family) => {
    const sizedByArea = family.type === 'balloon-expandable';
    const value = sizedByArea ? areaMm2 : perimDiameter;
    const lo = (vs: ValveSize) => (sizedByArea ? vs.areaMin : vs.perimeterDiameterMin);
    const hi = (vs: ValveSize) => (sizedByArea ? vs.areaMax : vs.perimeterDiameterMax);

    let primarySize: ValveSize | null = null;
    let alternativeSize: ValveSize | null = null;
    let fitStatus = 'out-of-range';

    for (const vs of family.sizes) {
      if (value >= lo(vs) && value <= hi(vs)) {
        primarySize = vs;
        fitStatus = 'in-range';
        break;
      }
    }

    // If no exact match, clamp to the nearest end of the family range.
    if (!primarySize) {
      const smallest = family.sizes[0];
      const largest = family.sizes[family.sizes.length - 1];
      if (value < lo(smallest)) {
        primarySize = smallest;
        fitStatus = 'undersized';
      } else if (value > hi(largest)) {
        primarySize = largest;
        fitStatus = 'oversized';
      }
    }

    // Find alternative (adjacent size), using the same sizing metric.
    if (primarySize) {
      const idx = family.sizes.indexOf(primarySize);
      if (value > (lo(primarySize) + hi(primarySize)) / 2) {
        if (idx < family.sizes.length - 1) alternativeSize = family.sizes[idx + 1];
      } else {
        if (idx > 0) alternativeSize = family.sizes[idx - 1];
      }
    }

    // Cover index + modality-appropriate oversizing.
    let coverIndex: number | undefined;
    let oversizingPct: number | undefined;
    let oversizingMetric: 'area' | 'perimeter' | undefined;
    let sizingWarning: string | undefined;

    if (primarySize) {
      // Cover index = (nominal device diameter − annulus perimeter-diameter) / device × 100.
      coverIndex = ((primarySize.size - perimDiameter) / primarySize.size) * 100;

      // Nominal device geometry from its label diameter.
      const areaOversizing = (Math.PI * (primarySize.size / 2) ** 2 / areaMm2 - 1) * 100;
      const perimeterOversizing = (Math.PI * primarySize.size / perimeterMm - 1) * 100;
      oversizingMetric = sizedByArea ? 'area' : 'perimeter';
      oversizingPct = sizedByArea ? areaOversizing : perimeterOversizing;

      // Warnings — dangerous directions only; "ideal" oversizing differs by
      // device family (e.g. Evolut targets ~20% perimeter, ACURATE far less),
      // so we do not flag merely-low oversizing.
      if (coverIndex < 0) {
        sizingWarning = `Undersized: cover index ${coverIndex.toFixed(1)}% (negative). Embolization / PVL risk.`;
      } else if (sizedByArea && areaOversizing > 20) {
        sizingWarning = `Area oversizing ${areaOversizing.toFixed(0)}% (>20%). Annular rupture risk; consider a self-expanding alternative.`;
      } else if (!sizedByArea && perimeterOversizing > 30) {
        sizingWarning = `Perimeter oversizing ${perimeterOversizing.toFixed(0)}% (>30%). Excess oversizing — rupture / conduction risk.`;
      }
    }

    return { family, primarySize, alternativeSize, fitStatus, coverIndex, oversizingPct, oversizingMetric, sizingWarning };
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

/**
 * Sheath-to-femoral-artery ratio (SFAR) cutoff. SFAR > 1.05 is the validated
 * threshold associated with increased major vascular complications in TAVR.
 */
export const SFAR_THRESHOLD = 1.05;

export interface SheathFitAssessment {
  sheathOuterDiameterMm: number;
  minLumenDiameterMm: number;
  /** marginMm = minLumenDiameterMm - sheathOuterDiameterMm */
  marginMm: number;
  /** SFAR = sheathOD / minLumen (dimensionless) */
  sfar: number;
  feasibility: 'feasible' | 'borderline' | 'unfavorable';
  note: string;
}

/**
 * Assess ilio-femoral access feasibility for a given sheath OD vs the minimum
 * lumen diameter along the access path. SFAR and absolute margin are both used;
 * heavy calcification escalates a borderline-by-SFAR case to unfavorable.
 */
export function assessSheathFit(
  minLumenDiameterMm: number,
  sheathOuterDiameterMm: number,
  hasModerateOrSevereCalcification: boolean
): SheathFitAssessment {
  const marginMm = minLumenDiameterMm - sheathOuterDiameterMm;
  const sfar = minLumenDiameterMm > 0 ? sheathOuterDiameterMm / minLumenDiameterMm : Infinity;

  let feasibility: 'feasible' | 'borderline' | 'unfavorable';
  let note: string;

  // SFAR > 1.05 is the validated cutoff. (A lumen narrower than the sheath
  // always yields SFAR > 1, but SFAR up to 1.05 is still considered borderline
  // rather than outright unfavorable, so we gate on SFAR only here.)
  if (sfar > SFAR_THRESHOLD) {
    feasibility = 'unfavorable';
    note = `Unfavorable access — SFAR ${sfar.toFixed(2)} (min lumen ${minLumenDiameterMm.toFixed(1)} mm vs sheath ${sheathOuterDiameterMm.toFixed(1)} mm). High vascular-complication risk; consider alternative access.`;
  } else if (sfar > 1.0 || marginMm < 1.0) {
    if (hasModerateOrSevereCalcification && sfar > 1.0) {
      feasibility = 'unfavorable';
      note = `Borderline SFAR ${sfar.toFixed(2)} with moderate/severe calcification — escalated to unfavorable. Consider alternative access.`;
    } else {
      feasibility = 'borderline';
      note = `Borderline access — SFAR ${sfar.toFixed(2)}, margin ${marginMm.toFixed(1)} mm. Heavy calcification or tortuosity raises complication risk.`;
    }
  } else {
    feasibility = 'feasible';
    note = `Feasible — SFAR ${sfar.toFixed(2)}, margin ${marginMm.toFixed(1)} mm.`;
  }

  return { sheathOuterDiameterMm, minLumenDiameterMm, marginMm, sfar, feasibility, note };
}
