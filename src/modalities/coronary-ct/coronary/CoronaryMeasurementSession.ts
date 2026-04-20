import { deriveQCAMetrics } from './QCAGeometry';
import type {
  CoronaryVesselId,
  CoronaryVesselKind,
  CoronaryVesselRecord,
  CoronaryVesselTemplate,
  ManualQCAInput,
  WorldPoint3D,
} from './QCATypes';

export const DEFAULT_CENTERLINE_TEMPLATES: CoronaryVesselTemplate[] = [
  { id: 'lad', label: 'LAD', color: '#ff9f68', kind: 'main' },
  { id: 'lcx', label: 'LCx', color: '#79c7ff', kind: 'main' },
  { id: 'rca', label: 'RCA', color: '#f8d16c', kind: 'main' },
  { id: 'lm', label: 'Left Main', color: '#8dd6a5', kind: 'main' },
];

function createEmptyRecord(template: CoronaryVesselTemplate): CoronaryVesselRecord {
  return {
    id: template.id,
    label: template.label,
    color: template.color,
    kind: template.kind,
    centerlinePoints: [],
    manual: {
      hyperemiaResistanceScale: 0.21,
      meanAorticPressureMmHg: 90,
    },
    markers: [],
    lumenContours: [],
  };
}

function createDefaultRecords(): CoronaryVesselRecord[] {
  return DEFAULT_CENTERLINE_TEMPLATES.map(createEmptyRecord);
}

function createIdFromLabel(label: string): string {
  const base = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return base || 'centerline';
}

export class CoronaryMeasurementSession {
  public readonly disclaimer =
    'Research-only coronary workbench. Centerlines are manual/assisted; CT-FFR solver is not implemented yet.';

  private vessels: CoronaryVesselRecord[] = createDefaultRecords();

  reset(): void {
    this.vessels = createDefaultRecords();
  }

  getRecords(): CoronaryVesselRecord[] {
    return this.vessels.map((record) => ({
      ...record,
      centerlinePoints: record.centerlinePoints.map((point) => ({ ...point })),
      lesionStart: record.lesionStart ? { ...record.lesionStart } : undefined,
      lesionEnd: record.lesionEnd ? { ...record.lesionEnd } : undefined,
      minimalLumenSite: record.minimalLumenSite ? { ...record.minimalLumenSite } : undefined,
      manual: { ...record.manual },
      markers: record.markers.map((m) => ({ ...m })),
      stenosisMeasurement: record.stenosisMeasurement ? { ...record.stenosisMeasurement } : undefined,
      lumenContours: record.lumenContours.map((c) => ({
        ...c,
        points: c.points.map(p => ({ ...p })),
        vesselPoints: c.vesselPoints?.map(p => ({ ...p })),
        composition: c.composition ? { ...c.composition } : undefined,
      })),
    }));
  }

  hasRecord(vesselId: CoronaryVesselId): boolean {
    return this.vessels.some((record) => record.id === vesselId);
  }

  getRecord(vesselId: CoronaryVesselId): CoronaryVesselRecord {
    const record = this.vessels.find((entry) => entry.id === vesselId);
    if (!record) {
      throw new Error(`Unknown coronary centerline: ${vesselId}`);
    }
    return record;
  }

  addRecord(label: string, kind: CoronaryVesselKind = 'custom', color = '#d7e7f8'): CoronaryVesselId {
    const normalizedLabel = label.trim();
    if (!normalizedLabel) {
      throw new Error('Centerline label is required.');
    }

    const existing = this.vessels.find(
      (record) => record.label.toLowerCase() === normalizedLabel.toLowerCase()
    );
    if (existing) {
      return existing.id;
    }

    const baseId = createIdFromLabel(normalizedLabel);
    let nextId = baseId;
    let counter = 2;
    while (this.hasRecord(nextId)) {
      nextId = `${baseId}-${counter}`;
      counter += 1;
    }

    this.vessels = [
      ...this.vessels,
      createEmptyRecord({
        id: nextId,
        label: normalizedLabel,
        color,
        kind,
      }),
    ];

    return nextId;
  }

  renameRecord(vesselId: CoronaryVesselId, label: string): void {
    this.getRecord(vesselId).label = label.trim() || this.getRecord(vesselId).label;
  }

  setRecordColor(vesselId: CoronaryVesselId, color: string): void {
    this.getRecord(vesselId).color = color;
  }

  deleteRecord(vesselId: CoronaryVesselId): void {
    this.vessels = this.vessels.filter((record) => record.id !== vesselId);
    if (this.vessels.length === 0) {
      this.reset();
    }
  }

  addCenterlinePoint(vesselId: CoronaryVesselId, point: WorldPoint3D): void {
    this.getRecord(vesselId).centerlinePoints = [...this.getRecord(vesselId).centerlinePoints, point];
  }

