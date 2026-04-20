import { useEffect, useMemo, useRef, useState } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import {
  CoronaryMeasurementSession,
  DEFAULT_CENTERLINE_TEMPLATES,
} from '../coronary/CoronaryMeasurementSession';
import {
  CoronaryCenterlineOverlay,
  type CoronaryCenterlineMode,
} from '../coronary/CoronaryCenterlineOverlay';
import type { CoronaryVesselId, CoronaryVesselRecord, ManualQCAInput, WorldPoint3D, LumenContour } from '../coronary/QCATypes';
import { pointAtDist, frameAtDist, generateVesselWallContour, type Vec3 } from '../coronary/QCAGeometry';
import type { DicomSeriesInfo } from '../core/dicomLoader';
import { setActiveTool } from '../core/toolManager';
import { 
  samplePlaqueComposition, toVec,
  HU_THRESHOLD_LAP, HU_THRESHOLD_FB_FATTY, HU_THRESHOLD_FIBROUS 
} from '../coronary/QCAGeometry';
import { SnakeView } from './SnakeView';
import { LongitudinalProfile } from './LongitudinalProfile';
import { FFRResultsPanel } from './FFRResultsPanel';
import { CACResultsPanel } from './CACResultsPanel';
import { computePatientFFR, type PatientFFRResult } from '../coronary/ffr';
import { resampleCenterline } from '../coronary/ffr/arcResample';
import { autoDetectStenosis } from '../shared/autoStenosis';
import { computePatientCAC, type CACPatientResult } from '../coronary/cac/cacScoring';

const VIEWPORT_IDS = ['axial', 'sagittal', 'coronal'] as const;
const BRANCH_PRESETS = ['D1', 'D2', 'OM1', 'OM2', 'PDA', 'PLV', 'RI', 'Diag', 'Septal'];

const AIR_HU = -1000;

function createVoxelSampler(volume: cornerstone.Types.IImageVolume): ((world: Vec3) => number) | null {
  const imgVol = volume as cornerstone.Types.IImageVolume & {
    imageData?: { worldToIndex(point: number[]): number[] };
    dimensions?: number[];
    getScalarData?(): ArrayLike<number>;
  };
  if (!imgVol.imageData?.worldToIndex || !imgVol.dimensions || !imgVol.getScalarData) {
    return null;
  }
  const dims = imgVol.dimensions;
  let scalarData: ArrayLike<number>;
  try {
    scalarData = imgVol.getScalarData();
  } catch {
    return null;
  }
  return (world: Vec3): number => {
    const index = imgVol.imageData!.worldToIndex(world as unknown as number[]);
    const i = Math.floor(index[0]);
    const j = Math.floor(index[1]);
    const k = Math.floor(index[2]);
    if (i < 0 || i >= dims[0] || j < 0 || j >= dims[1] || k < 0 || k >= dims[2]) {
      return AIR_HU;
    }
    const offset = i + j * dims[0] + k * dims[0] * dims[1];
    return scalarData[offset] ?? AIR_HU;
  };
}
const CENTERLINE_COLORS = ['#ff9f68', '#79c7ff', '#f8d16c', '#8dd6a5', '#d8a2ff', '#ff8fb1', '#6fe7d2'];

type WorkflowStep = 'define' | 'analysis';

interface Props {
  renderingEngineId: string;
  volumeId: string;
  series: DicomSeriesInfo | null;
  resetToken: number;
}

interface ContextMenuState {
  centerlineId: CoronaryVesselId;
  x: number;
  y: number;
  label: string;
  color: string;
  pointIndex: number | null;
  distanceMm?: number;
  markerId?: string;
}

function fmt(value: number | null | undefined, digits = 1): string {
  return value == null ? '—' : value.toFixed(digits);
}

function pointLabel(point?: WorldPoint3D): string {
  if (!point) {
    return '—';
  }

  return `${point.x.toFixed(1)}, ${point.y.toFixed(1)}, ${point.z.toFixed(1)}`;
}

function pickColor(index: number): string {
  return CENTERLINE_COLORS[index % CENTERLINE_COLORS.length];
}

