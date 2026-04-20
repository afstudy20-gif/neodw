import * as cornerstone from '@cornerstonejs/core';
import { TAVIVector3D } from './TAVITypes';
import { TAVIGeometry } from './TAVIGeometry';

/**
 * DoubleObliqueController manages two linked viewports for TAVI planning.
 *
 * LEFT viewport = reference plane (longitudinal cut through aortic axis)
 * RIGHT viewport = working plane (cross-section perpendicular to axis)
 *
 * Mouse interaction (ProSizeAV-style):
 * - Mouse move in RIGHT → rotates LEFT viewport
 * - Scroll in RIGHT → tilts the plane (changes tilt angle)
 * - Mouse move in LEFT → rotates RIGHT viewport
 * - Scroll in LEFT → translates along axis (scroll through aortic root)
 */

export interface DoubleObliqueState {
  axisPoint: TAVIVector3D;
  axisDirection: TAVIVector3D;
  rotationAngle: number;   // radians: rotation around axis
  tiltAngle: number;       // radians: tilt perpendicular to axis
}

const SCROLL_STEP_MM = 0.75; // Fine step for cusp nadir identification (was 1.5mm)
const TILT_STEP_RAD = 0.03; // ~1.7 degrees per scroll tick (was ~3°)
// Sensitivity: degrees of rotation per pixel from center (absolute positioning)
// ~250px from center = ~12.5 degrees max rotation
const ROTATION_DEG_PER_PIXEL = 0.05;
// Translation: mm per pixel from center (absolute positioning)
// ~250px from center = ~12.5mm max translation
const TRANSLATION_MM_PER_PIXEL = 0.05;

export class DoubleObliqueController {
  private renderingEngineId: string;
  private leftViewportId: string;
  private rightViewportId: string;
  private sagittalViewportId: string = 'sagittal';
  private state: DoubleObliqueState;
  private disposed = false;
  private initialSetup = true;

  // Event handler references for cleanup
  private rightMouseMoveHandler: ((e: MouseEvent) => void) | null = null;
  private rightWheelHandler: ((e: WheelEvent) => void) | null = null;
  private leftMouseMoveHandler: ((e: MouseEvent) => void) | null = null;
  private leftWheelHandler: ((e: WheelEvent) => void) | null = null;
  private leftMouseDownHandler: ((e: MouseEvent) => void) | null = null;
  private leftMouseUpHandler: ((e: MouseEvent) => void) | null = null;
  private sagittalWheelHandler: ((e: WheelEvent) => void) | null = null;
  private cameraModifiedHandler: ((evt: any) => void) | null = null;

  // Base state captured when mouse enters a viewport (for absolute positioning)
  private baseRotationAngle = 0;
  private baseAxisPoint: TAVIVector3D = { x: 0, y: 0, z: 0 };

  // Target indicator element
  private targetIndicator: HTMLDivElement | null = null;

  // Scroll lock for annulus tracing (Phase 3)
  private scrollLocked = false;

  // Animation frame ID for cleanup
  private animationFrameId: number | null = null;

  constructor(
    renderingEngineId: string,
    leftViewportId: string,
    rightViewportId: string
  ) {
    this.renderingEngineId = renderingEngineId;
    this.leftViewportId = leftViewportId;
    this.rightViewportId = rightViewportId;
    this.state = {
      axisPoint: { x: 0, y: 0, z: 0 },
      axisDirection: { x: 0, y: 0, z: 1 },
      rotationAngle: 0,
      tiltAngle: 0,
    };
  }

  /** Initialize with a detected or manually placed aortic axis */
  initialize(axisPoint: TAVIVector3D, axisDirection: TAVIVector3D): void {
    this.state.axisPoint = { ...axisPoint };
    this.state.axisDirection = TAVIGeometry.vectorNormalize(axisDirection);
    // Start at π/2 rotation so the reference (left) viewport shows a sagittal-like view
    // (looking from the patient's left side). This is the standard orientation for
    // cusp hinge point identification — cusps are visible in profile from this angle,
    // similar to OsiriX/3mensio TAVI planning views.
    // At rotation=0, the view is coronal-like (from the front) where cusps overlap.
    this.state.rotationAngle = Math.PI / 2;
    this.state.tiltAngle = 0;
    this.initialSetup = true;

    console.log('[DoubleOblique] initialize — axisPoint:', JSON.stringify(axisPoint), 'axisDir:', JSON.stringify(this.state.axisDirection));

    this.updateCameras();

    // Debug: log final camera states
    const eng = cornerstone.getRenderingEngine(this.renderingEngineId);
    if (eng) {
      const lCam = eng.getViewport(this.leftViewportId)?.getCamera();
      const rCam = eng.getViewport(this.rightViewportId)?.getCamera();
      console.log('[DoubleOblique] LEFT camera:', JSON.stringify({
        vpn: lCam?.viewPlaneNormal, vup: lCam?.viewUp, fp: lCam?.focalPoint,
        ps: lCam?.parallelScale
      }));
      console.log('[DoubleOblique] RIGHT camera:', JSON.stringify({
        vpn: rCam?.viewPlaneNormal, vup: rCam?.viewUp, fp: rCam?.focalPoint,
        ps: rCam?.parallelScale
      }));
    }

    this.attachListeners();
    this.createOrientationIcons();
  }

  getState(): Readonly<DoubleObliqueState> {
    return this.state;
  }

  getAxisPoint(): TAVIVector3D {
    return { ...this.state.axisPoint };
  }

  getAxisDirection(): TAVIVector3D {
    return { ...this.state.axisDirection };
  }

  /** Restore a previously saved state (for reset/back operations) */
  restoreState(saved: { axisPoint: TAVIVector3D; axisDirection: TAVIVector3D; rotationAngle: number; tiltAngle: number }): void {
    this.state.axisPoint = { ...saved.axisPoint };
    this.state.axisDirection = TAVIGeometry.vectorNormalize(saved.axisDirection);
    this.state.rotationAngle = saved.rotationAngle;
    this.state.tiltAngle = saved.tiltAngle;
    console.log('[DoubleOblique] restoreState — axisPoint:', JSON.stringify(saved.axisPoint), 'rotation:', saved.rotationAngle.toFixed(2));
    this.updateCameras();
  }

  /** Set the rotation angle directly (radians) */
  setRotationAngle(radians: number): void {
    this.state.rotationAngle = radians;
    this.updateCameras();
  }

