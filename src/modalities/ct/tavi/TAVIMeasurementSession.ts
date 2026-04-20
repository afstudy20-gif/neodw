import {
  TAVIContourSnapshot,
  TAVIPointSnapshot,
  TAVIVector3D,
  TAVIGeometryResult,
  TAVICalciumResult,
  TAVIFluoroAngleResult,
  TAVIProjectionConfirmationResult,
  AccessRoute,
  PigtailAccessRoute,
} from './TAVITypes';
import { TAVIGeometry } from './TAVIGeometry';

export const TAVIStructureAorticAxis = 'aortic-axis';
export const TAVIStructureAnnulus = 'annulus';
export const TAVIStructureLeftOstium = 'left-ostium';
export const TAVIStructureRightOstium = 'right-ostium';
export const TAVIStructureSinus = 'sinus';
export const TAVIStructureSTJ = 'stj';
export const TAVIStructureAscendingAorta = 'ascending-aorta';
export const TAVIStructureSinusPoints = 'sinus-points';
export const TAVIStructureLVOT = 'lvot';
export const TAVIStructureMembranousSeptum = 'membranous-septum';

function TAVIRoundToHalfMillimeter(value: number): number {
  return Math.round(value * 2.0) / 2.0;
}

export class TAVIMeasurementSession {
  public calciumThresholdHU = 850.0;
  public cuspCalcificationGrade = 0;
  public annulusCalcificationGrade = 0;
  public useAssistedAnnulusForPlanning = false;
  public notes = '';

  public patientName?: string;
  public patientID?: string;
  public patientUID?: string;
  public patientBirthDate?: string;
  public studyInstanceUID?: string;

  /** Aortic axis: 2 points — [0] = LVOT center (below valve), [1] = ascending aorta center (above valve) */
  public aorticAxisPointSnapshots: TAVIPointSnapshot[] = [];
  /** Computed aortic axis direction vector (normalized, from LVOT toward aorta) */
  public aorticAxisDirection?: TAVIVector3D | null;
  /** Aortic axis length in mm */
  public aorticAxisLengthMm?: number | null;

  public annulusSnapshot?: TAVIContourSnapshot;
  public leftOstiumSnapshot?: TAVIPointSnapshot;
  public rightOstiumSnapshot?: TAVIPointSnapshot;
  public sinusSnapshot?: TAVIContourSnapshot;
  public stjSnapshot?: TAVIContourSnapshot;
  public ascendingAortaSnapshot?: TAVIContourSnapshot;
  public lvotSnapshot?: TAVIContourSnapshot;

  public sinusPointSnapshots: TAVIPointSnapshot[] = [];
  public membranousSeptumPointSnapshots: TAVIPointSnapshot[] = [];

  /** Three-point cusp definition (ProSizeAV-style) */
  public cuspLCC?: TAVIVector3D;
  public cuspNCC?: TAVIVector3D;
  public cuspRCC?: TAVIVector3D;
  /** Annulus plane derived from 3 cusp nadirs */
  public annulusPlaneNormal?: TAVIVector3D;
  public annulusPlaneCentroid?: TAVIVector3D;

  public annulusGeometry?: TAVIGeometryResult | null;
  public assistedAnnulusGeometry?: TAVIGeometryResult | null;
  public lvotGeometry?: TAVIGeometryResult | null;
  public sinusGeometry?: TAVIGeometryResult | null;
  public stjGeometry?: TAVIGeometryResult | null;
  public ascendingAortaGeometry?: TAVIGeometryResult | null;

  public annulusCalcium?: TAVICalciumResult | null;
  public lvotCalcium?: TAVICalciumResult | null;
  public sinusCalcium?: TAVICalciumResult | null;
  public stjCalcium?: TAVICalciumResult | null;
  public ascendingAortaCalcium?: TAVICalciumResult | null;

  /** Multi-level cross-section thumbnails (ProSizeAV page 2 style) */
  public multiLevelThumbnails: Map<number, string> = new Map();
  /** Multi-level geometry results keyed by distance from annulus plane */
  public multiLevelGeometries: Map<number, TAVIGeometryResult> = new Map();

