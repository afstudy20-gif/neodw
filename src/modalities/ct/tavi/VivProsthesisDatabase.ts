/**
 * Surgical bioprosthesis database for Valve-in-Valve (ViV) / redo-TAVI planning.
 *
 * In ViV, a new transcatheter valve is deployed INSIDE a failing surgical (or
 * earlier transcatheter) bioprosthesis. Sizing is governed by the surgical
 * valve's TRUE INTERNAL DIAMETER (stent ID) — which is smaller than its label
 * size because the stent frame + leaflet tissue occupy space.
 *
 * The values below are nominal true-ID figures assembled from the VIVID
 * registry and published literature (see references). They exist to drive a
 * recognizable sizing + 3D-nested-frame workflow, NOT to replace the VIVID app
 * or manufacturer IFU.
 *
 * ⚠ CLINICAL SAFETY: these are unverified nominal values for a research
 * scaffold (README: "Not a medical device"). True IDs vary by generation,
 * measurement modality, and degeneration. Always cross-check against the
 * VIVID app and the specific valve's IFU before any clinical use.
 *
 * References:
 *  - VIVID registry / VIVID Calculator app (Bapat et al.)
 *  - JAMA Cardiol. 2017;2(5):517-524 (Bapat V, et al.)
 *  - EuroIntervention 2014 review on ViV TAVI
 */

export type SurgicalFrameProfile = 'perimount' | 'mosaic' | 'trifecta' | 'mitroflow' | 'generic';

export interface SurgicalBioprosthesis {
  /** Display name, e.g. "Perimount Magna Ease". */
  name: string;
  manufacturer: string;
  /** Stented valves have a visible radiopaque frame on CT (measurable ID);
   *  stentless do not. */
  stentType: 'stented' | 'stentless';
  /** Visual frame silhouette family for the nested 3D rendering. */
  frameProfile: SurgicalFrameProfile;
  /** Label size (mm) → true internal diameter (mm). Sources: VIVID published
   *  values. Keys are the manufacturer label sizes. */
  trueInnerDiameterMm: Record<number, number>;
  /** Whether bioprosthetic valve fracture (BVF) is generally reported as
   *  feasible for this platform (ring can be fractured to enlarge the ID). */
  bvfFeasible: boolean;
  /** Typical stent frame height (mm) — used by the 3D silhouette. */
  frameHeightMm: number;
}

/**
 * Common surgical aortic bioprostheses encountered in ViV TAVI. True IDs are
 * approximate published values; cover the most frequently implanted platforms.
 */
export const SURGICAL_BIOPROSTHESES: SurgicalBioprosthesis[] = [
  {
    name: 'Carpentier-Edwards Perimount Magna Ease',
    manufacturer: 'Edwards',
    stentType: 'stented',
    frameProfile: 'perimount',
    // True ID ~ label − 2 mm for Perimount family (Bapat/VIVID).
    trueInnerDiameterMm: { 19: 17, 21: 19, 23: 21, 25: 23, 27: 25, 29: 27 },
    bvfFeasible: true,
    frameHeightMm: 19,
  },
  {
    name: 'Carpentier-Edwards Perimount Theon',
    manufacturer: 'Edwards',
    stentType: 'stented',
    frameProfile: 'perimount',
    trueInnerDiameterMm: { 19: 17, 21: 18, 23: 20, 25: 22, 27: 24, 29: 26 },
    bvfFeasible: true,
    frameHeightMm: 20,
  },
  {
    name: 'Medtronic Mosaic',
    manufacturer: 'Medtronic',
    stentType: 'stented',
    frameProfile: 'mosaic',
    // Mosaic true IDs are among the smallest (notoriously restrictive for ViV).
    trueInnerDiameterMm: { 21: 18, 23: 19, 25: 21, 27: 22, 29: 24 },
    bvfFeasible: true,
    frameHeightMm: 20,
  },
  {
    name: 'Medtronic Hancock II',
    manufacturer: 'Medtronic',
    stentType: 'stented',
    frameProfile: 'mosaic',
    trueInnerDiameterMm: { 21: 17, 23: 19, 25: 21, 27: 22 },
    bvfFeasible: false,
    frameHeightMm: 21,
  },
  {
    name: 'St. Jude Medical Trifecta',
    manufacturer: 'Abbott',
    stentType: 'stented',
    frameProfile: 'trifecta',
    trueInnerDiameterMm: { 19: 17, 21: 19, 23: 21, 25: 23, 27: 25, 29: 27 },
    bvfFeasible: true,
    frameHeightMm: 20,
  },
  {
    name: 'St. Jude Medical Epic',
    manufacturer: 'Abbott',
    stentType: 'stented',
    frameProfile: 'trifecta',
    trueInnerDiameterMm: { 19: 16, 21: 18, 23: 20, 25: 22, 27: 24, 29: 26 },
    bvfFeasible: false,
    frameHeightMm: 21,
  },
  {
    name: 'Sorin Mitroflow LX',
    manufacturer: 'Sorin / LivaNova',
    stentType: 'stented',
    frameProfile: 'mitroflow',
    trueInnerDiameterMm: { 19: 17, 21: 18, 23: 20, 25: 22, 27: 23, 29: 25 },
    bvfFeasible: true,
    frameHeightMm: 18,
  },
  {
    name: 'LivaNova Soprano Armonia',
    manufacturer: 'LivaNova',
    stentType: 'stented',
    frameProfile: 'mitroflow',
    trueInnerDiameterMm: { 19: 17, 21: 18, 23: 20, 25: 22, 27: 23 },
    bvfFeasible: true,
    frameHeightMm: 19,
  },
];