  /** Compute the rotation angle (radians) that orients the LEFT viewport to face a given world point.
   *  The LEFT viewport's plane will contain the axis direction and the direction toward the target point. */
  computeRotationAngleToward(targetPoint: TAVIVector3D): number {
    const axis = this.state.axisDirection;
    // Vector from current axisPoint to target
    const toTarget = TAVIGeometry.vectorSubtract(targetPoint, this.state.axisPoint);
    // Project onto plane perpendicular to axis
    const dot = TAVIGeometry.vectorDot(toTarget, axis);
    const projected = TAVIGeometry.vectorSubtract(toTarget, TAVIGeometry.vectorScale(axis, dot));
    const projLen = TAVIGeometry.vectorLength(projected);
    if (projLen < 0.001) return this.state.rotationAngle; // target is on the axis

    const projNorm = TAVIGeometry.vectorScale(projected, 1 / projLen);

    // Decompose into rawUp / rawRight basis
    const helper = Math.abs(axis.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
    const rawUp = TAVIGeometry.vectorNormalize(TAVIGeometry.vectorCross(helper, axis));
    const rawRight = TAVIGeometry.vectorNormalize(TAVIGeometry.vectorCross(axis, rawUp));

    const compUp = TAVIGeometry.vectorDot(projNorm, rawUp);
    const compRight = TAVIGeometry.vectorDot(projNorm, rawRight);

    return Math.atan2(compRight, compUp);
  }

  /** Get the left viewport ID */
  getLeftViewportId(): string { return this.leftViewportId; }

  /** Get the right viewport ID */
  getRightViewportId(): string { return this.rightViewportId; }

  /** Set the tilt angle directly (radians) */
  setTiltAngle(radians: number): void {
    this.state.tiltAngle = Math.max(-Math.PI / 6, Math.min(Math.PI / 6, radians));
    this.updateCameras();
  }

  /** Set both rotation and tilt to achieve a specific LAO/RAO viewing angle.
   *  laoRaoDeg: positive = LAO, negative = RAO
   *  cranCaudDeg: positive = Cranial, negative = Caudal (maps to tilt) */
  setViewingAngle(laoRaoDeg: number, cranCaudDeg: number): void {
    this.state.rotationAngle = (laoRaoDeg * Math.PI) / 180;
    this.state.tiltAngle = Math.max(-Math.PI / 6, Math.min(Math.PI / 6, (cranCaudDeg * Math.PI) / 180));
    this.updateCameras();
  }

  /** Lock scrolling (used during constrained contour tracing) */
  lockScrolling(): void {
    this.scrollLocked = true;
  }

  /** Unlock scrolling */
  unlockScrolling(): void {
    this.scrollLocked = false;
  }

  /**
   * Compute the camera parameters for both viewports based on the current state.
   *
   * RIGHT viewport: shows cross-section perpendicular to axis
   *   viewPlaneNormal = axisDirection
   *   viewUp = rotated up vector
   *
   * LEFT viewport: shows longitudinal cut through axis
   *   viewPlaneNormal = perpendicular to both axis and right's viewUp
   *   viewUp = axisDirection
   */
  private computeCameraParams(): {
    right: { viewPlaneNormal: cornerstone.Types.Point3; viewUp: cornerstone.Types.Point3; focalPoint: cornerstone.Types.Point3 };
    left: { viewPlaneNormal: cornerstone.Types.Point3; viewUp: cornerstone.Types.Point3; focalPoint: cornerstone.Types.Point3 };
  } {
    const axis = this.state.axisDirection;

    // Compute a canonical "up" perpendicular to the axis
    const helper = Math.abs(axis.z) < 0.9
      ? { x: 0, y: 0, z: 1 }
      : { x: 0, y: 1, z: 0 };
    const rawUp = TAVIGeometry.vectorNormalize(
      TAVIGeometry.vectorCross(helper, axis)
    );
    const rawRight = TAVIGeometry.vectorNormalize(
      TAVIGeometry.vectorCross(axis, rawUp)
    );

    // Apply rotation around axis
    const cosR = Math.cos(this.state.rotationAngle);
    const sinR = Math.sin(this.state.rotationAngle);
    const rotatedUp = TAVIGeometry.vectorNormalize(
      TAVIGeometry.vectorAdd(
        TAVIGeometry.vectorScale(rawUp, cosR),
        TAVIGeometry.vectorScale(rawRight, sinR)
      )
    );
    const rotatedRight = TAVIGeometry.vectorNormalize(
      TAVIGeometry.vectorCross(axis, rotatedUp)
    );

    // Apply tilt (rotates axis direction slightly)
    const cosT = Math.cos(this.state.tiltAngle);
    const sinT = Math.sin(this.state.tiltAngle);
    const tiltedAxis = TAVIGeometry.vectorNormalize(
      TAVIGeometry.vectorAdd(
        TAVIGeometry.vectorScale(axis, cosT),
        TAVIGeometry.vectorScale(rotatedRight, sinT)
      )
    );

    const fp: cornerstone.Types.Point3 = [
      this.state.axisPoint.x,
      this.state.axisPoint.y,
      this.state.axisPoint.z,
    ];

    // RIGHT viewport: looking along the (tilted) axis, negated to view from the correct side
    // (looking from ascending aorta toward LVOT = standard valve view from above)
    const rightVPN: cornerstone.Types.Point3 = [-tiltedAxis.x, -tiltedAxis.y, -tiltedAxis.z];
    const rightUp: cornerstone.Types.Point3 = [rotatedUp.x, rotatedUp.y, rotatedUp.z];

    // LEFT viewport: longitudinal view — looking perpendicular to both axis and rotatedUp
    // cross(rotatedUp, tiltedAxis) ensures correct (non-mirrored) orientation
    const leftNormal = TAVIGeometry.vectorNormalize(
      TAVIGeometry.vectorCross(rotatedUp, tiltedAxis)
    );
    const leftVPN: cornerstone.Types.Point3 = [leftNormal.x, leftNormal.y, leftNormal.z];
    const leftUp: cornerstone.Types.Point3 = [tiltedAxis.x, tiltedAxis.y, tiltedAxis.z];

    return {
      right: { viewPlaneNormal: rightVPN, viewUp: rightUp, focalPoint: fp },
      left: { viewPlaneNormal: leftVPN, viewUp: leftUp, focalPoint: fp },
    };
  }

  /** Apply computed camera parameters to both viewports */
  updateCameras(): void {
    const engine = cornerstone.getRenderingEngine(this.renderingEngineId);
    if (!engine) return;

    const params = this.computeCameraParams();

    const leftVp = engine.getViewport(this.leftViewportId);
    const rightVp = engine.getViewport(this.rightViewportId);

    // Apply oblique camera to each viewport.
    // For ORTHOGRAPHIC volume viewports in Cornerstone v4:
    //   - viewPlaneNormal = slice plane orientation (normal of the oblique cut)
    //   - viewUp = which direction is "up" in the viewport
    //   - focalPoint = the 3D point that the slice passes through
    //   - parallelScale = half the viewport height in mm (controls zoom)
    //   - position = camera position along the normal (for parallel projection)
    const applyCamera = (
      vp: cornerstone.Types.IViewport | undefined,
      cam: { viewPlaneNormal: cornerstone.Types.Point3; viewUp: cornerstone.Types.Point3; focalPoint: cornerstone.Types.Point3 },
      side: 'left' | 'right'
    ) => {
      if (!vp) return;

      // Preserve existing parallelScale if set, otherwise compute from volume
      const existingCam = vp.getCamera();
      let parallelScale = existingCam.parallelScale || 150;

      // On first call, set appropriate zoom for each viewport:
      // LEFT (reference/longitudinal): 100mm half-height = 200mm total FOV
      //   — shows the full aortic root lengthwise
      // RIGHT (working/cross-section): 50mm half-height = 100mm total FOV
      //   — zoomed into the aortic root cross-section (~30mm diameter)
      if (this.initialSetup) {
        parallelScale = side === 'left' ? 100 : 50;
      }

      const vpn = cam.viewPlaneNormal;
      const d = 1000; // far enough for parallel projection

      vp.setCamera({
        parallelProjection: true,
        viewPlaneNormal: vpn,
        viewUp: cam.viewUp,
        focalPoint: cam.focalPoint,
        position: [
          cam.focalPoint[0] + vpn[0] * d,
          cam.focalPoint[1] + vpn[1] * d,
          cam.focalPoint[2] + vpn[2] * d,
        ] as cornerstone.Types.Point3,
        parallelScale,
      });
      vp.render();
    };

    applyCamera(leftVp, params.left, 'left');
    applyCamera(rightVp, params.right, 'right');

    // Center sagittal viewport on axis point (keep standard orientation, just move focal point)
    const sagVp = engine.getViewport(this.sagittalViewportId);
    if (sagVp) {
      const sagCam = sagVp.getCamera();
      const fp = this.state.axisPoint;
      const sagVPN = sagCam.viewPlaneNormal || [1, 0, 0];
      const d = 1000;
      sagVp.setCamera({
        ...sagCam,
        focalPoint: [fp.x, fp.y, fp.z],
        position: [fp.x + sagVPN[0] * d, fp.y + sagVPN[1] * d, fp.z + sagVPN[2] * d],
        parallelScale: this.initialSetup ? 80 : sagCam.parallelScale,
      });
      sagVp.render();
    }

    this.initialSetup = false;

    // Schedule overlay updates after render completes
    // (Cornerstone render() may modify DOM, so we defer overlay updates)
    requestAnimationFrame(() => {
      if (this.orientationIcons.length > 0) {
        this.updateOrientationIcons();
      }
      this.updatePlaneIndicatorLine();
      this.updateMarkerOverlay();
      this.updateLeftMarkerOverlay();
      this.updateSagittalOverlay();
    });
  }

  /** Animate rotation around the axis (e.g., 120 degrees for cusp-to-cusp) */
  rotateAroundAxis(angleDegrees: number, durationMs = 500): Promise<void> {
    return new Promise((resolve) => {
      const startAngle = this.state.rotationAngle;
      const deltaAngle = (angleDegrees * Math.PI) / 180;
      const startTime = performance.now();

      const animate = (now: number) => {
        const elapsed = now - startTime;
        const t = Math.min(1, elapsed / durationMs);
        // Ease in-out
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

        this.state.rotationAngle = startAngle + deltaAngle * eased;
        this.updateCameras();

        if (t < 1) {
          this.animationFrameId = requestAnimationFrame(animate);
        } else {
          this.animationFrameId = null;
          resolve();
        }
      };

      this.animationFrameId = requestAnimationFrame(animate);
    });
  }

  /** Prepare views for cusp hinge point definition:
   *  - Zoom both viewports appropriately for cusp visibility
   *  - RIGHT (working): zoom into cross-section (50mm parallelScale = 100mm FOV)
   *  - LEFT (reference): show longitudinal profile (80mm parallelScale = 160mm FOV) */
  prepareForCuspDefinition(): void {
    const engine = cornerstone.getRenderingEngine(this.renderingEngineId);
    if (!engine) return;

    const leftVp = engine.getViewport(this.leftViewportId);
    const rightVp = engine.getViewport(this.rightViewportId);

    if (leftVp) {
      const cam = leftVp.getCamera();
      leftVp.setCamera({ ...cam, parallelScale: 80 });
      leftVp.render();
    }
    if (rightVp) {
      const cam = rightVp.getCamera();
      rightVp.setCamera({ ...cam, parallelScale: 50 });
      rightVp.render();
    }
    console.log('[DoubleOblique] prepareForCuspDefinition — zoom set (left:80, right:50)');
  }

  /** Align working viewport to show a specific plane (e.g., after 3-point cusp definition) */
  alignToPlane(normal: TAVIVector3D, centroid: TAVIVector3D): void {
    this.state.axisPoint = { ...centroid };

    // The new axis direction becomes the plane normal
    this.state.axisDirection = TAVIGeometry.vectorNormalize(normal);
    // Keep π/2 rotation so the reference (left) viewport shows sagittal-like view
    // (looking from the side — aortic root visible vertically)
    this.state.rotationAngle = Math.PI / 2;
    this.state.tiltAngle = 0;
    this.updateCameras();
  }

  /** Navigate to a plane at a given distance from the current axis point along the axis */
  showPlaneAtDistance(distanceMm: number): void {
    this.state.axisPoint = TAVIGeometry.vectorAdd(
      this.state.axisPoint,
      TAVIGeometry.vectorScale(this.state.axisDirection, distanceMm)
    );
    this.updateCameras();
  }

  /** Navigate to a plane at a given distance from a fixed origin along the axis */
  showPlaneAtDistanceFromOrigin(origin: TAVIVector3D, distanceMm: number): void {
    this.state.axisPoint = TAVIGeometry.vectorAdd(
      origin,
      TAVIGeometry.vectorScale(this.state.axisDirection, distanceMm)
    );
    this.updateCameras();
  }

  /**
   * Generate multi-level cross-section thumbnails.
   * Moves the working viewport to each distance, renders, captures, then restores.
   */
  async generateMultiLevelThumbnails(
    origin: TAVIVector3D,
    distances: number[]
  ): Promise<Map<number, string>> {
    const result = new Map<number, string>();
    const savedAxisPoint = { ...this.state.axisPoint };

    for (const dist of distances) {
      this.showPlaneAtDistanceFromOrigin(origin, dist);
      // Wait for render to complete
      await new Promise<void>(resolve => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      });
      const thumbnail = await this.captureViewportThumbnail();
      if (thumbnail) {
        result.set(dist, thumbnail);
      }
    }

    // Restore original position
    this.state.axisPoint = savedAxisPoint;
    this.updateCameras();

    return result;
  }