  public fluoroAngle?: TAVIFluoroAngleResult | null;
  public projectionConfirmation?: TAVIProjectionConfirmationResult | null;

  public leftCoronaryHeightMm?: number | null;
  public rightCoronaryHeightMm?: number | null;
  public membranousSeptumLengthMm?: number | null;
  public horizontalAortaAngleDegrees = 0;
  public virtualValveDiameterMm = 0;
  public hasManualVirtualValveDiameter = false;
  public plannedAccess: AccessRoute = 'Unknown';
  public plannedPigtailAccess: PigtailAccessRoute = 'Unknown';

  /** Reset all captured measurements and computed results */
  public reset(): void {
    this.aorticAxisPointSnapshots = [];
    this.aorticAxisDirection = null;
    this.aorticAxisLengthMm = null;
    this.annulusSnapshot = undefined;
    this.leftOstiumSnapshot = undefined;
    this.rightOstiumSnapshot = undefined;
    this.sinusSnapshot = undefined;
    this.stjSnapshot = undefined;
    this.ascendingAortaSnapshot = undefined;
    this.lvotSnapshot = undefined;
    this.sinusPointSnapshots = [];
    this.membranousSeptumPointSnapshots = [];
    this.cuspLCC = undefined;
    this.cuspNCC = undefined;
    this.cuspRCC = undefined;
    this.annulusPlaneNormal = undefined;
    this.annulusPlaneCentroid = undefined;
    this.annulusGeometry = null;
    this.assistedAnnulusGeometry = null;
    this.lvotGeometry = null;
    this.sinusGeometry = null;
    this.stjGeometry = null;
    this.ascendingAortaGeometry = null;
    this.annulusCalcium = null;
    this.lvotCalcium = null;
    this.sinusCalcium = null;
    this.stjCalcium = null;
    this.ascendingAortaCalcium = null;
    this.multiLevelThumbnails.clear();
    this.multiLevelGeometries.clear();
    this.annulusRawContourPoints = [];
    this.fluoroAngle = null;
    this.projectionConfirmation = null;
    this.leftCoronaryHeightMm = null;
    this.rightCoronaryHeightMm = null;
    this.membranousSeptumLengthMm = null;
    this.horizontalAortaAngleDegrees = 0;
    this.virtualValveDiameterMm = 0;
    this.hasManualVirtualValveDiameter = false;
    this.plannedAccess = 'Unknown';
    this.plannedPigtailAccess = 'Unknown';
    this.useAssistedAnnulusForPlanning = false;
    this.calciumThresholdHU = 850.0;
    this.cuspCalcificationGrade = 0;
    this.annulusCalcificationGrade = 0;
    this.notes = '';
  }

  private applyMetadataFromContour(snapshot?: TAVIContourSnapshot) {
    if (!snapshot) return;
    this.patientName = snapshot.patientName || this.patientName;
    this.patientID = snapshot.patientID || this.patientID;
    this.patientUID = snapshot.patientUID || this.patientUID;
    this.patientBirthDate = snapshot.patientBirthDate || this.patientBirthDate;
    this.studyInstanceUID = snapshot.studyInstanceUID || this.studyInstanceUID;
  }

  private applyMetadataFromPoint(snapshot?: TAVIPointSnapshot) {
    if (!snapshot) return;
    this.patientName = snapshot.patientName || this.patientName;
    this.patientID = snapshot.patientID || this.patientID;
    this.patientUID = snapshot.patientUID || this.patientUID;
    this.patientBirthDate = snapshot.patientBirthDate || this.patientBirthDate;
    this.studyInstanceUID = snapshot.studyInstanceUID || this.studyInstanceUID;
  }