  setCenterlinePoints(vesselId: CoronaryVesselId, points: WorldPoint3D[]): void {
    this.getRecord(vesselId).centerlinePoints = points.map((point) => ({ ...point }));
  }

  updateCenterlinePoint(vesselId: CoronaryVesselId, index: number, point: WorldPoint3D): void {
    const record = this.getRecord(vesselId);
    if (index < 0 || index >= record.centerlinePoints.length) {
      return;
    }
    record.centerlinePoints = record.centerlinePoints.map((existing, currentIndex) =>
      currentIndex === index ? { ...point } : existing
    );
  }

  removeCenterlinePoint(vesselId: CoronaryVesselId, index: number): void {
    const record = this.getRecord(vesselId);
    record.centerlinePoints = record.centerlinePoints.filter((_, currentIndex) => currentIndex !== index);
  }

  undoLastCenterlinePoint(vesselId: CoronaryVesselId): void {
    this.getRecord(vesselId).centerlinePoints = this.getRecord(vesselId).centerlinePoints.slice(0, -1);
  }

  clearVessel(vesselId: CoronaryVesselId): void {
    const record = this.getRecord(vesselId);
    this.vessels = this.vessels.map((entry) =>
      entry.id === vesselId
        ? createEmptyRecord({
            id: record.id,
            label: record.label,
            color: record.color,
            kind: record.kind,
          })
        : entry
    );
  }

  setLesionStart(vesselId: CoronaryVesselId, point: WorldPoint3D): void {
    this.getRecord(vesselId).lesionStart = point;
  }

  setLesionEnd(vesselId: CoronaryVesselId, point: WorldPoint3D): void {
    this.getRecord(vesselId).lesionEnd = point;
  }

  setMinimalLumenSite(vesselId: CoronaryVesselId, point: WorldPoint3D): void {
    this.getRecord(vesselId).minimalLumenSite = point;
  }

  updateManual(vesselId: CoronaryVesselId, patch: Partial<ManualQCAInput>): void {
    this.getRecord(vesselId).manual = {
      ...this.getRecord(vesselId).manual,
      ...patch,
    };
  }