  /** Navigate to estimated coronary position: rotate + translate above annulus plane */
  navigateToEstimatedCoronaryPosition(
    side: 'left' | 'right',
    annulusCentroid: TAVIVector3D
  ): void {
    // Coronary ostia are typically 10–15mm above the annulus plane
    const heightAboveAnnulus = 12; // mm estimate
    this.state.axisPoint = TAVIGeometry.vectorAdd(
      annulusCentroid,
      TAVIGeometry.vectorScale(this.state.axisDirection, heightAboveAnnulus)
    );

    // LCA is roughly at 120° from RCA around the aortic root
    // Rotate to approximate position
    if (side === 'left') {
      this.state.rotationAngle = -Math.PI / 3; // ~-60° from reference
    } else {
      this.state.rotationAngle = Math.PI / 3; // ~+60° from reference
    }

    this.updateCameras();
  }

  /** Capture the current working viewport as a base64 thumbnail */
  async captureViewportThumbnail(): Promise<string | null> {
    const engine = cornerstone.getRenderingEngine(this.renderingEngineId);
    if (!engine) return null;

    const vp = engine.getViewport(this.rightViewportId);
    if (!vp?.element) return null;

    const canvas = vp.element.querySelector('canvas');
    if (!canvas) return null;

    return canvas.toDataURL('image/png');
  }

