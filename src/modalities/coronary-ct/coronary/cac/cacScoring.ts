import * as cornerstone from '@cornerstonejs/core';
import type { CoronaryVesselRecord, WorldPoint3D } from '../QCATypes';
import {
  buildParallelTransportFrames,
  polylineLength,
  pointAtDist,
  toVec,
  add,
  scale,
  type Frame3D,
  type Vec3,
} from '../QCAGeometry';

const CAC_HU_THRESHOLD = 130;

interface VolumeContext {
  imageData: any;
  voxelManager: any;
  scalarData: ArrayLike<number> | null;
  dimensions: [number, number, number];
  voxelVolumeMm3: number;
}

export interface CACVesselResult {
  vesselId: string;
  label: string;
  agatstonScore: number;
  volumeMm3: number;
  peakHU: number;
  meanCalciumHU: number;
  voxelCount: number;
}

export type CACDRSCategory = 'zero' | 'mild' | 'moderate' | 'severe';

export interface CACPatientResult {
  vessels: CACVesselResult[];
  totalAgatston: number;
  totalVolumeMm3: number;
  category: CACDRSCategory;
}

/**
 * CAC-DRS category thresholds (CAC-DRS / MESA consensus):
 *   0        → no calcium, no disease
 *   1–99     → mild calcium, minimal plaque
 *   100–399  → moderate calcium, intermediate risk
 *   ≥400     → severe calcium, high risk
 */
export function classifyCACDRS(agatston: number): CACDRSCategory {
  if (agatston <= 0) return 'zero';
  if (agatston < 100) return 'mild';
  if (agatston < 400) return 'moderate';
  return 'severe';
}

/**
 * Agatston density factor from peak HU inside a lesion slice.
 * Historic 120 kVp table — see reference technical doc.
 */
function densityFactor(peakHU: number): number {
  if (peakHU >= 400) return 4;
  if (peakHU >= 300) return 3;
  if (peakHU >= 200) return 2;
  if (peakHU >= CAC_HU_THRESHOLD) return 1;
  return 0;
}

function resolveVolume(renderingEngineId: string | undefined, volumeId: string): VolumeContext | null {
  try {
    let volume: any = cornerstone.cache.getVolume(volumeId);
    if (!volume) {
      const cache = cornerstone.cache as any;
      const getVolumes = cache.getVolumes || cache._volumeCache?.values;
      if (typeof getVolumes === 'function') {
        const all = Array.from(getVolumes.call(cache._volumeCache || cache)) as any[];
        volume = all.find((v: any) => {
          const inner = v?.volume || v;
          return inner?.imageData && (inner.voxelManager || inner.scalarData || typeof inner.getScalarData === 'function');
        });
        if (volume && !volume.imageData && volume.volume) volume = volume.volume;
      }
    }
    if (!volume?.imageData?.worldToIndex || !volume.dimensions) return null;

    const vm = volume.voxelManager ?? null;
    let scalarData: ArrayLike<number> | null = volume.scalarData ?? null;
    if (!scalarData && typeof volume.getScalarData === 'function') {
      try { scalarData = volume.getScalarData(); } catch { /* ignore */ }
    }
    if (!vm?.getAtIJK && !scalarData) return null;

    // Voxel volume — prefer spacing from imageData, else fallback to 1 mm^3.
    let spacing: [number, number, number] = [1, 1, 1];
    try {
      const s = volume.imageData.getSpacing?.();
      if (s && s.length === 3) spacing = [s[0], s[1], s[2]];
      else if (volume.spacing && volume.spacing.length === 3) spacing = volume.spacing;
    } catch { /* ignore */ }
    const voxelVolumeMm3 = spacing[0] * spacing[1] * spacing[2];

    return {
      imageData: volume.imageData,
      voxelManager: vm,
      scalarData,
      dimensions: [volume.dimensions[0], volume.dimensions[1], volume.dimensions[2]],
      voxelVolumeMm3,
    };
    // Parent caller (Workspace) resolves renderingEngineId; we accept it only
    // for future symmetry with other pipelines that look up a specific engine.
  } catch {
    // Intentional: cache lookup failures should surface as "no volume", not throw.
  }
  return null;
}

function sampleHU(volume: VolumeContext, world: WorldPoint3D): number {
  const idx = volume.imageData.worldToIndex([world.x, world.y, world.z] as any);
  if (!idx) return -1000;
  const [dx, dy, dz] = volume.dimensions;
  const i = Math.round(idx[0]);
  const j = Math.round(idx[1]);
  const k = Math.round(idx[2]);
  if (i < 0 || i >= dx || j < 0 || j >= dy || k < 0 || k >= dz) return -1000;
  const vm = volume.voxelManager;
  if (vm?.getAtIJK) {
    const v = vm.getAtIJK(i, j, k);
    return typeof v === 'number' ? v : -1000;
  }
  if (volume.scalarData) {
    const offset = k * dx * dy + j * dx + i;
    const v = volume.scalarData[offset];
    return typeof v === 'number' ? v : -1000;
  }
  return -1000;
}

