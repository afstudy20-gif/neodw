/**
 * 3D surface measurement + annotation model.
 *
 * Points are picked on the rendered surface (or interior cavity) by ray-marching
 * the view ray to the first voxel inside a HU window — see firstHitT in
 * scalpelRayMarch. This module holds the pure geometry (distance, angle) and the
 * persistence model so measurements/annotations can be saved linked to the
 * DICOM series and reloaded — including on another machine.
 *
 * Pure and storage-independent so it can be unit-tested without a viewport.
 */

export type Vec3 = [number, number, number];

export interface Measurement {
  id: string;
  kind: 'distance' | 'angle';
  /** World-space points (mm). distance: 2 points; angle: 3 (a, vertex, b). */
  points: Vec3[];
  /** Result value: mm for distance, degrees for angle. */
  value: number;
  label?: string;
}

export interface Annotation {
  id: string;
  point: Vec3;
  text: string;
}

/** Records stored per DICOM series, keyed by SeriesInstanceUID (or a fallback). */
export interface MeasurementRecord {
  seriesKey: string;
  measurements: Measurement[];
  annotations: Annotation[];
}

/** Euclidean distance between two world points, in the volume's world units (mm). */
export function distance3(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Angle A–V–B at vertex V, in degrees [0, 180]. Returns 0 when either arm has
 * zero length (degenerate) rather than NaN.
 */
export function angle3(a: Vec3, vertex: Vec3, b: Vec3): number {
  const u: Vec3 = [a[0] - vertex[0], a[1] - vertex[1], a[2] - vertex[2]];
  const v: Vec3 = [b[0] - vertex[0], b[1] - vertex[1], b[2] - vertex[2]];
  const lu = Math.hypot(u[0], u[1], u[2]);
  const lv = Math.hypot(v[0], v[1], v[2]);
  if (lu < 1e-9 || lv < 1e-9) return 0;
  const dot = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const cos = Math.max(-1, Math.min(1, dot / (lu * lv)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** Human-readable value: "42.7 mm" for a distance, "118.4°" for an angle. */
export function formatMeasurement(m: Measurement): string {
  return m.kind === 'distance' ? `${m.value.toFixed(1)} mm` : `${m.value.toFixed(1)}°`;
}

/**
 * Compute the measurement value for a set of picked points. Returns null when
 * there are not enough points for the kind (2 for distance, 3 for angle).
 */
export function computeValue(kind: Measurement['kind'], points: Vec3[]): number | null {
  if (kind === 'distance') return points.length >= 2 ? distance3(points[0], points[1]) : null;
  if (kind === 'angle') return points.length >= 3 ? angle3(points[0], points[1], points[2]) : null;
  return null;
}

const STORAGE_PREFIX = 'neodw:measure3d:';

/** Storage key for a series. */
export function storageKey(seriesKey: string): string {
  return STORAGE_PREFIX + seriesKey;
}

/**
 * Serialize a record to a compact JSON string for persistence. Round-trips with
 * deserializeRecord.
 */
export function serializeRecord(record: MeasurementRecord): string {
  return JSON.stringify(record);
}

/**
 * Parse a stored record. Returns an empty record for the series if the input is
 * missing or malformed, so a corrupt entry never throws into the UI.
 */
export function deserializeRecord(seriesKey: string, raw: string | null): MeasurementRecord {
  const empty: MeasurementRecord = { seriesKey, measurements: [], annotations: [] };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as Partial<MeasurementRecord>;
    return {
      seriesKey,
      measurements: Array.isArray(parsed.measurements) ? parsed.measurements : [],
      annotations: Array.isArray(parsed.annotations) ? parsed.annotations : [],
    };
  } catch {
    return empty;
  }
}
