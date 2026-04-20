import type { CoronaryVesselRecord } from '../QCATypes';
import { interpolateContourRadii, polylineLength } from '../QCAGeometry';
import type { FFRArcSample } from './ffrTypes';

/**
 * Default arc-length step for FFR sampling. 0.5 mm matches common
 * clinical pullback wire spatial resolution without ballooning cost.
 */
export const DEFAULT_ARC_STEP_MM = 0.5;

/**
 * Resample a vessel centerline at a uniform arc-length step, interpolating
 * lumen area from the nearest LumenContour pair. Reference diameter fields
 * are left blank here — they are populated by referenceDiameter.ts after a
 * full healthy-baseline pass over the entire vessel.
 *
 * Fallback order for lumen radius at a sample:
 *   1. Interpolated inner radius from contour polygons.
 *   2. Per-contour min-diameter override (if present, used as a scalar).
 *   3. manual.minimalLumenDiameterMm.
 *   4. manual.proximalReferenceDiameterMm (coarse).
 *   5. 1.5 mm (last-ditch, keeps solver numerically stable).
 */
export function resampleCenterline(
  record: CoronaryVesselRecord,
  arcStepMm: number = DEFAULT_ARC_STEP_MM
): FFRArcSample[] {
  const centerline = record.centerlinePoints;
  if (centerline.length < 2) return [];

  const totalLength = polylineLength(centerline);
  if (totalLength <= 0) return [];

  const sortedContours = [...record.lumenContours].sort(
    (a, b) => a.distanceMm - b.distanceMm
  );
  const hasContourGeometry = sortedContours.some((c) => c.points.length >= 3);

  const fallbackDiameterMm = pickFallbackDiameter(record);

  const samples: FFRArcSample[] = [];
  const step = Math.max(0.05, arcStepMm);
  for (let d = 0; d <= totalLength + 1e-6; d += step) {
    const distance = Math.min(d, totalLength);

    let diameterMm: number;
    if (hasContourGeometry) {
      const { inner } = interpolateContourRadii(sortedContours, centerline, distance);
      diameterMm = inner > 0 ? inner * 2 : fallbackDiameterMm;
    } else {
      diameterMm = overrideDiameterAt(sortedContours, distance) ?? fallbackDiameterMm;
    }

    // Clamp to a plausible physiological range so the solver never sees a
    // zero-area division. 0.3 mm is well below the smallest imageable branch
    // and 8 mm exceeds any normal epicardial lumen.
    const clampedD = Math.min(Math.max(diameterMm, 0.3), 8.0);
    const radiusMm = clampedD / 2;
    const areaMm2 = Math.PI * radiusMm * radiusMm;

    samples.push({
      distanceMm: distance,
      diameterMm: clampedD,
      areaMm2,
      referenceDiameterMm: 0,
      referenceAreaMm2: 0,
    });
  }

  return samples;
}

function overrideDiameterAt(
  sorted: CoronaryVesselRecord['lumenContours'],
  distanceMm: number
): number | null {
  if (sorted.length === 0) return null;
  if (distanceMm <= sorted[0].distanceMm) {
    return sorted[0].minDiameterOverrideMm ?? null;
  }
  if (distanceMm >= sorted[sorted.length - 1].distanceMm) {
    return sorted[sorted.length - 1].minDiameterOverrideMm ?? null;
  }
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (distanceMm >= a.distanceMm && distanceMm <= b.distanceMm) {
      const t = (distanceMm - a.distanceMm) / Math.max(b.distanceMm - a.distanceMm, 1e-6);
      const da = a.minDiameterOverrideMm;
      const db = b.minDiameterOverrideMm;
      if (da != null && db != null) return da + (db - da) * t;
      return da ?? db ?? null;
    }
  }
  return null;
}

function pickFallbackDiameter(record: CoronaryVesselRecord): number {
  const m = record.manual;
  return (
    m.minimalLumenDiameterMm ??
    m.distalReferenceDiameterMm ??
    m.proximalReferenceDiameterMm ??
    1.5
  );
}
