import {
  CoronaryMeasurementSession,
  DEFAULT_CENTERLINE_TEMPLATES,
} from '../coronary/CoronaryMeasurementSession';
import type { AutoCoronaryCenterline } from './types';

export function applyAutoCoronaryToSession(
  session: CoronaryMeasurementSession,
  centerlines: AutoCoronaryCenterline[]
): void {
  const templateById = new Map(DEFAULT_CENTERLINE_TEMPLATES.map((t) => [t.id, t]));

  for (const line of centerlines) {
    const template = templateById.get(line.id);
    if (!template) continue;
    if (!session.hasRecord(line.id)) continue;

    session.renameRecord(line.id, line.label || template.label);
    session.setRecordColor(line.id, line.color || template.color);
    session.setCenterlinePoints(line.id, line.points);
  }
}