  public captureContourSnapshot(snapshot: TAVIContourSnapshot, identifier: string) {
    switch (identifier) {
      case TAVIStructureAnnulus:
        this.annulusSnapshot = { ...snapshot };
        break;
      case TAVIStructureLVOT:
        this.lvotSnapshot = { ...snapshot };
        break;
      case TAVIStructureSinus:
        this.sinusSnapshot = { ...snapshot };
        break;
      case TAVIStructureSTJ:
        this.stjSnapshot = { ...snapshot };
        break;
      case TAVIStructureAscendingAorta:
        this.ascendingAortaSnapshot = { ...snapshot };
        break;
    }
    this.applyMetadataFromContour(snapshot);
    this.recompute();
  }

  public capturePointSnapshot(snapshot: TAVIPointSnapshot, identifier: string) {
    switch (identifier) {
      case TAVIStructureLeftOstium:
        this.leftOstiumSnapshot = { ...snapshot };
        break;
      case TAVIStructureRightOstium:
        this.rightOstiumSnapshot = { ...snapshot };
        break;
    }
    this.applyMetadataFromPoint(snapshot);
    this.recompute();
  }

  public capturePointSnapshots(snapshots: TAVIPointSnapshot[], identifier: string) {
    if (identifier === TAVIStructureAorticAxis) {
      this.aorticAxisPointSnapshots = snapshots.map((s) => ({ ...s }));
      if (this.aorticAxisPointSnapshots.length > 0) {
        this.applyMetadataFromPoint(this.aorticAxisPointSnapshots[0]);
      }
      this.recompute();
    } else if (identifier === TAVIStructureSinusPoints) {
      this.sinusPointSnapshots = snapshots.map((s) => ({ ...s }));
      if (this.sinusPointSnapshots.length > 0) {
        this.applyMetadataFromPoint(this.sinusPointSnapshots[0]);
      }
      this.recompute();
    } else if (identifier === TAVIStructureMembranousSeptum) {
      this.membranousSeptumPointSnapshots = snapshots.map((s) => ({ ...s }));
      if (this.membranousSeptumPointSnapshots.length > 0) {
        this.applyMetadataFromPoint(this.membranousSeptumPointSnapshots[0]);
      }
      this.recompute();
    }
  }

  /**
   * Capture the annulus plane from 3 cusp nadir points (ProSizeAV-style).
   * Computes the plane normal via cross product and orients it along the aortic axis if available.
   */
  public captureThreePointAnnulusPlane(
    lcc: TAVIVector3D,
    ncc: TAVIVector3D,
    rcc: TAVIVector3D
  ): boolean {
    this.cuspLCC = { ...lcc };
    this.cuspNCC = { ...ncc };
    this.cuspRCC = { ...rcc };

    const planeResult = TAVIGeometry.planeFromThreePoints(lcc, ncc, rcc);
    if (!planeResult) return false;

    let { normal } = planeResult;
    const { centroid } = planeResult;

    // Orient normal to point in the same direction as the aortic axis (LVOT → ascending aorta)
    if (this.aorticAxisDirection) {
      if (TAVIGeometry.vectorDot(normal, this.aorticAxisDirection) < 0) {
        normal = TAVIGeometry.vectorScale(normal, -1);
      }
    }

    this.annulusPlaneNormal = normal;
    this.annulusPlaneCentroid = centroid;
    this.recompute();
    return true;
  }

  /**
   * Capture a constrained annulus contour (ProSizeAV-style: clicked points on the annulus plane).
   * Optionally smooths the contour via spline interpolation before storing.
   */
  /** Raw (unsmoothed) contour points for editing */
  public annulusRawContourPoints: TAVIVector3D[] = [];

  public captureConstrainedAnnulusContour(
    worldPoints: TAVIVector3D[],
    planeNormal: TAVIVector3D,
    smooth = true
  ): void {
    // Store raw points for later editing
    this.annulusRawContourPoints = worldPoints.map(p => ({ ...p }));

    const finalPoints = smooth
      ? TAVIGeometry.interpolateContourCatmullRom(worldPoints, 8)
      : worldPoints;

    const snapshot: TAVIContourSnapshot = {
      worldPoints: finalPoints,
      pixelPoints: [],
      planeOrigin: worldPoints.length > 0 ? worldPoints[0] : { x: 0, y: 0, z: 0 },
      planeNormal: { ...planeNormal },
    };

    this.captureContourSnapshot(snapshot, TAVIStructureAnnulus);
    this.useAssistedAnnulusForPlanning = true;
  }

