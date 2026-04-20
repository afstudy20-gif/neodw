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
  pixelPoints: TAPoint2D[]; // Optional pixel representation
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
