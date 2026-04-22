import type { DicomSeriesInfo } from '../core/dicomLoader';
import { getSeriesPreferenceScore } from '../core/dicomLoader';
import type { AutoCoronarySeriesCandidate } from './types';

function describeReasons(series: DicomSeriesInfo): string[] {
  const desc = (series.seriesDescription || '').toLowerCase();
  const reasons: string[] = [];
  if (/\btemporal\b|\bphase\b/.test(desc)) reasons.push('temporal/phase');
  if (/\b75(?:\.0)?\s*%/.test(desc) || /\b75\b/.test(desc)) reasons.push('75% phase');
  else if (/\b(?:70|80)(?:\.0)?\s*%/.test(desc) || /\b(?:70|80)\b/.test(desc))
    reasons.push('mid-diastolic window');
  if (/\bangi[oo]\b|\bcta\b|\bcor\b|\bcardiac\b/.test(desc)) reasons.push('cardiac/ccta keyword');
  if (/\bbone\b|\blung\b|\bscout\b|\bsmart score\b|\bsmart prep\b|\bcalcium\b/.test(desc))
    reasons.push('derived/non-coronary');
  if (series.numImages < 100) reasons.push('too few images');
  return reasons;
}

export interface SelectSeriesResult {
  selected: AutoCoronarySeriesCandidate | null;
  candidates: AutoCoronarySeriesCandidate[];
}

export function selectBestCoronarySeries(seriesList: DicomSeriesInfo[]): SelectSeriesResult {
  const candidates: AutoCoronarySeriesCandidate[] = seriesList.map((series) => ({
    seriesInstanceUID: series.seriesInstanceUID,
    seriesDescription: series.seriesDescription,
    numImages: series.numImages,
    score: getSeriesPreferenceScore(series),
    reasons: describeReasons(series),
  }));
  candidates.sort((a, b) => b.score - a.score);
  return { selected: candidates[0] ?? null, candidates };
}