  // ── Event Listeners ──
  //
  // ProSizeAV interaction model (absolute position from viewport center):
  //
  // RIGHT viewport (working / cross-section):
  //   mousemove Y offset from center → translate along axis (reconstructs LEFT)
  //   scroll → tilt plane
  //
  // LEFT viewport (reference / longitudinal):
  //   mousemove X offset from center → rotate around axis (reconstructs RIGHT)
  //   scroll → translate along axis

  private attachListeners(): void {
    const engine = cornerstone.getRenderingEngine(this.renderingEngineId);
    if (!engine) return;

    const leftVp = engine.getViewport(this.leftViewportId);
    const rightVp = engine.getViewport(this.rightViewportId);

    if (!leftVp?.element || !rightVp?.element) return;

    // Capture base state so absolute offsets are relative to the state
    // at the moment the mouse entered the viewport
    this.baseRotationAngle = this.state.rotationAngle;
    this.baseAxisPoint = { ...this.state.axisPoint };

    // ── RIGHT viewport: scroll → translate along axis, Alt+drag → tilt ──

    this.rightMouseMoveHandler = (e: MouseEvent) => {
      this.updateTargetIndicator(e, 'right');
    };

    this.rightWheelHandler = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.scrollLocked) return;
      // Scroll in RIGHT = translate along axis (move through aortic root)
      const delta = e.deltaY > 0 ? SCROLL_STEP_MM : -SCROLL_STEP_MM;
      this.state.axisPoint = TAVIGeometry.vectorAdd(
        this.state.axisPoint,
        TAVIGeometry.vectorScale(this.state.axisDirection, delta)
      );
      this.baseAxisPoint = { ...this.state.axisPoint };
      this.updateCameras();
      // Re-apply on next frame to guard against any async camera overrides
      requestAnimationFrame(() => this.updateCameras());
    };

    // ── LEFT viewport: scroll → rotate around axis ──

    this.leftMouseMoveHandler = (e: MouseEvent) => {
      this.updateTargetIndicator(e, 'left');
    };

    // Drag on reference viewport (middle-click OR Ctrl+left-click):
    // - vertical drag = translate along axis
    // - horizontal drag = tilt the cross-section plane
    // Left-click WITHOUT modifier is reserved for the Probe tool (cusp/coronary capture)
    this.leftMouseDownHandler = (e: MouseEvent) => {
      const isMiddleClick = e.button === 1;
      const isCtrlLeftClick = e.button === 0 && (e.ctrlKey || e.metaKey);
      if (isMiddleClick || isCtrlLeftClick) {
        this.isDraggingPlane = true;
        this.lastDragX = e.clientX;
        this.lastDragY = e.clientY;
        e.preventDefault();
      }
    };
    this.leftMouseUpHandler = () => {
      this.isDraggingPlane = false;
    };

    this.leftWheelHandler = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.scrollLocked) return;
      // Scroll in LEFT = rotate around axis (reconstruct different longitudinal cut)
      const delta = e.deltaY > 0 ? TILT_STEP_RAD : -TILT_STEP_RAD;
      this.state.rotationAngle += delta;
      this.updateCameras();
      // Re-apply on next frame to guard against any async camera overrides
      requestAnimationFrame(() => this.updateCameras());
    };

    // ── SAGITTAL viewport: scroll → standard slice navigation ──
    const sagVp = engine.getViewport(this.sagittalViewportId);
    if (sagVp?.element) {
      this.sagittalWheelHandler = (e: WheelEvent) => {
        e.preventDefault();
        e.stopPropagation();
        // Scroll sagittal: move focal point along sagittal VPN (standard slice navigation)
        const cam = sagVp.getCamera();
        if (!cam.viewPlaneNormal || !cam.focalPoint) return;
        const vpn = cam.viewPlaneNormal;
        const step = e.deltaY > 0 ? SCROLL_STEP_MM : -SCROLL_STEP_MM;
        const newFP: cornerstone.Types.Point3 = [
          cam.focalPoint[0] + vpn[0] * step,
          cam.focalPoint[1] + vpn[1] * step,
          cam.focalPoint[2] + vpn[2] * step,
        ];
        const d = 1000;
        sagVp.setCamera({
          ...cam,
          focalPoint: newFP,
          position: [newFP[0] + vpn[0] * d, newFP[1] + vpn[1] * d, newFP[2] + vpn[2] * d],
        });
        sagVp.render();
        // Update sagittal overlay (reference lines + markers)
        requestAnimationFrame(() => this.updateSagittalOverlay());
      };
      sagVp.element.addEventListener('wheel', this.sagittalWheelHandler, { passive: false });
    }

    rightVp.element.addEventListener('mousemove', this.rightMouseMoveHandler);
    rightVp.element.addEventListener('wheel', this.rightWheelHandler, { passive: false });
    leftVp.element.addEventListener('mousemove', this.leftMouseMoveHandler);
    leftVp.element.addEventListener('wheel', this.leftWheelHandler, { passive: false });
    leftVp.element.addEventListener('mousedown', this.leftMouseDownHandler);
    leftVp.element.addEventListener('mouseup', this.leftMouseUpHandler);
    window.addEventListener('mouseup', this.leftMouseUpHandler); // catch mouseup outside viewport

    // Listen for Cornerstone CAMERA_MODIFIED on all viewports to redraw overlays
    // when user zooms/pans via built-in tools (Pan, Zoom, W/L etc.)
    this.cameraModifiedHandler = () => {
      this.updateMarkerOverlay();
      this.updateLeftMarkerOverlay();
      this.updateSagittalOverlay();
    };
    const cameraEvent = cornerstone.Enums.Events.CAMERA_MODIFIED;
    for (const vpId of [this.leftViewportId, this.rightViewportId, this.sagittalViewportId]) {
      const vp = engine.getViewport(vpId);
      if (vp?.element) {
        vp.element.addEventListener(cameraEvent, this.cameraModifiedHandler);
      }
    }
  }

  private detachListeners(): void {
    const engine = cornerstone.getRenderingEngine(this.renderingEngineId);
    if (!engine) return;

    const leftVp = engine.getViewport(this.leftViewportId);
    const rightVp = engine.getViewport(this.rightViewportId);

    if (rightVp?.element) {
      if (this.rightMouseMoveHandler) rightVp.element.removeEventListener('mousemove', this.rightMouseMoveHandler);
      if (this.rightWheelHandler) rightVp.element.removeEventListener('wheel', this.rightWheelHandler);
    }
    if (leftVp?.element) {
      if (this.leftMouseMoveHandler) leftVp.element.removeEventListener('mousemove', this.leftMouseMoveHandler);
      if (this.leftWheelHandler) leftVp.element.removeEventListener('wheel', this.leftWheelHandler);
      if (this.leftMouseDownHandler) leftVp.element.removeEventListener('mousedown', this.leftMouseDownHandler);
      if (this.leftMouseUpHandler) {
        leftVp.element.removeEventListener('mouseup', this.leftMouseUpHandler);
        window.removeEventListener('mouseup', this.leftMouseUpHandler);
      }
    }

    // Sagittal cleanup
    const sagVp = engine.getViewport(this.sagittalViewportId);
    if (sagVp?.element && this.sagittalWheelHandler) {
      sagVp.element.removeEventListener('wheel', this.sagittalWheelHandler);
    }

    // Camera modified cleanup
    if (this.cameraModifiedHandler) {
      const cameraEvent = cornerstone.Enums.Events.CAMERA_MODIFIED;
      for (const vpId of [this.leftViewportId, this.rightViewportId, this.sagittalViewportId]) {
        const vp = engine.getViewport(vpId);
        if (vp?.element) {
          vp.element.removeEventListener(cameraEvent, this.cameraModifiedHandler);
        }
      }
    }

    this.rightMouseMoveHandler = null;
    this.rightWheelHandler = null;
    this.leftMouseMoveHandler = null;
    this.leftWheelHandler = null;
    this.leftMouseDownHandler = null;
    this.leftMouseUpHandler = null;
    this.sagittalWheelHandler = null;
    this.cameraModifiedHandler = null;
  }

  /** Update indicator on mouse move — also handle drag to translate/tilt the plane */
  private updateTargetIndicator(e: MouseEvent, source: 'left' | 'right'): void {
    if (source === 'left' && this.isDraggingPlane) {
      const dx = e.clientX - this.lastDragX;
      const dy = e.clientY - this.lastDragY;
      this.lastDragX = e.clientX;
      this.lastDragY = e.clientY;

      const engine = cornerstone.getRenderingEngine(this.renderingEngineId);
      const leftVp = engine?.getViewport(this.leftViewportId);
      if (leftVp) {
        const cam = leftVp.getCamera();
        const vpHeight = leftVp.element.clientHeight;
        const mmPerPx = ((cam.parallelScale || 120) * 2) / vpHeight;

        // Vertical drag → translate along axis (move cross-section plane up/down)
        if (Math.abs(dy) > 0) {
          const deltaMm = dy * mmPerPx;
          this.state.axisPoint = TAVIGeometry.vectorAdd(
            this.state.axisPoint,
            TAVIGeometry.vectorScale(this.state.axisDirection, -deltaMm)
          );
          this.baseAxisPoint = { ...this.state.axisPoint };
        }

        // Horizontal drag → tilt the cross-section plane
        if (Math.abs(dx) > 0) {
          const tiltDelta = dx * 0.003; // radians per pixel
          this.state.tiltAngle += tiltDelta;
          // Clamp tilt to ±30 degrees
          this.state.tiltAngle = Math.max(-Math.PI / 6, Math.min(Math.PI / 6, this.state.tiltAngle));
        }

        this.updateCameras();
      }
      return;
    }
    this.updatePlaneIndicatorLine();
  }

  // Drag state for the plane indicator line
  private isDraggingPlane = false;
  private lastDragX = 0;
  private lastDragY = 0;

  // Right viewport reference line overlay
  private rightIndicator: HTMLDivElement | null = null;

  /** Draw cross-reference lines on BOTH viewports:
   *  - LEFT: tilted line showing where the cross-section plane cuts (blue)
   *  - RIGHT: line showing the reference view's cut direction (orange) */
  private updatePlaneIndicatorLine(): void {
    const engine = cornerstone.getRenderingEngine(this.renderingEngineId);
    if (!engine) return;
    const leftVp = engine.getViewport(this.leftViewportId);
    const rightVp = engine.getViewport(this.rightViewportId);
    if (!leftVp?.element || !rightVp?.element) return;

    const params = this.computeCameraParams();
    const axis = this.state.axisDirection;
    const fp = this.state.axisPoint;
    const extent = 100; // mm

    // ── LEFT viewport: cross-section plane line (blue) ──
    if (!this.targetIndicator) {
      this.targetIndicator = document.createElement('div');
      this.targetIndicator.className = 'tavi-plane-indicator';
      this.targetIndicator.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:100;';
    }
    const leftEl = leftVp.element;
    if (!leftEl.contains(this.targetIndicator)) {
      leftEl.style.position = 'relative';
      leftEl.appendChild(this.targetIndicator);
    }

    // Cross-section plane intersects the reference view as a line
    const leftVPN = { x: params.left.viewPlaneNormal[0], y: params.left.viewPlaneNormal[1], z: params.left.viewPlaneNormal[2] };
    const planeRight = TAVIGeometry.vectorNormalize(TAVIGeometry.vectorCross(axis, leftVPN));
    const csP1 = TAVIGeometry.vectorAdd(fp, TAVIGeometry.vectorScale(planeRight, extent));
    const csP2 = TAVIGeometry.vectorAdd(fp, TAVIGeometry.vectorScale(planeRight, -extent));
    const lc1 = leftVp.worldToCanvas([csP1.x, csP1.y, csP1.z]);
    const lc2 = leftVp.worldToCanvas([csP2.x, csP2.y, csP2.z]);

    // Also draw the axis direction line on the left viewport (shows aortic axis path)
    const axP1 = TAVIGeometry.vectorAdd(fp, TAVIGeometry.vectorScale(axis, extent));
    const axP2 = TAVIGeometry.vectorAdd(fp, TAVIGeometry.vectorScale(axis, -extent));
    const la1 = leftVp.worldToCanvas([axP1.x, axP1.y, axP1.z]);
    const la2 = leftVp.worldToCanvas([axP2.x, axP2.y, axP2.z]);

    {
      const w = leftEl.clientWidth;
      const h = leftEl.clientHeight;
      let svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">`;
      // Cross-section plane line (blue)
      if (lc1 && lc2) {
        svg += `<line x1="${lc1[0]}" y1="${lc1[1]}" x2="${lc2[0]}" y2="${lc2[1]}" stroke="#58a6ff" stroke-width="2" opacity="0.8"/>`;
      }
      // Axis direction line (yellow, dashed)
      if (la1 && la2) {
        svg += `<line x1="${la1[0]}" y1="${la1[1]}" x2="${la2[0]}" y2="${la2[1]}" stroke="#d29922" stroke-width="1" stroke-dasharray="6,4" opacity="0.5"/>`;
      }
      svg += '</svg>';
      this.targetIndicator.innerHTML = svg;
    }

    // ── RIGHT viewport: reference view cut line (orange) ──
    if (!this.rightIndicator) {
      this.rightIndicator = document.createElement('div');
      this.rightIndicator.className = 'tavi-right-indicator';
      this.rightIndicator.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:100;';
    }
    const rightEl = rightVp.element;
    if (!rightEl.contains(this.rightIndicator)) {
      rightEl.style.position = 'relative';
      rightEl.appendChild(this.rightIndicator);
    }

    // The reference view's cut plane intersects the working view as a line
    // Reference VPN is the normal of the left viewport's slice
    const refNormal = { x: params.left.viewPlaneNormal[0], y: params.left.viewPlaneNormal[1], z: params.left.viewPlaneNormal[2] };
    // Direction of the line = cross(refNormal, workingVPN)
    const rightVPN = { x: params.right.viewPlaneNormal[0], y: params.right.viewPlaneNormal[1], z: params.right.viewPlaneNormal[2] };
    const refLineDir = TAVIGeometry.vectorNormalize(TAVIGeometry.vectorCross(refNormal, rightVPN));
    const refP1 = TAVIGeometry.vectorAdd(fp, TAVIGeometry.vectorScale(refLineDir, extent));
    const refP2 = TAVIGeometry.vectorAdd(fp, TAVIGeometry.vectorScale(refLineDir, -extent));
    const rc1 = rightVp.worldToCanvas([refP1.x, refP1.y, refP1.z]);
    const rc2 = rightVp.worldToCanvas([refP2.x, refP2.y, refP2.z]);

    {
      const w = rightEl.clientWidth;
      const h = rightEl.clientHeight;
      let svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">`;
      // Reference plane intersection line (orange)
      if (rc1 && rc2) {
        svg += `<line x1="${rc1[0]}" y1="${rc1[1]}" x2="${rc2[0]}" y2="${rc2[1]}" stroke="#f0883e" stroke-width="2" opacity="0.8"/>`;
      }
      svg += '</svg>';
      this.rightIndicator.innerHTML = svg;
    }
  }

  /** Remove the target indicators from the DOM */
  private removeTargetIndicator(): void {
    this.targetIndicator?.parentElement?.removeChild(this.targetIndicator);
    this.targetIndicator = null;
    this.rightIndicator?.parentElement?.removeChild(this.rightIndicator);
    this.rightIndicator = null;
    this.sagittalIndicator?.parentElement?.removeChild(this.sagittalIndicator);
    this.sagittalIndicator = null;
  }

  // Sagittal viewport cross-reference overlay
  private sagittalIndicator: HTMLDivElement | null = null;

  /** Draw cross-reference lines on the sagittal viewport:
   *  - cross-section plane line (blue) showing current working plane intersection
   *  - axis direction line (yellow dashed) showing the aortic axis
   *  - focal point crosshair (green) showing current position */
  private updateSagittalOverlay(): void {
    const engine = cornerstone.getRenderingEngine(this.renderingEngineId);
    if (!engine) return;
    const sagVp = engine.getViewport(this.sagittalViewportId);
    if (!sagVp?.element) return;

    if (!this.sagittalIndicator) {
      this.sagittalIndicator = document.createElement('div');
      this.sagittalIndicator.className = 'tavi-sagittal-indicator';
      this.sagittalIndicator.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:100;';
    }
    const el = sagVp.element;
    if (!el.contains(this.sagittalIndicator)) {
      el.style.position = 'relative';
      el.appendChild(this.sagittalIndicator);
    }

    const fp = this.state.axisPoint;
    const axis = this.state.axisDirection;
    const extent = 100; // mm

    // Axis line (yellow dashed)
    const axP1 = TAVIGeometry.vectorAdd(fp, TAVIGeometry.vectorScale(axis, extent));
    const axP2 = TAVIGeometry.vectorAdd(fp, TAVIGeometry.vectorScale(axis, -extent));
    const sa1 = sagVp.worldToCanvas([axP1.x, axP1.y, axP1.z]);
    const sa2 = sagVp.worldToCanvas([axP2.x, axP2.y, axP2.z]);

    // Cross-section plane line (blue) — perpendicular to axis in sagittal view
    const params = this.computeCameraParams();
    const sagVPN = sagVp.getCamera().viewPlaneNormal || [1, 0, 0];
    const sagNormal = { x: sagVPN[0], y: sagVPN[1], z: sagVPN[2] };
    const csDir = TAVIGeometry.vectorNormalize(TAVIGeometry.vectorCross(axis, sagNormal));
    const csP1 = TAVIGeometry.vectorAdd(fp, TAVIGeometry.vectorScale(csDir, extent));
    const csP2 = TAVIGeometry.vectorAdd(fp, TAVIGeometry.vectorScale(csDir, -extent));
    const sc1 = sagVp.worldToCanvas([csP1.x, csP1.y, csP1.z]);
    const sc2 = sagVp.worldToCanvas([csP2.x, csP2.y, csP2.z]);

    // Center crosshair (green)
    const center = sagVp.worldToCanvas([fp.x, fp.y, fp.z]);

    const w = el.clientWidth;
    const h = el.clientHeight;
    let svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">`;

    // Axis line (yellow dashed)
    if (sa1 && sa2) {
      svg += `<line x1="${sa1[0]}" y1="${sa1[1]}" x2="${sa2[0]}" y2="${sa2[1]}" stroke="#d29922" stroke-width="1.5" stroke-dasharray="6,4" opacity="0.7"/>`;
    }
    // Cross-section line (blue)
    if (sc1 && sc2) {
      svg += `<line x1="${sc1[0]}" y1="${sc1[1]}" x2="${sc2[0]}" y2="${sc2[1]}" stroke="#58a6ff" stroke-width="2" opacity="0.8"/>`;
    }
    // Center crosshair (green)
    if (center) {
      const cx = center[0], cy = center[1];
      svg += `<line x1="${cx - 12}" y1="${cy}" x2="${cx + 12}" y2="${cy}" stroke="#3fb950" stroke-width="1.5"/>`;
      svg += `<line x1="${cx}" y1="${cy - 12}" x2="${cx}" y2="${cy + 12}" stroke="#3fb950" stroke-width="1.5"/>`;
    }

    // Render all markers (cusps, ostia) on sagittal — no distance filtering (show all)
    const sagCam = sagVp.getCamera();
    const sagVPNv = sagCam.viewPlaneNormal;
    const sagFP = sagCam.focalPoint;
    for (const m of this.markerPoints) {
      if (!m.label) continue;
      // Only filter if marker is very far from the sagittal plane (>30mm)
      if (sagVPNv && sagFP) {
        const dist = Math.abs(
          (m.point.x - sagFP[0]) * sagVPNv[0] +
          (m.point.y - sagFP[1]) * sagVPNv[1] +
          (m.point.z - sagFP[2]) * sagVPNv[2]
        );
        if (dist > 30) continue;
      }
      const mp = sagVp.worldToCanvas([m.point.x, m.point.y, m.point.z]);
      if (!mp) continue;
      const [mx, my] = mp;
      if (mx < -10 || mx > w + 10 || my < -10 || my > h + 10) continue;
      svg += `<circle cx="${mx}" cy="${my}" r="5" fill="none" stroke="${m.color}" stroke-width="2"/>`;
      svg += `<circle cx="${mx}" cy="${my}" r="2" fill="${m.color}"/>`;
      svg += `<text x="${mx + 8}" y="${my + 4}" fill="${m.color}" font-size="11" font-weight="bold" style="filter:drop-shadow(0 0 2px rgba(0,0,0,0.9))">${m.label}</text>`;
    }

    svg += '</svg>';
    this.sagittalIndicator.innerHTML = svg;
  }

  // ── Orientation labels (R/L/A/P/S/I at viewport edges + angle info) ──
  private orientationIcons: HTMLDivElement[] = [];

  /** Create orientation label containers on each viewport */
  private createOrientationIcons(): void {
    this.removeOrientationIcons();
    const engine = cornerstone.getRenderingEngine(this.renderingEngineId);
    if (!engine) return;

    for (const vpId of [this.leftViewportId, this.rightViewportId]) {
      const vp = engine.getViewport(vpId);
      if (!vp?.element) continue;

      const el = vp.element;
      el.style.position = 'relative';

      const container = document.createElement('div');
      container.className = 'tavi-orientation-labels';
      container.setAttribute('data-viewport', vpId);
      container.style.cssText = `
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: 60;
      `;
      el.appendChild(container);
      this.orientationIcons.push(container);
    }
    this.updateOrientationIcons();
  }

  /** Compute which anatomical direction label goes on which viewport edge */
  private computeEdgeLabels(cam: { viewPlaneNormal: cornerstone.Types.Point3; viewUp: cornerstone.Types.Point3 }): {
    right: string; left: string; top: string; bottom: string;
  } {
    const vpn = cam.viewPlaneNormal;
    const vup = cam.viewUp;

    // In VTK/Cornerstone: viewRight = cross(viewPlaneNormal, viewUp)
    const vRight = TAVIGeometry.vectorNormalize(
      TAVIGeometry.vectorCross(
        { x: vpn[0], y: vpn[1], z: vpn[2] },
        { x: vup[0], y: vup[1], z: vup[2] }
      )
    );
    const vUp = { x: vup[0], y: vup[1], z: vup[2] };

    // DICOM LPS: L=+x, R=-x, P=+y, A=-y, S=+z, I=-z
    const directions = [
      { vec: { x: 1, y: 0, z: 0 }, label: 'L' },
      { vec: { x: -1, y: 0, z: 0 }, label: 'R' },
      { vec: { x: 0, y: 1, z: 0 }, label: 'P' },
      { vec: { x: 0, y: -1, z: 0 }, label: 'A' },
      { vec: { x: 0, y: 0, z: 1 }, label: 'S' },
      { vec: { x: 0, y: 0, z: -1 }, label: 'I' },
    ];

    let right = '', left = '', top = '', bottom = '';
    let rMax = 0, lMax = 0, tMax = 0, bMax = 0;

    for (const d of directions) {
      const projR = TAVIGeometry.vectorDot(d.vec, vRight);
      const projU = TAVIGeometry.vectorDot(d.vec, vUp);
      if (projR > rMax) { rMax = projR; right = d.label; }
      if (-projR > lMax) { lMax = -projR; left = d.label; }
      if (projU > tMax) { tMax = projU; top = d.label; }
      if (-projU > bMax) { bMax = -projU; bottom = d.label; }
    }

    return { right, left, top, bottom };
  }

  /** Update orientation labels at viewport edges */
  private updateOrientationIcons(): void {
    const engine = cornerstone.getRenderingEngine(this.renderingEngineId);
    if (!engine) return;

    // Re-attach containers if they were removed from the DOM
    for (const container of this.orientationIcons) {
      const vpId = container.getAttribute('data-viewport');
      if (!vpId) continue;
      const vp = engine.getViewport(vpId);
      if (vp?.element && !vp.element.contains(container)) {
        vp.element.style.position = 'relative';
        vp.element.appendChild(container);
      }
    }

    for (const container of this.orientationIcons) {
      const vpId = container.getAttribute('data-viewport');
      if (!vpId) continue;
      const isRight = vpId === this.rightViewportId;

      // Read the ACTUAL camera from Cornerstone (not our computed params)
      // so labels match exactly what's rendered on screen
      const vp = engine.getViewport(vpId);
      if (!vp) continue;
      const actualCam = vp.getCamera();
      if (!actualCam.viewPlaneNormal || !actualCam.viewUp) continue;

      const cam = {
        viewPlaneNormal: actualCam.viewPlaneNormal,
        viewUp: actualCam.viewUp,
      };
      const labels = this.computeEdgeLabels(cam);
      const vpn = cam.viewPlaneNormal;

      // Compute viewing angles for the angle label
      const laoRao = Math.atan2(vpn[0], vpn[1]) * 180 / Math.PI;
      const cranCaud = Math.atan2(vpn[2], Math.hypot(vpn[0], vpn[1])) * 180 / Math.PI;
      const lrText = laoRao >= 0 ? `LAO ${Math.abs(laoRao).toFixed(0)}°` : `RAO ${Math.abs(laoRao).toFixed(0)}°`;
      const ccText = cranCaud >= 0 ? `CRA ${Math.abs(cranCaud).toFixed(0)}°` : `CAU ${Math.abs(cranCaud).toFixed(0)}°`;

      const color = isRight ? '#58a6ff' : '#f0883e';
      const labelStyle = `color:${color};font-size:13px;font-weight:bold;font-family:-apple-system,sans-serif;text-shadow:0 0 4px rgba(0,0,0,0.8);`;
      const angleStyle = `color:${color};font-size:10px;font-family:-apple-system,sans-serif;text-shadow:0 0 4px rgba(0,0,0,0.8);opacity:0.8;`;

      container.innerHTML = `
        <span style="position:absolute;right:8px;top:50%;transform:translateY(-50%);${labelStyle}">${labels.right}</span>
        <span style="position:absolute;left:8px;top:50%;transform:translateY(-50%);${labelStyle}">${labels.left}</span>
        <span style="position:absolute;top:8px;left:50%;transform:translateX(-50%);${labelStyle}">${labels.top}</span>
        <span style="position:absolute;bottom:8px;left:50%;transform:translateX(-50%);${labelStyle}">${labels.bottom}</span>
        <span style="position:absolute;bottom:4px;right:4px;${angleStyle}">${lrText} ${ccText}</span>
      `;
    }
  }

  /** Remove orientation labels from DOM */
  private removeOrientationIcons(): void {
    for (const icon of this.orientationIcons) {
      icon.parentElement?.removeChild(icon);
    }
    this.orientationIcons = [];
  }

  // ── Point markers overlay (ostia, cusps, etc.) ──
  private markerOverlay: HTMLDivElement | null = null;
  private markerPoints: { point: TAVIVector3D; label: string; color: string }[] = [];

  /** Measurement lines between two points (e.g., coronary height) */
  private measurementLines: { from: TAVIVector3D; to: TAVIVector3D; label: string; color: string }[] = [];

  /** Set points to be rendered as markers on ALL viewports */
  setMarkerPoints(points: { point: TAVIVector3D; label: string; color: string }[]): void {
    this.markerPoints = points;
    this.updateMarkerOverlay();
    this.updateLeftMarkerOverlay();
    this.updateSagittalOverlay();
  }

  /** Set measurement lines to render between point pairs */
  setMeasurementLines(lines: { from: TAVIVector3D; to: TAVIVector3D; label: string; color: string }[]): void {
    this.measurementLines = lines;
    this.updateMarkerOverlay();
  }

  /** Render marker dots on the working (right) viewport AND reference (left) viewport */
  private updateMarkerOverlay(): void {
    const engine = cornerstone.getRenderingEngine(this.renderingEngineId);
    if (!engine) return;
    const rightVp = engine.getViewport(this.rightViewportId);
    if (!rightVp?.element) return;

    if (!this.markerOverlay) {
      this.markerOverlay = document.createElement('div');
      this.markerOverlay.className = 'tavi-marker-overlay';
      this.markerOverlay.style.cssText = `
        position: absolute; inset: 0;
        pointer-events: none; z-index: 55;
      `;
    }

    const el = rightVp.element;
    if (!el.contains(this.markerOverlay)) {
      el.style.position = 'relative';
      el.appendChild(this.markerOverlay);
    }

    if (this.markerPoints.length === 0) {
      this.markerOverlay.innerHTML = '';
      return;
    }

    const w = el.clientWidth;
    const h = el.clientHeight;
    let svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" style="font-family:-apple-system,sans-serif;">`;

    // Only show markers that are near the current cross-section plane.
    // Use the ACTUAL viewport camera VPN (which includes tilt) for distance filtering,
    // not the original axisDirection. When tilt is applied, the cross-section plane
    // is perpendicular to tiltedAxis, not the original axis.
    const cam = rightVp.getCamera();
    const vpn = cam.viewPlaneNormal;
    const fp = cam.focalPoint;
    // VPN points from focal to camera; slice normal = -VPN for distance calc
    // But for distance we only need abs, so sign doesn't matter
    const sliceNx = vpn ? vpn[0] : 0;
    const sliceNy = vpn ? vpn[1] : 0;
    const sliceNz = vpn ? vpn[2] : 0;
    const fpx = fp ? fp[0] : this.state.axisPoint.x;
    const fpy = fp ? fp[1] : this.state.axisPoint.y;
    const fpz = fp ? fp[2] : this.state.axisPoint.z;

    let visibleCount = 0;
    for (const m of this.markerPoints) {
      // Distance from marker to the actual viewport image plane
      const dist = Math.abs(
        (m.point.x - fpx) * sliceNx +
        (m.point.y - fpy) * sliceNy +
        (m.point.z - fpz) * sliceNz
      );
      if (dist > 5) continue; // Skip markers more than 5mm from current slice

      const cp = rightVp.worldToCanvas([m.point.x, m.point.y, m.point.z]);
      if (!cp) continue;
      const [cx, cy] = cp;
      if (cx < -10 || cx > w + 10 || cy < -10 || cy > h + 10) continue;
      visibleCount++;

      // Marker dot
      svg += `<circle cx="${cx}" cy="${cy}" r="6" fill="none" stroke="${m.color}" stroke-width="2"/>`;
      svg += `<circle cx="${cx}" cy="${cy}" r="2" fill="${m.color}"/>`;
      // Label with shadow
      svg += `<text x="${cx + 10}" y="${cy + 4}" fill="${m.color}" font-size="11" font-weight="bold" style="filter:drop-shadow(0 0 2px rgba(0,0,0,0.9))">${m.label}</text>`;
    }

    // Draw measurement lines (e.g., coronary heights)
    for (const line of this.measurementLines) {
      const cpFrom = rightVp.worldToCanvas([line.from.x, line.from.y, line.from.z]);
      const cpTo = rightVp.worldToCanvas([line.to.x, line.to.y, line.to.z]);
      if (!cpFrom || !cpTo) continue;

      svg += `<line x1="${cpFrom[0]}" y1="${cpFrom[1]}" x2="${cpTo[0]}" y2="${cpTo[1]}" stroke="${line.color}" stroke-width="1.5" stroke-dasharray="4,3"/>`;
      // Label at midpoint
      const mx = (cpFrom[0] + cpTo[0]) / 2 + 8;
      const my = (cpFrom[1] + cpTo[1]) / 2;
      svg += `<text x="${mx}" y="${my}" fill="${line.color}" font-size="10" style="filter:drop-shadow(0 0 2px rgba(0,0,0,0.9))">${line.label}</text>`;
    }

    svg += '</svg>';
    this.markerOverlay.innerHTML = svg;
  }

  // Left viewport marker overlay for cusp hinge points
  private leftMarkerOverlay: HTMLDivElement | null = null;

  /** Render markers on the reference (left) viewport — cusp hinge tick marks */
  private updateLeftMarkerOverlay(): void {
    const engine = cornerstone.getRenderingEngine(this.renderingEngineId);
    if (!engine) return;
    const leftVp = engine.getViewport(this.leftViewportId);
    if (!leftVp?.element) return;

    if (!this.leftMarkerOverlay) {
      this.leftMarkerOverlay = document.createElement('div');
      this.leftMarkerOverlay.className = 'tavi-left-marker-overlay';
      this.leftMarkerOverlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:55;';
    }

    const el = leftVp.element;
    if (!el.contains(this.leftMarkerOverlay)) {
      el.style.position = 'relative';
      el.appendChild(this.leftMarkerOverlay);
    }

    if (this.markerPoints.length === 0) {
      this.leftMarkerOverlay.innerHTML = '';
      return;
    }

    const w = el.clientWidth;
    const h = el.clientHeight;
    let svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" style="font-family:-apple-system,sans-serif;">`;

    // Reference viewport: show markers as tick marks on the right edge
    // These show the position along the axis regardless of slice distance
    // (they indicate height/depth, not cross-section position)
    const leftCam = leftVp.getCamera();
    const leftVPN = leftCam.viewPlaneNormal;
    const leftFP = leftCam.focalPoint;

    for (const m of this.markerPoints) {
      if (!m.label) continue;

      // On the reference viewport, only hide markers very far from the view plane (>30mm)
      if (leftVPN && leftFP) {
        const dist = Math.abs(
          (m.point.x - leftFP[0]) * leftVPN[0] +
          (m.point.y - leftFP[1]) * leftVPN[1] +
          (m.point.z - leftFP[2]) * leftVPN[2]
        );
        if (dist > 30) continue;
      }

      const cp = leftVp.worldToCanvas([m.point.x, m.point.y, m.point.z]);
      if (!cp) continue;
      const [cx, cy] = cp;
      if (cx < -10 || cx > w + 10 || cy < -10 || cy > h + 10) continue;

      // Circle + label at projected position (same style as working viewport)
      svg += `<circle cx="${cx}" cy="${cy}" r="5" fill="none" stroke="${m.color}" stroke-width="2"/>`;
      svg += `<circle cx="${cx}" cy="${cy}" r="2" fill="${m.color}"/>`;
      svg += `<text x="${cx + 8}" y="${cy + 4}" fill="${m.color}" font-size="11" font-weight="bold" style="filter:drop-shadow(0 0 2px rgba(0,0,0,0.9))">${m.label}</text>`;
    }

    // Also draw measurement lines on the reference viewport
    for (const line of this.measurementLines) {
      const cpFrom = leftVp.worldToCanvas([line.from.x, line.from.y, line.from.z]);
      const cpTo = leftVp.worldToCanvas([line.to.x, line.to.y, line.to.z]);
      if (!cpFrom || !cpTo) continue;
      svg += `<line x1="${cpFrom[0]}" y1="${cpFrom[1]}" x2="${cpTo[0]}" y2="${cpTo[1]}" stroke="${line.color}" stroke-width="1" stroke-dasharray="3,2" opacity="0.6"/>`;
    }

    svg += '</svg>';
    this.leftMarkerOverlay.innerHTML = svg;
  }

  private removeMarkerOverlay(): void {
    this.markerOverlay?.parentElement?.removeChild(this.markerOverlay);
    this.markerOverlay = null;
    this.leftMarkerOverlay?.parentElement?.removeChild(this.leftMarkerOverlay);
    this.leftMarkerOverlay = null;
  }

  /** Clean up all resources */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.animationFrameId != null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    this.detachListeners();
    this.removeTargetIndicator();
    this.removeOrientationIcons();
    this.removeMarkerOverlay();
  }
}