/**
 * Per-vessel CAC scoring.
 *
 * Walks the centerline at a fixed arc step. At each step we probe a disk
 * in the perpendicular frame (lateral × perpendicular) out to a fixed
 * radius, sampling on a 2D grid. Any voxel ≥ 130 HU counts toward the
 * calcium volume and peak HU tracking, and — after converting the arc-
 * segment-plus-disk sample into an equivalent 2D area — contributes an
 * Agatston-style term of `area × densityFactor(peak)` per segment.
 *
 * This is a reduced-order surrogate, not a true axial-slice Agatston
 * (which would require iterating over native DICOM slices). The output
 * captures the clinically relevant variables — volume, peak HU, CAC-DRS
 * category — without needing DICOM slice access, and stays tethered to
 * the exact vessel the user traced.
 */
export interface ComputePatientCACParams {
  records: CoronaryVesselRecord[];
  volumeId: string;
  /** Disk radius around centerline (mm). Defaults to 6 mm. */
  diskRadiusMm?: number;
  /** Grid step inside the disk (mm). Defaults to 0.6 mm. */
  diskStepMm?: number;
  /** Arc-length step along the centerline (mm). Defaults to 0.6 mm. */
  arcStepMm?: number;
}

export function computePatientCAC(params: ComputePatientCACParams): CACPatientResult | null {
  const volume = resolveVolume(undefined, params.volumeId);
  if (!volume) return null;

  const diskRadiusMm = params.diskRadiusMm ?? 6;
  const diskStepMm = params.diskStepMm ?? 0.6;
  const arcStepMm = params.arcStepMm ?? 0.6;

  const vessels: CACVesselResult[] = [];
  let totalAgatston = 0;
  let totalVolumeMm3 = 0;

  for (const record of params.records) {
    if (record.centerlinePoints.length < 2) {
      vessels.push(emptyVessel(record));
      continue;
    }

    const length = polylineLength(record.centerlinePoints);
    if (length <= 0) {
      vessels.push(emptyVessel(record));
      continue;
    }

    // Densify centerline at arcStep and build a parallel-transported frame
    // array so the perpendicular disk is continuous along the vessel.
    const densified: WorldPoint3D[] = [];
    for (let d = 0; d <= length; d += arcStepMm) {
      densified.push(pointAtDist(record.centerlinePoints, d));
    }
    if (densified.length < 2) {
      vessels.push(emptyVessel(record));
      continue;
    }
    const frames: Frame3D[] = buildParallelTransportFrames(densified, 0);

    let voxelCount = 0;
    let peakHU = -1000;
    let calciumHUSum = 0;
    let agatston = 0;

    const diskArea = diskStepMm * diskStepMm;

    for (let i = 0; i < densified.length; i += 1) {
      const center = toVec(densified[i]);
      const frame = frames[i];
      const lateral: Vec3 = frame.lateral;
      const perp: Vec3 = frame.perpendicular;

      let slicePeak = -1000;
      let sliceCalciumPixels = 0;

      // 2D grid over the perpendicular disk. Only samples inside the
      // radius are considered (circular mask).
      const steps = Math.ceil((diskRadiusMm * 2) / diskStepMm);
      for (let sx = 0; sx <= steps; sx += 1) {
        const u = -diskRadiusMm + sx * diskStepMm;
        for (let sy = 0; sy <= steps; sy += 1) {
          const v = -diskRadiusMm + sy * diskStepMm;
          if (u * u + v * v > diskRadiusMm * diskRadiusMm) continue;

          const worldVec = add(add(center, scale(lateral, u)), scale(perp, v));
          const hu = sampleHU(volume, { x: worldVec[0], y: worldVec[1], z: worldVec[2] });
          if (hu >= CAC_HU_THRESHOLD) {
            voxelCount += 1;
            calciumHUSum += hu;
            sliceCalciumPixels += 1;
            if (hu > slicePeak) slicePeak = hu;
            if (hu > peakHU) peakHU = hu;
          }
        }
      }

      // Agatston per slice: area * density factor, but only if the slice
      // has at least the guideline-mandated 1 mm^2 of contiguous calcium.
      const sliceArea = sliceCalciumPixels * diskArea;
      if (sliceArea >= 1.0 && slicePeak >= CAC_HU_THRESHOLD) {
        agatston += sliceArea * densityFactor(slicePeak) * (arcStepMm / 3.0);
        // * (arcStepMm / 3.0) normalises to the historic 3 mm Agatston
        // slice thickness so our finer sampling doesn't inflate the score.
      }
    }

    const volumeMm3 = voxelCount * diskArea * arcStepMm;
    const meanCalciumHU = voxelCount > 0 ? calciumHUSum / voxelCount : 0;

    vessels.push({
      vesselId: record.id,
      label: record.label,
      agatstonScore: Math.round(agatston),
      volumeMm3: Math.round(volumeMm3 * 10) / 10,
      peakHU: peakHU === -1000 ? 0 : Math.round(peakHU),
      meanCalciumHU: Math.round(meanCalciumHU),
      voxelCount,
    });

    totalAgatston += agatston;
    totalVolumeMm3 += volumeMm3;
  }

  const totalAgatstonRounded = Math.round(totalAgatston);
  return {
    vessels,
    totalAgatston: totalAgatstonRounded,
    totalVolumeMm3: Math.round(totalVolumeMm3 * 10) / 10,
    category: classifyCACDRS(totalAgatstonRounded),
  };
}

function emptyVessel(record: CoronaryVesselRecord): CACVesselResult {
  return {
    vesselId: record.id,
    label: record.label,
    agatstonScore: 0,
    volumeMm3: 0,
    peakHU: 0,
    meanCalciumHU: 0,
    voxelCount: 0,
  };
}
