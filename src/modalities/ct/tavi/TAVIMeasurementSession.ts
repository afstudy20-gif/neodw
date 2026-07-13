import {
  TAVIContourSnapshot,
  TAVIPointSnapshot,
  TAVIVector3D,
  TAVIGeometryResult,
  TAVICalciumResult,
  TAVIFluoroAngleResult,
  TAVICuspOverlapViews,
  TAVIProjectionConfirmationResult,
  TAVISinusDiameterResult,
  SinusLabel,
  AccessVesselId,
  AccessVesselResult,
  AccessRoute,
  PigtailAccessRoute,
  TAVISelectedValve,
  TAVIDeploymentRatio,
  TAVIVivState,
} from './TAVITypes';
import { TAVIGeometry } from './TAVIGeometry';
import { resolveSelectedValve, VALVE_FAMILIES } from './TAVIValveDatabase';
import { computeDeploymentResult, type DeploymentResult } from './ValveDeployment';
import { frameProfileFor, positionFrame } from './ValveFrameGeometry';
import { recommendVivValveSizes, resolveSurgicalBioprosthesis, assessBvf, type VivValveRecommendation } from './VivProsthesisDatabase';

export const TAVIStructureAorticAxis = 'aortic-axis';
export const TAVIStructureAnnulus = 'annulus';
export const TAVIStructureLeftOstium = 'left-ostium';
export const TAVIStructureRightOstium = 'right-ostium';
export const TAVIStructureSinus = 'sinus';
export const TAVIStructureSTJ = 'stj';
export const TAVIStructureAscendingAorta = 'ascending-aorta';
export const TAVIStructureSinusPoints = 'sinus-points';
export const TAVIStructureSinusDiameters = 'sinus-diameters';
export const TAVIStructureLVOT = 'lvot';
export const TAVIStructureMembranousSeptum = 'membranous-septum';
export const TAVIStructureThoracicAorta = 'thoracic-aorta';
export const TAVIStructureAbdominalAorta = 'abdominal-aorta';
export const TAVIStructureIliacLeft = 'iliac-left';
export const TAVIStructureIliacRight = 'iliac-right';

function TAVIRoundToHalfMillimeter(value: number): number {
  return Math.round(value * 2.0) / 2.0;
}

export class TAVIMeasurementSession {
  public calciumThresholdHU = 850.0;
  public cuspCalcificationGrade = 0;
  /** Per-cusp manual calcium grades (0..3). Aggregate `cuspCalcificationGrade`
   *  is auto-synced to the max of these in recompute() for risk scoring. */
  public cuspCalcificationGradeLCC = 0;
  public cuspCalcificationGradeRCC = 0;
  public cuspCalcificationGradeNCC = 0;
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

  /** Three-point cusp definition (structured) */
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
  /** Per-sinus width point pairs (LCS/RCS/NCS), each two world points. */
  public sinusDiameterPoints: Partial<Record<SinusLabel, { a: TAVIVector3D; b: TAVIVector3D }>> = {};
  /** Optional per-sinus floor (nadir) points for sinus-height computation. */
  public sinusFloorPoints: Partial<Record<SinusLabel, TAVIVector3D>> = {};
  /** Computed per-sinus diameter + height results (derived in recompute). */
  public sinusDiameters: Partial<Record<SinusLabel, TAVISinusDiameterResult>> = {};

  /** Ilio-femoral access vessel measurements keyed by vessel id. */
  public accessVessels: Map<AccessVesselId, AccessVesselResult> = new Map();
  /** Sheath OD (mm) selected for the access sheath-fit check. */
  public selectedSheathOuterDiameterMm?: number | null;
  public stjGeometry?: TAVIGeometryResult | null;
  public ascendingAortaGeometry?: TAVIGeometryResult | null;