  public activeAnnulusGeometry(): TAVIGeometryResult | null | undefined {
    return this.useAssistedAnnulusForPlanning && this.assistedAnnulusGeometry
      ? this.assistedAnnulusGeometry
      : this.annulusGeometry;
  }

  public preferredProjectionAngle(): TAVIFluoroAngleResult | null | undefined {
    return this.projectionConfirmation?.confirmationAngle || this.fluoroAngle;
  }

  public recompute() {
    // Compute aortic axis from the 2 placed points (LVOT → ascending aorta)
    this.aorticAxisDirection = null;
    this.aorticAxisLengthMm = null;
    if (this.aorticAxisPointSnapshots.length >= 2) {
      const p0 = this.aorticAxisPointSnapshots[0].worldPoint; // LVOT
      const p1 = this.aorticAxisPointSnapshots[1].worldPoint; // ascending aorta
      const diff = TAVIGeometry.vectorSubtract(p1, p0);
      this.aorticAxisLengthMm = TAVIGeometry.vectorLength(diff);
      if (this.aorticAxisLengthMm > 0.001) {
        this.aorticAxisDirection = TAVIGeometry.vectorNormalize(diff);
      }
    }

    this.annulusGeometry = this.annulusSnapshot
      ? TAVIGeometry.geometryForWorldContour(this.annulusSnapshot.worldPoints, this.annulusSnapshot.planeNormal)
      : null;
    this.assistedAnnulusGeometry = this.annulusSnapshot
      ? TAVIGeometry.assistedAnnulusGeometryForWorldContour(
          this.annulusSnapshot.worldPoints,
          this.annulusSnapshot.planeNormal
        )
      : null;
    this.lvotGeometry = this.lvotSnapshot
      ? TAVIGeometry.geometryForWorldContour(this.lvotSnapshot.worldPoints, this.lvotSnapshot.planeNormal)
      : null;
    this.sinusGeometry = this.sinusSnapshot
      ? TAVIGeometry.geometryForWorldContour(this.sinusSnapshot.worldPoints, this.sinusSnapshot.planeNormal)
      : null;
    this.stjGeometry = this.stjSnapshot
      ? TAVIGeometry.geometryForWorldContour(this.stjSnapshot.worldPoints, this.stjSnapshot.planeNormal)
      : null;
    this.ascendingAortaGeometry = this.ascendingAortaSnapshot
      ? TAVIGeometry.geometryForWorldContour(
          this.ascendingAortaSnapshot.worldPoints,
          this.ascendingAortaSnapshot.planeNormal
        )
      : null;

    if (this.annulusSnapshot?.pixelValues && this.annulusSnapshot.pixelAreaMm2) {
      this.annulusCalcium = TAVIGeometry.calciumResultForPixelValues(
        this.annulusSnapshot.pixelValues,
        this.annulusSnapshot.pixelAreaMm2,
        this.calciumThresholdHU
      );
    } else {
      this.annulusCalcium = null;
    }

    const planningAnnulus = this.activeAnnulusGeometry();
    this.fluoroAngle = planningAnnulus ? TAVIGeometry.fluoroAngleForPlaneNormal(planningAnnulus.planeNormal) : null;

    this.horizontalAortaAngleDegrees = 0;
    if (planningAnnulus) {
      // Use aortic axis direction for angulation if available (more accurate than plane normal)
      const angleVector = this.aorticAxisDirection || planningAnnulus.planeNormal;
      const rawAngle = TAVIGeometry.angleBetweenVectors(angleVector, { x: 0, y: 0, z: 1 });
      this.horizontalAortaAngleDegrees = rawAngle > 90 ? 180 - rawAngle : rawAngle;
      if (!this.hasManualVirtualValveDiameter) {
        this.virtualValveDiameterMm = TAVIRoundToHalfMillimeter(planningAnnulus.equivalentDiameterMm);
      }
    }

    this.leftCoronaryHeightMm = null;
    this.rightCoronaryHeightMm = null;
    this.membranousSeptumLengthMm = null;

    if (planningAnnulus && this.leftOstiumSnapshot) {
      this.leftCoronaryHeightMm = Math.abs(
        TAVIGeometry.distanceFromPointToPlane(
          this.leftOstiumSnapshot.worldPoint,
          planningAnnulus.centroid,
          planningAnnulus.planeNormal
        )
      );
    }

    if (planningAnnulus && this.rightOstiumSnapshot) {
      this.rightCoronaryHeightMm = Math.abs(
        TAVIGeometry.distanceFromPointToPlane(
          this.rightOstiumSnapshot.worldPoint,
          planningAnnulus.centroid,
          planningAnnulus.planeNormal
        )
      );
    }

    if (this.membranousSeptumPointSnapshots.length >= 2) {
      const first = this.membranousSeptumPointSnapshots[0].worldPoint;
      const second = this.membranousSeptumPointSnapshots[1].worldPoint;
      this.membranousSeptumLengthMm = TAVIGeometry.vectorLength(TAVIGeometry.vectorSubtract(second, first));
    }

    this.projectionConfirmation = null;
    if (planningAnnulus && this.sinusPointSnapshots.length >= 3) {
      const worldPoints = this.sinusPointSnapshots.map((s) => s.worldPoint);
      const confirmationNormal = TAVIGeometry.planeNormalForWorldPoints(worldPoints);
      this.projectionConfirmation = TAVIGeometry.projectionConfirmationForReferenceNormal(
        planningAnnulus.planeNormal,
        confirmationNormal
      );
    }
  }