export function CoronaryWorkspace({ renderingEngineId, volumeId, series, resetToken }: Props) {
  const sessionRef = useRef(new CoronaryMeasurementSession());
  const overlayRef = useRef<CoronaryCenterlineOverlay | null>(null);
  const session = sessionRef.current;

  const [version, setVersion] = useState(0);
  const [workflowStep, setWorkflowStep] = useState<WorkflowStep>('define');
  const [activeCenterlineId, setActiveCenterlineId] = useState<CoronaryVesselId>('lad');
  const [centerlineMode, setCenterlineMode] = useState<CoronaryCenterlineMode>('idle');
  const [selectedPointIndex, setSelectedPointIndex] = useState<number | null>(null);
  const [snakeViewVisible, setSnakeViewVisible] = useState(false);
  const [snakeRotationDegrees, setSnakeRotationDegrees] = useState(0);
  const [status, setStatus] = useState(
    'Adjust your view first, then click "Activate LAD" or pick a vessel to start drawing.'
  );
  const [branchPreset, setBranchPreset] = useState(BRANCH_PRESETS[0]);
  const [customLabel, setCustomLabel] = useState('');
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [cursorDistanceMm, setCursorDistanceMm] = useState<number>(0);
  const [pendingStenosisProximal, setPendingStenosisProximal] = useState<number | null>(null);
  const [editContourMode, setEditContourMode] = useState(false);
  const [editVesselWallMode, setEditVesselWallMode] = useState(false);
  const [brushRadiusMm, setBrushRadiusMm] = useState(1.5);
  const [diameterHandlesVisible, setDiameterHandlesVisible] = useState(false);
  const [ffrResult, setFFRResult] = useState<PatientFFRResult | null>(null);
  const [ffrError, setFFRError] = useState<string | null>(null);
  const [ffrBusy, setFFRBusy] = useState(false);
  const [cacResult, setCACResult] = useState<CACPatientResult | null>(null);
  const [cacError, setCACError] = useState<string | null>(null);
  const [cacBusy, setCACBusy] = useState(false);

  // session.getRecords() deep-clones every call. Memoize against `version`
  // so unrelated re-renders (cursor drag, hover state, etc.) don't break
  // reference equality for children that use record arrays as effect deps.
  // forceRefresh() / setVersion bumps `version` whenever session state
  // actually changes, so this cache stays correct.
  const records = useMemo(() => session.getRecords(), [session, version]);
  const activeRecord =
    records.find((record) => record.id === activeCenterlineId) ??
    records[0] ??
    DEFAULT_CENTERLINE_TEMPLATES.map((template) => ({
      id: template.id,
      label: template.label,
      color: template.color,
      kind: template.kind,
      centerlinePoints: [],
      manual: {},
    }))[0];
  const metrics = session.derivedMetrics(activeRecord.id);
  const analysisReadyRecords = session.labeledRecordsForAnalysis();

  function forceRefresh(message?: string) {
    if (message) {
      setStatus(message);
    }
    setVersion((value) => value + 1);
  }

  function runAutoDetectStenosis() {
    if (activeRecord.centerlinePoints.length < 3) {
      setStatus('Centerline needs at least 3 control points before auto-detect.');
      return;
    }
    if (activeRecord.lumenContours.length === 0) {
      setStatus('Run Auto Lumen in the Stretched View first so the diameter profile exists.');
      return;
    }
    const samples = resampleCenterline(activeRecord);
    if (samples.length < 5) {
      setStatus('Insufficient geometry for auto-detection.');
      return;
    }
    const finding = autoDetectStenosis(samples);
    if (!finding) {
      setStatus('No significant stenosis found (≥20% DS) on the diameter profile.');
      return;
    }
    session.setStenosisMeasurement(activeRecord.id, finding.proximalMm, finding.distalMm);
    setCursorDistanceMm(finding.mldMm);
    setPendingStenosisProximal(null);
    forceRefresh(
      `Auto-detected stenosis: ${finding.diameterStenosisPercent.toFixed(0)}% DS, MLD ${finding.mldDiameterMm.toFixed(2)} mm at ${finding.mldMm.toFixed(1)} mm.`
    );
  }

  function runPatientFFR() {
    setFFRBusy(true);
    setFFRError(null);
    try {
      const ready = session.labeledRecordsForAnalysis();
      if (ready.length === 0) {
        throw new Error('Label at least one centerline with ≥2 points before running CT-FFR.');
      }
      const mass = activeRecord.manual.myocardialMassG;
      const pa = activeRecord.manual.meanAorticPressureMmHg;
      if (!mass || mass <= 0) {
        throw new Error('Myocardial mass (g) is required for the allometric flow estimate.');
      }
      if (!pa || pa <= 0) {
        throw new Error('Mean aortic pressure (mmHg) is required.');
      }
      const hyperemiaScale = activeRecord.manual.hyperemiaResistanceScale;
      const hyperemiaFactor = hyperemiaScale && hyperemiaScale > 0 ? hyperemiaScale : undefined;
      const result = computePatientFFR({
        records: ready,
        meanAorticPressureMmHg: pa,
        myocardialMassG: mass,
        hyperemiaFactor,
      });
      setFFRResult(result);
      setStatus(`CT-FFR solved for ${result.vessels.length} vessel(s).`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown CT-FFR failure.';
      setFFRError(message);
      setFFRResult(null);
    } finally {
      setFFRBusy(false);
    }
  }

  function runCalciumScore() {
    setCACBusy(true);
    setCACError(null);
    try {
      const ready = session.labeledRecordsForAnalysis();
      if (ready.length === 0) {
        throw new Error('Label at least one centerline before scoring calcium.');
      }
      const result = computePatientCAC({
        records: ready,
        volumeId,
      });
      if (!result) {
        throw new Error('CT volume not available. Make sure a series is loaded.');
      }
      setCACResult(result);
      setStatus(
        `Calcium score: total Agatston ${result.totalAgatston}, volume ${result.totalVolumeMm3.toFixed(1)} mm³.`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown CAC scoring failure.';
      setCACError(message);
      setCACResult(null);
    } finally {
      setCACBusy(false);
    }
  }

  function closeContextMenu() {
    setContextMenu(null);
  }

  function syncOverlayState() {
    if (!overlayRef.current) {
      return;
    }

    overlayRef.current.setCenterlines(
      session.getRecords().map((record) => ({
        id: record.id,
        label: record.label,
        color: record.color,
        points: record.centerlinePoints,
      })),
      activeRecord.id
    );
    overlayRef.current.setMode(centerlineMode);
    overlayRef.current.setSelectedPoint(activeRecord.id, selectedPointIndex);
  }

  useEffect(() => {
    session.reset();
    setWorkflowStep('define');
    setActiveCenterlineId('lad');
    setCenterlineMode('idle');
    setSelectedPointIndex(null);
    setSnakeViewVisible(false);
    setSnakeRotationDegrees(0);
    setBranchPreset(BRANCH_PRESETS[0]);
    setCustomLabel('');
    setContextMenu(null);
    setCursorDistanceMm(0);
    setPendingStenosisProximal(null);
    setStatus(
      'Adjust your view first, then click "Activate LAD" or pick a vessel to start drawing.'
    );
    setVersion((value) => value + 1);
  }, [resetToken, session]);

  useEffect(() => {
    if (!records.some((record) => record.id === activeCenterlineId) && records[0]) {
      setActiveCenterlineId(records[0].id);
      setSelectedPointIndex(null);
    }
  }, [activeCenterlineId, records]);

  const handleContourChange = (contour: LumenContour) => {
    if (contour.points.length > 0 && contour.vesselPoints && contour.vesselPoints.length > 0) {
       const volume = cornerstone.cache.getVolume(volumeId);
       const sampler = volume ? createVoxelSampler(volume) : null;
       if (sampler) {
          const center = pointAtDist(activeRecord.centerlinePoints, contour.distanceMm);
          const frame = frameAtDist(activeRecord.centerlinePoints, contour.distanceMm);
          const composition = samplePlaqueComposition(
             contour.points,
             contour.vesselPoints,
             center,
             frame,
             sampler,
          );
          contour.composition = {
             lapAreaMm2: composition.lap,
             fibrofattyAreaMm2: composition.fibrofatty,
             fibrousAreaMm2: composition.fibrous,
             calcifiedAreaMm2: composition.calcified
          };
       }
    }
    
    session.setLumenContour(activeRecord.id, contour);
    setVersion((v) => v + 1);
  };

  const handleGenerateVesselWall = () => {
    const record = activeRecord;
    if (record.lumenContours.length === 0) {
      setStatus('No lumen contours found. Define lumen boundaries first.');
      return;
    }
    
    // Generate for all existing lumen contours that don't have vessel points
    record.lumenContours.forEach(c => {
      if (!c.vesselPoints || c.vesselPoints.length === 0) {
         const center = pointAtDist(record.centerlinePoints, c.distanceMm);
         const frame = frameAtDist(record.centerlinePoints, c.distanceMm);
         const vPoints = generateVesselWallContour(c.points, center, frame, 0.8);
         session.setLumenContour(record.id, { ...c, vesselPoints: vPoints });
      }
    });
    
    setVersion(v => v + 1);
    setStatus('Automated EEM initialization complete.');
  };

  const handleResetPlaque = () => {
    session.resetPlaqueAnalysis(activeRecord.id);
    setVersion(v => v + 1);
    setStatus('Plaque analysis data reset for this vessel.');
  };

  useEffect(() => {
    if (selectedPointIndex == null) {
      return;
    }

    const nextRecord = session.getRecords().find((record) => record.id === activeCenterlineId);
    if (!nextRecord || selectedPointIndex >= nextRecord.centerlinePoints.length) {
      setSelectedPointIndex(null);
    }
  }, [activeCenterlineId, selectedPointIndex, session, version]);

  useEffect(() => {
    if (workflowStep === 'analysis' && analysisReadyRecords.length === 0) {
      setWorkflowStep('define');
      return;
    }

    if (
      workflowStep === 'analysis' &&
      analysisReadyRecords.length > 0 &&
      !analysisReadyRecords.some((record) => record.id === activeRecord.id)
    ) {
      setActiveCenterlineId(analysisReadyRecords[0].id);
      setSelectedPointIndex(null);
    }
  }, [activeRecord.id, analysisReadyRecords, workflowStep]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;

    const attachOverlay = () => {
      if (cancelled) {
        return;
      }

      const engine = cornerstone.getRenderingEngine(renderingEngineId);
      const ready =
        engine &&
        VIEWPORT_IDS.every((viewportId) => {
          const viewport = engine.getViewport(viewportId);
          return Boolean(viewport?.element);
        });

      if (!ready) {
        timer = window.setTimeout(attachOverlay, 120);
        return;
      }

      overlayRef.current?.disable();
      const overlay = new CoronaryCenterlineOverlay(renderingEngineId);
      overlay.enable([...VIEWPORT_IDS], {
        onCenterlineSelected: (centerlineId) => {
          setActiveCenterlineId(centerlineId);
          setSelectedPointIndex(null);
          closeContextMenu();
        },
        onCenterlinePointsChanged: (centerlineId, points) => {
          sessionRef.current.setCenterlinePoints(centerlineId, points);
          setActiveCenterlineId(centerlineId);
          setVersion((value) => value + 1);
        },
        onControlPointSelected: (centerlineId, pointIndex) => {
          setActiveCenterlineId(centerlineId);
          setSelectedPointIndex(pointIndex);
        },
        onContextMenuRequested: (event) => {
          const record = sessionRef.current.getRecord(event.centerlineId);
          setActiveCenterlineId(event.centerlineId);
          setSelectedPointIndex(null);
          setContextMenu({
            centerlineId: event.centerlineId,
            x: event.clientX,
            y: event.clientY,
            label: record.label,
            color: record.color,
            pointIndex: null,
          });
        },
      });

      overlayRef.current = overlay;
      syncOverlayState();
    };

    attachOverlay();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      overlayRef.current?.disable();
      overlayRef.current = null;
    };
  }, [renderingEngineId, series?.seriesInstanceUID]);

  useEffect(() => {
    syncOverlayState();
  }, [activeRecord.id, centerlineMode, selectedPointIndex, version]);

  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('coronary:centerlines-changed', {
        detail: session.getRecords().map((record) => ({
          id: record.id,
          label: record.label,
          color: record.color,
          points: record.centerlinePoints,
        })),
      })
    );
  }, [session, version]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.centerline-context-menu')) {
        return;
      }
      closeContextMenu();
    }

    function handleKeydown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        closeContextMenu();
      }

      // Undo last point: Ctrl+Z or Cmd+Z
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        // Prevent undo if typing in a text field
        if (
          document.activeElement instanceof HTMLInputElement ||
          document.activeElement instanceof HTMLTextAreaElement
        ) {
          return;
        }

        // Get latest record state inside the handler to avoid closure staleness
        const currentRecord = activeCenterlineId ? session.getRecord(activeCenterlineId) : null;
        if (currentRecord && currentRecord.centerlinePoints.length > 0) {
          event.preventDefault();
          session.removeCenterlinePoint(currentRecord.id, currentRecord.centerlinePoints.length - 1);
          forceRefresh(`${currentRecord.label}: last point removed via undo.`);
        }
      }
    }

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeydown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeydown);
    };
  }, [contextMenu, activeCenterlineId, session, forceRefresh]);

  function takeLatestProbePoint(): WorldPoint3D | null {
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    if (!engine) {
      return null;
    }

    const toolName = cornerstoneTools.ProbeTool.toolName;

    for (const viewportId of VIEWPORT_IDS) {
      const viewport = engine.getViewport(viewportId);
      if (!viewport?.element) {
        continue;
      }

      const annotations = cornerstoneTools.annotation.state.getAnnotations(toolName, viewport.element);
      const annotation = annotations?.[annotations.length - 1] as any;
      const point = annotation?.data?.handles?.points?.[0];
      if (!point) {
        continue;
      }

      cornerstoneTools.annotation.state.removeAnnotation(annotation.annotationUID);
      return { x: point[0], y: point[1], z: point[2] };
    }

    return null;
  }

  function capturePoint(target: 'lesionStart' | 'lesionEnd' | 'mldSite') {
    const point = takeLatestProbePoint();
    if (!point) {
      setStatus('No Probe annotation found. Click inside a viewport with the Probe tool first, then capture.');
      return;
    }

    if (target === 'lesionStart') {
      session.setLesionStart(activeRecord.id, point);
      forceRefresh(`${activeRecord.label}: lesion start updated.`);
      return;
    }

    if (target === 'lesionEnd') {
      session.setLesionEnd(activeRecord.id, point);
      forceRefresh(`${activeRecord.label}: lesion end updated.`);
      return;
    }

    session.setMinimalLumenSite(activeRecord.id, point);
    forceRefresh(`${activeRecord.label}: minimal lumen site updated.`);
  }

  function updateManualField<K extends keyof ManualQCAInput>(field: K, value: string) {
    const nextValue = value.trim() === '' ? undefined : Number(value);
    session.updateManual(activeRecord.id, {
      [field]: Number.isNaN(nextValue) ? undefined : nextValue,
    } as Partial<ManualQCAInput>);
    forceRefresh();
  }

  function updateTextField<K extends keyof ManualQCAInput>(field: K, value: string) {
    session.updateManual(activeRecord.id, {
      [field]: value,
    } as Partial<ManualQCAInput>);
    forceRefresh();
  }

  function addCenterline(label: string, kind: CoronaryVesselRecord['kind']) {
    const trimmed = label.trim();
    if (!trimmed) {
      setStatus('Enter a vessel label before adding a new centerline.');
      return;
    }

    const color = pickColor(session.getRecords().length);
    const vesselId = session.addRecord(trimmed, kind, color);
    setActiveCenterlineId(vesselId);
    setCenterlineMode('draw');
    setSelectedPointIndex(null);
    forceRefresh(`${trimmed}: ready. Left click in a viewport to create or extend this centerline.`);
  }

  function handleAddBranchPreset() {
    addCenterline(branchPreset, 'branch');
  }

  function handleAddCustomLabel() {
    addCenterline(customLabel, 'custom');
    setCustomLabel('');
  }

  function selectCenterline(centerlineId: CoronaryVesselId) {
    setActiveCenterlineId(centerlineId);
    setSelectedPointIndex(null);
    closeContextMenu();
    setSnakeRotationDegrees(0);
  }

  function clearCenterline(centerlineId: CoronaryVesselId) {
    const record = session.getRecord(centerlineId);
    session.clearVessel(centerlineId);
    if (centerlineId === activeRecord.id) {
      setSelectedPointIndex(null);
    }
    setCenterlineMode('draw');
    forceRefresh(`${record.label}: geometry cleared. Left click to redraw.`);
  }

  function deleteCenterline(centerlineId: CoronaryVesselId) {
    const record = session.getRecord(centerlineId);
    if (record.kind === 'main') {
      clearCenterline(centerlineId);
      return;
    }

    session.deleteRecord(centerlineId);
    const nextRecord = session.getRecords()[0];
    if (nextRecord) {
      setActiveCenterlineId(nextRecord.id);
    }
    setSelectedPointIndex(null);
    closeContextMenu();
    forceRefresh(`${record.label}: centerline deleted.`);
  }

  function deletePoint(centerlineId: CoronaryVesselId, pointIndex: number) {
    const record = session.getRecord(centerlineId);
    session.removeCenterlinePoint(centerlineId, pointIndex);
    closeContextMenu();
    if (centerlineId === activeRecord.id) {
      const nextCount = session.getRecord(centerlineId).centerlinePoints.length;
      setSelectedPointIndex(nextCount > 0 ? clampIndex(pointIndex - 1, 0, nextCount - 1) : null);
    }
    forceRefresh(`${record.label}: control point deleted.`);
  }

  function applyContextMenuEdits() {
    if (!contextMenu) {
      return;
    }

    const label = contextMenu.label.trim();
    if (!label) {
      setStatus('Centerline label cannot be empty.');
      return;
    }

    const collision = session
      .getRecords()
      .find(
        (record) =>
          record.id !== contextMenu.centerlineId &&
          record.label.trim().toLowerCase() === label.toLowerCase()
      );
    if (collision) {
      setStatus(`The label "${label}" is already in use.`);
      return;
    }

    session.renameRecord(contextMenu.centerlineId, label);
    session.setRecordColor(contextMenu.centerlineId, contextMenu.color);
    closeContextMenu();
    forceRefresh(`${label}: label and color updated.`);
  }

  function openPointContextMenu(pointIndex: number, clientX: number, clientY: number) {
    setSelectedPointIndex(pointIndex);
    setContextMenu({
      centerlineId: activeRecord.id,
      x: clientX,
      y: clientY,
      label: activeRecord.label,
      color: activeRecord.color,
      pointIndex,
    });
  }

  function updateSelectedPointAxis(axis: keyof WorldPoint3D, value: string) {
    if (selectedPointIndex == null) {
      return;
    }

    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return;
    }

    const point = session.getRecord(activeRecord.id).centerlinePoints[selectedPointIndex];
    if (!point) {
      return;
    }

    session.updateCenterlinePoint(activeRecord.id, selectedPointIndex, {
      ...point,
      [axis]: numeric,
    });
    forceRefresh(`${activeRecord.label}: control point ${selectedPointIndex + 1} updated.`);
  }

  function removeSelectedPoint() {
    if (selectedPointIndex == null) {
      return;
    }

    session.removeCenterlinePoint(activeRecord.id, selectedPointIndex);
    setSelectedPointIndex(null);
    forceRefresh(`${activeRecord.label}: control point removed.`);
  }

  function downloadJson() {
    const blob = new Blob([JSON.stringify(session.exportSnapshot(), null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'coronary-workbench-session.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function downloadReport() {
    const blob = new Blob(
      [
        session.textReport({
          patientName: series?.patientName,
          studyDescription: series?.studyDescription,
        }),
      ],
      { type: 'text/plain' }
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'coronary-workbench-report.txt';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const selectedPoint =
    selectedPointIndex != null ? activeRecord.centerlinePoints[selectedPointIndex] : undefined;

  return (
    <aside className="workspace-panel">
      <div className="panel-header">
        <span>Coronary Workspace</span>
        <span className="panel-pill research">Research</span>
      </div>

      <div className="workspace-scroll">
        <div className="workspace-card status-card">
          <p>{status}</p>
        </div>

        <div className="workspace-card">
          <div className="step-tabs">
            <button
              className={`vessel-tab ${workflowStep === 'define' ? 'active' : ''}`}
              onClick={() => setWorkflowStep('define')}
            >
              Define Centerlines
            </button>
            <button
              className={`vessel-tab ${workflowStep === 'analysis' ? 'active' : ''}`}
              disabled={analysisReadyRecords.length === 0}
              onClick={() => {
                if (analysisReadyRecords.length === 0) {
                  return;
                }
                setWorkflowStep('analysis');
              }}
            >
              Analysis
            </button>
          </div>
          <p className="mini-copy">
            {analysisReadyRecords.length > 0
              ? `${analysisReadyRecords.length} labeled centerline(s) ready for analysis.`
              : 'Define and label at least one centerline before entering analysis.'}
          </p>
        </div>

        {workflowStep === 'define' ? (
          <>
            <div className="workspace-card">
              <div className="card-title-row">
                <h3>Workflow Assistant</h3>
                <span className="mini-copy">{series?.seriesDescription || 'No active series'}</span>
              </div>

              <div className="section-label">Main Vessels</div>
              <div className="vessel-tabs">
                {DEFAULT_CENTERLINE_TEMPLATES.map((template) => {
                  const record = records.find((entry) => entry.id === template.id);
                  if (!record) {
                    return null;
                  }

                  return (
                    <button
                      key={record.id}
                      className={`vessel-tab ${activeRecord.id === record.id ? 'active' : ''}`}
                      onClick={() => selectCenterline(record.id)}
                    >
                      {record.label}
                    </button>
                  );
                })}
              </div>

              <div className="section-label">Add Branch Vessel</div>
              <div className="inline-form">
                <select value={branchPreset} onChange={(event) => setBranchPreset(event.target.value)}>
                  {BRANCH_PRESETS.map((label) => (
                    <option key={label} value={label}>
                      {label}
                    </option>
                  ))}
                </select>
                <button className="secondary-btn small" onClick={handleAddBranchPreset}>
                  Add
                </button>
              </div>

              <div className="section-label">Custom Label</div>
              <div className="inline-form">
                <input
                  type="text"
                  value={customLabel}
                  placeholder="Enter branch name"
                  onChange={(event) => setCustomLabel(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      handleAddCustomLabel();
                    }
                  }}
                />
                <button className="secondary-btn small" onClick={handleAddCustomLabel}>
                  Add
                </button>
              </div>

              <div className="section-label">Centerline List</div>
              <div className="centerline-list">
                {records.map((record) => (
                  <button
                    key={record.id}
                    className={`centerline-row ${activeRecord.id === record.id ? 'active' : ''}`}
                    onClick={() => selectCenterline(record.id)}
                  >
                    <span className="color-dot" style={{ backgroundColor: record.color }} />
                    <span className="centerline-name">{record.label || 'Unlabeled'}</span>
                    <span className="centerline-meta">{record.centerlinePoints.length} pts</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="workspace-card">
              <div className="card-title-row">
                <h3>Edit Centerline Layout</h3>
                <div className="header-actions">
                  <button
                    className={`ghost-btn ${snakeViewVisible ? 'active' : ''}`}
                    onClick={() => {
                      const nextVisible = !snakeViewVisible;
                      setSnakeViewVisible(nextVisible);
                      if (nextVisible) {
                        setStatus(
                          `${activeRecord.label}: Snake View opened. Use the wheel to scroll points and drag to edit.`
                        );
                      }
                    }}
                  >
                    {snakeViewVisible ? 'Hide Snake View' : 'Snake View'}
                  </button>
                  <button
                    className="ghost-btn"
                    onClick={() => {
                      setCenterlineMode(centerlineMode === 'draw' ? 'idle' : 'draw');
                      setStatus(
                        centerlineMode === 'draw'
                          ? 'Draw mode paused. Drag existing control points to modify centerlines.'
                          : `${activeRecord.label}: draw mode enabled. Left click to create or extend the active centerline.`
                      );
                    }}
                  >
                    {centerlineMode === 'draw' ? 'Pause Draw' : 'Draw / Extend'}
                  </button>
                </div>
              </div>

              <div className="action-grid">
                <button
                  className="primary-btn small"
                  onClick={() => {
                    setCenterlineMode('draw');
                    setStatus(`${activeRecord.label}: draw mode enabled.`);
                  }}
                >
                  Activate {activeRecord.label}
                </button>
                <button className="secondary-btn small" onClick={() => clearCenterline(activeRecord.id)}>
                  Clear Geometry
                </button>
                <button
                  className="ghost-btn"
                  onClick={() => {
                    session.undoLastCenterlinePoint(activeRecord.id);
                    setSelectedPointIndex(null);
                    forceRefresh(`${activeRecord.label}: last control point removed.`);
                  }}
                >
                  Undo Last Point
                </button>
              </div>

              <div className="metric-list">
                <MetricRow label="Active vessel" value={activeRecord.label} />
                <MetricRow label="Control points" value={`${activeRecord.centerlinePoints.length}`} />
                <MetricRow
                  label="Centerline length"
                  value={metrics.centerlineLengthMm != null ? `${metrics.centerlineLengthMm.toFixed(1)} mm` : '—'}
                />
              </div>

              <div className="instruction-box">
                Left click in a viewport to create or extend the active centerline. Drag control points to modify it.
                Right click any centerline to open “Edit Label &amp; Color...”.
              </div>
            </div>

            <div className="workspace-card">
              <div className="card-title-row">
                <h3>Point Inspector</h3>
                <span className="mini-copy">Numeric fallback editor</span>
              </div>

              {selectedPoint ? (
                <>
                  <div className="metric-list">
                    <MetricRow label="Selected point" value={`#${selectedPointIndex != null ? selectedPointIndex + 1 : 0}`} />
                    <MetricRow label="World position" value={pointLabel(selectedPoint)} />
                  </div>
                  <div className="field-grid">
                    <NumberField
                      label="X"
                      value={selectedPoint.x}
                      step="0.1"
                      onChange={(value) => updateSelectedPointAxis('x', value)}
                    />
                    <NumberField
                      label="Y"
                      value={selectedPoint.y}
                      step="0.1"
                      onChange={(value) => updateSelectedPointAxis('y', value)}
                    />
                    <NumberField
                      label="Z"
                      value={selectedPoint.z}
                      step="0.1"
                      onChange={(value) => updateSelectedPointAxis('z', value)}
                    />
                  </div>
                  <div className="action-grid compact">
                    <button className="ghost-btn" onClick={removeSelectedPoint}>
                      Remove Point
                    </button>
                  </div>
                </>
              ) : (
                <div className="instruction-box">
                  Click a control point in any viewport or in Snake View to inspect and edit its coordinates here.
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="workspace-card">
              <div className="card-title-row">
                <h3>Analysis Vessel</h3>
                <span className="mini-copy">Only labeled centerlines are listed here.</span>
              </div>
              <div className="vessel-tabs">
                {analysisReadyRecords.map((record) => (
                  <button
                    key={record.id}
                    className={`vessel-tab ${activeRecord.id === record.id ? 'active' : ''}`}
                    onClick={() => selectCenterline(record.id)}
                  >
                    {record.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="workspace-card">
              <div className="card-title-row">
                <h3>Stenosis Assessment</h3>
              </div>

              {activeRecord.stenosisMeasurement ? (
                <>
                  <div className="metric-list">
                    <MetricRow label="Lesion length" value={`${Math.abs(activeRecord.stenosisMeasurement.lesionEndMm - activeRecord.stenosisMeasurement.lesionStartMm).toFixed(1)} mm`} />
                    <MetricRow label="Proximal Ref" value={`${activeRecord.stenosisMeasurement.proximalReferenceMm.toFixed(1)} mm`} />
                    <MetricRow label="Distal Ref" value={`${activeRecord.stenosisMeasurement.distalReferenceMm.toFixed(1)} mm`} />
                  </div>
                  
                  <div className="field-grid">
                    <label className="field-block">
                      <span>Method</span>
                      <select 
                        value={activeRecord.stenosisMeasurement.measurementType}
                        onChange={(e) => {
                           session.updateStenosisMeasurement(activeRecord.id, {
                             measurementType: e.target.value as 'minD' | 'avgD' | 'area'
                           });
                           forceRefresh('Stenosis method updated.');
                        }}
                      >
                        <option value="minD">Minimum Diameter</option>
                        <option value="avgD">Average Diameter</option>
                        <option value="area">Lumen Area</option>
                      </select>
                    </label>

                    <label className="field-block">
                      <span>References</span>
                      <select 
                        value={activeRecord.stenosisMeasurement.referenceStrategy}
                        onChange={(e) => {
                           session.updateStenosisMeasurement(activeRecord.id, {
                             referenceStrategy: e.target.value as 'average' | 'interpolate'
                           });
                           forceRefresh('Reference strategy updated.');
                        }}
                      >
                        <option value="average">Average of 2</option>
                        <option value="interpolate">Interpolate</option>
                      </select>
                    </label>
                  </div>

                  <div className="action-grid compact">
                    <button className="ghost-btn" onClick={() => {
                        session.clearStenosisMeasurement(activeRecord.id);
                        forceRefresh('Stenosis measurement deleted.');
                    }}>
                      Delete Measurement
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="action-grid">
                    <button
                      className="primary-btn small"
                      onClick={runAutoDetectStenosis}
                      disabled={pendingStenosisProximal != null}
                      title="Scan the lumen profile for the worst narrowing and set the lesion boundaries automatically"
                    >
                      Auto-Detect Stenosis
                    </button>
                    <button
                      className={`secondary-btn small ${pendingStenosisProximal != null ? 'active' : ''}`}
                      onClick={() => {
                        if (pendingStenosisProximal != null) {
                          setPendingStenosisProximal(null);
                          setStatus('Measurement cancelled.');
                        } else {
                          setPendingStenosisProximal(cursorDistanceMm);
                          setStatus('Proximal boundary marked. Move the cursor to the distal boundary, then press Finish Point.');
                        }
                      }}
                    >
                      {pendingStenosisProximal != null ? 'Cancel Measurement' : 'Add Measurement'}
                    </button>
                    {pendingStenosisProximal != null && (
                      <button
                        className="primary-btn small"
                        onClick={() => {
                          const distalMm = cursorDistanceMm;
                          const proximalMm = pendingStenosisProximal;
                          if (proximalMm == null) return;
                          if (Math.abs(distalMm - proximalMm) < 1) {
                            setStatus('Distal boundary must be at least 1 mm away from the proximal boundary.');
                            return;
                          }
                          session.setStenosisMeasurement(activeRecord.id, proximalMm, distalMm);
                          setPendingStenosisProximal(null);
                          forceRefresh('Stenosis measurement saved.');
                        }}
                      >
                        Finish Point
                      </button>
                    )}
                  </div>
                  <div className="instruction-box">
                    {pendingStenosisProximal != null
                      ? `Proximal marked at ${pendingStenosisProximal.toFixed(1)} mm. Move the Stretched View cursor to the distal boundary, then press Finish Point.`
                      : "Move the cursor line to the proximal boundary, then click 'Add Measurement'. After that, move the cursor to the distal boundary and press Finish Point (left-click on the Stretched View also commits)."}
                  </div>
                </>
              )}
            </div>

            <div className="workspace-card">
              <h3>Manual QCA Inputs</h3>
              <div className="field-grid">
                <NumberField
                  label="Prox ref diameter (mm)"
                  value={activeRecord.manual.proximalReferenceDiameterMm}
                  onChange={(value) => updateManualField('proximalReferenceDiameterMm', value)}
                />
                <NumberField
                  label="Dist ref diameter (mm)"
                  value={activeRecord.manual.distalReferenceDiameterMm}
                  onChange={(value) => updateManualField('distalReferenceDiameterMm', value)}
                />
                <NumberField
                  label="Minimal lumen diameter (mm)"
                  value={activeRecord.manual.minimalLumenDiameterMm}
                  onChange={(value) => updateManualField('minimalLumenDiameterMm', value)}
                />
                <NumberField
                  label="Prox ref area (mm2)"
                  value={activeRecord.manual.proximalReferenceAreaMm2}
                  onChange={(value) => updateManualField('proximalReferenceAreaMm2', value)}
                />
                <NumberField
                  label="Dist ref area (mm2)"
                  value={activeRecord.manual.distalReferenceAreaMm2}
                  onChange={(value) => updateManualField('distalReferenceAreaMm2', value)}
                />
                <NumberField
                  label="Minimal lumen area (mm2)"
                  value={activeRecord.manual.minimalLumenAreaMm2}
                  onChange={(value) => updateManualField('minimalLumenAreaMm2', value)}
                />
              </div>

              <label className="field-block">
                <span>Lesion notes</span>
                <textarea
                  rows={3}
                  value={activeRecord.manual.notes || ''}
                  onChange={(event) => updateTextField('notes', event.target.value)}
                />
              </label>
            </div>

            <div className="workspace-card">
              <h3>Derived QCA Metrics</h3>
              <div className="metric-list">
                <MetricRow label="Centerline length" value={`${fmt(metrics.centerlineLengthMm)} mm`} />
                <MetricRow label="Lesion length" value={`${fmt(metrics.lesionLengthMm)} mm`} />
                <MetricRow label="Reference diameter" value={`${fmt(metrics.referenceDiameterMm, 2)} mm`} />
                <MetricRow
                  label="Diameter stenosis"
                  value={
                    metrics.diameterStenosisPercent != null
                      ? `${metrics.diameterStenosisPercent.toFixed(1)} %`
                      : '—'
                  }
                  highlight={metrics.diameterStenosisPercent != null && metrics.diameterStenosisPercent >= 50}
                />
                <MetricRow label="Reference area" value={`${fmt(metrics.referenceAreaMm2, 2)} mm2`} />
                <MetricRow
                  label="Area stenosis"
                  value={
                    metrics.areaStenosisPercent != null
                      ? `${metrics.areaStenosisPercent.toFixed(1)} %`
                      : '—'
                  }
                />
                <MetricRow label="Severity" value={metrics.severityLabel} />
              </div>
            </div>

            <div className="workspace-card highlight-special">
              <div className="card-title-row">
                <h3>Quantitative Plaque Analysis (QCPA)</h3>
                <div className="card-badge">Phase 6</div>
              </div>
              
              <div className="action-grid compact" style={{marginBottom: '12px'}}>
                <button 
                  className={`secondary-btn small ${editVesselWallMode ? 'active' : ''}`}
                  onClick={() => {
                    setEditVesselWallMode(!editVesselWallMode);
                    if (!editVesselWallMode) setEditContourMode(false);
                  }}
                >
                  {editVesselWallMode ? 'Stop Editing EEM' : 'Edit Vessel Wall (EEM)'}
                </button>
                <button className="ghost-btn small" onClick={handleGenerateVesselWall}>
                  Auto-Init EEM
                </button>
                <button className="ghost-btn small" onClick={handleResetPlaque}>
                  Reset
                </button>
                <button 
                  className={`secondary-btn small ${snakeViewVisible ? 'active' : ''}`}
                  onClick={() => setSnakeViewVisible(!snakeViewVisible)}
                >
                  {snakeViewVisible ? 'Hide Stretched View' : 'Show Stretched View'}
                </button>
              </div>

              <div className="rotation-control">
                <div className="label-row">
                   <span>Pullback Rotation</span>
                   <strong>{snakeRotationDegrees.toFixed(0)}°</strong>
                </div>
                <input 
                  type="range" 
                  min="0" 
                  max="360" 
                  value={snakeRotationDegrees} 
                  onChange={(e) => setSnakeRotationDegrees(parseFloat(e.target.value))} 
                  className="rotation-slider"
                />
              </div>

              {metrics.plaque ? (
                <div className="metric-list plaque-metrics">
                  <MetricRow label="Total Plaque Volume" value={`${fmt(metrics.plaque.totalVolumeMm3, 1)} mm³`} highlight />
                  <MetricRow label="Plaque Burden" value={`${fmt(metrics.plaque.plaqueBurdenPercent, 1)} %`} />
                  
                  <div className="plaque-breakdown">
                     <div className="breakdown-item lap">
                        <div className="dot" /> 
                        <span>LAP (&lt; 30 HU)</span>
                        <strong>{fmt(metrics.plaque.lapVolumeMm3, 1)} mm³</strong>
                     </div>
                     <div className="breakdown-item fibrofatty">
                        <div className="dot" />
                        <span>Fibrofatty (30-130)</span>
                        <strong>{fmt(metrics.plaque.fibrofattyVolumeMm3, 1)} mm³</strong>
                     </div>
                     <div className="breakdown-item fibrous">
                        <div className="dot" />
                        <span>Fibrous (130-350)</span>
                        <strong>{fmt(metrics.plaque.fibrousVolumeMm3, 1)} mm³</strong>
                     </div>
                  </div>
                </div>
              ) : (
                <div className="instruction-box">
                  Define vessel wall boundaries (EEM) to calculate plaque volumes and burden. Use 'Auto-Init EEM' to start.
                </div>
              )}
            </div>

            <div className="workspace-card">
              <h3>CT-FFR Solver Inputs</h3>
              <div className="field-grid">
                <NumberField
                  label="Mean aortic pressure (mmHg)"
                  value={activeRecord.manual.meanAorticPressureMmHg}
                  onChange={(value) => updateManualField('meanAorticPressureMmHg', value)}
                />
                <NumberField
                  label="Myocardial mass (g)"
                  value={activeRecord.manual.myocardialMassG}
                  onChange={(value) => updateManualField('myocardialMassG', value)}
                />
                <NumberField
                  label="Hyperemia resistance scale"
                  value={activeRecord.manual.hyperemiaResistanceScale}
                  step="0.01"
                  onChange={(value) => updateManualField('hyperemiaResistanceScale', value)}
                />
              </div>

              <div className={`solver-readiness ${metrics.solverReady ? 'ready' : ''}`}>
                {metrics.solverReady
                  ? 'Core geometry and boundary-condition inputs are ready for reduced-order CFD.'
                  : 'CT-FFR requires at least 3 centerline points, lesion boundaries, an MLD site, and baseline pressure and mass inputs.'}
              </div>

              <div className="action-grid compact" style={{ marginTop: '12px' }}>
                <button
                  className="primary-btn small"
                  onClick={runPatientFFR}
                  disabled={ffrBusy}
                >
                  {ffrBusy ? 'Solving…' : 'Run CT-FFR'}
                </button>
                {ffrResult && (
                  <button
                    className="ghost-btn small"
                    onClick={() => {
                      setFFRResult(null);
                      setFFRError(null);
                    }}
                  >
                    Clear Results
                  </button>
                )}
              </div>
            </div>

            <div className="workspace-card highlight-special">
              <div className="card-title-row">
                <h3>CT-FFR Results</h3>
                <div className="card-badge">1D Solver</div>
              </div>
              <FFRResultsPanel result={ffrResult} error={ffrError} busy={ffrBusy} />
            </div>

            <div className="workspace-card highlight-special">
              <div className="card-title-row">
                <h3>Calcium Score (CAC)</h3>
                <div className="card-badge">Agatston</div>
              </div>
              <div className="action-grid compact" style={{ marginBottom: '12px' }}>
                <button
                  className="primary-btn small"
                  onClick={runCalciumScore}
                  disabled={cacBusy}
                >
                  {cacBusy ? 'Scoring…' : 'Run Calcium Score'}
                </button>
                {cacResult && (
                  <button
                    className="ghost-btn small"
                    onClick={() => {
                      setCACResult(null);
                      setCACError(null);
                    }}
                  >
                    Clear Results
                  </button>
                )}
              </div>
              <CACResultsPanel result={cacResult} error={cacError} busy={cacBusy} />
            </div>

            <div className="workspace-card">
              <div className="card-title-row">
                <h3>Export</h3>
                <span className="mini-copy">JSON + text report</span>
              </div>
              <div className="action-grid compact">
                <button className="primary-btn small" onClick={downloadJson}>
                  Download JSON
                </button>
                <button className="secondary-btn small" onClick={downloadReport}>
                  Download Report
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {contextMenu && (
        <div
          className="centerline-context-menu"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 280),
            top: Math.min(contextMenu.y, window.innerHeight - 240),
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="card-title-row">
            <h3>Edit Label &amp; Color</h3>
            <button className="ghost-btn" onClick={closeContextMenu}>
              Close
            </button>
          </div>
          <label className="field-block">
            <span>Label</span>
            <input
              type="text"
              value={contextMenu.label}
              onChange={(event) =>
                setContextMenu((current) =>
                  current ? { ...current, label: event.target.value } : current
                )
              }
            />
          </label>
          <label className="field-block">
            <span>Color</span>
            <input
              type="color"
              value={contextMenu.color}
              onChange={(event) =>
                setContextMenu((current) =>
                  current ? { ...current, color: event.target.value } : current
                )
              }
            />
          </label>
          <div className="action-grid compact">
            <button className="primary-btn small" onClick={applyContextMenuEdits}>
              Apply
            </button>
            {contextMenu.pointIndex === null && contextMenu.distanceMm !== undefined && (
              <>
                 <button
                   className="secondary-btn small"
                   onClick={() => {
                     setEditContourMode(!editContourMode);
                     closeContextMenu();
                     forceRefresh();
                   }}
                 >
                   {editContourMode ? 'Finish Editing Contour' : 'Edit Contour'}
                 </button>
                 <button
                   className="secondary-btn small"
                   onClick={() => {
                     // Toggle diameter handles visibility (we can store this in workspace state)
                     setDiameterHandlesVisible(!diameterHandlesVisible);
                     closeContextMenu();
                     forceRefresh();
                   }}
                 >
                   {diameterHandlesVisible ? 'Hide Diameter Handles' : 'Show Diameter Handles'}
                 </button>
                 <button
                   className="secondary-btn small"
                   onClick={() => {
                     session.clearLumenContour(contextMenu.centerlineId, contextMenu.distanceMm!);
                     closeContextMenu();
                     forceRefresh('Contour deleted.');
                   }}
                 >
                   Delete Contour
                 </button>
              </>
            )}
            {contextMenu.pointIndex != null && (
              <button
                className="secondary-btn small"
                onClick={() => {
                  deletePoint(contextMenu.centerlineId, contextMenu.pointIndex as number);
                }}
              >
                Delete Point
              </button>
            )}
            {contextMenu.distanceMm != null && contextMenu.markerId == null && (
              <button
                className="secondary-btn small"
                onClick={() => {
                  session.addCurveMarker(
                    contextMenu.centerlineId,
                    contextMenu.distanceMm!,
                    'Marker',
                    '#ffffff'
                  );
                  closeContextMenu();
                  forceRefresh('Marker added.');
                }}
              >
                Add Marker
              </button>
            )}
            {contextMenu.markerId != null && (
              <button
                className="secondary-btn small"
                onClick={() => {
                  session.removeCurveMarker(contextMenu.centerlineId, contextMenu.markerId!);
                  closeContextMenu();
                  forceRefresh('Marker deleted.');
                }}
              >
                Delete Marker
              </button>
            )}
            <button
              className="secondary-btn small"
              onClick={() => {
                deleteCenterline(contextMenu.centerlineId);
              }}
            >
              {session.getRecord(contextMenu.centerlineId).kind === 'main' ? 'Clear' : 'Delete'}
            </button>
          </div>
        </div>
      )}

      <SnakeView
        visible={snakeViewVisible}
        volumeId={volumeId}
        record={activeRecord}
        selectedPointIndex={selectedPointIndex}
        rotationDegrees={snakeRotationDegrees}
        cursorDistanceMm={cursorDistanceMm}
        onCursorChange={setCursorDistanceMm}
        pendingStenosisProximalMm={pendingStenosisProximal}
        onStenosisCommitted={(distalMm) => {
           session.setStenosisMeasurement(
             activeRecord.id,
             pendingStenosisProximal!,
             distalMm
           );
           setPendingStenosisProximal(null);
           forceRefresh('Stenosis measurement saved.');
        }}
        editContourMode={editContourMode}
        onEditContourModeChange={setEditContourMode}
        onContourChange={handleContourChange}
        editVesselWallMode={editVesselWallMode}
        onEditVesselWallModeChange={setEditVesselWallMode}
        diameterHandlesVisible={workflowStep === 'analysis' && !editContourMode && !editVesselWallMode}
        onDiameterOverrideChange={(distMm, minD, maxD) => {
          session.updateLumenContourOverrides(activeRecord.id, distMm, minD, maxD);
          forceRefresh();
        }}
        onClose={() => setSnakeViewVisible(false)}
        onRotationChange={setSnakeRotationDegrees}
        onSelectPoint={(index) => {
          setSelectedPointIndex(index);
          setActiveCenterlineId(activeRecord.id);
        }}
        onPointsChange={(points) => {
          session.setCenterlinePoints(activeRecord.id, points);
          forceRefresh();
        }}
        clinical={metrics.clinical}
        onRequestPointMenu={openPointContextMenu}
        onRequestSnakeMenu={(distanceMm, clientX, clientY) => {
          const proximityThresholdMm = 2;
          const marker = activeRecord.markers.find(m => Math.abs(m.distanceMm - distanceMm) < proximityThresholdMm);
          setContextMenu({
            centerlineId: activeRecord.id,
            x: clientX,
            y: clientY,
            label: activeRecord.label,
            color: activeRecord.color,
            pointIndex: null,
            distanceMm,
            markerId: marker?.id,
          });
        }}
        onStatusChange={setStatus}
      />

      {workflowStep === 'analysis' && (
        <div 
          className="analysis-profile-container" 
          style={{ 
            position: 'fixed', 
            bottom: 0, 
            left: 240, 
            right: 390, 
            height: 140, 
            background: 'rgba(7, 16, 24, 0.98)',
            borderTop: '1px solid rgba(255, 255, 255, 0.1)',
            zIndex: 100,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center'
          }}
        >
           <LongitudinalProfile
              record={activeRecord}
              metrics={metrics}
              cursorDistanceMm={cursorDistanceMm}
              onCursorChange={setCursorDistanceMm}
              width={Math.max(400, window.innerWidth - 630)}
              height={140}
           />
        </div>
      )}
    </aside>
  );
}

function clampIndex(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function MetricRow({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className={`metric-row ${highlight ? 'highlight' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  step,
}: {
  label: string;
  value: number | undefined;
  onChange: (value: string) => void;
  step?: string;
}) {
  return (
    <label className="field-block">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
