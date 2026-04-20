import type { VesselContour, QCAMeasurements } from './QCATypes';

/**
 * Compute interpolated reference diameters using proximal and distal healthy segments.
 * Uses linear interpolation between the average diameters of the proximal and distal
 * 20% of the vessel segment (excluding the most stenotic region).
 */
export function computeReferenceDiameters(contour: VesselContour): number[] {
  const { diameters, cumulativeLength } = contour;
  const n = diameters.length;
  if (n < 5) return diameters.slice();

  const totalLength = cumulativeLength[n - 1];

  // Average the proximal 20% and distal 20% for reference
  const proxEnd = Math.max(3, Math.floor(n * 0.2));
  const distStart = Math.min(n - 4, Math.floor(n * 0.8));

  let proxSum = 0;
  for (let i = 0; i < proxEnd; i++) proxSum += diameters[i];
  const proxRef = proxSum / proxEnd;

  let distSum = 0;
  let distCount = 0;
  for (let i = distStart; i < n; i++) { distSum += diameters[i]; distCount++; }
  const distRef = distSum / distCount;

  // Linear interpolation between proximal and distal reference
  const refDiameters: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = totalLength > 0 ? cumulativeLength[i] / totalLength : i / (n - 1);
    refDiameters.push(proxRef + (distRef - proxRef) * t);
  }

  return refDiameters;
}

/**
 * Detect lesion boundaries: where diameter drops below a threshold relative to reference.
 */
function detectLesionBoundaries(
  diameters: number[],
  referenceDiameters: number[],
  mldIndex: number,
  threshold: number = 0.5
): [number, number] {
  const n = diameters.length;

  // Search left from MLD for lesion start
  let lesionStart = mldIndex;
  for (let i = mldIndex - 1; i >= 0; i--) {
    const ratio = diameters[i] / referenceDiameters[i];
    if (ratio >= (1 - threshold * 0.5)) {
      lesionStart = i + 1;
      break;
    }
    if (i === 0) lesionStart = 0;
  }

  // Search right from MLD for lesion end
  let lesionEnd = mldIndex;
  for (let i = mldIndex + 1; i < n; i++) {
    const ratio = diameters[i] / referenceDiameters[i];
    if (ratio >= (1 - threshold * 0.5)) {
      lesionEnd = i - 1;
      break;
    }
    if (i === n - 1) lesionEnd = n - 1;
  }

  return [lesionStart, lesionEnd];
}

/**
 * Compute all QCA measurements from a vessel contour.
 */
export function computeQCAMeasurements(
  contour: VesselContour,
  referenceDiameters: number[]
): QCAMeasurements {
  const { diameters, areas, cumulativeLength } = contour;
  const n = diameters.length;

  // Find MLD
  let mld = Infinity;
  let mldIndex = 0;
  for (let i = 0; i < n; i++) {
    if (diameters[i] < mld) {
      mld = diameters[i];
      mldIndex = i;
    }
  }

  const mldPosition = cumulativeLength[mldIndex];
  const refAtMLD = referenceDiameters[mldIndex];
  const refAreaAtMLD = Math.PI * (refAtMLD / 2) ** 2;
  const mla = areas[mldIndex];

  // Diameter Stenosis
  const diameterStenosis = refAtMLD > 0 ? (1 - mld / refAtMLD) * 100 : 0;

  // Area Stenosis
  const areaStenosis = refAreaAtMLD > 0 ? (1 - mla / refAreaAtMLD) * 100 : 0;

  // Lesion boundaries
  const [lesionStartIndex, lesionEndIndex] = detectLesionBoundaries(diameters, referenceDiameters, mldIndex);
  const lesionLength = cumulativeLength[lesionEndIndex] - cumulativeLength[lesionStartIndex];

  // Proximal and distal reference diameters
  const proxEnd = Math.max(1, Math.floor(n * 0.2));
  let proxSum = 0;
  for (let i = 0; i < proxEnd; i++) proxSum += diameters[i];
  const proximalRefDiameter = proxSum / proxEnd;

  const distStart = Math.min(n - 2, Math.floor(n * 0.8));
  let distSum = 0;
  let distCount = 0;
  for (let i = distStart; i < n; i++) { distSum += diameters[i]; distCount++; }
  const distalRefDiameter = distSum / distCount;

  // DMax
  const dMax = Math.max(...diameters);

  // Segment length
  const segmentLength = cumulativeLength[n - 1];

  return {
    mld,
    mldIndex,
    mldPosition,
    referenceDiameter: refAtMLD,
    diameterStenosis,
    areaStenosis,
    lesionLength,
    lesionStartIndex,
    lesionEndIndex,
    proximalRefDiameter,
    distalRefDiameter,
    dMax,
    segmentLength,
  };
}
