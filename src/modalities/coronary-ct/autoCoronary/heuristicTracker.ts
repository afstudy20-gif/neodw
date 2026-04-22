import type { AutoCoronaryCenterline, AutoCoronaryProgressFn } from './types';
import type { VoxelSampler } from './volumeSampler';

interface TemplateSpec {
  id: AutoCoronaryCenterline['id'];
  label: string;
  color: string;
  dx: number;
  dy: number;
  dz: number;
  length: number;
}

// Phase 1 placeholder: seed at volume center, emit straight-line traces for LM/LAD/LCx/RCA.
// Coordinates chosen so the four traces fan out and do not overlap visually.
const TEMPLATES: TemplateSpec[] = [
  { id: 'lm', label: 'Left Main', color: '#8dd6a5', dx: 0.5, dy: -0.3, dz: -0.5, length: 6 },
  { id: 'lad', label: 'LAD', color: '#ff9f68', dx: 0.8, dy: 0.9, dz: -1.0, length: 16 },
  { id: 'lcx', label: 'LCx', color: '#79c7ff', dx: -1.0, dy: 0.2, dz: -0.8, length: 14 },
  { id: 'rca', label: 'RCA', color: '#f8d16c', dx: -0.6, dy: -1.1, dz: -1.0, length: 18 },
];

export function heuristicTrackCoronaries(
  sampler: VoxelSampler,
  onProgress?: AutoCoronaryProgressFn
): AutoCoronaryCenterline[] {
  onProgress?.('seed-detection', 20);

  const ci = Math.floor(sampler.dims[0] / 2);
  const cj = Math.floor(sampler.dims[1] / 2);
  const ck = Math.floor(sampler.dims[2] / 2);
  const seed = sampler.worldAt(ci, cj, ck);

  onProgress?.('centerline-tracking', 60);

  const lines: AutoCoronaryCenterline[] = TEMPLATES.map((tpl) => {
    const points = Array.from({ length: tpl.length }, (_, n) => ({
      x: seed[0] + tpl.dx * n,
      y: seed[1] + tpl.dy * n,
      z: seed[2] + tpl.dz * n,
    }));
    return {
      id: tpl.id,
      label: tpl.label,
      color: tpl.color,
      points,
      confidence: 0.35,
    };
  });

  return lines;
}
