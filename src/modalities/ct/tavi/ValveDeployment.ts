/**
 * Post-deployment metrics for the virtual valve simulation.
 *
 * These are advisory geometric/rule-based indicators — NOT finite-element
 * predictions. They answer the questions an operator asks when eyeballing a
 * 3mensio-style deployment preview:
 *   1. How much does the frame cover / oversize the annulus? (cover index)
 *   2. Will the outflow rim sit below the coronary ostia? (obstruction check)
 *   3. Given annular eccentricity + calcium + oversizing, is PVL likely?
 *
 * All inputs come from the already-captured TAVI session; nothing here
 * re-derives anatomy. Research use only — see TAVIValveDatabase disclaimer.
 */

import type { ValveFamily, ValveSize } from './TAVIValveDatabase';

export interface DeploymentCoronaryCheck {
  side: 'left' | 'right';
  /** Coronary ostium height above the annular plane, mm. */
  ostiumHeightMm: number;
  /** Height of the frame's outflow rim above the annular plane, mm.
   *  Negative values are impossible for a normally-placed frame. */
  frameOutflowHeightMm: number;
  /** Vertical clearance between the ostium and the frame rim, mm.
   *  Positive = ostium above the rim (safe); negative = rim above the ostium
   *  (leaflets / frame cells may obstruct coronary flow). */
  clearanceMm: number;
  /** 'low' | 'moderate' | 'high' obstruction risk for this side. */
  risk: 'low' | 'moderate' | 'high';
}

export interface PVLIndicator {
  /** 0–100 ordinal PVL risk score (higher = more likely). Rule-based, not
   *  validated against outcomes. */
  score: number;
  /** 'low' | 'moderate' | 'high' band derived from score thresholds. */
  band: 'low' | 'moderate' | 'high';
  /** Human-readable factors that contributed. */
  factors: string[];
}

export interface DeploymentResult {
  /** Cover index: (prosthesis − annulus) / prosthesis × 100, %.
   *  Manufacturer sizing metric (area for BE, perimeter-diameter for SE). */
  coverIndexPct: number;
  /** Oversizing in the manufacturer sizing metric, %. */
  oversizingPct: number;
  /** Which metric oversizing was computed in. */
  oversizingMetric: 'area' | 'perimeter';
  /** Per-side coronary clearance checks. */
  coronary: DeploymentCoronaryCheck[];
  /** Rule-based paravalvular-leak indicator. */
  pvl: PVLIndicator;
}

/**
 * Compute the full deployment result for a selected prosthesis placed against a
 * measured annulus.
 *
 * @param family    Selected valve family (determines sizing metric + frame type)
 * @param size      Selected nominal size
 * @param annulus   Measured annulus geometry { perimeterMm, areaMm2, min/max diam }
 * @param frameOutflowHeightMm  Height of the frame outflow rim above annulus
 * @param coronaryHeights        LCA/RCA ostium heights above annulus (mm)
 * @param calciumGrades          Annular + aggregate cusp calcification grades (0–3)
 */
export function computeDeploymentResult(params: {
  family: ValveFamily;
  size: ValveSize;
  annulus: { perimeterMm: number; areaMm2: number; minimumDiameterMm: number; maximumDiameterMm: number };
  frameOutflowHeightMm: number;
  coronaryHeights: { left?: number | null; right?: number | null };
  calciumGrades: { annulus: number; cusp: number };
}): DeploymentResult {
  const { family, size, annulus, frameOutflowHeightMm, coronaryHeights, calciumGrades } = params;

  const sizedByArea = family.type === 'balloon-expandable';
  const perimDiameter = annulus.perimeterMm / Math.PI;

  const coverIndexPct = ((size.size - perimDiameter) / size.size) * 100;
  const areaOversizing = (Math.PI * (size.size / 2) ** 2 / annulus.areaMm2 - 1) * 100;
  const perimeterOversizing = (Math.PI * size.size / annulus.perimeterMm - 1) * 100;
  const oversizingMetric: 'area' | 'perimeter' = sizedByArea ? 'area' : 'perimeter';
  const oversizingPct = sizedByArea ? areaOversizing : perimeterOversizing;

  // Coronary clearance: a side is at risk when the frame rim rises above the
  // ostium. Self-expanding frames reach higher than short balloon-expandable
  // ones, so frameOutflowHeightMm already encodes the device geometry.
  const coronary: DeploymentCoronaryCheck[] = [];
  (['left', 'right'] as const).forEach((side) => {
    const ostiumHeightMm = side === 'left' ? coronaryHeights.left : coronaryHeights.right;
    if (ostiumHeightMm == null) return;
    const clearanceMm = ostiumHeightMm - frameOutflowHeightMm;
    let risk: 'low' | 'moderate' | 'high' = 'low';
    if (clearanceMm < 0) risk = 'high';
    else if (clearanceMm < 3) risk = 'moderate';
    coronary.push({ side, ostiumHeightMm, frameOutflowHeightMm, clearanceMm, risk });
  });

  // PVL indicator — rule-based composite. Inputs that raise PVL risk:
  //  - undersizing / negative cover index (poor seal)
  //  - high annular eccentricity (gaps on the minor axis)
  //  - heavy annular or cusp calcium (prevents circumferential apposition)
  const factors: string[] = [];
  let score = 0;
  if (coverIndexPct < 0) {
    score += 35;
    factors.push(`Undersized frame (CI ${coverIndexPct.toFixed(0)}%) — poor circumferential seal`);
  } else if (coverIndexPct < 5) {
    score += 15;
    factors.push(`Borderline cover index (${coverIndexPct.toFixed(0)}%)`);
  }

  const ecc = annulus.maximumDiameterMm > 0
    ? 1 - annulus.minimumDiameterMm / annulus.maximumDiameterMm
    : 0;
  if (ecc > 0.35) {
    score += 25;
    factors.push(`Highly elliptical annulus (ecc ${ecc.toFixed(2)}) — minor-axis gap risk`);
  } else if (ecc > 0.25) {
    score += 12;
    factors.push(`Moderate eccentricity (${ecc.toFixed(2)})`);
  }

  if (calciumGrades.annulus >= 3) {
    score += 25;
    factors.push('Severe annular calcification');
  } else if (calciumGrades.annulus >= 2) {
    score += 12;
    factors.push('Moderate annular calcification');
  }
  if (calciumGrades.cusp >= 2) {
    score += 8;
    factors.push('Moderate–severe cusp calcification');
  }

  score = Math.min(100, score);
  const band: 'low' | 'moderate' | 'high' = score >= 45 ? 'high' : score >= 20 ? 'moderate' : 'low';
  if (factors.length === 0) factors.push('No dominant PVL risk factor');

  return {
    coverIndexPct,
    oversizingPct,
    oversizingMetric,
    coronary,
    pvl: { score, band, factors },
  };
}
