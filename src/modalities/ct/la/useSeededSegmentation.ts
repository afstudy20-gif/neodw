import { useCallback, useRef, useState } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import { segmentLeftAtrium, worldToIJK } from './leftAtriumSegmentation';

/**
 * Shared seeded blood-pool segmentation hook.
 *
 * Encapsulates the proven seed → region-grow → labelmap-overlay flow used by the
 * Aorta / Vascular planning panels: it preserves the MPR cameras + crosshair
 * across Cornerstone's internal resetCamera side-effects, runs the seeded
 * flood-fill (`segmentLeftAtrium`), and attaches the result as a labelmap
 * representation on the requested viewports. Panel-specific features (sculpt,
 * exclude masks, undo, mesh/STL, session IO) stay in the panels and build on
 * top of `maskRef` / `clear`.
 */

export interface SeededMaskState {
  data: Uint8Array;
  dims: { dx: number; dy: number; dz: number };
  voxelToWorld: (i: number, j: number, k: number) => [number, number, number];
  voxelVolumeMm3: number;
  labelmapVolumeId: string;
  seedIJK: [number, number, number];
  /** Result metrics — also mirrored to hook state, included here so callers can
   *  read fresh values synchronously right after the await (state lags a render). */
  voxelCount: number;
  volumeCm3: number;
  leaked: boolean;
}

export interface RunFromSeedParams {
  minHU: number;
  maxHU: number;
  extraSeeds?: number[][];
  excludeMask?: Uint8Array | null;
}

export interface SeededSegmentationOptions {
  renderingEngineId: string;
  volumeId: string;
  /** Unique Cornerstone segmentation id, e.g. 'vascularSegmentation'. */
  segmentationId: string;
  /** Labelmap overlay colour (RGBA 0–255). Defaults to translucent red. */
  color?: [number, number, number, number];
  /** Region-grow voxel cap (leak guard). */
  maxVoxels?: number;
  /** MPR viewports the overlay renders on. */
  mprViewportIds?: string[];
  /** All viewports to clear representations from (MPR + 3D). */
  allViewportIds?: string[];
}

const DEFAULT_MPR = ['axial', 'sagittal', 'coronal'];
const DEFAULT_ALL = ['axial', 'sagittal', 'coronal', 'volume3d'];

export interface SeededSegmentationApi {
  running: boolean;
  error: string | null;
  voxelCount: number | null;
  volumeCm3: number | null;
  leaked: boolean;
  /** Current mask state, or null when nothing is segmented. */
  maskRef: React.MutableRefObject<SeededMaskState | null>;
  hasMask: () => boolean;
  runFromSeed: (seedWorld: number[], params: RunFromSeedParams) => Promise<SeededMaskState | null>;
  clear: () => void;
}

