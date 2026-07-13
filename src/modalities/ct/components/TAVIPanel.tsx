import React, { useState, useCallback, useRef, useEffect, useImperativeHandle, useMemo } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import { setActiveTool, enableProbeTool, disableProbeTool, enterDoubleObliqueMode, setDoubleObliqueCenterHandler } from '../core/toolManager';
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
import { TAVIContourSnapshot, TAVIPointSnapshot, TAVIVector3D, TAVIGeometryResult, TAVIFluoroAngleResult, SinusLabel } from '../tavi/TAVITypes';
import { recommendValveSizes, assessTAVRRisks, assessBAVRisk, computePacemakerRiskScore, ValveSizeRecommendation, resolveSelectedValve } from '../tavi/TAVIValveDatabase';
import { AngioProjectionSimulator } from './AngioProjectionSimulator';
import { PerpendicularityPlot } from './PerpendicularityPlot';
import { TAVIGeometry } from '../tavi/TAVIGeometry';
import { detectAorticAxis, detectAorticAxisLocal, AorticAxisResult, autoSegmentCrossSectionAtPlane, autoTraceAnnulusContrastEdgeAtPlane, samplePixelValuesInWorldContour, snapPointToLumenCentroid, snapPointToAxialMinimum } from '../tavi/AorticAxisDetection';
import { DoubleObliqueController } from '../tavi/DoubleObliqueController';
import { ConstrainedContourTool } from '../tavi/ConstrainedContourTool';
import { CenterlineOverlay } from '../tavi/CenterlineOverlay';
import { CuspMarkerOverlay, CuspId } from '../tavi/CuspMarkerOverlay';
import { AnnulusMeasurementOverlay } from '../tavi/AnnulusMeasurementOverlay';
import { CoronaryHeightView } from './CoronaryHeightView';
import { ValveVisualization3D } from './ValveVisualization3D';
import { ValveDeploy3D, type MeshLayer } from './ValveDeploy3D';
import { frameProfileFor, positionFrame, buildFrameMesh, buildAnnulusDiscMesh, surgicalFrameProfile } from '../tavi/ValveFrameGeometry';
import { computeDeploymentResult, type DeploymentResult } from '../tavi/ValveDeployment';
import { useAorticRootSurface } from '../tavi/useAorticRootSurface';
import { SURGICAL_BIOPROSTHESES, resolveSurgicalBioprosthesis } from '../tavi/VivProsthesisDatabase';
import { meshToBinarySTL } from '../la/stlExport';
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

function centroidOfWorldPoints(points: TAVIVector3D[]): TAVIVector3D | null {
  const valid = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
  if (valid.length === 0) return null;
  return {
    x: valid.reduce((sum, p) => sum + p.x, 0) / valid.length,
    y: valid.reduce((sum, p) => sum + p.y, 0) / valid.length,
    z: valid.reduce((sum, p) => sum + p.z, 0) / valid.length,
  };
}