  // ── Report Computed Properties (Phase 5) ──

  /** Perpendicularity curve for the graph */
  public get perpendicularityCurve(): { laoRaoDeg: number; cranialCaudalDeg: number }[] {
    const planningAnnulus = this.activeAnnulusGeometry();
    if (!planningAnnulus) return [];
    return TAVIGeometry.computePerpendicularityCurve(planningAnnulus.planeNormal);
  }

  /** RAO projection feasibility table */
  public get raoProjectionTable(): { raoDeg: number; cranialCaudalDeg: number; label: string }[] {
    const planningAnnulus = this.activeAnnulusGeometry();
    if (!planningAnnulus) return [];
    return TAVIGeometry.computeRAOLAOTable(planningAnnulus.planeNormal);
  }

  /** LAO projection feasibility table */
  public get laoProjectionTable(): { laoDeg: number; cranialCaudalDeg: number; label: string }[] {
    const planningAnnulus = this.activeAnnulusGeometry();
    if (!planningAnnulus) return [];
    return TAVIGeometry.computeLAOTable(planningAnnulus.planeNormal);
  }

  /** Cusp-specific implantation plane angles */
  public get implantationPlaneAngles(): {
    rccAnterior: TAVIFluoroAngleResult;
    lccPosterior: TAVIFluoroAngleResult;
    nccPosterior: TAVIFluoroAngleResult;
    lvView: TAVIFluoroAngleResult;
  } | null {
    const planningAnnulus = this.activeAnnulusGeometry();
    if (!planningAnnulus || !this.cuspLCC || !this.cuspNCC || !this.cuspRCC) return null;
    return TAVIGeometry.computeCuspImplantationAngles(
      planningAnnulus.planeNormal,
      planningAnnulus.centroid,
      this.cuspLCC,
      this.cuspNCC,
      this.cuspRCC
    );
  }

  public hasRequiredCaptures(): boolean {
    return !!this.annulusSnapshot && !!this.leftOstiumSnapshot && !!this.rightOstiumSnapshot;
  }

