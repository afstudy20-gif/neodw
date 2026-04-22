import { useCallback, useState } from 'react';
import type { DicomSeriesInfo } from '../core/dicomLoader';
import type { CoronaryMeasurementSession } from '../coronary/CoronaryMeasurementSession';
import { runAutoCoronaryPipeline } from './backgroundPipeline';
import { applyAutoCoronaryToSession } from './sessionAdapter';
import type { AutoCoronaryResult, AutoCoronaryStage } from './types';

interface Params {
  seriesList: DicomSeriesInfo[];
  activeSeries: DicomSeriesInfo | null;
  volumeId: string;
  session: CoronaryMeasurementSession;
  onApplied?: (result: AutoCoronaryResult) => void;
}

interface UseAutoCoronary {
  run: () => Promise<AutoCoronaryResult | null>;
  busy: boolean;
  stage: AutoCoronaryStage | '';
  error: string | null;
}

export function useAutoCoronary({
  seriesList,
  activeSeries,
  volumeId,
  session,
  onApplied,
}: Params): UseAutoCoronary {
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<AutoCoronaryStage | ''>('');
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (busy) return null;
    setBusy(true);
    setError(null);
    setStage('series-selection');
    try {
      const result = await runAutoCoronaryPipeline({
        seriesList,
        activeSeries,
        volumeId,
        onProgress: (nextStage) => setStage(nextStage),
      });
      applyAutoCoronaryToSession(session, result.centerlines);
      onApplied?.(result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Auto Coronary failed.';
      setError(message);
      return null;
    } finally {
      setBusy(false);
    }
  }, [busy, seriesList, activeSeries, volumeId, session, onApplied]);

  return { run, busy, stage, error };
}
