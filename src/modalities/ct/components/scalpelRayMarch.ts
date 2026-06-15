/**
 * Ray-march helpers for the 3D CT scalpel (volume eraser).
 * Mirrors the proven HUProbeOverlay camera-ray pattern so drawn polygons
 * map reliably from canvas space into voxel IJK indices.
 */

export const SCALPEL_AIR_HU = -3024;
export const SCALPEL_TISSUE_MIN_HU = -200;

export type Point2 = [number, number];
export type Point3 = [number, number, number];

export type CameraLike = {
  position?: Point3 | null;
  focalPoint?: Point3 | null;
  parallelProjection?: boolean;
};

export function pointInPolygon(x: number, y: number, polygon: Point2[]): boolean {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function polygonBounds(polygon: Point2[]): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [px, py] of polygon) {
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px);
    minY = Math.min(minY, py);
    maxY = Math.max(maxY, py);
  }
  return { minX, maxX, minY, maxY };
}

/** Ray / AABB slab intersection. Returns null when the ray misses the box. */
export function intersectAabb(
  origin: Point3,
  dir: Point3,
  bounds: number[],
): { tMin: number; tMax: number } | null {
  let tMin = -Infinity;
  let tMax = Infinity;

  for (let i = 0; i < 3; i++) {
    const bMin = bounds[i * 2];
    const bMax = bounds[i * 2 + 1];
    const o = origin[i];
    const d = dir[i];

    if (Math.abs(d) < 1e-6) {
      if (o < bMin || o > bMax) return null;
      continue;
    }

    let t1 = (bMin - o) / d;
    let t2 = (bMax - o) / d;
    if (t1 > t2) {
      const temp = t1;
      t1 = t2;
      t2 = temp;
    }

    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }

  return { tMin, tMax };
}

export function normalize3(v: Point3): Point3 | null {
  const len = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2);
  if (len < 1e-6) return null;
  return [v[0] / len, v[1] / len, v[2] / len];
}

export function subtract3(a: Point3, b: Point3): Point3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function addScaled(origin: Point3, dir: Point3, t: number): Point3 {
  return [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
}

export function viewDirectionFromCamera(cam: CameraLike): Point3 | null {
  if (!cam.position || !cam.focalPoint) return null;
  return normalize3(subtract3(cam.focalPoint, cam.position));
}

/**
 * Build a view ray for a canvas pixel. Perspective rays start at the camera;
 * parallel rays pass through the focal-plane point with a constant view direction.
 */
export function buildViewRay(
  cam: CameraLike,
  worldTarget: Point3,
): { origin: Point3; dir: Point3 } | null {
  const viewDir = viewDirectionFromCamera(cam);
  if (!viewDir) return null;

  if (cam.parallelProjection) {
    return { origin: worldTarget, dir: viewDir };
  }

  if (!cam.position) return null;
  const dir = normalize3(subtract3(worldTarget, cam.position));
  if (!dir) return null;
  return { origin: [...cam.position], dir };
}

export type MarchRange = { tMin: number; tMax: number };

/**
 * Distance range along a view ray to traverse the volume.
 * Uses AABB entry/exit when possible; otherwise falls back to a focal-distance sweep
 * (same strategy as HUProbeOverlay).
 */
export function marchRangeAlongRay(
  origin: Point3,
  dir: Point3,
  bounds: number[],
  cam: CameraLike,
  worldTarget: Point3,
): MarchRange | null {
  const hit = intersectAabb(origin, dir, bounds);
  if (hit) {
    const tMin = Math.max(0, hit.tMin);
    const tMax = hit.tMax;
    if (tMax > tMin) return { tMin, tMax };
  }

  if (!cam.position) return null;
  const focalDist = Math.sqrt(
    (worldTarget[0] - cam.position[0]) ** 2 +
    (worldTarget[1] - cam.position[1]) ** 2 +
    (worldTarget[2] - cam.position[2]) ** 2,
  );
  if (focalDist < 1e-3) return null;

  return { tMin: focalDist * 0.05, tMax: focalDist * 2.5 };
}

/**
 * Pick the stored value that renders as "air" (zero VRT opacity) for a given
 * scalar typed-array type. This is the crux of the scalpel working at all:
 *
 * CT volumes are commonly stored as an UNSIGNED type (Uint16, PixelRepresentation
 * 0) with a negative RescaleIntercept (e.g. −1024). The stored value is
 * `(HU − intercept)/slope`, so the lowest air maps to stored 0. Writing a raw
 * HU like −3024 into a Uint16 array WRAPS to ~62512 — a very dense voxel — so
 * the structure is not erased (it gets brighter). For unsigned data the correct
 * "air" stored value is therefore 0; for signed/float data −3024 HU is below air
 * and maps to zero opacity directly.
 *
 * @param arrayCtorName e.g. "Int16Array", "Uint16Array", "Float32Array"
 */
export function eraseValueForScalarType(arrayCtorName: string | undefined | null): number {
  return arrayCtorName && arrayCtorName.startsWith('Uint') ? 0 : SCALPEL_AIR_HU;
}

export function shouldEraseVoxel(hu: number | null | undefined, eraseValue = SCALPEL_AIR_HU): boolean {
  if (hu === null || hu === undefined) return false;
  if (hu <= SCALPEL_TISSUE_MIN_HU) return false;
  return hu !== eraseValue;
}

export function collectPolygonRaySamples(
  polygon: Point2[],
  sampleStep = 2,
): Point2[] {
  const { minX, maxX, minY, maxY } = polygonBounds(polygon);
  const samples: Point2[] = [];
  for (let cx = Math.floor(minX); cx <= Math.ceil(maxX); cx += sampleStep) {
    for (let cy = Math.floor(minY); cy <= Math.ceil(maxY); cy += sampleStep) {
      if (pointInPolygon(cx, cy, polygon)) samples.push([cx, cy]);
    }
  }
  return samples;
}