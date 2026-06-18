import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import { enableProbeTool, disableProbeTool } from '../core/toolManager';
import { autoSegmentCrossSectionAtPlane } from '../tavi/AorticAxisDetection';
import { TAVIGeometry } from '../tavi/TAVIGeometry';
import { useSeededSegmentation } from '../la/useSeededSegmentation';
import { AngioProjectionSimulator } from './AngioProjectionSimulator';
import { recommendGraftSizes } from '../vascular/vascularGraftDatabase';
import type { TAVIGeometryResult, TAVIVector3D } from '../tavi/TAVITypes';

type VascularStep =
  | 'segmentation'
  | 'centerline'
  | 'length'
  | 'diameter'
  | 'neck'
  | 'trajectory'
  | 'virtual-angio'
  | 'fenestrated'
  | 'iliac'
  | 'template';

type ViewportId = 'axial' | 'sagittal' | 'coronal';

interface LengthMeasurement {
  id: string;
  label: string;
  fromArcMm: number;
  toArcMm: number;
  lengthMm: number;
}

interface DiameterMeasurement {
  id: string;
  label: string;
  arcMm: number;
  viewportId: ViewportId;
  minDiameterMm: number;
  maxDiameterMm: number;
  areaMm2: number;
  perimeterMm: number;
  equivalentDiameterMm: number;
}

interface NeckSlice {
  arcMm: number;
  minDiameterMm: number;
  maxDiameterMm: number;
  equivDiameterMm: number;
}

/**
 * Stent apposition grade for a neck slice (3mensio §3.3.4): graded by the
 * diameter increase relative to the proximal seal (baseline) diameter.
 * green ≤10%, orange 10–20%, red >20% (apposition lost / aneurysmal).
 */
function appositionColor(increasePct: number): string {
  if (increasePct > 20) return '#f85149'; // red
  if (increasePct > 10) return '#d29922'; // orange
  return '#3fb950'; // green
}

interface FenestrationMeasurement {
  id: string;
  label: string;
  clockHour: number;
  heightMm: number;
  innerAorticDiameterMm: number;
  branchDiameterMm: number;
}

interface IliacMeasurement {
  id: string;
  side: 'left' | 'right';
  vessel: string;
  lengthMm: number;
  diameterMm: number;
  angleDeg: number;
}

interface Props {
  renderingEngineId: string;
  volumeId: string;
  patientName?: string;
  studyDate?: string;
}

export interface VascularPanelHandle {
  resetAll: () => void;
}

const STEPS: Array<{ id: VascularStep; title: string; hint: string }> = [
  { id: 'segmentation', title: '1. Vessel Segmentation', hint: 'Seed the aorta, tune inclusion, then confirm the segmented vessel tree.' },
  { id: 'centerline', title: '2. Centerline Detection', hint: 'Place start, bifurcation and endpoints. Correct every point before confirming.' },
  { id: 'length', title: '3. Length Measurements', hint: 'Set a baseline, move the cursor along the centerline, then measure from baseline or custom ranges.' },
  { id: 'diameter', title: '4. Diameter Measurements', hint: 'At the cursor position, capture min/max diameter and lumen area in the perpendicular plane.' },
  { id: 'neck', title: '5. Neck / Apposition', hint: 'Define neck start/end and review sampled diameters for apposition risk.' },
  { id: 'trajectory', title: '6. Trajectory Diameter', hint: 'Compare the full access trajectory against a catheter or delivery system diameter.' },
  { id: 'virtual-angio', title: '7. Virtual Angio', hint: 'Record C-arm working angles for the selected centerline position.' },
  { id: 'fenestrated', title: '8. Fenestrated', hint: 'Clock position, height, inner aortic diameter and branch diameter for visceral ostia.' },
  { id: 'iliac', title: '9. Iliac Branches', hint: 'Internal iliac centerline length, branch diameter and take-off angle.' },
  { id: 'template', title: '10. Template / Virtual Stent', hint: 'Collect measurements into a generic AAA/TAA sizing sheet.' },
];

const FEN_LABELS = ['Celiac', 'SMA', 'Right renal', 'Left renal', 'Extra renal', 'Custom'];

function fmt(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '-';
  return value.toFixed(digits);
}

function distance(a: TAVIVector3D, b: TAVIVector3D): number {
  return TAVIGeometry.vectorDistance(a, b);
}

function cumulativeLengths(points: TAVIVector3D[]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++) {
    out.push(out[i - 1] + distance(points[i - 1], points[i]));
  }
  return out;
}

function pointAtArc(points: TAVIVector3D[], arcMm: number): TAVIVector3D | null {
  if (points.length === 0) return null;
  if (points.length === 1) return points[0];
  const arcs = cumulativeLengths(points);
  const total = arcs[arcs.length - 1];
  const target = Math.max(0, Math.min(total, arcMm));
  for (let i = 1; i < arcs.length; i++) {
    if (arcs[i] < target) continue;
    const span = arcs[i] - arcs[i - 1];
    const t = span > 0 ? (target - arcs[i - 1]) / span : 0;
    const a = points[i - 1];
    const b = points[i];
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
    };
  }
  return points[points.length - 1];
}

function centerlineLength(points: TAVIVector3D[]): number {
  const arcs = cumulativeLengths(points);
  return arcs[arcs.length - 1] ?? 0;
}

/** Unit tangent of the centerline at a given arc length (central difference). */
function tangentAtArc(points: TAVIVector3D[], arcMm: number): TAVIVector3D | null {
  if (points.length < 2) return null;
  const a = pointAtArc(points, Math.max(0, arcMm - 1));
  const b = pointAtArc(points, arcMm + 1);
  if (!a || !b) return null;
  const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const len = Math.hypot(d.x, d.y, d.z);
  return len > 1e-6 ? { x: d.x / len, y: d.y / len, z: d.z / len } : null;
}

function tortuosity(points: TAVIVector3D[]): number {
  if (points.length < 2) return 1;
  const len = centerlineLength(points);
  const straight = distance(points[0], points[points.length - 1]);
  return straight > 0 ? len / straight : 1;
}

/** Sample the HU value at a world coordinate from the source volume. */
function sampleHUAtWorld(volumeId: string, world: TAVIVector3D): number | null {
  const volume = cornerstone.cache.getVolume(volumeId) as
    | (cornerstone.Types.IImageVolume & { voxelManager?: { getCompleteScalarDataArray?: () => ArrayLike<number> } })
    | undefined;
  if (!volume?.imageData) return null;
  const ijk = volume.imageData.worldToIndex([world.x, world.y, world.z]);
  const dims = volume.imageData.getDimensions();
  const i = Math.round(ijk[0]);
  const j = Math.round(ijk[1]);
  const k = Math.round(ijk[2]);
  if (i < 0 || i >= dims[0] || j < 0 || j >= dims[1] || k < 0 || k >= dims[2]) return null;
  const idx = i + j * dims[0] + k * dims[0] * dims[1];
  const arr = volume.voxelManager?.getCompleteScalarDataArray?.();
  if (arr) return (arr[idx] ?? null) as number | null;
  const tuple = volume.imageData.getPointData?.()?.getScalars?.()?.getTuple?.(idx);
  return tuple?.[0] ?? null;
}

