export interface Point2D {
  x: number;
  y: number;
}

/** Cornerstone world coordinate (3D). For 2D stack images z is typically 0. */
export type WorldPoint = [number, number, number];

// ── Calibration ──

export type CatheterSize = '5F' | '6F' | '7F' | '8F';

export const CATHETER_DIAMETERS: Record<CatheterSize, number> = {
  '5F': 1.67,
  '6F': 2.0,
  '7F': 2.33,
  '8F': 2.67,
};

export interface CalibrationData {
  method: 'catheter' | 'pixel-spacing';
  mmPerPixel: number;
  catheterSize: CatheterSize;
  catheterDiameterMm: number;
  catheterPixelWidth: number;
  /** Detected edge positions in world coordinates — survives pan/zoom */
  catheterLine: [WorldPoint, WorldPoint] | null;
}

// ── Vessel Contour ──

export interface VesselContour {
  centerline: WorldPoint[];
  leftBorder: WorldPoint[];
  rightBorder: WorldPoint[];
  diameters: number[];           // mm at each centerline point
  areas: number[];               // mm² at each point (circular assumption)
  cumulativeLength: number[];    // mm arc length from proximal
}

// ── QCA Measurements ──

export interface QCAMeasurements {
  mld: number;                   // Minimum Lumen Diameter (mm)
  mldIndex: number;              // index into centerline array
  mldPosition: number;           // position along vessel (mm)
  referenceDiameter: number;     // interpolated reference at MLD
  diameterStenosis: number;      // % DS
  areaStenosis: number;          // % AS
  lesionLength: number;          // mm
  lesionStartIndex: number;
  lesionEndIndex: number;
  proximalRefDiameter: number;
  distalRefDiameter: number;
  dMax: number;
  segmentLength: number;         // total analyzed segment length (mm)
}

// ── FFR ──

export interface FFRResult {
  vffr: number;                  // distal vFFR value
  pullbackCurve: number[];       // vFFR at each centerline point
  aoPress: number;               // aortic pressure (mmHg)
  isSignificant: boolean;        // vFFR <= 0.80
}

// ── Workflow ──

export type QCAStep = 'images' | 'calibration' | 'analysis' | 'report';

export const QCA_STEPS: QCAStep[] = ['images', 'calibration', 'analysis', 'report'];

export const QCA_STEP_LABELS: Record<QCAStep, string> = {
  images: 'Images',
  calibration: 'Calibration',
  analysis: 'Analysis',
  report: 'Report',
};

export type InteractionMode =
  | 'none'
  | 'calibration-line'
  | 'place-proximal'
  | 'place-distal'
  | 'place-centerline'
  | 'drag-point';

export interface QCASession {
  step: QCAStep;
  interactionMode: InteractionMode;
  frameIndex: number;
  calibration: CalibrationData | null;
  /** All spatial points stored in world coordinates so they survive pan/zoom */
  proximalPoint: WorldPoint | null;
  distalPoint: WorldPoint | null;
  centerlinePoints: WorldPoint[];
  contour: VesselContour | null;
  referenceDiameters: number[];
  measurements: QCAMeasurements | null;
  ffrResult: FFRResult | null;
  chartMode: 'diameter' | 'area';
  analysisTab: 'segment' | 'obstruction';
  /** User-overridden lesion boundary indices (null = auto-detected) */
  lesionStartOverride: number | null;
  lesionEndOverride: number | null;
}

// ── Actions ──

export type QCAAction =
  | { type: 'SET_STEP'; step: QCAStep }
  | { type: 'SET_INTERACTION'; mode: InteractionMode }
  | { type: 'SET_FRAME'; index: number }
  | { type: 'SET_CALIBRATION'; data: CalibrationData }
  | { type: 'SET_PROXIMAL'; point: WorldPoint }
  | { type: 'SET_DISTAL'; point: WorldPoint }
  | { type: 'ADD_CENTERLINE_POINT'; point: WorldPoint }
  | { type: 'SET_CONTOUR'; contour: VesselContour; refDiameters: number[]; measurements: QCAMeasurements }
  | { type: 'SET_FFR'; result: FFRResult }
  | { type: 'SET_CHART_MODE'; mode: 'diameter' | 'area' }
  | { type: 'SET_ANALYSIS_TAB'; tab: 'segment' | 'obstruction' }
  | { type: 'MOVE_PROXIMAL'; point: WorldPoint }
  | { type: 'MOVE_DISTAL'; point: WorldPoint }
  | { type: 'SET_LESION_BOUNDS'; startIdx: number | null; endIdx: number | null }
  | { type: 'CLEAR_ANALYSIS' }
  | { type: 'RESET' }
  | { type: 'RESTORE'; state: QCASession };

export function createInitialSession(): QCASession {
  return {
    step: 'images',
    interactionMode: 'none',
    frameIndex: 0,
    calibration: null,
    proximalPoint: null,
    distalPoint: null,
    centerlinePoints: [],
    contour: null,
    referenceDiameters: [],
    measurements: null,
    ffrResult: null,
    chartMode: 'diameter',
    analysisTab: 'segment',
    lesionStartOverride: null,
    lesionEndOverride: null,
  };
}

export function qcaReducer(state: QCASession, action: QCAAction): QCASession {
  switch (action.type) {
    case 'SET_STEP':
      return { ...state, step: action.step, interactionMode: 'none' };
    case 'SET_INTERACTION':
      return { ...state, interactionMode: action.mode };
    case 'SET_FRAME':
      return { ...state, frameIndex: action.index };
    case 'SET_CALIBRATION':
      return { ...state, calibration: action.data };
    case 'SET_PROXIMAL':
      return { ...state, proximalPoint: action.point, contour: null, measurements: null, ffrResult: null, referenceDiameters: [] };
    case 'SET_DISTAL':
      return { ...state, distalPoint: action.point, contour: null, measurements: null, ffrResult: null, referenceDiameters: [] };
    case 'ADD_CENTERLINE_POINT':
      return { ...state, centerlinePoints: [...state.centerlinePoints, action.point] };
    case 'SET_CONTOUR':
      return { ...state, contour: action.contour, referenceDiameters: action.refDiameters, measurements: action.measurements, ffrResult: null };
    case 'SET_FFR':
      return { ...state, ffrResult: action.result };
    case 'SET_CHART_MODE':
      return { ...state, chartMode: action.mode };
    case 'SET_ANALYSIS_TAB':
      return { ...state, analysisTab: action.tab };
    case 'MOVE_PROXIMAL':
      return { ...state, proximalPoint: action.point };
    case 'MOVE_DISTAL':
      return { ...state, distalPoint: action.point };
    case 'SET_LESION_BOUNDS':
      return { ...state, lesionStartOverride: action.startIdx, lesionEndOverride: action.endIdx };
    case 'CLEAR_ANALYSIS':
      return { ...state, proximalPoint: null, distalPoint: null, centerlinePoints: [], contour: null, referenceDiameters: [], measurements: null, ffrResult: null, lesionStartOverride: null, lesionEndOverride: null };
    case 'RESET':
      return createInitialSession();
    case 'RESTORE':
      return action.state;
    default:
      return state;
  }
}
