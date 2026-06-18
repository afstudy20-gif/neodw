/**
 * Endovascular graft sizing database (EVAR / TEVAR proximal main body).
 *
 * Mirrors the 3mensio Vascular "Templates" step (§3.7): vendor-specific stent
 * graft families used to size the proximal landing zone from the measured neck
 * (seal) diameter. Sizing rule: proximal body is over-sized ~10–25% over the
 * native neck; the smallest available body ≥ neck × (1 + minOversize) is chosen.
 *
 * ⚠ CLINICAL SAFETY: the available-size lists below are typical/nominal values
 * assembled from manufacturer literature. They MUST be independently verified
 * against the current, region-specific IFU before any clinical use. Oversizing
 * targets vary by device, neck quality and indication. Research use only.
 */

export interface GraftFamily {
  name: string;
  manufacturer: string;
  segment: 'AAA' | 'TAA';
  /** Available proximal main-body diameters (mm). */
  bodyDiametersMm: number[];
  /** Manufacturer-recommended native neck/landing range (mm). */
  neckMinMm: number;
  neckMaxMm: number;
}

const GRAFT_FAMILIES: GraftFamily[] = [
  { name: 'Endurant II/IIs', manufacturer: 'Medtronic', segment: 'AAA', bodyDiametersMm: [23, 25, 28, 32, 36], neckMinMm: 19, neckMaxMm: 32 },
  { name: 'Zenith Alpha AAA', manufacturer: 'Cook', segment: 'AAA', bodyDiametersMm: [22, 24, 26, 28, 30, 32, 36], neckMinMm: 18, neckMaxMm: 32 },
  { name: 'E-liac / E-xtra', manufacturer: 'Jotec (Artivion)', segment: 'AAA', bodyDiametersMm: [24, 28, 32, 36], neckMinMm: 20, neckMaxMm: 32 },
  { name: 'Zenith Alpha Thoracic', manufacturer: 'Cook', segment: 'TAA', bodyDiametersMm: [18, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46], neckMinMm: 15, neckMaxMm: 42 },
  { name: 'Valiant Navion', manufacturer: 'Medtronic', segment: 'TAA', bodyDiametersMm: [24, 28, 30, 34, 38, 40, 42, 46], neckMinMm: 18, neckMaxMm: 42 },
  { name: 'E-tegra', manufacturer: 'Jotec (Artivion)', segment: 'TAA', bodyDiametersMm: [24, 26, 28, 30, 33, 36, 40, 43, 46], neckMinMm: 19, neckMaxMm: 42 },
];

export interface GraftRecommendation {
  family: GraftFamily;
  bodyDiameterMm: number | null;
  oversizingPct: number | null;
  /** 'in-range' | 'undersized' | 'oversized' | 'out-of-range' */
  fitStatus: string;
  warning?: string;
}

/**
 * Recommend a proximal main-body size per family for a measured neck/seal
 * diameter. Targets ~10–25% oversizing; flags necks outside the device range or
 * oversizing that falls below 10% (seal risk) or above 25% (infolding risk).
 */
export function recommendGraftSizes(sealDiameterMm: number, segment?: 'AAA' | 'TAA'): GraftRecommendation[] {
  if (!Number.isFinite(sealDiameterMm) || sealDiameterMm <= 0) return [];
  const families = segment ? GRAFT_FAMILIES.filter((f) => f.segment === segment) : GRAFT_FAMILIES;
  const minTarget = sealDiameterMm * 1.10;

  return families.map((family) => {
    let fitStatus = 'in-range';
    let warning: string | undefined;

    if (sealDiameterMm < family.neckMinMm) fitStatus = 'undersized';
    else if (sealDiameterMm > family.neckMaxMm) fitStatus = 'out-of-range';

    // Smallest body that clears the minimum-oversizing target.
    let body: number | null = family.bodyDiametersMm.find((d) => d >= minTarget) ?? null;
    if (body == null) {
      body = family.bodyDiametersMm[family.bodyDiametersMm.length - 1] ?? null;
      if (body != null && fitStatus === 'in-range') fitStatus = 'oversized';
    }

    const oversizingPct = body != null ? (body / sealDiameterMm - 1) * 100 : null;
    if (oversizingPct != null) {
      if (oversizingPct < 10) warning = `Oversizing ${oversizingPct.toFixed(0)}% (<10%) — endoleak/migration risk.`;
      else if (oversizingPct > 25) warning = `Oversizing ${oversizingPct.toFixed(0)}% (>25%) — infolding / seal risk.`;
    }
    if (fitStatus === 'out-of-range') warning = `Neck ${sealDiameterMm.toFixed(1)} mm exceeds device range (${family.neckMinMm}–${family.neckMaxMm} mm).`;

    return { family, bodyDiameterMm: body, oversizingPct, fitStatus, warning };
  });
}