/**
 * Snap a clicked seed off any calcium/partial-volume spike onto true lumen by
 * taking the neighborhood-median HU and returning the in-neighborhood voxel
 * closest to that median. Prevents seeding on a hot calcified spot (which both
 * inflates the HU band and lets the flood cross into bone).
 */
function robustSeed(volumeId: string, world: TAVIVector3D): { world: TAVIVector3D; hu: number } | null {
  const volume = cornerstone.cache.getVolume(volumeId) as
    | (cornerstone.Types.IImageVolume & { voxelManager?: { getCompleteScalarDataArray?: () => ArrayLike<number> } })
    | undefined;
  if (!volume?.imageData) return null;
  const arr = volume.voxelManager?.getCompleteScalarDataArray?.();
  if (!arr) return { world, hu: sampleHUAtWorld(volumeId, world) ?? 350 };
  const dims = volume.imageData.getDimensions();
  const c = volume.imageData.worldToIndex([world.x, world.y, world.z]).map((v) => Math.round(v)) as number[];
  const R = 2;
  const samples: { i: number; j: number; k: number; hu: number }[] = [];
  for (let dk = -R; dk <= R; dk++)
    for (let dj = -R; dj <= R; dj++)
      for (let di = -R; di <= R; di++) {
        const i = c[0] + di, j = c[1] + dj, k = c[2] + dk;
        if (i < 0 || i >= dims[0] || j < 0 || j >= dims[1] || k < 0 || k >= dims[2]) continue;
        const hu = arr[i + j * dims[0] + k * dims[0] * dims[1]] as number;
        if (Number.isFinite(hu)) samples.push({ i, j, k, hu });
      }
  if (samples.length === 0) return { world, hu: sampleHUAtWorld(volumeId, world) ?? 350 };
  const sorted = [...samples].sort((a, b) => a.hu - b.hu);
  const median = sorted[Math.floor(sorted.length / 2)].hu;
  let best = samples[0];
  for (const s of samples) if (Math.abs(s.hu - median) < Math.abs(best.hu - median)) best = s;
  const w = volume.imageData.indexToWorld([best.i, best.j, best.k]);
  return { world: { x: w[0], y: w[1], z: w[2] }, hu: best.hu };
}

/**
 * Map seed HU + a 0–100 "include smaller branches" sensitivity to a flood-fill
 * HU band. Sensitivity widens BOTH ends: a higher value reaches dimmer distal
 * branches (lower floor) and brighter/denser contrast (higher ceiling) so the
 * grow can cover the whole vessel; a lower value keeps it tight to avoid leaks.
 * The ceiling stays under dense cortical bone (~>700 HU) so the vertebral cortex,
 * where the descending aorta abuts the spine, remains out-of-band and walls the
 * flood off — even though softer cancellous bone is in-band, it is unreachable
 * behind that cortical barrier.
 */
function huBandForSeed(seedHU: number, sensitivity: number): { minHU: number; maxHU: number } {
  const s = Math.max(0, Math.min(1, sensitivity / 100));
  const minHU = Math.max(150, Math.min(320, Math.round(seedHU - (120 + s * 140))));
  // Always give the ceiling real headroom above the (often very bright) lumen so
  // dense contrast does not block the BFS, but never above ~680 HU (cortical bone).
  const maxHU = Math.max(Math.round(seedHU + 60), Math.min(680, Math.round(seedHU + (90 + s * 180))));
  return { minHU, maxHU };
}

function row(label: string, value: string, warn = false) {
  return (
    <div className="tavi-row">
      <span className="tavi-row-label">{label}</span>
      <span className={`tavi-row-value ${warn ? 'tavi-row-warn' : ''}`}>{value}</span>
    </div>
  );
}

/**
 * Build a flood-fill exclude mask: voxels within `radiusMm` of any exclusion
 * centre are marked hard-background (1) so the region grow cannot enter them.
 * Used to cut the bridge into the heart / aortic root (3mensio "Remove Heart").
 */
function buildExcludeMask(volumeId: string, centers: TAVIVector3D[], radiusMm: number): Uint8Array | null {
  if (centers.length === 0) return null;
  const volume = cornerstone.cache.getVolume(volumeId);
  if (!volume?.imageData) return null;
  const dims = volume.imageData.getDimensions();
  const spacing = volume.imageData.getSpacing();
  const [dx, dy, dz] = dims;
  const mask = new Uint8Array(dx * dy * dz);
  const stride = dx * dy;
  for (const c of centers) {
    const ijk = volume.imageData.worldToIndex([c.x, c.y, c.z]).map((v) => Math.round(v)) as number[];
    const ri = Math.ceil(radiusMm / spacing[0]);
    const rj = Math.ceil(radiusMm / spacing[1]);
    const rk = Math.ceil(radiusMm / spacing[2]);
    for (let k = Math.max(0, ijk[2] - rk); k <= Math.min(dz - 1, ijk[2] + rk); k++)
      for (let j = Math.max(0, ijk[1] - rj); j <= Math.min(dy - 1, ijk[1] + rj); j++)
        for (let i = Math.max(0, ijk[0] - ri); i <= Math.min(dx - 1, ijk[0] + ri); i++) {
          const ddx = (i - ijk[0]) * spacing[0];
          const ddy = (j - ijk[1]) * spacing[1];
          const ddz = (k - ijk[2]) * spacing[2];
          if (ddx * ddx + ddy * ddy + ddz * ddz <= radiusMm * radiusMm) mask[i + j * dx + k * stride] = 1;
        }
  }
  return mask;
}

const EXCLUDE_RADIUS_MM = 18;

