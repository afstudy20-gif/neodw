import type { CoronaryVesselId, WorldPoint3D } from '../coronary/QCATypes';

export interface AutoCoronarySeriesCandidate {
  seriesInstanceUID: string;
  seriesDescription: string;
  numImages: number;
  score: number;
  reasons: string[];
}

export interface AutoCoronaryCenterline {
  id: CoronaryVesselId;
  label: string;
  color: string;
  points: WorldPoint3D[];
  confidence: number;
}

export interface AutoCoronaryResult {
  selectedSeriesUID: string;
  candidates: AutoCoronarySeriesCandidate[];
  centerlines: AutoCoronaryCenterline[];
  warnings: string[];
}

export type AutoCoronaryStage =
  | 'series-selection'
  | 'seed-detection'
  | 'centerline-tracking'
  | 'done';

export type AutoCoronaryProgressFn = (stage: AutoCoronaryStage, percent: number) => void;
