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

  // Align with HUProbeOverlay ray-march window (0.2×–2× focal distance).
  return { tMin: focalDist * 0.2, tMax: focalDist * 2 };
}

export function shouldEraseVoxel(hu: number | null | undefined, eraseValue = SCALPEL_AIR_HU): boolean {
  if (hu === null || hu === undefined) return false;
  if (hu <= SCALPEL_TISSUE_MIN_HU) return false;
  return hu !== eraseValue;
}

/** Prefer live VTK/scalar arrays — streaming volumes often return null from getAtIJK. */
export function readVoxelHu(
  ii: number,
  jj: number,
  kk: number,
  dims: Point3,
  vm: ScalpelVolumeLike['voxelManager'],
  vtkScalarData: Int16Array | Float32Array | null | undefined,
  scalarData: Int16Array | Float32Array | null,
): number | null | undefined {
  const voxelKey = kk * dims[0] * dims[1] + jj * dims[0] + ii;
  if (vtkScalarData && voxelKey >= 0 && voxelKey < vtkScalarData.length) {
    return vtkScalarData[voxelKey];
  }
  if (scalarData && voxelKey >= 0 && voxelKey < scalarData.length) {
    return scalarData[voxelKey];
  }
  return vm.getAtIJK(ii, jj, kk);
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

export type ScalpelEraseStats = {
  erased: number;
  modifiedSlices: number;
  rays: number;
  rayHits: number;
  mapFailures: number;
  eraseValue: number;
};

export type ScalpelEraseOptions = {
  eraseValue?: number;
  sampleStep?: number;
  /** Called after each voxel is erased — use for per-slice image-cache dual-write. */
  onVoxelErased?: (ii: number, jj: number, kk: number) => void;
};

export type ScalpelEraseResult = ScalpelEraseStats & {
  modifiedSliceIndices: Set<number>;
};

export type ScalpelViewportLike = {
  getCamera: () => CameraLike;
  canvasToWorld?: (canvasPos: Point2) => Point3 | undefined;
};

export type ScalpelVolumeLike = {
  voxelManager: {
    getAtIJK: (i: number, j: number, k: number) => number | null | undefined;
    setAtIJK: (i: number, j: number, k: number, value: number) => void;
    getCompleteScalarDataArray?: () => Int16Array | Float32Array | null;
    setCompleteScalarDataArray?: (data: Int16Array | Float32Array) => void;
  };
  imageData: {
    getDimensions: () => Point3;
    getSpacing: () => Point3;
    getBounds: () => number[];
    worldToIndex: (world: Point3) => Point3;
    getPointData?: () => { getScalars?: () => { getData?: () => Int16Array | Float32Array } };
  };
  getScalarData?: () => Int16Array | Float32Array;
  scalarData?: Int16Array | Float32Array;
};

/**
 * Core scalpel erase pipeline (ray-march + dual-write). Used by RenderModeSelector
 * and integration tests with mocked viewports/volumes.
 */
export function runScalpelErase(
  viewport: ScalpelViewportLike,
  volume: ScalpelVolumeLike,
  canvasPoints: Point2[],
  options: ScalpelEraseOptions = {},
): ScalpelEraseResult | null {
  if (canvasPoints.length < 3) return null;

  const eraseValue = options.eraseValue ?? SCALPEL_AIR_HU;
  const sampleStep = options.sampleStep ?? 2;
  const onVoxelErased = options.onVoxelErased;

  const cam = viewport.getCamera();
  if (!cam.position || !cam.focalPoint) return null;

  const imageData = volume.imageData;
  const dims = imageData.getDimensions();
  const spacing = imageData.getSpacing();
  const vm = volume.voxelManager;
  const bounds = imageData.getBounds();

  const vtkScalarData = imageData.getPointData?.()?.getScalars?.()?.getData?.();
  let scalarData = vm.getCompleteScalarDataArray?.() ?? null;
  if (!scalarData) {
    scalarData = volume.getScalarData?.() ?? volume.scalarData ?? null;
  }

  const rayStep = Math.min(spacing[0], spacing[1], spacing[2]) * 0.5;
  let erased = 0;
  const modifiedSliceIndices = new Set<number>();
  const erasedSet = new Set<number>();
  let rays = 0;
  let rayHits = 0;
  let mapFailures = 0;

  const writeErasedVoxel = (ii: number, jj: number, kk: number) => {
    const voxelKey = kk * dims[0] * dims[1] + jj * dims[0] + ii;
    if (erasedSet.has(voxelKey)) return;

    const hu = readVoxelHu(ii, jj, kk, dims, vm, vtkScalarData, scalarData);
    if (!shouldEraseVoxel(hu, eraseValue)) return;

    vm.setAtIJK(ii, jj, kk, eraseValue);
    if (vtkScalarData) vtkScalarData[voxelKey] = eraseValue;
    if (scalarData) scalarData[voxelKey] = eraseValue;
    onVoxelErased?.(ii, jj, kk);

    erasedSet.add(voxelKey);
    modifiedSliceIndices.add(kk);
    erased++;
  };

  for (const [cx, cy] of collectPolygonRaySamples(canvasPoints, sampleStep)) {
    rays++;
    const worldTarget = viewport.canvasToWorld?.([cx, cy]);
    if (!worldTarget) {
      mapFailures++;
      continue;
    }

    const viewRay = buildViewRay(cam, worldTarget);
    if (!viewRay) continue;

    const march = marchRangeAlongRay(viewRay.origin, viewRay.dir, bounds, cam, worldTarget);
    if (!march) continue;
    rayHits++;

    for (let d = march.tMin; d <= march.tMax; d += rayStep) {
      const worldPos = addScaled(viewRay.origin, viewRay.dir, d);
      const ijk = imageData.worldToIndex(worldPos);
      const ii = Math.round(ijk[0]);
      const jj = Math.round(ijk[1]);
      const kk = Math.round(ijk[2]);

      if (ii < 0 || ii >= dims[0] || jj < 0 || jj >= dims[1] || kk < 0 || kk >= dims[2]) continue;
      writeErasedVoxel(ii, jj, kk);
    }
  }

  if (erased > 0) {
    if (scalarData && typeof vm.setCompleteScalarDataArray === 'function') {
      try {
        vm.setCompleteScalarDataArray(scalarData);
      } catch { /* ignore */ }
    }
    if (vtkScalarData && scalarData && vtkScalarData.length === scalarData.length) {
      try {
        vtkScalarData.set(scalarData);
      } catch { /* ignore */ }
    }
  }

  return {
    erased,
    modifiedSlices: modifiedSliceIndices.size,
    modifiedSliceIndices,
    rays,
    rayHits,
    mapFailures,
    eraseValue,
  };
}