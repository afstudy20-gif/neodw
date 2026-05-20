import * as cornerstone from '@cornerstonejs/core';
import type { DicomSeriesInfo } from '../core/dicomLoader';
import { selectBestCoronarySeries } from './selectBestSeries';
import { buildVoxelSampler } from './volumeSampler';
import { heuristicTrackCoronaries } from './heuristicTracker';
import { detectAortaCenterline } from './aortaDetection';
import { traceCoronariesFromAortaRoot, traceCoronariesFromManualLandmarks } from './ostiumTracker';
import type { AutoCoronaryProgressFn, AutoCoronaryResult } from './types';
import type { WorldPoint3D } from '../coronary/QCATypes';

interface PipelineParams {
  seriesList: DicomSeriesInfo[];
  activeSeries: DicomSeriesInfo | null;
  volumeId: string;
  onProgress?: AutoCoronaryProgressFn;
  aortaRoot?: WorldPoint3D | null;
  rcaOstium?: WorldPoint3D | null;
  lmcaOstium?: WorldPoint3D | null;
}

export async function runAutoCoronaryPipeline(params: PipelineParams): Promise<AutoCoronaryResult> {
  const { seriesList, activeSeries, volumeId, onProgress, aortaRoot, rcaOstium, lmcaOstium } = params;

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

  const warnings: string[] = [];
  let centerlines;

  if (aortaRoot && rcaOstium && lmcaOstium) {
    onProgress?.('centerline-tracking', 60);
    const rootIJK_raw = sampler.worldToIndex([aortaRoot.x, aortaRoot.y, aortaRoot.z]);
    const rcaIJK_raw = sampler.worldToIndex([rcaOstium.x, rcaOstium.y, rcaOstium.z]);
    const lmcaIJK_raw = sampler.worldToIndex([lmcaOstium.x, lmcaOstium.y, lmcaOstium.z]);

    const rootIJK: [number, number, number] = [
      Math.round(rootIJK_raw[0]),
      Math.round(rootIJK_raw[1]),
      Math.round(rootIJK_raw[2]),
    ];
    const rcaOstiumIJK: [number, number, number] = [
      Math.round(rcaIJK_raw[0]),
      Math.round(rcaIJK_raw[1]),
      Math.round(rcaIJK_raw[2]),
    ];
    const lmcaOstiumIJK: [number, number, number] = [
      Math.round(lmcaIJK_raw[0]),
      Math.round(lmcaIJK_raw[1]),
      Math.round(lmcaIJK_raw[2]),
    ];

    centerlines = traceCoronariesFromManualLandmarks(sampler, rootIJK, rcaOstiumIJK, lmcaOstiumIJK);
    const shortCount = centerlines.filter((c) => c.points.length < 8).length;
    if (shortCount > 0) {
      warnings.push(
        `${shortCount} vessel trace(s) terminated early — verify manual landmark placement and HU contrast window.`
      );
    }
  } else {
    onProgress?.('seed-detection', 25);
    const aorta = detectAortaCenterline(sampler);

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
  }

  onProgress?.('done', 100);

  return {
    selectedSeriesUID: resolvedSeries.seriesInstanceUID,
    candidates,
    centerlines,
    warnings,
  };
}
