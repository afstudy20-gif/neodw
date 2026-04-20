import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import {
  segmentLeftAtrium,
  materializeLabelmap,
  worldToIJK,
  refineByHURange,
} from '../la/leftAtriumSegmentation';
import { trimThinBranches, cutAtPlane, countVoxels, paintSphere, fillHoles3D, componentContaining, erodeBall, dilateBall, boundingBox, cropWithPad, pasteSubvolume, rimIndices } from '../la/morphology';
import { marchingCubesBinary } from '../la/marchingCubes';
import { meshToBinarySTL, downloadBlob } from '../la/stlExport';
import { LA3DView } from '../la/LA3DView';
import {
  encodeBinaryRLE,
  decodeBinaryRLE,
  buildSessionFilename,
  downloadSessionJSON,
  readSessionJSON,
  type LASessionData,
} from '../la/laSessionIO';

interface Props {
  renderingEngineId: string;
  volumeId: string;
  patientName?: string;
  studyDate?: string;
}

export interface LAAPanelHandle {
  saveSession: () => void;
  loadSessionFile: (f: File) => Promise<void>;
  hasMask: () => boolean;
}

const MESH_PRESETS: Array<{ name: string; rgb: [number, number, number] }> = [
  { name: 'LA red',  rgb: [0.88, 0.32, 0.35] },
  { name: 'Pink',    rgb: [1.00, 0.60, 0.75] },
  { name: 'Gold',    rgb: [0.95, 0.78, 0.25] },
  { name: 'Bronze',  rgb: [0.80, 0.55, 0.35] },
  { name: 'Cyan',    rgb: [0.35, 0.80, 0.95] },
  { name: 'Green',   rgb: [0.40, 0.85, 0.50] },
  { name: 'White',   rgb: [0.95, 0.95, 0.95] },
];

const BG_PRESETS: Array<{ name: string; rgb: [number, number, number] }> = [
  { name: 'Dark',   rgb: [0.07, 0.08, 0.10] },
  { name: 'Black',  rgb: [0.00, 0.00, 0.00] },
  { name: 'Gray',   rgb: [0.35, 0.35, 0.35] },
  { name: 'Light',  rgb: [0.90, 0.90, 0.90] },
];

function rgbToHex(c: [number, number, number]): string {
  return '#' + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
}
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

function MeshColorBar({
  meshColor, setMeshColor, meshBg, setMeshBg, meshAlpha, setMeshAlpha,
}: {
  meshColor: [number, number, number];
  setMeshColor: (c: [number, number, number]) => void;
  meshBg: [number, number, number];
  setMeshBg: (c: [number, number, number]) => void;
  meshAlpha: number;
  setMeshAlpha: (a: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={{
      position: 'absolute', bottom: 6, left: 6, zIndex: 60,
      background: 'rgba(0,0,0,0.55)', padding: '4px 6px', borderRadius: 6,
      border: '1px solid rgba(255,255,255,0.15)', color: '#cfe0f4',
      fontSize: 11, display: 'flex', alignItems: 'center', gap: 4,
      flexWrap: 'wrap', maxWidth: 'calc(100% - 12px)',
    }}>
      <span style={{ opacity: 0.8, marginRight: 2 }}>mesh</span>
      {MESH_PRESETS.map((p) => (
        <button
          key={p.name}
          onClick={() => setMeshColor(p.rgb)}
          title={p.name}
          style={{
            width: 16, height: 16, borderRadius: '50%', cursor: 'pointer',
            background: rgbToHex(p.rgb),
            border: rgbToHex(meshColor).toLowerCase() === rgbToHex(p.rgb).toLowerCase()
              ? '2px solid #fff' : '1px solid rgba(255,255,255,0.25)',
            padding: 0,
          }}
        />
      ))}
      <input
        type="color"
        value={rgbToHex(meshColor)}
        onChange={(e) => setMeshColor(hexToRgb(e.target.value))}
        title="Custom mesh color"
        style={{ width: 22, height: 20, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }}
      />
      <span style={{ opacity: 0.8, marginLeft: 6 }}>α</span>
      <input
        type="range"
        min={0.1} max={1} step={0.05}
        value={meshAlpha}
        onChange={(e) => setMeshAlpha(Number(e.target.value))}
        title="Mesh opacity (drag for hollow-look transparency)"
        style={{ width: 64, verticalAlign: 'middle' }}
      />
      <span style={{ fontSize: 10, opacity: 0.7, minWidth: 24 }}>{meshAlpha.toFixed(2)}</span>
      <button
        onClick={() => setExpanded((v) => !v)}
        title="Background color"
        style={{
          padding: '2px 6px', fontSize: 10, background: 'color-mix(in oklch, var(--nd-ink) 6%, transparent)',
          border: '1px solid rgba(255,255,255,0.2)', color: '#fff',
          borderRadius: 3, cursor: 'pointer',
        }}
      >bg</button>
      {expanded && (
        <>
          {BG_PRESETS.map((p) => (
            <button
              key={p.name}
              onClick={() => setMeshBg(p.rgb)}
              title={p.name}
              style={{
                width: 16, height: 16, borderRadius: 3, cursor: 'pointer',
                background: rgbToHex(p.rgb),
                border: rgbToHex(meshBg).toLowerCase() === rgbToHex(p.rgb).toLowerCase()
                  ? '2px solid #fff' : '1px solid rgba(255,255,255,0.25)',
                padding: 0,
              }}
            />
          ))}
          <input
            type="color"
            value={rgbToHex(meshBg)}
            onChange={(e) => setMeshBg(hexToRgb(e.target.value))}
            title="Custom background color"
            style={{ width: 22, height: 20, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }}
          />
        </>
      )}
    </div>
  );
}

function LA3DInlineView({
  data,
  dims,
  voxelToWorld,
  refreshKey,
  onRebuild,
  onShow,
  onClose,
  visible,
  hasMask,
  meshColor,
  setMeshColor,
  meshBg,
  setMeshBg,
  meshAlpha,
  setMeshAlpha,
}: {
  data: Uint8Array | null;
  dims: { dx: number; dy: number; dz: number } | null;
  voxelToWorld: ((i: number, j: number, k: number) => [number, number, number]) | null;
  refreshKey: number;
  onRebuild: () => void;
  onShow: () => void;
  onClose: () => void;
  visible: boolean;
  hasMask: boolean;
  meshColor: [number, number, number];
  setMeshColor: (c: [number, number, number]) => void;
  meshBg: [number, number, number];
  setMeshBg: (c: [number, number, number]) => void;
  meshAlpha: number;
  setMeshAlpha: (a: number) => void;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    const find = () => {
      if (cancelled) return;
      const el = document.getElementById('viewport-3d');
      if (el) setHost(el); else requestAnimationFrame(find);
    };
    find();
    return () => { cancelled = true; };
  }, []);
  if (!host) return null;
  return createPortal(
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 50,
        background: '#000',
        overflow: 'hidden',
      }}
    >
      {visible && hasMask && data && dims && voxelToWorld ? (
        <>
          <LA3DView
            data={data}
            dims={dims}
            voxelToWorld={voxelToWorld}
            refreshKey={refreshKey}
            baseColor={meshColor}
            bgColor={meshBg}
            alpha={meshAlpha}
            fill
          />
          <MeshColorBar
            meshColor={meshColor}
            setMeshColor={setMeshColor}
            meshBg={meshBg}
            setMeshBg={setMeshBg}
            meshAlpha={meshAlpha}
            setMeshAlpha={setMeshAlpha}
          />
          <div style={{ position: 'absolute', top: 6, right: 6, zIndex: 60, display: 'flex', gap: 4 }}>
            <button
              onClick={onRebuild}
              title="Rebuild LAA mesh from current mask"
              style={{
                padding: '4px 10px', fontSize: 11, fontWeight: 600,
                background: 'rgba(220,60,60,0.4)', border: '1px solid rgba(220,60,60,0.7)',
                color: '#fff', borderRadius: 4, cursor: 'pointer',
              }}
            >↻ Rebuild</button>
            <button
              onClick={onClose}
              title="Close 3D mesh view"
              style={{
                padding: '4px 8px', fontSize: 12, fontWeight: 700,
                background: 'rgba(60,60,60,0.6)', border: '1px solid rgba(255,255,255,0.25)',
                color: '#fff', borderRadius: 4, cursor: 'pointer',
              }}
            >×</button>
          </div>
        </>
      ) : (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 10,
          color: '#9cb5d1', fontSize: 12, textAlign: 'center', padding: 12,
        }}>
          {hasMask ? (
            <>
              <div>LAA mask ready.</div>
              <button
                onClick={onShow}
                style={{
                  padding: '10px 18px', fontSize: 13, fontWeight: 600,
                  background: 'rgba(220,60,60,0.45)', border: '1px solid rgba(220,60,60,0.75)',
                  color: '#fff', borderRadius: 4, cursor: 'pointer',
                }}
              >Build 3D Mesh</button>
            </>
          ) : (
            <div>
              LAA 3D mesh will appear here.<br />
              Place seed → Run Flood-Fill.
            </div>
          )}
        </div>
      )}
    </div>,
    host
  );
}

const LAA_SEGMENTATION_ID = 'laaSegmentation';
const LAA_EXCLUDE_SEGMENTATION_ID = 'laaExcludeMask';
const MPR_VIEWPORT_IDS = ['axial', 'sagittal', 'coronal'];
const ALL_VIEWPORT_IDS = ['axial', 'sagittal', 'coronal', 'volume3d'];

// Blood-pool-only range. Trabecular bone starts ~150 HU and cortical bone >500,
// so a narrow band centered on peak iodinated contrast (≈300–400 HU) limits
// flood-fill leakage into spine/ribs even when seed is placed near vertebra.
const DEFAULT_MIN_HU = 280;
const DEFAULT_MAX_HU = 450;
const LAA_VOXEL_CAP = 250_000; // LAA typical volume ≈5–20 mL at 1mm isotropic

interface LAState {
  data: Uint8Array;
  originalData: Uint8Array; // snapshot from flood-fill, for "Reset Mask"
  dims: { dx: number; dy: number; dz: number };
  voxelToWorld: (i: number, j: number, k: number) => [number, number, number];
  voxelVolumeMm3: number;
  labelmapVolumeId: string;
  seedIJK: [number, number, number];
}

