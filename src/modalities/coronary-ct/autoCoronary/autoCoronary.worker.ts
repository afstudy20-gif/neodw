/// <reference lib="webworker" />
import { detectAortaCenterline } from './aortaDetection';
import { traceCoronariesFromAortaRoot } from './ostiumTracker';
import { heuristicTrackCoronaries } from './heuristicTracker';
import type { VoxelSampler } from './volumeSampler';
import type { AutoCoronaryCenterline, AutoCoronaryStage } from './types';

interface WorkerInput {
  dims: [number, number, number];
  scalar: Float32Array | Int16Array | Uint16Array;
  origin: [number, number, number];
  spacing: [number, number, number];
  direction: number[]; // row-major 3x3
}

interface WorkerOutput {
  centerlines: AutoCoronaryCenterline[];
  aortaFound: boolean;
}

type WorkerMessage =
  | { type: 'progress'; stage: AutoCoronaryStage; percent: number }
  | { type: 'done'; result: WorkerOutput }
  | { type: 'error'; message: string };

const AIR_HU = -1000;

function buildSamplerFromBuffers(input: WorkerInput): VoxelSampler {
  const { dims, scalar, origin, spacing, direction } = input;

  function sampleIJK(i: number, j: number, k: number): number {
    if (i < 0 || j < 0 || k < 0 || i >= dims[0] || j >= dims[1] || k >= dims[2]) return AIR_HU;
    return scalar[i + j * dims[0] + k * dims[0] * dims[1]] ?? AIR_HU;
  }

  function worldAt(i: number, j: number, k: number): [number, number, number] {
    const si = i * spacing[0];
    const sj = j * spacing[1];
    const sk = k * spacing[2];
    // direction is column-major from VTK normally; rebuild with provided row-major 3x3.
    const x = origin[0] + direction[0] * si + direction[1] * sj + direction[2] * sk;
    const y = origin[1] + direction[3] * si + direction[4] * sj + direction[5] * sk;
    const z = origin[2] + direction[6] * si + direction[7] * sj + direction[8] * sk;
    return [x, y, z];
  }

  // Inverse direction matrix for world→IJK.
  const m = direction;
  const det =
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6]);
  const invDet = det === 0 ? 0 : 1 / det;
  const inv = [
    (m[4] * m[8] - m[5] * m[7]) * invDet,
    (m[2] * m[7] - m[1] * m[8]) * invDet,
    (m[1] * m[5] - m[2] * m[4]) * invDet,
    (m[5] * m[6] - m[3] * m[8]) * invDet,
    (m[0] * m[8] - m[2] * m[6]) * invDet,
    (m[2] * m[3] - m[0] * m[5]) * invDet,
    (m[3] * m[7] - m[4] * m[6]) * invDet,
    (m[1] * m[6] - m[0] * m[7]) * invDet,
    (m[0] * m[4] - m[1] * m[3]) * invDet,
  ];

  function sample(world: [number, number, number]): number {
    const wx = world[0] - origin[0];
    const wy = world[1] - origin[1];
    const wz = world[2] - origin[2];
    const si = inv[0] * wx + inv[1] * wy + inv[2] * wz;
    const sj = inv[3] * wx + inv[4] * wy + inv[5] * wz;
    const sk = inv[6] * wx + inv[7] * wy + inv[8] * wz;
    return sampleIJK(
      Math.round(si / spacing[0]),
      Math.round(sj / spacing[1]),
      Math.round(sk / spacing[2])
    );
  }

  return { dims, sample, sampleIJK, worldAt };
}

self.addEventListener('message', (event: MessageEvent<WorkerInput>) => {
  try {
    const sampler = buildSamplerFromBuffers(event.data);

    (self as unknown as Worker).postMessage({
      type: 'progress',
      stage: 'seed-detection',
      percent: 25,
    } satisfies WorkerMessage);

    const aorta = detectAortaCenterline(sampler);

    (self as unknown as Worker).postMessage({
      type: 'progress',
      stage: 'centerline-tracking',
      percent: 65,
    } satisfies WorkerMessage);

    const centerlines = aorta
      ? traceCoronariesFromAortaRoot(sampler, aorta.rootIJK)
      : heuristicTrackCoronaries(sampler);

    const out: WorkerMessage = {
      type: 'done',
      result: { centerlines, aortaFound: Boolean(aorta) },
    };
    (self as unknown as Worker).postMessage(out);
  } catch (err) {
    const msg: WorkerMessage = {
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(msg);
  }
});

export type { WorkerInput, WorkerMessage, WorkerOutput };
