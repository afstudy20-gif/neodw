// Lesion volume + follow-up growth metrics.
//
// Pure helpers for estimating a lesion's volume from caliper diameters and
// quantifying interval change between two studies (follow-up). Volumes in mm³;
// convenience mL conversion provided.

const MM3_PER_ML = 1000;

/** Sphere volume from a single diameter: V = π·d³/6 (mm³). */
export function sphereVolumeFromDiameterMm(diameterMm: number): number {
  const d = Math.max(0, diameterMm);
  return (Math.PI * d * d * d) / 6;
}

/**
 * Ellipsoid volume from up to three orthogonal diameters: V = π/6·a·b·c.
 * With two diameters, the third defaults to the smaller of the two (a prolate
 * estimate from an axial measurement), matching common 2-axis lesion sizing.
 */
export function ellipsoidVolumeMm3(d1Mm: number, d2Mm: number, d3Mm?: number): number {
  const a = Math.max(0, d1Mm);
  const b = Math.max(0, d2Mm);
  const c = d3Mm != null ? Math.max(0, d3Mm) : Math.min(a, b);
  return (Math.PI / 6) * a * b * c;
}

/** mm³ → mL. */
export function mlFromMm3(mm3: number): number {
  return mm3 / MM3_PER_ML;
}

export interface VolumeChange {
  deltaMm3: number;
  /** (v2 − v1) / v1 × 100; null when v1 is 0. */
  percentChange: number | null;
  /** v2 / v1; null when v1 is 0. */
  foldChange: number | null;
}

/** Interval volume change between a baseline (v1) and follow-up (v2). */
export function volumeChange(v1Mm3: number, v2Mm3: number): VolumeChange {
  const deltaMm3 = v2Mm3 - v1Mm3;
  if (v1Mm3 <= 0) {
    return { deltaMm3, percentChange: null, foldChange: null };
  }
  return {
    deltaMm3,
    percentChange: (deltaMm3 / v1Mm3) * 100,
    foldChange: v2Mm3 / v1Mm3,
  };
}

/**
 * Volume doubling time (days) from two volumes `daysApart` apart:
 *   VDT = daysApart · ln(2) / ln(v2/v1).
 * Returns null for non-growth (v2 ≤ v1) or invalid inputs (the formula is only
 * meaningful for monotonic growth).
 */
export function doublingTimeDays(v1Mm3: number, v2Mm3: number, daysApart: number): number | null {
  if (v1Mm3 <= 0 || v2Mm3 <= 0 || daysApart <= 0) return null;
  if (v2Mm3 <= v1Mm3) return null;
  return (daysApart * Math.LN2) / Math.log(v2Mm3 / v1Mm3);
}