export const LAAPanel = forwardRef<LAAPanelHandle, Props>(function LAAPanel(
  { renderingEngineId, volumeId, patientName, studyDate }: Props,
  ref
) {
  const [minHU, setMinHU] = useState(DEFAULT_MIN_HU);
  const [maxHU, setMaxHU] = useState(DEFAULT_MAX_HU);
  const [seedWorld, setSeedWorld] = useState<number[] | null>(null);
  const [seedHU, setSeedHU] = useState<number | null>(null);
  const [seedMode, setSeedMode] = useState(false);
  const [trimRadiusMm, setTrimRadiusMm] = useState(6);
  const [editMode, setEditMode] = useState<'off' | 'paint' | 'erase' | 'sculpt' | 'exclude'>('off');
  const [extraSeedMode, setExtraSeedMode] = useState(false);
  // Tracks counts for UI display
  const [extraSeedCount, setExtraSeedCount] = useState(0);
  const [excludeVoxCount, setExcludeVoxCount] = useState(0);
  const [brushRadiusMm, setBrushRadiusMm] = useState(5);
  const [contourMode, setContourMode] = useState(false);
  const [contourRadiusMm, setContourRadiusMm] = useState(1.5);
  const [contourTick, setContourTick] = useState(0);
  const [handleCount, setHandleCount] = useState(16);
  const [meshTick, setMeshTick] = useState(0);
  const [meshVisible, setMeshVisible] = useState(false);
  const [meshColor, setMeshColor] = useState<[number, number, number]>([0.45, 0.85, 0.45]);
  const [meshBg, setMeshBg] = useState<[number, number, number]>([0.04, 0.06, 0.08]);
  const [meshAlpha, setMeshAlpha] = useState(0.92);
  const [flipMV, setFlipMV] = useState(false);
  const [flipAorta, setFlipAorta] = useState(false);
  const [mvMode, setMvMode] = useState(false);
  const [mvPoints, setMvPoints] = useState<Array<[number, number, number]>>([]);
  const [aortaMode, setAortaMode] = useState(false);
  const [aortaPoints, setAortaPoints] = useState<Array<[number, number, number]>>([]);
  const [running, setRunning] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [voxelCount, setVoxelCount] = useState<number | null>(null);
  const [volumeCm3, setVolumeCm3] = useState<number | null>(null);
  const [leaked, setLeaked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const laStateRef = useRef<LAState | null>(null);
  const handlesCacheRef = useRef<Map<string, Array<{ world: [number, number, number] }>>>(new Map());
  // Unified undo/redo — every stroke snapshots both LA mask AND exclude mask.
  // Undo restores both. Cap size to prevent memory blowup.
  type UndoEntry = { mask: Uint8Array; exclude: Uint8Array | null };
  const undoStackRef = useRef<UndoEntry[]>([]);
  const redoStackRef = useRef<UndoEntry[]>([]);
  const UNDO_CAP = 20;
  const [, forceRerender] = useState(0);
  // Exclude mask — user-painted "never include" regions. Respected by flood-fill
  // and stroke-based add. Same dims as mask.
  const excludeMaskRef = useRef<Uint8Array | null>(null);
  // Cornerstone labelmap volume id for exclude mask visualization (cyan overlay)
  const excludeLabelmapIdRef = useRef<string | null>(null);
  // Multi-seed list (additional + seeds beyond primary).
  const extraSeedsRef = useRef<Array<[number, number, number]>>([]);

  const clearSegmentation = useCallback(() => {
    const { segmentation } = cornerstoneTools;
    for (const vpId of ALL_VIEWPORT_IDS) {
      try {
        segmentation.removeSegmentationRepresentations(vpId, {
          segmentationId: LAA_SEGMENTATION_ID,
        });
      } catch { /* ignore */ }
    }
    try { segmentation.removeSegmentation(LAA_SEGMENTATION_ID); } catch { /* ignore */ }
    if (laStateRef.current?.labelmapVolumeId) {
      try { cornerstone.cache.removeVolumeLoadObject(laStateRef.current.labelmapVolumeId); } catch { /* ignore */ }
    }
    laStateRef.current = null;
    handlesCacheRef.current.clear();
    // Also clear exclude overlay
    excludeMaskRef.current = null;
    setExcludeVoxCount(0);
    if (excludeLabelmapIdRef.current) {
      for (const vpId of MPR_VIEWPORT_IDS) {
        try { segmentation.removeSegmentationRepresentations(vpId, { segmentationId: LAA_EXCLUDE_SEGMENTATION_ID }); } catch { /* ignore */ }
      }
      try { segmentation.removeSegmentation(LAA_EXCLUDE_SEGMENTATION_ID); } catch { /* ignore */ }
      try { cornerstone.cache.removeVolumeLoadObject(excludeLabelmapIdRef.current); } catch { /* ignore */ }
      excludeLabelmapIdRef.current = null;
    }
    extraSeedsRef.current = [];
    setExtraSeedCount(0);
    undoStackRef.current = [];
    redoStackRef.current = [];
    setVoxelCount(null);
    setVolumeCm3(null);
    setLeaked(false);
    setStatusMsg(null);
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    engine?.renderViewports(ALL_VIEWPORT_IDS);
  }, [renderingEngineId]);

  // Capture MPR cameras + crosshair toolCenter + annotation handles
  const captureViewState = useCallback(() => {
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    const cams: Record<string, any> = {};
    if (engine) {
      for (const vpId of MPR_VIEWPORT_IDS) {
        const vp = engine.getViewport(vpId);
        if (vp) cams[vpId] = vp.getCamera();
      }
    }
    const toolGroup = cornerstoneTools.ToolGroupManager.getToolGroup('mprToolGroup');
    const csToolName = (cornerstoneTools as any).CrosshairsTool?.toolName || 'Crosshairs';
    const csTool = toolGroup?.getToolInstance(csToolName) as any;
    const toolCenter: number[] | null =
      csTool?.toolCenter && csTool.toolCenter.length === 3 ? [...csTool.toolCenter] : null;
    return { engine, cams, csTool, csToolName, toolCenter };
  }, [renderingEngineId]);

  const restoreViewState = useCallback((state: ReturnType<typeof captureViewState>) => {
    const { engine, cams, csTool, csToolName, toolCenter } = state;
    if (!engine) return;
    for (const vpId of MPR_VIEWPORT_IDS) {
      const vp = engine.getViewport(vpId);
      if (vp && cams[vpId]) vp.setCamera(cams[vpId]);
    }
    if (csTool && toolCenter) {
      csTool.toolCenter = [...toolCenter];
      for (const vpId of MPR_VIEWPORT_IDS) {
        const vp = engine.getViewport(vpId);
        if (!vp?.element) continue;
        try {
          const anns = cornerstoneTools.annotation.state.getAnnotations(csToolName, vp.element);
          if (anns) for (const a of anns) {
            if (a.data?.handles) a.data.handles.toolCenter = [...toolCenter] as any;
          }
        } catch { /* ignore */ }
      }
    }
    engine.renderViewports(MPR_VIEWPORT_IDS);
  }, []);

  // Attach labelmap representation — saves camera/crosshair before, restores
  // at multiple ticks to defeat async resetCamera side-effects inside
  // Cornerstone segmentation/tools.
  const attachRepresentation = useCallback(async (
    labelmapVolumeId: string,
    preCapture?: ReturnType<typeof captureViewState>
  ) => {
    const { segmentation, Enums: ToolsEnums } = cornerstoneTools;
    const state = preCapture ?? captureViewState();

    try { segmentation.removeSegmentation(LAA_SEGMENTATION_ID); } catch { /* ignore */ }
    segmentation.addSegmentations([
      {
        segmentationId: LAA_SEGMENTATION_ID,
        representation: {
          type: ToolsEnums.SegmentationRepresentations.Labelmap,
          data: { volumeId: labelmapVolumeId },
        },
      },
    ]);
    const laColor: [number, number, number, number] = [220, 60, 60, 160];
    for (const vpId of MPR_VIEWPORT_IDS) {
      await segmentation.addLabelmapRepresentationToViewport(vpId, [
        {
          segmentationId: LAA_SEGMENTATION_ID,
          config: { colorLUTOrIndex: [[0, 0, 0, 0], laColor] as any },
        },
      ]);
    }

    // Multi-tick restore to beat any async resetCamera triggered by seg add
    restoreViewState(state);
    requestAnimationFrame(() => {
      restoreViewState(state);
      requestAnimationFrame(() => restoreViewState(state));
    });
    setTimeout(() => restoreViewState(state), 100);
    setTimeout(() => restoreViewState(state), 300);
  }, [captureViewState, restoreViewState]);

  // Mutate the existing labelmap volume in-place, then re-render.
  // Avoids creating a new volume on every op (was the main cause of freezes
  // and actor-remove warnings).
  const syncExcludeVisualization = useCallback(async () => {
    const cur = laStateRef.current;
    const mask = excludeMaskRef.current;
    if (!cur || !mask) return;
    const { segmentation, Enums: ToolsEnums } = cornerstoneTools;
    // Materialize labelmap on first call
    if (!excludeLabelmapIdRef.current) {
      const id = materializeLabelmap(volumeId, mask);
      if (!id) return;
      excludeLabelmapIdRef.current = id;
      try { segmentation.removeSegmentation(LAA_EXCLUDE_SEGMENTATION_ID); } catch { /* ignore */ }
      segmentation.addSegmentations([
        {
          segmentationId: LAA_EXCLUDE_SEGMENTATION_ID,
          representation: {
            type: ToolsEnums.SegmentationRepresentations.Labelmap,
            data: { volumeId: id },
          },
        },
      ]);
      const cyan: [number, number, number, number] = [80, 200, 230, 140];
      for (const vpId of MPR_VIEWPORT_IDS) {
        await segmentation.addLabelmapRepresentationToViewport(vpId, [
          {
            segmentationId: LAA_EXCLUDE_SEGMENTATION_ID,
            config: { colorLUTOrIndex: [[0, 0, 0, 0], cyan] as any },
          },
        ]);
      }
    } else {
      // Update existing
      const lm = cornerstone.cache.getVolume(excludeLabelmapIdRef.current);
      const arr = (lm as any)?.voxelManager?.getCompleteScalarDataArray?.();
      if (lm && arr) {
        for (let i = 0; i < mask.length; i++) (arr as any)[i] = mask[i];
        (lm as any).voxelManager?.setCompleteScalarDataArray?.(arr);
        (lm as any).imageData?.modified?.();
        try {
          (cornerstoneTools as any).segmentation?.triggerSegmentationEvents
            ?.triggerSegmentationDataModified?.(LAA_EXCLUDE_SEGMENTATION_ID);
        } catch { /* ignore */ }
      }
    }
  }, [volumeId]);

  const clearExcludeVisualization = useCallback(() => {
    const { segmentation } = cornerstoneTools;
    if (excludeLabelmapIdRef.current) {
      for (const vpId of MPR_VIEWPORT_IDS) {
        try {
          segmentation.removeSegmentationRepresentations(vpId, { segmentationId: LAA_EXCLUDE_SEGMENTATION_ID });
        } catch { /* ignore */ }
      }
      try { segmentation.removeSegmentation(LAA_EXCLUDE_SEGMENTATION_ID); } catch { /* ignore */ }
      try { cornerstone.cache.removeVolumeLoadObject(excludeLabelmapIdRef.current); } catch { /* ignore */ }
      excludeLabelmapIdRef.current = null;
    }
  }, []);

  const applyData = useCallback(async (newData: Uint8Array, opts?: { skipUndo?: boolean }) => {
    const cur = laStateRef.current;
    if (!cur) return;
    if (!opts?.skipUndo) {
      undoStackRef.current.push({
        mask: new Uint8Array(cur.data),
        exclude: excludeMaskRef.current ? new Uint8Array(excludeMaskRef.current) : null,
      });
      if (undoStackRef.current.length > UNDO_CAP) undoStackRef.current.shift();
      redoStackRef.current = [];
    }
    const lm = cornerstone.cache.getVolume(cur.labelmapVolumeId);
    const lmArr = (lm as any)?.voxelManager?.getCompleteScalarDataArray?.();
    if (lm && lmArr) {
      for (let i = 0; i < newData.length; i++) (lmArr as any)[i] = newData[i];
      (lm as any).voxelManager?.setCompleteScalarDataArray?.(lmArr);
      (lm as any).imageData?.modified?.();
      // Must fire Cornerstone segmentation event — render pipeline listens
      // for this, not vtk imageData.modified(). Without it the overlay
      // doesn't refresh and Trim / Fill Holes / MV Cut appear to do nothing.
      try {
        (cornerstoneTools as any).segmentation?.triggerSegmentationEvents
          ?.triggerSegmentationDataModified?.(LAA_SEGMENTATION_ID);
      } catch { /* best-effort */ }
    } else {
      // Fallback: volume gone — re-materialize (rare)
      const newId = materializeLabelmap(volumeId, newData);
      if (!newId) {
        setError('Failed to materialize labelmap volume.');
        return;
      }
      laStateRef.current = { ...cur, data: newData, labelmapVolumeId: newId };
      await attachRepresentation(newId);
      const nv0 = countVoxels(newData);
      setVoxelCount(nv0);
      setVolumeCm3((nv0 * cur.voxelVolumeMm3) / 1000);
      return;
    }
    laStateRef.current = { ...cur, data: newData };
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    engine?.renderViewports(MPR_VIEWPORT_IDS);
    const nv = countVoxels(newData);
    setVoxelCount(nv);
    setVolumeCm3((nv * cur.voxelVolumeMm3) / 1000);
  }, [volumeId, renderingEngineId, attachRepresentation]);

  // Seed placement: overlay a transparent div over each MPR viewport so the
  // click doesn't get swallowed by Cornerstone Tools (which binds mousedown
  // in capture phase). Overlay sits above with higher z-index, pointer-events:auto.
  useEffect(() => {
    if (!seedMode && !mvMode && !aortaMode && !extraSeedMode && editMode === 'off') return;
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    if (!engine) return;

    const cleanups: Array<() => void> = [];
    const elementIdMap: Record<string, string> = {
      axial: 'viewport-axial',
      sagittal: 'viewport-sagittal',
      coronal: 'viewport-coronal',
    };

    for (const vpId of MPR_VIEWPORT_IDS) {
      const vp = engine.getViewport(vpId);
      if (!vp) continue;
      // Prefer DOM container by id (most robust) — fall back to vp.element
      const el = (document.getElementById(elementIdMap[vpId]) as HTMLElement | null)
        ?? (vp.element as HTMLElement);
      if (!el) continue;

      const overlay = document.createElement('div');
      const isEditing = editMode !== 'off';
      overlay.style.cssText = `
        position:absolute; inset:0; z-index:9999;
        cursor:${isEditing ? 'none' : 'crosshair'}; background:rgba(255,60,60,0.04);
        outline:2px dashed rgba(255,60,60,0.6); outline-offset:-2px;
        pointer-events:auto;
      `;
      overlay.dataset.laPicker = '1';
      overlay.title = seedMode
        ? 'Click to place LAA seed'
        : mvMode
          ? 'Click to add MV plane point'
          : editMode === 'paint'
            ? 'Drag to paint LAA voxels'
            : 'Drag to erase LAA voxels';

      // Brush cursor: yellow oval tracks mouse, scales with brush diameter (mm)
      const brushCursor = document.createElement('div');
      const cursorColor =
        editMode === 'erase' ? 'rgba(255,100,100,0.95)'
          : editMode === 'exclude' ? 'rgba(80,220,255,0.95)'
            : editMode === 'paint' ? 'rgba(120,255,120,0.95)'
              : 'rgba(255,220,60,0.95)'; // sculpt / default yellow
      brushCursor.style.cssText = `
        position:absolute; pointer-events:none;
        border:2px solid ${cursorColor};
        border-radius:50%;
        box-shadow:0 0 3px rgba(0,0,0,0.6), inset 0 0 3px rgba(0,0,0,0.4);
        box-sizing:border-box;
        display:none;
        left:0; top:0; width:0; height:0;
      `;
      overlay.appendChild(brushCursor);

      const updateBrushCursor = (clientX: number, clientY: number) => {
        if (!isEditing) { brushCursor.style.display = 'none'; return; }
        const volume = cornerstone.cache.getVolume(volumeId);
        if (!volume?.imageData) return;
        const rect = el.getBoundingClientRect();
        const cx = clientX - rect.left;
        const cy = clientY - rect.top;
        const w0 = (vp as any).canvasToWorld?.([cx, cy]);
        const w1 = (vp as any).canvasToWorld?.([cx + 20, cy]);
        if (!w0 || !w1) return;
        const mmPerPx = Math.hypot(w1[0] - w0[0], w1[1] - w0[1], w1[2] - w0[2]) / 20;
        if (!(mmPerPx > 0)) return;
        const rPx = brushRadiusMm / mmPerPx;
        brushCursor.style.display = 'block';
        brushCursor.style.left = `${cx - rPx}px`;
        brushCursor.style.top = `${cy - rPx}px`;
        brushCursor.style.width = `${rPx * 2}px`;
        brushCursor.style.height = `${rPx * 2}px`;
      };

      let dragging = false;
      let paintTotalChanged = 0;
      // For sculpt mode: value (0 or 1) resolved at drag start based on click location.
      // paint/erase are fixed; sculpt samples mask[clicked voxel] and inverts.
      let sculptValue: 0 | 1 = 1;
      const paintAt = (clientX: number, clientY: number) => {
        const cur = laStateRef.current;
        if (!cur) { console.warn('[LAA Paint] no mask — run Flood-Fill first'); return; }
        const rect = el.getBoundingClientRect();
        const cx = clientX - rect.left;
        const cy = clientY - rect.top;
        const world = (vp as any).canvasToWorld?.([cx, cy]);
        if (!world) return;
        const volume = cornerstone.cache.getVolume(volumeId);
        if (!volume?.imageData) return;
        const ijkFloat = volume.imageData.worldToIndex(world);
        const ci = Math.round(ijkFloat[0]);
        const cj = Math.round(ijkFloat[1]);
        const ck = Math.round(ijkFloat[2]);
        const spacing = volume.imageData.getSpacing();
        const minSpacing = Math.min(spacing[0], spacing[1], spacing[2]);
        const radiusVox = Math.max(1, Math.round(brushRadiusMm / minSpacing));
        // Exclude mode paints into excludeMaskRef, not the LA mask
        if (editMode === 'exclude') {
          if (!excludeMaskRef.current) {
            excludeMaskRef.current = new Uint8Array(cur.data.length);
          }
          const changedEx = paintSphere(excludeMaskRef.current, cur.dims, ci, cj, ck, radiusVox, 1);
          paintTotalChanged += changedEx;
          // Live update cyan overlay (skip on first stroke — endDrag materializes)
          if (excludeLabelmapIdRef.current) {
            const lm = cornerstone.cache.getVolume(excludeLabelmapIdRef.current);
            const arr = (lm as any)?.voxelManager?.getCompleteScalarDataArray?.();
            if (lm && arr && excludeMaskRef.current) {
              for (let i = 0; i < excludeMaskRef.current.length; i++) (arr as any)[i] = excludeMaskRef.current[i];
              (lm as any).voxelManager?.setCompleteScalarDataArray?.(arr);
              (lm as any).imageData?.modified?.();
              try {
                (cornerstoneTools as any).segmentation?.triggerSegmentationEvents
                  ?.triggerSegmentationDataModified?.(LAA_EXCLUDE_SEGMENTATION_ID);
              } catch { /* best-effort */ }
            }
          }
          return;
        }
        const value: 0 | 1 = editMode === 'paint' ? 1 : editMode === 'erase' ? 0 : sculptValue;
        const changed = paintSphere(cur.data, cur.dims, ci, cj, ck, radiusVox, value);
        paintTotalChanged += changed;
        // Live update: mark labelmap modified each stroke step so user sees feedback
        const lm = cornerstone.cache.getVolume(cur.labelmapVolumeId);
        const lmArr = (lm as any)?.voxelManager?.getCompleteScalarDataArray?.();
        if (lm && lmArr) {
          for (let i = 0; i < cur.data.length; i++) (lmArr as any)[i] = cur.data[i];
          (lm as any).voxelManager?.setCompleteScalarDataArray?.(lmArr);
          (lm as any).imageData?.modified?.();
          try {
            (cornerstoneTools as any).segmentation?.triggerSegmentationEvents
              ?.triggerSegmentationDataModified?.(LAA_SEGMENTATION_ID);
          } catch { /* best-effort */ }
        }
      };

      const endDrag = async () => {
        if (!dragging) return;
        dragging = false;
        prevClientX = null; prevClientY = null;
        const cur = laStateRef.current;
        if (!cur) return;
        if (editMode === 'exclude') {
          if (paintTotalChanged > 0) {
            let total = 0;
            if (excludeMaskRef.current) for (let i = 0; i < excludeMaskRef.current.length; i++) if (excludeMaskRef.current[i]) total++;
            setExcludeVoxCount(total);
            await syncExcludeVisualization();
            setStatusMsg(`Exclude stroke: +${paintTotalChanged.toLocaleString()} voxels (total excluded: ${total.toLocaleString()}). Re-run Flood-Fill.`);
          }
          paintTotalChanged = 0;
          return;
        }
        await applyData(cur.data, { skipUndo: true });
        if (paintTotalChanged > 0) {
          const verb = editMode === 'paint' ? 'Painted' : editMode === 'erase' ? 'Erased' : (sculptValue === 1 ? 'Added' : 'Removed');
          setStatusMsg(`${verb} ${paintTotalChanged.toLocaleString()} voxels.`);
        }
        paintTotalChanged = 0;
      };

      let prevClientX: number | null = null;
      let prevClientY: number | null = null;
      const onMouseMove = (e: MouseEvent) => {
        updateBrushCursor(e.clientX, e.clientY);
        if (!dragging) return;
        const cx = e.clientX, cy = e.clientY;
        if (prevClientX !== null && prevClientY !== null) {
          const dx = cx - prevClientX, dy = cy - prevClientY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          // Interpolate at ~4px steps so consecutive spheres overlap
          const steps = Math.max(1, Math.ceil(dist / 4));
          for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            paintAt(prevClientX + dx * t, prevClientY + dy * t);
          }
        } else {
          paintAt(cx, cy);
        }
        prevClientX = cx; prevClientY = cy;
      };

      const handler = (e: MouseEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = el.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const world = (vp as any).canvasToWorld?.([cx, cy]);
        if (!world) return;

        if (editMode !== 'off') {
          dragging = true;
          // Push undo snapshot at stroke START so all edits (mask + exclude) are undoable
          const curS = laStateRef.current;
          if (curS) {
            undoStackRef.current.push({
              mask: new Uint8Array(curS.data),
              exclude: excludeMaskRef.current ? new Uint8Array(excludeMaskRef.current) : null,
            });
            if (undoStackRef.current.length > UNDO_CAP) undoStackRef.current.shift();
            redoStackRef.current = [];
          }
          // Sculpt: sample current mask at click → invert (inside=erase, outside=add)
          if (editMode === 'sculpt') {
            const cur = laStateRef.current;
            const volume = cornerstone.cache.getVolume(volumeId);
            if (cur && volume?.imageData) {
              const ijk = volume.imageData.worldToIndex(world);
              const ci = Math.round(ijk[0]);
              const cj = Math.round(ijk[1]);
              const ck = Math.round(ijk[2]);
              const { dx, dy, dz } = cur.dims;
              if (ci >= 0 && ci < dx && cj >= 0 && cj < dy && ck >= 0 && ck < dz) {
                const stride = dx * dy;
                const idx = ck * stride + cj * dx + ci;
                sculptValue = cur.data[idx] ? 0 : 1; // inside→erase, outside→add
              } else {
                sculptValue = 1;
              }
            }
          }
          paintAt(e.clientX, e.clientY);
          prevClientX = e.clientX; prevClientY = e.clientY;
          return;
        }

        if (seedMode) {
          setSeedWorld([world[0], world[1], world[2]]);
          let hu: number | null = null;
          try {
            const volume = cornerstone.cache.getVolume(volumeId);
            if (volume?.imageData) {
              const ijkFloat = volume.imageData.worldToIndex(world);
              const dims = volume.imageData.getDimensions();
              const i = Math.round(ijkFloat[0]);
              const j = Math.round(ijkFloat[1]);
              const k = Math.round(ijkFloat[2]);
              if (i >= 0 && i < dims[0] && j >= 0 && j < dims[1] && k >= 0 && k < dims[2]) {
                const flatIdx = k * dims[0] * dims[1] + j * dims[0] + i;
                // Prefer voxelManager — reliable during streaming; fall back to vtk scalars
                const scalarArray = (volume as any).voxelManager?.getCompleteScalarDataArray?.();
                if (scalarArray) {
                  hu = scalarArray[flatIdx] ?? null;
                } else {
                  const scalars = volume.imageData.getPointData()?.getScalars?.();
                  const tup = scalars?.getTuple?.(flatIdx);
                  hu = tup?.[0] ?? null;
                }
              }
            }
          } catch { /* HU sampling best-effort */ }
          setSeedHU(hu);
          setSeedMode(false);
          setError(null);
        } else if (mvMode) {
          setMvPoints((prev) => {
            const next = [...prev, [world[0], world[1], world[2]] as [number, number, number]];
            if (next.length >= 3) setMvMode(false);
            return next;
          });
        } else if (aortaMode) {
          setAortaPoints((prev) => {
            const next = [...prev, [world[0], world[1], world[2]] as [number, number, number]];
            if (next.length >= 3) setAortaMode(false);
            return next;
          });
        } else if (extraSeedMode) {
          const w = [world[0], world[1], world[2]] as [number, number, number];
          extraSeedsRef.current.push(w);
          setExtraSeedCount(extraSeedsRef.current.length);
          setStatusMsg(`Extra seed #${extraSeedsRef.current.length} placed. Re-run Flood-Fill to apply.`);
        }
      };

      // Ensure element is positioned for absolute overlay
      const prevPos = el.style.position;
      if (!prevPos || prevPos === 'static') el.style.position = 'relative';

      const onLeave = () => { brushCursor.style.display = 'none'; endDrag(); };
      // Forward wheel events to underlying Cornerstone canvas so slice scroll
      // still works while the picker overlay is active.
      const onWheel = (e: WheelEvent) => {
        const canvas = el.querySelector('canvas');
        if (!canvas) return;
        e.preventDefault();
        e.stopPropagation();
        canvas.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          deltaZ: e.deltaZ,
          deltaMode: e.deltaMode,
          clientX: e.clientX,
          clientY: e.clientY,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
        }));
      };
      // Forward right / middle mouse events so Cornerstone tools (zoom, pan,
      // crosshair drag on non-left buttons) keep working.
      const forwardToCanvas = (evtName: string) => (e: MouseEvent) => {
        if (e.button === 0) return; // left-click reserved for picker
        const canvas = el.querySelector('canvas');
        if (!canvas) return;
        canvas.dispatchEvent(new MouseEvent(evtName, {
          bubbles: true, cancelable: true,
          button: e.button, buttons: e.buttons,
          clientX: e.clientX, clientY: e.clientY,
          ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
        }));
      };
      const onMouseDownPass = forwardToCanvas('mousedown');
      const onMouseUpPass = forwardToCanvas('mouseup');
      overlay.addEventListener('mousedown', handler);
      overlay.addEventListener('mousedown', onMouseDownPass);
      overlay.addEventListener('mouseup', onMouseUpPass);
      overlay.addEventListener('mousemove', onMouseMove);
      overlay.addEventListener('mouseup', endDrag);
      overlay.addEventListener('mouseleave', onLeave);
      overlay.addEventListener('wheel', onWheel, { passive: false });
      overlay.addEventListener('contextmenu', (e) => e.preventDefault());
      el.appendChild(overlay);

      cleanups.push(() => {
        overlay.removeEventListener('mousedown', handler);
        overlay.removeEventListener('mousedown', onMouseDownPass);
        overlay.removeEventListener('mouseup', onMouseUpPass);
        overlay.removeEventListener('mousemove', onMouseMove);
        overlay.removeEventListener('mouseup', endDrag);
        overlay.removeEventListener('mouseleave', onLeave);
        overlay.removeEventListener('wheel', onWheel as any);
        if (overlay.parentElement === el) el.removeChild(overlay);
        if (!prevPos || prevPos === 'static') el.style.position = prevPos;
      });
    }
    return () => cleanups.forEach((fn) => fn());
  }, [seedMode, mvMode, aortaMode, extraSeedMode, editMode, brushRadiusMm, renderingEngineId, volumeId, applyData]);

  // Compute plane from 3 world-space points: unit normal + centroid origin.
  const planeFromPoints = useCallback((pts: Array<[number, number, number]>) => {
    if (pts.length < 3) return null;
    const [p0, p1, p2] = pts;
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
    const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 0)) return null;
    nx /= len; ny /= len; nz /= len;
    const origin: [number, number, number] = [
      (p0[0] + p1[0] + p2[0]) / 3,
      (p0[1] + p1[1] + p2[1]) / 3,
      (p0[2] + p1[2] + p2[2]) / 3,
    ];
    return { normal: [nx, ny, nz] as [number, number, number], origin };
  }, []);

  // MV + aorta point markers on MPRs. SVG dots follow camera/slice changes.
  useEffect(() => {
    if (mvPoints.length === 0 && aortaPoints.length === 0) return;
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    if (!engine) return;
    const elementIdMap: Record<string, string> = {
      axial: 'viewport-axial', sagittal: 'viewport-sagittal', coronal: 'viewport-coronal',
    };
    const cleanups: Array<() => void> = [];
    for (const vpId of MPR_VIEWPORT_IDS) {
      const vp = engine.getViewport(vpId) as any;
      if (!vp) continue;
      const el = (document.getElementById(elementIdMap[vpId]) as HTMLElement | null)
        ?? (vp.element as HTMLElement);
      if (!el) continue;
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:absolute; inset:0; z-index:9998; pointer-events:none;';
      overlay.dataset.laMarkers = '1';

      const prevPos = el.style.position;
      if (!prevPos || prevPos === 'static') el.style.position = 'relative';

      const draw = () => {
        const rect = el.getBoundingClientRect();
        const cam = vp.getCamera?.();
        const vn = cam?.viewPlaneNormal;
        const fp = cam?.focalPoint;
        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('width', String(rect.width));
        svg.setAttribute('height', String(rect.height));
        svg.style.cssText = 'position:absolute; left:0; top:0; pointer-events:none;';

        const addMarker = (w: [number, number, number], color: string, label: string) => {
          const c = vp.worldToCanvas?.(w);
          if (!c) return;
          if (c[0] < -30 || c[1] < -30 || c[0] > rect.width + 30 || c[1] > rect.height + 30) return;
          // Slice-depth opacity: dim when far from current slice plane
          let opacity = 1;
          if (vn && fp) {
            const d = (w[0] - fp[0]) * vn[0] + (w[1] - fp[1]) * vn[1] + (w[2] - fp[2]) * vn[2];
            const ad = Math.abs(d);
            opacity = ad < 1 ? 1 : ad < 5 ? 0.55 : ad < 15 ? 0.25 : 0.1;
          }
          const g = document.createElementNS(svgNS, 'g');
          g.setAttribute('opacity', String(opacity));
          const ring = document.createElementNS(svgNS, 'circle');
          ring.setAttribute('cx', String(c[0]));
          ring.setAttribute('cy', String(c[1]));
          ring.setAttribute('r', '7');
          ring.setAttribute('fill', 'none');
          ring.setAttribute('stroke', color);
          ring.setAttribute('stroke-width', '2');
          g.appendChild(ring);
          const dot = document.createElementNS(svgNS, 'circle');
          dot.setAttribute('cx', String(c[0]));
          dot.setAttribute('cy', String(c[1]));
          dot.setAttribute('r', '2.5');
          dot.setAttribute('fill', color);
          g.appendChild(dot);
          const txt = document.createElementNS(svgNS, 'text');
          txt.setAttribute('x', String(c[0] + 10));
          txt.setAttribute('y', String(c[1] - 8));
          txt.setAttribute('fill', color);
          txt.setAttribute('font-size', '11');
          txt.setAttribute('font-weight', '700');
          txt.setAttribute('stroke', 'rgba(0,0,0,0.7)');
          txt.setAttribute('stroke-width', '0.6');
          txt.setAttribute('paint-order', 'stroke');
          txt.textContent = label;
          g.appendChild(txt);
          svg.appendChild(g);
        };

        mvPoints.forEach((p, i) => addMarker(p, '#ffb347', `MV${i + 1}`));
        aortaPoints.forEach((p, i) => addMarker(p, '#c080ff', `Ao${i + 1}`));

        // Plane-slice intersection line (blue MV, purple Ao) when 3 points set.
        const drawPlaneLine = (
          plane: { normal: [number, number, number]; origin: [number, number, number] },
          color: string,
          label: string
        ) => {
          if (!vn || !fp) return;
          const [n1x, n1y, n1z] = plane.normal;
          const [p1x, p1y, p1z] = plane.origin;
          const n2x = vn[0], n2y = vn[1], n2z = vn[2];
          const p2x = fp[0], p2y = fp[1], p2z = fp[2];
          // Direction = n1 × n2
          const dx = n1y * n2z - n1z * n2y;
          const dy = n1z * n2x - n1x * n2z;
          const dz = n1x * n2y - n1y * n2x;
          const dl2 = dx * dx + dy * dy + dz * dz;
          if (dl2 < 1e-8) return; // planes parallel
          const d1 = n1x * p1x + n1y * p1y + n1z * p1z;
          const d2 = n2x * p2x + n2y * p2y + n2z * p2z;
          // a = n2 × dir; b = dir × n1
          const ax = n2y * dz - n2z * dy, ay = n2z * dx - n2x * dz, az = n2x * dy - n2y * dx;
          const bx = dy * n1z - dz * n1y, by = dz * n1x - dx * n1z, bz = dx * n1y - dy * n1x;
          const Px = (d1 * ax + d2 * bx) / dl2;
          const Py = (d1 * ay + d2 * by) / dl2;
          const Pz = (d1 * az + d2 * bz) / dl2;
          const dlen = Math.sqrt(dl2);
          const udx = dx / dlen, udy = dy / dlen, udz = dz / dlen;
          const t = 800; // mm — well outside any realistic FOV
          const Ax = Px + udx * t, Ay = Py + udy * t, Az = Pz + udz * t;
          const Bx = Px - udx * t, By = Py - udy * t, Bz = Pz - udz * t;
          const ca = vp.worldToCanvas?.([Ax, Ay, Az]);
          const cb = vp.worldToCanvas?.([Bx, By, Bz]);
          if (!ca || !cb) return;
          const line = document.createElementNS(svgNS, 'line');
          line.setAttribute('x1', String(ca[0]));
          line.setAttribute('y1', String(ca[1]));
          line.setAttribute('x2', String(cb[0]));
          line.setAttribute('y2', String(cb[1]));
          line.setAttribute('stroke', color);
          line.setAttribute('stroke-width', '2');
          line.setAttribute('stroke-dasharray', '8,4');
          line.setAttribute('opacity', '0.85');
          svg.appendChild(line);
          const tx = document.createElementNS(svgNS, 'text');
          tx.setAttribute('x', String((ca[0] + cb[0]) / 2));
          tx.setAttribute('y', String((ca[1] + cb[1]) / 2 - 6));
          tx.setAttribute('fill', color);
          tx.setAttribute('font-size', '11');
          tx.setAttribute('font-weight', '700');
          tx.setAttribute('stroke', 'rgba(0,0,0,0.7)');
          tx.setAttribute('stroke-width', '0.6');
          tx.setAttribute('paint-order', 'stroke');
          tx.textContent = label;
          svg.appendChild(tx);
        };

        if (mvPoints.length === 3) {
          const pl = planeFromPoints(mvPoints);
          if (pl) drawPlaneLine(pl, '#4fa9ff', 'MV');
        }
        if (aortaPoints.length === 3) {
          const pl = planeFromPoints(aortaPoints);
          if (pl) drawPlaneLine(pl, '#c080ff', 'Ao');
        }

        overlay.replaceChildren(svg);
      };
      draw();
      el.appendChild(overlay);

      const onCamera = () => draw();
      el.addEventListener('wheel', onCamera, { passive: true });
      const events = (cornerstone as any).Enums?.Events;
      const camEvt = events?.CAMERA_MODIFIED || 'CAMERA_MODIFIED';
      el.addEventListener(camEvt, onCamera as any);
      const resizeObs = new ResizeObserver(draw);
      resizeObs.observe(el);

      cleanups.push(() => {
        el.removeEventListener('wheel', onCamera);
        el.removeEventListener(camEvt, onCamera as any);
        resizeObs.disconnect();
        if (overlay.parentElement === el) el.removeChild(overlay);
        if (!prevPos || prevPos === 'static') el.style.position = prevPos;
      });
    }
    return () => cleanups.forEach((fn) => fn());
  }, [mvPoints, aortaPoints, renderingEngineId, volumeId, planeFromPoints]);

  // Contour-drag edit mode: TAVI-style persistent handles per slice.
  // Handles live in handlesCacheRef keyed by slice signature. Drag moves only
  // the grabbed handle — others stay put. On drag end, paint/erase spheres
  // reshape the mask locally, but handles don't regenerate from rim.
  useEffect(() => {
    if (!contourMode) return;
    const cur = laStateRef.current;
    if (!cur) return;
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    if (!engine) return;

    // Cache reset on mode re-entry and on handleCount change (different N).
    handlesCacheRef.current.clear();

    // Rim computed once per mode entry — used only to initialize handles for
    // each slice on first visit.
    const rim = rimIndices(cur.data, cur.dims);
    const { dx, dy } = cur.dims;
    const stride = dx * dy;
    const rimPts: Array<{ world: [number, number, number] }> = new Array(rim.length);
    for (let p = 0; p < rim.length; p++) {
      const idx = rim[p];
      const k = (idx / stride) | 0;
      const rem = idx - k * stride;
      const j = (rem / dx) | 0;
      const i = rem - j * dx;
      rimPts[p] = { world: cur.voxelToWorld(i, j, k) };
    }

    const cleanups: Array<() => void> = [];
    const elementIdMap: Record<string, string> = {
      axial: 'viewport-axial', sagittal: 'viewport-sagittal', coronal: 'viewport-coronal',
    };
    const volume = cornerstone.cache.getVolume(volumeId);
    const spacing = volume?.imageData?.getSpacing?.() || [1, 1, 1];
    const minSpacing = Math.min(spacing[0], spacing[1], spacing[2]);
    const halfThick = Math.max(0.5, minSpacing * 0.75);

    for (const vpId of MPR_VIEWPORT_IDS) {
      const vp = engine.getViewport(vpId) as any;
      if (!vp) continue;
      const el = (document.getElementById(elementIdMap[vpId]) as HTMLElement | null) ?? (vp.element as HTMLElement);
      if (!el) continue;

      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:absolute; inset:0; z-index:9999; pointer-events:none;';
      overlay.dataset.laContour = '1';

      // Derive handles for this slice from rimPts using angle-bin resampling.
      const deriveHandles = (nx: number, ny: number, nz: number, fx: number, fy: number, fz: number): Array<{ world: [number, number, number] }> | null => {
        const rect = el.getBoundingClientRect();
        const cands: Array<{ world: [number, number, number]; cx: number; cy: number }> = [];
        for (const p of rimPts) {
          const d = (p.world[0] - fx) * nx + (p.world[1] - fy) * ny + (p.world[2] - fz) * nz;
          if (Math.abs(d) > halfThick) continue;
          const c = vp.worldToCanvas?.(p.world);
          if (!c) continue;
          if (c[0] < 0 || c[1] < 0 || c[0] > rect.width || c[1] > rect.height) continue;
          cands.push({ world: p.world, cx: c[0], cy: c[1] });
        }
        if (cands.length < 3) return null;
        let mx = 0, my = 0;
        for (const c of cands) { mx += c.cx; my += c.cy; }
        mx /= cands.length; my /= cands.length;
        const N = Math.max(6, Math.min(48, handleCount));
        const bins: Array<typeof cands[0] | null> = new Array(N).fill(null);
        const binDist: number[] = new Array(N).fill(Infinity);
        for (const p of cands) {
          const a = Math.atan2(p.cy - my, p.cx - mx);
          const norm = (a + Math.PI) / (2 * Math.PI);
          const bi = Math.min(N - 1, Math.floor(norm * N));
          const binCenter = -Math.PI + (bi + 0.5) * (2 * Math.PI / N);
          const d = Math.abs(a - binCenter);
          if (d < binDist[bi]) { binDist[bi] = d; bins[bi] = p; }
        }
        const kept = bins.filter((b): b is NonNullable<typeof b> => b !== null);
        if (kept.length < 3) return null;
        return kept.map((k) => ({ world: [k.world[0], k.world[1], k.world[2]] as [number, number, number] }));
      };

      const renderDots = () => {
        overlay.replaceChildren();
        const cam = vp.getCamera?.();
        if (!cam) return;
        const [nx, ny, nz] = cam.viewPlaneNormal;
        const [fx, fy, fz] = cam.focalPoint;
        const sliceDist = fx * nx + fy * ny + fz * nz;
        const sliceKey = `${vpId}:${sliceDist.toFixed(1)}`;

        let handles = handlesCacheRef.current.get(sliceKey);
        if (!handles) {
          const derived = deriveHandles(nx, ny, nz, fx, fy, fz);
          if (!derived) return;
          handles = derived;
          handlesCacheRef.current.set(sliceKey, handles);
        }

        const rect = el.getBoundingClientRect();
        const proj: Array<{ cx: number; cy: number; idx: number }> = [];
        for (let i = 0; i < handles.length; i++) {
          const c = vp.worldToCanvas?.(handles[i].world);
          if (!c) continue;
          proj.push({ cx: c[0], cy: c[1], idx: i });
        }
        if (proj.length < 3) return;

        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('width', String(rect.width));
        svg.setAttribute('height', String(rect.height));
        svg.style.cssText = 'position:absolute; inset:0; pointer-events:none;';
        const poly = document.createElementNS(svgNS, 'polygon');
        poly.setAttribute('points', proj.map((p) => `${p.cx},${p.cy}`).join(' '));
        poly.setAttribute('fill', 'rgba(255,80,80,0.10)');
        poly.setAttribute('stroke', 'rgba(255,80,80,0.9)');
        poly.setAttribute('stroke-width', '1.8');
        svg.appendChild(poly);
        overlay.appendChild(svg);

        for (const p of proj) {
          const dot = document.createElement('div');
          dot.style.cssText = `position:absolute; left:${p.cx - 6}px; top:${p.cy - 6}px; width:12px; height:12px; border-radius:50%; background:rgba(255,80,80,0.95); border:2px solid white; cursor:grab; pointer-events:auto; box-shadow:0 0 3px rgba(0,0,0,0.6);`;
          dot.dataset.handleIdx = String(p.idx);
          dot.dataset.sliceKey = sliceKey;
          overlay.appendChild(dot);
        }
      };

      renderDots();

      let drag: { sliceKey: string; idx: number; sourceWorld: [number, number, number] } | null = null;
      let ghost: HTMLDivElement | null = null;

      const onDown = (e: MouseEvent) => {
        const t = e.target as HTMLElement;
        if (!t?.dataset?.handleIdx || !t?.dataset?.sliceKey) return;
        e.preventDefault();
        e.stopPropagation();
        const sk = t.dataset.sliceKey;
        const idx = Number(t.dataset.handleIdx);
        const handles = handlesCacheRef.current.get(sk);
        if (!handles || !handles[idx]) return;
        drag = { sliceKey: sk, idx, sourceWorld: [...handles[idx].world] as [number, number, number] };
        t.style.background = 'rgba(255,220,80,0.95)';
        t.style.cursor = 'grabbing';
        ghost = document.createElement('div');
        ghost.style.cssText = 'position:absolute; width:12px; height:12px; border-radius:50%; background:rgba(100,200,255,0.9); border:1.5px solid white; pointer-events:none;';
        overlay.appendChild(ghost);
      };

      const onMove = (e: MouseEvent) => {
        if (!drag || !ghost) return;
        const rect = el.getBoundingClientRect();
        ghost.style.left = `${e.clientX - rect.left - 6}px`;
        ghost.style.top = `${e.clientY - rect.top - 6}px`;
      };

      const onUp = async (e: MouseEvent) => {
        if (!drag) return;
        const { sliceKey: sk, idx, sourceWorld } = drag;
        drag = null;
        if (ghost && ghost.parentElement) ghost.parentElement.removeChild(ghost);
        ghost = null;

        const rect = el.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const targetWorld = vp.canvasToWorld?.([cx, cy]);
        if (!targetWorld) { renderDots(); return; }

        // Update cached handle position FIRST so subsequent renders show new spot.
        const handles = handlesCacheRef.current.get(sk);
        if (handles && handles[idx]) {
          handles[idx] = { world: [targetWorld[0], targetWorld[1], targetWorld[2]] };
        }

        // Reshape mask: paint sphere at target, erase sphere at source.
        const lmVolume = cornerstone.cache.getVolume(volumeId);
        if (lmVolume?.imageData) {
          const sp = lmVolume.imageData.getSpacing();
          const ms = Math.min(sp[0], sp[1], sp[2]);
          const radiusVox = Math.max(1, Math.round(contourRadiusMm / ms));
          const tIjk = lmVolume.imageData.worldToIndex(targetWorld);
          const sIjk = lmVolume.imageData.worldToIndex(sourceWorld);
          const data = cur.data;
          paintSphere(data, cur.dims, Math.round(tIjk[0]), Math.round(tIjk[1]), Math.round(tIjk[2]), radiusVox, 1);
          paintSphere(data, cur.dims, Math.round(sIjk[0]), Math.round(sIjk[1]), Math.round(sIjk[2]), radiusVox, 0);
          await applyData(data);
        }
        // Re-render dots — handles cache holds updated positions.
        renderDots();
      };

      const onCam = () => renderDots();
      const csEvents = (cornerstone as any).Enums?.Events;
      const camEvt = csEvents?.CAMERA_MODIFIED || 'CORNERSTONE_CAMERA_MODIFIED';

      overlay.addEventListener('mousedown', onDown);
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      el.addEventListener(camEvt, onCam as EventListener);

      const prevPos = el.style.position;
      if (!prevPos || prevPos === 'static') el.style.position = 'relative';
      el.appendChild(overlay);

      cleanups.push(() => {
        overlay.removeEventListener('mousedown', onDown);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        el.removeEventListener(camEvt, onCam as EventListener);
        if (overlay.parentElement === el) el.removeChild(overlay);
        if (!prevPos || prevPos === 'static') el.style.position = prevPos;
      });
    }
    return () => cleanups.forEach((fn) => fn());
  }, [contourMode, contourRadiusMm, handleCount, renderingEngineId, volumeId, applyData]);

  const runUndo = useCallback(async () => {
    const cur = laStateRef.current; if (!cur) return;
    const prev = undoStackRef.current.pop();
    if (!prev) { setStatusMsg('Nothing to undo.'); return; }
    redoStackRef.current.push({
      mask: new Uint8Array(cur.data),
      exclude: excludeMaskRef.current ? new Uint8Array(excludeMaskRef.current) : null,
    });
    if (redoStackRef.current.length > UNDO_CAP) redoStackRef.current.shift();
    excludeMaskRef.current = prev.exclude ? new Uint8Array(prev.exclude) : null;
    let ec = 0; if (excludeMaskRef.current) for (let i = 0; i < excludeMaskRef.current.length; i++) if (excludeMaskRef.current[i]) ec++;
    setExcludeVoxCount(ec);
    if (excludeMaskRef.current && excludeLabelmapIdRef.current) await syncExcludeVisualization();
    else if (!excludeMaskRef.current) clearExcludeVisualization();
    await applyData(prev.mask, { skipUndo: true });
    forceRerender((n) => n + 1);
    setStatusMsg(`Undo (${undoStackRef.current.length} left).`);
  }, [applyData, syncExcludeVisualization, clearExcludeVisualization]);

  const runRedo = useCallback(async () => {
    const cur = laStateRef.current; if (!cur) return;
    const next = redoStackRef.current.pop();
    if (!next) { setStatusMsg('Nothing to redo.'); return; }
    undoStackRef.current.push({
      mask: new Uint8Array(cur.data),
      exclude: excludeMaskRef.current ? new Uint8Array(excludeMaskRef.current) : null,
    });
    if (undoStackRef.current.length > UNDO_CAP) undoStackRef.current.shift();
    excludeMaskRef.current = next.exclude ? new Uint8Array(next.exclude) : null;
    let ec = 0; if (excludeMaskRef.current) for (let i = 0; i < excludeMaskRef.current.length; i++) if (excludeMaskRef.current[i]) ec++;
    setExcludeVoxCount(ec);
    if (excludeMaskRef.current && excludeLabelmapIdRef.current) await syncExcludeVisualization();
    else if (!excludeMaskRef.current) clearExcludeVisualization();
    await applyData(next.mask, { skipUndo: true });
    forceRerender((n) => n + 1);
    setStatusMsg(`Redo (${redoStackRef.current.length} left).`);
  }, [applyData, syncExcludeVisualization, clearExcludeVisualization]);

  // Keyboard shortcuts: Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z redo
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); runUndo(); }
      if ((e.key === 'Z' && e.shiftKey) || (e.key === 'y')) { e.preventDefault(); runRedo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runUndo, runRedo]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const saveSession = useCallback(() => {
    const cur = laStateRef.current;
    if (!cur) { setError('No mask to save. Run flood-fill first.'); return; }
    const volume = cornerstone.cache.getVolume(volumeId);
    const spacing = (volume?.imageData?.getSpacing?.() as number[]) || [1, 1, 1];
    const origin = (volume?.imageData?.getOrigin?.() as number[]) || [0, 0, 0];
    const session: LASessionData = {
      version: 1,
      patientName,
      studyDate,
      volumeId,
      dims: [cur.dims.dx, cur.dims.dy, cur.dims.dz],
      spacing: [spacing[0], spacing[1], spacing[2]],
      origin: [origin[0], origin[1], origin[2]],
      minHU, maxHU,
      brushRadiusMm,
      seedWorld: seedWorld ?? null,
      mvPoints: mvPoints.map((p) => [p[0], p[1], p[2]]),
      aortaPoints: aortaPoints.map((p) => [p[0], p[1], p[2]]),
      extraSeeds: extraSeedsRef.current.map((p) => [p[0], p[1], p[2]]),
      voxelVolumeMm3: cur.voxelVolumeMm3,
      volumeCm3,
      voxelCount,
      maskRLE: encodeBinaryRLE(cur.data),
      excludeRLE: excludeMaskRef.current ? encodeBinaryRLE(excludeMaskRef.current) : null,
    };
    const fname = buildSessionFilename(patientName, studyDate, 'LAA');
    downloadSessionJSON(session, fname);
    setStatusMsg(`Saved: ${fname}`);
  }, [patientName, studyDate, volumeId, minHU, maxHU, brushRadiusMm, seedWorld, mvPoints, aortaPoints, volumeCm3, voxelCount]);

  const loadSessionFromFile = useCallback(async (file: File) => {
    setError(null);
    setStatusMsg(null);
    try {
      const data = await readSessionJSON(file);
      const volume = cornerstone.cache.getVolume(volumeId);
      if (!volume?.imageData) { setError('Load a DICOM series first.'); return; }
      const srcDims = volume.imageData.getDimensions();
      if (srcDims[0] !== data.dims[0] || srcDims[1] !== data.dims[1] || srcDims[2] !== data.dims[2]) {
        setError(`Dim mismatch: session ${data.dims.join('x')} vs volume ${srcDims.join('x')}`);
        return;
      }
      setRunning(true);
      const total = data.dims[0] * data.dims[1] * data.dims[2];
      const mask = decodeBinaryRLE(data.maskRLE.firstValue, data.maskRLE.runs, total);
      const exclude = data.excludeRLE
        ? decodeBinaryRLE(data.excludeRLE.firstValue, data.excludeRLE.runs, total)
        : null;

      const preState = captureViewState();
      clearSegmentation();
      excludeMaskRef.current = exclude;
      clearExcludeVisualization();

      const newId = materializeLabelmap(volumeId, mask);
      if (!newId) { setError('Failed to materialize labelmap.'); setRunning(false); return; }
      const imageData = volume.imageData;
      const voxelToWorld = (i: number, j: number, k: number): [number, number, number] => {
        const w = imageData.indexToWorld([i, j, k]);
        return [w[0], w[1], w[2]];
      };
      const sp = imageData.getSpacing();
      const voxelVolumeMm3 = data.voxelVolumeMm3 ?? (sp[0] * sp[1] * sp[2]);
      const seedIJK: [number, number, number] = data.seedWorld
        ? (worldToIJK(volumeId, data.seedWorld) ?? [0, 0, 0])
        : [0, 0, 0];
      laStateRef.current = {
        data: mask,
        originalData: new Uint8Array(mask),
        dims: { dx: data.dims[0], dy: data.dims[1], dz: data.dims[2] },
        voxelToWorld,
        voxelVolumeMm3,
        labelmapVolumeId: newId,
        seedIJK,
      };
      await attachRepresentation(newId, preState);

      setMinHU(data.minHU);
      setMaxHU(data.maxHU);
      setBrushRadiusMm(data.brushRadiusMm ?? 1.5);
      setSeedWorld(data.seedWorld);
      setMvPoints(data.mvPoints.map((p) => [p[0], p[1], p[2]] as [number, number, number]));
      setAortaPoints(data.aortaPoints.map((p) => [p[0], p[1], p[2]] as [number, number, number]));
      extraSeedsRef.current = data.extraSeeds.map((p) => [p[0], p[1], p[2]] as [number, number, number]);
      setExtraSeedCount(extraSeedsRef.current.length);

      let nv = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i]) nv++;
      setVoxelCount(nv);
      setVolumeCm3((nv * voxelVolumeMm3) / 1000);

      if (exclude) {
        let ec = 0;
        for (let i = 0; i < exclude.length; i++) if (exclude[i]) ec++;
        setExcludeVoxCount(ec);
        await syncExcludeVisualization();
      } else {
        setExcludeVoxCount(0);
      }

      undoStackRef.current = [];
      redoStackRef.current = [];
      forceRerender((n) => n + 1);
      setStatusMsg(`Loaded: ${file.name} (${nv.toLocaleString()} voxels)`);
    } catch (err: any) {
      setError(err?.message || 'Failed to load session.');
    } finally {
      setRunning(false);
    }
  }, [volumeId, captureViewState, clearSegmentation, clearExcludeVisualization, attachRepresentation, syncExcludeVisualization]);

  useImperativeHandle(ref, () => ({
    saveSession,
    loadSessionFile: loadSessionFromFile,
    hasMask: () => laStateRef.current !== null && !!laStateRef.current.data && (voxelCount ?? 0) > 0,
  }), [saveSession, loadSessionFromFile, voxelCount]);

  const runReconstruction = useCallback(async () => {
    setError(null);
    setStatusMsg(null);
    if (!seedWorld) {
      setError('Place seed inside LAA pouch first.');
      return;
    }
    const seedIJK = worldToIJK(volumeId, seedWorld);
    if (!seedIJK) {
      setError('Seed coord out of volume bounds.');
      return;
    }

    setRunning(true);
    try {
      // Capture view state BEFORE any Cornerstone side-effects (derived labelmap
      // creation + segmentation add both trigger resetCamera internally).
      const preState = captureViewState();
      clearSegmentation();
      await new Promise((r) => setTimeout(r, 20));

      const extraSeedsIJK: Array<[number, number, number]> = [];
      for (const ew of extraSeedsRef.current) {
        const ijk = worldToIJK(volumeId, ew as any);
        if (ijk) extraSeedsIJK.push(ijk);
      }
      const res = await segmentLeftAtrium(volumeId, {
        minHU, maxHU, seedIJK,
        maxVoxels: LAA_VOXEL_CAP,
        extraSeeds: extraSeedsIJK,
        excludeMask: excludeMaskRef.current,
      });
      if (!res) {
        setError('Segmentation failed: volume unavailable.');
        return;
      }

      laStateRef.current = {
        data: res.data,
        originalData: new Uint8Array(res.data),
        dims: res.dims,
        voxelToWorld: res.voxelToWorld,
        voxelVolumeMm3: res.voxelVolumeMm3,
        labelmapVolumeId: res.labelmapVolumeId,
        seedIJK,
      };

      await attachRepresentation(res.labelmapVolumeId, preState);

      setVoxelCount(res.voxelCount);
      setVolumeCm3(res.volumeCm3);
      setLeaked(res.leaked);
    } catch (err: any) {
      setError(err?.message || 'Reconstruction failed.');
    } finally {
      setRunning(false);
    }
  }, [seedWorld, volumeId, minHU, maxHU, clearSegmentation, attachRepresentation]);

  const runTrimVeins = useCallback(async () => {
    const cur = laStateRef.current;
    if (!cur) return;
    setError(null);
    setStatusMsg(null);
    setRunning(true);
    try {
      await new Promise((r) => setTimeout(r, 20));
      const volume = cornerstone.cache.getVolume(volumeId);
      const spacing = volume?.imageData?.getSpacing?.() || [1, 1, 1];
      const minSpacing = Math.min(spacing[0], spacing[1], spacing[2]);
      const radiusVox = Math.max(1, Math.round(trimRadiusMm / minSpacing));
      // Operate directly on current mask. Auto fill-holes was over-inflating
      // the mask (enclosed bg pockets in vessel tree) and breaking trim.
      // Users can still click "Fill Holes" explicitly when needed.
      const beforeN = countVoxels(cur.data);
      const trimmed = trimThinBranches(cur.data, cur.dims, radiusVox, cur.seedIJK);
      const afterN = countVoxels(trimmed);
      await applyData(trimmed);
      setStatusMsg(`Trim @${trimRadiusMm}mm: ${beforeN.toLocaleString()} → ${afterN.toLocaleString()} voxels. ${afterN === 0 ? 'Seed eroded away — reduce radius.' : ''}`);
      setStatusMsg(`Trimmed at ${trimRadiusMm} mm (${radiusVox} vox/axis, min spacing ${minSpacing.toFixed(2)} mm).`);
    } catch (err: any) {
      setError(err?.message || 'Trim failed.');
    } finally {
      setRunning(false);
    }
  }, [trimRadiusMm, applyData, volumeId]);

  const runMVCut = useCallback(async () => {
    const cur = laStateRef.current;
    if (!cur || mvPoints.length < 3) return;
    setError(null);
    setStatusMsg(null);
    setRunning(true);
    try {
      await new Promise((r) => setTimeout(r, 20));
      // Plane from 3 points
      const [p0, p1, p2] = mvPoints;
      const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
      const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
      const cx = ay * bz - az * by;
      const cy = az * bx - ax * bz;
      const cz = ax * by - ay * bx;
      const triArea2 = cx * cx + cy * cy + cz * cz;
      const triArea = 0.5 * Math.sqrt(triArea2);
      if (triArea < 25) {
        setError(`MV points nearly collinear (tri area ${triArea.toFixed(1)} mm²). Re-pick 3 points spread around the MV annulus (anterior, posterior, lateral) on different slices.`);
        return;
      }
      let nx = cx, ny = cy, nz = cz;
      const len = Math.sqrt(triArea2) || 1;
      nx /= len; ny /= len; nz /= len;
      // Warn (soft) when plane is nearly axial-aligned — typical failure mode
      // when all 3 clicks happen on the same axial slice. Cut degenerates into
      // a horizontal slab split.
      if (Math.abs(nz) > 0.92) {
        setStatusMsg(`⚠ MV plane is near-horizontal (|nZ|=${Math.abs(nz).toFixed(2)}). Likely all points on same axial slice. Click Undo, then re-pick MV points across multiple slices for proper oblique cut.`);
      }
      const origin: [number, number, number] = [
        (p0[0] + p1[0] + p2[0]) / 3,
        (p0[1] + p1[1] + p2[1]) / 3,
        (p0[2] + p1[2] + p2[2]) / 3,
      ];

      // Determine which side contains the seed — keep that side
      const [si, sj, sk] = cur.seedIJK;
      const [sw0, sw1, sw2] = cur.voxelToWorld(si, sj, sk);
      const seedDot = (sw0 - origin[0]) * nx + (sw1 - origin[1]) * ny + (sw2 - origin[2]) * nz;
      // cutAtPlane removes dot > 0 side → flip normal if seed is on that side.
      // Flip toggle inverts which side is kept (for cases where seed is on
      // the wrong side, e.g. LV seed by mistake, or user wants the opposite cut).
      let normal: [number, number, number] = [nx, ny, nz];
      const wantSeedSide = !flipMV;
      if ((seedDot > 0) === wantSeedSide) normal = [-nx, -ny, -nz];

      const cut = cutAtPlane(cur.data, cur.dims, cur.voxelToWorld, origin, normal);
      const beforeN = countVoxels(cur.data);
      const afterCutN = countVoxels(cut);
      const isolated = flipMV
        ? cut
        : componentContaining(cut, cur.dims, si, sj, sk);
      const afterIsoN = countVoxels(isolated);
      if (afterIsoN === 0) {
        setError('Seed not in mask after cut — plane passed through seed side. Re-pick MV points, seed, or toggle Flip.');
        return;
      }
      await applyData(isolated);
      setMvPoints([]);
      setStatusMsg(`MV cut${flipMV ? ' [flipped]' : ''}: ${beforeN.toLocaleString()} → ${afterCutN.toLocaleString()} (cut) → ${afterIsoN.toLocaleString()}.`);
    } catch (err: any) {
      setError(err?.message || 'MV cut failed.');
    } finally {
      setRunning(false);
    }
  }, [mvPoints, applyData, flipMV]);

  const runAortaCut = useCallback(async () => {
    const cur = laStateRef.current;
    if (!cur || aortaPoints.length < 3) return;
    setError(null);
    setStatusMsg(null);
    setRunning(true);
    try {
      await new Promise((r) => setTimeout(r, 20));
      const [p0, p1, p2] = aortaPoints;
      const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
      const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
      const cx = ay * bz - az * by;
      const cy = az * bx - ax * bz;
      const cz = ax * by - ay * bx;
      const triArea2 = cx * cx + cy * cy + cz * cz;
      const triArea = 0.5 * Math.sqrt(triArea2);
      if (triArea < 25) {
        setError(`Aorta points nearly collinear (tri area ${triArea.toFixed(1)} mm²). Re-pick 3 points spread around the root on different slices.`);
        return;
      }
      let nx = cx, ny = cy, nz = cz;
      const len = Math.sqrt(triArea2) || 1;
      nx /= len; ny /= len; nz /= len;
      if (Math.abs(nz) > 0.92) {
        setStatusMsg(`⚠ Aorta plane near-horizontal (|nZ|=${Math.abs(nz).toFixed(2)}). Likely same-slice clicks. Undo + re-pick across slices if cut is wrong.`);
      }
      const origin: [number, number, number] = [
        (p0[0] + p1[0] + p2[0]) / 3,
        (p0[1] + p1[1] + p2[1]) / 3,
        (p0[2] + p1[2] + p2[2]) / 3,
      ];
      const [si, sj, sk] = cur.seedIJK;
      const [sw0, sw1, sw2] = cur.voxelToWorld(si, sj, sk);
      const seedDot = (sw0 - origin[0]) * nx + (sw1 - origin[1]) * ny + (sw2 - origin[2]) * nz;
      let normal: [number, number, number] = [nx, ny, nz];
      const wantSeedSide = !flipAorta;
      if ((seedDot > 0) === wantSeedSide) normal = [-nx, -ny, -nz];
      const cut = cutAtPlane(cur.data, cur.dims, cur.voxelToWorld, origin, normal);
      const beforeN = countVoxels(cur.data);
      const afterCutN = countVoxels(cut);
      const isolated = flipAorta ? cut : componentContaining(cut, cur.dims, si, sj, sk);
      const afterIsoN = countVoxels(isolated);
      if (afterIsoN === 0) {
        setError('Seed removed by aorta cut — plane on seed side. Re-pick points or toggle Flip.');
        return;
      }
      await applyData(isolated);
      setAortaPoints([]);
      setStatusMsg(`Aorta cut${flipAorta ? ' [flipped]' : ''}: ${beforeN.toLocaleString()} → ${afterCutN.toLocaleString()} → ${afterIsoN.toLocaleString()}.`);
    } catch (err: any) {
      setError(err?.message || 'Aorta cut failed.');
    } finally {
      setRunning(false);
    }
  }, [aortaPoints, applyData, flipAorta]);

  const runExportSTL = useCallback(async () => {
    const cur = laStateRef.current;
    if (!cur) return;
    setError(null);
    setStatusMsg(null);
    setRunning(true);
    try {
      setStatusMsg('Running marching cubes…');
      await new Promise((r) => setTimeout(r, 20));
      const mesh = marchingCubesBinary(cur.data, cur.dims, cur.voxelToWorld);
      if (mesh.triangleCount === 0) {
        setError('No surface generated. Is the mask empty?');
        return;
      }
      const blob = meshToBinarySTL(mesh, 'LAA — antidicom');
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      downloadBlob(blob, `left-atrium-${ts}.stl`);
      setStatusMsg(`Exported ${mesh.triangleCount.toLocaleString()} triangles.`);
    } catch (err: any) {
      setError(err?.message || 'STL export failed.');
    } finally {
      setRunning(false);
    }
  }, []);

  const resetSeed = useCallback(() => {
    setSeedWorld(null);
    setSeedHU(null);
    setSeedMode(false);
    setError(null);
  }, []);

  const hasMask = laStateRef.current !== null && voxelCount !== null && voxelCount > 0;

  return (
    <div className="la-panel">
      <div className="la-section">
        <h4>LAA 3D Reconstruction</h4>
        <p className="la-hint">
          Contrast-enhanced CT. Seeded flood-fill → trim PVs → MV plane cut → STL export.
        </p>
      </div>

      <div className="la-section">
        <h4>1. Place Seed</h4>
        <div className="la-preset-row">
          <button
            className={`la-btn ${seedMode ? 'active' : ''}`}
            onClick={() => { setSeedMode((v) => !v); setMvMode(false); setAortaMode(false); setEditMode('off'); setContourMode(false); }}
            disabled={running}
            title="Click mid-chest axial slice inside LAA pouch (small off-shoot lateral to LA, anterior to LSPV). HU target ≈300–400."
          >
            {seedMode ? 'Click MPR…' : seedWorld ? 'Re-place' : 'Place Seed'}
          </button>
          <button
            className={`la-btn ${extraSeedMode ? 'active' : ''}`}
            onClick={() => { setExtraSeedMode((v) => !v); setSeedMode(false); setMvMode(false); setAortaMode(false); setEditMode('off'); setContourMode(false); }}
            disabled={running}
            title="Add extra seeds inside LAA lobes if multi-lobed (chicken-wing, cauliflower)."
          >{extraSeedMode ? 'Click MPR…' : `+ Extra (${extraSeedCount})`}</button>
          {seedWorld && (
            <button className="la-btn la-btn-secondary" onClick={resetSeed} disabled={running}>Clear</button>
          )}
          {extraSeedCount > 0 && (
            <button className="la-btn la-btn-secondary" onClick={() => {
              extraSeedsRef.current = [];
              setExtraSeedCount(0);
              setStatusMsg('Extra seeds cleared.');
            }} disabled={running}>Clr+</button>
          )}
        </div>
        {seedWorld && (
          <div className="la-seed-info" style={{ fontSize: 11, padding: 6 }}>
            <div>
              [{seedWorld.map((v) => v.toFixed(1)).join(', ')}]
              {seedHU !== null && (
                <>
                  {' · HU '}<strong>{Math.round(seedHU)}</strong>
                  {(seedHU < 250 || seedHU > 500) && (
                    <span style={{ color: '#ffb0b0', marginLeft: 4 }}>⚠ outside pool</span>
                  )}
                </>
              )}
              {seedHU === null && <span style={{ color: '#ffc080' }}> · HU n/a (streaming)</span>}
            </div>
          </div>
        )}
      </div>

      <div className="la-section">
        <h4>2. HU Threshold (blood pool)</h4>
        <div className="la-range-inputs">
          <label>
            Min HU
            <input type="number" value={minHU}
              onChange={(e) => setMinHU(Number(e.target.value))} disabled={running} />
          </label>
          <label>
            Max HU
            <input type="number" value={maxHU}
              onChange={(e) => setMaxHU(Number(e.target.value))} disabled={running} />
          </label>
        </div>
        <div className="la-range-slider">
          <input type="range" min={-200} max={1500} value={minHU}
            onChange={(e) => setMinHU(Number(e.target.value))} disabled={running} />
          <input type="range" min={-200} max={1500} value={maxHU}
            onChange={(e) => setMaxHU(Number(e.target.value))} disabled={running} />
        </div>
        <div className="la-preset-row">
          <button className="la-btn la-btn-secondary"
            onClick={() => { setMinHU(DEFAULT_MIN_HU); setMaxHU(DEFAULT_MAX_HU); }}
            disabled={running}>Reset defaults</button>
          <button className="la-btn la-btn-secondary"
            onClick={() => { setMinHU(220); setMaxHU(500); }} disabled={running}>Loose</button>
          <button className="la-btn la-btn-secondary"
            onClick={() => { setMinHU(320); setMaxHU(420); }} disabled={running}>Tight</button>
        </div>
      </div>

      <div className="la-section">
        <h4>3. Reconstruct</h4>
        <button
          className="la-btn la-btn-primary"
          onClick={runReconstruction}
          disabled={running || !seedWorld}
        >
          {running ? 'Working…' : 'Run Flood-Fill'}
        </button>
        {hasMask && (
          <button className="la-btn la-btn-secondary" onClick={clearSegmentation} disabled={running}>
            Clear Mask
          </button>
        )}
      </div>


      <LA3DInlineView
        hasMask={hasMask}
        data={laStateRef.current?.data ?? null}
        dims={laStateRef.current?.dims ?? null}
        voxelToWorld={laStateRef.current?.voxelToWorld ?? null}
        refreshKey={meshTick}
        visible={meshVisible}
        onShow={() => { setMeshVisible(true); setMeshTick((t) => t + 1); }}
        onClose={() => setMeshVisible(false)}
        onRebuild={() => setMeshTick((t) => t + 1)}
        meshColor={meshColor}
        setMeshColor={setMeshColor}
        meshBg={meshBg}
        setMeshBg={setMeshBg}
        meshAlpha={meshAlpha}
        setMeshAlpha={setMeshAlpha}
      />

      {hasMask && (
        <>
          <div className="la-section">
            <h4>4. Clean-up (keep LAA pouch)</h4>
            <p className="la-hint">
              <strong>Goal:</strong> keep LAA pouch only. Remove LA body through ostium cut (step 5). Erase brush for stray LA or neighbouring vessels.
            </p>
            <div className="la-preset-row">
              <button className="la-btn la-btn-secondary" onClick={async () => {
                const cur = laStateRef.current; if (!cur) return;
                setRunning(true);
                try {
                  const [si, sj, sk] = cur.seedIJK;
                  const stride = cur.dims.dx * cur.dims.dy;
                  const seedIdx = sk * stride + sj * cur.dims.dx + si;
                  if (!cur.data[seedIdx]) {
                    setError('Seed voxel out of mask (erased). Reset Mask or re-seed.');
                    return;
                  }
                  const before = countVoxels(cur.data);
                  const iso = componentContaining(cur.data, cur.dims, si, sj, sk);
                  const after = countVoxels(iso);
                  if (before === after) {
                    setStatusMsg('Mask already one blob. No fragments to drop. LA+aorta+LV stay connected — use MV Cut + Aorta Cut to separate.');
                  } else {
                    await applyData(iso);
                    setStatusMsg(`Dropped fragments: ${before.toLocaleString()} → ${after.toLocaleString()} (−${(before - after).toLocaleString()}).`);
                  }
                } finally { setRunning(false); }
              }} disabled={running} title="Keep only the connected component that contains the seed. Run AFTER Shrink 1 vox if fragments stay attached via a thin bridge.">
                <span style={{ display: 'block' }}>Drop Fragments</span>
                <span className="la-btn-sub">keep largest blob (LAA pouch)</span>
              </button>
              <button className="la-btn la-btn-secondary" onClick={async () => {
                const cur = laStateRef.current; if (!cur) return;
                setRunning(true);
                try {
                  const filled = fillHoles3D(cur.data, cur.dims);
                  await applyData(filled);
                  setStatusMsg('Filled internal holes.');
                } finally { setRunning(false); }
              }} disabled={running}>
                <span style={{ display: 'block' }}>Fill Holes</span>
                <span className="la-btn-sub">close internal gaps</span>
              </button>
              <button className="la-btn la-btn-secondary" onClick={async () => {
                const cur = laStateRef.current; if (!cur) return;
                setRunning(true);
                try {
                  const before = countVoxels(cur.data);
                  const refined = refineByHURange(volumeId, cur.data, minHU, maxHU);
                  const after = countVoxels(refined);
                  await applyData(refined);
                  setStatusMsg(`Snap to HU [${minHU}, ${maxHU}]: ${before.toLocaleString()} → ${after.toLocaleString()} voxels.`);
                } finally { setRunning(false); }
              }} disabled={running}>
                <span style={{ display: 'block' }}>Snap to HU</span>
                <span className="la-btn-sub">drop out-of-range voxels</span>
              </button>
              <button className="la-btn la-btn-secondary" onClick={async () => {
                const cur = laStateRef.current; if (!cur) return;
                setRunning(true);
                try {
                  await applyData(new Uint8Array(cur.originalData));
                  setStatusMsg('Reset to flood-fill mask.');
                } finally { setRunning(false); }
              }} disabled={running}>
                <span style={{ display: 'block' }}>Reset Mask</span>
                <span className="la-btn-sub">back to flood-fill</span>
              </button>
            </div>
            <div className="la-preset-row" style={{ marginTop: 8 }}>
              <button className="la-btn la-btn-secondary" onClick={async () => {
                const cur = laStateRef.current; if (!cur) return;
                setRunning(true);
                try {
                  const bbox = boundingBox(cur.data, cur.dims);
                  if (!bbox) return;
                  const { sub, subDims, origin } = cropWithPad(cur.data, cur.dims, bbox, 3);
                  const shrunk = erodeBall(sub, subDims, 1);
                  const out = new Uint8Array(cur.data.length);
                  pasteSubvolume(out, cur.dims, shrunk, subDims, origin);
                  const before = countVoxels(cur.data);
                  const after = countVoxels(out);
                  await applyData(out);
                  setStatusMsg(`Shrink 1 vox: ${before.toLocaleString()} → ${after.toLocaleString()}.`);
                } finally { setRunning(false); }
              }} disabled={running} title="Morphological erosion (ball r=1). Breaks thin bridges between LA and neighbouring structures. Follow with Drop Fragments, then Grow 1 vox.">
                <span style={{ display: 'block' }}>Shrink 1 vox</span>
                <span className="la-btn-sub">break thin bridges</span>
              </button>
              <button className="la-btn la-btn-secondary" onClick={async () => {
                const cur = laStateRef.current; if (!cur) return;
                setRunning(true);
                try {
                  const bbox = boundingBox(cur.data, cur.dims);
                  if (!bbox) return;
                  const { sub, subDims, origin } = cropWithPad(cur.data, cur.dims, bbox, 3);
                  const grown = dilateBall(sub, subDims, 1);
                  const out = new Uint8Array(cur.data.length);
                  pasteSubvolume(out, cur.dims, grown, subDims, origin);
                  const before = countVoxels(cur.data);
                  const after = countVoxels(out);
                  await applyData(out);
                  setStatusMsg(`Grow 1 vox: ${before.toLocaleString()} → ${after.toLocaleString()}.`);
                } finally { setRunning(false); }
              }} disabled={running} title="Morphological dilation (ball r=1). Restore size lost during Shrink. Apply 1–2× after Drop Fragments.">
                <span style={{ display: 'block' }}>Grow 1 vox</span>
                <span className="la-btn-sub">restore size ×1–2 after Drop</span>
              </button>
            </div>
          </div>

          <div className="la-section">
            <h4>4b. Manual Edit (Brush)</h4>
            <p className="la-hint">
              <strong>Sculpt</strong>: inside mask = remove, outside = add (Siemens-style).
              <strong> Paint/Erase</strong>: fixed-mode. <strong>Exclude stroke</strong>: mark voxels flood-fill must avoid.
            </p>
            <div className="la-preset-row">
              <button
                className={`la-btn ${editMode === 'sculpt' ? 'active' : ''}`}
                onClick={() => { setEditMode((m) => (m === 'sculpt' ? 'off' : 'sculpt')); setSeedMode(false); setMvMode(false); setAortaMode(false); setContourMode(false); setExtraSeedMode(false); }}
                disabled={running}
                title="Click inside mask → erase, outside mask → add (Siemens-style). For removing disconnected fragments use Erase instead (Sculpt on outside voxels would ADD them back)."
              >
                <span style={{ display: 'block' }}>Sculpt</span>
                <span className="la-btn-sub">in=remove, out=add (wrong for outside frags)</span>
              </button>
              <button
                className={`la-btn ${editMode === 'paint' ? 'active' : ''}`}
                onClick={() => { setEditMode((m) => (m === 'paint' ? 'off' : 'paint')); setSeedMode(false); setMvMode(false); setContourMode(false); setExtraSeedMode(false); }}
                disabled={running}
                title="Fixed add brush: drag to add voxels to the mask."
              >
                <span style={{ display: 'block' }}>Paint</span>
                <span className="la-btn-sub">fixed add brush</span>
              </button>
              <button
                className={`la-btn ${editMode === 'erase' ? 'active' : ''}`}
                onClick={() => { setEditMode((m) => (m === 'erase' ? 'off' : 'erase')); setSeedMode(false); setMvMode(false); setContourMode(false); setExtraSeedMode(false); }}
                disabled={running}
                title="Fixed remove-only brush. Best tool for scrubbing stray fragments when Shrink+Drop+Grow leaves leftovers."
              >
                <span style={{ display: 'block' }}>Erase</span>
                <span className="la-btn-sub">fixed remove — use on outside frags</span>
              </button>
              <button
                className={`la-btn ${editMode === 'exclude' ? 'active' : ''}`}
                onClick={() => { setEditMode((m) => (m === 'exclude' ? 'off' : 'exclude')); setSeedMode(false); setMvMode(false); setContourMode(false); setExtraSeedMode(false); }}
                disabled={running}
                title="Paint regions flood-fill must never enter (Siemens − stroke)"
              >
                <span style={{ display: 'block' }}>Exclude (−)</span>
                <span className="la-btn-sub">mark bridge, then Drop Fragments again</span>
              </button>
              <button
                className="la-btn la-btn-secondary"
                onClick={() => setEditMode('off')}
                disabled={running || editMode === 'off'}
              >Stop</button>
            </div>
            <div className="la-range-inputs">
              <label>
                Brush Ø (mm)
                <input type="number" min={0.5} max={30} step={0.5} value={brushRadiusMm}
                  onChange={(e) => setBrushRadiusMm(Math.max(0.5, Math.min(30, Number(e.target.value))))}
                  disabled={running} />
              </label>
            </div>
            <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
              {[2, 5, 8, 10, 15].map((v) => (
                <button
                  key={v}
                  className={`la-btn ${brushRadiusMm === v ? 'active' : ''}`}
                  style={{ padding: '3px 8px', fontSize: 11, flex: 1 }}
                  onClick={() => setBrushRadiusMm(v)}
                  disabled={running}
                  title={`Set brush Ø to ${v} mm`}
                >{v}</button>
              ))}
            </div>
            {excludeVoxCount > 0 && (
              <div className="la-seed-info">
                <div>Exclude mask: <strong>{excludeVoxCount.toLocaleString()}</strong> voxels</div>
                <button className="la-btn la-btn-secondary" onClick={() => {
                  excludeMaskRef.current = null;
                  setExcludeVoxCount(0);
                  clearExcludeVisualization();
                  setStatusMsg('Exclude mask cleared.');
                }} disabled={running}>Clear Exclude</button>
              </div>
            )}
          </div>

          <div className="la-section">
            <h4>4d. Undo / Redo</h4>
            <p className="la-hint">
              Mask history stack (up to {UNDO_CAP} steps). Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z redo. Stroke ends = 1 undo step.
            </p>
            <div className="la-preset-row">
              <button className="la-btn la-btn-secondary" onClick={runUndo}
                disabled={running || undoStackRef.current.length === 0}>
                Undo ({undoStackRef.current.length})
              </button>
              <button className="la-btn la-btn-secondary" onClick={runRedo}
                disabled={running || redoStackRef.current.length === 0}>
                Redo ({redoStackRef.current.length})
              </button>
            </div>
          </div>

          <div className="la-section">
            <h4>4c. Contour Drag Edit</h4>
            <p className="la-hint">
              Red dots = current mask rim on this slice. Drag a dot toward the true border — paints sphere at target, erases at source. Scroll MPRs to see dots for other slices.
            </p>
            <div className="la-preset-row">
              <button
                className={`la-btn ${contourMode ? 'active' : ''}`}
                onClick={() => {
                  setContourMode((v) => !v);
                  setSeedMode(false); setMvMode(false); setEditMode('off');
                }}
                disabled={running}
              >{contourMode ? 'Exit Contour Edit' : 'Enter Contour Edit'}</button>
            </div>
            <div className="la-range-inputs">
              <label>
                Drag radius (mm)
                <input type="number" min={0.5} max={10} step={0.5} value={contourRadiusMm}
                  onChange={(e) => setContourRadiusMm(Math.max(0.5, Math.min(10, Number(e.target.value))))}
                  disabled={running} />
              </label>
              <label>
                Handles
                <input type="number" min={6} max={48} step={1} value={handleCount}
                  onChange={(e) => setHandleCount(Math.max(6, Math.min(48, Number(e.target.value))))}
                  disabled={running} />
              </label>
            </div>
          </div>

          <div className="la-section">
            <h4>5. Ostium Cut (LAA neck)</h4>
            <p className="la-hint">
              Click 3 points on the LAA ostium (narrow neck where LAA meets LA). Plane removes LA side; LAA pouch preserved (seed-anchored).
            </p>
            <p className="la-hint" style={{ color: '#ffcc66' }}>
              <strong>Pick across 3 different slices</strong> (not all on the same axial). Clicking all 3 on one axial slice makes plane nearly horizontal → wrong cut.<br />
              Recommended: 1 point on axial (anterior MV), then scroll/switch to sagittal for lateral, coronal for posterior. Blue preview line should look <em>oblique on all 3 MPRs</em> — never perfectly flat.<br />
              Wrong half removed? → toggle <strong>Flip</strong>, re-apply.<br />
              Plane guard: area &lt; 25 mm² = collinear (blocked); |nZ| &gt; 0.92 = warning (near-horizontal, re-pick advised).
            </p>
            <button
              className={`la-btn ${mvMode ? 'active' : ''}`}
              onClick={() => { setMvMode((v) => !v); setSeedMode(false); setAortaMode(false); setEditMode('off'); setContourMode(false); if (!mvMode) setMvPoints([]); }}
              disabled={running}
            >
              {mvMode
                ? `Click point ${mvPoints.length + 1}/3 on LAA ostium…`
                : mvPoints.length >= 3
                  ? 'Re-pick MV Points'
                  : 'Define MV Plane (3 points)'}
            </button>
            {mvPoints.length > 0 && (
              <div className="la-seed-info">
                {mvPoints.map((p, idx) => (
                  <div key={idx}>P{idx + 1}: [{p.map((v) => v.toFixed(1)).join(', ')}]</div>
                ))}
                {mvPoints.length < 3 && <div className="la-hint">Need {3 - mvPoints.length} more.</div>}
              </div>
            )}
            <div className="la-preset-row">
              <button
                className="la-btn la-btn-primary"
                onClick={runMVCut}
                disabled={running || mvPoints.length < 3}
              >
                Apply MV Cut
              </button>
              <button
                className={`la-btn ${flipMV ? 'active' : ''}`}
                onClick={() => setFlipMV((v) => !v)}
                disabled={running}
                title="Invert which side is kept. Use if wrong half was removed."
              >
                Flip {flipMV ? '(on)' : ''}
              </button>
            </div>
          </div>

          <div className="la-section">
            <h4>5b. Extra Cut (optional)</h4>
            <p className="la-hint">
              Optional second plane cut to trim neighbouring vessel / LA bleed after ostium cut.
            </p>
            <p className="la-hint" style={{ color: '#ffcc66' }}>
              <strong>Pick across 3 different slices</strong> (same rule as MV). All 3 on one axial → nearly horizontal plane → wrong cut.<br />
              Aortic root runs superior-anterior to LA. Good picks: anterior root wall on high axial, posterior root wall on lower slice, lateral on sagittal/coronal.<br />
              Purple preview line must look <em>oblique on all 3 MPRs</em>. Wrong half kept? → <strong>Flip</strong> + re-apply.<br />
              Guard: area &lt; 25 mm² blocks, |nZ| &gt; 0.92 warns.
            </p>
            <button
              className={`la-btn ${aortaMode ? 'active' : ''}`}
              onClick={() => { setAortaMode((v) => !v); setSeedMode(false); setMvMode(false); setEditMode('off'); setContourMode(false); if (!aortaMode) setAortaPoints([]); }}
              disabled={running}
            >
              {aortaMode
                ? `Click point ${aortaPoints.length + 1}/3 on extra cut line…`
                : aortaPoints.length >= 3
                  ? 'Re-pick Extra Points'
                  : 'Define Aorta Plane (3 points)'}
            </button>
            {aortaPoints.length > 0 && (
              <div className="la-seed-info">
                {aortaPoints.map((p, idx) => (
                  <div key={idx}>P{idx + 1}: [{p.map((v) => v.toFixed(1)).join(', ')}]</div>
                ))}
                {aortaPoints.length < 3 && <div className="la-hint">Need {3 - aortaPoints.length} more.</div>}
              </div>
            )}
            <div className="la-preset-row">
              <button
                className="la-btn la-btn-primary"
                onClick={runAortaCut}
                disabled={running || aortaPoints.length < 3}
              >
                Apply Aorta Cut
              </button>
              <button
                className={`la-btn ${flipAorta ? 'active' : ''}`}
                onClick={() => setFlipAorta((v) => !v)}
                disabled={running}
                title="Invert which side is kept."
              >
                Flip {flipAorta ? '(on)' : ''}
              </button>
            </div>
          </div>

          <div className="la-section">
            <h4>6. Export</h4>
            <button className="la-btn la-btn-primary" onClick={runExportSTL} disabled={running}>
              Export STL (binary)
            </button>
          </div>
        </>
      )}

      {error && <div className="la-error">{error}</div>}
      {statusMsg && <div className="la-status">{statusMsg}</div>}

      {voxelCount !== null && (
        <div className="la-section la-results">
          <h4>Current Mask</h4>
          <div className="la-result-row">
            <span>Voxels</span>
            <span>{voxelCount.toLocaleString()}</span>
          </div>
          {volumeCm3 !== null && (
            <div className="la-result-row">
              <span>Volume</span>
              <span>{volumeCm3.toFixed(2)} cm³</span>
            </div>
          )}
          {leaked && (
            <div className="la-warn">
              Hit voxel cap — region may have leaked. Tighten upper HU, re-seed, or Trim Veins.
            </div>
          )}
        </div>
      )}

    </div>
  );
});
