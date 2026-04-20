export type CoronaryVesselId = string;

export type CoronaryVesselKind = 'main' | 'branch' | 'custom';

export interface WorldPoint3D {
  x: number;
  y: number;
  z: number;
}

export interface ManualQCAInput {
  proximalReferenceDiameterMm?: number;
  distalReferenceDiameterMm?: number;
  minimalLumenDiameterMm?: number;
  proximalReferenceAreaMm2?: number;
  distalReferenceAreaMm2?: number;
  minimalLumenAreaMm2?: number;
  meanAorticPressureMmHg?: number;
  myocardialMassG?: number;
  hyperemiaResistanceScale?: number;
  notes?: string;
}

export interface CurveMarker {
  id: string;
  distanceMm: number;
  label: string;
  color: string;
}

export type ReferenceStrategy = 'average' | 'interpolate';
export type StenosisMeasurementType = 'minD' | 'avgD' | 'area';

export interface StenosisMeasurement {
  lesionStartMm: number;
  lesionEndMm: number;
  proximalReferenceMm: number;
  distalReferenceMm: number;
  referenceStrategy: ReferenceStrategy;
  measurementType: StenosisMeasurementType;
}

export interface LumenContour {
  distanceMm: number;
  points: WorldPoint3D[]; // Lumen boundary
  vesselPoints?: WorldPoint3D[]; // External Elastic Membrane (EEM) / Vessel Wall
  minDiameterOverrideMm?: number;
  maxDiameterOverrideMm?: number;
  composition?: {
    lapAreaMm2: number;
    fibrofattyAreaMm2: number;
    fibrousAreaMm2: number;
    calcifiedAreaMm2: number;
  };
}

export interface CoronaryVesselRecord {
  id: CoronaryVesselId;
  label: string;
  color: string;
  kind: CoronaryVesselKind;
  centerlinePoints: WorldPoint3D[];
  lesionStart?: WorldPoint3D;
  lesionEnd?: WorldPoint3D;
  minimalLumenSite?: WorldPoint3D;
  manual: ManualQCAInput;
  markers: CurveMarker[];
  stenosisMeasurement?: StenosisMeasurement;
  lumenContours: LumenContour[];
}

export interface CoronaryVesselTemplate {
  id: CoronaryVesselId;
  label: string;
  color: string;
  kind: CoronaryVesselKind;
}

export interface PlaqueMetrics {
  totalVolumeMm3: number;
  calcifiedVolumeMm3: number; // >350 HU
  fibrousVolumeMm3: number;   // 130-350 HU
  fibrofattyVolumeMm3: number; // 30-130 HU
  lapVolumeMm3: number;       // <30 HU (Low Attenuation Plaque)
  plaqueBurdenPercent: number; // (Total Plaque / Vessel Volume) * 100
  remodelingIndex: number | null;
}

export interface DerivedQCAMetrics {
  centerlineLengthMm: number | null;
  lesionLengthMm: number | null;
  referenceDiameterMm: number | null;
  diameterStenosisPercent: number | null;
  referenceAreaMm2: number | null;
  areaStenosisPercent: number | null;
  severityLabel: string;
  solverReady: boolean;
  plaque?: PlaqueMetrics;
  clinical?: ClinicalMarkers;
}

export interface ClinicalMarkers {
  mldDistanceMm: number;
  mldDiameterMm: number;
  proximalReferenceDistanceMm?: number;
  proximalReferenceDiameterMm?: number;
  distalReferenceDistanceMm?: number;
  distalReferenceDiameterMm?: number;
}