  public annulusCalcium?: TAVICalciumResult | null;
  public lvotCalcium?: TAVICalciumResult | null;
  public sinusCalcium?: TAVICalciumResult | null;
  public stjCalcium?: TAVICalciumResult | null;
  public ascendingAortaCalcium?: TAVICalciumResult | null;
  /** Computed per-cusp 2D Agatston (populated via captureCuspCalciumSample). */
  public cuspCalciumLCC?: TAVICalciumResult | null;
  public cuspCalciumRCC?: TAVICalciumResult | null;
  public cuspCalciumNCC?: TAVICalciumResult | null;
  /** Sampled HU pixels per cusp disc — kept so recompute() can re-run on
   *  calciumThresholdHU change. Cusps have no contour snapshot to stamp. */
  public cuspPixelSampleLCC?: { pixelValues: Float32Array; pixelAreaMm2: number } | null;
  public cuspPixelSampleRCC?: { pixelValues: Float32Array; pixelAreaMm2: number } | null;
  public cuspPixelSampleNCC?: { pixelValues: Float32Array; pixelAreaMm2: number } | null;

  /** Multi-level cross-section thumbnails (multi-level) */
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

  // ── Virtual valve deployment (selection state) ──
  //
  // The user-chosen prosthesis drives the 3D deployment visualization and the
  // device-type-aware risk scoring (e.g. self-expanding vs balloon-expandable
  // pacemaker risk). When null, only sizing *recommendations* are shown and
  // risk models fall back to conservative defaults.
  public selectedValve: TAVISelectedValve | null = null;
  /** Implant depth below the annular plane toward the LVOT, mm (default 5mm). */
  public implantDepthMm = 5;
  /** Sub/supra-annular split of the frame. Default 80% supra / 20% sub. */
  public deploymentRatio: TAVIDeploymentRatio = '80/20';

  // ── Valve-in-Valve (redo-TAVI) planning state ──
  //
  // Independent of the native-valve selection above. Populated only when the
  // operator uses the ViV subtab. Drives the nested-frame 3D view (surgical
  // bioprosthesis outer frame + TAVI inner frame) and the ViV sizing report.
  public viv: TAVIVivState = {
    surgicalName: null,
    surgicalLabelMm: null,
    innerDiameterMm: null,
    measured: false,
    selectedTavi: null,
  };

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
    this.sinusDiameterPoints = {};
    this.sinusFloorPoints = {};
    this.sinusDiameters = {};
    this.accessVessels = new Map();
    this.selectedSheathOuterDiameterMm = null;
    this.stjGeometry = null;
    this.ascendingAortaGeometry = null;
    this.annulusCalcium = null;
    this.lvotCalcium = null;
    this.sinusCalcium = null;
    this.stjCalcium = null;
    this.ascendingAortaCalcium = null;
    this.cuspCalciumLCC = null;
    this.cuspCalciumRCC = null;
    this.cuspCalciumNCC = null;
    this.cuspPixelSampleLCC = null;
    this.cuspPixelSampleRCC = null;
    this.cuspPixelSampleNCC = null;
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
    this.cuspCalcificationGradeLCC = 0;
    this.cuspCalcificationGradeRCC = 0;
    this.cuspCalcificationGradeNCC = 0;
    this.annulusCalcificationGrade = 0;
    this.notes = '';
    this.selectedValve = null;
    this.implantDepthMm = 5;
    this.deploymentRatio = '80/20';
    this.viv = {
      surgicalName: null,
      surgicalLabelMm: null,
      innerDiameterMm: null,
      measured: false,
      selectedTavi: null,
    };
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

  /** Attach sampled LVOT HU pixels to the LVOT snapshot so recompute() scores it. */
  public captureLvotCalciumSample(pixelValues: Float32Array, pixelAreaMm2: number): void {
    const base = this.lvotSnapshot ?? {
      worldPoints: [],
      planeOrigin: { x: 0, y: 0, z: 0 },
      planeNormal: { x: 0, y: 0, z: 1 },
    };
    this.lvotSnapshot = { ...base, pixelValues, pixelAreaMm2 };
    this.recompute();
  }

  /** Store sampled per-cusp HU pixels; recompute() converts to 2D Agatston. */
  public captureCuspCalciumSample(
    id: 'lcc' | 'rcc' | 'ncc',
    pixelValues: Float32Array,
    pixelAreaMm2: number
  ): void {
    const sample = { pixelValues, pixelAreaMm2 };
    if (id === 'lcc') this.cuspPixelSampleLCC = sample;
    else if (id === 'rcc') this.cuspPixelSampleRCC = sample;
    else this.cuspPixelSampleNCC = sample;
    this.recompute();
  }