export const VascularPanel = forwardRef<VascularPanelHandle, Props>(function VascularPanel({
  renderingEngineId,
  volumeId,
  patientName,
  studyDate,
}, ref) {
  const [activeStep, setActiveStep] = useState<VascularStep>('segmentation');
  const [seedPoint, setSeedPoint] = useState<TAVIVector3D | null>(null);
  const [seedHU, setSeedHU] = useState<number | null>(null);
  // Additional positive seeds (3mensio "Add Vessel") + exclusion centres ("Remove Heart").
  const [extraSeeds, setExtraSeeds] = useState<TAVIVector3D[]>([]);
  const [excludeSeeds, setExcludeSeeds] = useState<TAVIVector3D[]>([]);
  const [segPlaceMode, setSegPlaceMode] = useState<'seed' | 'addVessel' | 'exclude' | null>(null);
  const [segmentationConfirmed, setSegmentationConfirmed] = useState(false);
  const [sensitivity, setSensitivity] = useState(50);
  const seg = useSeededSegmentation({
    renderingEngineId,
    volumeId,
    segmentationId: 'vascularSegmentation',
    color: [230, 70, 70, 150],
    maxVoxels: 4_000_000, // full aorta + iliacs at sub-mm spacing
  });
  // Latest seg ref so the unmount cleanup can drop the labelmap without re-running
  // every render (seg is a fresh object each render).
  const segRef = useRef(seg);
  segRef.current = seg;
  const [centerlinePoints, setCenterlinePoints] = useState<TAVIVector3D[]>([]);
  const [centerlineConfirmed, setCenterlineConfirmed] = useState(false);
  const [centerlineCapturing, setCenterlineCapturing] = useState(false);
  const [cursorArcMm, setCursorArcMm] = useState(0);
  const [baselineArcMm, setBaselineArcMm] = useState<number | null>(null);
  const [lengths, setLengths] = useState<LengthMeasurement[]>([]);
  const [diameters, setDiameters] = useState<DiameterMeasurement[]>([]);
  const [diameterViewport, setDiameterViewport] = useState<ViewportId>('axial');
  const [diameterBusy, setDiameterBusy] = useState(false);
  const [neckStartMm, setNeckStartMm] = useState<number | null>(null);
  const [neckEndMm, setNeckEndMm] = useState<number | null>(null);
  const [neckSpacingMm, setNeckSpacingMm] = useState(5);
  const [stentDiameterMm, setStentDiameterMm] = useState(30);
  const [graftSegment, setGraftSegment] = useState<'AAA' | 'TAA'>('AAA');
  const [neckSlices, setNeckSlices] = useState<NeckSlice[]>([]);
  const [neckBusy, setNeckBusy] = useState(false);
  const [catheterMm, setCatheterMm] = useState(7);
  const [fenestrations, setFenestrations] = useState<FenestrationMeasurement[]>([]);
  const [fenDraft, setFenDraft] = useState({ label: 'Right renal', clockHour: 3, heightMm: 0, innerAorticDiameterMm: 24, branchDiameterMm: 6 });
  const [iliacs, setIliacs] = useState<IliacMeasurement[]>([]);
  const [iliacDraft, setIliacDraft] = useState({ side: 'left' as 'left' | 'right', vessel: 'Internal iliac', lengthMm: 0, diameterMm: 6, angleDeg: 0 });
  const [status, setStatus] = useState<string>('Load CTA, then seed a contrast-filled vessel.');
  const [refresh, setRefresh] = useState(0);
  const overlayCleanupRef = useRef<(() => void) | null>(null);

  const totalLength = useMemo(() => centerlineLength(centerlinePoints), [centerlinePoints]);
  const cursorPoint = useMemo(() => pointAtArc(centerlinePoints, cursorArcMm), [centerlinePoints, cursorArcMm]);
  const trajectoryNarrow = useMemo(
    () => diameters.filter((d) => d.minDiameterMm < catheterMm),
    [diameters, catheterMm]
  );

  const getEngine = useCallback(() => cornerstone.getRenderingEngine(renderingEngineId) ?? undefined, [renderingEngineId]);

  const clearProbeAnnotations = useCallback(() => {
    const engine = getEngine();
    if (!engine) return;
    for (const vpId of ['axial', 'sagittal', 'coronal'] as ViewportId[]) {
      const vp = engine.getViewport(vpId);
      if (!vp?.element) continue;
      const probes = cornerstoneTools.annotation.state.getAnnotations('Probe', vp.element);
      for (const probe of [...(probes ?? [])]) {
        if (probe.annotationUID) cornerstoneTools.annotation.state.removeAnnotation(probe.annotationUID);
      }
      vp.render();
    }
  }, [getEngine]);

  const latestProbePoint = useCallback((): TAVIVector3D | null => {
    const engine = getEngine();
    if (!engine) return null;
    for (const vpId of ['coronal', 'sagittal', 'axial'] as ViewportId[]) {
      const vp = engine.getViewport(vpId);
      if (!vp?.element) continue;
      const probes = cornerstoneTools.annotation.state.getAnnotations('Probe', vp.element);
      const last = probes?.[probes.length - 1];
      const p = last?.data?.handles?.points?.[0];
      if (p) return { x: p[0], y: p[1], z: p[2] };
    }
    return null;
  }, [getEngine]);

  const resetAll = useCallback(() => {
    disableProbeTool();
    clearProbeAnnotations();
    overlayCleanupRef.current?.();
    seg.clear();
    setActiveStep('segmentation');
    setSeedPoint(null);
    setSeedHU(null);
    setExtraSeeds([]);
    setExcludeSeeds([]);
    setSegPlaceMode(null);
    setSegmentationConfirmed(false);
    setSensitivity(50);
    setCenterlinePoints([]);
    setCenterlineConfirmed(false);
    setCenterlineCapturing(false);
    setCursorArcMm(0);
    setBaselineArcMm(null);
    setLengths([]);
    setDiameters([]);
    setNeckStartMm(null);
    setNeckEndMm(null);
    setNeckSlices([]);
    setStentDiameterMm(30);
    setCatheterMm(7);
    setFenestrations([]);
    setIliacs([]);
    setStatus('Vascular session reset.');
    setRefresh((v) => v + 1);
  }, [clearProbeAnnotations, seg]);

  useImperativeHandle(ref, () => ({ resetAll }), [resetAll]);

  useEffect(() => {
    return () => {
      disableProbeTool();
      clearProbeAnnotations();
      overlayCleanupRef.current?.();
      segRef.current.clear(); // drop the labelmap segmentation on unmount
    };
  }, [clearProbeAnnotations]);

  const startProbe = (message: string) => {
    clearProbeAnnotations();
    enableProbeTool();
    setStatus(message);
  };

  /** Grow the 3D blood-pool mask from a primary seed + optional extra seeds
   *  (Add Vessel) and exclusion regions (Remove Heart). */
  const growFrom = async (
    primary: TAVIVector3D,
    hu: number | null,
    extras: TAVIVector3D[],
    excludes: TAVIVector3D[],
  ) => {
    const baseHU = hu ?? sampleHUAtWorld(volumeId, primary) ?? 350;
    const { minHU, maxHU } = huBandForSeed(baseHU, sensitivity);
    const excludeMask = buildExcludeMask(volumeId, excludes, EXCLUDE_RADIUS_MM);
    setStatus(`Growing vessel (HU ${fmt(baseHU, 0)}, band ${minHU}–${maxHU})…`);
    const res = await seg.runFromSeed([primary.x, primary.y, primary.z], {
      minHU, maxHU,
      extraSeeds: extras.map((p) => [p.x, p.y, p.z]),
      excludeMask,
    });
    if (!res) {
      setStatus(seg.error ?? 'Segmentation failed. Re-place the seed inside contrast and retry.');
      return;
    }
    setSegmentationConfirmed(false);
    if (res.voxelCount < 200) {
      setStatus(`Only ${res.voxelCount.toLocaleString()} voxels grew — seed may be off the lumen or band too tight. Re-seed in bright contrast or raise sensitivity.`);
      return;
    }
    setStatus(
      `Segmented ${res.voxelCount.toLocaleString()} voxels (${fmt(res.volumeCm3)} cm³)` +
      `${res.leaked ? ' — possible leak; lower sensitivity, exclude the heart, or re-seed.' : '. Confirm to lock the vessel scaffold.'}`
    );
  };

  const regrow = async () => {
    if (!seedPoint) { setStatus('Place a seed inside the aortic lumen first.'); return; }
    await growFrom(seedPoint, seedHU, extraSeeds, excludeSeeds);
  };

  const startSegPlacement = (mode: 'seed' | 'addVessel' | 'exclude') => {
    const msg = mode === 'seed'
      ? 'Click the contrast-filled aortic lumen — the mask grows automatically.'
      : mode === 'addVessel'
        ? 'Click an unconnected vessel/branch (e.g. a renal) to merge it into the mask.'
        : 'Click the heart / aortic-root bridge to exclude it from the grow.';
    startProbe(msg);
    setSegPlaceMode(mode);
  };

  // Auto-capture probe clicks for seed / add-vessel / exclude placement, then re-grow.
  useEffect(() => {
    if (activeStep !== 'segmentation' || !segPlaceMode) return;
    const id = window.setInterval(() => {
      const p = latestProbePoint();
      if (!p) return;
      clearProbeAnnotations();
      disableProbeTool();
      const mode = segPlaceMode;
      setSegPlaceMode(null);
      if (mode === 'seed') {
        const snap = robustSeed(volumeId, p);
        const seedW = snap?.world ?? p;
        const hu = snap?.hu ?? sampleHUAtWorld(volumeId, p);
        setSeedPoint(seedW);
        setSeedHU(hu);
        void growFrom(seedW, hu, extraSeeds, excludeSeeds);
      } else if (mode === 'addVessel') {
        const snap = robustSeed(volumeId, p);
        const next = [...extraSeeds, snap?.world ?? p];
        setExtraSeeds(next);
        if (seedPoint) void growFrom(seedPoint, seedHU, next, excludeSeeds);
      } else {
        const next = [...excludeSeeds, p];
        setExcludeSeeds(next);
        if (seedPoint) void growFrom(seedPoint, seedHU, extraSeeds, next);
      }
    }, 200);
    return () => window.clearInterval(id);
    // sensitivity is included so a slider change mid-placement re-captures a
    // fresh growFrom closure (otherwise the grow uses a stale HU band).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStep, segPlaceMode, seedPoint, seedHU, extraSeeds, excludeSeeds, sensitivity, volumeId, clearProbeAnnotations]);

  const startCenterlineCapture = () => {
    startProbe('Click the vessel center along the path — each click adds a control point automatically.');
    setCenterlineCapturing(true);
  };

  const undoCenterlinePoint = () => {
    setCenterlinePoints((prev) => {
      const next = prev.slice(0, -1);
      setCursorArcMm(Math.min(cursorArcMm, centerlineLength(next)));
      return next;
    });
    setCenterlineConfirmed(false);
    setRefresh((v) => v + 1);
  };

  const confirmCenterline = () => {
    if (centerlinePoints.length < 2) {
      setStatus('Place at least two centerline points first (click along the vessel).');
      return;
    }
    setCenterlineCapturing(false);
    disableProbeTool();
    clearProbeAnnotations();
    setCenterlineConfirmed(true);
    setActiveStep('length');
    setStatus('Centerline confirmed. Measurements are now tied to this centerline.');
  };

  // Auto-capture: while placing centerline points, append every probe click as a
  // control point (no separate "Add Point" step), then clear the probe so the
  // next click is fresh.
  useEffect(() => {
    if (activeStep !== 'centerline' || !centerlineCapturing) return;
    const id = window.setInterval(() => {
      const engine = getEngine();
      if (!engine) return;
      const captured: TAVIVector3D[] = [];
      for (const vpId of ['axial', 'sagittal', 'coronal'] as ViewportId[]) {
        const vp = engine.getViewport(vpId);
        if (!vp?.element) continue;
        const probes = cornerstoneTools.annotation.state.getAnnotations('Probe', vp.element) ?? [];
        for (const pr of probes) {
          const pt = pr.data?.handles?.points?.[0];
          if (pt) captured.push({ x: pt[0], y: pt[1], z: pt[2] });
        }
      }
      if (captured.length === 0) return;
      setCenterlinePoints((prev) => {
        // Drop points coincident with the last one (a tick can re-read a probe
        // before its removal propagates) — zero-length segments break tangents.
        const next = [...prev];
        for (const c of captured) {
          const last = next[next.length - 1];
          if (!last || distance(last, c) > 0.5) next.push(c);
        }
        if (next.length === prev.length) return prev;
        setCursorArcMm(centerlineLength(next));
        return next;
      });
      setCenterlineConfirmed(false);
      clearProbeAnnotations();
      enableProbeTool();
      setStatus('Control point added. Keep clicking along the vessel, then Confirm.');
      setRefresh((v) => v + 1);
    }, 250);
    return () => window.clearInterval(id);
  }, [activeStep, centerlineCapturing, getEngine, clearProbeAnnotations]);

  const setCursor = (arc: number) => {
    const next = Math.max(0, Math.min(totalLength, arc));
    setCursorArcMm(next);
    const p = pointAtArc(centerlinePoints, next);
    const engine = getEngine();
    if (engine && p) {
      for (const vpId of ['axial', 'sagittal', 'coronal'] as ViewportId[]) {
        const vp = engine.getViewport(vpId);
        const cam = vp?.getCamera();
        if (!vp || !cam?.viewPlaneNormal) continue;
        const vpn = cam.viewPlaneNormal;
        const d = 1000;
        vp.setCamera({
          ...cam,
          focalPoint: [p.x, p.y, p.z],
          position: [p.x + vpn[0] * d, p.y + vpn[1] * d, p.z + vpn[2] * d],
        });
        vp.render();
      }
    }
  };

  const addLengthFromBaseline = () => {
    if (baselineArcMm == null) {
      setStatus('Set a baseline first.');
      return;
    }
    const len = Math.abs(cursorArcMm - baselineArcMm);
    setLengths((prev) => [
      ...prev,
      {
        id: `len-${Date.now()}`,
        label: `Baseline to ${fmt(cursorArcMm)} mm`,
        fromArcMm: baselineArcMm,
        toArcMm: cursorArcMm,
        lengthMm: len,
      },
    ]);
    setStatus(`Length recorded: ${fmt(len)} mm.`);
  };

  const captureDiameter = () => {
    const engine = getEngine();
    const volume = cornerstone.cache.getVolume(volumeId);
    const vp = engine?.getViewport(diameterViewport);
    const cam = vp?.getCamera();
    if (!volume || !vp || !cam?.focalPoint || !cam.viewPlaneNormal) {
      setStatus('No volume or active viewport camera available.');
      return;
    }

    setDiameterBusy(true);
    requestAnimationFrame(() => {
      try {
        const origin: TAVIVector3D = { x: cam.focalPoint![0], y: cam.focalPoint![1], z: cam.focalPoint![2] };
        const normal: TAVIVector3D = { x: cam.viewPlaneNormal![0], y: cam.viewPlaneNormal![1], z: cam.viewPlaneNormal![2] };
        const viewUp = cam.viewUp
          ? { x: cam.viewUp[0], y: cam.viewUp[1], z: cam.viewUp[2] }
          : undefined;
        const seg = autoSegmentCrossSectionAtPlane(volume, origin, normal, viewUp, {
          gridSize: 180,
          pixelSpacing: 0.3,
          minDiameterMm: 3,
          maxDiameterMm: 80,
          searchRadiusMm: 30,
        });
        const geo: TAVIGeometryResult | null = seg
          ? TAVIGeometry.geometryForWorldContour(seg.contourPoints, normal)
          : null;
        if (!seg || !geo) {
          setStatus('Lumen detection failed. Move the crosshair onto contrast-filled lumen and retry.');
          return;
        }
        const item: DiameterMeasurement = {
          id: `dia-${Date.now()}`,
          label: `${diameterViewport.toUpperCase()} ${fmt(cursorArcMm)} mm`,
          arcMm: cursorArcMm,
          viewportId: diameterViewport,
          minDiameterMm: geo.minimumDiameterMm,
          maxDiameterMm: geo.maximumDiameterMm,
          areaMm2: geo.areaMm2,
          perimeterMm: geo.perimeterMm,
          equivalentDiameterMm: geo.equivalentDiameterMm,
        };
        setDiameters((prev) => [...prev, item]);
        setStatus(`Diameter recorded: min ${fmt(item.minDiameterMm)} mm, max ${fmt(item.maxDiameterMm)} mm.`);
      } finally {
        setDiameterBusy(false);
      }
    });
  };

  /** Auto-sample the neck between start/end along the centerline, segment each
   *  perpendicular slice, and grade apposition vs the proximal seal (§3.3.3-4). */
  const sampleNeck = () => {
    if (neckStartMm == null || neckEndMm == null) {
      setStatus('Set neck start and end first.');
      return;
    }
    const volume = cornerstone.cache.getVolume(volumeId);
    if (!volume || centerlinePoints.length < 2) {
      setStatus('Confirm a centerline first.');
      return;
    }
    const lo = Math.min(neckStartMm, neckEndMm);
    const hi = Math.max(neckStartMm, neckEndMm);
    const step = Math.max(1, neckSpacingMm);
    setNeckBusy(true);
    requestAnimationFrame(() => {
      try {
        const slices: NeckSlice[] = [];
        for (let arc = lo; arc <= hi + 1e-6; arc += step) {
          const p = pointAtArc(centerlinePoints, arc);
          const t = tangentAtArc(centerlinePoints, arc);
          if (!p || !t) continue;
          const seg = autoSegmentCrossSectionAtPlane(volume, p, t, undefined, {
            gridSize: 180, pixelSpacing: 0.3, minDiameterMm: 3, maxDiameterMm: 80, searchRadiusMm: 30,
          });
          const geo = seg ? TAVIGeometry.geometryForWorldContour(seg.contourPoints, t) : null;
          if (seg && geo) {
            slices.push({
              arcMm: arc,
              minDiameterMm: geo.minimumDiameterMm,
              maxDiameterMm: geo.maximumDiameterMm,
              equivDiameterMm: geo.equivalentDiameterMm,
            });
          }
        }
        setNeckSlices(slices);
        setStatus(slices.length ? `Sampled ${slices.length} neck slices.` : 'No lumen segmented along the neck — adjust the centerline through contrast.');
      } finally {
        setNeckBusy(false);
      }
    });
  };

  const addFenestration = () => {
    setFenestrations((prev) => [...prev, { id: `fen-${Date.now()}`, ...fenDraft }]);
  };

  const addIliac = () => {
    setIliacs((prev) => [...prev, { id: `iliac-${Date.now()}`, ...iliacDraft }]);
  };

  const exportCsv = () => {
    const lines = [
      ['Section', 'Label', 'A', 'B', 'C', 'D'].join(','),
      ['Patient', patientName ?? '', studyDate ?? '', '', '', ''].join(','),
      ...lengths.map((m) => ['Length', m.label, fmt(m.fromArcMm), fmt(m.toArcMm), fmt(m.lengthMm), 'mm'].join(',')),
      ...diameters.map((m) => ['Diameter', m.label, fmt(m.arcMm), fmt(m.minDiameterMm), fmt(m.maxDiameterMm), fmt(m.areaMm2)].join(',')),
      ...fenestrations.map((m) => ['Fenestration', m.label, fmt(m.clockHour, 1), fmt(m.heightMm), fmt(m.innerAorticDiameterMm), fmt(m.branchDiameterMm)].join(',')),
      ...iliacs.map((m) => ['Iliac', `${m.side} ${m.vessel}`, fmt(m.lengthMm), fmt(m.diameterMm), fmt(m.angleDeg), ''].join(',')),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vascular-measurements-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    overlayCleanupRef.current?.();
    const engine = getEngine();
    if (!engine) return;
    const listeners: Array<() => void> = [];
    const redraw = () => setRefresh((v) => v + 1);

    for (const vpId of ['axial', 'sagittal', 'coronal'] as ViewportId[]) {
      const vp = engine.getViewport(vpId);
      if (!vp?.element) continue;
      let overlay = vp.element.querySelector('.vascular-centerline-overlay') as HTMLDivElement | null;
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'vascular-centerline-overlay';
        overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:54;';
        vp.element.style.position = 'relative';
        vp.element.appendChild(overlay);
      }

      const render = () => {
        if (!overlay) return;
        const w = vp.element.clientWidth;
        const h = vp.element.clientHeight;
        let svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">`;
        const projected = centerlinePoints
          .map((p) => vp.worldToCanvas([p.x, p.y, p.z]))
          .filter(Boolean) as number[][];
        if (projected.length >= 2) {
          svg += `<polyline points="${projected.map((p) => `${p[0]},${p[1]}`).join(' ')}" fill="none" stroke="#22c55e" stroke-width="2" stroke-linejoin="round"/>`;
        }
        projected.forEach((p, i) => {
          svg += `<circle cx="${p[0]}" cy="${p[1]}" r="${i === 0 || i === projected.length - 1 ? 5 : 3}" fill="#22c55e" stroke="#052e16" stroke-width="1"/>`;
        });
        const cp = cursorPoint ? vp.worldToCanvas([cursorPoint.x, cursorPoint.y, cursorPoint.z]) : null;
        if (cp) {
          svg += `<circle cx="${cp[0]}" cy="${cp[1]}" r="7" fill="none" stroke="#f59e0b" stroke-width="2"/>`;
        }
        svg += '</svg>';
        overlay.innerHTML = svg;
      };
      render();
      vp.element.addEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, redraw as EventListener);
      listeners.push(() => {
        vp.element.removeEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, redraw as EventListener);
        if (overlay) overlay.innerHTML = '';
      });
    }

    overlayCleanupRef.current = () => {
      for (const fn of listeners) fn();
      overlayCleanupRef.current = null;
    };
    return overlayCleanupRef.current;
  }, [centerlinePoints, cursorPoint, getEngine, refresh]);

  const renderStep = () => {
    if (activeStep === 'segmentation') {
      return (
        <div className="tavi-card">
          <h3 className="tavi-card-title">Vessel Segmentation</h3>
          <p className="tavi-step-hint">Click the contrast-filled aortic lumen to grow a 3D blood-pool mask (red labelmap on MPR + 3D). Add Vessel merges unconnected branches (e.g. renals); Exclude Heart blocks the grow from leaking into the heart/aortic root.</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
            <button className={`tavi-button ${segPlaceMode === 'seed' ? 'tavi-button-capture' : ''}`}
              onClick={() => startSegPlacement('seed')}>{seedPoint ? 'Re-seed' : 'Place Seed'}</button>
            <button className={`tavi-button ${segPlaceMode === 'addVessel' ? 'tavi-button-capture' : ''}`}
              disabled={!seg.hasMask()} onClick={() => startSegPlacement('addVessel')}>Add Vessel</button>
            <button className={`tavi-button ${segPlaceMode === 'exclude' ? 'tavi-button-capture' : ''}`}
              disabled={!seg.hasMask()} onClick={() => startSegPlacement('exclude')}>Exclude Heart</button>
          </div>
          {segPlaceMode && (
            <div className="tavi-calcium-note" style={{ color: '#58a6ff' }}>
              {segPlaceMode === 'seed' ? 'Click the aortic lumen…' : segPlaceMode === 'addVessel' ? 'Click an unconnected branch…' : 'Click the heart / root bridge…'}
            </div>
          )}
          <label className="tavi-toggle-row" style={{ marginTop: 8 }}>
            <span>Include smaller branches</span>
            <input type="range" min={0} max={100} value={sensitivity} onChange={(e) => setSensitivity(Number(e.target.value))} />
          </label>
          <div className="tavi-report-grid">
            {row('Seed HU', seedHU != null ? fmt(seedHU, 0) : '-', seedHU != null && seedHU < 150)}
            {row('Sensitivity', `${sensitivity}%`)}
            {row('Added Vessels', String(extraSeeds.length))}
            {row('Exclusions', String(excludeSeeds.length))}
            {row('Segmented Volume', seg.voxelCount ? `${fmt(seg.volumeCm3)} cm³` : '-', seg.leaked)}
          </div>
          <button className="tavi-button tavi-button-capture" disabled={!seedPoint || seg.running} onClick={() => void regrow()}>
            {seg.running ? 'Growing…' : seg.hasMask() ? 'Re-grow Segmentation' : 'Grow Segmentation'}
          </button>
          {seg.leaked && (
            <div className="tavi-calcium-note" style={{ color: '#f59e0b' }}>Hit the voxel cap — likely a leak. Lower sensitivity, Exclude Heart at the bridge, or re-seed.</div>
          )}
          <button className="tavi-button" disabled={!seg.hasMask()} style={{ marginTop: 6 }} onClick={() => { setSegmentationConfirmed(true); setActiveStep('centerline'); setStatus('Segmentation confirmed. Define centerline.'); }}>
            Confirm Segmentation
          </button>
        </div>
      );
    }

    if (activeStep === 'centerline') {
      return (
        <div className="tavi-card">
          <h3 className="tavi-card-title">Centerline Detection</h3>
          <p className="tavi-step-hint">Click the vessel centre from proximal aorta toward the endpoint — each click adds a control point automatically. For bifurcations, add the main path first; branches are tracked in Fenestrated/Iliac steps.</p>
          <button
            className={`tavi-button ${centerlineCapturing ? 'tavi-button-capture' : ''}`}
            onClick={() => (centerlineCapturing ? setCenterlineCapturing(false) : startCenterlineCapture())}
          >
            {centerlineCapturing ? 'Stop Placing' : centerlinePoints.length ? 'Resume Placing Points' : 'Start Placing Points'}
          </button>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 6 }}>
            <button className="tavi-button" disabled={centerlinePoints.length === 0} onClick={undoCenterlinePoint}>Undo</button>
            <button className="tavi-button tavi-button-capture" disabled={centerlinePoints.length < 2} onClick={confirmCenterline}>Confirm</button>
          </div>
          <div className="tavi-report-grid" style={{ marginTop: 8 }}>
            {row('Control Points', String(centerlinePoints.length), centerlinePoints.length > 0 && centerlinePoints.length < 2)}
            {row('Centerline Length', `${fmt(totalLength)} mm`)}
            {row('Tortuosity Index', fmt(tortuosity(centerlinePoints), 2), tortuosity(centerlinePoints) > 1.5)}
          </div>
        </div>
      );
    }

    if (activeStep === 'length') {
      return (
        <div className="tavi-card">
          <h3 className="tavi-card-title">Length Measurements</h3>
          {renderCursorControl()}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <button className="tavi-button" disabled={!centerlineConfirmed} onClick={() => setBaselineArcMm(cursorArcMm)}>Set Baseline</button>
            <button className="tavi-button tavi-button-capture" disabled={baselineArcMm == null} onClick={addLengthFromBaseline}>Measure from Baseline</button>
          </div>
          <div className="tavi-report-grid" style={{ marginTop: 8 }}>
            {row('Baseline', baselineArcMm != null ? `${fmt(baselineArcMm)} mm` : '-')}
            {row('Cursor', `${fmt(cursorArcMm)} mm`)}
          </div>
          {renderLengthTable()}
        </div>
      );
    }

    if (activeStep === 'diameter') {
      return (
        <div className="tavi-card">
          <h3 className="tavi-card-title">Diameter Measurements</h3>
          {renderCursorControl()}
          <label className="tavi-toggle-row">
            <span>Perpendicular viewport</span>
            <select className="tavi-inline-select" value={diameterViewport} onChange={(e) => setDiameterViewport(e.target.value as ViewportId)}>
              <option value="axial">Axial</option>
              <option value="coronal">Coronal</option>
              <option value="sagittal">Sagittal</option>
            </select>
          </label>
          <button className="tavi-button tavi-button-capture" disabled={diameterBusy} onClick={captureDiameter}>
            {diameterBusy ? 'Measuring...' : 'Capture Lumen Min/Max'}
          </button>
          {renderDiameterTable()}
        </div>
      );
    }

    if (activeStep === 'neck') {
      return (
        <div className="tavi-card">
          <h3 className="tavi-card-title">Neck Measurements / Stent Apposition</h3>
          {renderCursorControl()}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <button className="tavi-button" onClick={() => setNeckStartMm(cursorArcMm)}>Set Neck Start</button>
            <button className="tavi-button" onClick={() => setNeckEndMm(cursorArcMm)}>Set Neck End</button>
          </div>
          <label className="tavi-toggle-row">
            <span>Slice spacing</span>
            <input className="tavi-inline-input" type="number" value={neckSpacingMm} onChange={(e) => setNeckSpacingMm(Number(e.target.value))} />
          </label>
          <label className="tavi-toggle-row">
            <span>Stent diameter</span>
            <input className="tavi-inline-input" type="number" step={0.5} value={stentDiameterMm} onChange={(e) => setStentDiameterMm(Number(e.target.value))} />
          </label>
          <button className="tavi-button tavi-button-capture" disabled={neckBusy || neckStartMm == null || neckEndMm == null} onClick={sampleNeck}>
            {neckBusy ? 'Sampling…' : 'Sample Neck Slices'}
          </button>
          <div className="tavi-report-grid">
            {row('Neck Start', neckStartMm != null ? `${fmt(neckStartMm)} mm` : '-')}
            {row('Neck End', neckEndMm != null ? `${fmt(neckEndMm)} mm` : '-')}
            {row('Sampled Slices', String(neckSlices.length), neckStartMm != null && neckEndMm != null && neckSlices.length === 0)}
            {row('Seal (baseline) Ø', neckSlices.length ? `${fmt(neckSlices[0].equivDiameterMm)} mm` : '-')}
            {row('Min Neck Ø', neckSlices.length ? `${fmt(Math.min(...neckSlices.map((s) => s.minDiameterMm)))} mm` : '-')}
            {row('Stent oversizing', neckSlices.length ? `${fmt((stentDiameterMm / neckSlices[0].equivDiameterMm - 1) * 100, 0)}%` : '-')}
          </div>
          {neckSlices.length > 0 && (() => {
            const baseline = neckSlices[0].equivDiameterMm;
            return (
              <div className="tavi-report-grid" style={{ marginTop: 6 }}>
                <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginBottom: 2 }}>Apposition (Δø vs seal): 🟢≤10% 🟠≤20% 🔴&gt;20%</div>
                {neckSlices.map((s, i) => {
                  const inc = (s.equivDiameterMm / baseline - 1) * 100;
                  return (
                    <div key={i} className="tavi-row">
                      <span className="tavi-row-label">+{fmt(s.arcMm - neckSlices[0].arcMm, 0)} mm</span>
                      <span className="tavi-row-value" style={{ color: appositionColor(inc) }}>
                        ø {fmt(s.equivDiameterMm)} mm ({inc >= 0 ? '+' : ''}{fmt(inc, 0)}%)
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      );
    }

    if (activeStep === 'trajectory') {
      return (
        <div className="tavi-card">
          <h3 className="tavi-card-title">Trajectory Diameter Analysis</h3>
          <label className="tavi-toggle-row">
            <span>Catheter / sheath diameter</span>
            <input className="tavi-inline-input" type="number" value={catheterMm} step={0.5} onChange={(e) => setCatheterMm(Number(e.target.value))} />
          </label>
          <div className="tavi-report-grid">
            {row('Recorded Cross-sections', String(diameters.length))}
            {row('Too Narrow Segments', String(trajectoryNarrow.length), trajectoryNarrow.length > 0)}
            {row('Trajectory Tortuosity', fmt(tortuosity(centerlinePoints), 2), tortuosity(centerlinePoints) > 1.5)}
          </div>
          {trajectoryNarrow.map((d) => (
            <div key={d.id} className="tavi-calcium-note">Narrow at {fmt(d.arcMm)} mm: min {fmt(d.minDiameterMm)} mm</div>
          ))}
        </div>
      );
    }

    if (activeStep === 'virtual-angio') {
      return (
        <div className="tavi-card">
          <h3 className="tavi-card-title">Virtual Angio View</h3>
          {renderCursorControl()}
          <p className="tavi-step-hint">C-arm projection that opens the vessel cross-section (beam ⟂ centerline) at the cursor. Drag the cursor or the curve to explore working angles.</p>
          {(() => {
            const t = tangentAtArc(centerlinePoints, cursorArcMm);
            const coplanar = t ? TAVIGeometry.fluoroAngleForPlaneNormal(t) : null;
            return (
              <>
                <div className="tavi-report-grid">
                  {row('Centerline Position', `${fmt(cursorArcMm)} / ${fmt(totalLength)} mm`)}
                  {row('Suggested C-arm', coplanar
                    ? `${coplanar.laoRaoLabel} ${fmt(coplanar.laoRaoDegrees, 0)}° / ${coplanar.cranialCaudalLabel} ${fmt(coplanar.cranialCaudalDegrees, 0)}°`
                    : 'place ≥2 centerline points', !coplanar)}
                </div>
                {coplanar && t && (
                  <div className="angio-simulator-wrapper">
                    <AngioProjectionSimulator
                      curve={TAVIGeometry.computePerpendicularityCurve(t)}
                      raoTable={TAVIGeometry.computeRAOLAOTable(t)}
                      laoTable={TAVIGeometry.computeLAOTable(t)}
                      coplanarAngle={coplanar}
                      width={0}
                      height={300}
                    />
                  </div>
                )}
              </>
            );
          })()}
        </div>
      );
    }

    if (activeStep === 'fenestrated') {
      return (
        <div className="tavi-card">
          <h3 className="tavi-card-title">Fenestrated Measurements</h3>
          <select className="tavi-inline-select" value={fenDraft.label} onChange={(e) => setFenDraft((p) => ({ ...p, label: e.target.value }))}>
            {FEN_LABELS.map((label) => <option key={label}>{label}</option>)}
          </select>
          {numberInput('Clock', fenDraft.clockHour, (v) => setFenDraft((p) => ({ ...p, clockHour: v })))}
          {numberInput('Height from baseline', fenDraft.heightMm, (v) => setFenDraft((p) => ({ ...p, heightMm: v })))}
          {numberInput('Inner aortic diameter', fenDraft.innerAorticDiameterMm, (v) => setFenDraft((p) => ({ ...p, innerAorticDiameterMm: v })))}
          {numberInput('Branch diameter', fenDraft.branchDiameterMm, (v) => setFenDraft((p) => ({ ...p, branchDiameterMm: v })))}
          <button className="tavi-button tavi-button-capture" onClick={addFenestration}>Add Fenestration</button>
          {fenestrations.map((f) => (
            <div key={f.id} className="tavi-report-row">{f.label}: {fmt(f.clockHour, 1)}h, h {fmt(f.heightMm)} mm, aorta {fmt(f.innerAorticDiameterMm)} mm, branch {fmt(f.branchDiameterMm)} mm</div>
          ))}
        </div>
      );
    }

    if (activeStep === 'iliac') {
      return (
        <div className="tavi-card">
          <h3 className="tavi-card-title">Iliac Measurements</h3>
          <label className="tavi-toggle-row">
            <span>Side</span>
            <select className="tavi-inline-select" value={iliacDraft.side} onChange={(e) => setIliacDraft((p) => ({ ...p, side: e.target.value as 'left' | 'right' }))}>
              <option value="left">Left</option>
              <option value="right">Right</option>
            </select>
          </label>
          {numberInput('Length', iliacDraft.lengthMm, (v) => setIliacDraft((p) => ({ ...p, lengthMm: v })))}
          {numberInput('Diameter', iliacDraft.diameterMm, (v) => setIliacDraft((p) => ({ ...p, diameterMm: v })))}
          {numberInput('Angle', iliacDraft.angleDeg, (v) => setIliacDraft((p) => ({ ...p, angleDeg: v })))}
          <button className="tavi-button tavi-button-capture" onClick={addIliac}>Add Iliac</button>
          {iliacs.map((m) => (
            <div key={m.id} className="tavi-report-row">{m.side} {m.vessel}: L {fmt(m.lengthMm)} mm, d {fmt(m.diameterMm)} mm, angle {fmt(m.angleDeg)} deg</div>
          ))}
        </div>
      );
    }

    const sealMm = neckSlices.length ? neckSlices[0].equivDiameterMm : null;
    const grafts = sealMm != null ? recommendGraftSizes(sealMm, graftSegment) : [];
    return (
      <div className="tavi-card">
        <h3 className="tavi-card-title">Template / Virtual Stent</h3>
        <div className="tavi-report-grid">
          {row('Lengths', String(lengths.length))}
          {row('Diameters', String(diameters.length))}
          {row('Fenestrations', String(fenestrations.length))}
          {row('Iliac Branches', String(iliacs.length))}
        </div>

        <div style={{ display: 'flex', gap: 6, margin: '8px 0 4px' }}>
          {(['AAA', 'TAA'] as const).map((s) => (
            <button key={s} className={`tavi-button ${graftSegment === s ? 'tavi-button-capture' : ''}`}
              style={{ flex: 1, fontSize: '0.72rem' }} onClick={() => setGraftSegment(s)}>{s}</button>
          ))}
        </div>
        {sealMm == null ? (
          <div className="tavi-step-hint">Sample the neck (step 5) to get a seal diameter for graft sizing.</div>
        ) : (
          <>
            <div className="tavi-report-grid">{row('Seal (neck) Ø', `${fmt(sealMm)} mm`)}</div>
            {grafts.map((g) => (
              <div key={g.family.name} className="tavi-row" title={g.warning ?? ''}>
                <span className="tavi-row-label">{g.family.name} <span style={{ color: 'var(--text-muted)' }}>{g.family.manufacturer}</span></span>
                <span className="tavi-row-value" style={{ color: g.warning ? '#d29922' : '#3fb950' }}>
                  {g.bodyDiameterMm != null ? `${fmt(g.bodyDiameterMm, 0)} mm (+${fmt(g.oversizingPct ?? 0, 0)}%)` : '—'}
                </span>
              </div>
            ))}
            <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)', marginTop: 4 }}>
              Main-body proximal Ø, ~10–25% oversized vs neck. Verify against device IFU.
            </div>
          </>
        )}

        <button className="tavi-button tavi-button-export" style={{ marginTop: 8 }} onClick={exportCsv}>Export CSV</button>
        {renderLengthTable()}
        {renderDiameterTable()}
      </div>
    );
  };

  const renderCursorControl = () => (
    <div style={{ marginBottom: 8 }}>
      <label className="tavi-toggle-row">
        <span>Centerline cursor</span>
        <input
          type="range"
          min={0}
          max={Math.max(1, totalLength)}
          step={1}
          value={Math.min(cursorArcMm, Math.max(1, totalLength))}
          onChange={(e) => setCursor(Number(e.target.value))}
          disabled={centerlinePoints.length < 2}
        />
      </label>
      <div className="tavi-report-grid">
        {row('Cursor', `${fmt(cursorArcMm)} / ${fmt(totalLength)} mm`)}
      </div>
    </div>
  );

  const renderLengthTable = () => lengths.length === 0 ? null : (
    <div className="tavi-report-grid" style={{ marginTop: 8 }}>
      {lengths.map((m) => row(m.label, `${fmt(m.lengthMm)} mm`))}
    </div>
  );

  const renderDiameterTable = () => diameters.length === 0 ? null : (
    <div className="tavi-report-grid" style={{ marginTop: 8 }}>
      {diameters.slice(-6).map((m) => row(`${m.label}`, `min ${fmt(m.minDiameterMm)} / max ${fmt(m.maxDiameterMm)} mm, area ${fmt(m.areaMm2, 0)} mm2`, m.minDiameterMm < catheterMm))}
    </div>
  );

  return (
    <div className="tavi-panel">
      <div className="tavi-panel-content">
        <div className="tavi-card">
          <h3 className="tavi-card-title">Vascular Planning</h3>
          <div className="tavi-step-hint">
            Based on the 3mensio Vascular workflow: segmentation, centerline, length, diameter, neck, trajectory, virtual angio, fenestrated and iliac measurements.
          </div>
          <div className="tavi-calcium-note">{status}</div>
        </div>

        <div className="vascular-accordion">
          {STEPS.map((step, i) => (
            <div key={step.id} className="vascular-accordion-item">
              <button
                className={`tavi-checklist-item vascular-accordion-header ${activeStep === step.id ? 'active' : ''}`}
                onClick={() => setActiveStep(step.id)}
              >
                <span className="tavi-check-icon">{i + 1}</span>
                <span className="tavi-checklist-label">{step.title}</span>
                <span className="vascular-accordion-caret">{activeStep === step.id ? '▾' : '▸'}</span>
              </button>
              {activeStep === step.id && (
                <div className="vascular-accordion-body">{renderStep()}</div>
              )}
            </div>
          ))}
        </div>

        <div className="tavi-card">
          <h3 className="tavi-card-title">Session Summary</h3>
          <div className="tavi-report-grid">
            {row('Segmentation', segmentationConfirmed ? 'confirmed' : 'pending')}
            {row('Centerline', centerlineConfirmed ? `${fmt(totalLength)} mm` : 'pending')}
            {row('Diameters', String(diameters.length))}
            {row('Fenestrations', String(fenestrations.length))}
          </div>
        </div>
      </div>
    </div>
  );
});

function numberInput(label: string, value: number, onChange: (v: number) => void) {
  return (
    <label className="tavi-toggle-row">
      <span>{label}</span>
      <input className="tavi-inline-input" type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}