  public nextRecommendedStepSummary(): string {
    if (this.aorticAxisPointSnapshots.length < 2) return 'Step 0: place crosshairs in the LVOT center and ascending aorta to estimate the aortic axis.';
    if (!this.ascendingAortaSnapshot) return 'Step 1: capture ascending aorta on a perpendicular MPR plane.';
    if (!this.stjSnapshot) return 'Step 2: capture the sino-tubular junction on the next perpendicular plane.';
    if (!this.sinusSnapshot) return 'Step 3: capture the sinus of Valsalva contour before annulus planning.';
    if (!this.annulusSnapshot) return 'Step 4: capture the annulus contour. This unlocks assisted annulus fitting and advisory angle guidance.';
    if (!this.lvotSnapshot) return 'Optional Step 4a: capture the LVOT contour for additional root sizing.';
    if (this.sinusPointSnapshots.length < 3) return 'Optional Step 4b: capture three sinus points to confirm the projection-angle preview, or continue to coronary ostia.';
    if (this.membranousSeptumPointSnapshots.length < 2) return 'Optional Step 4c: capture two membranous septum points if you want the brochure-style septum length measurement.';
    if (!this.leftOstiumSnapshot) return 'Step 5: capture the left coronary ostium point.';
    if (!this.rightOstiumSnapshot) return 'Step 6: capture the right coronary ostium point.';
    return 'Core workflow complete. Review the assisted annulus, preview angle, calcium assist, and export the report.';
  }

