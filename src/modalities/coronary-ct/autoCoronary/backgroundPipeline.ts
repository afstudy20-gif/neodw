import * as cornerstone from '@cornerstonejs/core';
import type { DicomSeriesInfo } from '../core/dicomLoader';
import { selectBestCoronarySeries } from './selectBestSeries';
import { buildVoxelSampler } from './volumeSampler';
import { heuristicTrackCoronaries } from './heuristicTracker';
import { detectAortaCenterline } from './aortaDetection';
import { traceCoronariesFromAortaRoot } from './ostiumTracker';
import type { AutoCoronaryProgressFn, AutoCoronaryResult } from './types';

interface PipelineParams {
  seriesList: DicomSeriesInfo[];
  activeSeries: DicomSeriesInfo | null;
  volumeId: string;
  onProgress?: AutoCoronaryProgressFn;
}

export async function runAutoCoronaryPipeline(params: PipelineParams): Promise<AutoCoronaryResult> {
  const { seriesList, activeSeries, volumeId, onProgress } = params;

  onProgress?.('series-selection', 5);
  const { selected, candidates } = selectBestCoronarySeries(seriesList);
  if (!selected) {
    throw new Error('No series available for Auto Coronary.');
  }

  const resolvedSeries =
    activeSeries?.seriesInstanceUID === selected.seriesInstanceUID
      ? activeSeries
      : seriesList.find((s) => s.seriesInstanceUID === selected.seriesInstanceUID) ?? null;

  if (!resolvedSeries) {
    throw new Error('Preferred coronary series not loaded in session.');
  }

  const volume = cornerstone.cache.getVolume(volumeId) as cornerstone.Types.IImageVolume | undefined;
  if (!volume) {
    throw new Error('Volume is not loaded in cache.');
  }

  const sampler = buildVoxelSampler(volume);

  onProgress?.('seed-detection', 25);
  const aorta = detectAortaCenterline(sampler);

  const warnings: string[] = [];
  let centerlines;

  if (aorta) {
    onProgress?.('centerline-tracking', 60);
    centerlines = traceCoronariesFromAortaRoot(sampler, aorta.rootIJK);
    const shortCount = centerlines.filter((c) => c.points.length < 8).length;
    if (shortCount > 0) {
      warnings.push(
        `${shortCount} vessel trace(s) terminated early — verify ostium position and HU contrast window before using.`
      );
    }
  } else {
    warnings.push(
      'Aorta root not detected — fell back to heuristic straight-line seeds. Manual centerline editing required.'
    );
    centerlines = heuristicTrackCoronaries(sampler, onProgress);
  }

  onProgress?.('done', 100);

  return {
    selectedSeriesUID: resolvedSeries.seriesInstanceUID,
    candidates,
    centerlines,
    warnings,
  };
}
