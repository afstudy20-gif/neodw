import {
  TAVIVector3D,
  TAVIPoint2D,
  TAVIGeometryResult,
  TAVICalciumResult,
  TAVIFluoroAngleResult,
  TAVIProjectionConfirmationResult,
} from './TAVITypes';

const kTAVIGeometryEpsilon = 1.0e-9;

interface TAVIPlaneBasis {
  basisU: TAVIVector3D;
  basisV: TAVIVector3D;
  normal: TAVIVector3D;
}

interface TAVIGeometryComputation {
  area: number;
  perimeter: number;
  minimumDiameter: number;
  maximumDiameter: number;
  centroid: TAVIVector3D;
  normal: TAVIVector3D;
  majorAxisDirection: TAVIVector3D;
  minorAxisDirection: TAVIVector3D;
}

export class TAVIGeometry {
  static vectorAdd(a: TAVIVector3D, b: TAVIVector3D): TAVIVector3D {
    return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
  }

  static vectorSubtract(a: TAVIVector3D, b: TAVIVector3D): TAVIVector3D {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  }

  static vectorScale(a: TAVIVector3D, scale: number): TAVIVector3D {
    return { x: a.x * scale, y: a.y * scale, z: a.z * scale };
  }

  static vectorDot(a: TAVIVector3D, b: TAVIVector3D): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  }

  static vectorCross(a: TAVIVector3D, b: TAVIVector3D): TAVIVector3D {
    return {
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x,
    };
  }

  static vectorLength(a: TAVIVector3D): number {
    return Math.sqrt(this.vectorDot(a, a));
  }

  static vectorIsZero(a: TAVIVector3D): boolean {
    return (
      Math.abs(a.x) <= Number.EPSILON &&
      Math.abs(a.y) <= Number.EPSILON &&
      Math.abs(a.z) <= Number.EPSILON
    );
  }

  static vectorNormalize(a: TAVIVector3D): TAVIVector3D {
    const length = this.vectorLength(a);
    if (length <= Number.EPSILON) {
      return { x: 0, y: 0, z: 0 };
    }
    return this.vectorScale(a, 1.0 / length);
  }

  static vectorDistance(a: TAVIVector3D, b: TAVIVector3D): number {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  }

  static cross2D(origin: TAVIPoint2D, a: TAVIPoint2D, b: TAVIPoint2D): number {
    return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
  }

  static distance2D(a: TAVIPoint2D, b: TAVIPoint2D): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  static comparePoint2D(a: TAVIPoint2D, b: TAVIPoint2D): number {
    if (Math.abs(a.x - b.x) > kTAVIGeometryEpsilon) {
      return a.x < b.x ? -1 : 1;
    }
    if (Math.abs(a.y - b.y) > kTAVIGeometryEpsilon) {
      return a.y < b.y ? -1 : 1;
    }
    return 0;
  }

  static sanitizedWorldPoints(worldPoints: TAVIVector3D[]): TAVIVector3D[] {
    const sanitized = [...worldPoints];
    if (sanitized.length > 3) {
      const first = sanitized[0];
      const last = sanitized[sanitized.length - 1];
      if (this.vectorLength(this.vectorSubtract(first, last)) < 1.0e-6) {
        sanitized.pop();
      }
    }
    return sanitized;
  }

  static fallbackNormalForWorldPoints(worldPoints: TAVIVector3D[]): TAVIVector3D {
    if (worldPoints.length < 3) {
      return { x: 0, y: 0, z: 1 };
    }
    const origin = worldPoints[0];
    for (let i = 1; i + 1 < worldPoints.length; i++) {
      const a = this.vectorSubtract(worldPoints[i], origin);
      const b = this.vectorSubtract(worldPoints[i + 1], origin);
      const cross = this.vectorCross(a, b);
      if (!this.vectorIsZero(cross)) {
        return this.vectorNormalize(cross);
      }
    }
    return { x: 0, y: 0, z: 1 };
  }

  static planeBasisMake(planeNormal: TAVIVector3D): TAVIPlaneBasis {
    let normal = this.vectorNormalize(planeNormal);
    if (this.vectorIsZero(normal)) {
      normal = { x: 0, y: 0, z: 1 };
    }

    const helper = Math.abs(normal.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
    let basisU = this.vectorNormalize(this.vectorCross(helper, normal));
    if (this.vectorIsZero(basisU)) {
      basisU = this.vectorNormalize(this.vectorCross({ x: 1, y: 0, z: 0 }, normal));
    }
    const basisV = this.vectorNormalize(this.vectorCross(normal, basisU));
    return { basisU, basisV, normal };
  }

  static projectWorldPointWithBasis(
    worldPoint: TAVIVector3D,
    planeOrigin: TAVIVector3D,
    basis: TAVIPlaneBasis
  ): TAVIPoint2D {
    const delta = this.vectorSubtract(worldPoint, planeOrigin);
    return {
      x: this.vectorDot(delta, basis.basisU),
      y: this.vectorDot(delta, basis.basisV),
    };
  }

  static projectWorldPointsWithBasis(
    worldPoints: TAVIVector3D[],
    planeOrigin: TAVIVector3D,
    basis: TAVIPlaneBasis
  ): TAVIPoint2D[] {
    return worldPoints.map((p) => this.projectWorldPointWithBasis(p, planeOrigin, basis));
  }

  static convexHull(points: TAVIPoint2D[]): TAVIPoint2D[] {
    if (points.length <= 3) return points;

    const sorted = [...points].sort(this.comparePoint2D);

    const lower: TAVIPoint2D[] = [];
    for (const p of sorted) {
      while (
        lower.length >= 2 &&
        this.cross2D(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
      ) {
        lower.pop();
      }
      lower.push(p);
    }

    const upper: TAVIPoint2D[] = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
      const p = sorted[i];
      while (
        upper.length >= 2 &&
        this.cross2D(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
      ) {
        upper.pop();
      }
      upper.push(p);
    }

    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  static calculatePrincipalAxes(
    projectedPoints: TAVIPoint2D[],
    basis: TAVIPlaneBasis
  ): { major: TAVIVector3D; minor: TAVIVector3D; axisRatio: number } {
    if (projectedPoints.length < 2) {
      return { major: basis.basisU, minor: basis.basisV, axisRatio: 1.0 };
    }

    let meanX = 0,
      meanY = 0;
    for (const p of projectedPoints) {
      meanX += p.x;
      meanY += p.y;
    }
    meanX /= projectedPoints.length;
    meanY /= projectedPoints.length;

    let sxx = 0,
      syy = 0,
      sxy = 0;
    for (const p of projectedPoints) {
      const dx = p.x - meanX;
      const dy = p.y - meanY;
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
    }
    sxx /= projectedPoints.length;
    syy /= projectedPoints.length;
    sxy /= projectedPoints.length;

    const trace = sxx + syy;
    const determinantTerm = Math.sqrt(Math.max(0, (sxx - syy) * (sxx - syy) + 4 * sxy * sxy));
    const lambda1 = Math.max(0, (trace + determinantTerm) * 0.5);
    const lambda2 = Math.max(0, (trace - determinantTerm) * 0.5);

    let vx = 1.0,
      vy = 0.0;
    if (Math.abs(sxy) > kTAVIGeometryEpsilon || Math.abs(lambda1 - sxx) > kTAVIGeometryEpsilon) {
      vx = sxy;
      vy = lambda1 - sxx;
      const len = Math.hypot(vx, vy);
      if (len > kTAVIGeometryEpsilon) {
        vx /= len;
        vy /= len;
      } else {
        vx = 1.0;
        vy = 0.0;
      }
    }

    const majorWorld = this.vectorNormalize(
      this.vectorAdd(this.vectorScale(basis.basisU, vx), this.vectorScale(basis.basisV, vy))
    );
    let minorWorld = this.vectorNormalize(this.vectorCross(basis.normal, majorWorld));
    if (this.vectorIsZero(minorWorld)) minorWorld = basis.basisV;

    let axisRatio = 1.0;
    if (lambda2 > kTAVIGeometryEpsilon) {
      axisRatio = Math.max(1.0, Math.sqrt(lambda1 / lambda2));
    }

    return { major: majorWorld, minor: minorWorld, axisRatio };
  }

  static calculateContourGeometry(
    worldPoints: TAVIVector3D[],
    planeNormal: TAVIVector3D
  ): TAVIGeometryComputation {
    const computation: TAVIGeometryComputation = {
      area: 0,
      perimeter: 0,
      minimumDiameter: Number.MAX_VALUE,
      maximumDiameter: 0,
      centroid: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: 0, z: 0 },
      majorAxisDirection: { x: 0, y: 0, z: 0 },
      minorAxisDirection: { x: 0, y: 0, z: 0 },
    };

    const sanitized = this.sanitizedWorldPoints(worldPoints);
    computation.normal = this.vectorNormalize(planeNormal);
    if (this.vectorIsZero(computation.normal)) {
      computation.normal = this.fallbackNormalForWorldPoints(sanitized);
    }

    for (const p of sanitized) {
      computation.centroid = this.vectorAdd(computation.centroid, p);
    }
    computation.centroid =
      sanitized.length > 0 ? this.vectorScale(computation.centroid, 1.0 / sanitized.length) : { x: 0, y: 0, z: 0 };

    const basis = this.planeBasisMake(computation.normal);
    const projected = this.projectWorldPointsWithBasis(sanitized, computation.centroid, basis);

    for (let i = 0; i < projected.length; i++) {
      const current = projected[i];
      const next = projected[(i + 1) % projected.length];
      computation.perimeter += this.distance2D(current, next);
      computation.area += current.x * next.y - next.x * current.y;
    }
    computation.area = Math.abs(computation.area) * 0.5;

    const hull = this.convexHull(projected);
    for (let i = 0; i < hull.length; i++) {
      for (let j = i + 1; j < hull.length; j++) {
        computation.maximumDiameter = Math.max(
          computation.maximumDiameter,
          this.distance2D(hull[i], hull[j])
        );
      }
    }

    if (hull.length >= 2) {
      for (let i = 0; i < hull.length; i++) {
        const a = hull[i];
        const b = hull[(i + 1) % hull.length];
        const edgeLength = this.distance2D(a, b);
        if (edgeLength <= kTAVIGeometryEpsilon) continue;

        const nx = -(b.y - a.y) / edgeLength;
        const ny = (b.x - a.x) / edgeLength;
        let minProjection = Number.MAX_VALUE;
        let maxProjection = -Number.MAX_VALUE;

        for (const p of hull) {
          const projection = p.x * nx + p.y * ny;
          minProjection = Math.min(minProjection, projection);
          maxProjection = Math.max(maxProjection, projection);
        }
        computation.minimumDiameter = Math.min(
          computation.minimumDiameter,
          maxProjection - minProjection
        );
      }
    }

    if (computation.minimumDiameter === Number.MAX_VALUE) {
      computation.minimumDiameter = 0.0;
    }

    const { major, minor } = this.calculatePrincipalAxes(projected, basis);
    computation.majorAxisDirection = major;
    computation.minorAxisDirection = minor;

    return computation;
  }

  static geometryForWorldContour(
    worldPoints: TAVIVector3D[],
    planeNormal: TAVIVector3D
  ): TAVIGeometryResult | null {
    if (worldPoints.length < 3) return null;
    const computation = this.calculateContourGeometry(worldPoints, planeNormal);
    if (computation.area <= 0) return null;

    return {
      perimeterMm: computation.perimeter,
      areaMm2: computation.area,
      equivalentDiameterMm: computation.area > 0 ? 2.0 * Math.sqrt(computation.area / Math.PI) : 0,
      minimumDiameterMm: computation.minimumDiameter,
      maximumDiameterMm: computation.maximumDiameter,
      centroid: computation.centroid,
      planeNormal: computation.normal,
      majorAxisDirection: computation.majorAxisDirection,
      minorAxisDirection: computation.minorAxisDirection,
    };
  }

  static assistedAnnulusGeometryForWorldContour(
    worldPoints: TAVIVector3D[],
    planeNormal: TAVIVector3D
  ): TAVIGeometryResult | null {
    if (worldPoints.length < 3) return null;

    const sanitized = this.sanitizedWorldPoints(worldPoints);
    let normal = this.vectorNormalize(planeNormal);
    if (this.vectorIsZero(normal)) {
      normal = this.fallbackNormalForWorldPoints(sanitized);
    }

    let centroid = { x: 0, y: 0, z: 0 };
    for (const p of sanitized) centroid = this.vectorAdd(centroid, p);
    centroid = this.vectorScale(centroid, 1.0 / sanitized.length);

    const basis = this.planeBasisMake(normal);
    const projected = this.projectWorldPointsWithBasis(sanitized, centroid, basis);
    if (projected.length < 3) return null;

    let area = 0;
    for (let i = 0; i < projected.length; i++) {
      const current = projected[i];
      const next = projected[(i + 1) % projected.length];
      area += current.x * next.y - next.x * current.y;
    }
    area = Math.abs(area) * 0.5;
    if (area <= 0) return null;

    const { major, minor, axisRatio } = this.calculatePrincipalAxes(projected, basis);
    const ratio = Math.max(axisRatio, 1.0);

    const majorDiameter = 2.0 * Math.sqrt((area * ratio) / Math.PI);
    const minorDiameter = 2.0 * Math.sqrt(area / (Math.PI * ratio));
    const semiMajor = majorDiameter * 0.5;
    const semiMinor = minorDiameter * 0.5;
    const h = Math.pow(semiMajor - semiMinor, 2) / Math.pow(semiMajor + semiMinor, 2);
    const perimeter =
      Math.PI * (semiMajor + semiMinor) * (1.0 + (3.0 * h) / (10.0 + Math.sqrt(Math.max(0, 4.0 - 3.0 * h))));

    return {
      perimeterMm: perimeter,
      areaMm2: area,
      equivalentDiameterMm: 2.0 * Math.sqrt(area / Math.PI),
      minimumDiameterMm: minorDiameter,
      maximumDiameterMm: majorDiameter,
      centroid: centroid,
      planeNormal: normal,
      majorAxisDirection: major,
      minorAxisDirection: minor,
    };
  }

  static distanceFromPointToPlane(
    point: TAVIVector3D,
    origin: TAVIVector3D,
    normal: TAVIVector3D
  ): number {
    const normalizedNormal = this.vectorNormalize(normal);
    if (this.vectorIsZero(normalizedNormal)) return 0;
    return this.vectorDot(this.vectorSubtract(point, origin), normalizedNormal);
  }

  static fluoroAngleForPlaneNormal(planeNormal: TAVIVector3D): TAVIFluoroAngleResult {
    const normal = this.vectorNormalize(planeNormal);
    if (this.vectorIsZero(normal)) return {
      laoRaoLabel: 'LAO', cranialCaudalLabel: 'CRANIAL',
      laoRaoDegrees: 0, cranialCaudalDegrees: 0, planeNormal: normal
    };

    // TAVI "coplanar" view: C-arm beam lies IN the annulus plane (beam · normal = 0)
    // At AP (α=0): beam = (0, -1, 0) in LPS
    // beam · normal = -ny → for coplanar: need ny ≈ 0 (pure AP is coplanar only if ny≈0)
    // General coplanar angle: beam ⊥ normal
    //   tan(β) = -(sin(α)*nx - cos(α)*ny) / nz
    // At the "optimal" α where |β| is minimized:
    //   α_opt = atan2(nx, -ny) (aligns the horizontal beam component with the normal's horizontal projection)
    const laoRao = (Math.atan2(normal.x, -normal.y) * 180.0) / Math.PI;
    // Then compute β at α_opt:
    const alphaRad = Math.atan2(normal.x, -normal.y);
    const horizProjection = Math.sin(alphaRad) * normal.x - Math.cos(alphaRad) * normal.y;
    const cranialCaudal = Math.abs(normal.z) > 0.001
      ? (Math.atan2(-horizProjection, normal.z) * 180.0) / Math.PI
      : 0;

    return {
      laoRaoLabel: laoRao >= 0 ? 'LAO' : 'RAO',
      cranialCaudalLabel: cranialCaudal >= 0 ? 'CRANIAL' : 'CAUDAL',
      laoRaoDegrees: Math.abs(laoRao),
      cranialCaudalDegrees: Math.abs(cranialCaudal),
      planeNormal: normal,
    };
  }

  static angleBetweenVectors(lhs: TAVIVector3D, rhs: TAVIVector3D): number {
    const normLhs = this.vectorNormalize(lhs);
    const normRhs = this.vectorNormalize(rhs);
    if (this.vectorIsZero(normLhs) || this.vectorIsZero(normRhs)) return 0;

    const clampedDot = Math.max(-1.0, Math.min(1.0, this.vectorDot(normLhs, normRhs)));
    return (Math.acos(clampedDot) * 180.0) / Math.PI;
  }

  static projectionConfirmationForReferenceNormal(
    referenceNormal: TAVIVector3D,
    confirmationNormal: TAVIVector3D
  ): TAVIProjectionConfirmationResult | null {
    const normRef = this.vectorNormalize(referenceNormal);
    let normConf = this.vectorNormalize(confirmationNormal);
    if (this.vectorIsZero(normRef) || this.vectorIsZero(normConf)) return null;

    const invConf = this.vectorScale(normConf, -1.0);
    if (
      this.angleBetweenVectors(normRef, invConf) < this.angleBetweenVectors(normRef, normConf)
    ) {
      normConf = invConf;
    }

    const refAngle = this.fluoroAngleForPlaneNormal(normRef);
    const confAngle = this.fluoroAngleForPlaneNormal(normConf);

    return {
      confirmationNormal: normConf,
      confirmationAngle: confAngle,
      normalDifferenceDegrees: this.angleBetweenVectors(normRef, normConf),
      laoRaoDifferenceDegrees: Math.abs(refAngle.laoRaoDegrees - confAngle.laoRaoDegrees),
      cranialCaudalDifferenceDegrees: Math.abs(
        refAngle.cranialCaudalDegrees - confAngle.cranialCaudalDegrees
      ),
    };
  }

  static calciumResultForPixelValues(
    pixelValues: Float32Array,
    pixelAreaMm2: number,
    thresholdHU: number
  ): TAVICalciumResult {
    const totalSamples = pixelValues.length;
    let samplesAbove = 0;
    let agatstonScore2D = 0;

    for (let i = 0; i < totalSamples; i++) {
      const val = pixelValues[i];
      if (val >= thresholdHU) samplesAbove++;
      if (val >= 130) {
        let densityFactor = 1;
        if (val >= 400) densityFactor = 4;
        else if (val >= 300) densityFactor = 3;
        else if (val >= 200) densityFactor = 2;
        agatstonScore2D += pixelAreaMm2 * densityFactor;
      }
    }

    return {
      thresholdHU,
      totalSamples,
      totalAreaMm2: totalSamples * pixelAreaMm2,
      samplesAboveThreshold: samplesAbove,
      hyperdenseAreaMm2: samplesAbove * pixelAreaMm2,
      fractionAboveThreshold: totalSamples > 0 ? samplesAbove / totalSamples : 0,
      agatstonScore2D,
    };
  }

  static planeNormalForWorldPoints(worldPoints: TAVIVector3D[]): TAVIVector3D {
    return this.fallbackNormalForWorldPoints(this.sanitizedWorldPoints(worldPoints));
  }

  // ── Report Geometry (Phase 5) ──

  /**
   * Compute the perpendicularity curve: for each RAO/LAO angle (x-axis),
   * what cranial/caudal angle achieves perpendicularity to the annulus plane?
   *
   * The annulus plane normal defines the "coplanar" C-arm orientation.
   * For any given RAO/LAO rotation, we compute the required cranial/caudal
   * to keep the projection perpendicular to the annulus.
   *
   * Returns array of {laoRaoDeg, cranialCaudalDeg} pairs from -90 to +90.
   */
  static computePerpendicularityCurve(
    annulusNormal: TAVIVector3D
  ): { laoRaoDeg: number; cranialCaudalDeg: number }[] {
    const normal = this.vectorNormalize(annulusNormal);
    if (this.vectorIsZero(normal)) return [];

    const points: { laoRaoDeg: number; cranialCaudalDeg: number }[] = [];

    // TAVI "coplanar" / "deployment" view: the C-arm beam lies IN the annulus plane
    // so that the valve ring appears as a line (all cusps at the same level).
    // This means: beam · normal = 0 (beam perpendicular to normal)
    //
    // C-arm beam direction in DICOM LPS (X+=Left, Y+=Posterior, Z+=Superior):
    //   beam = (sin(α)*cos(β), -cos(α)*cos(β), sin(β))
    //   where α = LAO/RAO angle (positive = LAO), β = Cranial/Caudal (positive = Cranial)
    //   At (0°,0°): beam = (0, -1, 0) = AP direction
    //
    // Coplanar condition: beam · normal = 0:
    //   sin(α)*cos(β)*nx - cos(α)*cos(β)*ny + sin(β)*nz = 0
    //   cos(β) * [sin(α)*nx - cos(α)*ny] = -sin(β)*nz
    //   tan(β) = -[sin(α)*nx - cos(α)*ny] / nz
    //   β = atan2(-(sin(α)*nx - cos(α)*ny), nz)

    for (let deg = -60; deg <= 60; deg += 1) {
      const laoRaoRad = (deg * Math.PI) / 180;
      const horizProjection = Math.sin(laoRaoRad) * normal.x - Math.cos(laoRaoRad) * normal.y;
      // Avoid division by zero when nz ≈ 0
      if (Math.abs(normal.z) < 0.001) continue;
      const cranCaudRad = Math.atan2(-horizProjection, normal.z);
      const cranCaudDeg = (cranCaudRad * 180) / Math.PI;

      // Clamp to reasonable range
      if (Math.abs(cranCaudDeg) <= 60) {
        points.push({ laoRaoDeg: deg, cranialCaudalDeg: cranCaudDeg });
      }
    }

    return points;
  }

  /**
   * Compute the RAO/LAO feasibility table: for each 10-degree increment,
   * what is the corresponding cranial/caudal angle for perpendicularity?
   */
  static computeRAOLAOTable(
    annulusNormal: TAVIVector3D
  ): { raoDeg: number; cranialCaudalDeg: number; label: string }[] {
    let normal = this.vectorNormalize(annulusNormal);
    if (this.vectorIsZero(normal)) return [];

    const entries: { raoDeg: number; cranialCaudalDeg: number; label: string }[] = [];

    // Coplanar condition: beam · normal = 0 (beam IN annulus plane)
    // RAO Projection column (RAO 0-40)
    for (let rao = 0; rao <= 40; rao += 10) {
      const laoRaoRad = (-rao * Math.PI) / 180; // RAO is negative LAO
      const horizProjection = Math.sin(laoRaoRad) * normal.x - Math.cos(laoRaoRad) * normal.y;
      const cranCaudRad = Math.abs(normal.z) > 0.001 ? Math.atan2(-horizProjection, normal.z) : 0;
      const cranCaudDeg = (cranCaudRad * 180) / Math.PI;
      entries.push({
        raoDeg: rao,
        cranialCaudalDeg: cranCaudDeg,
        label: `RAO ${rao}°`,
      });
    }

    return entries;
  }

  /**
   * Compute LAO projection feasibility table.
   */
  static computeLAOTable(
    annulusNormal: TAVIVector3D
  ): { laoDeg: number; cranialCaudalDeg: number; label: string }[] {
    const normal = this.vectorNormalize(annulusNormal);
    if (this.vectorIsZero(normal)) return [];

    const entries: { laoDeg: number; cranialCaudalDeg: number; label: string }[] = [];

    // Coplanar condition: beam · normal = 0 (beam IN annulus plane)
    for (let lao = 0; lao <= 40; lao += 10) {
      const laoRaoRad = (lao * Math.PI) / 180;
      const horizProjection = Math.sin(laoRaoRad) * normal.x - Math.cos(laoRaoRad) * normal.y;
      const cranCaudRad = Math.abs(normal.z) > 0.001 ? Math.atan2(-horizProjection, normal.z) : 0;
      const cranCaudDeg = (cranCaudRad * 180) / Math.PI;
      entries.push({
        laoDeg: lao,
        cranialCaudalDeg: cranCaudDeg,
        label: `LAO ${lao}°`,
      });
    }

    return entries;
  }

  /**
   * Compute implantation plane angles for each cusp.
   * Each cusp-specific angle is the C-arm orientation that centers that cusp
   * in the projection while maintaining perpendicularity to the annulus plane.
   */
  static computeCuspImplantationAngles(
    annulusNormal: TAVIVector3D,
    annulusCentroid: TAVIVector3D,
    cuspLCC: TAVIVector3D,
    cuspNCC: TAVIVector3D,
    cuspRCC: TAVIVector3D
  ): {
    rccAnterior: TAVIFluoroAngleResult;
    lccPosterior: TAVIFluoroAngleResult;
    nccPosterior: TAVIFluoroAngleResult;
    lvView: TAVIFluoroAngleResult;
  } {
    // Each implantation plane is defined by rotating the annulus normal
    // toward the direction of the cusp from the centroid, creating a view
    // where that cusp appears centered.
    //
    // The cusp direction in the annulus plane gives the "viewing preference"
    // for that implantation angle.

    const computeCuspAngle = (cusp: TAVIVector3D): TAVIFluoroAngleResult => {
      // Direction from centroid to cusp, projected onto annulus plane
      const toCusp = this.vectorSubtract(cusp, annulusCentroid);
      const projected = this.vectorSubtract(
        toCusp,
        this.vectorScale(annulusNormal, this.vectorDot(toCusp, annulusNormal))
      );
      const projNorm = this.vectorNormalize(projected);

      if (this.vectorIsZero(projNorm)) {
        return this.fluoroAngleForPlaneNormal(annulusNormal);
      }

      // Rotate the annulus normal slightly toward this cusp direction
      // to create the implantation plane view
      const tiltAngle = 15 * Math.PI / 180; // ~15 degree tilt toward cusp
      const tilted = this.vectorNormalize(
        this.vectorAdd(
          this.vectorScale(annulusNormal, Math.cos(tiltAngle)),
          this.vectorScale(projNorm, Math.sin(tiltAngle))
        )
      );

      return this.fluoroAngleForPlaneNormal(tilted);
    };

    // RCC Anterior: view with RCC facing the operator
    const rccAnterior = computeCuspAngle(cuspRCC);

    // LCC Posterior: view centered on LCC
    const lccPosterior = computeCuspAngle(cuspLCC);

    // NCC Posterior: view centered on NCC
    const nccPosterior = computeCuspAngle(cuspNCC);

    // LV View: standard coplanar view (no cusp tilt)
    // Use the most RAO feasible caudal projection
    const coplanar = this.fluoroAngleForPlaneNormal(annulusNormal);
    const lvView: TAVIFluoroAngleResult = {
      ...coplanar,
      // Bias toward RAO/Caudal for LV view (avoid descending aorta)
      laoRaoLabel: 'RAO',
      laoRaoDegrees: Math.max(coplanar.laoRaoDegrees, 20),
      cranialCaudalLabel: 'CAUDAL',
      cranialCaudalDegrees: Math.max(coplanar.cranialCaudalDegrees, 30),
    };

    return { rccAnterior, lccPosterior, nccPosterior, lvView };
  }

  /** Compute a plane from three non-collinear points. Returns normal and centroid. */
  static planeFromThreePoints(
    p1: TAVIVector3D,
    p2: TAVIVector3D,
    p3: TAVIVector3D
  ): { normal: TAVIVector3D; centroid: TAVIVector3D } | null {
    const v1 = this.vectorSubtract(p2, p1);
    const v2 = this.vectorSubtract(p3, p1);
    const cross = this.vectorCross(v1, v2);
    if (this.vectorIsZero(cross)) return null; // collinear points

    const normal = this.vectorNormalize(cross);
    const centroid = this.vectorScale(
      this.vectorAdd(this.vectorAdd(p1, p2), p3),
      1.0 / 3.0
    );
    return { normal, centroid };
  }

  /** Project a 3D point onto a plane defined by an origin and normal. */
  static projectPointOntoPlane(
    point: TAVIVector3D,
    planeOrigin: TAVIVector3D,
    planeNormal: TAVIVector3D
  ): TAVIVector3D {
    const normal = this.vectorNormalize(planeNormal);
    if (this.vectorIsZero(normal)) return { ...point };
    const dist = this.distanceFromPointToPlane(point, planeOrigin, normal);
    return this.vectorSubtract(point, this.vectorScale(normal, dist));
  }

  /**
   * Catmull-Rom spline interpolation for a closed contour.
   * Takes N control points and produces N * segmentsPerEdge smooth points.
   */
  static interpolateContourCatmullRom(
    controlPoints: TAVIVector3D[],
    segmentsPerEdge = 8
  ): TAVIVector3D[] {
    const n = controlPoints.length;
    if (n < 3) return [...controlPoints];

    const result: TAVIVector3D[] = [];
    const alpha = 0.5; // centripetal Catmull-Rom

    for (let i = 0; i < n; i++) {
      const p0 = controlPoints[(i - 1 + n) % n];
      const p1 = controlPoints[i];
      const p2 = controlPoints[(i + 1) % n];
      const p3 = controlPoints[(i + 2) % n];

      for (let s = 0; s < segmentsPerEdge; s++) {
        const t = s / segmentsPerEdge;

        // Catmull-Rom basis functions
        const t2 = t * t;
        const t3 = t2 * t;
        const b0 = -alpha * t + 2 * alpha * t2 - alpha * t3;
        const b1 = 1 + (alpha - 3) * t2 + (2 - alpha) * t3;
        const b2 = alpha * t + (3 - 2 * alpha) * t2 + (alpha - 2) * t3;
        const b3 = -alpha * t2 + alpha * t3;

        result.push({
          x: b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x,
          y: b0 * p0.y + b1 * p1.y + b2 * p2.y + b3 * p3.y,
          z: b0 * p0.z + b1 * p1.z + b2 * p2.z + b3 * p3.z,
        });
      }
    }

    return result;
  }
}