  /** Capture/replace a single sinus diameter (two world points). */
  public captureSinusDiameter(label: SinusLabel, a: TAVIVector3D, b: TAVIVector3D): void {
    this.sinusDiameterPoints = { ...this.sinusDiameterPoints, [label]: { a: { ...a }, b: { ...b } } };
    this.recompute();
  }

  /** Capture/replace the floor (nadir) point of a sinus for height measurement. */
  public captureSinusFloor(label: SinusLabel, floor: TAVIVector3D): void {
    this.sinusFloorPoints = { ...this.sinusFloorPoints, [label]: { ...floor } };
    this.recompute();
  }

  /** Clear one sinus's diameter + floor measurements. */
  public clearSinusDiameter(label: SinusLabel): void {
    const dp = { ...this.sinusDiameterPoints }; delete dp[label]; this.sinusDiameterPoints = dp;
    const fp = { ...this.sinusFloorPoints }; delete fp[label]; this.sinusFloorPoints = fp;
    this.recompute();
  }

  /**
   * Store a computed access-vessel result. The heavy per-section auto-seg loop
   * runs in the panel (where the Cornerstone volume is available); the session
   * only stores the finished result, staying volume-agnostic.
   */
  public captureAccessVessel(result: AccessVesselResult): void {
    this.accessVessels = new Map(this.accessVessels);
    this.accessVessels.set(result.vesselId, { ...result });
  }

  /** Remove one access-vessel measurement. */
  public clearAccessVessel(vesselId: AccessVesselId): void {
    const next = new Map(this.accessVessels);
    next.delete(vesselId);
    this.accessVessels = next;
  }

