import type { Point2D } from './QCATypes';

/** Raw contour result in pixel (Point2D) space — caller converts to world coords. */
export interface RawContour {
  centerline: Point2D[];
  leftBorder: Point2D[];
  rightBorder: Point2D[];
  diameters: number[];
  areas: number[];
  cumulativeLength: number[];
}

function getPixelData(canvas: HTMLCanvasElement): { data: Uint8ClampedArray; width: number; height: number } {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Cannot get 2D context');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: imageData.data, width: canvas.width, height: canvas.height };
}

function sampleBrightness(data: Uint8ClampedArray, width: number, height: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 >= width || y0 >= height) return 255;
  return data[(y0 * width + x0) * 4];
}

/**
 * Build a smooth centerline using Catmull-Rom spline.
 */
export function buildCenterline(
  proximal: Point2D,
  distal: Point2D,
  intermediatePoints: Point2D[],
  samplesPerSegment: number = 20
): Point2D[] {
  const controlPoints = [proximal, ...intermediatePoints, distal];

  if (controlPoints.length === 2) {
    const result: Point2D[] = [];
    const n = Math.max(20, Math.ceil(Math.hypot(distal.x - proximal.x, distal.y - proximal.y) / 2));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      result.push({
        x: proximal.x + (distal.x - proximal.x) * t,
        y: proximal.y + (distal.y - proximal.y) * t,
      });
    }
    return result;
  }

  const result: Point2D[] = [];
  for (let seg = 0; seg < controlPoints.length - 1; seg++) {
    const p0 = controlPoints[Math.max(0, seg - 1)];
    const p1 = controlPoints[seg];
    const p2 = controlPoints[seg + 1];
    const p3 = controlPoints[Math.min(controlPoints.length - 1, seg + 2)];

    for (let i = 0; i < samplesPerSegment; i++) {
      const t = i / samplesPerSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      result.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  result.push(controlPoints[controlPoints.length - 1]);
  return result;
}

function computeNormals(centerline: Point2D[]): Point2D[] {
  const normals: Point2D[] = [];
  for (let i = 0; i < centerline.length; i++) {
    const prev = centerline[Math.max(0, i - 1)];
    const next = centerline[Math.min(centerline.length - 1, i + 1)];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    normals.push({ x: -dy / len, y: dx / len });
  }
  return normals;
}

/**
 * ANGIOGRAPHY-OPTIMIZED edge detection.
 *
 * In angiography: vessel = DARK (contrast absorbs X-ray), background = BRIGHT.
 * The vessel appears as a dark band. We need to find where:
 *   - Left edge: brightness transitions from BRIGHT → DARK (going left→right toward center)
 *   - Right edge: brightness transitions from DARK → BRIGHT (going past center)
 *
 * Strategy: Sample brightness along perpendicular scanline, find the dark trough,
 * then find where brightness rises above a threshold on each side.
 */
function detectVesselEdges(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  center: Point2D,
  normal: Point2D,
  searchRadius: number
): [number, number] {
  // Sample brightness profile along the perpendicular
  const samples: number[] = [];
  for (let offset = -searchRadius; offset <= searchRadius; offset++) {
    const x = center.x + normal.x * offset;
    const y = center.y + normal.y * offset;
    samples.push(sampleBrightness(data, width, height, x, y));
  }

  const n = samples.length;
  if (n < 5) return [-3, 3];
  const centerIdx = Math.floor(n / 2);

  // Find the darkest point near the center (vessel lumen)
  // Search within ±searchRadius/3 of center
  const nearRange = Math.floor(n / 3);
  let minVal = Infinity;
  let minIdx = centerIdx;
  for (let i = Math.max(0, centerIdx - nearRange); i <= Math.min(n - 1, centerIdx + nearRange); i++) {
    if (samples[i] < minVal) {
      minVal = samples[i];
      minIdx = i;
    }
  }

  // Background brightness: average of outer 20% on each side
  const outerN = Math.max(3, Math.floor(n * 0.15));
  let bgLeft = 0, bgRight = 0;
  for (let i = 0; i < outerN; i++) bgLeft += samples[i];
  for (let i = n - outerN; i < n; i++) bgRight += samples[i];
  bgLeft /= outerN;
  bgRight /= outerN;

  // Edge threshold: 50% between vessel (dark) and background (bright).
  // Standard QCA uses the full-width-half-maximum (FWHM) rule — the edge is
  // the 50% point between lumen minimum and adjacent background. Prior value
  // of 0.35 clamped contour to the dense contrast core and underestimated
  // diameters by ~2-3× on larger vessels (e.g. reported 1.4 mm for a real
  // ~3.5 mm RCA segment).
  const threshLeft = minVal + (bgLeft - minVal) * 0.5;
  const threshRight = minVal + (bgRight - minVal) * 0.5;

  // Find left edge: going from minIdx toward left, find where brightness crosses threshold
  let leftEdge = minIdx;
  for (let i = minIdx - 1; i >= 0; i--) {
    if (samples[i] >= threshLeft) {
      // Subpixel interpolation
      const frac = (threshLeft - samples[i + 1]) / (samples[i] - samples[i + 1]);
      leftEdge = i + 1 - frac;
      break;
    }
    if (i === 0) leftEdge = 0;
  }

  // Find right edge: going from minIdx toward right
  let rightEdge = minIdx;
  for (let i = minIdx + 1; i < n; i++) {
    if (samples[i] >= threshRight) {
      const frac = (threshRight - samples[i - 1]) / (samples[i] - samples[i - 1]);
      rightEdge = i - 1 + frac;
      break;
    }
    if (i === n - 1) rightEdge = n - 1;
  }

  // Convert to offset from center of scanline
  return [leftEdge - centerIdx, rightEdge - centerIdx];
}

function smooth(values: number[], windowSize: number): number[] {
  const result: number[] = [];
  const half = Math.floor(windowSize / 2);
  for (let i = 0; i < values.length; i++) {
    let sum = 0, count = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j++) {
      sum += values[j];
      count++;
    }
    result.push(sum / count);
  }
  return result;
}

