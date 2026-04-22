import type { VoxelSampler } from './volumeSampler';
import type { WorldPoint3D } from '../coronary/QCATypes';
import type { AutoCoronaryCenterline } from './types';

const LUMEN_HU_MIN = 180;
const LUMEN_HU_MAX = 600;
const MAX_STEPS = 120;
const STEP_MM = 1.0;

// Anchor seeds at four candidate ostial positions around the aortic root in IJK space.
// Distances are in voxels; we then convert to world for each step.
interface OstiumSpec {
  id: AutoCoronaryCenterline['id'];
  label: string;
  color: string;
  offsetI: number; // relative to aorta root
  offsetJ: number;
  dirI: number; // initial growth direction in IJK
  dirJ: number;
  dirK: number;
}

const OSTIA: OstiumSpec[] = [
  // Left Main: slightly left-posterior of root
  { id: 'lm', label: 'Left Main', color: '#8dd6a5', offsetI: 8, offsetJ: -2, dirI: 1, dirJ: -1, dirK: 0 },
  // LAD: continuation of LM anteriorly and slightly inferior
  { id: 'lad', label: 'LAD', color: '#ff9f68', offsetI: 14, offsetJ: 3, dirI: 1, dirJ: 1, dirK: -1 },
  // LCx: LM divides laterally toward atrioventricular groove
  { id: 'lcx', label: 'LCx', color: '#79c7ff', offsetI: 12, offsetJ: -8, dirI: -1, dirJ: -1, dirK: -1 },
  // RCA: right-anterior of root
  { id: 'rca', label: 'RCA', color: '#f8d16c', offsetI: -10, offsetJ: 4, dirI: -1, dirJ: 1, dirK: -1 },
];

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Grow a centerline by stepping along (dirI, dirJ, dirK) and refining each step
// to the voxel-local HU-bright centroid within a small search window. Stops when
// HU leaves lumen window or goes out of bounds.
function traceVessel(
  sampler: VoxelSampler,
  startIJK: [number, number, number],
  dir: [number, number, number]
): WorldPoint3D[] {
  const [w, h, d] = sampler.dims;
  const points: WorldPoint3D[] = [];

  let ci = startIJK[0];
  let cj = startIJK[1];
  let ck = startIJK[2];

  const wStart = sampler.worldAt(ci, cj, ck);
  points.push({ x: wStart[0], y: wStart[1], z: wStart[2] });

  const spacingMm = Math.max(
    0.3,
    Math.abs(
      sampler.worldAt(Math.min(ci + 1, w - 1), cj, ck)[0] - wStart[0]
    ) || 0.5
  );
  const voxelStep = Math.max(1, Math.round(STEP_MM / spacingMm));

  let [di, dj, dk] = dir;
  const norm = Math.hypot(di, dj, dk) || 1;
  di /= norm;
  dj /= norm;
  dk /= norm;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const ni = clamp(Math.round(ci + di * voxelStep), 0, w - 1);
    const nj = clamp(Math.round(cj + dj * voxelStep), 0, h - 1);
    const nk = clamp(Math.round(ck + dk * voxelStep), 0, d - 1);

    // Refine via 3x3x3 centroid of HU-bright voxels.
    let sumI = 0;
    let sumJ = 0;
    let sumK = 0;
    let count = 0;
    for (let oi = -2; oi <= 2; oi += 1) {
      for (let oj = -2; oj <= 2; oj += 1) {
        for (let ok = -1; ok <= 1; ok += 1) {
          const ii = clamp(ni + oi, 0, w - 1);
          const jj = clamp(nj + oj, 0, h - 1);
          const kk = clamp(nk + ok, 0, d - 1);
          const hu = sampler.sampleIJK(ii, jj, kk);
          if (hu >= LUMEN_HU_MIN && hu <= LUMEN_HU_MAX) {
            sumI += ii;
            sumJ += jj;
            sumK += kk;
            count += 1;
          }
        }
      }
    }
    if (count < 4) break;

    const refI = sumI / count;
    const refJ = sumJ / count;
    const refK = sumK / count;

    const newDi = refI - ci;
    const newDj = refJ - cj;
    const newDk = refK - ck;
    const newNorm = Math.hypot(newDi, newDj, newDk);
    if (newNorm < 0.2) break;

    ci = refI;
    cj = refJ;
    ck = refK;
    di = newDi / newNorm;
    dj = newDj / newNorm;
    dk = newDk / newNorm;

    const world = sampler.worldAt(Math.round(ci), Math.round(cj), Math.round(ck));
    points.push({ x: world[0], y: world[1], z: world[2] });
  }

  return points;
}

export function traceCoronariesFromAortaRoot(
  sampler: VoxelSampler,
  rootIJK: [number, number, number]
): AutoCoronaryCenterline[] {
  const [w, h, d] = sampler.dims;
  const lines: AutoCoronaryCenterline[] = [];

  for (const spec of OSTIA) {
    const startI = clamp(rootIJK[0] + spec.offsetI, 0, w - 1);
    const startJ = clamp(rootIJK[1] + spec.offsetJ, 0, h - 1);
    const startK = clamp(rootIJK[2] - 2, 0, d - 1);

    const points = traceVessel(
      sampler,
      [startI, startJ, startK],
      [spec.dirI, spec.dirJ, spec.dirK]
    );

    lines.push({
      id: spec.id,
      label: spec.label,
      color: spec.color,
      points,
      confidence: points.length > 8 ? 0.55 : 0.25,
    });
  }

  return lines;
}
