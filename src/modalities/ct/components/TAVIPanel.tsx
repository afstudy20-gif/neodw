import React, { useState, useCallback, useRef, useEffect, useImperativeHandle } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import { setActiveTool, enableProbeTool, disableProbeTool, enterDoubleObliqueMode } from '../core/toolManager';
import {
  TAVIMeasurementSession,
  TAVIStructureAorticAxis,
  TAVIStructureAnnulus,
  TAVIStructureLeftOstium,
  TAVIStructureRightOstium,
  TAVIStructureSinus,
  TAVIStructureSTJ,
  TAVIStructureAscendingAorta,
  TAVIStructureLVOT,
  TAVIStructureSinusPoints,
  TAVIStructureMembranousSeptum,
} from '../tavi/TAVIMeasurementSession';
import { TAVIContourSnapshot, TAVIPointSnapshot, TAVIVector3D, TAVIGeometryResult, TAVIFluoroAngleResult, ACCESS_ROUTES, PIGTAIL_ACCESS_ROUTES } from '../tavi/TAVITypes';
import { recommendValveSizes, assessTAVRRisks, assessBAVRisk, computePacemakerRiskScore, ValveSizeRecommendation } from '../tavi/TAVIValveDatabase';
import { AngioProjectionSimulator } from './AngioProjectionSimulator';
import { PerpendicularityPlot } from './PerpendicularityPlot';
import { TAVIGeometry } from '../tavi/TAVIGeometry';
import { detectAorticAxis, detectAorticAxisLocal, AorticAxisResult, autoSegmentCrossSectionAtPlane } from '../tavi/AorticAxisDetection';
import { DoubleObliqueController } from '../tavi/DoubleObliqueController';
import { ConstrainedContourTool } from '../tavi/ConstrainedContourTool';
import { CenterlineOverlay } from '../tavi/CenterlineOverlay';
import { CuspMarkerOverlay, CuspId } from '../tavi/CuspMarkerOverlay';
import { AnnulusMeasurementOverlay } from '../tavi/AnnulusMeasurementOverlay';
import { CoronaryHeightView } from './CoronaryHeightView';
import { ValveVisualization3D } from './ValveVisualization3D';
import { ContourOverlay } from './ContourOverlay';
import { CuspTriangleOverlay } from './CuspTriangleOverlay';
import type { ViewportMode } from './ViewportGrid';

const VIEWPORT_IDS = ['axial', 'sagittal', 'coronal'];

type StepType = 'contour' | 'point' | 'multi-point';

interface Step {
  id: string;
  label: string;
  type: StepType;
  num: string;
  hint: string;
  optional?: boolean;
}

const steps: Step[] = [
  { id: TAVIStructureAorticAxis, label: 'Aortic Axis', type: 'multi-point', num: '0', hint: 'Scroll to LVOT-aorta junction. Axis is computed from cusp hinge points.' },
  { id: TAVIStructureSTJ, label: 'Sino-Tubular Junction', type: 'contour', num: '1', hint: 'Measure long/short axis diameters at the STJ. A narrow STJ increases aortic dissection risk during deployment.' },
  { id: TAVIStructureSinus, label: 'Sinus of Valsalva', type: 'contour', num: '2', hint: 'Draw sinus contour. Calculate width and height for each sinus.' },
  { id: TAVIStructureRightOstium, label: 'Right Coronary Ostium', type: 'point', num: '3', hint: 'Click the right coronary ostium. Evaluate sinus width relative to valve expansion.' },
  { id: TAVIStructureLeftOstium, label: 'Left Coronary Ostium', type: 'point', num: '4', hint: 'Click the left main coronary ostium. Height <10mm = high obstruction risk.' },
  { id: TAVIStructureAnnulus, label: 'Annulus', type: 'contour', num: '5', hint: 'Trace outer annulus line after cusp definition. Bisect calcium nodules for representative dimensions.' },
  { id: TAVIStructureLVOT, label: 'LVOT', type: 'contour', num: '6', hint: 'Trace LVOT contour 3-5mm below the annulus. Assess sub-annular landing zone and calcium struts.' },
  { id: TAVIStructureAscendingAorta, label: 'Ascending Aorta', type: 'contour', num: '7', hint: 'Draw contour on perpendicular MPR plane in ascending aorta.' },
  { id: TAVIStructureMembranousSeptum, label: 'Membranous Septum', type: 'multi-point', num: '8', hint: 'In coronal view: click base of NCC then where muscular septum begins. Predicts post-procedural heart block risk.', optional: true },
  { id: TAVIStructureSinusPoints, label: 'Sinus Points', type: 'multi-point', num: '9', hint: 'Click 3+ sinus points to confirm the C-arm projection angle.', optional: true },
];

// ── Utility ──

function fmt(val: number | null | undefined, d = 1): string {
  if (val == null) return '—';
  return val.toFixed(d);
}

function ecc(geo: TAVIGeometryResult): number {
  return geo.maximumDiameterMm > 0 ? 1 - (geo.minimumDiameterMm / geo.maximumDiameterMm) : 0;
}

function dPerim(p: number): number { return p / Math.PI; }
function dArea(a: number): number { return 2 * Math.sqrt(a / Math.PI); }

function angleStr(a: TAVIFluoroAngleResult): string {
  return `${a.laoRaoLabel} ${fmt(a.laoRaoDegrees, 0)}° / ${a.cranialCaudalLabel} ${fmt(a.cranialCaudalDegrees, 0)}°`;
}

function riskBadge(level: 'low' | 'moderate' | 'high'): string {
  if (level === 'high') return '🔴';
  if (level === 'moderate') return '🟡';
  return '🟢';
}

// ── Component ──

export interface TAVIPanelHandle {
  setViewingAngle: (laoRaoDeg: number, cranCaudDeg: number) => void;
  resetAll: () => void;
  showReport: () => void;
  showCapture: () => void;
}

interface TAVIPanelProps {
  renderingEngineId: string;
  volumeId: string;
  viewportMode: ViewportMode;
  onViewportModeChange: (mode: ViewportMode) => void;
  panelRef?: React.Ref<TAVIPanelHandle>;
  onReportToggle?: (isReport: boolean) => void;
}

type TAVIWorkflowPhase = 'legacy' | 'axis-detection' | 'axis-validation' | 'centerline-review' | 'cusp-definition' | 'annulus-tracing' | 'coronary-heights' | 'report';