  /** Minimum lumen diameter across all measured access vessels (access-limiting). */
  public iliofemoralMinLumenMm(): number | null {
    const mins = Array.from(this.accessVessels.values())
      .map((v) => v.minLumenDiameterMm)
      .filter((v): v is number => v != null && Number.isFinite(v));
    return mins.length ? Math.min(...mins) : null;
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
   * Capture the annulus plane from 3 cusp nadir points (structured).
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
   * Capture a constrained annulus contour (structured: clicked points on the annulus plane).
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

    // Per-sinus (LCS/RCS/NCS) diameters + optional heights (floor → STJ plane).
    this.sinusDiameters = {};
    const stjForSinus = this.stjGeometry;
    for (const label of ['LCS', 'RCS', 'NCS'] as SinusLabel[]) {
      const pts = this.sinusDiameterPoints[label];
      if (!pts) continue;
      const diameterMm = TAVIGeometry.vectorDistance(pts.a, pts.b);
      const floorPoint = this.sinusFloorPoints[label];
      const heightMm = floorPoint && stjForSinus
        ? TAVIGeometry.sinusHeightToPlane(floorPoint, stjForSinus.centroid, stjForSinus.planeNormal)
        : undefined;
      this.sinusDiameters[label] = { label, pointA: pts.a, pointB: pts.b, diameterMm, floorPoint, heightMm };
    }

    const calc = (sample?: { pixelValues?: Float32Array; pixelAreaMm2?: number } | null) =>
      sample?.pixelValues && sample.pixelAreaMm2
        ? TAVIGeometry.calciumResultForPixelValues(sample.pixelValues, sample.pixelAreaMm2, this.calciumThresholdHU)
        : null;

    this.annulusCalcium = calc(this.annulusSnapshot);
    this.lvotCalcium = calc(this.lvotSnapshot);
    this.cuspCalciumLCC = calc(this.cuspPixelSampleLCC);
    this.cuspCalciumRCC = calc(this.cuspPixelSampleRCC);
    this.cuspCalciumNCC = calc(this.cuspPixelSampleNCC);

    // Keep the aggregate cusp grade in sync for risk scoring
    // (TAVIValveDatabase.assessTAVRRisks consumes cuspCalcificationGrade).
    this.cuspCalcificationGrade = Math.max(
      this.cuspCalcificationGradeLCC,
      this.cuspCalcificationGradeRCC,
      this.cuspCalcificationGradeNCC,
      this.cuspCalcificationGrade
    );

    const planningAnnulus = this.activeAnnulusGeometry();
    this.fluoroAngle = planningAnnulus ? TAVIGeometry.fluoroAngleForPlaneNormal(planningAnnulus.planeNormal) : null;

    this.horizontalAortaAngleDegrees = 0;
    if (planningAnnulus) {
      // Use aortic axis direction for angulation if available (more accurate than plane normal)
      const angleVector = this.aorticAxisDirection || planningAnnulus.planeNormal;
      const rawAngle = TAVIGeometry.angleBetweenVectors(angleVector, { x: 0, y: 0, z: 1 });
      this.horizontalAortaAngleDegrees = rawAngle > 90 ? 180 - rawAngle : rawAngle;
      if (!this.hasManualVirtualValveDiameter) {
        // When a prosthesis is selected, mirror its nominal diameter so the
        // legacy scalar stays consistent with the deployment visualization.
        this.virtualValveDiameterMm = this.selectedValve?.sizeMm
          ? TAVIRoundToHalfMillimeter(this.selectedValve.sizeMm)
          : TAVIRoundToHalfMillimeter(planningAnnulus.equivalentDiameterMm);
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

  /** Cusp-overlap fluoroscopy views (all on the line of perpendicularity). */
  public get cuspOverlapViews(): TAVICuspOverlapViews | null {
    const planningAnnulus = this.activeAnnulusGeometry();
    if (!planningAnnulus || !this.cuspLCC || !this.cuspNCC || !this.cuspRCC) return null;
    return TAVIGeometry.computeCuspOverlapViews(
      planningAnnulus.planeNormal,
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

  /** Generate a structured text report (structured export format) */
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
    for (const label of ['LCS', 'RCS', 'NCS'] as SinusLabel[]) {
      const d = this.sinusDiameters[label];
      if (d) lines.push(`Sinus ${label}: ${r(d.diameterMm)} mm${d.heightMm != null ? `, height ${r(d.heightMm)} mm` : ''}`);
    }
    lines.push('');

    // Cusp-overlap fluoroscopy views (on the line of perpendicularity)
    const overlaps = this.cuspOverlapViews;
    if (overlaps) {
      lines.push('CUSP-OVERLAP VIEWS');
      lines.push('───────────────────────────────────────────');
      const fmtAngle = (a: TAVIFluoroAngleResult) =>
        `${a.laoRaoLabel} ${Math.abs(a.laoRaoDegrees).toFixed(0)}° / ${a.cranialCaudalLabel} ${Math.abs(a.cranialCaudalDegrees).toFixed(0)}°`;
      lines.push(`R/L overlap (NCC):  ${fmtAngle(overlaps.rlOverlap.angle)}`);
      lines.push(`R/N overlap (LCC):  ${fmtAngle(overlaps.rnOverlap.angle)}`);
      lines.push(`L/N overlap (RCC):  ${fmtAngle(overlaps.lnOverlap.angle)}`);
      lines.push('');
    }

    // Calcium
    const hasAnyCalcium =
      this.annulusCalcium || this.lvotCalcium ||
      this.cuspCalciumLCC || this.cuspCalciumRCC || this.cuspCalciumNCC ||
      this.cuspCalcificationGradeLCC > 0 || this.cuspCalcificationGradeRCC > 0 ||
      this.cuspCalcificationGradeNCC > 0 || this.annulusCalcificationGrade > 0;
    if (hasAnyCalcium) {
      lines.push('CALCIUM ASSESSMENT');
      lines.push('───────────────────────────────────────────');
      lines.push(`Threshold:        ${this.calciumThresholdHU} HU`);
      if (this.annulusCalcium) {
        lines.push(`Annulus Agatston (2D): ${r(this.annulusCalcium.agatstonScore2D, 0)}`);
        lines.push(`Annulus dense frac:    ${r(this.annulusCalcium.fractionAboveThreshold * 100, 1)}%`);
      }
      if (this.cuspCalciumLCC || this.cuspCalciumRCC || this.cuspCalciumNCC) {
        lines.push('Per-cusp Agatston (2D):');
        lines.push(`  LCC: ${r(this.cuspCalciumLCC?.agatstonScore2D ?? null, 0)}  grade ${this.cuspCalcificationGradeLCC}`);
        lines.push(`  RCC: ${r(this.cuspCalciumRCC?.agatstonScore2D ?? null, 0)}  grade ${this.cuspCalcificationGradeRCC}`);
        lines.push(`  NCC: ${r(this.cuspCalciumNCC?.agatstonScore2D ?? null, 0)}  grade ${this.cuspCalcificationGradeNCC}`);
      } else {
        lines.push(`Cusp grades — LCC: ${this.cuspCalcificationGradeLCC} | RCC: ${this.cuspCalcificationGradeRCC} | NCC: ${this.cuspCalcificationGradeNCC}`);
      }
      if (this.lvotCalcium) {
        lines.push(`LVOT Agatston (2D):    ${r(this.lvotCalcium.agatstonScore2D, 0)}`);
        lines.push(`LVOT dense frac:       ${r(this.lvotCalcium.fractionAboveThreshold * 100, 1)}%`);
      }
      lines.push('');
    }

    // Access route
    lines.push('ACCESS PLANNING');
    lines.push('───────────────────────────────────────────');
    lines.push(`Planned Access:         ${this.plannedAccess}`);
    lines.push(`Planned Pigtail Access: ${this.plannedPigtailAccess}`);
    lines.push('');

    // Selected prosthesis / virtual deployment
    if (this.selectedValve) {
      lines.push('SELECTED PROSTHESIS');
      lines.push('───────────────────────────────────────────');
      lines.push(`Valve:            ${this.selectedValve.familyName} ${r(this.selectedValve.sizeMm, this.selectedValve.sizeMm % 1 === 0 ? 0 : 1)} mm`);
      lines.push(`Implant depth:    ${r(this.implantDepthMm)} mm sub-annular`);
      lines.push(`Deployment ratio: ${this.deploymentRatio} (supra/sub)`);
      const dep = this.deploymentResult();
      if (dep) {
        lines.push('');
        lines.push('VIRTUAL DEPLOYMENT (advisory)');
        lines.push(`  Cover index:        ${r(dep.coverIndexPct)}%  (oversizing ${r(dep.oversizingPct, 0)}% by ${dep.oversizingMetric})`);
        for (const c of dep.coronary) {
          const tag = c.side === 'left' ? 'LCO' : 'RCO';
          lines.push(`  ${tag} clearance:      ${r(c.clearanceMm)} mm  [${c.risk.toUpperCase()} obstruction risk]`);
        }
        lines.push(`  PVL indicator:      ${dep.pvl.score}/100  [${dep.pvl.band.toUpperCase()}]`);
        if (dep.pvl.factors.length > 0) {
          for (const f of dep.pvl.factors) lines.push(`    · ${f}`);
        }
      }
      lines.push('');
    }

    // Valve-in-Valve / redo-TAVI planning
    const vivRecs = this.vivRecommendations();
    if (this.viv.surgicalName || this.viv.innerDiameterMm != null) {
      lines.push('VALVE-IN-VALVE PLANNING');
      lines.push('───────────────────────────────────────────');
      if (this.viv.surgicalName) {
        lines.push(`Surgical valve:   ${this.viv.surgicalName}${this.viv.surgicalLabelMm != null ? ` ${this.viv.surgicalLabelMm}mm` : ''}`);
      }
      if (this.viv.innerDiameterMm != null) {
        lines.push(`True inner ø:     ${r(this.viv.innerDiameterMm)} mm  (${this.viv.measured ? 'CT-measured' : 'database'})`);
      }
      const bvf = this.vivBvfAssessment();
      if (bvf) {
        lines.push(`BVF:              ${bvf.feasible ? 'feasible' : 'not reported'}${bvf.estimatedIdGainMm > 0 ? ` (~+${r(bvf.estimatedIdGainMm)} mm ID gain)` : ''}`);
      }
      if (vivRecs && vivRecs.length > 0) {
        lines.push('');
        lines.push('Recommended TAVI-in-valve (by fit):');
        for (const rec of vivRecs) {
          lines.push(`  ${rec.familyName} ${rec.sizeMm}mm — CI ${r(rec.coverIndexPct)}% [${rec.fitStatus.toUpperCase()}] · ${rec.note}`);
        }
      }
      if (this.viv.selectedTavi) {
        lines.push('');
        lines.push(`Selected ViV TAVI: ${this.viv.selectedTavi.familyName} ${r(this.viv.selectedTavi.sizeMm, this.viv.selectedTavi.sizeMm % 1 === 0 ? 0 : 1)}mm`);
      }
      lines.push('');
    }

    // Access vessels (ilio-femoral runoff)
    if (this.accessVessels.size > 0) {
      lines.push('ACCESS VESSELS');
      lines.push('───────────────────────────────────────────');
      const vesselNames: Record<AccessVesselId, string> = {
        'thoracic-aorta': 'Thoracic Aorta',
        'abdominal-aorta': 'Abdominal Aorta',
        'iliac-left': 'Iliac (L)',
        'iliac-right': 'Iliac (R)',
      };
      for (const [id, v] of this.accessVessels) {
        lines.push(
          `${vesselNames[id]}: min ø ${r(v.minLumenDiameterMm)} mm @ ${r(v.minLumenAtArcLengthMm, 0)}mm, ` +
          `tortuosity ${r(v.tortuosityIndex, 2)} (${r(v.cumulativeAngulationDeg, 0)}° total)`
        );
      }
      lines.push('');
    }

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
    const vivRecsCsv = this.vivRecommendations();
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

    if (this.annulusCalcium) rows.push(['Annulus Agatston 2D', this.annulusCalcium.agatstonScore2D.toFixed(0), '']);
    if (this.cuspCalciumLCC) rows.push(['LCC Agatston 2D', this.cuspCalciumLCC.agatstonScore2D.toFixed(0), '']);
    if (this.cuspCalciumRCC) rows.push(['RCC Agatston 2D', this.cuspCalciumRCC.agatstonScore2D.toFixed(0), '']);
    if (this.cuspCalciumNCC) rows.push(['NCC Agatston 2D', this.cuspCalciumNCC.agatstonScore2D.toFixed(0), '']);
    rows.push(['LCC Ca Grade', String(this.cuspCalcificationGradeLCC), '']);
    rows.push(['RCC Ca Grade', String(this.cuspCalcificationGradeRCC), '']);
    rows.push(['NCC Ca Grade', String(this.cuspCalcificationGradeNCC), '']);
    if (this.lvotCalcium) rows.push(['LVOT Agatston 2D', this.lvotCalcium.agatstonScore2D.toFixed(0), '']);

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

    for (const label of ['LCS', 'RCS', 'NCS'] as SinusLabel[]) {
      const d = this.sinusDiameters[label];
      if (!d) continue;
      rows.push([`Sinus ${label} Diameter`, d.diameterMm.toFixed(1), 'mm']);
      if (d.heightMm != null) rows.push([`Sinus ${label} Height`, d.heightMm.toFixed(1), 'mm']);
    }

    // Multi-level geometries
    for (const [dist, geom] of this.multiLevelGeometries) {
      const prefix = dist < 0 ? `LVOT ${Math.abs(dist)}mm` : `AV +${dist}mm`;
      rows.push([`${prefix} Min Diameter`, geom.minimumDiameterMm.toFixed(1), 'mm']);
      rows.push([`${prefix} Max Diameter`, geom.maximumDiameterMm.toFixed(1), 'mm']);
      rows.push([`${prefix} Area`, geom.areaMm2.toFixed(1), 'mm2']);
    }

    const overlaps = this.cuspOverlapViews;
    if (overlaps) {
      const fmtAngle = (a: TAVIFluoroAngleResult) =>
        `${a.laoRaoLabel} ${Math.abs(a.laoRaoDegrees).toFixed(0)} / ${a.cranialCaudalLabel} ${Math.abs(a.cranialCaudalDegrees).toFixed(0)}`;
      rows.push(['R/L Overlap View (NCC)', fmtAngle(overlaps.rlOverlap.angle), 'deg']);
      rows.push(['R/N Overlap View (LCC)', fmtAngle(overlaps.rnOverlap.angle), 'deg']);
      rows.push(['L/N Overlap View (RCC)', fmtAngle(overlaps.lnOverlap.angle), 'deg']);
    }

    rows.push(['Planned Access', this.plannedAccess, '']);
    rows.push(['Planned Pigtail Access', this.plannedPigtailAccess, '']);

    if (this.selectedValve) {
      rows.push(['Selected Valve Family', this.selectedValve.familyName, '']);
      rows.push(['Selected Valve Size', this.selectedValve.sizeMm.toString(), 'mm']);
      rows.push(['Implant Depth', this.implantDepthMm.toFixed(1), 'mm']);
      rows.push(['Deployment Ratio', this.deploymentRatio, '']);
      const dep = this.deploymentResult();
      if (dep) {
        rows.push(['Cover Index', dep.coverIndexPct.toFixed(1), '%']);
        rows.push(['Oversizing', dep.oversizingPct.toFixed(0), '%']);
        rows.push(['Oversizing Metric', dep.oversizingMetric, '']);
        for (const c of dep.coronary) {
          const tag = c.side === 'left' ? 'LCO' : 'RCO';
          rows.push([`${tag} Clearance`, c.clearanceMm.toFixed(1), 'mm']);
          rows.push([`${tag} Obstruction Risk`, c.risk, '']);
        }
        rows.push(['PVL Score', String(dep.pvl.score), '/100']);
        rows.push(['PVL Band', dep.pvl.band, '']);
      }
    }

    // Valve-in-Valve
    if (this.viv.surgicalName) {
      rows.push(['ViV Surgical Valve', this.viv.surgicalName, '']);
      if (this.viv.surgicalLabelMm != null) rows.push(['ViV Surgical Size', this.viv.surgicalLabelMm.toString(), 'mm']);
    }
    if (this.viv.innerDiameterMm != null) {
      rows.push(['ViV True Inner Diameter', this.viv.innerDiameterMm.toFixed(1), 'mm']);
      rows.push(['ViV ID Source', this.viv.measured ? 'CT-measured' : 'database', '']);
    }
    const bvf = this.vivBvfAssessment();
    if (bvf) {
      rows.push(['ViV BVF Feasible', bvf.feasible ? 'yes' : 'no', '']);
      rows.push(['ViV BVF ID Gain', bvf.estimatedIdGainMm.toFixed(1), 'mm']);
    }
    if (vivRecsCsv && vivRecsCsv.length > 0) {
      for (const rec of vivRecsCsv) {
        rows.push([`ViV Rec ${rec.familyName}`, rec.sizeMm.toString(), `mm CI ${rec.coverIndexPct.toFixed(1)}% ${rec.fitStatus}`]);
      }
    }
    if (this.viv.selectedTavi) {
      rows.push(['ViV Selected TAVI', `${this.viv.selectedTavi.familyName} ${this.viv.selectedTavi.sizeMm}`, 'mm']);
    }

    const vesselCsvNames: Record<AccessVesselId, string> = {
      'thoracic-aorta': 'Thoracic Aorta',
      'abdominal-aorta': 'Abdominal Aorta',
      'iliac-left': 'Iliac L',
      'iliac-right': 'Iliac R',
    };
    for (const [id, v] of this.accessVessels) {
      const n = vesselCsvNames[id];
      rows.push([`${n} Min Lumen`, v.minLumenDiameterMm.toFixed(1), 'mm']);
      rows.push([`${n} Tortuosity Index`, v.tortuosityIndex.toFixed(2), '']);
      rows.push([`${n} Cumulative Angulation`, v.cumulativeAngulationDeg.toFixed(0), 'deg']);
      rows.push([`${n} Path Length`, v.pathLengthMm.toFixed(1), 'mm']);
      rows.push([`${n} Chord Length`, v.chordLengthMm.toFixed(1), 'mm']);
    }

    return rows.map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
  }

  /** Export world-coordinate landmarks and annulus contours for QA/debug/research review. */
  public annulusPointsCsvReport(): string {
    const rows: string[][] = [];
    const addPoint = (group: string, label: string, index: number | string, p?: TAVIVector3D | null, note = '') => {
      if (!p) return;
      rows.push([
        group,
        label,
        String(index),
        p.x.toFixed(3),
        p.y.toFixed(3),
        p.z.toFixed(3),
        note,
      ]);
    };

    rows.push(['Group', 'Label', 'Index', 'X', 'Y', 'Z', 'Note']);

    addPoint('Cusp', 'LCC', '', this.cuspLCC);
    addPoint('Cusp', 'RCC', '', this.cuspRCC);
    addPoint('Cusp', 'NCC', '', this.cuspNCC);
    addPoint('Ostium', 'LCA', '', this.leftOstiumSnapshot?.worldPoint, this.leftCoronaryHeightMm != null ? `height ${this.leftCoronaryHeightMm.toFixed(1)} mm` : '');
    addPoint('Ostium', 'RCA', '', this.rightOstiumSnapshot?.worldPoint, this.rightCoronaryHeightMm != null ? `height ${this.rightCoronaryHeightMm.toFixed(1)} mm` : '');
    addPoint('Plane', 'Annulus centroid', '', this.annulusPlaneCentroid);
    addPoint('Plane', 'Annulus normal', '', this.annulusPlaneNormal);

    this.annulusRawContourPoints.forEach((p, index) => {
      addPoint('Annulus raw contour', 'Raw', index, p);
    });
    this.annulusSnapshot?.worldPoints.forEach((p, index) => {
      addPoint('Annulus interpolated contour', 'Interpolated', index, p);
    });

    for (const label of ['LCS', 'RCS', 'NCS'] as SinusLabel[]) {
      const pair = this.sinusDiameterPoints[label];
      addPoint('Sinus width', `${label} A`, '', pair?.a);
      addPoint('Sinus width', `${label} B`, '', pair?.b);
      addPoint('Sinus floor', label, '', this.sinusFloorPoints[label]);
    }

    const escapeCell = (cell: string) => `"${cell.split('"').join('""')}"`;
    return rows.map(row => row.map(escapeCell).join(',')).join('\n');
  }

  /**
   * Compute the post-deployment metrics for the selected prosthesis against the
   * measured annulus. Returns null until both a prosthesis is selected and an
   * annulus geometry exists. Used by the report and the 3D deployment view.
   */
  public deploymentResult(): DeploymentResult | null {
    if (!this.selectedValve) return null;
    const entry = resolveSelectedValve(this.selectedValve.familyName, this.selectedValve.sizeMm);
    const annulus = this.activeAnnulusGeometry();
    if (!entry || !annulus) return null;
    const profile = frameProfileFor(
      entry.family.name,
      entry.family.type === 'self-expanding',
      entry.size.size,
    );
    const rings = positionFrame(profile, this.implantDepthMm, this.deploymentRatio);
    return computeDeploymentResult({
      family: entry.family,
      size: entry.size,
      annulus: {
        perimeterMm: annulus.perimeterMm,
        areaMm2: annulus.areaMm2,
        minimumDiameterMm: annulus.minimumDiameterMm,
        maximumDiameterMm: annulus.maximumDiameterMm,
      },
      frameOutflowHeightMm: rings[rings.length - 1].heightAboveAnnulusMm,
      coronaryHeights: { left: this.leftCoronaryHeightMm, right: this.rightCoronaryHeightMm },
      calciumGrades: { annulus: this.annulusCalcificationGrade, cusp: this.cuspCalcificationGrade },
    });
  }

  /**
   * Compute ViV sizing recommendations for the current surgical bioprosthesis
   * state. Returns null when no inner diameter is available. Uses the measured
   * diameter when present, otherwise the DB true ID for the selected surgical
   * valve + label size.
   */
  public vivRecommendations(): VivValveRecommendation[] | null {
    const inner = this.viv.measured && this.viv.innerDiameterMm != null
      ? this.viv.innerDiameterMm
      : (() => {
          if (!this.viv.surgicalName || this.viv.surgicalLabelMm == null) return null;
          const bp = resolveSurgicalBioprosthesis(this.viv.surgicalName);
          return bp?.trueInnerDiameterMm[this.viv.surgicalLabelMm] ?? null;
        })();
    if (inner == null) return null;
    const families = VALVE_FAMILIES.map((f) => ({
      name: f.name,
      type: f.type,
      sizes: f.sizes.map((s) => s.size),
    }));
    return recommendVivValveSizes(inner, families);
  }

  /** BVF assessment for the currently-selected surgical bioprosthesis. */
  public vivBvfAssessment(): { feasible: boolean; estimatedIdGainMm: number; note: string } | null {
    if (!this.viv.surgicalName || this.viv.surgicalLabelMm == null) return null;
    const bp = resolveSurgicalBioprosthesis(this.viv.surgicalName);
    if (!bp) return null;
    return assessBvf(bp, this.viv.surgicalLabelMm);
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