  /** Generate a structured text report (ProSizeAV export format) */
  public textReport(): string {
    const lines: string[] = [];
    const r = (v: number | null | undefined, decimals = 1) =>
      v != null ? v.toFixed(decimals) : '—';
    const annulus = this.activeAnnulusGeometry();

    lines.push('═══════════════════════════════════════════');
    lines.push('          TAVI PLANNING REPORT');
    lines.push('═══════════════════════════════════════════');
    lines.push('');

    // Patient demographics
    lines.push('PATIENT INFORMATION');
    lines.push('───────────────────────────────────────────');
    if (this.patientName) lines.push(`Name:       ${this.patientName}`);
    if (this.patientID) lines.push(`ID:         ${this.patientID}`);
    if (this.patientBirthDate) lines.push(`DOB:        ${this.patientBirthDate}`);
    lines.push('');

    // Annulus measurements
    lines.push('ANNULUS MEASUREMENTS');
    lines.push('───────────────────────────────────────────');
    if (annulus) {
      const eqDPerimeter = annulus.perimeterMm / Math.PI;
      const eqDArea = 2 * Math.sqrt(annulus.areaMm2 / Math.PI);
      const eccentricity = annulus.maximumDiameterMm > 0
        ? (1 - annulus.minimumDiameterMm / annulus.maximumDiameterMm)
        : 0;
      lines.push(`Perimeter:        ${r(annulus.perimeterMm)} mm  (equiv. ∅ ${r(eqDPerimeter)} mm)`);
      lines.push(`Area:             ${r(annulus.areaMm2)} mm²  (equiv. ∅ ${r(eqDArea)} mm)`);
      lines.push(`Min diameter:     ${r(annulus.minimumDiameterMm)} mm`);
      lines.push(`Max diameter:     ${r(annulus.maximumDiameterMm)} mm`);
      lines.push(`Eccentricity:     ${r(eccentricity, 2)}`);
    } else {
      lines.push('(not measured)');
    }
    lines.push('');

    // Coronary heights
    lines.push('CORONARY ARTERIES');
    lines.push('───────────────────────────────────────────');
    lines.push(`LCA height:       ${r(this.leftCoronaryHeightMm)} mm${(this.leftCoronaryHeightMm != null && this.leftCoronaryHeightMm < 10) ? '  ⚠ LOW' : ''}`);
    lines.push(`RCA height:       ${r(this.rightCoronaryHeightMm)} mm${(this.rightCoronaryHeightMm != null && this.rightCoronaryHeightMm < 10) ? '  ⚠ LOW' : ''}`);
    lines.push('');

    // Aortic root dimensions
    lines.push('AORTIC ROOT DIMENSIONS');
    lines.push('───────────────────────────────────────────');
    const structures: [string, TAVIGeometryResult | null | undefined][] = [
      ['LVOT', this.lvotGeometry],
      ['Sinus', this.sinusGeometry],
      ['STJ', this.stjGeometry],
      ['Ascending Aorta', this.ascendingAortaGeometry],
    ];
    for (const [name, geom] of structures) {
      if (geom) {
        lines.push(`${name}: ${r(geom.minimumDiameterMm)}×${r(geom.maximumDiameterMm)} mm, area ${r(geom.areaMm2)} mm²`);
      }
    }
    lines.push('');

    // Implantation angles
    const angles = this.implantationPlaneAngles;
    if (angles) {
      lines.push('IMPLANTATION PLANE ANGLES');
      lines.push('───────────────────────────────────────────');
      const fmtAngle = (a: TAVIFluoroAngleResult) =>
        `${a.laoRaoLabel} ${Math.abs(a.laoRaoDegrees).toFixed(0)}° / ${a.cranialCaudalLabel} ${Math.abs(a.cranialCaudalDegrees).toFixed(0)}°`;
      lines.push(`RCC Anterior:     ${fmtAngle(angles.rccAnterior)}`);
      lines.push(`LCC Posterior:    ${fmtAngle(angles.lccPosterior)}`);
      lines.push(`NCC Posterior:    ${fmtAngle(angles.nccPosterior)}`);
      lines.push(`LV View:          ${fmtAngle(angles.lvView)}`);
      lines.push('');
    }

    // Calcium
    if (this.annulusCalcium) {
      lines.push('CALCIUM ASSESSMENT');
      lines.push('───────────────────────────────────────────');
      lines.push(`Threshold:        ${this.calciumThresholdHU} HU`);
      lines.push(`Agatston (2D):    ${r(this.annulusCalcium.agatstonScore2D, 0)}`);
      lines.push(`Dense fraction:   ${r(this.annulusCalcium.fractionAboveThreshold * 100, 1)}%`);
      lines.push('');
    }

    // Access route
    lines.push('ACCESS PLANNING');
    lines.push('───────────────────────────────────────────');
    lines.push(`Planned Access:         ${this.plannedAccess}`);
    lines.push(`Planned Pigtail Access: ${this.plannedPigtailAccess}`);
    lines.push('');

    // Notes
    if (this.notes) {
      lines.push('NOTES');
      lines.push('───────────────────────────────────────────');
      lines.push(this.notes);
      lines.push('');
    }

    return lines.join('\n');
  }