export const TAVIPanel: React.FC<TAVIPanelProps> = ({
  renderingEngineId,
  volumeId,
  viewportMode,
  onViewportModeChange,
  panelRef,
  onReportToggle,
}) => {
  const [session] = useState(() => new TAVIMeasurementSession());
  const [refresh, setRefresh] = useState(0);
  const [activeStep, setActiveStep] = useState<string>(TAVIStructureAorticAxis);
  const [drawingActive, setDrawingActive] = useState(false);
  const [multiPoints, setMultiPoints] = useState<TAVIPointSnapshot[]>([]);
  const [activeTab, setActiveTab] = useState<'capture' | 'report'>('capture');
  const [deploymentRatio, setDeploymentRatio] = useState<'80/20' | '90/10'>('80/20');

  // ProSizeAV-style workflow state — default to axis-validation (ProSize-Style)
  const [workflowPhase, setWorkflowPhase] = useState<TAVIWorkflowPhase>('axis-validation');
  const [axisResult, setAxisResult] = useState<AorticAxisResult | null>(null);
  const [axisDetecting, setAxisDetecting] = useState(false);
  const [axisError, setAxisError] = useState<string | null>(null);
  const controllerRef = useRef<DoubleObliqueController | null>(null);

  // Ref to hold the reset function (defined later) so useImperativeHandle can access it
  const resetAllRef = useRef<(() => void) | null>(null);

  // Expose methods to parent via ref
  useImperativeHandle(panelRef, () => ({
    setViewingAngle: (laoRaoDeg: number, cranCaudDeg: number) => {
      controllerRef.current?.setViewingAngle(laoRaoDeg, cranCaudDeg);
    },
    resetAll: () => {
      resetAllRef.current?.();
    },
    showReport: () => {
      setActiveTab('report');
    },
    showCapture: () => {
      setActiveTab('capture');
    },
  }), []);

  // Cusp definition state
  type CuspStep = 'lcc' | 'ncc' | 'rcc' | 'verify';
  const [cuspStep, setCuspStep] = useState<CuspStep>('lcc');
  const [cuspPoints, setCuspPoints] = useState<{ lcc?: TAVIVector3D; ncc?: TAVIVector3D; rcc?: TAVIVector3D }>({});
  const [cuspRotating, setCuspRotating] = useState(false);
  // Two-step cusp capture: 'idle' → user clicks Place → 'placed' → user clicks Confirm → saves
  const [cuspPlaced, setCuspPlaced] = useState(false);

  // Save controller state before cusp definition so we can restore on reset
  const preCuspStateRef = useRef<{ axisPoint: TAVIVector3D; axisDirection: TAVIVector3D; rotationAngle: number; tiltAngle: number } | null>(null);

  // Toggle MIP on/off for precise landmark placement vs overview.
  // keepSagittalMIP: during cusp definition, sagittal stays MIP for orientation
  const setMIPMode = useCallback((enabled: boolean, keepSagittalMIP = false) => {
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    if (!engine) return;
    for (const vpId of ['axial', 'sagittal', 'coronal']) {
      const vp = engine.getViewport(vpId) as cornerstone.Types.IVolumeViewport | undefined;
      if (!vp || !('setBlendMode' in vp)) continue;

      // Sagittal keeps MIP if requested (for cusp orientation)
      const useMIP = enabled || (keepSagittalMIP && vpId === 'sagittal');

      if (useMIP) {
        (vp as any).setBlendMode(cornerstone.Enums.BlendModes.MAXIMUM_INTENSITY_BLEND);
        (vp as any).setSlabThickness(vpId === 'sagittal' ? 10 : 5); // sagittal thicker slab for better overview
      } else {
        (vp as any).setBlendMode(cornerstone.Enums.BlendModes.COMPOSITE);
        (vp as any).resetSlabThickness?.();
      }
      vp.render();
    }
  }, [renderingEngineId]);

  // Constrained contour tracing state
  const contourToolRef = useRef<ConstrainedContourTool | null>(null);
  const [contourPointCount, setContourPointCount] = useState(0);
  const [contourClosed, setContourClosed] = useState(false);
  const [contourStarted, setContourStarted] = useState(false);
  const [contourVersion, setContourVersion] = useState(0); // increments when points change (drag)

  // Coronary heights state
  type CoronaryStep = 'navigate-lca' | 'capture-lca' | 'navigate-rca' | 'capture-rca' | 'multi-level' | 'done';
  const [coronaryStep, setCoronaryStep] = useState<CoronaryStep>('navigate-lca');
  const [multiLevelGenerating, setMultiLevelGenerating] = useState(false);
  const [multiLevelThumbnails, setMultiLevelThumbnails] = useState<Map<number, string>>(new Map());

  // Auto-detect contour state
  const [autoDetecting, setAutoDetecting] = useState(false);
  const [autoDetectError, setAutoDetectError] = useState<string | null>(null);

  // Active contour overlay: which structure's contour is currently shown for editing
  const [activeContourId, setActiveContourId] = useState<string | null>(null);

  // NC cusp guide: 3 points on axial defining the NC region (visual guide only, not stored in session)
  const [ncGuidePoints, setNcGuidePoints] = useState<TAVIVector3D[]>([]);

  // Overlay refs (3mensio-style)
  const centerlineRef = useRef<CenterlineOverlay | null>(null);
  const cuspMarkerRef = useRef<CuspMarkerOverlay | null>(null);
  const measurementRef = useRef<AnnulusMeasurementOverlay | null>(null);

  const forceUpdate = () => setRefresh((prev) => prev + 1);
  const currentStep = steps.find(s => s.id === activeStep)!;

  const getEngine = () => {
    return cornerstone.getRenderingEngine(renderingEngineId) ?? undefined;
  };

  // ── Sync captured points as visual markers on viewports ──
  const markerOverlayRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const markers: { point: TAVIVector3D; label: string; color: string }[] = [];

    // Cusp nadirs
    if (session.cuspLCC) markers.push({ point: session.cuspLCC, label: 'LCH', color: '#f85149' });
    if (session.cuspNCC) markers.push({ point: session.cuspNCC, label: 'NCH', color: '#d29922' });
    if (session.cuspRCC) markers.push({ point: session.cuspRCC, label: 'RCH', color: '#3fb950' });

    // Coronary ostia
    if (session.leftOstiumSnapshot) markers.push({ point: session.leftOstiumSnapshot.worldPoint, label: 'LCO', color: '#ff6b6b' });
    if (session.rightOstiumSnapshot) markers.push({ point: session.rightOstiumSnapshot.worldPoint, label: 'RCO', color: '#ff6b6b' });

    // Annulus centroid
    if (session.annulusPlaneCentroid) markers.push({ point: session.annulusPlaneCentroid, label: '', color: 'rgba(88,166,255,0.5)' });

    // If double-oblique controller is active, use its marker system
    if (controllerRef.current) {
      controllerRef.current.setMarkerPoints(markers);

      // Coronary height measurement lines (from ostium to its projection on the annulus plane)
      const annulus = session.activeAnnulusGeometry();
      const lines: { from: TAVIVector3D; to: TAVIVector3D; label: string; color: string }[] = [];
      if (annulus && session.leftOstiumSnapshot) {
        const projected = TAVIGeometry.projectPointOntoPlane(
          session.leftOstiumSnapshot.worldPoint, annulus.centroid, annulus.planeNormal
        );
        const h = session.leftCoronaryHeightMm;
        lines.push({ from: session.leftOstiumSnapshot.worldPoint, to: projected, label: h != null ? `${h.toFixed(1)}mm` : '', color: '#ff6b6b' });
      }
      if (annulus && session.rightOstiumSnapshot) {
        const projected = TAVIGeometry.projectPointOntoPlane(
          session.rightOstiumSnapshot.worldPoint, annulus.centroid, annulus.planeNormal
        );
        const h = session.rightCoronaryHeightMm;
        lines.push({ from: session.rightOstiumSnapshot.worldPoint, to: projected, label: h != null ? `${h.toFixed(1)}mm` : '', color: '#ff6b6b' });
      }
      controllerRef.current.setMeasurementLines(lines);
      return;
    }

    // Don't render MPR markers when report tab is active
    if (activeTab === 'report') {
      return;
    }

    // Otherwise render markers on all visible MPR viewports
    if (markers.length === 0) {
      if (markerOverlayRef.current) markerOverlayRef.current.innerHTML = '';
      return;
    }

    const engine = getEngine();
    if (!engine) return;

    // Render on all MPR viewports
    for (const vpId of ['axial', 'sagittal', 'coronal']) {
      const vp = engine.getViewport(vpId);
      if (!vp?.element) continue;

      let overlay = vp.element.querySelector('.tavi-point-markers') as HTMLDivElement;
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'tavi-point-markers';
        overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:55;';
        vp.element.style.position = 'relative';
        vp.element.appendChild(overlay);
      }

      const w = vp.element.clientWidth;
      const h = vp.element.clientHeight;
      let svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" style="font-family:-apple-system,sans-serif;">`;

      for (const m of markers) {
        const cp = vp.worldToCanvas([m.point.x, m.point.y, m.point.z]);
        if (!cp) continue;
        const [cx, cy] = cp;
        if (cx < -10 || cx > w + 10 || cy < -10 || cy > h + 10) continue;
        svg += `<circle cx="${cx}" cy="${cy}" r="5" fill="none" stroke="${m.color}" stroke-width="2"/>`;
        svg += `<circle cx="${cx}" cy="${cy}" r="1.5" fill="${m.color}"/>`;
        if (m.label) svg += `<text x="${cx + 8}" y="${cy + 4}" fill="${m.color}" font-size="10" font-weight="bold">${m.label}</text>`;
      }

      svg += '</svg>';
      overlay.innerHTML = svg;
    }

    // Re-render markers when camera changes (zoom/pan/scroll)
    const redrawMarkers = () => forceUpdate();
    const cameraEvent = cornerstone.Enums.Events.CAMERA_MODIFIED;
    for (const vpId of ['axial', 'sagittal', 'coronal']) {
      const vp = engine.getViewport(vpId);
      if (vp?.element) vp.element.addEventListener(cameraEvent, redrawMarkers);
    }

    return () => {
      // Clean up overlays and event listeners
      const eng = getEngine();
      if (!eng) return;
      for (const vpId of ['axial', 'sagittal', 'coronal']) {
        const vp = eng.getViewport(vpId);
        if (vp?.element) {
          vp.element.removeEventListener(cameraEvent, redrawMarkers);
          const overlay = vp.element.querySelector('.tavi-point-markers');
          if (overlay) overlay.innerHTML = '';
        }
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, viewportMode, refresh]);

  // ── ProSizeAV-style Axis Detection ──

  const startAutoAxisDetection = useCallback(() => {
    setAxisDetecting(true);
    setAxisError(null);

    // Run axis detection asynchronously to avoid blocking UI
    requestAnimationFrame(() => {
      try {
        const volume = cornerstone.cache.getVolume(volumeId);
        if (!volume) {
          setAxisError('No volume loaded');
          setAxisDetecting(false);
          return;
        }

        const result = detectAorticAxis(volume);
        if (!result) {
          setAxisError('Auto-detection failed. Use manual axis placement or adjust HU range.');
          setAxisDetecting(false);
          return;
        }

        setAxisResult(result);

        // Save axis to session
        const halfLen = 25;
        const p0 = TAVIGeometry.vectorAdd(result.centerPoint, TAVIGeometry.vectorScale(result.axisDirection, -halfLen));
        const p1 = TAVIGeometry.vectorAdd(result.centerPoint, TAVIGeometry.vectorScale(result.axisDirection, halfLen));
        session.capturePointSnapshots(
          [{ worldPoint: p0 }, { worldPoint: p1 }],
          TAVIStructureAorticAxis
        );

        // Switch to double-oblique viewport mode
        onViewportModeChange('tavi-oblique');

        // Initialize the double-oblique controller
        setTimeout(() => {
          enterDoubleObliqueMode(renderingEngineId);
          const controller = new DoubleObliqueController(
            renderingEngineId,
            'axial',     // LEFT = reference plane
            'coronal'    // RIGHT = working plane
          );
          controller.initialize(result.centerPoint, result.axisDirection);
          controllerRef.current = controller;

          // Skip centerline-review: go directly to cusp definition (like ProSizeAV/3mensio)
          // Save controller state for cusp reset
          const state = controller.getState();
          preCuspStateRef.current = {
            axisPoint: { ...state.axisPoint },
            axisDirection: { ...state.axisDirection },
            rotationAngle: state.rotationAngle,
            tiltAngle: state.tiltAngle,
          };
          controller.prepareForCuspDefinition();
          enableProbeTool();

          setWorkflowPhase('cusp-definition');
          setCuspStep('lcc');
          setCuspPoints({});
          setAxisDetecting(false);
        }, 200); // Wait for viewport layout to settle
      } catch (err: any) {
        setAxisError(`Detection error: ${err.message}`);
        setAxisDetecting(false);
      }
    });
  }, [renderingEngineId, volumeId, onViewportModeChange]);

  const validateAxis = useCallback(() => {
    const controller = controllerRef.current;
    if (!controller) return;

    const state = controller.getState();
    // Save axis to session as if 2 points were placed
    const axisLength = 50; // approximate mm
    const p0 = {
      x: state.axisPoint.x - state.axisDirection.x * axisLength / 2,
      y: state.axisPoint.y - state.axisDirection.y * axisLength / 2,
      z: state.axisPoint.z - state.axisDirection.z * axisLength / 2,
    };
    const p1 = {
      x: state.axisPoint.x + state.axisDirection.x * axisLength / 2,
      y: state.axisPoint.y + state.axisDirection.y * axisLength / 2,
      z: state.axisPoint.z + state.axisDirection.z * axisLength / 2,
    };

    session.capturePointSnapshots(
      [{ worldPoint: p0 }, { worldPoint: p1 }],
      TAVIStructureAorticAxis
    );

    // Go directly to cusp definition (like ProSizeAV)
    preCuspStateRef.current = {
      axisPoint: { ...state.axisPoint },
      axisDirection: { ...state.axisDirection },
      rotationAngle: state.rotationAngle,
      tiltAngle: state.tiltAngle,
    };
    controller.prepareForCuspDefinition();
    enableProbeTool();
    setWorkflowPhase('cusp-definition');
    setCuspStep('lcc');
    setCuspPoints({});
    forceUpdate();
  }, [session]);

  const exitTaviOblique = useCallback(() => {
    controllerRef.current?.dispose();
    controllerRef.current = null;
    onViewportModeChange('standard');
    setWorkflowPhase('legacy');
    setAxisResult(null);
    setAxisError(null);
    setCuspStep('lcc');
    setCuspPoints({});
  }, [onViewportModeChange]);

  /** Confirm the centerline and proceed to cusp definition */
  const confirmCenterline = useCallback(() => {
    // Save controller state so we can restore on cusp reset
    const controller = controllerRef.current;
    if (controller) {
      const state = controller.getState();
      preCuspStateRef.current = {
        axisPoint: { ...state.axisPoint },
        axisDirection: { ...state.axisDirection },
        rotationAngle: state.rotationAngle,
        tiltAngle: state.tiltAngle,
      };
      // Zoom in for cusp identification
      controller.prepareForCuspDefinition();
    }

    // Enable probe tool for cusp clicking
    enableProbeTool();
    setWorkflowPhase('cusp-definition');
    setCuspStep('lcc');
    setCuspPoints({});
    forceUpdate();
  }, []);

  // ── Cusp Definition (Phase 2) ──

  /** Capture a cusp point from the latest Probe annotation in EITHER viewport.
   *  Cusp hinge points can be identified in the reference (longitudinal) view
   *  where the cusp nadir is visible in profile, or in the working (cross-section) view. */
  const captureCuspPoint = useCallback(() => {
    const engine = getEngine();
    if (!engine) return;

    // Look for probe annotations in BOTH viewports — reference first (preferred for cusp nadirs),
    // then working viewport
    let ann: any = null;
    for (const vpId of ['axial', 'coronal', 'sagittal']) {
      const vp = engine.getViewport(vpId);
      if (!vp?.element) continue;
      const probes = cornerstoneTools.annotation.state.getAnnotations('Probe', vp.element);
      if (probes && probes.length > 0) {
        ann = probes[probes.length - 1];
        break;
      }
    }
    if (!ann) return;

    const p = ann.data.handles.points[0];
    const worldPoint: TAVIVector3D = { x: p[0], y: p[1], z: p[2] };

    // Remove the annotation after capturing
    cornerstoneTools.annotation.state.removeAnnotation(ann.annotationUID);

    const controller = controllerRef.current;

    if (cuspStep === 'lcc') {
      setCuspPoints(prev => ({ ...prev, lcc: worldPoint }));
      setCuspStep('ncc');
      // Auto-rotate 120° to expected NCC location
      if (controller) {
        setCuspRotating(true);
        controller.rotateAroundAxis(120, 500).then(() => setCuspRotating(false));
      }
    } else if (cuspStep === 'ncc') {
      setCuspPoints(prev => ({ ...prev, ncc: worldPoint }));
      setCuspStep('rcc');
      // Auto-rotate another 120° to expected RCC location
      if (controller) {
        setCuspRotating(true);
        controller.rotateAroundAxis(120, 500).then(() => setCuspRotating(false));
      }
    } else if (cuspStep === 'rcc') {
      const updated = { ...cuspPoints, rcc: worldPoint };
      setCuspPoints(updated);

      // Compute the annulus plane from 3 cusp points
      if (updated.lcc && updated.ncc) {
        const success = session.captureThreePointAnnulusPlane(
          updated.lcc, updated.ncc, worldPoint
        );

        if (success && controller && session.annulusPlaneNormal && session.annulusPlaneCentroid) {
          // Align view to the annulus plane for verification
          controller.alignToPlane(session.annulusPlaneNormal, session.annulusPlaneCentroid);
          setCuspStep('verify');
        }
      }
    }

    forceUpdate();
  }, [cuspStep, cuspPoints, session]);

  /** Go back to annulus tracing with existing points loaded for editing */
  const editAnnulus = useCallback(() => {
    setWorkflowPhase('annulus-tracing');
    controllerRef.current?.lockScrolling();
    // Re-align to annulus plane
    if (session.annulusPlaneNormal && session.annulusPlaneCentroid) {
      controllerRef.current?.alignToPlane(session.annulusPlaneNormal, session.annulusPlaneCentroid);
    }
    // Load existing raw contour points into the tool (initContourTool will be called by the useEffect)
    // We set closed=true and pointCount so the UI shows the editing state
    if (session.annulusRawContourPoints.length > 0) {
      setContourClosed(true);
      setContourPointCount(session.annulusRawContourPoints.length);
    } else {
      setContourClosed(false);
      setContourPointCount(0);
    }
    forceUpdate();
  }, [session]);

  /** Confirm the annulus plane and proceed to annulus tracing */
  const confirmAnnulusPlane = useCallback(() => {
    disableProbeTool();
    setWorkflowPhase('annulus-tracing');
    // Lock scrolling so user can't leave the plane during tracing
    controllerRef.current?.lockScrolling();
    forceUpdate();
  }, []);

  /** Re-pick cusps (reset cusp state and restore view to pre-cusp state) */
  const resetCusps = useCallback(() => {
    setCuspStep('lcc');
    setCuspPoints({});
    session.cuspLCC = undefined;
    session.cuspNCC = undefined;
    session.cuspRCC = undefined;
    session.annulusPlaneNormal = undefined;
    session.annulusPlaneCentroid = undefined;

    // Restore controller state to pre-cusp-definition position
    const controller = controllerRef.current;
    if (controller && preCuspStateRef.current) {
      controller.restoreState(preCuspStateRef.current);
      controller.prepareForCuspDefinition();
    }

    // Re-enable probe tool for clicking
    enableProbeTool();
    forceUpdate();
  }, [session]);

  // ── Constrained Contour Tracing (Phase 3) ──

  /** Initialize the constrained contour tool on the working viewport */
  const initContourTool = useCallback(() => {
    const engine = getEngine();
    if (!engine || !session.annulusPlaneNormal || !session.annulusPlaneCentroid) return;

    // Working viewport is 'coronal' in tavi-oblique mode
    const workingVp = engine.getViewport('coronal');
    if (!workingVp) return;

    // Clean up any existing contour tool
    contourToolRef.current?.disable();

    const tool = new ConstrainedContourTool(
      workingVp,
      session.annulusPlaneNormal,
      session.annulusPlaneCentroid
    );
    tool.enable();
    contourToolRef.current = tool;
    setContourPointCount(0);
    setContourClosed(false);
  }, [session, renderingEngineId]);

  /** Poll for Probe annotations during cusp definition — auto-detect when user places a point */
  useEffect(() => {
    if (workflowPhase !== 'cusp-definition' || cuspPlaced) return;

    const engine = getEngine();
    if (!engine) return;

    const interval = setInterval(() => {
      for (const vpId of ['axial', 'coronal', 'sagittal']) {
        const vp = engine.getViewport(vpId);
        if (!vp?.element) continue;
        const probes = cornerstoneTools.annotation.state.getAnnotations('Probe', vp.element);
        if (probes && probes.length > 0) {
          setCuspPlaced(true);
          break;
        }
      }
    }, 200);

    return () => clearInterval(interval);
  }, [workflowPhase, cuspPlaced, renderingEngineId]);

  /** Poll the contour tool for point count updates */
  useEffect(() => {
    if (workflowPhase !== 'annulus-tracing') return;

    // Initialize the contour tool when entering this phase
    initContourTool();

    // If editing existing annulus, load the raw contour points
    if (session.annulusRawContourPoints.length > 0 && contourToolRef.current) {
      contourToolRef.current.loadPoints(session.annulusRawContourPoints);
      setContourClosed(true);
      setContourPointCount(session.annulusRawContourPoints.length);
    }

    let lastPointHash = '';
    const interval = setInterval(() => {
      const tool = contourToolRef.current;
      if (tool) {
        setContourPointCount(tool.getPointCount());
        setContourClosed(tool.isClosed());
        // Detect point dragging: hash first point's coords to detect changes
        if (tool.isClosed()) {
          const pts = tool.getWorldPoints();
          if (pts.length > 0) {
            const p = pts[0];
            const hash = `${p.x.toFixed(1)}_${p.y.toFixed(1)}_${p.z.toFixed(1)}_${pts.length}`;
            if (hash !== lastPointHash) {
              lastPointHash = hash;
              setContourVersion(v => v + 1);
            }
          }
        }
      }
    }, 200);

    return () => {
      clearInterval(interval);
      contourToolRef.current?.disable();
      contourToolRef.current = null;
    };
  }, [workflowPhase, initContourTool]);

  /** Close the contour ring */
  const closeContour = useCallback(() => {
    contourToolRef.current?.closeContour();
    setContourClosed(true);
  }, []);

  /** Undo last contour point */
  const undoContourPoint = useCallback(() => {
    contourToolRef.current?.undoLastPoint();
    setContourPointCount(contourToolRef.current?.getPointCount() ?? 0);
  }, []);

  /** Clear all contour points */
  const clearContour = useCallback(() => {
    contourToolRef.current?.clearPoints();
    setContourPointCount(0);
    setContourClosed(false);
    setContourStarted(false);
  }, []);

  /** Confirm annulus contour and compute geometry */
  const confirmAnnulusContour = useCallback(() => {
    const tool = contourToolRef.current;
    if (!tool || !session.annulusPlaneNormal) return;

    const worldPoints = tool.getWorldPoints();
    if (worldPoints.length < 3) return;

    session.captureConstrainedAnnulusContour(
      worldPoints,
      session.annulusPlaneNormal,
      true // smooth via spline
    );

    // Clean up contour tool
    tool.disable();
    contourToolRef.current = null;

    // Unlock scrolling
    controllerRef.current?.unlockScrolling();

    // If coronary ostia were already captured (before cusp definition), skip coronary phase
    if (session.leftOstiumSnapshot && session.rightOstiumSnapshot) {
      setWorkflowPhase('coronary-heights');
      setCoronaryStep('multi-level');
    } else {
      setWorkflowPhase('coronary-heights');
    }
    forceUpdate();
  }, [session]);

  // ── Coronary Heights + Multi-Level (Phase 4) ──

  /** Auto-navigate to estimated coronary position when entering coronary phase */
  useEffect(() => {
    if (workflowPhase !== 'coronary-heights') return;

    // Skip if coronary ostia already captured (e.g., defined before cusp definition)
    if (session.leftOstiumSnapshot && session.rightOstiumSnapshot) return;

    const controller = controllerRef.current;
    const centroid = session.annulusPlaneCentroid;
    if (!controller || !centroid) return;

    // Enable probe tool for clicking
    enableProbeTool();

    // Navigate to estimated LCA position
    controller.navigateToEstimatedCoronaryPosition('left', centroid);
    setCoronaryStep('capture-lca');
  }, [workflowPhase, session]);

  /** Capture coronary ostium from the working viewport */
  const captureCoronaryPoint = useCallback((side: 'left' | 'right') => {
    const engine = getEngine();
    if (!engine) return;

    // Search for Probe annotations across all visible viewports
    // In tavi-oblique mode: 'coronal' (working) and 'axial' (reference)
    // In tavi-crosshair mode: 'axial', 'sagittal', 'coronal'
    // Find the most recent probe annotation
    let ann: any = null;
    for (const vpId of ['coronal', 'sagittal', 'axial']) {
      const vp = engine.getViewport(vpId);
      if (!vp?.element) continue;
      const probes = cornerstoneTools.annotation.state.getAnnotations('Probe', vp.element);
      if (probes && probes.length > 0) {
        ann = probes[probes.length - 1];
        break;
      }
    }
    if (!ann) return;

    const p = ann.data.handles.points[0];
    const worldPoint: TAVIVector3D = { x: p[0], y: p[1], z: p[2] };
    console.log(`[TAVI] captureCoronaryPoint(${side}): world=(${p[0].toFixed(1)}, ${p[1].toFixed(1)}, ${p[2].toFixed(1)})`);

    // Remove ALL probe annotations from ALL viewports (clean up duplicates)
    for (const vpId of ['coronal', 'sagittal', 'axial']) {
      const vp = engine.getViewport(vpId);
      if (!vp?.element) continue;
      const probes = cornerstoneTools.annotation.state.getAnnotations('Probe', vp.element);
      if (probes) {
        for (const probe of [...probes]) {
          if (probe.annotationUID) cornerstoneTools.annotation.state.removeAnnotation(probe.annotationUID);
        }
      }
    }

    const identifier = side === 'left' ? TAVIStructureLeftOstium : TAVIStructureRightOstium;
    session.capturePointSnapshot({ worldPoint }, identifier);
    forceUpdate();

    const controller = controllerRef.current;
    const centroid = session.annulusPlaneCentroid;

    if (side === 'left' && controller && centroid) {
      // Navigate to RCA position
      controller.navigateToEstimatedCoronaryPosition('right', centroid);
      setCoronaryStep('capture-rca');
    } else if (side === 'right') {
      setCoronaryStep('multi-level');
    }
  }, [session, renderingEngineId]);

  /** Capture a cusp hinge point from standard MPR views (before double-oblique mode) */
  const captureCuspFromMPR = useCallback((cusp: 'lcc' | 'ncc' | 'rcc') => {
    const engine = getEngine();
    if (!engine) return;

    // Find most recent probe annotation
    let ann: any = null;
    for (const vpId of ['coronal', 'sagittal', 'axial']) {
      const vp = engine.getViewport(vpId);
      if (!vp?.element) continue;
      const probes = cornerstoneTools.annotation.state.getAnnotations('Probe', vp.element);
      if (probes && probes.length > 0) {
        ann = probes[probes.length - 1];
        break;
      }
    }
    if (!ann) return;

    const p = ann.data.handles.points[0];
    const worldPoint: TAVIVector3D = { x: p[0], y: p[1], z: p[2] };

    // Remove ALL probe annotations
    for (const vpId of ['coronal', 'sagittal', 'axial']) {
      const vp = engine.getViewport(vpId);
      if (!vp?.element) continue;
      const probes = cornerstoneTools.annotation.state.getAnnotations('Probe', vp.element);
      if (probes) {
        for (const probe of [...probes]) {
          if (probe.annotationUID) cornerstoneTools.annotation.state.removeAnnotation(probe.annotationUID);
        }
      }
    }

    // Save to session and local state
    if (cusp === 'lcc') { session.cuspLCC = worldPoint; setCuspPoints(prev => ({ ...prev, lcc: worldPoint })); }
    if (cusp === 'ncc') { session.cuspNCC = worldPoint; setCuspPoints(prev => ({ ...prev, ncc: worldPoint })); }
    if (cusp === 'rcc') { session.cuspRCC = worldPoint; setCuspPoints(prev => ({ ...prev, rcc: worldPoint })); }

    session.recompute();
    forceUpdate();
    console.log(`[TAVI] captureCuspFromMPR(${cusp}): world=(${p[0].toFixed(1)}, ${p[1].toFixed(1)}, ${p[2].toFixed(1)})`);
  }, [session]);

  /** Auto-capture NC guide points: poll for Probe annotations when NC guide is active */
  const ncGuidePointsRef = useRef<TAVIVector3D[]>([]);
  ncGuidePointsRef.current = ncGuidePoints;

  useEffect(() => {
    if (workflowPhase !== 'axis-validation') return;
    if (ncGuidePointsRef.current.length >= 3) return;

    const engine = getEngine();
    if (!engine) return;

    const interval = setInterval(() => {
      if (ncGuidePointsRef.current.length >= 3) return;

      for (const vpId of ['axial', 'coronal', 'sagittal']) {
        const vp = engine.getViewport(vpId);
        if (!vp?.element) continue;
        const probes = cornerstoneTools.annotation.state.getAnnotations('Probe', vp.element);
        if (probes && probes.length > 0) {
          const ann = probes[probes.length - 1];
          const p = ann.data.handles.points[0];
          const wp: TAVIVector3D = { x: p[0], y: p[1], z: p[2] };

          // Remove all probes
          for (const vid of ['axial', 'coronal', 'sagittal']) {
            const v = engine.getViewport(vid);
            if (!v?.element) continue;
            const prs = cornerstoneTools.annotation.state.getAnnotations('Probe', v.element);
            if (prs) prs.forEach((pr: any) => { if (pr.annotationUID) cornerstoneTools.annotation.state.removeAnnotation(pr.annotationUID); });
          }

          setNcGuidePoints(prev => {
            if (prev.length >= 3) return prev;
            return [...prev, wp];
          });
          forceUpdate();
          break;
        }
      }
    }, 200);

    return () => clearInterval(interval);
  }, [workflowPhase, ncGuidePoints.length]);

  /** Generate multi-level cross-section thumbnails */
  const generateMultiLevel = useCallback(async () => {
    const controller = controllerRef.current;
    const centroid = session.annulusPlaneCentroid;
    if (!controller || !centroid) return;

    setMultiLevelGenerating(true);

    const distances = [-15, -10, -5, 0, 5, 10, 15];
    const thumbnails = await controller.generateMultiLevelThumbnails(centroid, distances);

    session.multiLevelThumbnails = thumbnails;
    setMultiLevelThumbnails(new Map(thumbnails));
    setMultiLevelGenerating(false);
    setCoronaryStep('done');
    forceUpdate();
  }, [session]);

  /** Finish coronary phase and switch to report or legacy */
  const finishCoronaryPhase = useCallback(() => {
    disableProbeTool();
    controllerRef.current?.unlockScrolling();
    setWorkflowPhase('legacy');
    setActiveTab('report');
    forceUpdate();
  }, []);

  // Cleanup controller + overlays on unmount
  useEffect(() => {
    return () => {
      controllerRef.current?.dispose();
      controllerRef.current = null;
      contourToolRef.current?.disable();
      contourToolRef.current = null;
      centerlineRef.current?.disable();
      centerlineRef.current = null;
      cuspMarkerRef.current?.disable();
      cuspMarkerRef.current = null;
      measurementRef.current?.disable();
      measurementRef.current = null;
    };
  }, []);

  // ── Centerline overlay: show during axis-validation on all 4 viewports ──
  useEffect(() => {
    if (workflowPhase !== 'axis-validation' && workflowPhase !== 'centerline-review') {
      centerlineRef.current?.disable();
      centerlineRef.current = null;
      return;
    }

    // Give viewport DOM time to settle
    const timer = setTimeout(() => {
      const overlay = new CenterlineOverlay(renderingEngineId);
      const vpIds = viewportMode === 'tavi-oblique'
        ? ['axial', 'coronal']
        : ['axial', 'sagittal', 'coronal', 'volume3d'];

      // Auto-detect initial centerline points from axis result or crosshair focal
      let initialPoints: TAVIVector3D[] | undefined;
      if (axisResult) {
        const halfLen = 25;
        const dir = axisResult.axisDirection;
        const ctr = axisResult.centerPoint;
        initialPoints = [
          { x: ctr.x - dir.x * halfLen, y: ctr.y - dir.y * halfLen, z: ctr.z - dir.z * halfLen },
          { x: ctr.x, y: ctr.y, z: ctr.z },
          { x: ctr.x + dir.x * halfLen, y: ctr.y + dir.y * halfLen, z: ctr.z + dir.z * halfLen },
        ];
      }

      overlay.enable(vpIds, initialPoints);
      centerlineRef.current = overlay;
    }, 150);

    return () => {
      clearTimeout(timer);
      centerlineRef.current?.disable();
      centerlineRef.current = null;
    };
  }, [workflowPhase, renderingEngineId, viewportMode, axisResult]);

  // ── Cusp marker overlay: show during cusp-definition on double-oblique viewports ──
  useEffect(() => {
    if (workflowPhase !== 'cusp-definition') {
      cuspMarkerRef.current?.disable();
      cuspMarkerRef.current = null;
      return;
    }

    const timer = setTimeout(() => {
      const overlay = new CuspMarkerOverlay(renderingEngineId);
      overlay.enable(['axial', 'coronal'], {
        onMarkerPlaced: (id: CuspId, point: TAVIVector3D) => {
          // Update state when marker is clicked
          const stateKey = id === 'rc' ? 'rcc' : id === 'nc' ? 'ncc' : 'lcc';
          setCuspPoints(prev => ({ ...prev, [stateKey]: point }));

          // Auto-rotate 120 degrees after placing LC and NC (not after RC, the last one)
          const controller = controllerRef.current;
          if (controller && id !== 'rc') {
            setCuspRotating(true);
            controller.rotateAroundAxis(120, 500).then(() => setCuspRotating(false));
          }
        },
        onMarkerMoved: (id: CuspId, point: TAVIVector3D) => {
          const stateKey = id === 'rc' ? 'rcc' : id === 'nc' ? 'ncc' : 'lcc';
          setCuspPoints(prev => ({ ...prev, [stateKey]: point }));
        },
        onAllPlaced: (lc: TAVIVector3D, nc: TAVIVector3D, rc: TAVIVector3D) => {
          // Compute annulus plane from 3 cusp points
          const success = session.captureThreePointAnnulusPlane(lc, nc, rc);
          if (success && session.annulusPlaneNormal && session.annulusPlaneCentroid) {
            const controller = controllerRef.current;
            if (controller) {
              controller.alignToPlane(session.annulusPlaneNormal, session.annulusPlaneCentroid);
            }
            setCuspStep('verify');
          }
          forceUpdate();
        },
      });
      cuspMarkerRef.current = overlay;
    }, 150);

    return () => {
      clearTimeout(timer);
      cuspMarkerRef.current?.disable();
      cuspMarkerRef.current = null;
    };
  }, [workflowPhase, renderingEngineId, session]);

  // ── Measurement overlay: show after annulus contour is confirmed ──
  useEffect(() => {
    // Show measurement overlay when we have annulus geometry
    const annulusGeo = session.activeAnnulusGeometry();
    if (!annulusGeo || workflowPhase === 'axis-validation' || workflowPhase === 'axis-detection') {
      measurementRef.current?.disable();
      measurementRef.current = null;
      return;
    }

    const timer = setTimeout(() => {
      // Use the working viewport (coronal in TAVI mode)
      const vpId = viewportMode === 'tavi-oblique' ? 'coronal' : 'axial';
      const overlay = new AnnulusMeasurementOverlay(renderingEngineId, vpId);
      overlay.enable();

      // Set annulus data
      if (session.annulusSnapshot?.worldPoints) {
        overlay.setAnnulusData(session.annulusSnapshot.worldPoints, annulusGeo);
      }

      // Set cusp labels
      const cusps: { id: string; point: TAVIVector3D }[] = [];
      if (session.cuspRCC) cusps.push({ id: 'RC', point: session.cuspRCC });
      if (session.cuspNCC) cusps.push({ id: 'NC', point: session.cuspNCC });
      if (session.cuspLCC) cusps.push({ id: 'LC', point: session.cuspLCC });
      if (cusps.length > 0) overlay.setCuspPositions(cusps);

      measurementRef.current = overlay;
    }, 150);

    return () => {
      clearTimeout(timer);
      measurementRef.current?.disable();
      measurementRef.current = null;
    };
  // Re-run when annulus geometry changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowPhase, renderingEngineId, viewportMode, session.annulusGeometry, session.assistedAnnulusGeometry]);

  // ── Auto-detect contour ──

  const handleAutoDetect = useCallback(() => {
    const engine = getEngine();
    if (!engine) return;

    setAutoDetecting(true);
    setAutoDetectError(null);

    requestAnimationFrame(() => {
      try {
        const volume = cornerstone.cache.getVolume(volumeId);
        if (!volume) {
          setAutoDetectError('No volume loaded');
          setAutoDetecting(false);
          return;
        }

        // Try all 3 MPR viewports and pick the one with the best segmentation
        // (largest contour = most likely to be the correct cross-section)
        type SegCandidate = {
          vpId: string;
          origin: TAVIVector3D;
          normal: TAVIVector3D;
          contourPoints: TAVIVector3D[];
        };
        let bestCandidate: SegCandidate | null = null;
        let bestArea = 0;

        for (const vpId of VIEWPORT_IDS) {
          const vp = engine.getViewport(vpId);
          if (!vp) continue;
          const cam = vp.getCamera();
          if (!cam.focalPoint || !cam.viewPlaneNormal) continue;

          const origin: TAVIVector3D = { x: cam.focalPoint[0], y: cam.focalPoint[1], z: cam.focalPoint[2] };
          const normal: TAVIVector3D = { x: cam.viewPlaneNormal[0], y: cam.viewPlaneNormal[1], z: cam.viewPlaneNormal[2] };
          const viewUp = cam.viewUp
            ? { x: cam.viewUp[0], y: cam.viewUp[1], z: cam.viewUp[2] }
            : undefined;

          try {
            const seg = autoSegmentCrossSectionAtPlane(volume, origin, normal, viewUp);
            if (seg && seg.contourPoints.length >= 8) {
              // Estimate contour area using shoelace on 2D projection
              const pts = seg.contourPoints;
              let area = 0;
              for (let i = 0; i < pts.length; i++) {
                const j = (i + 1) % pts.length;
                // Cross-product magnitude gives 2x area of triangle from origin
                const dx1 = pts[i].x - seg.centerWorld.x;
                const dy1 = pts[i].y - seg.centerWorld.y;
                const dz1 = pts[i].z - seg.centerWorld.z;
                const dx2 = pts[j].x - seg.centerWorld.x;
                const dy2 = pts[j].y - seg.centerWorld.y;
                const dz2 = pts[j].z - seg.centerWorld.z;
                const cx = dy1 * dz2 - dz1 * dy2;
                const cy = dz1 * dx2 - dx1 * dz2;
                const cz = dx1 * dy2 - dy1 * dx2;
                area += Math.sqrt(cx * cx + cy * cy + cz * cz);
              }
              area /= 2;

              if (area > bestArea) {
                bestArea = area;
                bestCandidate = { vpId, origin, normal, contourPoints: seg.contourPoints };
              }
            }
          } catch {
            // skip this viewport if segmentation throws
          }
        }

        if (!bestCandidate) {
          setAutoDetectError('No lumen found in any viewport. Navigate crosshairs so a vessel cross-section is visible, then try again.');
          setAutoDetecting(false);
          return;
        }

        // Create contour snapshot from best result
        const snapshot: TAVIContourSnapshot = {
          worldPoints: bestCandidate.contourPoints,
          pixelPoints: [],
          planeOrigin: bestCandidate.origin,
          planeNormal: bestCandidate.normal,
        };
        session.captureContourSnapshot(snapshot, activeStep);

        if (activeStep === TAVIStructureAnnulus) {
          session.useAssistedAnnulusForPlanning = true;
        }

        // Advance to next step
        const idx = steps.findIndex(s => s.id === activeStep);
        if (idx >= 0 && idx < steps.length - 1) {
          setActiveStep(steps[idx + 1].id);
        }

        setAutoDetecting(false);
        setAutoDetectError(null);
        forceUpdate();
      } catch (err: any) {
        const msg = err.message || String(err);
        if (msg.includes('scalar data')) {
          setAutoDetectError('Volume data not ready — ensure all slices are loaded, then try again.');
        } else {
          setAutoDetectError(`Detection error: ${msg}`);
        }
        setAutoDetecting(false);
      }
    });
  }, [activeStep, volumeId, session, renderingEngineId]);

  // ── Capture axis from crosshairs ──

  const captureAxisFromCrosshairs = useCallback(() => {
    const engine = getEngine();
    if (!engine) return;

    // ── Step 1: Read the crosshair intersection point ──
    let center: TAVIVector3D | null = null;
    const csToolName = cornerstoneTools.CrosshairsTool.toolName;

    // Try tool instance first
    const toolGroup = cornerstoneTools.ToolGroupManager.getToolGroup('mprToolGroup');
    if (toolGroup) {
      const csTool = toolGroup.getToolInstance(csToolName) as any;
      if (csTool?.toolCenter) {
        const tc = csTool.toolCenter;
        center = { x: tc[0], y: tc[1], z: tc[2] };
      }
    }

    // Fallback: annotation
    if (!center) {
      for (const vpId of ['coronal', 'sagittal', 'axial']) {
        const vp = engine.getViewport(vpId);
        if (!vp?.element) continue;
        const anns = cornerstoneTools.annotation.state.getAnnotations(csToolName, vp.element);
        if (anns?.length > 0) {
          const tc = anns[0].data?.handles?.toolCenter;
          if (tc) { center = { x: tc[0], y: tc[1], z: tc[2] }; break; }
        }
      }
    }

    // Fallback: average focal points
    if (!center) {
      const fps: cornerstone.Types.Point3[] = [];
      for (const vpId of ['sagittal', 'coronal']) {
        const vp = engine.getViewport(vpId);
        if (!vp) continue;
        const cam = vp.getCamera();
        if (cam.focalPoint) fps.push(cam.focalPoint);
      }
      if (fps.length > 0) {
        center = {
          x: fps.reduce((s, p) => s + p[0], 0) / fps.length,
          y: fps.reduce((s, p) => s + p[1], 0) / fps.length,
          z: fps.reduce((s, p) => s + p[2], 0) / fps.length,
        };
      }
    }

    if (!center) return;
    console.log('[TAVI] Crosshair center:', center);

    // ── Step 2: Determine aortic axis direction ──
    // Use LOCAL auto-detection: PCA on contrast voxels within ~35mm of the crosshair.
    // This finds the aortic root axis specifically, not the descending aorta.
    let axisDir: TAVIVector3D | null = null;
    try {
      const volume = cornerstone.cache.getVolume(volumeId);
      if (volume) {
        const result = detectAorticAxisLocal(volume, center, 15);
        if (result && result.confidence > 0.6) {
          axisDir = result.axisDirection;
          console.log('[TAVI] Local axis detected:', JSON.stringify(axisDir), 'confidence:', result.confidence.toFixed(3));
        } else {
          console.warn('[TAVI] Local detection low confidence:', result?.confidence);
        }
      }
    } catch (e) {
      console.warn('[TAVI] Local axis detection failed:', e);
    }

    // Fallback: use a typical cardiac axis estimate
    // In DICOM LPS: L=+x, P=+y, S=+z
    // Aortic root axis: from LVOT (inferior-posterior-right) toward
    // ascending aorta (superior-anterior-left), roughly 25° anterior, 15° left
    if (!axisDir) {
      // Typical aortic root axis in LPS: mostly vertical (S), slightly anterior and left
      axisDir = TAVIGeometry.vectorNormalize({ x: 0.15, y: -0.35, z: 0.92 });
      console.log('[TAVI] Using fallback cardiac axis estimate:', JSON.stringify(axisDir));
    }

    // Ensure axis points superiorly (Z > 0) — flip if PCA found reversed direction
    if (axisDir.z < 0) {
      axisDir = { x: -axisDir.x, y: -axisDir.y, z: -axisDir.z };
      console.log('[TAVI] Flipped axis to point superiorly:', JSON.stringify(axisDir));
    }

    // Sanity check: axis should be mostly vertical (Z component > 0.5)
    // If too horizontal, fall back to typical cardiac axis
    if (Math.abs(axisDir.z) < 0.4) {
      console.warn('[TAVI] Detected axis too horizontal (z=' + axisDir.z.toFixed(2) + '), using fallback');
      axisDir = TAVIGeometry.vectorNormalize({ x: 0.15, y: -0.35, z: 0.92 });
    }

    // ── Step 3: Save to session ──
    const halfLen = 25;
    const p0: TAVIVector3D = TAVIGeometry.vectorAdd(center, TAVIGeometry.vectorScale(axisDir, -halfLen));
    const p1: TAVIVector3D = TAVIGeometry.vectorAdd(center, TAVIGeometry.vectorScale(axisDir, halfLen));

    session.capturePointSnapshots(
      [{ worldPoint: p0 }, { worldPoint: p1 }],
      TAVIStructureAorticAxis
    );

    // ── Step 4: Switch to double-oblique mode ──
    onViewportModeChange('tavi-oblique');
    enterDoubleObliqueMode(renderingEngineId);

    setTimeout(() => {
      const controller = new DoubleObliqueController(
        renderingEngineId,
        'axial',    // LEFT = reference (longitudinal)
        'coronal'   // RIGHT = working (cross-section)
      );
      controller.initialize(center!, axisDir!);
      controllerRef.current = controller;

      // Go directly to cusp definition (like ProSizeAV)
      const state = controller.getState();
      preCuspStateRef.current = {
        axisPoint: { ...state.axisPoint },
        axisDirection: { ...state.axisDirection },
        rotationAngle: state.rotationAngle,
        tiltAngle: state.tiltAngle,
      };
      controller.prepareForCuspDefinition();
      enableProbeTool();
      setWorkflowPhase('cusp-definition');
      setCuspStep('lcc');
      setCuspPoints({});
      forceUpdate();
    }, 250);
  }, [session, renderingEngineId, volumeId, onViewportModeChange]);

  // ── Reset all TAVI measurements ──

  const resetAllMeasurements = useCallback(() => {
    session.reset();
    setActiveStep(TAVIStructureAorticAxis);
    setDrawingActive(false);
    setMultiPoints([]);
    setAutoDetectError(null);
    // Always reset to standard 4-viewport mode with crosshairs
    if (viewportMode === 'tavi-oblique') {
      onViewportModeChange('standard');
    }
    setWorkflowPhase('axis-validation');
    setCuspStep('lcc');
    setCuspPoints({});
    setContourPointCount(0);
    setContourClosed(false);
    setCoronaryStep('navigate-lca');
    setActiveContourId(null);
    setNcGuidePoints([]);
    setMultiLevelThumbnails(new Map());
    contourToolRef.current?.clearPoints();
    if (controllerRef.current) {
      controllerRef.current.dispose();
      controllerRef.current = null;
    }
    centerlineRef.current?.disable();
    centerlineRef.current = null;
    cuspMarkerRef.current?.disable();
    cuspMarkerRef.current = null;
    measurementRef.current?.disable();
    measurementRef.current = null;
    forceUpdate();
  }, [session, viewportMode, onViewportModeChange]);

  // Wire up the ref so useImperativeHandle can call resetAll (must be after definition)
  useEffect(() => {
    resetAllRef.current = resetAllMeasurements;
  }, [resetAllMeasurements]);

  // ── Capture logic ──

  const handleStartDrawing = () => {
    if (currentStep.type === 'point' || currentStep.type === 'multi-point') {
      setActiveTool('Probe');
      if (currentStep.type === 'multi-point') setMultiPoints([]);
    } else {
      setActiveTool('PlanarFreehandROI');
    }
    setDrawingActive(true);
  };

  const captureActiveAnnotation = () => {
    const engine = getEngine();
    if (!engine) return;

    let foundAnnotation = false;

    for (const vpId of VIEWPORT_IDS) {
      const vp = engine.getViewport(vpId);
      if (!vp?.element) continue;

      if (currentStep.type === 'point') {
        const probes = cornerstoneTools.annotation.state.getAnnotations('Probe', vp.element);
        if (probes && probes.length > 0) {
          const ann = probes[probes.length - 1] as any;
          const p = ann.data.handles.points[0];
          session.capturePointSnapshot({ worldPoint: { x: p[0], y: p[1], z: p[2] } }, activeStep);
          foundAnnotation = true;
          break;
        }
      } else if (currentStep.type === 'multi-point') {
        const probes = cornerstoneTools.annotation.state.getAnnotations('Probe', vp.element);
        if (probes && probes.length > 0) {
          const ann = probes[probes.length - 1] as any;
          const p = ann.data.handles.points[0];
          const newPoint: TAVIPointSnapshot = { worldPoint: { x: p[0], y: p[1], z: p[2] } };
          const updated = [...multiPoints, newPoint];
          setMultiPoints(updated);

          const minRequired = (activeStep === TAVIStructureMembranousSeptum || activeStep === TAVIStructureAorticAxis) ? 2 : 3;
          if (updated.length >= minRequired) {
            session.capturePointSnapshots(updated, activeStep);
            foundAnnotation = true;
          } else {
            forceUpdate();
            return;
          }
          break;
        }
      } else {
        const contours = cornerstoneTools.annotation.state.getAnnotations('PlanarFreehandROI', vp.element);
        if (contours && contours.length > 0) {
          const ann = contours[contours.length - 1] as any;
          const polyline: number[][] = ann.data.contour?.polyline ?? ann.data.polyline;
          if (polyline && polyline.length >= 3) {
            const worldPoints: TAVIVector3D[] = polyline.map(p => ({ x: p[0], y: p[1], z: p[2] }));
            const camera = vp.getCamera();
            const vpn = camera.viewPlaneNormal || [0, 0, 1];
            const snapshot: TAVIContourSnapshot = {
              worldPoints,
              pixelPoints: [],
              planeOrigin: { x: polyline[0][0], y: polyline[0][1], z: polyline[0][2] },
              planeNormal: { x: vpn[0], y: vpn[1], z: vpn[2] },
            };
            session.captureContourSnapshot(snapshot, activeStep);
            if (activeStep === TAVIStructureAnnulus) {
              session.useAssistedAnnulusForPlanning = true;
            }
            foundAnnotation = true;
            break;
          }
        }
      }
    }

    if (foundAnnotation) {
      setDrawingActive(false);
      setMultiPoints([]);
      setActiveTool('Crosshairs');
      const idx = steps.findIndex(s => s.id === activeStep);
      if (idx >= 0 && idx < steps.length - 1) {
        setActiveStep(steps[idx + 1].id);
      }
    }

    forceUpdate();
  };

  const cancelDrawing = () => {
    setDrawingActive(false);
    setMultiPoints([]);
    setActiveTool('Crosshairs');
  };

  const isStepCaptured = (stepId: string): boolean => {
    switch (stepId) {
      case TAVIStructureAorticAxis: return session.aorticAxisPointSnapshots.length >= 2;
      case TAVIStructureAscendingAorta: return !!session.ascendingAortaSnapshot;
      case TAVIStructureSTJ: return !!session.stjSnapshot;
      case TAVIStructureSinus: return !!session.sinusSnapshot;
      case TAVIStructureAnnulus: return !!session.annulusSnapshot;
      case TAVIStructureLVOT: return !!session.lvotSnapshot;
      case TAVIStructureLeftOstium: return !!session.leftOstiumSnapshot;
      case TAVIStructureRightOstium: return !!session.rightOstiumSnapshot;
      case TAVIStructureMembranousSeptum: return session.membranousSeptumPointSnapshots.length >= 2;
      case TAVIStructureSinusPoints: return session.sinusPointSnapshots.length >= 3;
      default: return false;
    }
  };

  const capturedCount = steps.filter(s => isStepCaptured(s.id)).length;
  const annulus = session.activeAnnulusGeometry();
  const fluoro = session.preferredProjectionAngle();

  // Valve sizing recommendations
  const valveRecs: ValveSizeRecommendation[] = annulus
    ? recommendValveSizes(annulus.perimeterMm, annulus.areaMm2)
    : [];

  // Risk assessment
  const risks = assessTAVRRisks({
    leftCoronaryHeightMm: session.leftCoronaryHeightMm,
    rightCoronaryHeightMm: session.rightCoronaryHeightMm,
    membranousSeptumLengthMm: session.membranousSeptumLengthMm,
    annulusCalcificationGrade: session.annulusCalcificationGrade,
    cuspCalcificationGrade: session.cuspCalcificationGrade,
    perimeterDerivedDiameterMm: annulus ? dPerim(annulus.perimeterMm) : null,
    sinusWidthMm: session.sinusGeometry ? session.sinusGeometry.maximumDiameterMm : null,
  });

  // BAV assessment
  const bavRisk = annulus
    ? assessBAVRisk(ecc(annulus), annulus.minimumDiameterMm, annulus.maximumDiameterMm)
    : { isSuspectedBAV: false, bavWarning: '' };

  // Pacemaker risk score
  const pmRisk = computePacemakerRiskScore({
    membranousSeptumLengthMm: session.membranousSeptumLengthMm,
    isSelfExpanding: false, // default; ideally based on selected valve
  });

  // Export report as text
  const exportReport = useCallback(() => {
    const lines: string[] = [];
    lines.push('═══════════════════════════════════════════');
    lines.push('  TAVR PRE-OPERATIVE CT ANALYSIS REPORT');
    lines.push('═══════════════════════════════════════════');
    lines.push('');

    if (session.patientName) lines.push(`Patient: ${session.patientName}`);
    if (session.patientID) lines.push(`ID: ${session.patientID}`);
    lines.push(`Date: ${new Date().toLocaleDateString()}`);
    lines.push('');

    // Annulus
    lines.push('── AORTIC ANNULUS ──');
    if (annulus) {
      lines.push(`  Perimeter:    ${fmt(annulus.perimeterMm)} mm (ø ${fmt(dPerim(annulus.perimeterMm))} mm)`);
      lines.push(`  Area:         ${fmt(annulus.areaMm2)} mm² (ø ${fmt(dArea(annulus.areaMm2))} mm)`);
      lines.push(`  Eccentricity: ${fmt(ecc(annulus), 2)} (${fmt(annulus.minimumDiameterMm)} × ${fmt(annulus.maximumDiameterMm)} mm)`);
      lines.push(`  Virtual Valve: ø ${fmt(session.virtualValveDiameterMm)} mm`);
      if (session.useAssistedAnnulusForPlanning) lines.push('  Source: Assisted Ellipse Fit');
    } else {
      lines.push('  Not captured');
    }
    lines.push('');

    // Coronary Heights
    lines.push('── CORONARY ASSESSMENT ──');
    lines.push(`  LCO Height: ${session.leftCoronaryHeightMm != null ? `${fmt(session.leftCoronaryHeightMm)} mm` : 'Not measured'}`);
    lines.push(`  RCO Height: ${session.rightCoronaryHeightMm != null ? `${fmt(session.rightCoronaryHeightMm)} mm` : 'Not measured'}`);
    if (session.membranousSeptumLengthMm != null) {
      lines.push(`  Membranous Septum: ${fmt(session.membranousSeptumLengthMm)} mm`);
    }
    lines.push(`  Aortic Angulation: ${fmt(session.horizontalAortaAngleDegrees)}°`);
    lines.push('');

    // Structure geometries
    lines.push('── STRUCTURE GEOMETRIES ──');
    const geos: [string, TAVIGeometryResult | null | undefined][] = [
      ['Ascending Aorta', session.ascendingAortaGeometry],
      ['STJ', session.stjGeometry],
      ['Sinus (SOV)', session.sinusGeometry],
      ['Annulus', annulus],
      ['LVOT', session.lvotGeometry],
    ];
    for (const [name, geo] of geos) {
      if (geo) {
        lines.push(`  ${name}: ø ${fmt(dPerim(geo.perimeterMm))} mm | ${fmt(geo.areaMm2)} mm² | ${fmt(geo.minimumDiameterMm)} × ${fmt(geo.maximumDiameterMm)} mm`);
      } else {
        lines.push(`  ${name}: —`);
      }
    }
    lines.push('');

    // Valve sizing
    if (valveRecs.length > 0) {
      lines.push('── VALVE SIZING ──');
      for (const rec of valveRecs) {
        if (rec.primarySize) {
          lines.push(`  ${rec.family.name} (${rec.family.manufacturer}): ${rec.primarySize.size}mm [${rec.fitStatus}]`);
          if (rec.alternativeSize) {
            lines.push(`    Alternative: ${rec.alternativeSize.size}mm`);
          }
        }
      }
      lines.push('');
    }

    // Fluoroscopy
    lines.push('── FLUOROSCOPIC PLANNING ──');
    if (fluoro) {
      lines.push(`  Coplanar View: ${angleStr(fluoro)}`);
      if (session.projectionConfirmation) {
        lines.push(`  Confirmed:     ${angleStr(session.projectionConfirmation.confirmationAngle)}`);
        lines.push(`  Difference:    ${fmt(session.projectionConfirmation.normalDifferenceDegrees)}°`);
      }
      // RAO/LAO table
      if (session.raoProjectionTable.length > 0) {
        lines.push('  RAO/LAO Perpendicularity Table:');
        for (const entry of session.raoProjectionTable) {
          const ccLabel = entry.cranialCaudalDeg >= 0 ? 'Cranial' : 'Caudal';
          lines.push(`    ${entry.label}: ${ccLabel} ${Math.abs(entry.cranialCaudalDeg).toFixed(0)}°`);
        }
        for (const entry of session.laoProjectionTable) {
          const ccLabel = entry.cranialCaudalDeg >= 0 ? 'Cranial' : 'Caudal';
          lines.push(`    ${entry.label}: ${ccLabel} ${Math.abs(entry.cranialCaudalDeg).toFixed(0)}°`);
        }
      }
    } else {
      lines.push('  Not available (capture annulus first)');
    }
    lines.push('');

    // Access route
    lines.push('── ACCESS PLANNING ──');
    lines.push(`  Planned Access:   ${session.plannedAccess}`);
    lines.push(`  Pigtail Access:   ${session.plannedPigtailAccess}`);
    lines.push('');

    // Risk
    lines.push('── RISK ASSESSMENT ──');
    lines.push(`  Coronary Obstruction: ${risks.coronaryObstructionRisk.toUpperCase()} — ${risks.coronaryObstructionNote}`);
    lines.push(`  Conduction:           ${risks.conductionDisturbanceRisk.toUpperCase()} — ${risks.conductionDisturbanceNote}`);
    lines.push(`  Annular Rupture:      ${risks.annularRuptureRisk.toUpperCase()} — ${risks.annularRuptureNote}`);
    lines.push('');

    // Calcium
    lines.push('── CALCIFICATION ──');
    lines.push(`  Cusp Grade: ${session.cuspCalcificationGrade} | Annulus Grade: ${session.annulusCalcificationGrade}`);
    lines.push(`  Threshold: ${session.calciumThresholdHU} HU`);
    if (session.annulusCalcium) {
      lines.push(`  Agatston 2D: ${fmt(session.annulusCalcium.agatstonScore2D, 0)}`);
      lines.push(`  Hyperdense Area: ${fmt(session.annulusCalcium.hyperdenseAreaMm2)} mm²`);
    }
    lines.push('');

    if (session.notes) {
      lines.push('── COMMENTS ──');
      lines.push(`  ${session.notes}`);
      lines.push('');
    }

    lines.push('═══════════════════════════════════════════');

    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `TAVR_Report_${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [session, annulus, fluoro, valveRecs, risks]);

  return (
    <div className="tavi-panel">
      {/* Tab bar */}
      <div className="tavi-tabs">
        <button className={`tavi-tab ${activeTab === 'capture' ? 'active' : ''}`} onClick={() => { setActiveTab('capture'); onReportToggle?.(false); }}>
          Capture ({capturedCount}/{steps.length})
        </button>
        <button className={`tavi-tab ${activeTab === 'report' ? 'active' : ''}`} onClick={() => { setActiveTab('report'); onReportToggle?.(true); }}>
          Report
        </button>
        <button
          className="tavi-tab"
          onClick={resetAllMeasurements}
          title="Reset all TAVI measurements"
          style={{ flex: 'none', padding: '6px 10px', color: 'var(--accent-red)' }}
        >
          Reset
        </button>
      </div>

      <div className="tavi-panel-content">

        {activeTab === 'capture' && (
          <>
            {/* ── Workflow Mode Selector ── */}
            <div className="tavi-card">
              <h3 className="tavi-card-title">Workflow Mode</h3>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <button
                  className={`tavi-button ${workflowPhase === 'legacy' ? 'tavi-button-capture' : ''}`}
                  onClick={() => {
                    if (viewportMode !== 'standard') {
                      onViewportModeChange('standard');
                    }
                    controllerRef.current?.dispose();
                    controllerRef.current = null;
                    setWorkflowPhase('legacy');
                  }}
                  style={{ flex: 1, fontSize: '0.75rem' }}
                >
                  Manual (4-view)
                </button>
                <button
                  className={`tavi-button ${workflowPhase !== 'legacy' ? 'tavi-button-capture' : ''}`}
                  onClick={() => {
                    if (viewportMode === 'standard') {
                      onViewportModeChange('tavi-crosshair');
                    }
                    if (workflowPhase === 'legacy') {
                      setWorkflowPhase('axis-validation');
                    }
                  }}
                  style={{ flex: 1, fontSize: '0.75rem' }}
                >
                  ProSize-Style
                </button>
              </div>

              {/* Axis Detection Status */}
              {axisError && (
                <div className="tavi-calcium-note" style={{ marginBottom: 8 }}>
                  {axisError}
                </div>
              )}

              {/* ── Unified Step-by-Step Planning (MPR views) ── */}
              {workflowPhase === 'axis-validation' && (
                <div style={{ marginBottom: 8 }}>
                  {(() => {
                    // Helper to render a Place/Confirm/↻ row
                    const PlaceRow = ({ label, captured, onPlace, onConfirm, onUndo }: {
                      label: string; captured: boolean;
                      onPlace: () => void; onConfirm: () => void; onUndo: () => void;
                    }) => (
                      <div style={{ display: 'flex', gap: 4, marginBottom: 3, alignItems: 'center' }}>
                        <button onClick={onPlace}
                          className={`tavi-button ${captured ? 'tavi-button-captured' : ''}`}
                          style={{ flex: 1, fontSize: '0.72rem', padding: '4px 6px' }}>
                          {captured ? `✓ ${label}` : `Place ${label}`}
                        </button>
                        {!captured && (
                          <button onClick={onConfirm}
                            className="tavi-button tavi-button-capture"
                            style={{ flex: 'none', fontSize: '0.72rem', padding: '4px 8px' }}>Confirm</button>
                        )}
                        {captured && (
                          <button onClick={onUndo}
                            className="tavi-button tavi-button-cancel"
                            style={{ flex: 'none', fontSize: '0.72rem', padding: '4px 6px' }}>↻</button>
                        )}
                      </div>
                    );

                    // Capture geometry at current axial crosshair level using auto-segmentation
                    const captureLevel = (structureId: string) => {
                      const engine = getEngine();
                      if (!engine) return;

                      // Get current crosshair position (focal point of axial viewport)
                      const axVp = engine.getViewport('axial');
                      if (!axVp) return;
                      const cam = axVp.getCamera();
                      if (!cam.focalPoint || !cam.viewPlaneNormal || !cam.viewUp) return;

                      const origin: TAVIVector3D = { x: cam.focalPoint[0], y: cam.focalPoint[1], z: cam.focalPoint[2] };
                      const normal: TAVIVector3D = { x: cam.viewPlaneNormal[0], y: cam.viewPlaneNormal[1], z: cam.viewPlaneNormal[2] };
                      const viewUp: TAVIVector3D = { x: cam.viewUp[0], y: cam.viewUp[1], z: cam.viewUp[2] };

                      // Auto-segment the lumen at this level
                      const volume = cornerstone.cache.getVolume(volumeId);
                      if (!volume) return;

                      const seg = autoSegmentCrossSectionAtPlane(volume, origin, normal, viewUp, {
                        huMin: 150, huMax: 500, gridSize: 200, pixelSpacing: 0.25,
                        maxDiameterMm: structureId === TAVIStructureAscendingAorta ? 55 : 50,
                      });

                      if (!seg || seg.contourPoints.length < 10) {
                        console.warn('[TAVI] Auto-segment failed for', structureId);
                        return;
                      }

                      // Compute geometry from contour
                      const geo = TAVIGeometry.geometryForWorldContour(seg.contourPoints, normal);
                      if (!geo) return;

                      // Store as contour snapshot in session (same format as manual contour tracing)
                      const contourSnapshot = {
                        worldPoints: seg.contourPoints,
                        planeNormal: normal,
                        planeOrigin: origin,
                      };

                      if (structureId === TAVIStructureAscendingAorta) session.ascendingAortaSnapshot = contourSnapshot;
                      if (structureId === TAVIStructureSTJ) session.stjSnapshot = contourSnapshot;
                      if (structureId === TAVIStructureSinus) session.sinusSnapshot = contourSnapshot;

                      // recompute will derive geometry from the snapshot
                      session.recompute();
                      setActiveContourId(structureId); // Show contour overlay for editing
                      setRefresh(r => r + 1); // Force re-render to show results
                      console.log(`[TAVI] Captured ${structureId}: min=${geo.minimumDiameterMm.toFixed(1)}mm, max=${geo.maximumDiameterMm.toFixed(1)}mm, area=${geo.areaMm2.toFixed(0)}mm²`);
                    };

                    // Section wrapper
                    const Section = ({ num, title, children }: { num: string; title: string; children: React.ReactNode }) => (
                      <div style={{ margin: '0 0 6px', padding: '6px 8px', background: 'color-mix(in oklch, var(--nd-ink) 6%, transparent)', borderRadius: 6, border: '1px solid rgba(255,255,255,0.08)' }}>
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                          {num}. {title}
                        </div>
                        {children}
                      </div>
                    );

                    return (
                      <div className="tavi-checklist">
                        {/* ── 1. Ascending Aorta ── */}
                        <Section num="1" title="Ascending Aorta">
                          {session.ascendingAortaGeometry ? (
                            <div>
                              <div className="tavi-report-grid" style={{ marginBottom: 4 }}>
                                <Row label="Min ø" value={`${fmt(session.ascendingAortaGeometry.minimumDiameterMm)} mm`} />
                                <Row label="Max ø" value={`${fmt(session.ascendingAortaGeometry.maximumDiameterMm)} mm`} />
                                <Row label="Area" value={`${fmt(session.ascendingAortaGeometry.areaMm2)} mm²`} />
                                <Row label="Perimeter" value={`${fmt(session.ascendingAortaGeometry.perimeterMm)} mm`} />
                              </div>
                              <div style={{ display: 'flex', gap: 4 }}>
                                {activeContourId === TAVIStructureAscendingAorta && (
                                  <button onClick={() => { setActiveContourId(null); setRefresh(r => r + 1); }}
                                    className="tavi-button tavi-button-capture" style={{ flex: 1, fontSize: '0.7rem', padding: '3px' }}>✓ Confirm</button>
                                )}
                                <button onClick={() => {
                                  session.ascendingAortaSnapshot = undefined; session.recompute();
                                  setActiveContourId(null); setRefresh(r => r + 1);
                                }} className="tavi-button tavi-button-cancel" style={{ flex: activeContourId === TAVIStructureAscendingAorta ? 'none' : 1, fontSize: '0.7rem', padding: '3px' }}>↻ Re-measure</button>
                              </div>
                            </div>
                          ) : (
                            <div>
                              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                                Navigate crosshair to ascending aorta level in axial view.
                              </div>
                              <button onClick={() => captureLevel(TAVIStructureAscendingAorta)}
                                className="tavi-button tavi-button-capture"
                                style={{ width: '100%', fontSize: '0.72rem', padding: '5px 8px' }}>
                                Capture Level
                              </button>
                            </div>
                          )}
                        </Section>

                        {/* ── 2. Sino-Tubular Junction ── */}
                        <Section num="2" title="Sino-Tubular Junction">
                          {session.stjGeometry ? (
                            <div>
                              <div className="tavi-report-grid" style={{ marginBottom: 4 }}>
                                <Row label="Min ø" value={`${fmt(session.stjGeometry.minimumDiameterMm)} mm`} />
                                <Row label="Max ø" value={`${fmt(session.stjGeometry.maximumDiameterMm)} mm`} />
                                <Row label="Area" value={`${fmt(session.stjGeometry.areaMm2)} mm²`} />
                              </div>
                              <div style={{ display: 'flex', gap: 4 }}>
                                {activeContourId === TAVIStructureSTJ && (
                                  <button onClick={() => { setActiveContourId(null); setRefresh(r => r + 1); }}
                                    className="tavi-button tavi-button-capture" style={{ flex: 1, fontSize: '0.7rem', padding: '3px' }}>✓ Confirm</button>
                                )}
                                <button onClick={() => {
                                  session.stjSnapshot = undefined; session.recompute();
                                  setActiveContourId(null); setRefresh(r => r + 1);
                                }} className="tavi-button tavi-button-cancel" style={{ flex: activeContourId === TAVIStructureSTJ ? 'none' : 1, fontSize: '0.7rem', padding: '3px' }}>↻ Re-measure</button>
                              </div>
                            </div>
                          ) : (
                            <div>
                              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                                Pull crosshair down to STJ level.
                              </div>
                              <button onClick={() => captureLevel(TAVIStructureSTJ)}
                                className="tavi-button tavi-button-capture"
                                style={{ width: '100%', fontSize: '0.72rem', padding: '5px 8px' }}>
                                Capture Level
                              </button>
                            </div>
                          )}
                        </Section>

                        {/* ── 3. Valve Level — Sinus Valsalva ── */}
                        <Section num="3" title="Valve Level — Sinus Valsalva">
                          {session.sinusGeometry ? (
                            <div>
                              <div className="tavi-report-grid" style={{ marginBottom: 4 }}>
                                <Row label="Sinus Min ø" value={`${fmt(session.sinusGeometry.minimumDiameterMm)} mm`} />
                                <Row label="Sinus Max ø" value={`${fmt(session.sinusGeometry.maximumDiameterMm)} mm`} />
                                <Row label="Sinus Area" value={`${fmt(session.sinusGeometry.areaMm2)} mm²`} />
                              </div>
                              <div style={{ display: 'flex', gap: 4 }}>
                                {activeContourId === TAVIStructureSinus && (
                                  <button onClick={() => { setActiveContourId(null); setRefresh(r => r + 1); }}
                                    className="tavi-button tavi-button-capture" style={{ flex: 1, fontSize: '0.7rem', padding: '3px' }}>✓ Confirm</button>
                                )}
                                <button onClick={() => {
                                  session.sinusSnapshot = undefined; session.recompute();
                                  setActiveContourId(null); setRefresh(r => r + 1);
                                }} className="tavi-button tavi-button-cancel" style={{ flex: activeContourId === TAVIStructureSinus ? 'none' : 1, fontSize: '0.7rem', padding: '3px' }}>↻ Re-measure</button>
                              </div>
                            </div>
                          ) : (
                            <div>
                              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                                Pull crosshair to valve/sinus level.
                              </div>
                              <button onClick={() => captureLevel(TAVIStructureSinus)}
                                className="tavi-button tavi-button-capture"
                                style={{ width: '100%', fontSize: '0.72rem', padding: '5px 8px' }}>
                                Capture Level
                              </button>
                            </div>
                          )}
                        </Section>

                        {/* ── 4. NC Cusp Guide ── */}
                        <Section num="4" title="NC Cusp Region">
                          {ncGuidePoints.length < 3 ? (
                            <div>
                              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                                Axial görüntüde NC bölgesinin 3 köşesine tıklayın. ({ncGuidePoints.length}/3)
                              </div>
                              <button onClick={() => enableProbeTool()}
                                className="tavi-button tavi-button-capture"
                                style={{ width: '100%', fontSize: '0.72rem', padding: '5px 8px' }}>
                                {ncGuidePoints.length === 0 ? 'Start Marking NC' : `Next Point (${ncGuidePoints.length}/3)`}
                              </button>
                            </div>
                          ) : (
                            <div style={{ fontSize: '0.7rem', color: '#eab308', fontWeight: 600, padding: '2px 0' }}>
                              ✓ NC region defined
                            </div>
                          )}
                          {ncGuidePoints.length > 0 && (
                            <button onClick={() => { setNcGuidePoints([]); forceUpdate(); }}
                              className="tavi-button tavi-button-cancel"
                              style={{ width: '100%', fontSize: '0.68rem', padding: '3px', marginTop: 4 }}>
                              ↻ Clear
                            </button>
                          )}
                        </Section>

                        {/* ── 5. Coronary Ostia ── */}
                        <Section num="5" title="Coronary Ostia">
                          <PlaceRow label="RCO" captured={!!session.rightOstiumSnapshot}
                            onPlace={() => enableProbeTool()}
                            onConfirm={() => captureCoronaryPoint('right')}
                            onUndo={() => { session.rightOstiumSnapshot = undefined; session.recompute(); enableProbeTool(); forceUpdate(); }} />
                          <PlaceRow label="LCO" captured={!!session.leftOstiumSnapshot}
                            onPlace={() => enableProbeTool()}
                            onConfirm={() => captureCoronaryPoint('left')}
                            onUndo={() => { session.leftOstiumSnapshot = undefined; session.recompute(); enableProbeTool(); forceUpdate(); }} />
                        </Section>

                        {/* ── 6. Cusp Hinge Points ── */}
                        <Section num="6" title="Cusp Hinge Points">
                          <PlaceRow label="LCH" captured={!!cuspPoints.lcc}
                            onPlace={() => enableProbeTool()}
                            onConfirm={() => captureCuspFromMPR('lcc')}
                            onUndo={() => { setCuspPoints(p => ({ ...p, lcc: undefined })); session.cuspLCC = undefined; session.recompute(); enableProbeTool(); forceUpdate(); }} />
                          <PlaceRow label="RCH" captured={!!cuspPoints.rcc}
                            onPlace={() => enableProbeTool()}
                            onConfirm={() => captureCuspFromMPR('rcc')}
                            onUndo={() => { setCuspPoints(p => ({ ...p, rcc: undefined })); session.cuspRCC = undefined; session.recompute(); enableProbeTool(); forceUpdate(); }} />

                          {/* NCH — auto-estimated from LCH+RCH */}
                          {cuspPoints.lcc && cuspPoints.rcc && !cuspPoints.ncc && (
                            <button onClick={() => {
                              const lcc = cuspPoints.lcc!, rcc = cuspPoints.rcc!;
                              const mid = { x: (lcc.x+rcc.x)/2, y: (lcc.y+rcc.y)/2, z: (lcc.z+rcc.z)/2 };
                              const lcrc = { x: rcc.x-lcc.x, y: rcc.y-lcc.y, z: rcc.z-lcc.z };
                              const lcrcLen = Math.sqrt(lcrc.x**2+lcrc.y**2+lcrc.z**2);
                              const perpDist = (Math.sqrt(3)/2) * lcrcLen;
                              let perp = { x: lcrc.y*1-lcrc.z*0, y: lcrc.z*0-lcrc.x*1, z: lcrc.x*0-lcrc.y*0 };
                              const pLen = Math.sqrt(perp.x**2+perp.y**2+perp.z**2);
                              if (pLen > 0.001) { perp.x/=pLen; perp.y/=pLen; perp.z/=pLen; }
                              if (perp.y < 0) { perp.x=-perp.x; perp.y=-perp.y; perp.z=-perp.z; }
                              const nccEst = { x: mid.x+perp.x*perpDist, y: mid.y+perp.y*perpDist, z: mid.z+perp.z*perpDist };
                              session.cuspNCC = nccEst;
                              setCuspPoints(prev => ({ ...prev, ncc: nccEst }));
                              session.recompute(); enableProbeTool(); forceUpdate();
                            }}
                              className="tavi-button tavi-button-capture"
                              style={{ width: '100%', fontSize: '0.72rem', padding: '4px 8px', marginBottom: 3 }}>
                              Estimate NCH
                            </button>
                          )}
                          {cuspPoints.ncc && (
                            <div style={{ display: 'flex', gap: 4, marginBottom: 3 }}>
                              <button onClick={() => enableProbeTool()}
                                className="tavi-button tavi-button-captured"
                                style={{ flex: 1, fontSize: '0.72rem', padding: '4px 6px' }}>✓ NCH</button>
                              <button onClick={() => captureCuspFromMPR('ncc')}
                                className="tavi-button tavi-button-capture"
                                style={{ flex: 'none', fontSize: '0.72rem', padding: '4px 8px' }}>Update</button>
                              <button onClick={() => { setCuspPoints(p => ({ ...p, ncc: undefined })); session.cuspNCC = undefined; session.recompute(); forceUpdate(); }}
                                className="tavi-button tavi-button-cancel" style={{ flex: 'none', fontSize: '0.72rem', padding: '4px 6px' }}>↻</button>
                            </div>
                          )}
                          {!cuspPoints.lcc && !cuspPoints.rcc && !cuspPoints.ncc && (
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', padding: '2px 0' }}>Place LCH + RCH first, then NCH will be estimated</div>
                          )}
                        </Section>

                        {/* ── 6. Proceed to Oblique Annulus Tracing ── */}
                        <Section num="6" title="Annulus Tracing">
                          {cuspPoints.lcc && cuspPoints.rcc && cuspPoints.ncc ? (
                            <button
                              onClick={() => {
                                const lcc = cuspPoints.lcc!, ncc = cuspPoints.ncc!, rcc = cuspPoints.rcc!;
                                const success = session.captureThreePointAnnulusPlane(lcc, ncc, rcc);
                                if (!success || !session.annulusPlaneNormal || !session.annulusPlaneCentroid) return;
                                const axisDir = session.annulusPlaneNormal;
                                const center = session.annulusPlaneCentroid;
                                const halfLen = 25;
                                session.capturePointSnapshots(
                                  [{ worldPoint: TAVIGeometry.vectorAdd(center, TAVIGeometry.vectorScale(axisDir, -halfLen)) },
                                   { worldPoint: TAVIGeometry.vectorAdd(center, TAVIGeometry.vectorScale(axisDir, halfLen)) }],
                                  TAVIStructureAorticAxis
                                );
                                setNcGuidePoints([]); // Clear NC guide overlay
                                onViewportModeChange('tavi-oblique');
                                enterDoubleObliqueMode(renderingEngineId);
                                setTimeout(() => {
                                  const ctrl = new DoubleObliqueController(renderingEngineId, 'axial', 'coronal');
                                  ctrl.initialize(center, axisDir);
                                  controllerRef.current = ctrl;
                                  ctrl.alignToPlane(session.annulusPlaneNormal!, session.annulusPlaneCentroid!);
                                  disableProbeTool();
                                  setWorkflowPhase('annulus-tracing');
                                  forceUpdate();
                                }, 200);
                              }}
                              className="tavi-button tavi-button-capture"
                              style={{ width: '100%', padding: '8px', fontSize: '0.78rem', fontWeight: 600 }}>
                              Proceed to Annulus Tracing →
                            </button>
                          ) : (
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', padding: '2px 0' }}>
                              Complete cusp hinge points first (LCH + RCH + NCH)
                            </div>
                          )}
                        </Section>
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* Centerline Review Phase — user verifies/adjusts the axis on double-oblique views */}
              {workflowPhase === 'centerline-review' && (
                <div style={{ marginBottom: 8 }}>
                  <h4 style={{ margin: '0 0 8px', fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                    Centerline Review
                  </h4>
                  <p className="tavi-step-hint">
                    Verify the aortic centerline. <strong>Scroll right panel</strong> to translate along axis.
                    <strong> Scroll left panel</strong> to rotate.
                    Mark coronary ostia before proceeding to cusp definition.
                  </p>

                  {/* Coronary Ostium Capture (optional, before cusp definition) */}
                  <div style={{ margin: '8px 0', padding: '6px 8px', background: 'color-mix(in oklch, var(--nd-ink) 6%, transparent)', borderRadius: 6, border: '1px solid rgba(255,255,255,0.08)' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: 4 }}>
                      Coronary Ostia (scroll right panel to ostium level, click to mark)
                    </div>
                    <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                      <button
                        onClick={() => { enableProbeTool(); }}
                        className={`tavi-button ${session.leftOstiumSnapshot ? 'tavi-button-captured' : ''}`}
                        style={{ flex: 1, fontSize: '0.72rem', padding: '4px 6px' }}
                      >
                        {session.leftOstiumSnapshot ? '✓ LCO' : 'Place LCO'}
                      </button>
                      <button
                        onClick={() => {
                          if (!session.leftOstiumSnapshot) {
                            captureCoronaryPoint('left');
                          }
                        }}
                        className="tavi-button tavi-button-capture"
                        style={{ flex: 'none', fontSize: '0.72rem', padding: '4px 8px' }}
                        disabled={!!session.leftOstiumSnapshot}
                      >
                        Confirm
                      </button>
                      {session.leftOstiumSnapshot && (
                        <button
                          onClick={() => {
                            session.leftOstiumSnapshot = undefined;
                            session.recompute();
                            enableProbeTool();
                            forceUpdate();
                          }}
                          className="tavi-button tavi-button-cancel"
                          style={{ flex: 'none', fontSize: '0.72rem', padding: '4px 6px' }}
                        >
                          ↻
                        </button>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button
                        onClick={() => { enableProbeTool(); }}
                        className={`tavi-button ${session.rightOstiumSnapshot ? 'tavi-button-captured' : ''}`}
                        style={{ flex: 1, fontSize: '0.72rem', padding: '4px 6px' }}
                      >
                        {session.rightOstiumSnapshot ? '✓ RCO' : 'Place RCO'}
                      </button>
                      <button
                        onClick={() => {
                          if (!session.rightOstiumSnapshot) {
                            captureCoronaryPoint('right');
                          }
                        }}
                        className="tavi-button tavi-button-capture"
                        style={{ flex: 'none', fontSize: '0.72rem', padding: '4px 8px' }}
                        disabled={!!session.rightOstiumSnapshot}
                      >
                        Confirm
                      </button>
                      {session.rightOstiumSnapshot && (
                        <button
                          onClick={() => {
                            session.rightOstiumSnapshot = undefined;
                            session.recompute();
                            enableProbeTool();
                            forceUpdate();
                          }}
                          className="tavi-button tavi-button-cancel"
                          style={{ flex: 'none', fontSize: '0.72rem', padding: '4px 6px' }}
                        >
                          ↻
                        </button>
                      )}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <button onClick={confirmCenterline} className="tavi-button tavi-button-capture" style={{ flex: 1 }}>
                      Confirm Axis &rarr; Define Cusps
                    </button>
                    <button onClick={() => {
                      onViewportModeChange('tavi-crosshair');
                      controllerRef.current?.dispose();
                      controllerRef.current = null;
                      setWorkflowPhase('axis-validation');
                    }} className="tavi-button" style={{ flex: 'none', padding: '0 12px' }}>
                      Back
                    </button>
                  </div>
                </div>
              )}

              {/* Cusp Definition Phase */}
              {workflowPhase === 'cusp-definition' && (
                <div>
                  {/* Coronary Ostia quick-capture (also available during cusp definition) */}
                  <div style={{ margin: '0 0 8px', padding: '6px 8px', background: 'color-mix(in oklch, var(--nd-ink) 6%, transparent)', borderRadius: 6, border: '1px solid rgba(255,255,255,0.08)' }}>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginBottom: 4 }}>
                      Coronary Ostia
                    </div>
                    <div style={{ display: 'flex', gap: 4, marginBottom: 3 }}>
                      <button onClick={() => enableProbeTool()}
                        className={`tavi-button ${session.leftOstiumSnapshot ? 'tavi-button-captured' : ''}`}
                        style={{ flex: 1, fontSize: '0.7rem', padding: '3px 6px' }}>
                        {session.leftOstiumSnapshot ? '✓ LCO' : 'Place LCO'}
                      </button>
                      <button onClick={() => captureCoronaryPoint('left')}
                        className="tavi-button tavi-button-capture"
                        style={{ flex: 'none', fontSize: '0.7rem', padding: '3px 6px' }}
                        disabled={!!session.leftOstiumSnapshot}>Confirm</button>
                      {session.leftOstiumSnapshot && (
                        <button onClick={() => { session.leftOstiumSnapshot = undefined; session.recompute(); enableProbeTool(); forceUpdate(); }}
                          className="tavi-button tavi-button-cancel" style={{ flex: 'none', fontSize: '0.7rem', padding: '3px 5px' }}>↻</button>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button onClick={() => enableProbeTool()}
                        className={`tavi-button ${session.rightOstiumSnapshot ? 'tavi-button-captured' : ''}`}
                        style={{ flex: 1, fontSize: '0.7rem', padding: '3px 6px' }}>
                        {session.rightOstiumSnapshot ? '✓ RCO' : 'Place RCO'}
                      </button>
                      <button onClick={() => captureCoronaryPoint('right')}
                        className="tavi-button tavi-button-capture"
                        style={{ flex: 'none', fontSize: '0.7rem', padding: '3px 6px' }}
                        disabled={!!session.rightOstiumSnapshot}>Confirm</button>
                      {session.rightOstiumSnapshot && (
                        <button onClick={() => { session.rightOstiumSnapshot = undefined; session.recompute(); enableProbeTool(); forceUpdate(); }}
                          className="tavi-button tavi-button-cancel" style={{ flex: 'none', fontSize: '0.7rem', padding: '3px 5px' }}>↻</button>
                      )}
                    </div>
                  </div>

                  <h4 style={{ margin: '0 0 8px', fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                    Three-Point Cusp Definition
                  </h4>

                  {/* Cusp checklist with Re-place buttons */}
                  <div className="tavi-checklist" style={{ marginBottom: 8 }}>
                    <div className={`tavi-checklist-item ${cuspStep === 'lcc' ? 'active' : ''} ${cuspPoints.lcc ? 'captured' : ''}`}>
                      <span className={`tavi-check-icon ${cuspPoints.lcc ? 'done' : ''}`}>
                        {cuspPoints.lcc ? '✓' : '1'}
                      </span>
                      <span className="tavi-checklist-label" style={{ flex: 1 }}>Left Cusp Hinge (LCH)</span>
                      {cuspPoints.lcc && cuspStep !== 'lcc' && (
                        <button
                          onClick={() => { setCuspPoints(p => ({ ...p, lcc: undefined })); setCuspStep('lcc'); setCuspPlaced(false); enableProbeTool(); }}
                          className="tavi-button"
                          style={{ fontSize: '0.65rem', padding: '2px 6px', color: '#f0883e', flex: 'none' }}
                        >Re-place</button>
                      )}
                    </div>
                    <div className={`tavi-checklist-item ${cuspStep === 'ncc' ? 'active' : ''} ${cuspPoints.ncc ? 'captured' : ''}`}>
                      <span className={`tavi-check-icon ${cuspPoints.ncc ? 'done' : ''}`}>
                        {cuspPoints.ncc ? '✓' : '2'}
                      </span>
                      <span className="tavi-checklist-label" style={{ flex: 1 }}>Non-Coronary Hinge (NCH)</span>
                      {cuspPoints.ncc && cuspStep !== 'ncc' && (
                        <button
                          onClick={() => { setCuspPoints(p => ({ ...p, ncc: undefined })); setCuspStep('ncc'); setCuspPlaced(false); enableProbeTool(); }}
                          className="tavi-button"
                          style={{ fontSize: '0.65rem', padding: '2px 6px', color: '#f0883e', flex: 'none' }}
                        >Re-place</button>
                      )}
                    </div>
                    <div className={`tavi-checklist-item ${cuspStep === 'rcc' ? 'active' : ''} ${cuspPoints.rcc ? 'captured' : ''}`}>
                      <span className={`tavi-check-icon ${cuspPoints.rcc ? 'done' : ''}`}>
                        {cuspPoints.rcc ? '✓' : '3'}
                      </span>
                      <span className="tavi-checklist-label" style={{ flex: 1 }}>Right Cusp Hinge (RCH)</span>
                      {cuspPoints.rcc && cuspStep !== 'rcc' && (
                        <button
                          onClick={() => { setCuspPoints(p => ({ ...p, rcc: undefined })); setCuspStep('rcc'); setCuspPlaced(false); enableProbeTool(); }}
                          className="tavi-button"
                          style={{ fontSize: '0.65rem', padding: '2px 6px', color: '#f0883e', flex: 'none' }}
                        >Re-place</button>
                      )}
                    </div>
                  </div>

                  {cuspRotating && (
                    <p className="tavi-step-hint" style={{ color: 'var(--accent)' }}>
                      Rotating to next cusp position...
                    </p>
                  )}

                  {cuspStep !== 'verify' && !cuspRotating && (
                    <>
                      <p className="tavi-step-hint">
                        {cuspStep === 'lcc' && 'Find the LCC hinge point (nadir). Scroll RIGHT to translate, LEFT to rotate. Click to place a point, then Confirm.'}
                        {cuspStep === 'ncc' && 'Now find NCC nadir. Scroll RIGHT to translate, LEFT to rotate. Click to place, then Confirm.'}
                        {cuspStep === 'rcc' && 'Find RCC nadir. Scroll RIGHT to translate, LEFT to rotate. Click to place, then Confirm.'}
                      </p>
                      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                        {!cuspPlaced ? (
                          <button
                            onClick={() => {
                              enableProbeTool();
                              setCuspPlaced(false);
                            }}
                            className="tavi-button"
                            style={{ flex: 1 }}
                          >
                            Place {cuspStep.toUpperCase()} (click on image)
                          </button>
                        ) : (
                          <>
                            <button
                              onClick={() => {
                                captureCuspPoint();
                                setCuspPlaced(false);
                              }}
                              className="tavi-button tavi-button-capture"
                              style={{ flex: 1 }}
                            >
                              Confirm {cuspStep.toUpperCase()}
                            </button>
                            <button
                              onClick={() => {
                                // Remove last probe annotation without capturing
                                const engine = getEngine();
                                if (engine) {
                                  for (const vpId of ['axial', 'coronal', 'sagittal']) {
                                    const vp = engine.getViewport(vpId);
                                    if (!vp?.element) continue;
                                    const probes = cornerstoneTools.annotation.state.getAnnotations('Probe', vp.element);
                                    if (probes && probes.length > 0) {
                                      const uid = probes[probes.length - 1].annotationUID;
                                      if (uid) cornerstoneTools.annotation.state.removeAnnotation(uid);
                                    }
                                  }
                                }
                                setCuspPlaced(false);
                              }}
                              className="tavi-button tavi-button-cancel"
                              style={{ flex: 'none', padding: '0 10px' }}
                            >
                              Cancel
                            </button>
                          </>
                        )}
                        <button onClick={resetCusps} className="tavi-button tavi-button-cancel" style={{ flex: 'none', padding: '0 12px' }}>
                          Reset
                        </button>
                      </div>
                    </>
                  )}

                  {cuspStep === 'verify' && (
                    <>
                      <p className="tavi-step-hint">
                        Plane defined. Scroll up and down to verify all 3 cusps appear and disappear at the same time.
                        This is critical — errors here affect all subsequent measurements.
                      </p>
                      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                        <button onClick={confirmAnnulusPlane} className="tavi-button tavi-button-capture" style={{ flex: 1 }}>
                          Confirm Plane
                        </button>
                        <button onClick={resetCusps} className="tavi-button tavi-button-cancel" style={{ flex: 1 }}>
                          Re-pick
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Annulus Tracing Phase */}
              {workflowPhase === 'annulus-tracing' && (
                <div>
                  {/* Back button + cusp status */}
                  <div style={{ display: 'flex', gap: 4, marginBottom: 8, alignItems: 'center' }}>
                    <button
                      onClick={() => {
                        // Go back to MPR views for cusp adjustment
                        // Clean up contour tool and annulus data so re-entry is clean
                        contourToolRef.current?.disable();
                        contourToolRef.current = null;
                        controllerRef.current?.dispose();
                        controllerRef.current = null;
                        session.annulusContourSnapshot = undefined;
                        session.annulusRawContourPoints = [];
                        session.recompute();
                        onViewportModeChange('tavi-crosshair');
                        setWorkflowPhase('axis-validation');
                        setContourStarted(false);
                        setContourClosed(false);
                        setContourPointCount(0);
                        forceUpdate();
                      }}
                      className="tavi-button"
                      style={{ flex: 'none', fontSize: '0.72rem', padding: '4px 10px' }}>
                      ← Back to Cusps
                    </button>
                    <div style={{ flex: 1, display: 'flex', gap: 6, justifyContent: 'flex-end', fontSize: '0.68rem' }}>
                      <span style={{ color: cuspPoints.lcc ? '#3fb950' : '#f85149' }}>LC{cuspPoints.lcc ? '✓' : '✗'}</span>
                      <span style={{ color: cuspPoints.rcc ? '#3fb950' : '#f85149' }}>RC{cuspPoints.rcc ? '✓' : '✗'}</span>
                      <span style={{ color: cuspPoints.ncc ? '#3fb950' : '#f85149' }}>NC{cuspPoints.ncc ? '✓' : '✗'}</span>
                      <span style={{ color: session.rightOstiumSnapshot ? '#3fb950' : '#8b949e' }}>RCO{session.rightOstiumSnapshot ? '✓' : ''}</span>
                      <span style={{ color: session.leftOstiumSnapshot ? '#3fb950' : '#8b949e' }}>LCO{session.leftOstiumSnapshot ? '✓' : ''}</span>
                    </div>
                  </div>

                  <h4 style={{ margin: '0 0 8px', fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                    Annulus Plane & Contour
                  </h4>

                  {/* Pre-contour: adjust cusps from oblique view */}
                  {!contourStarted && !contourClosed && (
                    <>
                      <p className="tavi-step-hint">
                        Verify cusp positions on the working view (right). Use <strong>Probe</strong> to re-place any cusp, then click Update.
                        Scroll to fine-tune the plane. When ready, click <strong>Start Contour</strong>.
                      </p>

                      {/* Cusp adjustment from oblique views */}
                      <div style={{ margin: '0 0 8px', padding: '6px 8px', background: 'color-mix(in oklch, var(--nd-ink) 6%, transparent)', borderRadius: 6, border: '1px solid rgba(255,255,255,0.08)' }}>
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                          Adjust Cusps (oblique view)
                        </div>
                        {(['lcc', 'rcc', 'ncc'] as const).map((cusp) => {
                          const label = cusp.toUpperCase();
                          const pt = cusp === 'lcc' ? cuspPoints.lcc : cusp === 'rcc' ? cuspPoints.rcc : cuspPoints.ncc;
                          return (
                            <div key={cusp} style={{ display: 'flex', gap: 4, marginBottom: 3, alignItems: 'center' }}>
                              <span style={{ fontSize: '0.72rem', fontWeight: 600, color: pt ? '#3fb950' : '#f85149', width: 28, flexShrink: 0 }}>
                                {pt ? '✓' : '○'} {label}
                              </span>
                              <button onClick={() => enableProbeTool()}
                                className="tavi-button"
                                style={{ flex: 1, fontSize: '0.68rem', padding: '3px 6px' }}>
                                {pt ? 'Re-place' : 'Place'}
                              </button>
                              <button onClick={() => {
                                // Capture from oblique viewports
                                const engine = cornerstone.getRenderingEngine(renderingEngineId);
                                if (!engine) return;
                                let ann: any = null;
                                for (const vpId of ['coronal', 'axial', 'sagittal']) {
                                  const vp = engine.getViewport(vpId);
                                  if (!vp?.element) continue;
                                  const probes = cornerstoneTools.annotation.state.getAnnotations('Probe', vp.element);
                                  if (probes?.length) { ann = probes[probes.length - 1]; break; }
                                }
                                if (!ann) return;
                                const p = ann.data.handles.points[0];
                                const wp: TAVIVector3D = { x: p[0], y: p[1], z: p[2] };
                                // Clean up probes
                                for (const vpId of ['coronal', 'axial', 'sagittal']) {
                                  const vp = engine.getViewport(vpId);
                                  if (!vp?.element) continue;
                                  const probes = cornerstoneTools.annotation.state.getAnnotations('Probe', vp.element);
                                  if (probes) probes.forEach((pr: any) => { if (pr.annotationUID) cornerstoneTools.annotation.state.removeAnnotation(pr.annotationUID); });
                                }
                                if (cusp === 'lcc') { session.cuspLCC = wp; setCuspPoints(prev => ({ ...prev, lcc: wp })); }
                                if (cusp === 'rcc') { session.cuspRCC = wp; setCuspPoints(prev => ({ ...prev, rcc: wp })); }
                                if (cusp === 'ncc') { session.cuspNCC = wp; setCuspPoints(prev => ({ ...prev, ncc: wp })); }
                                session.recompute();
                                // Re-compute annulus plane and re-align
                                if (cuspPoints.lcc && cuspPoints.rcc && cuspPoints.ncc) {
                                  const l = cusp === 'lcc' ? wp : cuspPoints.lcc;
                                  const r = cusp === 'rcc' ? wp : cuspPoints.rcc;
                                  const n = cusp === 'ncc' ? wp : cuspPoints.ncc;
                                  session.captureThreePointAnnulusPlane(l, r, n);
                                  if (session.annulusPlaneNormal && session.annulusPlaneCentroid) {
                                    controllerRef.current?.alignToPlane(session.annulusPlaneNormal, session.annulusPlaneCentroid);
                                  }
                                }
                                forceUpdate();
                              }}
                                className="tavi-button tavi-button-capture"
                                style={{ flex: 'none', fontSize: '0.68rem', padding: '3px 8px' }}>
                                Update
                              </button>
                            </div>
                          );
                        })}
                      </div>

                      <button
                        onClick={() => {
                          setContourStarted(true);
                          // Initialize contour tool here
                          controllerRef.current?.lockScrolling();
                        }}
                        className="tavi-button tavi-button-capture"
                        style={{ width: '100%', padding: '8px', fontSize: '0.78rem', fontWeight: 600 }}>
                        Start Contour Tracing
                      </button>
                    </>
                  )}

                  {/* Active contour tracing */}
                  {contourStarted && !contourClosed && (
                    <>
                      <p className="tavi-step-hint">
                        Click points along the outer annulus boundary in the working plane (right).
                        Points are locked to the annulus plane.
                      </p>
                      <div className="tavi-report-grid" style={{ marginBottom: 8 }}>
                        <Row label="Points placed" value={`${contourPointCount}`}
                          warn={contourPointCount > 0 && contourPointCount < 8} />
                      </div>
                      {contourPointCount < 8 && contourPointCount > 0 && (
                        <div className="tavi-calcium-note">
                          Place at least 8 points for an accurate contour. 12-20 points recommended.
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                        <button
                          onClick={closeContour}
                          className="tavi-button tavi-button-capture"
                          style={{ flex: 1 }}
                          disabled={contourPointCount < 3}
                        >
                          Close Contour
                        </button>
                        <button onClick={undoContourPoint} className="tavi-button" style={{ flex: 1 }}
                          disabled={contourPointCount === 0}>
                          Undo
                        </button>
                        <button onClick={() => { clearContour(); setContourStarted(false); }} className="tavi-button tavi-button-cancel" style={{ flex: 1 }}
                          disabled={contourPointCount === 0}>
                          Clear
                        </button>
                      </div>
                    </>
                  )}

                  {/* Contour closed — review and confirm */}
                  {contourClosed && (
                    <>
                      <p className="tavi-step-hint">
                        Contour closed ({contourPointCount} points). Drag individual markers to fine-tune their positions.
                        Points snap to the annulus plane when dragged.
                      </p>

                      {/* Preview geometry from raw clicked points */}
                      {(() => {
                        const tool = contourToolRef.current;
                        if (!tool || !session.annulusPlaneNormal) return null;
                        const pts = tool.getWorldPoints();
                        const geo = pts.length >= 3
                          ? TAVIGeometry.geometryForWorldContour(pts, session.annulusPlaneNormal)
                          : null;
                        if (!geo) return null;
                        return (
                          <div className="tavi-report-grid" style={{ margin: '8px 0' }}>
                            <Row label="Perimeter" value={`${fmt(geo.perimeterMm)} mm (ø ${fmt(dPerim(geo.perimeterMm))} mm)`} />
                            <Row label="Area" value={`${fmt(geo.areaMm2)} mm² (ø ${fmt(dArea(geo.areaMm2))} mm)`} />
                            <Row label="Eccentricity" value={`${fmt(ecc(geo), 2)} (${fmt(geo.minimumDiameterMm)} x ${fmt(geo.maximumDiameterMm)} mm)`} />
                          </div>
                        );
                      })()}

                      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                        <button onClick={confirmAnnulusContour} className="tavi-button tavi-button-capture" style={{ flex: 1 }}>
                          Confirm Annulus
                        </button>
                        <button onClick={clearContour} className="tavi-button tavi-button-cancel" style={{ flex: 1 }}>
                          Redo
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Coronary Heights + Multi-Level Phase */}
              {workflowPhase === 'coronary-heights' && (
                <div>
                  {/* Back to Annulus button */}
                  <div style={{ display: 'flex', gap: 4, marginBottom: 8, alignItems: 'center' }}>
                    <button
                      onClick={() => {
                        // Go back to annulus tracing — clear coronary data, re-init annulus
                        session.leftOstiumSnapshot = undefined;
                        session.rightOstiumSnapshot = undefined;
                        session.annulusContourSnapshot = undefined;
                        session.annulusRawContourPoints = [];
                        session.recompute();
                        contourToolRef.current?.disable();
                        contourToolRef.current = null;
                        setWorkflowPhase('annulus-tracing');
                        setContourStarted(false);
                        setContourClosed(false);
                        setContourPointCount(0);
                        setCoronaryStep('navigate-lca');
                        if (session.annulusPlaneNormal && session.annulusPlaneCentroid) {
                          controllerRef.current?.alignToPlane(session.annulusPlaneNormal, session.annulusPlaneCentroid);
                        }
                        forceUpdate();
                      }}
                      className="tavi-button"
                      style={{ flex: 'none', fontSize: '0.72rem', padding: '4px 10px' }}>
                      ← Back to Annulus
                    </button>
                  </div>

                  <h4 style={{ margin: '0 0 8px', fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                    Coronary Heights & Cross-Sections
                  </h4>

                  {/* Annulus summary */}
                  {annulus && (
                    <div className="tavi-report-grid" style={{ marginBottom: 8 }}>
                      <Row label="Perimeter" value={`${fmt(annulus.perimeterMm)} mm (ø ${fmt(dPerim(annulus.perimeterMm))} mm)`} />
                      <Row label="Area" value={`${fmt(annulus.areaMm2)} mm²`} />
                      <Row label="Eccentricity" value={`${fmt(ecc(annulus), 2)}`} />
                    </div>
                  )}

                  {/* LCA capture */}
                  {(coronaryStep === 'capture-lca') && (
                    <>
                      <p className="tavi-step-hint">
                        The view has been auto-navigated to the estimated left coronary artery position.
                        Click the lowest part of the left coronary ostium.
                      </p>
                      <button onClick={() => captureCoronaryPoint('left')} className="tavi-button tavi-button-capture" style={{ marginTop: 8, width: '100%' }}>
                        Capture LCA Ostium
                      </button>
                    </>
                  )}

                  {/* RCA capture */}
                  {coronaryStep === 'capture-rca' && (
                    <>
                      <p className="tavi-step-hint">
                        LCA captured. The view has been rotated to the estimated right coronary artery position.
                        Click the lowest part of the right coronary ostium.
                      </p>
                      {session.leftCoronaryHeightMm != null && (
                        <div className="tavi-report-grid" style={{ marginBottom: 8 }}>
                          <Row label="LCO Height" value={`${fmt(session.leftCoronaryHeightMm)} mm`}
                            warn={session.leftCoronaryHeightMm < 10} />
                        </div>
                      )}
                      <button onClick={() => captureCoronaryPoint('right')} className="tavi-button tavi-button-capture" style={{ marginTop: 8, width: '100%' }}>
                        Capture RCA Ostium
                      </button>
                    </>
                  )}

                  {/* Multi-level generation */}
                  {coronaryStep === 'multi-level' && (
                    <>
                      <div className="tavi-report-grid" style={{ marginBottom: 8 }}>
                        <Row label="LCO Height" value={`${fmt(session.leftCoronaryHeightMm)} mm`}
                          warn={session.leftCoronaryHeightMm != null && session.leftCoronaryHeightMm < 10} />
                        <Row label="RCO Height" value={`${fmt(session.rightCoronaryHeightMm)} mm`}
                          warn={session.rightCoronaryHeightMm != null && session.rightCoronaryHeightMm < 10} />
                      </div>
                      <p className="tavi-step-hint">
                        Both coronary ostia captured. Generate cross-section thumbnails at multiple levels above and below the annulus.
                      </p>
                      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                        <button
                          onClick={generateMultiLevel}
                          className="tavi-button tavi-button-capture"
                          style={{ flex: 1 }}
                          disabled={multiLevelGenerating}
                        >
                          {multiLevelGenerating ? 'Generating...' : 'Generate Cross-Sections'}
                        </button>
                        <button
                          onClick={editAnnulus}
                          className="tavi-button"
                          style={{ flex: 'none', padding: '0 10px', fontSize: '0.75rem' }}
                        >
                          Edit Annulus
                        </button>
                      </div>
                    </>
                  )}

                  {/* Done — show results */}
                  {coronaryStep === 'done' && (
                    <>
                      <div className="tavi-report-grid" style={{ marginBottom: 8 }}>
                        <Row label="LCO Height" value={`${fmt(session.leftCoronaryHeightMm)} mm`}
                          warn={session.leftCoronaryHeightMm != null && session.leftCoronaryHeightMm < 10} />
                        <Row label="RCO Height" value={`${fmt(session.rightCoronaryHeightMm)} mm`}
                          warn={session.rightCoronaryHeightMm != null && session.rightCoronaryHeightMm < 10} />
                      </div>

                      {/* Multi-level thumbnail grid */}
                      {multiLevelThumbnails.size > 0 && (
                        <div style={{ marginBottom: 12 }}>
                          <h4 style={{ margin: '0 0 6px', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>LVOT</h4>
                          <div className="tavi-multilevel-grid">
                            {[-15, -10, -5].map(dist => {
                              const thumb = multiLevelThumbnails.get(dist);
                              return (
                                <div key={dist} className="tavi-multilevel-item" onClick={() => {
                                  const controller = controllerRef.current;
                                  const centroid = session.annulusPlaneCentroid;
                                  if (controller && centroid) controller.showPlaneAtDistanceFromOrigin(centroid, dist);
                                }}>
                                  {thumb && <img src={thumb} alt={`${dist}mm`} className="tavi-multilevel-thumb" />}
                                  <span className="tavi-multilevel-label">{dist} mm</span>
                                </div>
                              );
                            })}
                          </div>
                          <h4 style={{ margin: '8px 0 6px', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Aortic Valve</h4>
                          <div className="tavi-multilevel-grid">
                            {[5, 10, 15].map(dist => {
                              const thumb = multiLevelThumbnails.get(dist);
                              return (
                                <div key={dist} className="tavi-multilevel-item" onClick={() => {
                                  const controller = controllerRef.current;
                                  const centroid = session.annulusPlaneCentroid;
                                  if (controller && centroid) controller.showPlaneAtDistanceFromOrigin(centroid, dist);
                                }}>
                                  {thumb && <img src={thumb} alt={`+${dist}mm`} className="tavi-multilevel-thumb" />}
                                  <span className="tavi-multilevel-label">+{dist} mm</span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={finishCoronaryPhase} className="tavi-button tavi-button-capture" style={{ flex: 1 }}>
                          View Report
                        </button>
                        <button
                          onClick={() => {
                            // Clear existing contour so re-entry is clean
                            contourToolRef.current?.disable();
                            contourToolRef.current = null;
                            session.annulusContourSnapshot = undefined;
                            session.annulusRawContourPoints = [];
                            session.recompute();
                            setWorkflowPhase('annulus-tracing');
                            setContourStarted(false);
                            setContourClosed(false);
                            setContourPointCount(0);
                            controllerRef.current?.lockScrolling();
                            if (session.annulusPlaneNormal && session.annulusPlaneCentroid) {
                              controllerRef.current?.alignToPlane(session.annulusPlaneNormal, session.annulusPlaneCentroid);
                            }
                            forceUpdate();
                          }}
                          className="tavi-button"
                          style={{ flex: 'none', padding: '0 10px', fontSize: '0.75rem' }}
                        >
                          Edit Annulus
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* ── Guided Workflow (legacy/manual steps) ── */}
            <div className="tavi-card">
              <h3 className="tavi-card-title">Guided Reporting</h3>
              <div className="tavi-checklist">
                {steps.map(step => (
                  <button
                    key={step.id}
                    className={`tavi-checklist-item ${activeStep === step.id ? 'active' : ''} ${isStepCaptured(step.id) ? 'captured' : ''}`}
                    onClick={() => { setActiveStep(step.id); setDrawingActive(false); setMultiPoints([]); }}
                  >
                    <span className={`tavi-check-icon ${isStepCaptured(step.id) ? 'done' : ''}`}>
                      {isStepCaptured(step.id) ? '✓' : step.num}
                    </span>
                    <span className="tavi-checklist-label">
                      {step.label}
                      {step.optional && <span className="tavi-optional">opt</span>}
                    </span>
                    <span className="tavi-checklist-type">{step.type === 'contour' ? '◯' : step.type === 'point' ? '·' : '···'}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* ── Draw Controls ── */}
            <div className="tavi-card">
              <h3 className="tavi-card-title">{currentStep.label}</h3>
              {!drawingActive ? (
                <>
                  <p className="tavi-step-hint">{currentStep.hint}</p>
                  {activeStep === TAVIStructureAnnulus && (
                    <div className="tavi-calcium-note">
                      <strong>Calcium Paradox:</strong> When tracing through calcium nodules, bisect the chunks — tracing inside gives larger perimeter but smaller area; tracing outside gives larger area. Take the average approach for representative dimensions.
                    </div>
                  )}
                  {currentStep.type === 'contour' ? (
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      <button
                        onClick={handleAutoDetect}
                        className="tavi-button tavi-button-capture"
                        style={{ flex: 1 }}
                        disabled={autoDetecting}
                      >
                        {autoDetecting ? 'Detecting...' : 'Auto-Detect'}
                      </button>
                      <button onClick={handleStartDrawing} className="tavi-button" style={{ flex: 1 }}>
                        Manual Draw
                      </button>
                    </div>
                  ) : activeStep === TAVIStructureAorticAxis ? (
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      <button
                        onClick={captureAxisFromCrosshairs}
                        className="tavi-button tavi-button-capture"
                        style={{ flex: 1 }}
                      >
                        From Crosshairs
                      </button>
                      <button onClick={handleStartDrawing} className="tavi-button" style={{ flex: 1 }}>
                        Place 2 Points
                      </button>
                    </div>
                  ) : (
                    <button onClick={handleStartDrawing} className="tavi-button" style={{ marginTop: 8 }}>
                      {currentStep.type === 'point' ? 'Place Point' : `Place Points (${(currentStep.id === TAVIStructureMembranousSeptum) ? '2' : '3+'})`}
                    </button>
                  )}
                  {autoDetectError && (
                    <div className="tavi-calcium-note" style={{ marginTop: 6 }}>
                      {autoDetectError}
                    </div>
                  )}
                </>
              ) : (
                <div className="tavi-draw-active">
                  <p className="tavi-draw-hint">
                    {currentStep.type === 'multi-point'
                      ? `Points collected: ${multiPoints.length} / ${(activeStep === TAVIStructureMembranousSeptum || activeStep === TAVIStructureAorticAxis) ? 2 : 3}+`
                      : currentStep.type === 'point'
                        ? 'Click on the viewport to place point'
                        : 'Draw a closed contour on the viewport'
                    }
                  </p>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={captureActiveAnnotation} className="tavi-button tavi-button-capture" style={{ flex: 1 }}>
                      {currentStep.type === 'multi-point' ? 'Add Point' : 'Capture'}
                    </button>
                    <button onClick={cancelDrawing} className="tavi-button tavi-button-cancel" style={{ flex: 1 }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div className="tavi-suggestion" style={{ marginTop: 8 }}>
                {session.nextRecommendedStepSummary()}
              </div>
            </div>

            {/* ── Planning Source ── */}
            {session.annulusSnapshot && (
              <div className="tavi-card">
                <h3 className="tavi-card-title">Planning Source</h3>
                <label className="tavi-toggle-row">
                  <input
                    type="checkbox"
                    checked={session.useAssistedAnnulusForPlanning}
                    onChange={(e) => {
                      session.useAssistedAnnulusForPlanning = e.target.checked;
                      session.recompute();
                      forceUpdate();
                    }}
                  />
                  <span>Use assisted annulus fit (ellipse)</span>
                </label>
                {session.assistedAnnulusGeometry && session.annulusGeometry && (
                  <div className="tavi-compare">
                    <div className="tavi-compare-col">
                      <span className="tavi-compare-title">Captured</span>
                      <span>P: {fmt(session.annulusGeometry.perimeterMm)} mm</span>
                      <span>A: {fmt(session.annulusGeometry.areaMm2)} mm²</span>
                      <span>ø {fmt(dPerim(session.annulusGeometry.perimeterMm))} mm</span>
                    </div>
                    <div className="tavi-compare-col">
                      <span className="tavi-compare-title">Assisted</span>
                      <span>P: {fmt(session.assistedAnnulusGeometry.perimeterMm)} mm</span>
                      <span>A: {fmt(session.assistedAnnulusGeometry.areaMm2)} mm²</span>
                      <span>ø {fmt(dPerim(session.assistedAnnulusGeometry.perimeterMm))} mm</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── Calcium ── */}
            <div className="tavi-card">
              <h3 className="tavi-card-title">Calcification</h3>
              <div className="tavi-report-grid">
                <div className="tavi-row">
                  <span className="tavi-row-label">Threshold</span>
                  <span className="tavi-row-value">
                    <input
                      type="number"
                      className="tavi-inline-input"
                      value={session.calciumThresholdHU}
                      onChange={(e) => { session.calciumThresholdHU = Number(e.target.value); session.recompute(); forceUpdate(); }}
                      style={{ width: 60 }}
                    /> HU
                  </span>
                </div>
                <div className="tavi-row">
                  <span className="tavi-row-label">Cusp Grade</span>
                  <span className="tavi-row-value">
                    <select
                      className="tavi-inline-select"
                      value={session.cuspCalcificationGrade}
                      onChange={(e) => { session.cuspCalcificationGrade = Number(e.target.value); forceUpdate(); }}
                    >
                      <option value={0}>None (0)</option>
                      <option value={1}>Mild (1)</option>
                      <option value={2}>Moderate (2)</option>
                      <option value={3}>Severe (3)</option>
                    </select>
                  </span>
                </div>
                <div className="tavi-row">
                  <span className="tavi-row-label">Annulus Grade</span>
                  <span className="tavi-row-value">
                    <select
                      className="tavi-inline-select"
                      value={session.annulusCalcificationGrade}
                      onChange={(e) => { session.annulusCalcificationGrade = Number(e.target.value); forceUpdate(); }}
                    >
                      <option value={0}>None (0)</option>
                      <option value={1}>Mild (1)</option>
                      <option value={2}>Moderate (2)</option>
                      <option value={3}>Severe (3)</option>
                    </select>
                  </span>
                </div>
                {session.annulusCalcium && (
                  <>
                    <Row label="Agatston 2D" value={fmt(session.annulusCalcium.agatstonScore2D, 0)} />
                    <Row label="Hyperdense Area" value={`${fmt(session.annulusCalcium.hyperdenseAreaMm2)} mm²`} />
                    <Row label="Ca Fraction" value={`${fmt(session.annulusCalcium.fractionAboveThreshold * 100, 0)}%`} />
                  </>
                )}
              </div>
            </div>
          </>
        )}

        {activeTab === 'report' && (
          <>
            {/* ── Export + Back ── */}
            <div className="tavi-export-bar" style={{ display: 'flex', gap: 6 }}>
              <button className="tavi-button" onClick={() => { setActiveTab('capture'); onReportToggle?.(false); }} style={{ flex: 'none', padding: '6px 12px', fontSize: '0.75rem' }}>
                ← TAVI
              </button>
              <button className="tavi-button tavi-button-export" onClick={exportReport} style={{ flex: 1 }}>
                Export Text
              </button>
              <button className="tavi-button" onClick={() => window.print()} style={{ flex: 1, fontSize: '0.75rem' }}>
                🖨 Print Report
              </button>
            </div>

            {/* ── 0. Aortic Axis ── */}
            {session.aorticAxisPointSnapshots.length >= 2 && (
              <div className="tavi-card">
                <h3 className="tavi-card-title">Aortic Axis</h3>
                <div className="tavi-report-grid">
                  <Row label="Axis Length" value={`${fmt(session.aorticAxisLengthMm)} mm`} />
                  <Row label="Angulation" value={session.aorticAxisDirection
                    ? `${fmt(session.horizontalAortaAngleDegrees)}° from horizontal`
                    : '—'} />
                </div>
              </div>
            )}

            {/* ── 1. Aortic Annulus Measurements ── */}
            <div className="tavi-card">
              <h3 className="tavi-card-title">Aortic Annulus</h3>
              {annulus ? (
                <div className="tavi-report-grid">
                  <Row label="Perimeter" value={`${fmt(annulus.perimeterMm)} mm (ø ${fmt(dPerim(annulus.perimeterMm))} mm)`} />
                  <Row label="Area" value={`${fmt(annulus.areaMm2)} mm² (ø ${fmt(dArea(annulus.areaMm2))} mm)`} />
                  <Row label="Eccentricity" value={`${fmt(ecc(annulus), 2)} (${fmt(annulus.minimumDiameterMm)} × ${fmt(annulus.maximumDiameterMm)} mm)`} />
                  <Row label="Aortic Angulation" value={`${fmt(session.horizontalAortaAngleDegrees)}°`} />
                  <Row label="Virtual Valve" value={`ø ${fmt(session.virtualValveDiameterMm)} mm`} highlight />
                  {session.useAssistedAnnulusForPlanning && (
                    <Row label="Source" value="Assisted Ellipse Fit" />
                  )}
                </div>
              ) : (
                <p className="tavi-empty">Capture annulus contour to see measurements</p>
              )}
            </div>

            {/* ── 2. Valve Sizing Recommendations ── */}
            <div className="tavi-card">
              <h3 className="tavi-card-title">Valve Sizing</h3>
              {valveRecs.length > 0 ? (
                <div className="tavi-valve-sizing">
                  {valveRecs.map((rec) => (
                    <div key={rec.family.name} className="tavi-valve-family">
                      <div className="tavi-valve-family-header">
                        <span className="tavi-valve-name">{rec.family.name}</span>
                        <span className="tavi-valve-mfr">{rec.family.manufacturer}</span>
                        <span className={`tavi-valve-type tavi-valve-type--${rec.family.type}`}>
                          {rec.family.type === 'balloon-expandable' ? 'BE' : 'SE'}
                        </span>
                      </div>
                      {rec.primarySize && (
                        <div className="tavi-valve-sizes">
                          <div className={`tavi-valve-size tavi-valve-size--primary ${rec.fitStatus !== 'in-range' ? 'tavi-valve-size--warning' : ''}`}>
                            <span className="tavi-valve-size-num">{rec.primarySize.size}mm</span>
                            <span className="tavi-valve-size-label">
                              {rec.fitStatus === 'in-range' ? 'Recommended' : rec.fitStatus === 'oversized' ? 'Max available' : 'Min available'}
                            </span>
                            <span className="tavi-valve-size-range">
                              ø {fmt(rec.primarySize.perimeterDiameterMin)}-{fmt(rec.primarySize.perimeterDiameterMax)} mm
                            </span>
                            {rec.coverIndex != null && (
                              <span className="tavi-valve-size-range" style={{ color: rec.coverIndex < 0 || rec.coverIndex > 20 ? '#f85149' : '#8b949e' }}>
                                CI: {fmt(rec.coverIndex, 1)}% | OS: {fmt(rec.oversizingPct ?? 0, 0)}%
                              </span>
                            )}
                          </div>
                          {rec.alternativeSize && (
                            <div className="tavi-valve-size tavi-valve-size--alt">
                              <span className="tavi-valve-size-num">{rec.alternativeSize.size}mm</span>
                              <span className="tavi-valve-size-label">Alternative</span>
                              <span className="tavi-valve-size-range">
                                ø {fmt(rec.alternativeSize.perimeterDiameterMin)}-{fmt(rec.alternativeSize.perimeterDiameterMax)} mm
                              </span>
                            </div>
                          )}
                          {rec.sizingWarning && (
                            <div style={{ fontSize: '0.7rem', color: '#f85149', padding: '4px 0 0', lineHeight: 1.3 }}>
                              ⚠ {rec.sizingWarning}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                  <div className="tavi-valve-deployment">
                    <span className="tavi-row-label">Deployment Ratio</span>
                    <div className="tavi-deployment-btns">
                      <button
                        className={`tavi-deploy-btn ${deploymentRatio === '80/20' ? 'active' : ''}`}
                        onClick={() => setDeploymentRatio('80/20')}
                      >80/20</button>
                      <button
                        className={`tavi-deploy-btn ${deploymentRatio === '90/10' ? 'active' : ''}`}
                        onClick={() => setDeploymentRatio('90/10')}
                      >90/10</button>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="tavi-empty">Capture annulus contour for valve recommendations</p>
              )}
            </div>

            {/* ── 3. Coronary & Risk Assessment ── */}
            <div className="tavi-card">
              <h3 className="tavi-card-title">Coronary Heights & Risk</h3>
              <div className="tavi-report-grid">
                <Row label="LCO Distance" value={session.leftCoronaryHeightMm != null ? `${fmt(session.leftCoronaryHeightMm)} mm` : '—'}
                  warn={session.leftCoronaryHeightMm != null && session.leftCoronaryHeightMm < 10} />
                <Row label="RCO Distance" value={session.rightCoronaryHeightMm != null ? `${fmt(session.rightCoronaryHeightMm)} mm` : '—'}
                  warn={session.rightCoronaryHeightMm != null && session.rightCoronaryHeightMm < 10} />
                {session.membranousSeptumLengthMm != null && (
                  <Row label="Membranous Septum" value={`${fmt(session.membranousSeptumLengthMm)} mm`}
                    warn={session.membranousSeptumLengthMm < 4} />
                )}
              </div>

              <div className="tavi-risk-section">
                <div className={`tavi-risk-item tavi-risk--${risks.coronaryObstructionRisk}`}>
                  <span className="tavi-risk-badge">{riskBadge(risks.coronaryObstructionRisk)}</span>
                  <div className="tavi-risk-content">
                    <span className="tavi-risk-title">Coronary Obstruction</span>
                    <span className="tavi-risk-note">{risks.coronaryObstructionNote}</span>
                  </div>
                </div>
                <div className={`tavi-risk-item tavi-risk--${risks.conductionDisturbanceRisk}`}>
                  <span className="tavi-risk-badge">{riskBadge(risks.conductionDisturbanceRisk)}</span>
                  <div className="tavi-risk-content">
                    <span className="tavi-risk-title">Conduction Disturbance</span>
                    <span className="tavi-risk-note">{risks.conductionDisturbanceNote}</span>
                  </div>
                </div>
                <div className={`tavi-risk-item tavi-risk--${risks.annularRuptureRisk}`}>
                  <span className="tavi-risk-badge">{riskBadge(risks.annularRuptureRisk)}</span>
                  <div className="tavi-risk-content">
                    <span className="tavi-risk-title">Annular Rupture</span>
                    <span className="tavi-risk-note">{risks.annularRuptureNote}</span>
                  </div>
                </div>
                {/* Pacemaker Risk Score */}
                {pmRisk.score > 0 && (
                  <div className={`tavi-risk-item tavi-risk--${pmRisk.score >= 5 ? 'high' : pmRisk.score >= 3 ? 'moderate' : 'low'}`}>
                    <span className="tavi-risk-badge">{pmRisk.score >= 5 ? '🔴' : pmRisk.score >= 3 ? '🟡' : '🟢'}</span>
                    <div className="tavi-risk-content">
                      <span className="tavi-risk-title">Pacemaker Risk ({pmRisk.score}/10)</span>
                      <span className="tavi-risk-note">{pmRisk.factors.join(', ')}</span>
                    </div>
                  </div>
                )}
                {/* BAV Warning */}
                {bavRisk.isSuspectedBAV && (
                  <div className="tavi-risk-item tavi-risk--high">
                    <span className="tavi-risk-badge">⚠</span>
                    <div className="tavi-risk-content">
                      <span className="tavi-risk-title">Suspected Bicuspid Valve (BAV)</span>
                      <span className="tavi-risk-note">{bavRisk.bavWarning}</span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* ── 3b. Coronary Height Stretched Vessel Views ── */}
            {(session.leftOstiumSnapshot || session.rightOstiumSnapshot) && (
              <div className="tavi-card">
                <CoronaryHeightView
                  controller={controllerRef.current}
                  renderingEngineId={renderingEngineId}
                  annulusCentroid={session.annulusPlaneCentroid}
                  annulusNormal={session.annulusPlaneNormal}
                  leftOstium={session.leftOstiumSnapshot?.worldPoint}
                  rightOstium={session.rightOstiumSnapshot?.worldPoint}
                  leftHeightMm={session.leftCoronaryHeightMm}
                  rightHeightMm={session.rightCoronaryHeightMm}
                />
              </div>
            )}

            {/* ── 3c. 3D Valve Visualization ── */}
            {session.annulusPlaneCentroid && (
              <div className="tavi-card">
                <ValveVisualization3D
                  annulusContour={session.annulusSnapshot?.worldPoints}
                  annulusNormal={session.annulusPlaneNormal}
                  annulusCentroid={session.annulusPlaneCentroid}
                  cuspLCC={session.cuspLCC}
                  cuspNCC={session.cuspNCC}
                  cuspRCC={session.cuspRCC}
                  axisDirection={session.aorticAxisDirection ?? undefined}
                  minDiameter={annulus?.minimumDiameterMm}
                  maxDiameter={annulus?.maximumDiameterMm}
                  width={0}
                  height={320}
                />
              </div>
            )}

            {/* ── 4. Implantation Plane / Fluoroscopic Planning ── */}
            <div className="tavi-card">
              <h3 className="tavi-card-title">Fluoroscopic Planning</h3>
              {fluoro ? (
                <>
                  <div className="tavi-report-grid">
                    <Row label="Coplanar View" value={angleStr(fluoro)} />
                    {session.projectionConfirmation && (
                      <>
                        <Row label="Confirmed" value={angleStr(session.projectionConfirmation.confirmationAngle)} />
                        <Row label="Difference" value={`${fmt(session.projectionConfirmation.normalDifferenceDegrees)}°`}
                          warn={session.projectionConfirmation.normalDifferenceDegrees > 10} />
                      </>
                    )}
                  </div>

                  {/* Angio Projection Simulator */}
                  <div className="angio-simulator-wrapper">
                    <AngioProjectionSimulator
                      curve={session.perpendicularityCurve}
                      raoTable={session.raoProjectionTable}
                      laoTable={session.laoProjectionTable}
                      coplanarAngle={fluoro}
                      implantationAngles={session.implantationPlaneAngles}
                      width={0}
                      height={360}
                    />
                  </div>

                  {/* Perpendicularity Plot (compact) */}
                  <div className="perp-plot-wrapper">
                    <PerpendicularityPlot
                      curve={session.perpendicularityCurve}
                      raoTable={session.raoProjectionTable}
                      laoTable={session.laoProjectionTable}
                      coplanarAngle={fluoro}
                      confirmationAngle={session.projectionConfirmation?.confirmationAngle}
                      width={0}
                      height={240}
                    />
                  </div>

                  {/* RAO/LAO Projection Table */}
                  {session.raoProjectionTable.length > 0 && (
                    <div className="tavi-projection-table">
                      <div className="tavi-projection-table-header">
                        <span>RAO/LAO</span>
                        <span>Cran/Caud for Perpendicularity</span>
                      </div>
                      {session.raoProjectionTable.map((entry) => (
                        <div key={entry.label} className="tavi-projection-table-row">
                          <span className="tavi-row-label">{entry.label}</span>
                          <span className="tavi-row-value">
                            {entry.cranialCaudalDeg >= 0 ? 'Cranial' : 'Caudal'} {Math.abs(entry.cranialCaudalDeg).toFixed(0)}°
                          </span>
                        </div>
                      ))}
                      {session.laoProjectionTable.map((entry) => (
                        <div key={entry.label} className="tavi-projection-table-row">
                          <span className="tavi-row-label">{entry.label}</span>
                          <span className="tavi-row-value">
                            {entry.cranialCaudalDeg >= 0 ? 'Cranial' : 'Caudal'} {Math.abs(entry.cranialCaudalDeg).toFixed(0)}°
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="tavi-fluoro-hint">
                    Drag on the projection curve to explore C-arm angles. Diamond markers show cusp-specific implantation planes.
                  </div>
                </>
              ) : (
                <p className="tavi-empty">Capture annulus for projection angles</p>
              )}
            </div>

            {/* ── 4b. Access Route Planning ── */}
            <div className="tavi-card">
              <h3 className="tavi-card-title">Access Planning</h3>
              <div className="tavi-report-grid">
                <div className="tavi-row">
                  <span className="tavi-row-label">Planned Access</span>
                  <span className="tavi-row-value">
                    <select
                      className="tavi-inline-select"
                      value={session.plannedAccess}
                      onChange={(e) => { session.plannedAccess = e.target.value as any; forceUpdate(); }}
                    >
                      {ACCESS_ROUTES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </span>
                </div>
                <div className="tavi-row">
                  <span className="tavi-row-label">Pigtail Access</span>
                  <span className="tavi-row-value">
                    <select
                      className="tavi-inline-select"
                      value={session.plannedPigtailAccess}
                      onChange={(e) => { session.plannedPigtailAccess = e.target.value as any; forceUpdate(); }}
                    >
                      {PIGTAIL_ACCESS_ROUTES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </span>
                </div>
              </div>
            </div>

            {/* ── 5. Structure Geometries ── */}
            <div className="tavi-card">
              <h3 className="tavi-card-title">Structure Geometries</h3>
              <div className="tavi-report-grid">
                <GeoRow label="Ascending Aorta" geo={session.ascendingAortaGeometry} />
                <GeoRow label="STJ" geo={session.stjGeometry} />
                <GeoRow label="Sinus (SOV)" geo={session.sinusGeometry} />
                <GeoRow label="Annulus" geo={annulus} />
                <GeoRow label="LVOT" geo={session.lvotGeometry} />
              </div>
            </div>

            {/* ── 6. Calcification Summary ── */}
            <div className="tavi-card">
              <h3 className="tavi-card-title">Calcification</h3>
              <div className="tavi-report-grid">
                <Row label="Cusp Grade" value={['None', 'Mild', 'Moderate', 'Severe'][session.cuspCalcificationGrade]}
                  warn={session.cuspCalcificationGrade >= 2} />
                <Row label="Annulus Grade" value={['None', 'Mild', 'Moderate', 'Severe'][session.annulusCalcificationGrade]}
                  warn={session.annulusCalcificationGrade >= 2} />
                <Row label="Threshold" value={`${session.calciumThresholdHU} HU`} />
                {session.annulusCalcium && (
                  <>
                    <Row label="Agatston 2D" value={fmt(session.annulusCalcium.agatstonScore2D, 0)} />
                    <Row label="Hyperdense Area" value={`${fmt(session.annulusCalcium.hyperdenseAreaMm2)} mm²`} />
                    <Row label="Ca Fraction" value={`${fmt(session.annulusCalcium.fractionAboveThreshold * 100, 0)}%`} />
                  </>
                )}
              </div>
            </div>

            {/* ── 7. Report Checklist ── */}
            <div className="tavi-card">
              <h3 className="tavi-card-title">Report Checklist</h3>
              <div className="tavi-report-checklist">
                <CheckItem done={session.aorticAxisPointSnapshots.length >= 2} label="Aortic axis estimation (center line)" />
                <CheckItem done={!!session.ascendingAortaGeometry} label="Aortic arch / ascending aorta view" />
                <CheckItem done={!!session.stjGeometry} label="STJ dimensions" />
                <CheckItem done={!!session.sinusGeometry} label="Sinus of Valsalva dimensions" />
                <CheckItem done={!!annulus} label="Annular plane with lasso trace" />
                <CheckItem done={!!session.lvotGeometry} label="LVOT assessment" />
                <CheckItem done={session.leftCoronaryHeightMm != null && session.rightCoronaryHeightMm != null} label="Coronary heights with virtual valve overlay" />
                <CheckItem done={!!fluoro} label="C-arm projection angles (Coplanar)" />
                <CheckItem done={session.sinusPointSnapshots.length >= 3} label="Projection confirmation (Cusp Overlap)" />
                <CheckItem done={session.membranousSeptumPointSnapshots.length >= 2} label="Septal length (conduction risk)" />
              </div>
            </div>

            {/* ── 8. Notes ── */}
            <div className="tavi-card">
              <h3 className="tavi-card-title">Comments</h3>
              <textarea
                className="tavi-notes"
                placeholder="Add clinical notes, vascular access assessment, arch morphology observations..."
                value={session.notes}
                onChange={(e) => { session.notes = e.target.value; forceUpdate(); }}
              />
            </div>
          </>
        )}

      </div>

      {/* ── Contour overlay on axial viewport — only for the active (unconfirmed) structure ── */}
      {activeContourId === TAVIStructureAscendingAorta && session.ascendingAortaSnapshot && session.ascendingAortaGeometry && (
        <ContourOverlay
          key={`asc-${refresh}`}
          renderingEngineId={renderingEngineId}
          viewportId="axial"
          contourPoints={session.ascendingAortaSnapshot.worldPoints}
          geometry={session.ascendingAortaGeometry}
          planeNormal={session.ascendingAortaSnapshot.planeNormal}
          contourColor="#3fb950"
          label="Asc. Aorta"
          handleCount={16}
          onContourEdited={(newPts, newGeo) => {
            session.ascendingAortaSnapshot = { ...session.ascendingAortaSnapshot!, worldPoints: newPts };
            session.recompute();
            setRefresh(r => r + 1);
          }}
        />
      )}
      {activeContourId === TAVIStructureSTJ && session.stjSnapshot && session.stjGeometry && (
        <ContourOverlay
          key={`stj-${refresh}`}
          renderingEngineId={renderingEngineId}
          viewportId="axial"
          contourPoints={session.stjSnapshot.worldPoints}
          geometry={session.stjGeometry}
          planeNormal={session.stjSnapshot.planeNormal}
          contourColor="#58a6ff"
          label="STJ"
          handleCount={16}
          onContourEdited={(newPts, newGeo) => {
            session.stjSnapshot = { ...session.stjSnapshot!, worldPoints: newPts };
            session.recompute();
            setRefresh(r => r + 1);
          }}
        />
      )}
      {activeContourId === TAVIStructureSinus && session.sinusSnapshot && session.sinusGeometry && (
        <ContourOverlay
          key={`sinus-${refresh}`}
          renderingEngineId={renderingEngineId}
          viewportId="axial"
          contourPoints={session.sinusSnapshot.worldPoints}
          geometry={session.sinusGeometry}
          planeNormal={session.sinusSnapshot.planeNormal}
          contourColor="#d29922"
          label="Sinus"
          handleCount={8}
          onContourEdited={(newPts, newGeo) => {
            session.sinusSnapshot = { ...session.sinusSnapshot!, worldPoints: newPts };
            session.recompute();
            setRefresh(r => r + 1);
          }}
        />
      )}

      {/* ── NC cusp guide triangle on all viewports ── */}
      {ncGuidePoints.length >= 2 && (
        <CuspTriangleOverlay
          key={`nc-tri-${refresh}`}
          renderingEngineId={renderingEngineId}
          viewportIds={['axial', 'sagittal', 'coronal']}
          points={ncGuidePoints}
        />
      )}
    </div>
  );
};

// ── Sub-components ──

function Row({ label, value, highlight, warn }: { label: string; value: string; highlight?: boolean; warn?: boolean }) {
  return (
    <div className="tavi-row">
      <span className="tavi-row-label">{label}</span>
      <span className={`tavi-row-value ${highlight ? 'tavi-row-highlight' : ''} ${warn ? 'tavi-row-warn' : ''}`}>{value}</span>
    </div>
  );
}

function GeoRow({ label, geo }: { label: string; geo?: TAVIGeometryResult | null }) {
  if (!geo) {
    return (
      <div className="tavi-row">
        <span className="tavi-row-label">{label}</span>
        <span className="tavi-row-value tavi-row-empty">—</span>
      </div>
    );
  }
  return (
    <div className="tavi-geo-row">
      <span className="tavi-row-label">{label}</span>
      <div className="tavi-geo-values">
        <span>ø {fmt(dPerim(geo.perimeterMm))} mm</span>
        <span>{fmt(geo.areaMm2)} mm²</span>
        <span>{fmt(geo.minimumDiameterMm)} × {fmt(geo.maximumDiameterMm)}</span>
      </div>
    </div>
  );
}

function CheckItem({ done, label }: { done: boolean; label: string }) {
  return (
    <div className={`tavi-check-row ${done ? 'tavi-check-done' : ''}`}>
      <span className="tavi-check-box">{done ? '✓' : '○'}</span>
      <span>{label}</span>
    </div>
  );
}