export function useSeededSegmentation(options: SeededSegmentationOptions): SeededSegmentationApi {
  const {
    renderingEngineId,
    volumeId,
    segmentationId,
    color = [220, 60, 60, 160],
    maxVoxels = 1_200_000,
    mprViewportIds = DEFAULT_MPR,
    allViewportIds = DEFAULT_ALL,
  } = options;

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voxelCount, setVoxelCount] = useState<number | null>(null);
  const [volumeCm3, setVolumeCm3] = useState<number | null>(null);
  const [leaked, setLeaked] = useState(false);
  const maskRef = useRef<SeededMaskState | null>(null);

  const clear = useCallback(() => {
    const { segmentation } = cornerstoneTools;
    for (const vpId of allViewportIds) {
      try {
        segmentation.removeSegmentationRepresentations(vpId, { segmentationId });
      } catch { /* ignore */ }
    }
    try { segmentation.removeSegmentation(segmentationId); } catch { /* ignore */ }
    if (maskRef.current?.labelmapVolumeId) {
      try { cornerstone.cache.removeVolumeLoadObject(maskRef.current.labelmapVolumeId); } catch { /* ignore */ }
    }
    maskRef.current = null;
    setVoxelCount(null);
    setVolumeCm3(null);
    setLeaked(false);
    cornerstone.getRenderingEngine(renderingEngineId)?.renderViewports(allViewportIds);
  }, [allViewportIds, renderingEngineId, segmentationId]);

  // Capture MPR cameras + crosshair toolCenter so we can restore after the
  // segmentation add (which triggers Cornerstone's async resetCamera).
  const captureViewState = useCallback(() => {
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    const cams: Record<string, cornerstone.Types.ICamera> = {};
    if (engine) {
      for (const vpId of mprViewportIds) {
        const vp = engine.getViewport(vpId);
        if (vp) cams[vpId] = vp.getCamera();
      }
    }
    const toolGroup = cornerstoneTools.ToolGroupManager.getToolGroup('mprToolGroup');
    const csToolName = (cornerstoneTools as { CrosshairsTool?: { toolName?: string } }).CrosshairsTool?.toolName || 'Crosshairs';
    const csTool = toolGroup?.getToolInstance(csToolName) as { toolCenter?: number[] } | undefined;
    const toolCenter = csTool?.toolCenter && csTool.toolCenter.length === 3 ? [...csTool.toolCenter] : null;
    return { engine, cams, csTool, csToolName, toolCenter };
  }, [mprViewportIds, renderingEngineId]);

  const restoreViewState = useCallback((state: ReturnType<typeof captureViewState>) => {
    const { engine, cams, csTool, csToolName, toolCenter } = state;
    if (!engine) return;
    for (const vpId of mprViewportIds) {
      const vp = engine.getViewport(vpId);
      if (vp && cams[vpId]) vp.setCamera(cams[vpId]);
    }
    if (csTool && toolCenter) {
      csTool.toolCenter = [...toolCenter];
      for (const vpId of mprViewportIds) {
        const vp = engine.getViewport(vpId);
        if (!vp?.element) continue;
        try {
          const anns = cornerstoneTools.annotation.state.getAnnotations(csToolName, vp.element);
          if (anns) for (const a of anns) {
            if (a.data?.handles) (a.data.handles as { toolCenter?: number[] }).toolCenter = [...toolCenter];
          }
        } catch { /* ignore */ }
      }
    }
    engine.renderViewports(mprViewportIds);
  }, [mprViewportIds]);

  const attachRepresentation = useCallback(async (
    labelmapVolumeId: string,
    preCapture?: ReturnType<typeof captureViewState>,
  ) => {
    const { segmentation, Enums: ToolsEnums } = cornerstoneTools;
    const state = preCapture ?? captureViewState();

    try { segmentation.removeSegmentation(segmentationId); } catch { /* ignore */ }
    segmentation.addSegmentations([
      {
        segmentationId,
        representation: {
          type: ToolsEnums.SegmentationRepresentations.Labelmap,
          data: { volumeId: labelmapVolumeId },
        },
      },
    ]);
    for (const vpId of mprViewportIds) {
      await segmentation.addLabelmapRepresentationToViewport(vpId, [
        {
          segmentationId,
          config: { colorLUTOrIndex: [[0, 0, 0, 0], color] as [number, number, number, number][] },
        },
      ]);
    }

    // Multi-tick restore to beat any async resetCamera triggered by seg add.
    restoreViewState(state);
    requestAnimationFrame(() => {
      restoreViewState(state);
      requestAnimationFrame(() => restoreViewState(state));
    });
    setTimeout(() => restoreViewState(state), 100);
    setTimeout(() => restoreViewState(state), 300);
  }, [captureViewState, color, mprViewportIds, restoreViewState, segmentationId]);

  const runFromSeed = useCallback(async (
    seedWorld: number[],
    params: RunFromSeedParams,
  ): Promise<SeededMaskState | null> => {
    setError(null);
    const seedIJK = worldToIJK(volumeId, seedWorld);
    if (!seedIJK) {
      setError('Seed coordinate is out of the volume bounds.');
      return null;
    }
    setRunning(true);
    try {
      // Snapshot the view BEFORE any Cornerstone side-effects.
      const preState = captureViewState();
      clear();
      await new Promise((r) => setTimeout(r, 20));

      const extraSeedsIJK: Array<[number, number, number]> = [];
      for (const ew of params.extraSeeds ?? []) {
        const ijk = worldToIJK(volumeId, ew);
        if (ijk) extraSeedsIJK.push(ijk);
      }

      const res = await segmentLeftAtrium(volumeId, {
        minHU: params.minHU,
        maxHU: params.maxHU,
        seedIJK,
        maxVoxels,
        extraSeeds: extraSeedsIJK,
        excludeMask: params.excludeMask ?? null,
      });
      if (!res) {
        setError('Segmentation failed: volume unavailable.');
        return null;
      }

      const mask: SeededMaskState = {
        data: res.data,
        dims: res.dims,
        voxelToWorld: res.voxelToWorld,
        voxelVolumeMm3: res.voxelVolumeMm3,
        labelmapVolumeId: res.labelmapVolumeId,
        seedIJK,
        voxelCount: res.voxelCount,
        volumeCm3: res.volumeCm3,
        leaked: res.leaked,
      };
      maskRef.current = mask;
      await attachRepresentation(res.labelmapVolumeId, preState);
      setVoxelCount(res.voxelCount);
      setVolumeCm3(res.volumeCm3);
      setLeaked(res.leaked);
      return mask;
    } finally {
      setRunning(false);
    }
  }, [attachRepresentation, captureViewState, clear, maxVoxels, volumeId]);

  const hasMask = useCallback(() => maskRef.current !== null && (voxelCount ?? 0) > 0, [voxelCount]);

  return { running, error, voxelCount, volumeCm3, leaked, maskRef, hasMask, runFromSeed, clear };
}