  addCurveMarker(vesselId: CoronaryVesselId, distanceMm: number, label: string, color: string): string {
    const id = `marker-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    this.getRecord(vesselId).markers.push({ id, distanceMm, label, color });
    return id;
  }

  updateCurveMarker(vesselId: CoronaryVesselId, markerId: string, patch: Partial<{ label: string; color: string }>): void {
    const record = this.getRecord(vesselId);
    record.markers = record.markers.map((m) => (m.id === markerId ? { ...m, ...patch } : m));
  }

  removeCurveMarker(vesselId: CoronaryVesselId, markerId: string): void {
    const record = this.getRecord(vesselId);
    record.markers = record.markers.filter((m) => m.id !== markerId);
  }

  setStenosisMeasurement(vesselId: CoronaryVesselId, lesionStartMm: number, lesionEndMm: number): void {
    const record = this.getRecord(vesselId);
    record.stenosisMeasurement = {
      lesionStartMm,
      lesionEndMm,
      proximalReferenceMm: Math.max(0, Math.min(lesionStartMm, lesionEndMm) - 5),
      distalReferenceMm: Math.max(lesionStartMm, lesionEndMm) + 5,
      referenceStrategy: 'interpolate',
      measurementType: 'avgD',
    };
  }

  updateStenosisMeasurement(
    vesselId: CoronaryVesselId,
    patch: Partial<NonNullable<CoronaryVesselRecord['stenosisMeasurement']>>
  ): void {
    const record = this.getRecord(vesselId);
    if (record.stenosisMeasurement) {
      record.stenosisMeasurement = { ...record.stenosisMeasurement, ...patch };
    }
  }

  clearStenosisMeasurement(vesselId: CoronaryVesselId): void {
    this.getRecord(vesselId).stenosisMeasurement = undefined;
  }

  setLumenContour(vesselId: CoronaryVesselId, contour: NonNullable<CoronaryVesselRecord['lumenContours']>[0]): void {
    const record = this.getRecord(vesselId);
    const existingIndex = record.lumenContours.findIndex((c) => Math.abs(c.distanceMm - contour.distanceMm) < 0.1);
    if (existingIndex >= 0) {
      record.lumenContours[existingIndex] = contour;
    } else {
      record.lumenContours.push(contour);
    }
  }

  generateDefaultVesselWall(vesselId: CoronaryVesselId, offsetMm: number = 0.8): void {
    const record = this.getRecord(vesselId);
    // This logic usually needs more than just points (centerline, volume)
    // but the session is just a data container.
    // The Workspace will perform the logic using QCAGeometry and then call setLumenContour.
  }

  resetPlaqueAnalysis(vesselId: CoronaryVesselId): void {
    const record = this.getRecord(vesselId);
    record.lumenContours.forEach((c) => {
      c.vesselPoints = undefined;
      c.composition = undefined;
    });
  }

  clearLumenContour(vesselId: CoronaryVesselId, distanceMm: number): void {
    const record = this.getRecord(vesselId);
    const index = record.lumenContours.findIndex((c) => Math.abs(c.distanceMm - distanceMm) < 0.1);
    if (index >= 0) {
      record.lumenContours.splice(index, 1);
    }
  }

  updateLumenContourOverrides(vesselId: CoronaryVesselId, distanceMm: number, minDiameterOverrideMm?: number, maxDiameterOverrideMm?: number): void {
    const record = this.getRecord(vesselId);
    const existing = record.lumenContours.find((c) => Math.abs(c.distanceMm - distanceMm) < 0.1);
    if (existing) {
      if (minDiameterOverrideMm !== undefined) existing.minDiameterOverrideMm = minDiameterOverrideMm;
      if (maxDiameterOverrideMm !== undefined) existing.maxDiameterOverrideMm = maxDiameterOverrideMm;
    } else {
      record.lumenContours.push({
        distanceMm,
        points: [],
        minDiameterOverrideMm,
        maxDiameterOverrideMm,
      });
    }
  }

  derivedMetrics(vesselId: CoronaryVesselId) {
    return deriveQCAMetrics(this.getRecord(vesselId));
  }

  labeledRecordsForAnalysis(): CoronaryVesselRecord[] {
    return this.vessels.filter((record) => record.label.trim().length > 0 && record.centerlinePoints.length >= 2);
  }

  exportSnapshot() {
    return {
      disclaimer: this.disclaimer,
      generatedAt: new Date().toISOString(),
      vessels: this.getRecords(),
      metrics: this.vessels.map((record) => ({
        id: record.id,
        label: record.label,
        metrics: this.derivedMetrics(record.id),
      })),
    };
  }

  textReport(context?: { patientName?: string; studyDescription?: string }): string {
    const lines: string[] = [];

    lines.push('CORONARY CT QCA WORKBENCH REPORT');
    lines.push('================================');
    lines.push(`Generated: ${new Date().toLocaleString()}`);
    if (context?.patientName) {
      lines.push(`Patient: ${context.patientName}`);
    }
    if (context?.studyDescription) {
      lines.push(`Study: ${context.studyDescription}`);
    }
    lines.push(`Note: ${this.disclaimer}`);
    lines.push('');

    this.vessels.forEach((record) => {
      const metrics = this.derivedMetrics(record.id);

      lines.push(record.label);
      lines.push('-'.repeat(record.label.length));
      lines.push(`Centerline points: ${record.centerlinePoints.length}`);
      lines.push(
        `Centerline length: ${
          metrics.centerlineLengthMm != null ? `${metrics.centerlineLengthMm.toFixed(1)} mm` : '—'
        }`
      );
      lines.push(
        `Lesion length: ${
          metrics.lesionLengthMm != null ? `${metrics.lesionLengthMm.toFixed(1)} mm` : '—'
        }`
      );
      lines.push(
        `Reference diameter: ${
          metrics.referenceDiameterMm != null ? `${metrics.referenceDiameterMm.toFixed(2)} mm` : '—'
        }`
      );
      lines.push(
        `Minimal lumen diameter: ${
          record.manual.minimalLumenDiameterMm != null
            ? `${record.manual.minimalLumenDiameterMm.toFixed(2)} mm`
            : '—'
        }`
      );
      lines.push(
        `Diameter stenosis: ${
          metrics.diameterStenosisPercent != null
            ? `${metrics.diameterStenosisPercent.toFixed(1)} %`
            : '—'
        }`
      );
      lines.push(
        `Reference area: ${
          metrics.referenceAreaMm2 != null ? `${metrics.referenceAreaMm2.toFixed(2)} mm2` : '—'
        }`
      );
      lines.push(
        `Minimal lumen area: ${
          record.manual.minimalLumenAreaMm2 != null
            ? `${record.manual.minimalLumenAreaMm2.toFixed(2)} mm2`
            : '—'
        }`
      );
      lines.push(
        `Area stenosis: ${
          metrics.areaStenosisPercent != null ? `${metrics.areaStenosisPercent.toFixed(1)} %` : '—'
        }`
      );
      lines.push(`Severity: ${metrics.severityLabel}`);
      lines.push(`CT-FFR solver ready: ${metrics.solverReady ? 'Yes' : 'No'}`);
      if (record.manual.notes) {
        lines.push(`Notes: ${record.manual.notes}`);
      }
      lines.push('');
    });

    return lines.join('\n');
  }
}
