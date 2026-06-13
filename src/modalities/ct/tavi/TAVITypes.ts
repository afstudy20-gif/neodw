export interface TAVIVector3D {
  x: number;
  y: number;
  z: number;
}

export interface TAVIPoint2D {
  x: number;
  y: number;
}

export interface TAVIGeometryResult {
  perimeterMm: number;
  areaMm2: number;
  equivalentDiameterMm: number;
  minimumDiameterMm: number;
  maximumDiameterMm: number;
  centroid: TAVIVector3D;
  planeNormal: TAVIVector3D;
  majorAxisDirection: TAVIVector3D;
  minorAxisDirection: TAVIVector3D;
}

export type AccessVesselId = 'thoracic-aorta' | 'abdominal-aorta' | 'iliac-left' | 'iliac-right';

export interface AccessVesselCrossSection {
  /** cumulative arc-length from path start, mm */
  arcLengthMm: number;
  /** world position of the centerline sample point */
  center: TAVIVector3D;
  /** min lumen diameter at this section (rotating-caliper min width), mm */
  minDiameterMm: number;
  /** equivalent (area-derived) diameter, mm */
  equivalentDiameterMm: number;
  areaMm2: number;
  /** false when auto-seg failed / was rejected at this section */
  valid: boolean;
}

export interface AccessVesselResult {
  vesselId: AccessVesselId;
  /** control points of the curved path, world coords */
  pathPoints: TAVIVector3D[];
  /** per-section samples ordered by arcLengthMm */
  sections: AccessVesselCrossSection[];
  /** straight-line chord between first and last valid section center, mm */
  chordLengthMm: number;
  /** summed path length over valid sections, mm */
  pathLengthMm: number;
  /** tortuosity index = pathLengthMm / chordLengthMm (≥ 1), dimensionless */
  tortuosityIndex: number;
  /** total cumulative angulation across the path, degrees */
  cumulativeAngulationDeg: number;
  /** MINIMUM minDiameterMm over all valid sections (the access-limiting lumen), mm */
  minLumenDiameterMm: number;
  /** arc-length at which minLumenDiameterMm occurs, mm */
  minLumenAtArcLengthMm: number;
}

export type SinusLabel = 'LCS' | 'RCS' | 'NCS'; // Left / Right / Non-coronary sinus

export interface TAVISinusDiameterResult {
  label: SinusLabel;
  /** Two world points defining the sinus width. */
  pointA: TAVIVector3D;
  pointB: TAVIVector3D;
  diameterMm: number;
  /** Optional sinus floor (nadir) world point for the height measurement. */
  floorPoint?: TAVIVector3D;
  /** |perpendicular distance from floor to the STJ plane|, mm. */
  heightMm?: number;
}

export interface TAVICalciumResult {
  thresholdHU: number;
  totalAreaMm2: number;
  hyperdenseAreaMm2: number;
  fractionAboveThreshold: number;
  agatstonScore2D: number;
  totalSamples: number;
  samplesAboveThreshold: number;
}

export interface TAVIFluoroAngleResult {
  laoRaoDegrees: number;
  cranialCaudalDegrees: number;
  laoRaoLabel: 'LAO' | 'RAO';
  cranialCaudalLabel: 'CRANIAL' | 'CAUDAL';
  planeNormal: TAVIVector3D;
}

export interface TAVIProjectionConfirmationResult {
  confirmationNormal: TAVIVector3D;
  confirmationAngle: TAVIFluoroAngleResult;
  normalDifferenceDegrees: number;
  laoRaoDifferenceDegrees: number;
  cranialCaudalDifferenceDegrees: number;
}

export interface TAVIContourSnapshot {
  label?: string;
  seriesUID?: string;
  seriesDescription?: string;
  studyInstanceUID?: string;
  patientName?: string;
  patientID?: string;
  patientUID?: string;
  patientBirthDate?: string;
  pixelPoints?: TAPoint2D[]; // Optional pixel representation
  worldPoints: TAVIVector3D[];
  pixelValues?: Float32Array;
  pixelAreaMm2?: number;
  roiType?: number;
  sliceIndex?: number;
  planeOrigin: TAVIVector3D;
  planeNormal: TAVIVector3D;
}

export interface TAVIPointSnapshot {
  label?: string;
  seriesUID?: string;
  seriesDescription?: string;
  studyInstanceUID?: string;
  patientName?: string;
  patientID?: string;
  patientUID?: string;
  patientBirthDate?: string;
  pixelPoint?: TAPoint2D;
  sliceIndex?: number;
  roiType?: number;
  worldPoint: TAVIVector3D;
}

export interface TAPoint2D {
  x: number;
  y: number;
}

export const ACCESS_ROUTES = [
  'Unknown',
  'Transfemoral Right',
  'Transfemoral Left',
  'Transapical',
  'Transaortic',
  'Subclavian Right',
  'Subclavian Left',
  'Suprasternal',
  'Transcaval',
  'Other',
] as const;

export type AccessRoute = (typeof ACCESS_ROUTES)[number];

export const PIGTAIL_ACCESS_ROUTES = [
  'Unknown',
  'Transfemoral Right',
  'Transfemoral Left',
  'Radial Right',
  'Radial Left',
  'Other',
] as const;

export type PigtailAccessRoute = (typeof PIGTAIL_ACCESS_ROUTES)[number];