/**
 * Main vessel contour detection for angiography.
 */
export function detectVesselContour(
  canvas: HTMLCanvasElement,
  proximal: Point2D,
  distal: Point2D,
  intermediatePoints: Point2D[],
  mmPerPixel: number,
  searchRadius: number = 40
): RawContour {
  const { data, width, height } = getPixelData(canvas);
  const centerline = buildCenterline(proximal, distal, intermediatePoints);
  const normals = computeNormals(centerline);

  const rawLeft: number[] = [];
  const rawRight: number[] = [];

  for (let i = 0; i < centerline.length; i++) {
    const [left, right] = detectVesselEdges(data, width, height, centerline[i], normals[i], searchRadius);
    rawLeft.push(left);
    rawRight.push(right);
  }

  // Smooth edge offsets to remove noise
  const smoothLeft = smooth(rawLeft, 9);
  const smoothRight = smooth(rawRight, 9);

  // Reject outliers: if an edge offset is more than 2x the median, clamp it
  const allWidths = smoothRight.map((r, i) => Math.abs(r - smoothLeft[i]));
  const sortedWidths = [...allWidths].sort((a, b) => a - b);
  const medianWidth = sortedWidths[Math.floor(sortedWidths.length / 2)];
  const maxWidth = medianWidth * 2.5;

  for (let i = 0; i < centerline.length; i++) {
    const w = Math.abs(smoothRight[i] - smoothLeft[i]);
    if (w > maxWidth) {
      // Clamp to median width centered around center
      const halfMed = medianWidth / 2;
      smoothLeft[i] = -halfMed;
      smoothRight[i] = halfMed;
    }
  }

  // Re-smooth after outlier rejection
  const finalLeft = smooth(smoothLeft, 5);
  const finalRight = smooth(smoothRight, 5);

  const leftBorder: Point2D[] = [];
  const rightBorder: Point2D[] = [];
  const diametersPixel: number[] = [];

  for (let i = 0; i < centerline.length; i++) {
    const c = centerline[i];
    const n = normals[i];
    leftBorder.push({ x: c.x + n.x * finalLeft[i], y: c.y + n.y * finalLeft[i] });
    rightBorder.push({ x: c.x + n.x * finalRight[i], y: c.y + n.y * finalRight[i] });
    diametersPixel.push(Math.abs(finalRight[i] - finalLeft[i]));
  }

  const diameters = diametersPixel.map(d => d * mmPerPixel);
  const areas = diameters.map(d => Math.PI * (d / 2) ** 2);

  const cumulativeLength: number[] = [0];
  for (let i = 1; i < centerline.length; i++) {
    const dx = centerline[i].x - centerline[i - 1].x;
    const dy = centerline[i].y - centerline[i - 1].y;
    cumulativeLength.push(cumulativeLength[i - 1] + Math.hypot(dx, dy) * mmPerPixel);
  }

  return { centerline, leftBorder, rightBorder, diameters, areas, cumulativeLength };
}

/**
 * Measure catheter width — kept for calibration.
 */
export function measureCatheterWidth(
  canvas: HTMLCanvasElement,
  lineStart: Point2D,
  lineEnd: Point2D
): { widthPx: number; edgeLeft: Point2D; edgeRight: Point2D; midPoint: Point2D } {
  const fallback = {
    widthPx: 15,
    edgeLeft: lineStart,
    edgeRight: lineEnd,
    midPoint: { x: (lineStart.x + lineEnd.x) / 2, y: (lineStart.y + lineEnd.y) / 2 },
  };
  const lineLen = Math.hypot(lineEnd.x - lineStart.x, lineEnd.y - lineStart.y);
  if (lineLen < 3) return fallback;
  return { ...fallback, widthPx: lineLen };
}