function hashWorldPoints(points: TAVIVector3D[]): string {
  return points
    .map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`)
    .join('|');
}

function angleStr(a: TAVIFluoroAngleResult): string {
  return `${a.laoRaoLabel} ${fmt(a.laoRaoDegrees, 0)}° / ${a.cranialCaudalLabel} ${fmt(a.cranialCaudalDegrees, 0)}°`;
}

function resampleClosedContourByCount(points: TAVIVector3D[], targetCount: number): TAVIVector3D[] {
  if (points.length <= targetCount) return points.map(p => ({ ...p }));

  const segments: number[] = [];
  let perimeter = 0;
  for (let i = 0; i < points.length; i++) {
    const len = TAVIGeometry.vectorDistance(points[i], points[(i + 1) % points.length]);
    segments.push(len);
    perimeter += len;
  }
  if (perimeter <= 0) return points.slice(0, targetCount).map(p => ({ ...p }));

  const resampled: TAVIVector3D[] = [];
  for (let i = 0; i < targetCount; i++) {
    const targetDistance = (i / targetCount) * perimeter;
    let walked = 0;
    let segmentIndex = 0;
    while (segmentIndex < segments.length - 1 && walked + segments[segmentIndex] < targetDistance) {
      walked += segments[segmentIndex];
      segmentIndex++;
    }

    const a = points[segmentIndex];
    const b = points[(segmentIndex + 1) % points.length];
    const local = segments[segmentIndex] > 0 ? (targetDistance - walked) / segments[segmentIndex] : 0;
    resampled.push({
      x: a.x + (b.x - a.x) * local,
      y: a.y + (b.y - a.y) * local,
      z: a.z + (b.z - a.z) * local,
    });
  }

  return resampled;
}

function riskBadge(level: 'low' | 'moderate' | 'high'): string {
  if (level === 'high') return '🔴';
  if (level === 'moderate') return '🟡';
  return '🟢';
}

// ── Reusable subcomponents (hoisted OUTSIDE the parent render) ──
//
// Both PlaceRow and Section used to be declared inside the TAVIPanel render
// closure. Every render produced a brand-new function reference, which React
// treated as a different component type and remounted every instance —
// destroying the DOM nodes for every button, which collapsed focus to <body>
// and scrolled the panel to the top on every Confirm / Place click. Hoisting
// them gives each a stable identity across renders so React keeps the DOM.

const PlaceRow = ({ label, captured, onPlace, onConfirm, onUndo }: {
  label: string;
  captured: boolean;
  onPlace: () => void;
  onConfirm: () => void;
  onUndo: () => void;
}) => (
  <div className="tavi-place-row">
    <button type="button" onClick={onPlace}
      className={`tavi-button tavi-place-main ${captured ? 'tavi-button-captured' : ''}`}>
      {captured ? `✓ ${label}` : `Place ${label}`}
    </button>
    {!captured && (
      <button type="button" onClick={onConfirm}
        className="tavi-button tavi-button-capture tavi-place-confirm">Confirm</button>
    )}
    {captured && (
      <button type="button" onClick={onUndo}
        className="tavi-button tavi-button-cancel tavi-place-undo">↻</button>
    )}
  </div>
);

const Section = ({ num, title, children }: { num: string; title: string; children: React.ReactNode }) => (
  <div style={{ margin: '0 0 6px', padding: '6px 8px', background: 'color-mix(in oklch, var(--nd-ink) 6%, transparent)', borderRadius: 6, border: '1px solid rgba(255,255,255,0.08)' }}>
    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
      {num}. {title}
    </div>
    {children}
  </div>
);

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
type TAVISubtitle = 'valve' | 'as-aort' | 'viv';

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
  const [activeSubtitle, setActiveSubtitle] = useState<TAVISubtitle>('valve');
  // Deployment ratio lives on the session so the value survives resets and
  // feeds the report/simulation. Local setter mirrors onto session + triggers re-render.
  const setDeploymentRatio = useCallback((ratio: '80/20' | '90/10') => {
    session.deploymentRatio = ratio;
    session.recompute();
    setRefresh((p) => p + 1);
  }, [session]);
  const [livePerp, setLivePerp] = useState<number | null>(null);
  const [snapEnabled, setSnapEnabled] = useState(true);

  // structured workflow state — default to axis-validation (guided)
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
  const [activeCuspUpdate, setActiveCuspUpdate] = useState<'lcc' | 'ncc' | 'rcc' | null>(null);

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
  // Explicit gate for the NC-cusp probe poller. Without this, the poller in
  // `useEffect` below would consume ANY probe annotation placed during the
  // axis-validation phase — including ones meant for Per-sinus width, RCO/LCO,
  // or cusp hinge capture — and silently advance step 4 instead of letting the
  // intended Confirm handler fire.
  const [ncMarkingActive, setNcMarkingActive] = useState(false);
  const [activeSinusWidthLabel, setActiveSinusWidthLabel] = useState<SinusLabel | null>(null);
  const [sinusWidthProbeCount, setSinusWidthProbeCount] = useState(0);
  const [sinusWidthMessage, setSinusWidthMessage] = useState<string | null>(null);

  // Overlay refs (3mensio-style)
  const centerlineRef = useRef<CenterlineOverlay | null>(null);
  const cuspMarkerRef = useRef<CuspMarkerOverlay | null>(null);
  const measurementRef = useRef<AnnulusMeasurementOverlay | null>(null);

  const forceUpdate = () => setRefresh((prev) => prev + 1);
  const currentStep = steps.find(s => s.id === activeStep)!;

  const getEngine = () => {
    return cornerstone.getRenderingEngine(renderingEngineId) ?? undefined;
  };

  const getCurrentAnnulusPlaneFromWorkingView = useCallback((): {
    centroid: TAVIVector3D;
    normal: TAVIVector3D;
    viewUp?: TAVIVector3D;
  } | null => {
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    const workingVp = engine?.getViewport('coronal');
    const cam = workingVp?.getCamera();
    if (!cam?.focalPoint || !cam.viewPlaneNormal) return null;

    return {
      centroid: { x: cam.focalPoint[0], y: cam.focalPoint[1], z: cam.focalPoint[2] },
      normal: TAVIGeometry.vectorNormalize({
        x: -cam.viewPlaneNormal[0],
        y: -cam.viewPlaneNormal[1],
        z: -cam.viewPlaneNormal[2],
      }),
      viewUp: cam.viewUp
        ? { x: cam.viewUp[0], y: cam.viewUp[1], z: cam.viewUp[2] }
        : undefined,
    };
  }, [renderingEngineId]);

  const syncAnnulusPlaneFromWorkingView = useCallback(() => {
    const plane = getCurrentAnnulusPlaneFromWorkingView();
    if (!plane) return null;
    session.annulusPlaneCentroid = plane.centroid;
    session.annulusPlaneNormal = plane.normal;
    session.recompute();
    return plane;
  }, [getCurrentAnnulusPlaneFromWorkingView, session]);

  const centerDoubleObliqueView = useCallback(() => {
    const controller = controllerRef.current;
    if (!controller) return false;

    const liveContourCenter = centroidOfWorldPoints(contourToolRef.current?.getWorldPoints() ?? []);
    const savedContourCenter = centroidOfWorldPoints(session.annulusRawContourPoints);
    const target =
      liveContourCenter ??
      savedContourCenter ??
      session.activeAnnulusGeometry()?.centroid ??
      session.annulusPlaneCentroid ??
      controller.getAxisPoint();

    controller.centerOnWorldPoint(target);
    return true;
  }, [session]);

  useEffect(() => {
    setDoubleObliqueCenterHandler(centerDoubleObliqueView);
    return () => setDoubleObliqueCenterHandler(null);
  }, [centerDoubleObliqueView]);

  const collectProbeAnnotations = useCallback(() => {
    const engine = getEngine();
    if (!engine) return [];
    const probes: any[] = [];
    const seen = new Set<string>();
    for (const vpId of ['coronal', 'sagittal', 'axial']) {
      const vp = engine.getViewport(vpId);
      if (!vp?.element) continue;
      const ps = cornerstoneTools.annotation.state.getAnnotations('Probe', vp.element);
      for (const probe of ps ?? []) {
        const key = probe.annotationUID ?? `${vpId}-${probes.length}`;
        if (seen.has(key)) continue;
        seen.add(key);
        probes.push(probe);
      }
    }
    return probes;
  }, [renderingEngineId]);

  const clearProbeAnnotations = useCallback(() => {
    const engine = getEngine();
    if (!engine) return;
    for (const vpId of ['coronal', 'sagittal', 'axial']) {
      const vp = engine.getViewport(vpId);
      if (!vp?.element) continue;
      const probes = cornerstoneTools.annotation.state.getAnnotations('Probe', vp.element);
      if (!probes) continue;
      for (const probe of [...probes]) {
        if (probe.annotationUID) cornerstoneTools.annotation.state.removeAnnotation(probe.annotationUID);
      }
      vp.render();
    }
  }, [renderingEngineId]);

  const trimProbeAnnotations = useCallback((maxCount: number) => {
    const probes = collectProbeAnnotations();
    const removeCount = Math.max(0, probes.length - maxCount);
    for (const probe of probes.slice(0, removeCount)) {
      if (probe.annotationUID) cornerstoneTools.annotation.state.removeAnnotation(probe.annotationUID);
    }
    const engine = getEngine();
    if (removeCount > 0 && engine) {
      for (const vpId of ['coronal', 'sagittal', 'axial']) {
        engine.getViewport(vpId)?.render();
      }
    }
    return probes.slice(removeCount);
  }, [collectProbeAnnotations, renderingEngineId]);

  const startSingleProbePlacement = useCallback(() => {
    clearProbeAnnotations();
    setActiveCuspUpdate(null);
    setNcMarkingActive(false);
    setActiveSinusWidthLabel(null);
    setSinusWidthProbeCount(0);
    setSinusWidthMessage(null);
    enableProbeTool();
  }, [clearProbeAnnotations]);

  const startSinusWidthPlacement = useCallback((label: SinusLabel) => {
    clearProbeAnnotations();
    setActiveSinusWidthLabel(label);
    setSinusWidthProbeCount(0);
    setSinusWidthMessage(`${label}: place 2 probes, then Confirm.`);
    enableProbeTool();
  }, [clearProbeAnnotations]);

  useEffect(() => {
    if (!activeSinusWidthLabel) return;
    const interval = window.setInterval(() => {
      setSinusWidthProbeCount(Math.min(trimProbeAnnotations(2).length, 2));
    }, 150);
    return () => window.clearInterval(interval);
  }, [activeSinusWidthLabel, trimProbeAnnotations]);

  useEffect(() => {
    if (activeSubtitle !== 'valve') {
      disableProbeTool();
      clearProbeAnnotations();
      contourToolRef.current?.disable();
      contourToolRef.current = null;
      centerlineRef.current?.disable();
      centerlineRef.current = null;
      cuspMarkerRef.current?.disable();
      cuspMarkerRef.current = null;
      measurementRef.current?.disable();
      measurementRef.current = null;
      setNcMarkingActive(false);
      setActiveSinusWidthLabel(null);
      setSinusWidthProbeCount(0);
      setSinusWidthMessage(null);
      setActiveCuspUpdate(null);
      setCuspPlaced(false);
      if (viewportMode !== 'tavi-crosshair') {
        onViewportModeChange('tavi-crosshair');
      }
      return;
    }

    const valveNeedsOblique =
      workflowPhase === 'centerline-review' ||
      workflowPhase === 'cusp-definition' ||
      workflowPhase === 'annulus-tracing' ||
      workflowPhase === 'coronary-heights' ||
      workflowPhase === 'report';

    if (valveNeedsOblique && controllerRef.current && viewportMode !== 'tavi-oblique') {
      onViewportModeChange('tavi-oblique');
      enterDoubleObliqueMode(renderingEngineId);
    }
  }, [
    activeSubtitle,
    clearProbeAnnotations,
    onViewportModeChange,
    renderingEngineId,
    viewportMode,
    workflowPhase,
  ]);

  // ── Sync captured points as visual markers on viewports ──
  const markerOverlayRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const clearMprMarkers = () => {
      const engine = getEngine();
      if (!engine) return;
      for (const vpId of ['axial', 'sagittal', 'coronal']) {
        const vp = engine.getViewport(vpId);
        const overlay = vp?.element?.querySelector('.tavi-point-markers');
        if (overlay) overlay.innerHTML = '';
      }
    };

    if (activeSubtitle !== 'valve') {
      controllerRef.current?.setMarkerPoints([]);
      controllerRef.current?.setMeasurementLines([]);
      controllerRef.current?.setPerpendicularityReference(null);
      controllerRef.current?.setAnnulusDiscRadiusMm(0);
      setLivePerp(null);
      clearMprMarkers();
      return;
    }

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

      // Live perpendicularity reference + annulus disc glyph radius.
      controllerRef.current.setPerpendicularityReference(
        annulus ? annulus.planeNormal : null,
        (dev) => setLivePerp(dev)
      );
      controllerRef.current.setAnnulusDiscRadiusMm(annulus ? annulus.equivalentDiameterMm / 2 : 0);
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
  }, [session, activeSubtitle, activeTab, viewportMode, refresh]);

  // ── structured Axis Detection ──

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
          controllerRef.current?.dispose();
          controllerRef.current = null;
          const controller = new DoubleObliqueController(
            renderingEngineId,
            'axial',     // LEFT = reference plane
            'coronal'    // RIGHT = working plane
          );
          controller.initialize(result.centerPoint, result.axisDirection);
          controllerRef.current = controller;

          // Skip centerline-review: go directly to cusp definition (like dedicated TAVI planners)
          // Save controller state for cusp reset
          const state = controller.getState();
          preCuspStateRef.current = {
            axisPoint: { ...state.axisPoint },
            axisDirection: { ...state.axisDirection },
            rotationAngle: state.rotationAngle,
            tiltAngle: state.tiltAngle,
          };
          controller.prepareForCuspDefinition();
          startSingleProbePlacement();

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
  }, [renderingEngineId, volumeId, onViewportModeChange, startSingleProbePlacement]);

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

    // Go directly to cusp definition (guided workflow)
    preCuspStateRef.current = {
      axisPoint: { ...state.axisPoint },
      axisDirection: { ...state.axisDirection },
      rotationAngle: state.rotationAngle,
      tiltAngle: state.tiltAngle,
    };
    controller.prepareForCuspDefinition();
    startSingleProbePlacement();
    setWorkflowPhase('cusp-definition');
    setCuspStep('lcc');
    setCuspPoints({});
    forceUpdate();
  }, [session, startSingleProbePlacement]);

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
    startSingleProbePlacement();
    setWorkflowPhase('cusp-definition');
    setCuspStep('lcc');
    setCuspPoints({});
    forceUpdate();
  }, [startSingleProbePlacement]);

  // ── Cusp Definition (Phase 2) ──

  /** Snap a cusp nadir toward the local HU minimum along the aortic axis. */
  const snapCuspNadir = (raw: TAVIVector3D): TAVIVector3D => {
    if (!snapEnabled) return raw;
    const volume = cornerstone.cache.getVolume(volumeId);
    const axisDir = session.aorticAxisDirection ?? controllerRef.current?.getAxisDirection();
    if (!volume || !axisDir) return raw;
    return snapPointToAxialMinimum(volume, raw, axisDir, { searchMm: 4 }) ?? raw;
  };

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
    const rawCusp: TAVIVector3D = { x: p[0], y: p[1], z: p[2] };
    const worldPoint: TAVIVector3D = snapCuspNadir(rawCusp);

    // Remove all transient probe annotations after capturing. Extra clicks
    // before Confirm should not leave HU probe labels on the view.
    clearProbeAnnotations();

    const controller = controllerRef.current;

    if (cuspStep === 'lcc') {
      setCuspPoints(prev => ({ ...prev, lcc: worldPoint }));
      setCuspStep('ncc');
      // Auto-rotate 120° to expected NCC location
      if (controller) {
        setCuspRotating(true);
        controller.rotateAroundAxis(120, 500)
              .then(() => setCuspRotating(false))
              .catch((err) => { console.warn('[tavi] auto-rotate failed', err); setCuspRotating(false); });
      }
    } else if (cuspStep === 'ncc') {
      setCuspPoints(prev => ({ ...prev, ncc: worldPoint }));
      setCuspStep('rcc');
      // Auto-rotate another 120° to expected RCC location
      if (controller) {
        setCuspRotating(true);
        controller.rotateAroundAxis(120, 500)
              .then(() => setCuspRotating(false))
              .catch((err) => { console.warn('[tavi] auto-rotate failed', err); setCuspRotating(false); });
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
  }, [cuspStep, cuspPoints, session, snapEnabled, volumeId, clearProbeAnnotations]);

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
    controllerRef.current?.unlockScrolling();
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
    startSingleProbePlacement();
    forceUpdate();
  }, [session, startSingleProbePlacement]);

  // ── Constrained Contour Tracing (Phase 3) ──

  /** Initialize the constrained contour tool on the working viewport */
  const initContourTool = useCallback(() => {
    const plane = syncAnnulusPlaneFromWorkingView();
    const engine = getEngine();
    if (!engine || !plane) return;

    // Working viewport is 'coronal' in tavi-oblique mode
    const workingVp = engine.getViewport('coronal');
    if (!workingVp) return;

    // Clean up any existing contour tool
    contourToolRef.current?.disable();

    const tool = new ConstrainedContourTool(
      workingVp,
      plane.normal,
      plane.centroid
    );
    tool.enable();
    contourToolRef.current = tool;
    setContourPointCount(0);
    setContourClosed(false);
  }, [renderingEngineId, syncAnnulusPlaneFromWorkingView]);

  const syncEditableAnnulusContour = useCallback((worldPoints: TAVIVector3D[]): boolean => {
    if (!session.annulusPlaneNormal || worldPoints.length < 3) return false;

    session.captureConstrainedAnnulusContour(
      worldPoints,
      session.annulusPlaneNormal,
      true
    );

    const annulusGeo = session.activeAnnulusGeometry();
    if (annulusGeo && session.annulusSnapshot?.worldPoints) {
      measurementRef.current?.setAnnulusData(session.annulusSnapshot.worldPoints, annulusGeo);
      controllerRef.current?.setAnnulusDiscRadiusMm(annulusGeo.equivalentDiameterMm / 2);
    }
    return true;
  }, [session]);

  /** Poll for Probe annotations during cusp definition — auto-detect when user places a point */
  useEffect(() => {
    if (activeSubtitle !== 'valve' || workflowPhase !== 'cusp-definition' || cuspPlaced) return;

    const engine = getEngine();
    if (!engine) return;

    const interval = setInterval(() => {
      const probes = trimProbeAnnotations(1);
      if (probes.length > 0) {
        setCuspPlaced(true);
        disableProbeTool();
      }
    }, 200);

    return () => clearInterval(interval);
  }, [activeSubtitle, workflowPhase, cuspPlaced, renderingEngineId, trimProbeAnnotations]);

  useEffect(() => {
    if (activeSubtitle !== 'valve' || workflowPhase !== 'annulus-tracing') return;
    if (contourStarted || contourClosed) return;
    const interval = window.setInterval(() => {
      trimProbeAnnotations(1);
    }, 150);
    return () => window.clearInterval(interval);
  }, [activeSubtitle, workflowPhase, contourStarted, contourClosed, trimProbeAnnotations]);

  /** Poll the contour tool for point count updates */
  useEffect(() => {
    if (activeSubtitle !== 'valve' || workflowPhase !== 'annulus-tracing') {
      contourToolRef.current?.disable();
      contourToolRef.current = null;
      return;
    }
    const shouldEnableContourTool =
      contourStarted || contourClosed || session.annulusRawContourPoints.length > 0;
    if (!shouldEnableContourTool) return;

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
        const pts = tool.getWorldPoints();
        const hash = hashWorldPoints(pts);
        if (hash !== lastPointHash) {
          lastPointHash = hash;
          if (tool.isClosed() && syncEditableAnnulusContour(pts)) {
            forceUpdate();
          }
          setContourVersion(v => v + 1);
        }
      }
    }, 200);

    return () => {
      clearInterval(interval);
      contourToolRef.current?.disable();
      contourToolRef.current = null;
    };
  }, [activeSubtitle, workflowPhase, initContourTool, contourStarted, contourClosed, session.annulusRawContourPoints.length, syncEditableAnnulusContour]);

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
    contourToolRef.current?.disable();
    contourToolRef.current = null;
    session.annulusSnapshot = undefined;
    session.annulusRawContourPoints = [];
    session.assistedAnnulusGeometry = null;
    session.useAssistedAnnulusForPlanning = false;
    session.recompute();
    controllerRef.current?.unlockScrolling();
    setContourPointCount(0);
    setContourClosed(false);
    setContourStarted(false);
    forceUpdate();
  }, [session]);

  const finishAnnulusCapture = useCallback(() => {
    contourToolRef.current?.disable();
    contourToolRef.current = null;
    controllerRef.current?.unlockScrolling();

    if (session.leftOstiumSnapshot && session.rightOstiumSnapshot) {
      setWorkflowPhase('coronary-heights');
      setCoronaryStep('multi-level');
    } else {
      setWorkflowPhase('coronary-heights');
    }
    forceUpdate();
  }, [session]);

  const autoTraceAnnulus = useCallback(() => {
    const plane = syncAnnulusPlaneFromWorkingView();
    if (!plane) return;

    const volume = cornerstone.cache.getVolume(volumeId);
    if (!volume) return;

    contourToolRef.current?.disable();
    contourToolRef.current = null;

    const seg =
      autoTraceAnnulusContrastEdgeAtPlane(
        volume,
        plane.centroid,
        plane.normal,
        plane.viewUp,
        {
          radialCount: 128,
          radialStepMm: 0.25,
          minRadiusMm: 5.5,
          maxRadiusMm: 23,
          minDiameterMm: 12,
          maxDiameterMm: 38,
        }
      ) ??
      autoSegmentCrossSectionAtPlane(
        volume,
        plane.centroid,
        plane.normal,
        plane.viewUp,
        {
          gridSize: 240,
          pixelSpacing: 0.2,
          minDiameterMm: 12,
          maxDiameterMm: 42,
          searchRadiusMm: 18,
        }
      );

    if (!seg || seg.contourPoints.length < 10) {
      window.alert(
        'Auto annulus tracing failed.\n\n' +
        'The contrast edge could not be isolated on this annulus plane. Fine-tune the cusp plane/crosshair and try Auto Trace again. Manual tracing is still available.'
      );
      return;
    }

    const editablePoints = resampleClosedContourByCount(seg.contourPoints, 24);
    initContourTool();
    const tool = contourToolRef.current as ConstrainedContourTool | null;
    if (!tool) return;
    tool.loadPoints(editablePoints);

    session.captureConstrainedAnnulusContour(editablePoints, plane.normal, true);
    setContourStarted(false);
    setContourClosed(true);
    setContourPointCount(editablePoints.length);
    setContourVersion(v => v + 1);
    controllerRef.current?.lockScrolling();
    forceUpdate();
  }, [session, volumeId, initContourTool, syncAnnulusPlaneFromWorkingView]);

  /** Confirm annulus contour and compute geometry */
  const confirmAnnulusContour = useCallback(() => {
    const tool = contourToolRef.current;
    if (!tool || !session.annulusPlaneNormal) return;

    const worldPoints = tool.getWorldPoints();
    if (worldPoints.length < 3) return;

    syncEditableAnnulusContour(worldPoints);

    finishAnnulusCapture();
  }, [session, syncEditableAnnulusContour, finishAnnulusCapture]);

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
    startSingleProbePlacement();

    // Navigate to estimated LCA position
    controller.navigateToEstimatedCoronaryPosition('left', centroid);
    setCoronaryStep('capture-lca');
  }, [workflowPhase, session, startSingleProbePlacement]);

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
    const rawPoint: TAVIVector3D = { x: p[0], y: p[1], z: p[2] };
    // Snap onto the contrast-filled lumen centroid for reproducible heights.
    const snapVolume = snapEnabled ? cornerstone.cache.getVolume(volumeId) : null;
    const snapped = snapVolume ? snapPointToLumenCentroid(snapVolume, rawPoint) : null;
    const worldPoint: TAVIVector3D = snapped ?? rawPoint;

    // Remove all transient Probe/HU annotations after capture.
    clearProbeAnnotations();

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
  }, [session, renderingEngineId, snapEnabled, volumeId, clearProbeAnnotations]);

  // Capture a single sinus width from the two most-recent Probe annotations.
  const captureSinusWidth = useCallback((label: SinusLabel) => {
    const probes = collectProbeAnnotations();
    const count = Math.min(probes.length, 2);
    setActiveSinusWidthLabel(label);
    setSinusWidthProbeCount(count);
    if (probes.length < 2) {
      setSinusWidthMessage(`${label}: need 2 probes before Confirm (${count}/2).`);
      startSingleProbePlacement();
      return;
    }
    const a = probes[probes.length - 2].data.handles.points[0];
    const b = probes[probes.length - 1].data.handles.points[0];
    session.captureSinusDiameter(
      label,
      { x: a[0], y: a[1], z: a[2] },
      { x: b[0], y: b[1], z: b[2] }
    );
    // Clean up probe annotations across viewports (mirror captureCoronaryPoint).
    clearProbeAnnotations();
    disableProbeTool();
    setActiveSinusWidthLabel(null);
    setSinusWidthProbeCount(0);
    setSinusWidthMessage(null);
    forceUpdate();
  }, [session, collectProbeAnnotations, clearProbeAnnotations, startSingleProbePlacement]);


  /** Capture a cusp hinge point from standard MPR views (before double-oblique mode) */
  const captureCuspFromMPR = useCallback((cusp: 'lcc' | 'ncc' | 'rcc'): boolean => {
    const engine = getEngine();
    if (!engine) return false;

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
    if (!ann) return false;

    const p = ann.data.handles.points[0];
    const worldPoint: TAVIVector3D = snapCuspNadir({ x: p[0], y: p[1], z: p[2] });

    clearProbeAnnotations();

    // Save to session and local state
    if (cusp === 'lcc') { session.cuspLCC = worldPoint; setCuspPoints(prev => ({ ...prev, lcc: worldPoint })); }
    if (cusp === 'ncc') { session.cuspNCC = worldPoint; setCuspPoints(prev => ({ ...prev, ncc: worldPoint })); }
    if (cusp === 'rcc') { session.cuspRCC = worldPoint; setCuspPoints(prev => ({ ...prev, rcc: worldPoint })); }

    session.recompute();
    setActiveCuspUpdate(null);
    forceUpdate();
    return true;
  }, [session, snapEnabled, volumeId, clearProbeAnnotations]);

  const startCuspUpdate = useCallback((cusp: 'lcc' | 'ncc' | 'rcc') => {
    clearProbeAnnotations();
    setNcMarkingActive(false);
    setActiveSinusWidthLabel(null);
    setSinusWidthProbeCount(0);
    setSinusWidthMessage(`Click the corrected ${cusp.toUpperCase()} point on the image.`);
    setActiveCuspUpdate(cusp);
    enableProbeTool();
  }, [clearProbeAnnotations]);

  useEffect(() => {
    if (!activeCuspUpdate) return;
    if (workflowPhase !== 'axis-validation') return;

    const interval = window.setInterval(() => {
      if (captureCuspFromMPR(activeCuspUpdate)) {
        setSinusWidthMessage(null);
        disableProbeTool();
      }
    }, 150);

    return () => window.clearInterval(interval);
  }, [activeCuspUpdate, workflowPhase, captureCuspFromMPR]);

  /** Auto-capture NC guide points: poll for Probe annotations when NC guide is active */
  const ncGuidePointsRef = useRef<TAVIVector3D[]>([]);
  ncGuidePointsRef.current = ncGuidePoints;

  useEffect(() => {
    if (workflowPhase !== 'axis-validation') return;
    if (!ncMarkingActive) return;
    if (ncGuidePointsRef.current.length >= 5) return;

    const engine = getEngine();
    if (!engine) return;

    const interval = setInterval(() => {
      if (ncGuidePointsRef.current.length >= 5) return;

      for (const vpId of ['axial', 'coronal', 'sagittal']) {
        const vp = engine.getViewport(vpId);
        if (!vp?.element) continue;
        const probes = cornerstoneTools.annotation.state.getAnnotations('Probe', vp.element);
        if (probes && probes.length > 0) {
          const ann = probes[probes.length - 1];
          const p = ann.data.handles?.points?.[0];
          if (!p) continue;
          const wp: TAVIVector3D = { x: p[0], y: p[1], z: p[2] };

          clearProbeAnnotations();

          const willComplete = ncGuidePointsRef.current.length + 1 >= 5;
          setNcGuidePoints(prev => {
            if (prev.length >= 5) return prev;
            return [...prev, wp];
          });
          // Auto-close the marking session once the 5th point lands so the
          // next probe click flows to whichever UI the user picks next.
          if (willComplete) {
            setNcMarkingActive(false);
            disableProbeTool();
          }
          forceUpdate();
          break;
        }
      }
    }, 200);

    return () => clearInterval(interval);
  }, [workflowPhase, ncGuidePoints.length, ncMarkingActive, clearProbeAnnotations]);

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
    onReportToggle?.(true);
    forceUpdate();
  }, [onReportToggle]);

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
    if (activeSubtitle !== 'valve' || (workflowPhase !== 'axis-validation' && workflowPhase !== 'centerline-review')) {
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
  }, [activeSubtitle, workflowPhase, renderingEngineId, viewportMode, axisResult]);

  // ── Cusp marker overlay: show during cusp-definition on double-oblique viewports ──
  useEffect(() => {
    if (activeSubtitle !== 'valve' || workflowPhase !== 'cusp-definition') {
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
            controller.rotateAroundAxis(120, 500)
              .then(() => setCuspRotating(false))
              .catch((err) => { console.warn('[tavi] auto-rotate failed', err); setCuspRotating(false); });
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
  }, [activeSubtitle, workflowPhase, renderingEngineId, session]);

  const hasAnnulusSnapshot = !!session.annulusSnapshot;

  // ── Measurement overlay: show after annulus contour is confirmed ──
  useEffect(() => {
    // Show measurement overlay when we have annulus geometry
    const annulusGeo = session.activeAnnulusGeometry();
    if (!annulusGeo || activeSubtitle !== 'valve' || workflowPhase === 'axis-validation' || workflowPhase === 'axis-detection') {
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
  // Re-run when the overlay should be created/removed or moved to another viewport.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSubtitle, workflowPhase, renderingEngineId, viewportMode, hasAnnulusSnapshot]);

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

        // Create contour snapshot from best result. Rasterize HU inside the
        // contour so 2D Agatston can be scored (annulus / LVOT).
        const caAuto = samplePixelValuesInWorldContour(
          cornerstone.cache.getVolume(volumeId), bestCandidate.contourPoints, bestCandidate.normal
        );
        const snapshot: TAVIContourSnapshot = {
          worldPoints: bestCandidate.contourPoints,
          pixelPoints: [],
          planeOrigin: bestCandidate.origin,
          planeNormal: bestCandidate.normal,
          ...(caAuto ? { pixelValues: caAuto.pixelValues, pixelAreaMm2: caAuto.pixelAreaMm2 } : {}),
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

  // ── Per-cusp calcium sampling ──
  // Cusps are single nadir points; synthesize a disc on the annulus plane
  // around the nadir and rasterize HU inside it for a 2D Agatston estimate.
  const CUSP_CA_RADIUS_MM = 6;
  const sampleCuspCalcium = (id: 'lcc' | 'rcc' | 'ncc', center?: TAVIVector3D) => {
    const volume = cornerstone.cache.getVolume(volumeId);
    const normal = session.annulusPlaneNormal ?? session.activeAnnulusGeometry()?.planeNormal;
    if (!volume || !center || !normal) return;
    const ring = TAVIGeometry.discOnPlane(center, normal, CUSP_CA_RADIUS_MM, 24);
    const s = samplePixelValuesInWorldContour(volume, ring, normal);
    if (s) {
      session.captureCuspCalciumSample(id, s.pixelValues, s.pixelAreaMm2);
      forceUpdate();
    }
  };

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
          const tc = (anns[0].data?.handles as any)?.toolCenter as number[] | undefined;
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
      controllerRef.current?.dispose();
      controllerRef.current = null;
      const controller = new DoubleObliqueController(
        renderingEngineId,
        'axial',    // LEFT = reference (longitudinal)
        'coronal'   // RIGHT = working (cross-section)
      );
      controller.initialize(center!, axisDir!);
      controllerRef.current = controller;

      // Go directly to cusp definition (guided workflow)
      const state = controller.getState();
      preCuspStateRef.current = {
        axisPoint: { ...state.axisPoint },
        axisDirection: { ...state.axisDirection },
        rotationAngle: state.rotationAngle,
        tiltAngle: state.tiltAngle,
      };
      controller.prepareForCuspDefinition();
      startSingleProbePlacement();
      setWorkflowPhase('cusp-definition');
      setCuspStep('lcc');
      setCuspPoints({});
      forceUpdate();
    }, 250);
  }, [session, renderingEngineId, volumeId, onViewportModeChange, startSingleProbePlacement]);

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
    setActiveSubtitle('valve');
    setCuspStep('lcc');
    setCuspPoints({});
    setContourPointCount(0);
    setContourClosed(false);
    setContourStarted(false);
    setCoronaryStep('navigate-lca');
    setActiveContourId(null);
    setNcGuidePoints([]);
    setMultiLevelThumbnails(new Map());
    // Disarm in-flight capture pollers/flags so a reset mid-workflow does not
    // leave probe placement stuck or a poller consuming later clicks.
    setCuspPlaced(false);
    setActiveCuspUpdate(null);
    setNcMarkingActive(false);
    setActiveSinusWidthLabel(null);
    setSinusWidthProbeCount(0);
    setSinusWidthMessage(null);
    setAxisResult(null);
    setAxisDetecting(false);
    setAxisError(null);
    disableProbeTool();
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
            const planeNormal = { x: vpn[0], y: vpn[1], z: vpn[2] };
            // Rasterize HU inside the contour so 2D Agatston can be scored for
            // calcium-bearing structures (annulus / LVOT). No-op for others.
            const ca = samplePixelValuesInWorldContour(
              cornerstone.cache.getVolume(volumeId), worldPoints, planeNormal
            );
            const snapshot: TAVIContourSnapshot = {
              worldPoints,
              pixelPoints: [],
              planeOrigin: { x: polyline[0][0], y: polyline[0][1], z: polyline[0][2] },
              planeNormal,
              ...(ca ? { pixelValues: ca.pixelValues, pixelAreaMm2: ca.pixelAreaMm2 } : {}),
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

  // Resolve the selected prosthesis back to its family/size entry so the risk
  // models and deployment view can read the device type, sheath OD, etc.
  const selectedValveEntry = session.selectedValve
    ? resolveSelectedValve(session.selectedValve.familyName, session.selectedValve.sizeMm)
    : null;

  // Pacemaker risk score — device-type aware once a prosthesis is selected.
  // Previously this was hardcoded `isSelfExpanding: false`, which understated
  // risk for self-expanding valves (Evolut / Navitor / ACURATE). Now it reflects
  // the actual selected platform and the live implant depth from the simulation.
  const pmRisk = computePacemakerRiskScore({
    membranousSeptumLengthMm: session.membranousSeptumLengthMm,
    implantDepthMm: session.implantDepthMm,
    isSelfExpanding: selectedValveEntry?.family.type === 'self-expanding',
  });

  // On-demand 3D aortic-root surface (built in the AS.AORT subtab from the
  // annulus centroid seed). Shared with the valve deployment view so the
  // prosthesis can be shown in the context of the actual root anatomy.
  const rootSurface = useAorticRootSurface(volumeId);

  // Virtual deployment meshes. Built only when a prosthesis is selected AND an
  const deploymentView = useMemo(() => {
    if (!selectedValveEntry || !session.annulusPlaneCentroid || !session.annulusPlaneNormal) return null;
    const origin = session.annulusPlaneCentroid;
    // Aortic axis: prefer the detected axis direction; fall back to the annulus normal.
    const axisRaw = session.aorticAxisDirection ?? session.annulusPlaneNormal;
    const len = Math.hypot(axisRaw.x, axisRaw.y, axisRaw.z) || 1;
    const axis = { x: axisRaw.x / len, y: axisRaw.y / len, z: axisRaw.z / len };
    // In-plane basis: pick a helper not parallel to the axis, then cross-product.
    const helper = Math.abs(axis.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
    const lx = TAVIGeometry.vectorNormalize(TAVIGeometry.vectorCross(helper, axis));
    const ly = TAVIGeometry.vectorNormalize(TAVIGeometry.vectorCross(axis, lx));

    const profile = frameProfileFor(
      selectedValveEntry.family.name,
      selectedValveEntry.family.type === 'self-expanding',
      selectedValveEntry.size.size,
    );
    const rings = positionFrame(profile, session.implantDepthMm, session.deploymentRatio);
    const frameMesh = buildFrameMesh(rings, { origin, axis, localX: lx, localY: ly }, 36);
    const annulusMesh = buildAnnulusDiscMesh(session.annulusSnapshot?.worldPoints ?? []);

    const layers: MeshLayer[] = [];
    // Semi-transparent aortic-root surface (built in AS.AORT), if available.
    if (rootSurface.mesh) {
      layers.push({ mesh: rootSurface.mesh, color: [0.9, 0.55, 0.35], alpha: 0.22 });
    }
    layers.push(
      { mesh: annulusMesh, color: [0.85, 0.85, 0.85], alpha: 0.18 },
      { mesh: frameMesh, color: [0.38, 0.78, 1.0], alpha: 0.92 },
    );
    const landmarks: { point: TAVIVector3D; color: [number, number, number]; radiusMm?: number }[] = [];
    if (session.cuspLCC) landmarks.push({ point: session.cuspLCC, color: [0.35, 0.95, 0.45], radiusMm: 1.6 });
    if (session.cuspNCC) landmarks.push({ point: session.cuspNCC, color: [0.98, 0.88, 0.2], radiusMm: 1.6 });
    if (session.cuspRCC) landmarks.push({ point: session.cuspRCC, color: [0.98, 0.4, 0.4], radiusMm: 1.6 });
    if (session.leftOstiumSnapshot) landmarks.push({ point: session.leftOstiumSnapshot.worldPoint, color: [1.0, 0.55, 0.1], radiusMm: 1.8 });
    if (session.rightOstiumSnapshot) landmarks.push({ point: session.rightOstiumSnapshot.worldPoint, color: [0.7, 0.4, 1.0], radiusMm: 1.8 });

    // Post-deployment metrics (cover index, coronary clearance, PVL indicator).
    const annulusGeom = session.activeAnnulusGeometry();
    let deploymentResult: DeploymentResult | null = null;
    if (annulusGeom) {
      deploymentResult = computeDeploymentResult({
        family: selectedValveEntry.family,
        size: selectedValveEntry.size,
        annulus: {
          perimeterMm: annulusGeom.perimeterMm,
          areaMm2: annulusGeom.areaMm2,
          minimumDiameterMm: annulusGeom.minimumDiameterMm,
          maximumDiameterMm: annulusGeom.maximumDiameterMm,
        },
        frameOutflowHeightMm: rings[rings.length - 1].heightAboveAnnulusMm,
        coronaryHeights: { left: session.leftCoronaryHeightMm, right: session.rightCoronaryHeightMm },
        calciumGrades: { annulus: session.annulusCalcificationGrade, cusp: session.cuspCalcificationGrade },
      });
    }

    return { layers, landmarks, frameHeightMm: profile.totalHeightMm, deploymentResult };
    // refresh lets implant-depth / deployment-ratio / selection changes rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedValveEntry,
    session.annulusPlaneCentroid,
    session.annulusPlaneNormal,
    session.aorticAxisDirection,
    session.annulusSnapshot,
    session.implantDepthMm,
    session.deploymentRatio,
    session.cuspLCC, session.cuspNCC, session.cuspRCC,
    session.leftOstiumSnapshot, session.rightOstiumSnapshot,
    rootSurface.mesh,
    refresh,
  ]);

  const navigateToPlanningPlane = useCallback((distanceMm: number) => {
    const controller = controllerRef.current;
    const origin = session.annulusPlaneCentroid ?? annulus?.centroid;
    if (!controller || !origin) return;
    controller.showPlaneAtDistanceFromOrigin(origin, distanceMm);
    if (distanceMm === 0) controller.centerOnWorldPoint(annulus?.centroid ?? origin);
  }, [annulus, session]);

  const navigateToLandmark = useCallback((point?: TAVIVector3D) => {
    if (!point) return;
    controllerRef.current?.showPlaneThroughWorldPoint(point);
  }, []);

  const ensureReportSnapshots = useCallback(async (distances: number[] = [0, 5, 10, 15]) => {
    const merged = new Map(session.multiLevelThumbnails);
    for (const [dist, thumb] of multiLevelThumbnails) merged.set(dist, thumb);

    const missing = distances.filter((dist) => !merged.has(dist));
    const controller = controllerRef.current;
    const centroid = session.annulusPlaneCentroid ?? annulus?.centroid;
    if (missing.length > 0 && controller && centroid) {
      const generated = await controller.generateMultiLevelThumbnails(centroid, missing);
      for (const [dist, thumb] of generated) merged.set(dist, thumb);
      session.multiLevelThumbnails = merged;
      setMultiLevelThumbnails(new Map(merged));
      forceUpdate();
    }

    return merged;
  }, [annulus, multiLevelThumbnails, session]);

  const exportAnnulusPointsCsv = useCallback(() => {
    const csv = session.annulusPointsCsvReport();
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `TAVR_Annulus_Points_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [session]);

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
    for (const lbl of ['LCS', 'RCS', 'NCS'] as SinusLabel[]) {
      const d = session.sinusDiameters[lbl];
      if (d) lines.push(`  Sinus ${lbl}: ${fmt(d.diameterMm)} mm${d.heightMm != null ? ` | h ${fmt(d.heightMm)} mm` : ''}`);
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

    // Risk
    lines.push('── RISK ASSESSMENT ──');
    lines.push(`  Coronary Obstruction: ${risks.coronaryObstructionRisk.toUpperCase()} — ${risks.coronaryObstructionNote}`);
    lines.push(`  Conduction:           ${risks.conductionDisturbanceRisk.toUpperCase()} — ${risks.conductionDisturbanceNote}`);
    lines.push(`  Annular Rupture:      ${risks.annularRuptureRisk.toUpperCase()} — ${risks.annularRuptureNote}`);
    lines.push('');

    // Calcium
    lines.push('── CALCIFICATION ──');
    lines.push(`  Cusp Grades — LCC: ${session.cuspCalcificationGradeLCC} | RCC: ${session.cuspCalcificationGradeRCC} | NCC: ${session.cuspCalcificationGradeNCC}`);
    lines.push(`  Annulus Grade: ${session.annulusCalcificationGrade}`);
    lines.push(`  Threshold: ${session.calciumThresholdHU} HU`);
    if (session.annulusCalcium) {
      lines.push(`  Annulus Agatston 2D: ${fmt(session.annulusCalcium.agatstonScore2D, 0)}`);
      lines.push(`  Annulus Hyperdense Area: ${fmt(session.annulusCalcium.hyperdenseAreaMm2)} mm²`);
    }
    if (session.cuspCalciumLCC) lines.push(`  LCC Agatston 2D: ${fmt(session.cuspCalciumLCC.agatstonScore2D, 0)}`);
    if (session.cuspCalciumRCC) lines.push(`  RCC Agatston 2D: ${fmt(session.cuspCalciumRCC.agatstonScore2D, 0)}`);
    if (session.cuspCalciumNCC) lines.push(`  NCC Agatston 2D: ${fmt(session.cuspCalciumNCC.agatstonScore2D, 0)}`);
    if (session.lvotCalcium) lines.push(`  LVOT Agatston 2D: ${fmt(session.lvotCalcium.agatstonScore2D, 0)} | Dense ${fmt(session.lvotCalcium.fractionAboveThreshold * 100, 1)}%`);
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

  // Export measurements as CSV (Excel / spreadsheet).
  const exportCsvReport = useCallback(() => {
    const csv = session.csvReport();
    // Prepend UTF-8 BOM so Excel renders mm²/° and quoted cells correctly.
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `TAVR_Report_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [session]);

  const exportPdfReport = useCallback(async (encapsulate: boolean) => {
    const { buildPdfReport, downloadPdf } = await import('../../../shared/dicom/pdfReport');
    const { downloadEncapsulatedPdf } = await import('../../../shared/dicom/encapsulatedPdf');
    const sections: import('../../../shared/dicom/pdfReport').ReportSection[] = [];
    const planningSnapshots = await ensureReportSnapshots([0, 5, 10, 15]);

    if (annulus) {
      sections.push({
        title: 'Aortic Annulus',
        rows: [
          { label: 'Perimeter', value: fmt(annulus.perimeterMm), unit: `mm (ø ${fmt(dPerim(annulus.perimeterMm))} mm)` },
          { label: 'Area', value: fmt(annulus.areaMm2), unit: `mm² (ø ${fmt(dArea(annulus.areaMm2))} mm)` },
          { label: 'Eccentricity', value: fmt(ecc(annulus), 2) },
          { label: 'Min × Max', value: `${fmt(annulus.minimumDiameterMm)} × ${fmt(annulus.maximumDiameterMm)}`, unit: 'mm' },
          { label: 'Virtual Valve', value: fmt(session.virtualValveDiameterMm), unit: 'mm' },
        ],
      });
    }

    const snapshotImages = [
      { dist: 0, title: 'Annulus Plane', caption: 'Valve annulus plane' },
      { dist: 5, title: 'Aortic Valve +5 mm', caption: '5 mm above annulus' },
      { dist: 10, title: 'Aortic Valve +10 mm', caption: '10 mm above annulus' },
      { dist: 15, title: 'Aortic Valve +15 mm', caption: '15 mm above annulus' },
    ]
      .map(({ dist, title, caption }) => {
        const dataUrl = planningSnapshots.get(dist);
        return dataUrl ? { title, caption, dataUrl } : null;
      })
      .filter((img): img is { title: string; caption: string; dataUrl: string } => !!img);
    if (snapshotImages.length > 0) {
      sections.push({
        title: 'Planning Snapshots',
        rows: [],
        images: snapshotImages,
      });
    }

    sections.push({
      title: 'Coronary Assessment',
      rows: [
        { label: 'LCO Height', value: session.leftCoronaryHeightMm != null ? fmt(session.leftCoronaryHeightMm) : '—', unit: session.leftCoronaryHeightMm != null ? 'mm' : '' },
        { label: 'RCO Height', value: session.rightCoronaryHeightMm != null ? fmt(session.rightCoronaryHeightMm) : '—', unit: session.rightCoronaryHeightMm != null ? 'mm' : '' },
        { label: 'Membranous Septum', value: session.membranousSeptumLengthMm != null ? fmt(session.membranousSeptumLengthMm) : '—', unit: session.membranousSeptumLengthMm != null ? 'mm' : '' },
        { label: 'Aortic Angulation', value: fmt(session.horizontalAortaAngleDegrees), unit: '°' },
      ],
    });

    if (Object.keys(session.sinusDiameters).length > 0) {
      sections.push({
        title: 'Sinus of Valsalva',
        rows: (['LCS', 'RCS', 'NCS'] as SinusLabel[])
          .map((lbl) => session.sinusDiameters[lbl])
          .filter((d): d is NonNullable<typeof d> => !!d)
          .map((d) => ({
            label: d.label,
            value: fmt(d.diameterMm),
            unit: d.heightMm != null ? `mm · h ${fmt(d.heightMm)} mm` : 'mm',
          })),
      });
    }

    sections.push({
      title: 'Risk Assessment',
      rows: [
        { label: 'Coronary Obstruction', value: `${risks.coronaryObstructionRisk.toUpperCase()} — ${risks.coronaryObstructionNote}` },
        { label: 'Conduction Disturbance', value: `${risks.conductionDisturbanceRisk.toUpperCase()} — ${risks.conductionDisturbanceNote}` },
        { label: 'Annular Rupture', value: `${risks.annularRuptureRisk.toUpperCase()} — ${risks.annularRuptureNote}` },
      ],
    });

    // Virtual deployment summary (only when a prosthesis is selected).
    const dep = session.deploymentResult();
    if (session.selectedValve && dep) {
      sections.push({
        title: `Virtual Deployment — ${session.selectedValve.familyName} ${fmt(session.selectedValve.sizeMm, session.selectedValve.sizeMm % 1 === 0 ? 0 : 1)}mm`,
        rows: [
          { label: 'Implant Depth', value: fmt(session.implantDepthMm), unit: 'mm sub-annular' },
          { label: 'Deployment Ratio', value: session.deploymentRatio },
          { label: 'Cover Index', value: fmt(dep.coverIndexPct), unit: '%' },
          { label: `Oversizing (${dep.oversizingMetric})`, value: fmt(dep.oversizingPct, 0), unit: '%' },
          ...dep.coronary.map((c) => ({
            label: `${c.side === 'left' ? 'LCO' : 'RCO'} Clearance`,
            value: `${fmt(c.clearanceMm)} mm — ${c.risk.toUpperCase()}`,
          })),
          { label: 'PVL Risk', value: `${dep.pvl.score}/100 — ${dep.pvl.band.toUpperCase()}` },
          ...dep.pvl.factors.map((f) => ({ label: '·', value: f })),
        ],
      });
    }

    sections.push({
      title: 'Calcification',
      rows: [
        { label: 'LCC Grade', value: String(session.cuspCalcificationGradeLCC) },
        { label: 'RCC Grade', value: String(session.cuspCalcificationGradeRCC) },
        { label: 'NCC Grade', value: String(session.cuspCalcificationGradeNCC) },
        { label: 'Annulus Grade', value: String(session.annulusCalcificationGrade) },
        { label: 'Threshold', value: String(session.calciumThresholdHU), unit: 'HU' },
        ...(session.annulusCalcium ? [
          { label: 'Annulus Agatston 2D', value: fmt(session.annulusCalcium.agatstonScore2D, 0) },
          { label: 'Annulus Hyperdense Area', value: fmt(session.annulusCalcium.hyperdenseAreaMm2), unit: 'mm²' },
        ] : []),
        ...(session.cuspCalciumLCC ? [{ label: 'LCC Agatston 2D', value: fmt(session.cuspCalciumLCC.agatstonScore2D, 0) }] : []),
        ...(session.cuspCalciumRCC ? [{ label: 'RCC Agatston 2D', value: fmt(session.cuspCalciumRCC.agatstonScore2D, 0) }] : []),
        ...(session.cuspCalciumNCC ? [{ label: 'NCC Agatston 2D', value: fmt(session.cuspCalciumNCC.agatstonScore2D, 0) }] : []),
        ...(session.lvotCalcium ? [
          { label: 'LVOT Agatston 2D', value: fmt(session.lvotCalcium.agatstonScore2D, 0) },
          { label: 'LVOT Ca Fraction', value: fmt(session.lvotCalcium.fractionAboveThreshold * 100, 0), unit: '%' },
        ] : []),
      ],
    });

    if (session.notes) {
      sections.push({ title: 'Comments', rows: [{ label: '', value: session.notes }] });
    }

    // Valve-in-Valve planning summary (only when ViV data is present).
    const vivRecs = session.vivRecommendations();
    if (session.viv.surgicalName || session.viv.innerDiameterMm != null) {
      sections.push({
        title: 'Valve-in-Valve Planning',
        rows: [
          ...(session.viv.surgicalName ? [{ label: 'Surgical Valve', value: `${session.viv.surgicalName}${session.viv.surgicalLabelMm != null ? ` ${session.viv.surgicalLabelMm}mm` : ''}` }] : []),
          ...(session.viv.innerDiameterMm != null ? [{ label: 'True Inner Diameter', value: fmt(session.viv.innerDiameterMm), unit: `mm (${session.viv.measured ? 'CT' : 'DB'})` }] : []),
          ...(session.vivBvfAssessment() ? [{ label: 'BVF', value: `${session.vivBvfAssessment()!.feasible ? 'Feasible' : 'Not reported'}${session.vivBvfAssessment()!.estimatedIdGainMm > 0 ? ` (+${fmt(session.vivBvfAssessment()!.estimatedIdGainMm)}mm)` : ''}` }] : []),
          ...(vivRecs ? vivRecs.map((rec) => ({ label: `→ ${rec.familyName} ${rec.sizeMm}mm`, value: `CI ${fmt(rec.coverIndexPct)}% — ${rec.fitStatus.toUpperCase()}` })) : []),
          ...(session.viv.selectedTavi ? [{ label: 'Selected ViV TAVI', value: `${session.viv.selectedTavi.familyName} ${fmt(session.viv.selectedTavi.sizeMm, session.viv.selectedTavi.sizeMm % 1 === 0 ? 0 : 1)}mm` }] : []),
        ],
      });
    }

    const pdf = await buildPdfReport({
      title: 'TAVR Pre-operative CT Analysis Report',
      patientName: session.patientName,
      patientId: session.patientID,
      modality: 'CT',
      sections,
      footnote: 'Generated by NeoDW. Research use only — not for clinical decision-making.',
    });

    const stamp = new Date().toISOString().slice(0, 10);
    if (encapsulate) {
      downloadEncapsulatedPdf({
        pdfBytes: pdf,
        studyInstanceUid: session.studyInstanceUID,
        patientName: session.patientName,
        patientId: session.patientID,
        patientBirthDate: session.patientBirthDate,
        documentTitle: 'TAVR Pre-operative CT Report',
      }, `TAVR_Report_${stamp}.dcm`);
    } else {
      downloadPdf(pdf, `TAVR_Report_${stamp}.pdf`);
    }
  }, [session, annulus, risks, ensureReportSnapshots]);

  const renderPlanningNavigation = () => {
    const canUseAnnulusPlane = !!(session.annulusPlaneCentroid ?? annulus?.centroid);
    return (
      <div className="tavi-card">
        <h3 className="tavi-card-title">Planning Navigation</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6 }}>
          <button className="tavi-button" disabled={!canUseAnnulusPlane} onClick={() => navigateToPlanningPlane(0)}>
            Go Annulus
          </button>
          <button className="tavi-button" disabled={!session.leftOstiumSnapshot} onClick={() => navigateToLandmark(session.leftOstiumSnapshot?.worldPoint)}>
            Go LCA
          </button>
          <button className="tavi-button" disabled={!session.rightOstiumSnapshot} onClick={() => navigateToLandmark(session.rightOstiumSnapshot?.worldPoint)}>
            Go RCA
          </button>
          {[5, 10, 15].map((dist) => (
            <button key={dist} className="tavi-button" disabled={!canUseAnnulusPlane} onClick={() => navigateToPlanningPlane(dist)}>
              +{dist} mm
            </button>
          ))}
        </div>
      </div>
    );
  };

  const renderPlanningSnapshots = () => {
    const snapshots = new Map(session.multiLevelThumbnails);
    for (const [dist, thumb] of multiLevelThumbnails) snapshots.set(dist, thumb);
    const distances = [0, 5, 10, 15];
    const hasSnapshots = distances.some((dist) => snapshots.has(dist));
    return (
      <div className="tavi-card">
        <h3 className="tavi-card-title">Planning Snapshots</h3>
        {!hasSnapshots ? (
          <button
            className="tavi-button tavi-button-capture"
            style={{ width: '100%' }}
            onClick={() => void ensureReportSnapshots(distances)}
            disabled={multiLevelGenerating}
          >
            Generate Annulus / +5 / +10 / +15
          </button>
        ) : (
          <div className="tavi-multilevel-grid">
            {distances.map((dist) => {
              const thumb = snapshots.get(dist);
              return (
                <div key={dist} className="tavi-multilevel-item" onClick={() => navigateToPlanningPlane(dist)}>
                  {thumb && <img src={thumb} alt={dist === 0 ? 'Annulus plane' : `+${dist}mm`} className="tavi-multilevel-thumb" />}
                  <span className="tavi-multilevel-label">{dist === 0 ? 'Annulus' : `+${dist} mm`}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const captureAorticLevel = (structureId: string) => {
    const engine = getEngine();
    if (!engine) return;

    const axVp = engine.getViewport('axial');
    if (!axVp) return;
    const cam = axVp.getCamera();
    if (!cam.focalPoint || !cam.viewPlaneNormal || !cam.viewUp) return;

    const origin: TAVIVector3D = { x: cam.focalPoint[0], y: cam.focalPoint[1], z: cam.focalPoint[2] };
    const normal: TAVIVector3D = { x: cam.viewPlaneNormal[0], y: cam.viewPlaneNormal[1], z: cam.viewPlaneNormal[2] };
    const viewUp: TAVIVector3D = { x: cam.viewUp[0], y: cam.viewUp[1], z: cam.viewUp[2] };

    const volume = cornerstone.cache.getVolume(volumeId);
    if (!volume) return;

    const isAorta = structureId === TAVIStructureAscendingAorta;
    const isSinus = structureId === TAVIStructureSinus;
    const isSTJ = structureId === TAVIStructureSTJ;
    const minDiameterMm = isSinus ? 18 : isSTJ ? 14 : isAorta ? 15 : 8;
    const maxDiameterMm = isAorta ? 55 : 50;

    const seg = autoSegmentCrossSectionAtPlane(volume, origin, normal, viewUp, {
      gridSize: 200,
      pixelSpacing: 0.25,
      maxDiameterMm,
      minDiameterMm,
      searchRadiusMm: 25,
    });

    if (!seg || seg.contourPoints.length < 10) {
      window.alert(
        `Auto-segmentation failed for ${structureId}.\n\n` +
        `Move the crosshair ONTO the contrast-filled lumen pixel and try again. ` +
        `The seed pixel must sit inside the lumen — the algorithm grows from where you point. ` +
        `Expected diameter range: ${minDiameterMm}-${maxDiameterMm} mm.`
      );
      return;
    }

    const contourSnapshot: TAVIContourSnapshot = {
      worldPoints: seg.contourPoints,
      planeNormal: normal,
      planeOrigin: origin,
    };

    if (structureId === TAVIStructureAscendingAorta) session.ascendingAortaSnapshot = contourSnapshot;
    if (structureId === TAVIStructureSTJ) session.stjSnapshot = contourSnapshot;
    if (structureId === TAVIStructureSinus) session.sinusSnapshot = contourSnapshot;

    session.recompute();
    setActiveContourId(structureId);
    forceUpdate();
  };

  const renderAsAortCards = () => (
    <div className="tavi-card">
      <div className="tavi-checklist">
        <Section num="1" title="Ascending Aorta">          {session.ascendingAortaGeometry ? (
            <div>
              <div className="tavi-report-grid" style={{ marginBottom: 4 }}>
                <Row label="Min ø" value={`${fmt(session.ascendingAortaGeometry.minimumDiameterMm)} mm`} />
                <Row label="Max ø" value={`${fmt(session.ascendingAortaGeometry.maximumDiameterMm)} mm`} />
                <Row label="Area" value={`${fmt(session.ascendingAortaGeometry.areaMm2)} mm²`} />
                <Row label="Perimeter" value={`${fmt(session.ascendingAortaGeometry.perimeterMm)} mm`} />
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                {activeContourId === TAVIStructureAscendingAorta && (
                  <button onClick={() => { setActiveContourId(null); forceUpdate(); }}
                    className="tavi-button tavi-button-capture" style={{ flex: 1, fontSize: '0.7rem', padding: '3px' }}>✓ Confirm</button>
                )}
                <button onClick={() => {
                  session.ascendingAortaSnapshot = undefined; session.recompute();
                  setActiveContourId(null); forceUpdate();
                }} className="tavi-button tavi-button-cancel" style={{ flex: activeContourId === TAVIStructureAscendingAorta ? 'none' : 1, fontSize: '0.7rem', padding: '3px' }}>↻ Re-measure</button>
              </div>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Navigate crosshair to ascending aorta level in axial view.
              </div>
              <button onClick={() => captureAorticLevel(TAVIStructureAscendingAorta)}
                className="tavi-button tavi-button-capture"
                style={{ width: '100%', fontSize: '0.72rem', padding: '5px 8px' }}>
                Capture Level
              </button>
            </div>
          )}
        </Section>

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
                  <button onClick={() => { setActiveContourId(null); forceUpdate(); }}
                    className="tavi-button tavi-button-capture" style={{ flex: 1, fontSize: '0.7rem', padding: '3px' }}>✓ Confirm</button>
                )}
                <button onClick={() => {
                  session.stjSnapshot = undefined; session.recompute();
                  setActiveContourId(null); forceUpdate();
                }} className="tavi-button tavi-button-cancel" style={{ flex: activeContourId === TAVIStructureSTJ ? 'none' : 1, fontSize: '0.7rem', padding: '3px' }}>↻ Re-measure</button>
              </div>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Pull crosshair down to STJ level.
              </div>
              <button onClick={() => captureAorticLevel(TAVIStructureSTJ)}
                className="tavi-button tavi-button-capture"
                style={{ width: '100%', fontSize: '0.72rem', padding: '5px 8px' }}>
                Capture Level
              </button>
            </div>
          )}
        </Section>

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
                  <button onClick={() => { setActiveContourId(null); forceUpdate(); }}
                    className="tavi-button tavi-button-capture" style={{ flex: 1, fontSize: '0.7rem', padding: '3px' }}>✓ Confirm</button>
                )}
                <button onClick={() => {
                  session.sinusSnapshot = undefined; session.recompute();
                  setActiveContourId(null); forceUpdate();
                }} className="tavi-button tavi-button-cancel" style={{ flex: activeContourId === TAVIStructureSinus ? 'none' : 1, fontSize: '0.7rem', padding: '3px' }}>↻ Re-measure</button>
              </div>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                Pull crosshair to valve/sinus level.
              </div>
              <button onClick={() => captureAorticLevel(TAVIStructureSinus)}
                className="tavi-button tavi-button-capture"
                style={{ width: '100%', fontSize: '0.72rem', padding: '5px 8px' }}>
                Capture Level
              </button>
            </div>
          )}
        </Section>
        <Section num="4" title="3D Aortic Root Surface">
          {!session.annulusPlaneCentroid ? (
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
              Capture the annulus plane (VALVE tab) to seed the root segmentation.
            </div>
          ) : rootSurface.building ? (
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              Building 3D surface… segmenting the aortic lumen.
            </div>
          ) : (
            <div>
              {rootSurface.error && (
                <div style={{ fontSize: '0.7rem', color: '#f85149', marginBottom: 4 }}>⚠ {rootSurface.error}</div>
              )}
              {rootSurface.mesh ? (
                <>
                  <div className="tavi-report-grid" style={{ marginBottom: 6 }}>
                    <Row label="Volume" value={`${fmt(rootSurface.volumeCm3 ?? 0)} cm³`} />
                    <Row label="Triangles" value={`${rootSurface.mesh.triangleCount.toLocaleString()}`} />
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      onClick={() => {
                        if (session.annulusPlaneCentroid) rootSurface.build(session.annulusPlaneCentroid);
                      }}
                      className="tavi-button tavi-button-cancel"
                      style={{ flex: 1, fontSize: '0.7rem', padding: '4px' }}
                    >↻ Rebuild</button>
                    <button
                      onClick={() => {
                        if (rootSurface.mesh) {
                          const blob = meshToBinarySTL(rootSurface.mesh, 'Aortic root — antidicom');
                          const a = document.createElement('a');
                          a.href = URL.createObjectURL(blob);
                          a.download = 'aortic-root.stl';
                          a.click();
                          URL.revokeObjectURL(a.href);
                        }
                      }}
                      className="tavi-button tavi-button-capture"
                      style={{ flex: 1, fontSize: '0.7rem', padding: '4px' }}
                    >⤓ STL</button>
                    <button
                      onClick={() => rootSurface.clear()}
                      className="tavi-button tavi-button-cancel"
                      style={{ fontSize: '0.7rem', padding: '4px' }}
                    >✕</button>
                  </div>
                </>
              ) : (
                <button
                  onClick={() => {
                    if (session.annulusPlaneCentroid) rootSurface.build(session.annulusPlaneCentroid);
                  }}
                  className="tavi-button tavi-button-capture"
                  style={{ width: '100%', fontSize: '0.72rem', padding: '5px 8px' }}
                >Build 3D Root Surface</button>
              )}
              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.3 }}>
                Seeds from the annulus centroid; shown in the deployment view (VALVE tab).
              </div>
            </div>
          )}
        </Section>
      </div>
    </div>
  );

  const renderVivCards = () => (
    <div className="tavi-card">
      <div className="tavi-checklist">
        <Section num="1" title="Failing Surgical Bioprosthesis">
          <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginBottom: 4 }}>
            Select the existing surgical valve — its true inner diameter drives sizing.
          </div>
          <select
            className="tavi-select"
            value={session.viv.surgicalName ?? ''}
            onChange={(e) => {
              const name = e.target.value || null;
              session.viv.surgicalName = name;
              // Reset label + measured flag when family changes; re-derive ID from DB.
              session.viv.surgicalLabelMm = null;
              session.viv.measured = false;
              session.viv.innerDiameterMm = null;
              forceUpdate();
            }}
            style={{ width: '100%', fontSize: '0.72rem', marginBottom: 4 }}
          >
            <option value="">— Select surgical valve —</option>
            {SURGICAL_BIOPROSTHESES.map((bp) => (
              <option key={bp.name} value={bp.name}>{bp.name}</option>
            ))}
          </select>
          {session.viv.surgicalName && (() => {
            const bp = resolveSurgicalBioprosthesis(session.viv.surgicalName);
            if (!bp) return null;
            return (
              <>
                <select
                  className="tavi-select"
                  value={session.viv.surgicalLabelMm ?? ''}
                  onChange={(e) => {
                    session.viv.surgicalLabelMm = e.target.value ? Number(e.target.value) : null;
                    // Adopt the DB true ID unless a CT measurement overrides it.
                    if (!session.viv.measured && session.viv.surgicalLabelMm != null) {
                      session.viv.innerDiameterMm = bp.trueInnerDiameterMm[session.viv.surgicalLabelMm] ?? null;
                    }
                    forceUpdate();
                  }}
                  style={{ width: '100%', fontSize: '0.72rem' }}
                >
                  <option value="">— Label size —</option>
                  {Object.keys(bp.trueInnerDiameterMm).map((s) => (
                    <option key={s} value={s}>{s} mm</option>
                  ))}
                </select>
                {session.viv.surgicalLabelMm != null && !session.viv.measured && session.viv.innerDiameterMm != null && (
                  <div className="tavi-report-grid" style={{ marginTop: 4 }}>
                    <Row label="True ID (DB)" value={`${fmt(session.viv.innerDiameterMm)} mm`} />
                    <Row label="BVF" value={bp.bvfFeasible ? 'Feasible' : 'N/R'} />
                  </div>
                )}
              </>
            );
          })()}
        </Section>

        <Section num="2" title="Inner Diameter (CT measurement overrides DB)">
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 4 }}>
            Optionally measure the stent inner diameter on CT for this patient.
          </div>
          <div className="tavi-report-grid">
            <label style={{ fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: 4 }}>
              ID
              <input
                type="number" step={0.5} min={10} max={35}
                value={session.viv.innerDiameterMm ?? ''}
                onChange={(e) => {
                  const v = e.target.value ? Number(e.target.value) : null;
                  session.viv.innerDiameterMm = v;
                  session.viv.measured = v != null;
                  forceUpdate();
                }}
                style={{ width: 64, fontSize: '0.72rem' }}
              />
              mm
            </label>
            {session.viv.measured && (
              <span style={{ fontSize: '0.65rem', color: 'var(--accent-green)' }}>✓ CT-measured</span>
            )}
          </div>
        </Section>

        <Section num="3" title="Recommended TAVI-in-Valve">
          {(() => {
            const recs = session.vivRecommendations();
            if (!recs || recs.length === 0) {
              return <p className="tavi-empty">Select a surgical valve or measure its ID for ViV recommendations.</p>;
            }
            const fitColor = (f: string) => f === 'fits' ? '#3fb950' : f === 'tight' ? '#d29922' : f === 'easy' ? '#d29922' : '#f85149';
            return (
              <div className="tavi-valve-sizing">
                {recs.map((rec) => {
                  const isSel = session.viv.selectedTavi?.familyName === rec.familyName && session.viv.selectedTavi?.sizeMm === rec.sizeMm;
                  return (
                    <div key={rec.familyName} className={`tavi-valve-family ${isSel ? 'tavi-valve-family--selected' : ''}`}>
                      <div className="tavi-valve-family-header">
                        <span className="tavi-valve-name">{rec.familyName}</span>
                        <span className={`tavi-valve-type tavi-valve-type--${rec.type}`}>{rec.type === 'balloon-expandable' ? 'BE' : 'SE'}</span>
                      </div>
                      <div className="tavi-valve-sizes">
                        <div className={`tavi-valve-size tavi-valve-size--primary ${rec.fitStatus === 'no' ? 'tavi-valve-size--warning' : ''} ${isSel ? 'tavi-valve-size--selected' : ''}`}>
                          <div className="tavi-valve-size-row">
                            <span className="tavi-valve-size-num">{rec.sizeMm}mm</span>
                            <span className="tavi-valve-size-label" style={{ color: fitColor(rec.fitStatus) }}>{rec.fitStatus.toUpperCase()}</span>
                            <button
                              type="button"
                              className={`tavi-select-btn ${isSel ? 'tavi-select-btn--active' : ''}`}
                              disabled={rec.fitStatus === 'no'}
                              onClick={() => {
                                session.viv.selectedTavi = { familyName: rec.familyName, sizeMm: rec.sizeMm };
                                forceUpdate();
                              }}
                            >{isSel ? '✓' : 'Select'}</button>
                          </div>
                          <span className="tavi-valve-size-range">CI: {fmt(rec.coverIndexPct, 1)}%</span>
                          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', lineHeight: 1.3 }}>{rec.note}</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </Section>

        {(() => {
          const bvf = session.vivBvfAssessment();
          if (!bvf) return null;
          return (
            <Section num="4" title="Bioprosthetic Valve Fracture (BVF)">
              <div className="tavi-report-grid">
                <Row label="Feasible" value={bvf.feasible ? 'Yes' : 'No'} />
                {bvf.estimatedIdGainMm > 0 && <Row label="Est. ID gain" value={`${fmt(bvf.estimatedIdGainMm)} mm`} />}
              </div>
              <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.35 }}>{bvf.note}</div>
            </Section>
          );
        })()}

        {session.viv.selectedTavi && session.viv.innerDiameterMm != null && (
          <Section num="5" title="Nested Frame Simulation">
            <ValveDeploy3D
              layers={(() => {
                // Surgical outer frame + TAVI inner frame, both in annulus space.
                if (!session.annulusPlaneCentroid || !session.annulusPlaneNormal) return [];
                const origin = session.annulusPlaneCentroid;
                const axisRaw = session.aorticAxisDirection ?? session.annulusPlaneNormal;
                const len = Math.hypot(axisRaw.x, axisRaw.y, axisRaw.z) || 1;
                const axis = { x: axisRaw.x / len, y: axisRaw.y / len, z: axisRaw.z / len };
                const helper = Math.abs(axis.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
                const lx = TAVIGeometry.vectorNormalize(TAVIGeometry.vectorCross(helper, axis));
                const ly = TAVIGeometry.vectorNormalize(TAVIGeometry.vectorCross(axis, lx));
                const layers: MeshLayer[] = [];
                if (rootSurface.mesh) layers.push({ mesh: rootSurface.mesh, color: [0.9, 0.55, 0.35], alpha: 0.2 });
                // Surgical bioprosthesis outer frame
                const bp = session.viv.surgicalName ? resolveSurgicalBioprosthesis(session.viv.surgicalName) : null;
                if (bp && session.viv.surgicalLabelMm != null) {
                  const sProfile = surgicalFrameProfile(bp.frameProfile, session.viv.surgicalLabelMm, session.viv.innerDiameterMm, bp.frameHeightMm);
                  const sRings = positionFrame(sProfile, 0, '80/20');
                  layers.push({ mesh: buildFrameMesh(sRings, { origin, axis, localX: lx, localY: ly }, 36), color: [0.75, 0.7, 0.65], alpha: 0.4 });
                }
                // TAVI inner frame (the new valve inside)
                const taviEntry = resolveSelectedValve(session.viv.selectedTavi.familyName, session.viv.selectedTavi.sizeMm);
                if (taviEntry) {
                  const tProfile = frameProfileFor(taviEntry.family.name, taviEntry.family.type === 'self-expanding', taviEntry.size.size);
                  const tRings = positionFrame(tProfile, session.implantDepthMm, session.deploymentRatio);
                  layers.push({ mesh: buildFrameMesh(tRings, { origin, axis, localX: lx, localY: ly }, 36), color: [0.38, 0.78, 1.0], alpha: 0.92 });
                }
                return layers;
              })()}
              refreshKey={`viv-${session.viv.surgicalName}-${session.viv.surgicalLabelMm}-${session.viv.innerDiameterMm}-${session.viv.selectedTavi?.familyName}-${session.viv.selectedTavi?.sizeMm}-${refresh}`}
              height={320}
            />
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 6, fontSize: '0.7rem', color: 'var(--text-muted)' }}>
              <span><span style={{ color: '#5ec9ff' }}>■</span> New TAVI valve</span>
              <span><span style={{ color: '#bfb3a6' }}>■</span> Surgical bioprosthesis</span>
              {rootSurface.mesh && <span><span style={{ color: '#e68c59' }}>■</span> Aortic root</span>}
            </div>
          </Section>
        )}
      </div>
    </div>
  );


  return (
    <div className="tavi-panel">
      <div className="tavi-panel-content">

        {activeTab === 'capture' && (
          <>
            <div className="tavi-subtabs" role="tablist" aria-label="TAVI planning sections">
              {([
                ['valve', 'VALVE'],
                ['as-aort', 'AS.AORT'],
                ['viv', 'ViV'],
              ] as [TAVISubtitle, string][]).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`tavi-subtab ${activeSubtitle === id ? 'active' : ''}`}
                  onClick={() => setActiveSubtitle(id)}
                >
                  {label}
                </button>
              ))}
            </div>

            {activeSubtitle === 'as-aort' && renderAsAortCards()}

            {activeSubtitle === 'viv' && renderVivCards()}

            {activeSubtitle === 'valve' && (
            <div className="tavi-card">
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

                      // Per-structure size envelopes prevent the auto-segmenter from
                      // accepting tiny near-by contrast (calcium plaque, coronary
                      // ostium) when the crosshair sits off-lumen. Aorta/STJ/sinus
                      // realistically span 15–55 mm; anything outside is wrong.
                      const isAorta = structureId === TAVIStructureAscendingAorta;
                      const isSinus = structureId === TAVIStructureSinus;
                      const isSTJ = structureId === TAVIStructureSTJ;
                      const minDiameterMm = isSinus ? 18 : isSTJ ? 14 : isAorta ? 15 : 8;
                      const maxDiameterMm = isAorta ? 55 : 50;

                      // Intentionally omit huMin/huMax: let the segmenter derive
                      // the band from the seed HU at the crosshair. Hard-coding
                      // 150–500 assumed peak-arterial enhancement and starved the
                      // BFS in delayed-phase studies where the lumen is 80–180 HU.
                      const seg = autoSegmentCrossSectionAtPlane(volume, origin, normal, viewUp, {
                        gridSize: 200, pixelSpacing: 0.25,
                        maxDiameterMm,
                        minDiameterMm,
                        searchRadiusMm: 25,
                      });

                      if (!seg || seg.contourPoints.length < 10) {
                        console.warn('[TAVI] Auto-segment failed for', structureId);
                        // Seeded BFS starts at the crosshair voxel. Failure means
                        // either the crosshair is off the contrast-filled lumen,
                        // or the connected region grown from it falls outside the
                        // structure's expected diameter band.
                        window.alert(
                          `Auto-segmentation failed for ${structureId}.\n\n` +
                          `Move the crosshair ONTO the contrast-filled lumen pixel and try again. ` +
                          `The seed pixel must sit inside the lumen — the algorithm grows from where you point. ` +
                          `Expected diameter range: ${minDiameterMm}–${maxDiameterMm} mm.`
                        );
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

                    return (
                      <div className="tavi-checklist">
                        {activeSubtitle === 'valve' && (
                          <>
                        {/* ── 1. Valve alignment hint ── */}
                        <Section num="1" title="Valve Alignment">
                          <div className="tavi-valve-hint">
                            <img
                              src="/tavi/valve-crosshair-hint.png"
                              alt="Aortic valve crosshair alignment"
                              className="tavi-valve-hint-image"
                            />
                            <div className="tavi-valve-hint-text">
                              Place the crosshair on the aortic valve, align to the aorta, then press the 6x Center button.
                            </div>
                          </div>
                        </Section>

                        {/* ── 2. NC Cusp Guide ── */}
                        <Section num="2" title="NC Cusp Region">
                          {ncGuidePoints.length < 5 ? (
                            <div>
                              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                                {ncMarkingActive
                                  ? `Click 5 points along the NC region outline in the axial view. (${ncGuidePoints.length}/5)`
                                  : 'Mark the NC region. Starting this step does not affect other measurements.'}
                              </div>
                              <button onClick={() => {
                                setActiveSinusWidthLabel(null);
                                setSinusWidthProbeCount(0);
                                setSinusWidthMessage(null);
                                clearProbeAnnotations();
                                setNcMarkingActive(true);
                                enableProbeTool();
                              }}
                                className="tavi-button tavi-button-capture"
                                style={{ width: '100%', fontSize: '0.72rem', padding: '5px 8px' }}>
                                {ncMarkingActive
                                  ? (ncGuidePoints.length === 0 ? 'Marking… click axial' : `Next Point (${ncGuidePoints.length}/5)`)
                                  : 'Start Marking NC'}
                              </button>
                              {ncMarkingActive && (
                                <button onClick={() => { setNcMarkingActive(false); disableProbeTool(); }}
                                  className="tavi-button tavi-button-cancel"
                                  style={{ width: '100%', fontSize: '0.68rem', padding: '3px', marginTop: 4 }}>
                                  Pause Marking
                                </button>
                              )}
                            </div>
                          ) : (
                            <div style={{ fontSize: '0.7rem', color: '#eab308', fontWeight: 600, padding: '2px 0' }}>
                              ✓ NC region defined
                            </div>
                          )}
                          {ncGuidePoints.length > 0 && (
                            <button onClick={() => { setNcGuidePoints([]); setNcMarkingActive(false); disableProbeTool(); forceUpdate(); }}
                              className="tavi-button tavi-button-cancel"
                              style={{ width: '100%', fontSize: '0.68rem', padding: '3px', marginTop: 4 }}>
                              ↻ Clear
                            </button>
                          )}
                        </Section>

                        {/* ── 3. Coronary Ostia ── */}
                        <Section num="3" title="Coronary Ostia">
                          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: 4 }}>
                            <input type="checkbox" checked={snapEnabled} onChange={(e) => setSnapEnabled(e.target.checked)} />
                            Snap to anatomy (lumen centroid / cusp nadir)
                          </label>
                          <PlaceRow label="LCO" captured={!!session.leftOstiumSnapshot}
                            onPlace={startSingleProbePlacement}
                            onConfirm={() => captureCoronaryPoint('left')}
                            onUndo={() => { session.leftOstiumSnapshot = undefined; session.recompute(); startSingleProbePlacement(); forceUpdate(); }} />
                          <PlaceRow label="RCO" captured={!!session.rightOstiumSnapshot}
                            onPlace={startSingleProbePlacement}
                            onConfirm={() => captureCoronaryPoint('right')}
                            onUndo={() => { session.rightOstiumSnapshot = undefined; session.recompute(); startSingleProbePlacement(); forceUpdate(); }} />
                          {livePerp != null && (
                            <Row label="View ⟂ to annulus" value={`${livePerp.toFixed(1)}° off`} warn={livePerp > 15} highlight={livePerp <= 5} />
                          )}
                        </Section>

                        {/* ── 4. Cusp Hinge Points ── */}
                        <Section num="4" title="Cusp Hinge Points">
                          <PlaceRow label="LCH" captured={!!cuspPoints.lcc}
                            onPlace={() => cuspPoints.lcc ? startCuspUpdate('lcc') : startSingleProbePlacement()}
                            onConfirm={() => captureCuspFromMPR('lcc')}
                            onUndo={() => { setCuspPoints(p => ({ ...p, lcc: undefined })); session.cuspLCC = undefined; session.recompute(); startSingleProbePlacement(); forceUpdate(); }} />
                          <PlaceRow label="RCH" captured={!!cuspPoints.rcc}
                            onPlace={() => cuspPoints.rcc ? startCuspUpdate('rcc') : startSingleProbePlacement()}
                            onConfirm={() => captureCuspFromMPR('rcc')}
                            onUndo={() => { setCuspPoints(p => ({ ...p, rcc: undefined })); session.cuspRCC = undefined; session.recompute(); startSingleProbePlacement(); forceUpdate(); }} />

                          {/* NCH — estimate first (3mensio places all 3 nadirs, but the
                              non-coronary one is hard to find on MPR; estimate from LCH+RCH
                              gives a starting dot the user verifies / updates by clicking the
                              true nadir). The plane through 3 real nadirs is built later by
                              Auto Trace Annulus / explicit Update. */}
                          {!cuspPoints.ncc && cuspPoints.lcc && cuspPoints.rcc && (() => {
                            const estimate = () => {
                              const lcc = cuspPoints.lcc!, rcc = cuspPoints.rcc!;
                              const mid = { x: (lcc.x+rcc.x)/2, y: (lcc.y+rcc.y)/2, z: (lcc.z+rcc.z)/2 };
                              const chord = TAVIGeometry.vectorSubtract(rcc, lcc);
                              const chordLen = TAVIGeometry.vectorLength(chord);
                              const axisDir = session.aorticAxisDirection
                                ?? controllerRef.current?.getAxisDirection()
                                ?? { x: 0, y: 0, z: 1 };
                              let perp = TAVIGeometry.vectorCross(chord, axisDir);
                              if (TAVIGeometry.vectorLength(perp) < 1e-3) perp = TAVIGeometry.vectorCross(chord, { x: 0, y: 0, z: 1 });
                              perp = TAVIGeometry.vectorNormalize(perp);
                              if (perp.y < 0) perp = TAVIGeometry.vectorScale(perp, -1); // NCC is posterior
                              const nccEst = TAVIGeometry.vectorAdd(mid, TAVIGeometry.vectorScale(perp, (Math.sqrt(3) / 2) * chordLen));
                              session.cuspNCC = nccEst;
                              setCuspPoints(prev => ({ ...prev, ncc: nccEst }));
                              session.recompute(); forceUpdate();
                            };
                            return (
                              <button onClick={estimate}
                                className="tavi-button tavi-button-capture"
                                style={{ width: '100%', fontSize: '0.72rem', padding: '4px 8px', marginBottom: 3 }}>
                                Estimate NCH
                              </button>
                            );
                          })()}
                          {cuspPoints.ncc && (
                            <div style={{ display: 'flex', gap: 4, marginBottom: 3 }}>
                              <button onClick={() => startCuspUpdate('ncc')}
                                className="tavi-button tavi-button-captured"
                                style={{ flex: 1, fontSize: '0.72rem', padding: '4px 6px' }}>
                                {activeCuspUpdate === 'ncc' ? 'Click new NCH' : '✓ NCH'}
                              </button>
                              <button onClick={() => { if (!captureCuspFromMPR('ncc')) startCuspUpdate('ncc'); }}
                                className="tavi-button tavi-button-capture"
                                style={{ flex: 'none', fontSize: '0.72rem', padding: '4px 8px' }}>Update</button>
                              <button onClick={() => { setCuspPoints(p => ({ ...p, ncc: undefined })); session.cuspNCC = undefined; session.recompute(); forceUpdate(); }}
                                className="tavi-button tavi-button-cancel"
                                style={{ flex: 'none', fontSize: '0.72rem', padding: '4px 6px' }}>↻</button>
                            </div>
                          )}
                          {!cuspPoints.lcc && !cuspPoints.rcc && !cuspPoints.ncc && (
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', padding: '2px 0' }}>Place LCH + RCH first; NCH will be estimated, then you can update it.</div>
                          )}
                        </Section>

                        {/* ── 5. Proceed to Oblique Annulus Tracing ── */}
                        <Section num="5" title="Annulus Tracing">
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
                                  let ctrl = controllerRef.current;
                                  if (!ctrl) {
                                    ctrl = new DoubleObliqueController(renderingEngineId, 'axial', 'coronal');
                                    ctrl.initialize(center, axisDir);
                                    controllerRef.current = ctrl;
                                  }
                                  ctrl.alignToPlane(session.annulusPlaneNormal!, session.annulusPlaneCentroid!);
                                  ctrl.unlockScrolling();
                                  disableProbeTool();
                                  setWorkflowPhase('annulus-tracing');
                                  setContourStarted(false);
                                  setContourClosed(false);
                                  setContourPointCount(0);
                                  forceUpdate();
                                  window.setTimeout(() => autoTraceAnnulus(), 100);
                                }, 200);
                              }}
                              className="tavi-button tavi-button-capture"
                              style={{ width: '100%', padding: '8px', fontSize: '0.78rem', fontWeight: 600 }}>
                              Auto Trace Annulus →
                            </button>
                          ) : (
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', padding: '2px 0' }}>
                              Complete cusp hinge points first (LCH + RCH + NCH)
                            </div>
                          )}
                        </Section>

                        {/* Per-sinus diameters (LCS / RCS / NCS) — optional two-Probe measurement */}
                        <Section num="6" title="Per-sinus Width">
                          <div style={{ marginTop: 6, fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                            Place 2 probes across a sinus only when individual LCS/RCS/NCS width is needed.
                          </div>
                          {sinusWidthMessage && (
                            <div style={{ fontSize: '0.68rem', color: sinusWidthProbeCount >= 2 ? 'var(--accent-green)' : '#eab308', margin: '3px 0 5px' }}>
                              {sinusWidthMessage} {activeSinusWidthLabel ? `(${sinusWidthProbeCount}/2)` : ''}
                            </div>
                          )}
                          {(['LCS', 'RCS', 'NCS'] as SinusLabel[]).map((lbl) => {
                            const d = session.sinusDiameters[lbl];
                            const isActiveSinus = activeSinusWidthLabel === lbl;
                            return (
                              <PlaceRow
                                key={lbl}
                                label={`${lbl}${d ? ` ${fmt(d.diameterMm)} mm${d.heightMm != null ? ` · h ${fmt(d.heightMm)}` : ''}` : isActiveSinus ? ` ${sinusWidthProbeCount}/2` : ''}`}
                                captured={!!d}
                                onPlace={() => startSinusWidthPlacement(lbl)}
                                onConfirm={() => captureSinusWidth(lbl)}
                                onUndo={() => { session.clearSinusDiameter(lbl); startSinusWidthPlacement(lbl); forceUpdate(); }}
                              />
                            );
                          })}
                        </Section>
                          </>
                        )}
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
	                        onClick={startSingleProbePlacement}
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
	                            startSingleProbePlacement();
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
	                        onClick={startSingleProbePlacement}
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
	                            startSingleProbePlacement();
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
                      <button onClick={startSingleProbePlacement}
                        className={`tavi-button ${session.leftOstiumSnapshot ? 'tavi-button-captured' : ''}`}
                        style={{ flex: 1, fontSize: '0.7rem', padding: '3px 6px' }}>
                        {session.leftOstiumSnapshot ? '✓ LCO' : 'Place LCO'}
                      </button>
                      <button onClick={() => captureCoronaryPoint('left')}
                        className="tavi-button tavi-button-capture"
                        style={{ flex: 'none', fontSize: '0.7rem', padding: '3px 6px' }}
                        disabled={!!session.leftOstiumSnapshot}>Confirm</button>
                      {session.leftOstiumSnapshot && (
                        <button onClick={() => { session.leftOstiumSnapshot = undefined; session.recompute(); startSingleProbePlacement(); forceUpdate(); }}
                          className="tavi-button tavi-button-cancel" style={{ flex: 'none', fontSize: '0.7rem', padding: '3px 5px' }}>↻</button>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button onClick={startSingleProbePlacement}
                        className={`tavi-button ${session.rightOstiumSnapshot ? 'tavi-button-captured' : ''}`}
                        style={{ flex: 1, fontSize: '0.7rem', padding: '3px 6px' }}>
                        {session.rightOstiumSnapshot ? '✓ RCO' : 'Place RCO'}
                      </button>
                      <button onClick={() => captureCoronaryPoint('right')}
                        className="tavi-button tavi-button-capture"
                        style={{ flex: 'none', fontSize: '0.7rem', padding: '3px 6px' }}
                        disabled={!!session.rightOstiumSnapshot}>Confirm</button>
                      {session.rightOstiumSnapshot && (
                        <button onClick={() => { session.rightOstiumSnapshot = undefined; session.recompute(); startSingleProbePlacement(); forceUpdate(); }}
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
                          onClick={() => { setCuspPoints(p => ({ ...p, lcc: undefined })); setCuspStep('lcc'); setCuspPlaced(false); startSingleProbePlacement(); }}
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
                          onClick={() => { setCuspPoints(p => ({ ...p, ncc: undefined })); setCuspStep('ncc'); setCuspPlaced(false); startSingleProbePlacement(); }}
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
                          onClick={() => { setCuspPoints(p => ({ ...p, rcc: undefined })); setCuspStep('rcc'); setCuspPlaced(false); startSingleProbePlacement(); }}
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
	                              startSingleProbePlacement();
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
	                                clearProbeAnnotations();
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
                        session.annulusSnapshot = undefined;
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
                        Scroll to fine-tune the plane. Auto Trace will segment the annulus on this plane.
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
	                              <button onClick={startSingleProbePlacement}
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
	                                clearProbeAnnotations();
                                if (cusp === 'lcc') { session.cuspLCC = wp; setCuspPoints(prev => ({ ...prev, lcc: wp })); }
                                if (cusp === 'rcc') { session.cuspRCC = wp; setCuspPoints(prev => ({ ...prev, rcc: wp })); }
                                if (cusp === 'ncc') { session.cuspNCC = wp; setCuspPoints(prev => ({ ...prev, ncc: wp })); }
                                session.recompute();
                                // Re-compute annulus plane and re-align
                                if (cuspPoints.lcc && cuspPoints.rcc && cuspPoints.ncc) {
                                  const l = cusp === 'lcc' ? wp : cuspPoints.lcc;
                                  const r = cusp === 'rcc' ? wp : cuspPoints.rcc;
                                  const n = cusp === 'ncc' ? wp : cuspPoints.ncc;
                                  // Signature is (lcc, ncc, rcc) — keep NCC second.
                                  session.captureThreePointAnnulusPlane(l, n, r);
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
                        onClick={autoTraceAnnulus}
                        className="tavi-button tavi-button-capture"
                        style={{ width: '100%', padding: '8px', fontSize: '0.78rem', fontWeight: 600 }}>
                        Auto Trace Annulus
                      </button>
                      <button
                        onClick={() => {
                          contourToolRef.current?.disable();
                          contourToolRef.current = null;
                          syncAnnulusPlaneFromWorkingView();
                          setContourStarted(true);
                          setContourClosed(false);
                          setContourPointCount(0);
                          window.setTimeout(() => initContourTool(), 0);
                          controllerRef.current?.lockScrolling();
                        }}
                        className="tavi-button tavi-button-cancel"
                        style={{ width: '100%', padding: '5px 8px', fontSize: '0.72rem', marginTop: 6 }}>
                        Manual Contour Fallback
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
                        session.annulusSnapshot = undefined;
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

                  {renderPlanningNavigation()}

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
                            session.annulusSnapshot = undefined;
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
            )}

            {activeSubtitle === 'valve' && (
              <>
                {workflowPhase === 'legacy' && (
                  <>
                    {/* ── Legacy Manual Fallback ── */}
                    <div className="tavi-card">
                  <h3 className="tavi-card-title">Manual Fallback</h3>
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
                  </>
                )}

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
                {([
                  ['lcc', 'LCC', session.cuspCalcificationGradeLCC, session.cuspLCC] as const,
                  ['rcc', 'RCC', session.cuspCalcificationGradeRCC, session.cuspRCC] as const,
                  ['ncc', 'NCC', session.cuspCalcificationGradeNCC, session.cuspNCC] as const,
                ]).map(([id, label, grade, center]) => (
                  <div className="tavi-row" key={id}>
                    <span className="tavi-row-label">{label} Grade</span>
                    <span className="tavi-row-value" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <select
                        className="tavi-inline-select"
                        value={grade}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (id === 'lcc') session.cuspCalcificationGradeLCC = v;
                          else if (id === 'rcc') session.cuspCalcificationGradeRCC = v;
                          else session.cuspCalcificationGradeNCC = v;
                          session.recompute();
                          forceUpdate();
                        }}
                      >
                        <option value={0}>None (0)</option>
                        <option value={1}>Mild (1)</option>
                        <option value={2}>Moderate (2)</option>
                        <option value={3}>Severe (3)</option>
                      </select>
                      <button
                        className="tavi-button"
                        style={{ fontSize: '0.7rem', padding: '2px 8px' }}
                        disabled={!center || !(session.annulusPlaneNormal ?? session.activeAnnulusGeometry()?.planeNormal)}
                        title="Sample HU in a 6mm disc around this cusp nadir for 2D Agatston"
                        onClick={() => sampleCuspCalcium(id, center)}
                      >
                        Sample
                      </button>
                    </span>
                  </div>
                ))}
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
                    <Row label="Annulus Agatston 2D" value={fmt(session.annulusCalcium.agatstonScore2D, 0)} />
                    <Row label="Annulus Hyperdense Area" value={`${fmt(session.annulusCalcium.hyperdenseAreaMm2)} mm²`} />
                    <Row label="Annulus Ca Fraction" value={`${fmt(session.annulusCalcium.fractionAboveThreshold * 100, 0)}%`} />
                  </>
                )}
                {session.cuspCalciumLCC && <Row label="LCC Agatston 2D" value={fmt(session.cuspCalciumLCC.agatstonScore2D, 0)} />}
                {session.cuspCalciumRCC && <Row label="RCC Agatston 2D" value={fmt(session.cuspCalciumRCC.agatstonScore2D, 0)} />}
                {session.cuspCalciumNCC && <Row label="NCC Agatston 2D" value={fmt(session.cuspCalciumNCC.agatstonScore2D, 0)} />}
                {session.lvotCalcium && (
                  <>
                    <Row label="LVOT Agatston 2D" value={fmt(session.lvotCalcium.agatstonScore2D, 0)} />
                    <Row label="LVOT Ca Fraction" value={`${fmt(session.lvotCalcium.fractionAboveThreshold * 100, 0)}%`} />
                  </>
                )}
              </div>
                </div>
              </>
            )}

          </>
        )}

        {activeTab === 'report' && (
          <>
            {/* ── Export ── */}
            <div className="tavi-export-bar" style={{ display: 'flex', gap: 6 }}>
              <button className="tavi-button tavi-button-export" onClick={exportReport} style={{ flex: 1 }}>
                Export Text
              </button>
              <button className="tavi-button tavi-button-export" onClick={exportCsvReport} style={{ flex: 1 }} title="Export measurements as CSV (Excel/spreadsheet)">
                Export CSV
              </button>
              <button className="tavi-button tavi-button-export" onClick={exportAnnulusPointsCsv} style={{ flex: 1 }} title="Export cusp, ostium, annulus raw/interpolated points">
                Points CSV
              </button>
              <button className="tavi-button tavi-button-export" onClick={() => void exportPdfReport(false)} style={{ flex: 1 }} title="PDF report">
                Export PDF
              </button>
              <button className="tavi-button tavi-button-export" onClick={() => void exportPdfReport(true)} style={{ flex: 1 }} title="PDF wrapped in DICOM Encapsulated PDF SOP (PACS-compatible)">
                PDF-in-DCM
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

            {renderPlanningNavigation()}
            {renderPlanningSnapshots()}

            {/* ── 2. Valve Sizing Recommendations ── */}
            <div className="tavi-card">
              <h3 className="tavi-card-title">Valve Sizing {selectedValveEntry && <span className="tavi-card-subtitle">· Selected: {selectedValveEntry.family.name} {fmt(session.selectedValve!.sizeMm, session.selectedValve!.sizeMm % 1 === 0 ? 0 : 1)}mm</span>}</h3>
              {valveRecs.length > 0 ? (
                <div className="tavi-valve-sizing">
                  {valveRecs.map((rec) => {
                    const isSelFamily = selectedValveEntry?.family.name === rec.family.name;
                    const isSelPrimary = isSelFamily && session.selectedValve?.sizeMm === rec.primarySize?.size;
                    const isSelAlt = isSelFamily && session.selectedValve?.sizeMm === rec.alternativeSize?.size;
                    return (
                    <div key={rec.family.name} className={`tavi-valve-family ${isSelFamily ? 'tavi-valve-family--selected' : ''}`}>
                      <div className="tavi-valve-family-header">
                        <span className="tavi-valve-name">{rec.family.name}</span>
                        <span className="tavi-valve-mfr">{rec.family.manufacturer}</span>
                        <span className={`tavi-valve-type tavi-valve-type--${rec.family.type}`}>
                          {rec.family.type === 'balloon-expandable' ? 'BE' : 'SE'}
                        </span>
                      </div>
                      {rec.primarySize && (
                        <div className="tavi-valve-sizes">
                          <div className={`tavi-valve-size tavi-valve-size--primary ${rec.fitStatus !== 'in-range' ? 'tavi-valve-size--warning' : ''} ${isSelPrimary ? 'tavi-valve-size--selected' : ''}`}>
                            <div className="tavi-valve-size-row">
                              <span className="tavi-valve-size-num">{rec.primarySize.size}mm</span>
                              <span className="tavi-valve-size-label">
                                {rec.fitStatus === 'in-range' ? 'Recommended' : rec.fitStatus === 'oversized' ? 'Max available' : 'Min available'}
                              </span>
                              <button
                                type="button"
                                className={`tavi-select-btn ${isSelPrimary ? 'tavi-select-btn--active' : ''}`}
                                onClick={() => {
                                  session.selectedValve = { familyName: rec.family.name, sizeMm: rec.primarySize!.size };
                                  session.recompute();
                                  forceUpdate();
                                }}
                              >{isSelPrimary ? '✓ Selected' : 'Select'}</button>
                            </div>
                            <span className="tavi-valve-size-range">
                              ø {fmt(rec.primarySize.perimeterDiameterMin)}-{fmt(rec.primarySize.perimeterDiameterMax)} mm
                            </span>
                            {rec.coverIndex != null && (
                              <span className="tavi-valve-size-range" style={{ color: rec.coverIndex < 0 || rec.coverIndex > 20 ? '#f85149' : '#8b949e' }}>
                                CI: {fmt(rec.coverIndex, 1)}% | OS({rec.oversizingMetric === 'area' ? 'A' : 'P'}): {fmt(rec.oversizingPct ?? 0, 0)}%
                              </span>
                            )}
                          </div>
                          {rec.alternativeSize && (
                            <div className={`tavi-valve-size tavi-valve-size--alt ${isSelAlt ? 'tavi-valve-size--selected' : ''}`}>
                              <div className="tavi-valve-size-row">
                                <span className="tavi-valve-size-num">{rec.alternativeSize.size}mm</span>
                                <span className="tavi-valve-size-label">Alternative</span>
                                <button
                                  type="button"
                                  className={`tavi-select-btn tavi-select-btn--alt ${isSelAlt ? 'tavi-select-btn--active' : ''}`}
                                  onClick={() => {
                                    session.selectedValve = { familyName: rec.family.name, sizeMm: rec.alternativeSize!.size };
                                    session.recompute();
                                    forceUpdate();
                                  }}
                                >{isSelAlt ? '✓ Selected' : 'Select'}</button>
                              </div>
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
                    );
                  })}
                  <div className="tavi-valve-deployment">
                    <span className="tavi-row-label">Deployment Ratio</span>
                    <div className="tavi-deployment-btns">
                      <button
                        className={`tavi-deploy-btn ${session.deploymentRatio === '80/20' ? 'active' : ''}`}
                        onClick={() => setDeploymentRatio('80/20')}
                      >80/20</button>
                      <button
                        className={`tavi-deploy-btn ${session.deploymentRatio === '90/10' ? 'active' : ''}`}
                        onClick={() => setDeploymentRatio('90/10')}
                      >90/10</button>
                    </div>
                  </div>
                  {selectedValveEntry && (
                    <div className="tavi-valve-deployment">
                      <span className="tavi-row-label">Implant Depth</span>
                      <div className="tavi-deployment-btns" style={{ flex: 1 }}>
                        <input
                          type="range" min={0} max={12} step={0.5}
                          value={session.implantDepthMm}
                          onChange={(e) => {
                            session.implantDepthMm = Number(e.target.value);
                            session.recompute();
                            forceUpdate();
                          }}
                          style={{ flex: 1, accentColor: 'var(--nd-accent, #58a6ff)' }}
                          aria-label="Implant depth below annulus"
                        />
                        <span className="tavi-deploy-depth-val">{fmt(session.implantDepthMm)} mm</span>
                      </div>
                    </div>
                  )}
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
                <h3 className="tavi-card-title">
                  Virtual Deployment
                  {deploymentView && selectedValveEntry && (
                    <span className="tavi-card-subtitle">· {selectedValveEntry.family.name} {fmt(session.selectedValve!.sizeMm, session.selectedValve!.sizeMm % 1 === 0 ? 0 : 1)}mm · frame {fmt(deploymentView.frameHeightMm, 0)}mm · depth {fmt(session.implantDepthMm)}mm</span>
                  )}
                </h3>
                {deploymentView ? (
                  <>
                    <ValveDeploy3D
                      layers={deploymentView.layers}
                      landmarks={deploymentView.landmarks}
                      refreshKey={`${session.selectedValve?.familyName}-${session.selectedValve?.sizeMm}-${session.implantDepthMm}-${session.deploymentRatio}-${refresh}`}
                      height={340}
                    />
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 6, fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                      <span><span style={{ color: '#5ec9ff' }}>■</span> Stent frame</span>
                      <span><span style={{ color: '#cccccc' }}>■</span> Annulus plane</span>
                      <span><span style={{ color: '#59f272' }}>●</span> LCC</span>
                      <span><span style={{ color: '#fae034' }}>●</span> NCC</span>
                      <span><span style={{ color: '#fa6666' }}>●</span> RCC</span>
                      <span><span style={{ color: '#ff8c1a' }}>●</span> LCO</span>
                      <span><span style={{ color: '#b266ff' }}>●</span> RCO</span>
                    </div>
                    {deploymentView.deploymentResult && (() => {
                      const dr = deploymentView.deploymentResult;
                      const ciColor = dr.coverIndexPct < 0 || dr.coverIndexPct > 25 ? '#f85149' : dr.coverIndexPct < 5 ? '#d29922' : '#3fb950';
                      return (
                        <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                          <div className="tavi-deploy-metric">
                            <span className="tavi-deploy-metric-label">Cover Index</span>
                            <span className="tavi-deploy-metric-val" style={{ color: ciColor }}>{fmt(dr.coverIndexPct, 1)}%</span>
                          </div>
                          <div className="tavi-deploy-metric">
                            <span className="tavi-deploy-metric-label">Oversizing ({dr.oversizingMetric === 'area' ? 'area' : 'perim'})</span>
                            <span className="tavi-deploy-metric-val">{fmt(dr.oversizingPct, 0)}%</span>
                          </div>
                          {dr.coronary.map((c) => {
                            const clr = c.risk === 'high' ? '#f85149' : c.risk === 'moderate' ? '#d29922' : '#3fb950';
                            return (
                              <div className="tavi-deploy-metric" key={c.side}>
                                <span className="tavi-deploy-metric-label">{c.side === 'left' ? 'LCO' : 'RCO'} clearance</span>
                                <span className="tavi-deploy-metric-val" style={{ color: clr }}>{fmt(c.clearanceMm)} mm {riskBadge(c.risk)}</span>
                              </div>
                            );
                          })}
                          <div className="tavi-deploy-metric" style={{ gridColumn: '1 / -1' }}>
                            <span className="tavi-deploy-metric-label">Paravalvular Leak risk {riskBadge(dr.pvl.band)}</span>
                            <span className="tavi-deploy-metric-val">{dr.pvl.score}/100</span>
                          </div>
                          {dr.pvl.factors.length > 0 && (
                            <div style={{ gridColumn: '1 / -1', fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                              {dr.pvl.factors.join(' · ')}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </>
                ) : (
                  <>
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
                    <p className="tavi-empty" style={{ marginTop: 6 }}>Select a prosthesis above to simulate its deployment in 3D.</p>
                  </>
                )}
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
                      overlapViews={session.cuspOverlapViews}
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
                    Drag along the curve to explore C-arm angles. Ringed markers are the cusp-overlap views (all on the line of perpendicularity); R/L overlap isolates the NCC — the self-expanding working view.
                  </div>
                </>
              ) : (
                <p className="tavi-empty">Capture annulus for projection angles</p>
              )}
            </div>

            {/* ── 5. Structure Geometries ── */}
            <div className="tavi-card">
              <h3 className="tavi-card-title">Structure Geometries</h3>
              <div className="tavi-report-grid">
                <GeoRow label="Ascending Aorta" geo={session.ascendingAortaGeometry} />
                <GeoRow label="STJ" geo={session.stjGeometry} />
                <GeoRow label="Sinus (SOV)" geo={session.sinusGeometry} />
                {(['LCS', 'RCS', 'NCS'] as SinusLabel[]).map((lbl) => {
                  const d = session.sinusDiameters[lbl];
                  return d ? (
                    <Row
                      key={lbl}
                      label={`Sinus ${lbl}`}
                      value={`${fmt(d.diameterMm)} mm${d.heightMm != null ? ` · h ${fmt(d.heightMm)} mm` : ''}`}
                    />
                  ) : null;
                })}
                <GeoRow label="Annulus" geo={annulus} />
                <GeoRow label="LVOT" geo={session.lvotGeometry} />
              </div>
            </div>

            {/* ── 6. Calcification Summary ── */}
            <div className="tavi-card">
              <h3 className="tavi-card-title">Calcification</h3>
              <div className="tavi-report-grid">
                <Row label="LCC Grade" value={['None', 'Mild', 'Moderate', 'Severe'][session.cuspCalcificationGradeLCC]}
                  warn={session.cuspCalcificationGradeLCC >= 2} />
                <Row label="RCC Grade" value={['None', 'Mild', 'Moderate', 'Severe'][session.cuspCalcificationGradeRCC]}
                  warn={session.cuspCalcificationGradeRCC >= 2} />
                <Row label="NCC Grade" value={['None', 'Mild', 'Moderate', 'Severe'][session.cuspCalcificationGradeNCC]}
                  warn={session.cuspCalcificationGradeNCC >= 2} />
                <Row label="Annulus Grade" value={['None', 'Mild', 'Moderate', 'Severe'][session.annulusCalcificationGrade]}
                  warn={session.annulusCalcificationGrade >= 2} />
                <Row label="Threshold" value={`${session.calciumThresholdHU} HU`} />
                {session.annulusCalcium && (
                  <>
                    <Row label="Annulus Agatston 2D" value={fmt(session.annulusCalcium.agatstonScore2D, 0)} />
                    <Row label="Annulus Hyperdense Area" value={`${fmt(session.annulusCalcium.hyperdenseAreaMm2)} mm²`} />
                    <Row label="Annulus Ca Fraction" value={`${fmt(session.annulusCalcium.fractionAboveThreshold * 100, 0)}%`} />
                  </>
                )}
                {session.cuspCalciumLCC && <Row label="LCC Agatston 2D" value={fmt(session.cuspCalciumLCC.agatstonScore2D, 0)} />}
                {session.cuspCalciumRCC && <Row label="RCC Agatston 2D" value={fmt(session.cuspCalciumRCC.agatstonScore2D, 0)} />}
                {session.cuspCalciumNCC && <Row label="NCC Agatston 2D" value={fmt(session.cuspCalciumNCC.agatstonScore2D, 0)} />}
                {session.lvotCalcium && (
                  <>
                    <Row label="LVOT Agatston 2D" value={fmt(session.lvotCalcium.agatstonScore2D, 0)} />
                    <Row label="LVOT Ca Fraction" value={`${fmt(session.lvotCalcium.fractionAboveThreshold * 100, 0)}%`} />
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
      {activeSubtitle === 'as-aort' && activeContourId === TAVIStructureAscendingAorta && session.ascendingAortaSnapshot && session.ascendingAortaGeometry && (
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
      {activeSubtitle === 'as-aort' && activeContourId === TAVIStructureSTJ && session.stjSnapshot && session.stjGeometry && (
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
      {activeSubtitle === 'as-aort' && activeContourId === TAVIStructureSinus && session.sinusSnapshot && session.sinusGeometry && (
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
      {activeSubtitle === 'valve' && workflowPhase !== 'annulus-tracing' && session.annulusSnapshot && (session.annulusGeometry ?? annulus) && (
        <ContourOverlay
          key={`annulus-${refresh}`}
          renderingEngineId={renderingEngineId}
          viewportId={viewportMode === 'tavi-oblique' ? 'coronal' : 'axial'}
          contourPoints={session.annulusSnapshot.worldPoints}
          geometry={(session.annulusGeometry ?? annulus)!}
          planeNormal={session.annulusSnapshot.planeNormal}
          contourColor="#ffffff"
          handleCount={24}
          showFill={false}
          showMeasurements={false}
          onContourEdited={(newPts) => {
            const rawPoints = resampleClosedContourByCount(newPts, 24);
            session.annulusRawContourPoints = rawPoints;
            session.annulusSnapshot = {
              ...session.annulusSnapshot!,
              worldPoints: newPts,
              planeOrigin: rawPoints[0] ?? session.annulusSnapshot!.planeOrigin,
            };
            session.useAssistedAnnulusForPlanning = true;
            session.recompute();
            setRefresh(r => r + 1);
          }}
        />
      )}

      {/* ── NC cusp guide triangle on all viewports ── */}
      {activeSubtitle === 'valve' && ncGuidePoints.length >= 2 && (
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