/** Resolve a surgical bioprosthesis by name. */
export function resolveSurgicalBioprosthesis(name: string): SurgicalBioprosthesis | undefined {
  return SURGICAL_BIOPROSTHESES.find((b) => b.name === name);
}

export type VivFitStatus = 'fits' | 'easy' | 'tight' | 'no';

export interface VivValveRecommendation {
  /** TAVI valve family name (matches VALVE_FAMILIES in TAVIValveDatabase). */
  familyName: string;
  /** TAVI valve type, drives the sizing metric. */
  type: 'balloon-expandable' | 'self-expanding';
  /** Recommended TAVI label size, mm. */
  sizeMm: number;
  /** (TAVI outer − surgical inner) / surgical inner × 100, %.
   *  ViV typically targets 0–5% — too much oversizing prevents full TAVI
   *  expansion and raises residual gradients. */
  coverIndexPct: number;
  /** Fit assessment against the surgical inner diameter. */
  fitStatus: VivFitStatus;
  /** Human-readable note, e.g. sizing/BVF guidance. */
  note: string;
}

/**
 * Recommend transcatheter valve sizes for a valve-in-valve procedure, given the
 * surgical bioprosthesis' true inner diameter.
 *
 * Sizing logic: the TAVI device's nominal outer diameter (≈ its label size)
 * should be close to the surgical inner diameter. We iterate candidate sizes
 * across all TAVI families and classify each:
 *  - fits: cover index within [0%, 5%]  (ideal ViV)
 *  - easy: cover index < 0% (TAVI smaller than the ID — undersized, may embolize)
 *  - tight: cover index within (5%, 10%] (mild oversizing, usually acceptable)
 *  - no: cover index > 10% (excessive oversizing — TAVI won't fully expand)
 *
 * @param innerDiameterMm  surgical true internal diameter (measured or DB)
 * @param families         TAVI families + their available sizes, from TAVIValveDatabase
 */
export function recommendVivValveSizes(
  innerDiameterMm: number,
  families: { name: string; type: 'balloon-expandable' | 'self-expanding'; sizes: number[] }[],
): VivValveRecommendation[] {
  const recs: VivValveRecommendation[] = [];
  for (const fam of families) {
    // Pick the candidate size whose label is closest to the inner diameter —
    // ViV is driven by the surgical ID, not the (native) annulus. Sort ascending
    // by distance from the ideal ~2.5% cover, so [0] is the closest fit.
    const best = fam.sizes
      .map((size) => ({ size, cover: ((size - innerDiameterMm) / innerDiameterMm) * 100 }))
      .sort((a, b) => Math.abs(a.cover - 2.5) - Math.abs(b.cover - 2.5))[0];
    if (!best) continue;

    let fitStatus: VivFitStatus = 'fits';
    let note = '';
    if (best.cover < 0) {
      fitStatus = 'easy';
      note = `Undersized — TAVI ${best.size}mm < surgical ID ${innerDiameterMm.toFixed(1)}mm; risk of device embolization / PVL`;
    } else if (best.cover <= 5) {
      fitStatus = 'fits';
      note = `Cover index ${best.cover.toFixed(1)}% — ideal ViV fit`;
    } else if (best.cover <= 10) {
      fitStatus = 'tight';
      note = `Cover index ${best.cover.toFixed(1)}% — mild oversizing; TAVI may not fully expand`;
    } else {
      fitStatus = 'no';
      note = `Cover index ${best.cover.toFixed(1)}% — excessive oversizing; high residual-gradient risk`;
    }

    recs.push({
      familyName: fam.name,
      type: fam.type,
      sizeMm: best.size,
      coverIndexPct: best.cover,
      fitStatus,
      note,
    });
  }
  // Sort by how close each is to the ideal ~2.5% cover index.
  return recs.sort((a, b) => Math.abs(a.coverIndexPct - 2.5) - Math.abs(b.coverIndexPct - 2.5));
}

/**
 * Bioprosthetic valve fracture (BVF) feasibility assessment for the chosen
 * surgical valve. Returns whether fracture is reported as feasible and the
 * estimated ID gain (mm) if performed — used to recommend a larger TAVI valve.
 */
export function assessBvf(bioprosthesis: SurgicalBioprosthesis, labelSize: number): {
  feasible: boolean;
  estimatedIdGainMm: number;
  note: string;
} {
  if (!bioprosthesis.bvfFeasible) {
    return { feasible: false, estimatedIdGainMm: 0, note: 'BVF not generally reported for this platform' };
  }
  // BVF typically adds ~2 mm to the true ID (fracturing the sewing ring).
  const gain = 2.0;
  return {
    feasible: true,
    estimatedIdGainMm: gain,
    note: `BVF feasible — may enlarge true ID by ~${gain} mm, permitting a larger TAVI valve`,
  };
}