  /** Generate a CSV export of key measurements */
  public csvReport(): string {
    const annulus = this.activeAnnulusGeometry();
    const rows: string[][] = [];

    rows.push(['Parameter', 'Value', 'Unit']);

    if (annulus) {
      rows.push(['Annulus Perimeter', annulus.perimeterMm.toFixed(1), 'mm']);
      rows.push(['Annulus Area', annulus.areaMm2.toFixed(1), 'mm2']);
      rows.push(['Annulus Equiv Diameter (Perimeter)', (annulus.perimeterMm / Math.PI).toFixed(1), 'mm']);
      rows.push(['Annulus Equiv Diameter (Area)', (2 * Math.sqrt(annulus.areaMm2 / Math.PI)).toFixed(1), 'mm']);
      rows.push(['Annulus Min Diameter', annulus.minimumDiameterMm.toFixed(1), 'mm']);
      rows.push(['Annulus Max Diameter', annulus.maximumDiameterMm.toFixed(1), 'mm']);
      const eccentricity = annulus.maximumDiameterMm > 0
        ? (1 - annulus.minimumDiameterMm / annulus.maximumDiameterMm)
        : 0;
      rows.push(['Annulus Eccentricity', eccentricity.toFixed(3), '']);
    }

    if (this.leftCoronaryHeightMm != null) {
      rows.push(['LCA Height', this.leftCoronaryHeightMm.toFixed(1), 'mm']);
    }
    if (this.rightCoronaryHeightMm != null) {
      rows.push(['RCA Height', this.rightCoronaryHeightMm.toFixed(1), 'mm']);
    }

    const structures: [string, TAVIGeometryResult | null | undefined][] = [
      ['LVOT', this.lvotGeometry],
      ['Sinus', this.sinusGeometry],
      ['STJ', this.stjGeometry],
      ['Ascending Aorta', this.ascendingAortaGeometry],
    ];
    for (const [name, geom] of structures) {
      if (geom) {
        rows.push([`${name} Min Diameter`, geom.minimumDiameterMm.toFixed(1), 'mm']);
        rows.push([`${name} Max Diameter`, geom.maximumDiameterMm.toFixed(1), 'mm']);
        rows.push([`${name} Area`, geom.areaMm2.toFixed(1), 'mm2']);
        rows.push([`${name} Perimeter`, geom.perimeterMm.toFixed(1), 'mm']);
      }
    }

    // Multi-level geometries
    for (const [dist, geom] of this.multiLevelGeometries) {
      const prefix = dist < 0 ? `LVOT ${Math.abs(dist)}mm` : `AV +${dist}mm`;
      rows.push([`${prefix} Min Diameter`, geom.minimumDiameterMm.toFixed(1), 'mm']);
      rows.push([`${prefix} Max Diameter`, geom.maximumDiameterMm.toFixed(1), 'mm']);
      rows.push([`${prefix} Area`, geom.areaMm2.toFixed(1), 'mm2']);
    }

    const angles = this.implantationPlaneAngles;
    if (angles) {
      const fmtAngle = (a: TAVIFluoroAngleResult) =>
        `${a.laoRaoLabel} ${Math.abs(a.laoRaoDegrees).toFixed(0)} / ${a.cranialCaudalLabel} ${Math.abs(a.cranialCaudalDegrees).toFixed(0)}`;
      rows.push(['RCC Anterior Angle', fmtAngle(angles.rccAnterior), 'deg']);
      rows.push(['LCC Posterior Angle', fmtAngle(angles.lccPosterior), 'deg']);
      rows.push(['NCC Posterior Angle', fmtAngle(angles.nccPosterior), 'deg']);
      rows.push(['LV View Angle', fmtAngle(angles.lvView), 'deg']);
    }

    rows.push(['Planned Access', this.plannedAccess, '']);
    rows.push(['Planned Pigtail Access', this.plannedPigtailAccess, '']);

    return rows.map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
  }

  public workflowChecklistSummary(): string {
    const arr = [
      `[${this.aorticAxisPointSnapshots.length >= 2 ? 'x' : ' '}] 0 Aortic axis estimation`,
      `[${this.ascendingAortaSnapshot ? 'x' : ' '}] 1 Ascending aorta`,
      `[${this.stjSnapshot ? 'x' : ' '}] 2 STJ`,
      `[${this.sinusSnapshot ? 'x' : ' '}] 3 Sinus contour`,
      `[${this.annulusSnapshot ? 'x' : ' '}] 4 Annulus contour`,
      `[${this.lvotSnapshot ? 'x' : ' '}] 4a LVOT contour`,
      `[${this.sinusPointSnapshots.length >= 3 ? 'x' : ' '}] 4b Sinus-point confirmation`,
      `[${this.membranousSeptumPointSnapshots.length >= 2 ? 'x' : ' '}] 4c Membranous septum`,
      `[${this.leftOstiumSnapshot ? 'x' : ' '}] 5 Left ostium`,
      `[${this.rightOstiumSnapshot ? 'x' : ' '}] 6 Right ostium`,
      `Planning source: ${this.useAssistedAnnulusForPlanning && this.assistedAnnulusGeometry ? 'Assisted annulus fit' : 'Captured annulus contour'}`,
    ];
    return arr.join('\n');
  }
}
