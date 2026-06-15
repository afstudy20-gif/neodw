import { useState, useEffect, useCallback, useRef } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import {
  addScaled,
  buildViewRay,
  collectPolygonRaySamples,
  marchRangeAlongRay,
  shouldEraseVoxel,
  eraseValueForScalarType,
} from './scalpelRayMarch';

type ScalpelMode = 'off' | 'draw' | 'erase-rect';
type RenderMode =
  | 'volume'
  | 'mip'
  | 'soft-tissue'
  | 'bone'
  | 'cardiac'
  | 'cardiac3'
  | 'coronary'
  | 'coronary3';

type ScalpelBackupArray =
  | Float64Array
  | Float32Array
  | Int32Array
  | Int16Array
  | Int8Array
  | Uint32Array
  | Uint16Array
  | Uint8Array
  | Uint8ClampedArray;

const PRESETS: { key: RenderMode; label: string; preset: string; description: string }[] = [
  { key: 'volume', label: 'Volume', preset: 'CT-Chest-Contrast-Enhanced', description: 'Standard contrast-enhanced volume rendering' },
  { key: 'cardiac3', label: 'Cardiac VRT', preset: 'CT-Cardiac3', description: 'Cinematic heart VRT — multi-color myocardium + calcium' },
  { key: 'coronary3', label: 'Coronary VRT', preset: 'CT-Coronary-Arteries-3', description: 'Coronary arteries with vessel/myocardium contrast' },
  { key: 'cardiac', label: 'Cardiac', preset: 'CT-Cardiac', description: 'Cardiac optimized — bone removed' },
  { key: 'coronary', label: 'Coronary', preset: 'CT-Coronary-Arteries-2', description: 'Coronary arteries (alt preset)' },
  { key: 'mip', label: 'MIP', preset: 'CT-MIP', description: 'Maximum Intensity Projection' },
  { key: 'soft-tissue', label: 'Soft Tissue', preset: 'CT-Soft-Tissue', description: 'Soft tissue only — bone removed' },
  { key: 'bone', label: 'Bone', preset: 'CT-Bone', description: 'Bone structures only' },
];

// Cinematic-like shading presets (ambient, diffuse, specular, specularPower)
const SHADING_PRESETS = {
  standard: { ambient: 0.1, diffuse: 0.9, specular: 0.2, specularPower: 10, label: 'Standard' },
  cinematic: { ambient: 0.05, diffuse: 0.7, specular: 0.65, specularPower: 64, label: 'Cinematic' },
  dramatic: { ambient: 0.02, diffuse: 0.6, specular: 0.8, specularPower: 100, label: 'Dramatic' },
  soft: { ambient: 0.3, diffuse: 0.8, specular: 0.1, specularPower: 5, label: 'Soft' },
};

type ShadingPreset = keyof typeof SHADING_PRESETS;

interface Props {
  renderingEngineId: string;
  volumeId: string;
}

// Tissue density layers — each can be toggled on/off
// Original CT-Chest-Contrast-Enhanced opacity reference:
//   HU -3024→0, 67→0, 251→0.45, 439→0.625, 3071→0.616
interface TissueLayer {
  key: string;
  label: string;
  // Each layer defines opacity control points: [HU, opacity] pairs
  // When hidden, all opacities become 0
  points: [number, number][];
  color: string;
}

const TISSUE_LAYERS: TissueLayer[] = [
  {
    key: 'air',
    label: 'Lung',
    points: [[-1024, 0.0], [-900, 0.02], [-600, 0.04], [-500, 0.0]],
    color: '#4a90d9',
  },
  {
    key: 'fat',
    label: 'Fat',
    points: [[-500, 0.0], [-200, 0.02], [-100, 0.04]],
    color: '#d4a574',
  },
  {
    key: 'soft',
    label: 'Soft Tissue',
    points: [[-100, 0.0], [0, 0.05], [60, 0.0]],
    color: '#e8967a',
  },
  {
    key: 'blood',
    label: 'Contrast',
    // Contrast-enhanced blood: peaks at ~200-350 HU, drops off before bone starts
    points: [[60, 0.0], [150, 0.30], [250, 0.55], [350, 0.65], [450, 0.50], [500, 0.0]],
    color: '#ff4444',
  },
  {
    key: 'bone',
    label: 'Bone',
    // Bone starts at ~500 HU — no overlap with contrast layer
    points: [[500, 0.0], [600, 0.55], [800, 0.65], [1200, 0.65], [3071, 0.62]],
    color: '#e8e8d0',
  },
];

export function RenderModeSelector({ renderingEngineId, volumeId }: Props) {
  const [mode, setMode] = useState<RenderMode>('cardiac3');
  const [shadingPreset, setShadingPreset] = useState<ShadingPreset>('cinematic');
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    (window as any).cornerstone = cornerstone;
    (window as any).cornerstoneTools = cornerstoneTools;
  }, []);

  // Tissue visibility toggles
  const [tissueVisibility, setTissueVisibility] = useState<Record<string, boolean>>({
    air: false,
    fat: false,
    soft: true,
    blood: true,
    bone: true,
  });
  const presetCounterRef = useRef(0); // Force unique preset names to bypass cache

  // Advanced shading sliders
  // Defaults match the 'cinematic' shading preset for crisper, more
  // VRT-like output (closer to Horos look) than the flat 'standard' values.
  const [ambient, setAmbient] = useState(0.05);
  const [diffuse, setDiffuse] = useState(0.7);
  const [specular, setSpecular] = useState(0.65);
  const [specularPower, setSpecularPower] = useState(64);
  const [sampleQuality, setSampleQuality] = useState(1.0);

  const getViewport3d = () => {
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    return engine?.getViewport('volume3d') as cornerstone.Types.IVolumeViewport | undefined;
  };

  // Apply VTK.js shading properties directly on the volume actor
  const applyShading = useCallback((amb: number, diff: number, spec: number, specPow: number) => {
    const viewport = getViewport3d();
    if (!viewport) return;
    try {
      const actor = viewport.getDefaultActor()?.actor;
      if (!actor) return;
      const property = (actor as any).getProperty?.();
      if (!property) return;
      property.setShade(true);
      property.setAmbient(amb);
      property.setDiffuse(diff);
      property.setSpecular(spec);
      property.setSpecularPower(specPow);
      viewport.render();
    } catch (e) {
      console.warn('[RenderMode] Could not apply shading:', e);
    }
  }, []);

  const setRenderMode = (newMode: RenderMode) => {
    const viewport = getViewport3d();
    if (!viewport) return;

    const presetInfo = PRESETS.find(p => p.key === newMode);
    if (presetInfo) {
      viewport.setProperties({ preset: presetInfo.preset });
    }

    viewport.render();
    setMode(newMode);

    // Re-apply current shading after preset change
    setTimeout(() => {
      applyShading(ambient, diffuse, specular, specularPower);
      // Re-apply tissue visibility ONLY if HU crop is not active
      if (!huCropEnabled) {
        const hasHidden = Object.values(tissueVisibility).some(v => !v) ||
                          !tissueVisibility['air'] || !tissueVisibility['fat'];
        if (hasHidden && newMode !== 'mip') {
          applyTissueVisibility(tissueVisibility);
        }
      }
    }, 50);
  };

  const applyShadingPreset = (preset: ShadingPreset) => {
    const s = SHADING_PRESETS[preset];
    setShadingPreset(preset);
    setAmbient(s.ambient);
    setDiffuse(s.diffuse);
    setSpecular(s.specular);
    setSpecularPower(s.specularPower);
    applyShading(s.ambient, s.diffuse, s.specular, s.specularPower);
  };

  const handleShadingSlider = (param: 'ambient' | 'diffuse' | 'specular' | 'specularPower', value: number) => {
    const newAmb = param === 'ambient' ? value : ambient;
    const newDiff = param === 'diffuse' ? value : diffuse;
    const newSpec = param === 'specular' ? value : specular;
    const newSpecPow = param === 'specularPower' ? value : specularPower;

    if (param === 'ambient') setAmbient(value);
    if (param === 'diffuse') setDiffuse(value);
    if (param === 'specular') setSpecular(value);
    if (param === 'specularPower') setSpecularPower(value);

    setShadingPreset('standard'); // Mark as custom
    applyShading(newAmb, newDiff, newSpec, newSpecPow);
  };

  const handleSampleQuality = (value: number) => {
    setSampleQuality(value);
    const viewport = getViewport3d();
    if (!viewport) return;
    // Lower multiplier = more samples = better quality but slower
    viewport.setProperties({ sampleDistanceMultiplier: value });
    viewport.render();
  };

  // Apply tissue visibility by directly modifying the vtkPiecewiseFunction
  // on the volume actor's property, then calling property.modified() to
  // trigger the StreamingOpenGLVolumeMapper to rebuild its GPU opacity texture.
  //
  // Key discovery: property.modified() is ESSENTIAL — it updates the property's
  // MTime so getNeedToRebuildBufferObjects() returns true, which then causes
  // buildBufferObjects() to regenerate the opacity texture from the ofun.
  const applyTissueVisibility = useCallback((visibility: Record<string, boolean>) => {
    const viewport = getViewport3d();
    if (!viewport) return;
    try {
      // Evaluate a layer's opacity at a given HU via linear interpolation
      const evalLayer = (points: [number, number][], hu: number): number => {
        if (hu <= points[0][0]) return points[0][1];
        if (hu >= points[points.length - 1][0]) return points[points.length - 1][1];
        for (let i = 0; i < points.length - 1; i++) {
          const [h0, o0] = points[i];
          const [h1, o1] = points[i + 1];
          if (hu >= h0 && hu <= h1) {
            const t = (hu - h0) / (h1 - h0);
            return o0 + t * (o1 - o0);
          }
        }
        return 0;
      };

      // Collect all breakpoint HU values from all layers
      const huSet = new Set<number>([-3024, 3071]);
      for (const layer of TISSUE_LAYERS) {
        for (const [hu] of layer.points) {
          huSet.add(hu);
          huSet.add(hu - 1); // Sharp boundary transitions
          huSet.add(hu + 1);
        }
      }
      const sortedHU = Array.from(huSet).sort((a, b) => a - b);

      // Build opacity points and apply via preset (creates new ofun internally)
      const allPoints: [number, number][] = [];
      for (const hu of sortedHU) {
        let totalOp = 0;
        for (const layer of TISSUE_LAYERS) {
          if (!(visibility[layer.key] ?? false)) continue;
          const firstHU = layer.points[0][0];
          const lastHU = layer.points[layer.points.length - 1][0];
          if (hu >= firstHU && hu <= lastHU) {
            totalOp += evalLayer(layer.points, hu);
          }
        }
        allPoints.push([hu, Math.max(0, Math.min(1, totalOp))]);
      }

      const count = allPoints.length * 2;
      const opStr = count + ' ' + allPoints.map(([h, o]) => `${h} ${o.toFixed(4)}`).join(' ');
      viewport.setProperties({
        preset: {
          name: `tissue-${Date.now()}`,
          scalarOpacity: opStr,
          colorTransfer: '20 -3024 0 0 0 67.0106 0.54902 0.25098 0.14902 251.105 0.882353 0.603922 0.290196 439.291 1 0.937033 0.954531 3071 0.827451 0.658824 1',
          gradientOpacity: '4 0 1 255 1',
          specularPower: '10', specular: '0.2', shade: '1',
          ambient: '0.1', diffuse: '0.9', interpolation: '1',
        } as any,
      });

      const visibleList = Object.keys(visibility).filter(k => visibility[k]);
      console.log('[TissueVis] Opacity updated, visible:', visibleList.join(', '));
    } catch (e) {
      console.warn('[TissueVis] Error:', e);
    }
  }, []);

  const toggleTissue = (key: string) => {
    const newVis = { ...tissueVisibility, [key]: !tissueVisibility[key] };
    setTissueVisibility(newVis);
    applyTissueVisibility(newVis);
  };

  // Quick scene presets
  const setScene = (scene: Record<string, boolean>) => {
    setTissueVisibility(scene);
    applyTissueVisibility(scene);
  };

  const SCENE_PRESETS = [
    { label: 'All', desc: 'Show everything', vis: { air: false, fat: true, soft: true, blood: true, bone: true } },
    { label: 'Heart', desc: 'Only contrast-enhanced blood (heart, aorta, vessels)', vis: { air: false, fat: false, soft: false, blood: true, bone: false } },
    { label: 'No Bone', desc: 'Hide bone, show soft tissue + contrast', vis: { air: false, fat: false, soft: true, blood: true, bone: false } },
    { label: 'Lung', desc: 'Show lung parenchyma + airways', vis: { air: true, fat: false, soft: false, blood: false, bone: false } },
  ];

  // ── Scalpel Tool: remove structures by painting on 3D viewport ──
  const [scalpelMode, setScalpelMode] = useState<ScalpelMode>('off');
  // HU Crop range for 3D isolation
  const [huCropEnabled, setHuCropEnabled] = useState(false);
  const [huCropMin, setHuCropMin] = useState(100);
  const [huCropMax, setHuCropMax] = useState(500);
  const [scalpelHasBackup, setScalpelHasBackup] = useState(false);

  // Clipping Box — 6 planes to clip the volume
  const [clipEnabled, setClipEnabled] = useState(false);
  const [clipBox, setClipBox] = useState({ xMin: 0, xMax: 100, yMin: 0, yMax: 100, zMin: 0, zMax: 100 }); // percentages

  // Region Growing — flood fill from seed point within HU range
  const [regionGrowMode, setRegionGrowMode] = useState<'off' | 'picking'>('off');
  const [regionGrowHuMin, setRegionGrowHuMin] = useState(100);
  const [regionGrowHuMax, setRegionGrowHuMax] = useState(500);
  const [regionGrowStatus, setRegionGrowStatus] = useState('');
  const regionGrowSeedRef = useRef<[number, number, number] | null>(null);

  const scalpelCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const scalpelPointsRef = useRef<[number, number][]>([]);
  const volumeBackupRef = useRef<{ data: ScalpelBackupArray | null; saved: boolean }>({ data: null, saved: false });
  const isDrawingRef = useRef(false);

  const getSliceScalarData = useCallback((volume: any, kk: number) => {
    const imageId = volume?.imageIds?.[kk];
    if (!imageId) return null;
    try {
      const image = cornerstone.cache.getImage(imageId) as any;
      return image?.voxelManager?.getScalarData?.()
        ?? image?.getPixelData?.()
        ?? image?.pixelData
        ?? null;
    } catch (e) {
      console.error('[Scalpel] Error fetching slice image:', e);
      return null;
    }
  }, []);

  const getTransparentVoxelValue = useCallback((volume: any): number => {
    // The erase value must be expressed in the array's STORED units, not raw HU.
    // For an UNSIGNED scalar array (Uint16 CT, PixelRepresentation 0) writing a
    // raw −3024 wraps to a huge dense value — the structure gets brighter instead
    // of disappearing. eraseValueForScalarType returns 0 (air) for unsigned data
    // and −3024 for signed/float, where −3024 HU maps to zero VRT opacity.
    let ctorName: string | undefined;
    try {
      const firstImageId = volume?.imageIds?.[0];
      const img = firstImageId ? (cornerstone.cache.getImage(firstImageId) as any) : null;
      const arr = img?.voxelManager?.getScalarData?.() ?? volume?.voxelManager?.getCompleteScalarDataArray?.();
      ctorName = arr?.constructor?.name;
    } catch { /* ignore */ }
    return eraseValueForScalarType(ctorName);
  }, []);

  const markVolumeFramesModified = useCallback((volume: any, viewport: cornerstone.Types.IVolumeViewport, modifiedSlices?: Set<number>) => {
    const texture = volume?.vtkOpenGLTexture;
    if (texture?.setUpdatedFrame && modifiedSlices?.size) {
      for (const kk of modifiedSlices) {
        try { texture.setUpdatedFrame(kk); } catch { /* ignore */ }
      }
    } else if (volume?.invalidateVolume) {
      try { volume.invalidateVolume(false); } catch { /* ignore */ }
    } else if (volume?.invalidate) {
      try { volume.invalidate(); } catch { /* ignore */ }
    }

    try { volume?.modified?.(); } catch { /* ignore */ }
    try { volume?.imageData?.modified?.(); } catch { /* ignore */ }
    try { volume?.imageData?.getPointData?.()?.getScalars?.()?.modified?.(); } catch { /* ignore */ }

    try {
      const actor = viewport.getDefaultActor()?.actor;
      const mapper = actor?.getMapper?.() as { modified?: () => void } | undefined;
      mapper?.modified?.();
    } catch { /* ignore */ }

    // THE FIX: setUpdatedFrame only FLAGS frames dirty — the streaming texture
    // re-uploads them to the GPU inside update3DFromRaw(), which a plain
    // viewport.render() after an off-render edit does NOT reach (observed: 546
    // frames left pending, so the carve never appeared). Prime a render so the
    // GL context is current, push the dirty frames to the GPU explicitly, then
    // redraw. This replaces the old setVolumesForViewports re-bind hammer (which
    // also failed to upload and reset the user's preset/shading).
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    viewport.render();
    try { texture?.update3DFromRaw?.(); } catch { /* ignore */ }
    viewport.render();
    try { engine?.render(); } catch { /* ignore */ }
  }, [renderingEngineId]);

  // Save volume data backup for undo.
  // Cornerstone3D streaming volumes store each slice in a separate image cache entry.
  // For blazing fast copy and low memory usage, we clone the live VTK scalar typed array if available.
  const saveVolumeBackup = useCallback(() => {
    if (volumeBackupRef.current.saved) {
      setScalpelHasBackup(true);
      return;
    }
    const volume = cornerstone.cache.getVolume(volumeId) as any;
    if (!volume?.voxelManager || !volume?.imageData) return;
    const dims = volume.imageData.getDimensions();
    const [nx, ny, nz] = dims;
    const total = nx * ny * nz;
    
    const vm = volume.voxelManager;
    let backup: ScalpelBackupArray;
    const completeArray = vm.getCompleteScalarDataArray?.();
    
    if (completeArray) {
      const BackupArray = completeArray.constructor as { new (data: ArrayLike<number>): ScalpelBackupArray };
      backup = new BackupArray(completeArray);
    } else {
      const vtkScalars = volume.imageData.getPointData?.()?.getScalars?.();
      const vtkScalarData = vtkScalars?.getData?.();
      if (vtkScalarData) {
        const BackupArray = vtkScalarData.constructor as { new (data: ArrayLike<number>): ScalpelBackupArray };
        backup = new BackupArray(vtkScalarData);
      } else {
        backup = new Int16Array(total);
        let idx = 0;
        for (let k = 0; k < nz; k++) {
          for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
              backup[idx++] = vm.getAtIJK(i, j, k) ?? -1024;
            }
          }
        }
      }
    }
    
    volumeBackupRef.current = { data: backup, saved: true };
    setScalpelHasBackup(true);
    console.log('[Scalpel] Backup saved, voxels:', total);
  }, [volumeId]);

  // Undo scalpel: restore all voxels via setAtIJK and direct VTK array writing (dual-write)
  const undoScalpel = useCallback(() => {
    const backup = volumeBackupRef.current;
    if (!backup.saved || !backup.data) {
      setScalpelHasBackup(false);
      return;
    }
    const volume = cornerstone.cache.getVolume(volumeId) as any;
    if (!volume?.voxelManager || !volume?.imageData) return;
    const vm = volume.voxelManager;
    
    const dims = volume.imageData.getDimensions();
    const [nx, ny, nz] = dims;
    const sliceSize = nx * ny;

    if (typeof vm.setCompleteScalarDataArray === 'function') {
      vm.setCompleteScalarDataArray(backup.data);
    } else {
      for (let k = 0; k < nz; k++) {
        const offset = k * sliceSize;
        const sliceData = getSliceScalarData(volume, k);
        if (sliceData) {
          sliceData.set(backup.data.subarray(offset, offset + sliceSize));
        } else {
          for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
              vm.setAtIJK(i, j, k, backup.data[offset + j * nx + i]);
            }
          }
        }
      }
    }
    
    const vtkScalars = volume.imageData.getPointData?.()?.getScalars?.();
    const vtkScalarData = vtkScalars?.getData?.();
    if (vtkScalarData) {
      vtkScalarData.set(backup.data);
    }

    let scalarData = null;
    try {
      scalarData = volume.getScalarData ? volume.getScalarData() : volume.scalarData;
    } catch { /* ignore */ }
    if (scalarData && scalarData !== vtkScalarData) {
      scalarData.set(backup.data);
    }
    
    const viewport = getViewport3d();
    if (viewport) {
      const allSlices = new Set<number>();
      for (let k = 0; k < nz; k++) allSlices.add(k);
      markVolumeFramesModified(volume, viewport, allSlices);
    }

    volumeBackupRef.current = { data: null, saved: false };
    setScalpelHasBackup(false);
    console.log('[Scalpel] Volume restored from backup');
  }, [volumeId, getSliceScalarData, markVolumeFramesModified]);

  // Apply scalpel: erase voxels under the drawn region via ray-march.
  // Architecture: Cornerstone3D streaming volumes store per-slice data in image cache.
  // voxelManager.setAtIJK() is the correct way to write — it updates the right per-image
  // cache entry. Afterwards we must notify VTK to rebuild its GPU texture.
  const applyScalpel = useCallback((canvasPoints: [number, number][]) => {
    if (canvasPoints.length < 3) return;

    const viewport = getViewport3d();
    if (!viewport) return;
    const volume = cornerstone.cache.getVolume(volumeId) as any;
    if (!volume?.voxelManager || !volume?.imageData) return;

    saveVolumeBackup();

    const cam = viewport.getCamera();
    if (!cam.position || !cam.focalPoint) return;

    const imageData = volume.imageData;
    const dims = imageData.getDimensions();
    const spacing = imageData.getSpacing();
    const vm = volume.voxelManager;
    const bounds = imageData.getBounds(); // [xmin, xmax, ymin, ymax, zmin, zmax]

    const ERASE_VALUE = getTransparentVoxelValue(volume);

    const vtkScalars = imageData.getPointData?.()?.getScalars?.();
    const vtkScalarData = vtkScalars?.getData?.();

    let scalarData: ScalpelBackupArray | null = null;
    try {
      scalarData = vm.getCompleteScalarDataArray?.() ?? null;
    } catch { /* ignore */ }
    if (!scalarData) {
      try {
        scalarData = volume.getScalarData ? volume.getScalarData() : volume.scalarData;
      } catch { /* ignore */ }
    }

    const sliceDataCache: { [kk: number]: ScalpelBackupArray | null | undefined } = {};
    const getSliceData = (kk: number) => {
      if (sliceDataCache[kk] !== undefined) return sliceDataCache[kk];
      sliceDataCache[kk] = getSliceScalarData(volume, kk);
      return sliceDataCache[kk];
    };

    const canCommitCompleteArray = !!scalarData && typeof vm.setCompleteScalarDataArray === 'function';

    const rayStep = Math.min(spacing[0], spacing[1], spacing[2]) * 0.5;
    let erased = 0;
    const modifiedSlices = new Set<number>();
    const erasedSet = new Set<number>();
    let rays = 0;
    let rayHits = 0;
    let mapFailures = 0;

    const writeErasedVoxel = (ii: number, jj: number, kk: number) => {
      const voxelKey = kk * dims[0] * dims[1] + jj * dims[0] + ii;
      if (erasedSet.has(voxelKey)) return;

      const hu = vm.getAtIJK(ii, jj, kk);
      if (!shouldEraseVoxel(hu, ERASE_VALUE)) return;

      vm.setAtIJK(ii, jj, kk, ERASE_VALUE);
      if (vtkScalarData) vtkScalarData[voxelKey] = ERASE_VALUE;
      if (scalarData) scalarData[voxelKey] = ERASE_VALUE;

      const sliceData = getSliceData(kk);
      if (sliceData) sliceData[jj * dims[0] + ii] = ERASE_VALUE;

      erasedSet.add(voxelKey);
      modifiedSlices.add(kk);
      erased++;
    };

    for (const [cx, cy] of collectPolygonRaySamples(canvasPoints, 2)) {
      rays++;

      const worldTarget = viewport.canvasToWorld?.([cx, cy]);
      if (!worldTarget) {
        mapFailures++;
        continue;
      }

      const viewRay = buildViewRay(cam, worldTarget);
      if (!viewRay) continue;

      const march = marchRangeAlongRay(viewRay.origin, viewRay.dir, bounds, cam, worldTarget);
      if (!march) continue;
      rayHits++;

      for (let d = march.tMin; d <= march.tMax; d += rayStep) {
        const worldPos = addScaled(viewRay.origin, viewRay.dir, d);
        const ijk = imageData.worldToIndex(worldPos);
        const ii = Math.round(ijk[0]);
        const jj = Math.round(ijk[1]);
        const kk = Math.round(ijk[2]);

        if (ii < 0 || ii >= dims[0] || jj < 0 || jj >= dims[1] || kk < 0 || kk >= dims[2]) continue;
        writeErasedVoxel(ii, jj, kk);
      }
    }

    // Read-back verification: confirm the erase value actually landed in the
    // LIVE per-image array the GPU texture uploads from (cache.getImage →
    // voxelManager.getScalarData). If `wrote` is false, the write target is
    // wrong; if true but the structure still shows, it's a texture-refresh issue.
    let readbackOk: boolean | null = null;
    let scalarTypeName: string | undefined;
    if (erasedSet.size > 0) {
      const anyKey = erasedSet.values().next().value as number;
      const kk = Math.floor(anyKey / (dims[0] * dims[1]));
      const within = anyKey - kk * dims[0] * dims[1];
      try {
        const img = cornerstone.cache.getImage(volume.imageIds[kk]) as any;
        const liveArr = img?.voxelManager?.getScalarData?.();
        scalarTypeName = liveArr?.constructor?.name;
        if (liveArr) readbackOk = liveArr[within] === ERASE_VALUE;
      } catch { /* ignore */ }
    }

    (window as any).__lastScalpelStats = {
      erased,
      modifiedSlices: modifiedSlices.size,
      rays,
      rayHits,
      mapFailures,
      eraseValue: ERASE_VALUE,
      scalarTypeName,
      readbackOk,
      dims,
      bounds,
    };

    console.log(
      `[Scalpel] Ray-march complete: erased=${erased}, slices=${modifiedSlices.size}, ` +
      `rays=${rays}, hits=${rayHits}, mapFailures=${mapFailures}, eraseValue=${ERASE_VALUE}, ` +
      `scalarType=${scalarTypeName}, readbackOk=${readbackOk}`
    );

    if (erased > 0) {
      if (canCommitCompleteArray) {
        try {
          vm.setCompleteScalarDataArray(scalarData);
        } catch (e) {
          console.warn('[Scalpel] Could not commit complete scalar array:', e);
        }
      }
      if (vtkScalarData && scalarData && vtkScalarData.length === scalarData.length) {
        try {
          vtkScalarData.set(scalarData);
        } catch { /* ignore */ }
      }
      markVolumeFramesModified(volume, viewport, modifiedSlices);

      console.log(`[Scalpel] ✓ Rendered: erased ${erased} voxels across ${modifiedSlices.size} slices`);
    } else {
      console.warn('[Scalpel] No voxels erased — check that canvasToWorld and ray march are hitting the volume bounds');
    }
  }, [volumeId, saveVolumeBackup, getSliceScalarData, getTransparentVoxelValue, markVolumeFramesModified]);

  // Setup/teardown scalpel canvas overlay on 3D viewport
  useEffect(() => {
    const viewport = getViewport3d();

    // Find every cornerstone-tools ToolGroup that has the volume3d viewport
    // attached. We deactivate trackball/pan/zoom on these during scalpel
    // draw mode so primary-mouse drag reaches the scalpel canvas instead of
    // rotating the camera. Restored on scalpel-off. Without this, the
    // Cardiac3DView modal's `cardiac3dToolGroup` (CCTA) and the main
    // CtApp's `vol3dToolGroup` keep TrackballRotate bound to primary mouse
    // and either intercept the drag or fight with the document-capture
    // listener below, leaving the eraser non-functional.
    function getVolume3dToolGroups(): unknown[] {
      const groups: unknown[] = [];
      const seen = new Set<unknown>();
      const addGroup = (tg: unknown | undefined) => {
        if (!tg || seen.has(tg)) return;
        seen.add(tg);
        groups.push(tg);
      };

      try {
        const mgr = cornerstoneTools.ToolGroupManager as unknown as {
          getAllToolGroups?: () => unknown[];
          getToolGroup?: (id: string) => unknown;
        };

        for (const id of ['vol3dToolGroup', 'cardiac3dToolGroup']) {
          addGroup(mgr.getToolGroup?.(id));
        }

        if (typeof mgr.getAllToolGroups === 'function') {
          for (const tg of mgr.getAllToolGroups()) {
            const info = (tg as { viewportsInfo?: Array<{ viewportId: string }> }).viewportsInfo;
            if (Array.isArray(info) && info.some((v) => v.viewportId === 'volume3d')) {
              addGroup(tg);
            }
          }
        }
      } catch { /* ignore */ }

      return groups;
    }

    function setVolume3dPrimaryToolsActive(active: boolean) {
      const names = [
        cornerstoneTools.TrackballRotateTool.toolName,
        cornerstoneTools.PanTool.toolName,
        cornerstoneTools.ZoomTool.toolName,
      ];
      for (const tg of getVolume3dToolGroups()) {
        const group = tg as {
          setToolPassive?: (n: string) => void;
          setToolActive?: (n: string, opts: unknown) => void;
        };
        for (const n of names) {
          try {
            if (active) {
              if (n === cornerstoneTools.TrackballRotateTool.toolName) {
                group.setToolActive?.(n, {
                  bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
                });
              } else if (n === cornerstoneTools.PanTool.toolName) {
                group.setToolActive?.(n, {
                  bindings: [
                    { mouseButton: cornerstoneTools.Enums.MouseBindings.Auxiliary },
                    {
                      mouseButton: cornerstoneTools.Enums.MouseBindings.Primary,
                      modifierKey: cornerstoneTools.Enums.KeyboardBindings.Shift,
                    },
                  ],
                });
              } else if (n === cornerstoneTools.ZoomTool.toolName) {
                group.setToolActive?.(n, {
                  bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }],
                });
              }
            } else {
              group.setToolPassive?.(n);
            }
          } catch { /* ignore */ }
        }
      }
    }

    if (scalpelMode === 'off') {
      if (scalpelCanvasRef.current) {
        scalpelCanvasRef.current.remove();
        scalpelCanvasRef.current = null;
      }
      try {
        if (viewport?.canvas) viewport.canvas.style.pointerEvents = '';
      } catch { /* ignore */ }
      try {
        const renderer = (viewport as any)?.getRenderer?.();
        const interactor = renderer?.getRenderWindow?.()?.getInteractor?.();
        if (interactor) interactor.setEnabled(true);
      } catch { /* ignore */ }
      setVolume3dPrimaryToolsActive(true);
      return;
    }

    if (!viewport?.element) return;
    const el = viewport.element;

    // Deactivate competing tools BEFORE attaching our canvas + listeners.
    setVolume3dPrimaryToolsActive(false);

    // Keep VTK from stealing drags; overlay canvas receives the stroke.
    try {
      if (viewport.canvas) viewport.canvas.style.pointerEvents = 'none';
    } catch { /* ignore */ }
    try {
      const renderer = (viewport as any).getRenderer?.();
      const interactor = renderer?.getRenderWindow?.()?.getInteractor?.();
      if (interactor) {
        interactor.setEnabled(false);
        console.log('[Scalpel] VTK interactor disabled');
      }
    } catch (e) { console.warn('[Scalpel] Could not disable interactor:', e); }

    // Create drawing canvas
    let canvas = scalpelCanvasRef.current;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:55;cursor:crosshair;touch-action:none;';
      el.style.position = 'relative';
      el.appendChild(canvas);
      scalpelCanvasRef.current = canvas;
    }

    const dpr = window.devicePixelRatio || 1;
    canvas.width = el.clientWidth * dpr;
    canvas.height = el.clientHeight * dpr;

    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const drawPath = () => {
      ctx.clearRect(0, 0, el.clientWidth, el.clientHeight);
      const pts = scalpelPointsRef.current;
      if (pts.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255, 60, 60, 0.25)';
      ctx.fill();
      ctx.strokeStyle = '#ff3c3c';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    };

    // DOCUMENT-level capture listeners bypass VTK event capturing; the stroke
    // is gated on e.target === canvas (see onDown) so the control deck stays
    // clickable.
    const toLocal = (e: MouseEvent): [number, number] => {
      const rect = canvas!.getBoundingClientRect();
      return [e.clientX - rect.left, e.clientY - rect.top];
    };

    const onDown = (e: MouseEvent) => {
      // Only start a stroke when the click actually lands on the overlay canvas.
      // Using the event target (not a bounding-rect test) means clicks on the
      // control deck — which sits ON TOP of the canvas — pass straight through
      // to its buttons instead of being swallowed in the capture phase. This is
      // the fix for "after pressing Erase, no 3D menu is clickable".
      if (e.button !== 0 || e.target !== canvas) return;
      e.preventDefault();
      e.stopPropagation();
      isDrawingRef.current = true;
      scalpelPointsRef.current = [toLocal(e)];
    };

    const onMove = (e: MouseEvent) => {
      if (!isDrawingRef.current) return;
      e.preventDefault();
      scalpelPointsRef.current.push(toLocal(e));
      drawPath();
    };

    const onUp = (e: MouseEvent) => {
      if (!isDrawingRef.current) return;
      e.preventDefault();
      isDrawingRef.current = false;
      const pts = [...scalpelPointsRef.current];
      scalpelPointsRef.current = [];

      if (pts.length >= 3) {
        // Show "Processing..." feedback
        ctx.clearRect(0, 0, el.clientWidth, el.clientHeight);
        ctx.fillStyle = 'rgba(255, 60, 60, 0.15)';
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let p = 1; p < pts.length; p++) ctx.lineTo(pts[p][0], pts[p][1]);
        ctx.closePath();
        ctx.fill();
        ctx.font = 'bold 14px -apple-system, sans-serif';
        ctx.fillStyle = '#ff3c3c';
        ctx.textAlign = 'center';
        const centX = pts.reduce((s, p) => s + p[0], 0) / pts.length;
        const centY = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        ctx.fillText('Erasing...', centX, centY);

        setTimeout(() => {
          applyScalpel(pts);
          ctx.clearRect(0, 0, el.clientWidth, el.clientHeight);
        }, 30);
      } else {
        ctx.clearRect(0, 0, el.clientWidth, el.clientHeight);
      }
    };

    // Escape key exits scalpel mode
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setScalpelMode('off');
    };

    // Listen on DOCUMENT in capture phase — guaranteed to fire before any VTK handler
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [scalpelMode, applyScalpel]);

  // Apply HU crop via viewport.setProperties({ preset }) — this calls applyPreset()
  // which creates a NEW vtkPiecewiseFunction internally, busting the mapper's hash cache.
  // Apply clipping box — 6 planes to crop the 3D volume
  const applyClipBox = useCallback((enabled: boolean, box: typeof clipBox) => {
    const viewport = getViewport3d();
    if (!viewport) return;
    try {
      const actor = viewport.getDefaultActor()?.actor;
      const mapper = actor?.getMapper?.() as any;
      if (!mapper) return;

      // Remove existing clipping planes
      mapper.removeAllClippingPlanes();

      if (enabled) {
        const volume = cornerstone.cache.getVolume(volumeId);
        if (!volume?.imageData) return;
        const bounds = volume.imageData.getBounds(); // [xmin,xmax,ymin,ymax,zmin,zmax]

        // Convert percentages to world coordinates
        const toWorld = (pct: number, min: number, max: number) => min + (pct / 100) * (max - min);

        const xLo = toWorld(box.xMin, bounds[0], bounds[1]);
        const xHi = toWorld(box.xMax, bounds[0], bounds[1]);
        const yLo = toWorld(box.yMin, bounds[2], bounds[3]);
        const yHi = toWorld(box.yMax, bounds[2], bounds[3]);
        const zLo = toWorld(box.zMin, bounds[4], bounds[5]);
        const zHi = toWorld(box.zMax, bounds[4], bounds[5]);

        // 6 clipping planes forming a box
        const planes = [
          { origin: [xLo, 0, 0], normal: [1, 0, 0] },   // +X (keep right of xLo)
          { origin: [xHi, 0, 0], normal: [-1, 0, 0] },   // -X (keep left of xHi)
          { origin: [0, yLo, 0], normal: [0, 1, 0] },     // +Y (keep above yLo)
          { origin: [0, yHi, 0], normal: [0, -1, 0] },    // -Y (keep below yHi)
          { origin: [0, 0, zLo], normal: [0, 0, 1] },     // +Z (keep above zLo)
          { origin: [0, 0, zHi], normal: [0, 0, -1] },    // -Z (keep below zHi)
        ];

        for (const p of planes) {
          // IMMUTABLE fake vtkPlane: VTK.js internally calls setOrigin()/setNormal()
          // to transform planes into data coordinates on each render. If we store
          // those transformed values, the next render double-transforms them, causing
          // cascading corruption (image disappears on rotation/click).
          // Fix: getOrigin/getNormal always return fresh copies of the ORIGINAL
          // world-space values. setOrigin/setNormal are no-ops.
          const origOrigin = [...p.origin] as [number, number, number];
          const origNormal = [...p.normal] as [number, number, number];
          let mtime = Date.now();
          const plane: any = {
            isA: (cls: string) => cls === 'vtkPlane',
            getClassName: () => 'vtkPlane',
            getOrigin: () => [...origOrigin],
            getNormal: () => [...origNormal],
            setOrigin: () => {},  // no-op — preserve original world-space values
            setNormal: () => {},  // no-op — preserve original world-space values
            getMTime: () => mtime,
            modified: () => { mtime = Date.now(); },
            onModified: () => ({ unsubscribe: () => {} }),
          };
          mapper.addClippingPlane(plane);
        }
      }

      mapper.modified();
      // Use VTK native render to bypass Cornerstone's resetCameraClippingRange
      try {
        const renderer = (viewport as any).getRenderer?.();
        renderer?.getRenderWindow?.()?.render?.();
      } catch {
        viewport.render();
      }
      console.log(`[ClipBox] ${enabled ? 'ON' : 'OFF'}`);
    } catch (e) {
      console.warn('[ClipBox] Error:', e);
    }
  }, [volumeId]);

  // ── Region Growing: 3D flood fill from seed within HU range ──
  // Picks a seed from the 3D viewport click, runs BFS to find all connected
  // voxels in the HU range, then erases everything else.
  const applyRegionGrow = useCallback((seedIJK: [number, number, number], minHU: number, maxHU: number) => {
    const viewport = getViewport3d();
    if (!viewport) return;
    const volume = cornerstone.cache.getVolume(volumeId) as any;
    if (!volume?.voxelManager || !volume?.imageData) return;

    saveVolumeBackup();
    setRegionGrowStatus('Growing...');

    const imageData = volume.imageData;
    const dims = imageData.getDimensions();
    const [nx, ny, nz] = dims;
    const totalVoxels = nx * ny * nz;

    // Fast path: direct copy of the live VTK scalar array
    const vtkScalars = imageData.getPointData?.()?.getScalars?.();
    const vtkScalarData = vtkScalars?.getData?.();
    const scalarData = vtkScalarData || volume.voxelManager.getCompleteScalarDataArray();
    if (!scalarData) return;

    const toIdx = (i: number, j: number, k: number) => k * nx * ny + j * nx + i;

    // Verify seed is in range
    const seedIdx = toIdx(seedIJK[0], seedIJK[1], seedIJK[2]);
    const seedHU = scalarData[seedIdx];
    if (seedHU < minHU || seedHU > maxHU) {
      setRegionGrowStatus(`Seed HU=${seedHU} outside range [${minHU}, ${maxHU}]`);
      return;
    }

    // BFS flood fill — use Uint8Array as visited mask
    const mask = new Uint8Array(totalVoxels); // 0 = not in region, 1 = in region

    const queue: number[] = []; // flat indices
    queue.push(seedIdx);
    mask[seedIdx] = 1;
    let regionSize = 0;
    const MAX_REGION = 20_000_000; // safety limit

    // 6-connected neighbors
    const dx = [1, -1, 0, 0, 0, 0];
    const dy = [0, 0, 1, -1, 0, 0];
    const dz = [0, 0, 0, 0, 1, -1];

    let head = 0;
    while (head < queue.length && regionSize < MAX_REGION) {
      const idx = queue[head++];
      regionSize++;
      const k = Math.floor(idx / (nx * ny));
      const rem = idx % (nx * ny);
      const j = Math.floor(rem / nx);
      const i = rem % nx;

      for (let d = 0; d < 6; d++) {
        const ni = i + dx[d], nj = j + dy[d], nk = k + dz[d];
        if (ni < 0 || ni >= nx || nj < 0 || nj >= ny || nk < 0 || nk >= nz) continue;
        const nIdx = toIdx(ni, nj, nk);
        if (mask[nIdx]) continue;
        const hu = scalarData[nIdx];
        if (hu >= minHU && hu <= maxHU) {
          mask[nIdx] = 1;
          queue.push(nIdx);
        }
      }
    }

    console.log(`[RegionGrow] Found ${regionSize} voxels in region`);

    // Cache slice arrays for fast writes
    const sliceDataCache: { [kk: number]: any } = {};
    const getSliceData = (kk: number) => {
      if (sliceDataCache[kk] !== undefined) return sliceDataCache[kk];
      if (!volume.imageIds || !volume.imageIds[kk]) {
        sliceDataCache[kk] = null;
        return null;
      }
      try {
        const imageId = volume.imageIds[kk];
        const image = cornerstone.cache.getImage(imageId);
        if (image) {
          let sliceData = null;
          if (image.voxelManager && typeof image.voxelManager.getScalarData === 'function') {
            sliceData = image.voxelManager.getScalarData();
          }
          if (!sliceData && typeof image.getPixelData === 'function') {
            sliceData = image.getPixelData();
          }
          const legacyPixelData = (image as { pixelData?: ReturnType<cornerstone.Types.IImage['getPixelData']> }).pixelData;
          if (!sliceData && legacyPixelData) {
            sliceData = legacyPixelData;
          }
          sliceDataCache[kk] = sliceData;
          return sliceData;
        }
      } catch (e) {
        console.error('[Scalpel] Error fetching slice image for regiongrow:', e);
      }
      sliceDataCache[kk] = null;
      return null;
    };

    // Erase everything OUTSIDE the region
    const AIR_HU = -1024;
    let erased = 0;
    const modifiedSlices = new Set<number>();
    const vm = volume.voxelManager;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const idx = toIdx(i, j, k);
          if (!mask[idx] && scalarData[idx] > -200) {
            scalarData[idx] = AIR_HU;
            vm.setAtIJK(i, j, k, AIR_HU); // Dual-write!
            
            const sliceData = getSliceData(k);
            if (sliceData) {
              sliceData[j * nx + i] = AIR_HU;
            }
            
            modifiedSlices.add(k);
            erased++;
          }
        }
      }
    }

    console.log(`[RegionGrow] Erased ${erased} voxels outside region`);

    // Mark each modified slice as updated in the volume's OpenGL texture
    if (volume.vtkOpenGLTexture?.setUpdatedFrame) {
      for (const kk of modifiedSlices) {
        try {
          volume.vtkOpenGLTexture.setUpdatedFrame(kk);
        } catch { /* ignore */ }
      }
    } else {
      try { volume.invalidate?.(); } catch { /* ignore */ }
    }

    // Call volume.modified to increment the Modified Times
    try {
      volume.modified?.();
    } catch { /* ignore */ }

    imageData.modified();
    if (imageData.getPointData) {
      imageData.getPointData().getScalars()?.modified?.();
    }
    const actor = viewport.getDefaultActor()?.actor;
    const mapper = actor?.getMapper?.();
    if (mapper) (mapper as any).modified?.();
    viewport.render();

    try {
      const engine = cornerstone.getRenderingEngine(renderingEngineId);
      engine?.renderViewport(viewport.id);
      engine?.render(); // refresh all viewports (MPRs) in the engine
    } catch { /* ignore */ }

    setRegionGrowStatus(`Isolated ${regionSize.toLocaleString()} voxels (${modifiedSlices.size} slices)`);
  }, [volumeId, saveVolumeBackup, renderingEngineId]);

  // Handle seed picking from 3D viewport click
  useEffect(() => {
    if (regionGrowMode !== 'picking') return;
    const viewport = getViewport3d();
    if (!viewport?.element) return;

    const el = viewport.element;

    const onClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      const worldPoint = (viewport as any).canvasToWorld?.([cx, cy]);
      if (!worldPoint) { setRegionGrowStatus('Could not map click to world'); return; }

      const volume = cornerstone.cache.getVolume(volumeId) as any;
      if (!volume?.imageData) return;
      const ijk = volume.imageData.worldToIndex(worldPoint);
      const seed: [number, number, number] = [Math.round(ijk[0]), Math.round(ijk[1]), Math.round(ijk[2])];
      regionGrowSeedRef.current = seed;

      const hu = volume.voxelManager?.getAtIJK(seed[0], seed[1], seed[2]);
      setRegionGrowStatus(`Seed: [${seed.join(',')}] HU=${hu}`);
      setRegionGrowMode('off');

      // Auto-run grow
      setTimeout(() => applyRegionGrow(seed, regionGrowHuMin, regionGrowHuMax), 50);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setRegionGrowMode('off'); setRegionGrowStatus('Cancelled'); }
    };

    // Temporarily disable VTK interactor
    try {
      const renderer = (viewport as any).getRenderer?.();
      const interactor = renderer?.getRenderWindow?.()?.getInteractor?.();
      if (interactor) interactor.setEnabled(false);
    } catch {}

    el.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      el.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown);
      // Re-enable VTK interactor
      try {
        const renderer = (viewport as any).getRenderer?.();
        const interactor = renderer?.getRenderWindow?.()?.getInteractor?.();
        if (interactor) interactor.setEnabled(true);
      } catch {}
    };
  }, [regionGrowMode, volumeId, regionGrowHuMin, regionGrowHuMax, applyRegionGrow]);

  const BASE_COLOR = '20 -3024 0 0 0 67.0106 0.54902 0.25098 0.14902 251.105 0.882353 0.603922 0.290196 439.291 1 0.937033 0.954531 3071 0.827451 0.658824 1';

  const applyHuCrop = useCallback((enabled: boolean, minHU: number, maxHU: number) => {
    const viewport = getViewport3d();
    if (!viewport) return;
    try {
      let opacityStr: string;
      if (!enabled) {
        opacityStr = '10 -3024 0 67.0106 0 251.105 0.446429 439.291 0.625 3071 0.616071';
      } else {
        const ramp = 20;
        const pts: [number, number][] = [
          [-3024, 0], [minHU - ramp, 0], [minHU, 0.05], [minHU + ramp, 0.4],
          [(minHU + maxHU) / 2, 0.6],
          [maxHU - ramp, 0.5], [maxHU, 0.05], [maxHU + ramp, 0], [3071, 0],
        ];
        const count = pts.length * 2;
        opacityStr = count + ' ' + pts.map(([h, o]) => `${h} ${o}`).join(' ');
      }

      viewport.setProperties({
        preset: {
          name: `crop-${Date.now()}`,
          scalarOpacity: opacityStr,
          colorTransfer: BASE_COLOR,
          gradientOpacity: '4 0 1 255 1',
          specularPower: '10', specular: '0.2', shade: '1',
          ambient: '0.1', diffuse: '0.9', interpolation: '1',
        } as any,
      });

      console.log(`[HUCrop] ${enabled ? `${minHU}→${maxHU} HU` : 'disabled'}`);
    } catch (e) {
      console.warn('[HUCrop] Error:', e);
    }
  }, []);

  const zoom3d = (factor: number) => {
    const viewport = getViewport3d();
    if (!viewport) return;
    const camera = viewport.getCamera();
    if (!camera.position || !camera.focalPoint) return;

    const direction = [
      camera.focalPoint[0] - camera.position[0],
      camera.focalPoint[1] - camera.position[1],
      camera.focalPoint[2] - camera.position[2],
    ];

    const newPosition: cornerstone.Types.Point3 = [
      camera.position[0] + direction[0] * factor,
      camera.position[1] + direction[1] * factor,
      camera.position[2] + direction[2] * factor,
    ];

    viewport.setCamera({ ...camera, position: newPosition });
    viewport.render();
  };

  const reset3d = () => {
    const viewport = getViewport3d();
    if (!viewport) return;
    viewport.resetCamera();
    viewport.render();
  };

  // ── C-arm angle display from 3D camera orientation ──
  const [cameraAngle, setCameraAngle] = useState<{ laoRao: string; cranCaud: string } | null>(null);

  const updateCameraAngle = useCallback(() => {
    const viewport = getViewport3d();
    if (!viewport) return;
    const cam = viewport.getCamera();
    if (!cam.position || !cam.focalPoint) return;

    const dx = cam.focalPoint[0] - cam.position[0];
    const dy = cam.focalPoint[1] - cam.position[1];
    const dz = cam.focalPoint[2] - cam.position[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 0.001) return;

    const vx = dx / len;
    const vy = dy / len;
    const vz = dz / len;

    const laoRaoDeg = Math.round(Math.atan2(vx, -vy) * 180 / Math.PI);
    const laoRaoLabel = laoRaoDeg >= 0 ? `LAO ${Math.abs(laoRaoDeg)}°` : `RAO ${Math.abs(laoRaoDeg)}°`;

    const cranCaudDeg = Math.round(Math.asin(vz) * 180 / Math.PI);
    const cranCaudLabel = cranCaudDeg >= 0 ? `Cranial ${Math.abs(cranCaudDeg)}°` : `Caudal ${Math.abs(cranCaudDeg)}°`;

    setCameraAngle({ laoRao: laoRaoLabel, cranCaud: cranCaudLabel });
  }, []);

  useEffect(() => {
    const timer = setInterval(updateCameraAngle, 200);
    updateCameraAngle();
    return () => clearInterval(timer);
  }, [updateCameraAngle]);

  const setAngleView = useCallback((laoRaoDeg: number, cranCaudDeg: number) => {
    const viewport = getViewport3d();
    if (!viewport) return;
    const cam = viewport.getCamera();
    if (!cam.focalPoint) return;

    const alpha = laoRaoDeg * Math.PI / 180;
    const beta = cranCaudDeg * Math.PI / 180;
    const bx = Math.sin(alpha) * Math.cos(beta);
    const by = -Math.cos(alpha) * Math.cos(beta);
    const bz = Math.sin(beta);

    const dist = cam.position && cam.focalPoint
      ? Math.sqrt(
          (cam.position[0] - cam.focalPoint[0]) ** 2 +
          (cam.position[1] - cam.focalPoint[1]) ** 2 +
          (cam.position[2] - cam.focalPoint[2]) ** 2
        )
      : 1000;

    viewport.setCamera({
      ...cam,
      position: [
        cam.focalPoint[0] - bx * dist,
        cam.focalPoint[1] - by * dist,
        cam.focalPoint[2] - bz * dist,
      ] as cornerstone.Types.Point3,
      viewUp: [0, 0, 1] as cornerstone.Types.Point3,
    });
    viewport.render();
    updateCameraAngle();
  }, [updateCameraAngle]);

  // 3D anatomical orientation presets
  const setOrientationView = useCallback((orientation: 'anterior' | 'posterior' | 'left' | 'right' | 'superior' | 'inferior') => {
    const viewport = getViewport3d();
    if (!viewport) return;
    const cam = viewport.getCamera();
    if (!cam.focalPoint) return;

    const dist = cam.position && cam.focalPoint
      ? Math.sqrt((cam.position[0] - cam.focalPoint[0]) ** 2 + (cam.position[1] - cam.focalPoint[1]) ** 2 + (cam.position[2] - cam.focalPoint[2]) ** 2)
      : 1000;

    // LPS: +X=Left, +Y=Posterior, +Z=Superior
    let dir: [number, number, number];
    let up: [number, number, number] = [0, 0, 1]; // default: Z-up
    switch (orientation) {
      case 'anterior':  dir = [0, -1, 0]; break;     // look from anterior (−Y) toward posterior
      case 'posterior': dir = [0, 1, 0]; break;       // look from posterior (+Y) toward anterior
      case 'left':      dir = [1, 0, 0]; break;       // look from left (+X)
      case 'right':     dir = [-1, 0, 0]; break;      // look from right (−X)
      case 'superior':  dir = [0, 0, 1]; up = [0, -1, 0]; break;  // look from top
      case 'inferior':  dir = [0, 0, -1]; up = [0, 1, 0]; break;  // look from bottom
    }

    viewport.setCamera({
      ...cam,
      position: [cam.focalPoint[0] - dir[0] * dist, cam.focalPoint[1] - dir[1] * dist, cam.focalPoint[2] - dir[2] * dist] as cornerstone.Types.Point3,
      viewUp: up as cornerstone.Types.Point3,
    });
    viewport.render();
    updateCameraAngle();
  }, [updateCameraAngle]);

  // Slider helper
  const SliderRow = ({ label, value, min, max, step, unit, onChange }: {
    label: string; value: number; min: number; max: number; step: number; unit?: string;
    onChange: (v: number) => void;
  }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span style={{ fontSize: '10px', color: 'var(--text-muted)', width: 65, flexShrink: 0 }}>{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ flex: 1, height: 3 }}
      />
      <span style={{ fontSize: '10px', color: 'var(--text-muted)', width: 36, textAlign: 'right' }}>
        {value.toFixed(step < 1 ? 2 : 0)}{unit || ''}
      </span>
    </div>
  );

  return (
    <div className="render-mode" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
      {/* Preset row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <span className="render-mode-label">3D:</span>
        {PRESETS.map(p => (
          <button
            key={p.key}
            className={`render-mode-btn ${mode === p.key ? 'active' : ''}`}
            onClick={() => setRenderMode(p.key)}
            title={p.description}
          >
            {p.label}
          </button>
        ))}
        <div className="toolbar-divider" style={{ margin: '0 4px' }} />
        <button className="render-mode-btn" onClick={() => zoom3d(0.2)} title="Zoom In 3D">+</button>
        <button className="render-mode-btn" onClick={() => zoom3d(-0.2)} title="Zoom Out 3D">-</button>
        <button className="render-mode-btn" onClick={reset3d} title="Reset 3D View">↺</button>
      </div>

      {/* Shading presets row (Cinematic) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '10px', color: 'var(--text-muted)', width: 50, flexShrink: 0 }}>Shading:</span>
        {(Object.keys(SHADING_PRESETS) as ShadingPreset[]).map(k => (
          <button
            key={k}
            className={`render-mode-btn ${shadingPreset === k ? 'active' : ''}`}
            onClick={() => applyShadingPreset(k)}
            title={`${SHADING_PRESETS[k].label} shading`}
            style={{ fontSize: '10px', padding: '2px 6px' }}
          >
            {SHADING_PRESETS[k].label}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button
          className={`render-mode-btn ${showAdvanced ? 'active' : ''}`}
          onClick={() => setShowAdvanced(!showAdvanced)}
          title="Advanced shading controls"
          style={{ fontSize: '10px', padding: '2px 6px' }}
        >
          ⚙
        </button>
      </div>

      {/* Advanced shading sliders (collapsible) */}
      {showAdvanced && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '4px 0', borderTop: '1px solid var(--border)' }}>
          <SliderRow label="Ambient" value={ambient} min={0} max={1} step={0.01} onChange={(v) => handleShadingSlider('ambient', v)} />
          <SliderRow label="Diffuse" value={diffuse} min={0} max={1} step={0.01} onChange={(v) => handleShadingSlider('diffuse', v)} />
          <SliderRow label="Specular" value={specular} min={0} max={1} step={0.01} onChange={(v) => handleShadingSlider('specular', v)} />
          <SliderRow label="Shininess" value={specularPower} min={1} max={128} step={1} onChange={(v) => handleShadingSlider('specularPower', v)} />
          <SliderRow label="Quality" value={sampleQuality} min={0.25} max={2} step={0.05} onChange={handleSampleQuality} />
        </div>
      )}

      {/* Scene presets + Tissue Visibility toggles */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '4px 0', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '10px', color: 'var(--text-muted)', flexShrink: 0 }}>Scene:</span>
        {SCENE_PRESETS.map(sp => (
          <button
            key={sp.label}
            className="render-mode-btn"
            onClick={() => setScene(sp.vis)}
            title={sp.desc}
            style={{ fontSize: '10px', padding: '2px 8px', fontWeight: 600 }}
          >
            {sp.label}
          </button>
        ))}
        <div className="toolbar-divider" style={{ margin: '0 2px' }} />
        {TISSUE_LAYERS.map(layer => (
          <button
            key={layer.key}
            className={`render-mode-btn ${tissueVisibility[layer.key] ? 'active' : ''}`}
            onClick={() => toggleTissue(layer.key)}
            title={`${layer.label} — click to ${tissueVisibility[layer.key] ? 'hide' : 'show'}`}
            style={{
              fontSize: '10px',
              padding: '2px 8px',
              borderLeft: `3px solid ${layer.color}`,
              opacity: tissueVisibility[layer.key] ? 1 : 0.4,
            }}
          >
            {layer.label}
          </button>
        ))}
      </div>

      {/* HU Crop — isolate structures by HU range */}
      <div style={{ padding: '4px 0', borderTop: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: huCropEnabled ? 4 : 0 }}>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)', flexShrink: 0 }}>Crop:</span>
          <button
            className={`render-mode-btn ${huCropEnabled ? 'active' : ''}`}
            onClick={() => { const next = !huCropEnabled; setHuCropEnabled(next); applyHuCrop(next, huCropMin, huCropMax); }}
            style={{ fontSize: '10px', padding: '2px 8px', fontWeight: 600 }}
            title="Enable HU crop to isolate structures"
          >
            {huCropEnabled ? 'ON' : 'OFF'}
          </button>
          {/* Quick presets */}
          <button className="render-mode-btn" onClick={() => { setHuCropMin(100); setHuCropMax(500); setHuCropEnabled(true); applyHuCrop(true, 100, 500); }}
            title="Heart only (contrast 100-500 HU)" style={{ fontSize: '10px', padding: '2px 6px' }}>Heart</button>
          <button className="render-mode-btn" onClick={() => { setHuCropMin(150); setHuCropMax(600); setHuCropEnabled(true); applyHuCrop(true, 150, 600); }}
            title="Vessels (150-600 HU)" style={{ fontSize: '10px', padding: '2px 6px' }}>Vessels</button>
          <button className="render-mode-btn" onClick={() => { setHuCropMin(200); setHuCropMax(1500); setHuCropEnabled(true); applyHuCrop(true, 200, 1500); }}
            title="Bone (200-1500 HU)" style={{ fontSize: '10px', padding: '2px 6px' }}>Bone</button>
          <button className="render-mode-btn" onClick={() => { setHuCropEnabled(false); applyHuCrop(false, 0, 0); }}
            title="Reset — show all" style={{ fontSize: '10px', padding: '2px 6px' }}>Reset</button>
        </div>
        {huCropEnabled && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: '10px', color: 'var(--text-muted)', width: 30 }}>Min</span>
              <input type="range" min={-1024} max={2000} value={huCropMin}
                onChange={(e) => setHuCropMin(Number(e.target.value))}
                onMouseUp={(e) => applyHuCrop(true, Number((e.target as HTMLInputElement).value), huCropMax)}
                style={{ flex: 1, height: 3 }} />
              <span style={{ fontSize: '10px', color: 'var(--text-muted)', width: 45, textAlign: 'right' }}>{huCropMin} HU</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: '10px', color: 'var(--text-muted)', width: 30 }}>Max</span>
              <input type="range" min={-500} max={3071} value={huCropMax}
                onChange={(e) => setHuCropMax(Number(e.target.value))}
                onMouseUp={(e) => applyHuCrop(true, huCropMin, Number((e.target as HTMLInputElement).value))}
                style={{ flex: 1, height: 3 }} />
              <span style={{ fontSize: '10px', color: 'var(--text-muted)', width: 45, textAlign: 'right' }}>{huCropMax} HU</span>
            </div>
          </div>
        )}
      </div>

      {/* Scalpel tool row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 0', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '10px', color: 'var(--text-muted)', flexShrink: 0 }}>Scalpel:</span>
        <button
          className={`render-mode-btn ${scalpelMode === 'draw' ? 'active' : ''}`}
          onClick={() => setScalpelMode(scalpelMode === 'draw' ? 'off' : 'draw')}
          title="Draw freehand to erase structures"
          style={{ fontSize: '10px', padding: '2px 8px', fontWeight: 600, color: scalpelMode === 'draw' ? '#ff3c3c' : undefined }}
        >
          {scalpelMode === 'draw' ? '[ Drawing... ]' : 'Erase'}
        </button>
        <button className="render-mode-btn" onClick={undoScalpel}
          title="Undo all scalpel edits" style={{ fontSize: '10px', padding: '2px 8px' }}
          disabled={!scalpelHasBackup}>Undo</button>
      </div>

      {/* Region Growing — seed-based 3D flood fill to isolate cardiac chambers */}
      <div style={{ padding: '4px 0', borderTop: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)', flexShrink: 0 }}>Isolate:</span>
          <button
            className={`render-mode-btn ${regionGrowMode === 'picking' ? 'active' : ''}`}
            onClick={() => {
              if (regionGrowMode === 'picking') { setRegionGrowMode('off'); setRegionGrowStatus(''); }
              else { setRegionGrowMode('picking'); setRegionGrowStatus('Click on 3D to place seed...'); }
            }}
            title="Click on the 3D volume to place a seed point, then region grow within HU range"
            style={{ fontSize: '10px', padding: '2px 8px', fontWeight: 600, color: regionGrowMode === 'picking' ? '#4fc3f7' : undefined }}
          >
            {regionGrowMode === 'picking' ? '[ Click to Seed... ]' : 'Seed'}
          </button>
          {/* Quick presets */}
          <button className="render-mode-btn" onClick={() => { setRegionGrowHuMin(100); setRegionGrowHuMax(500); }}
            title="Left atrium / ventricle (contrast blood 100-500 HU)" style={{ fontSize: '10px', padding: '2px 6px' }}>LA</button>
          <button className="render-mode-btn" onClick={() => { setRegionGrowHuMin(150); setRegionGrowHuMax(600); }}
            title="Aorta / great vessels (150-600 HU)" style={{ fontSize: '10px', padding: '2px 6px' }}>Aorta</button>
          <button className="render-mode-btn" onClick={() => { setRegionGrowHuMin(500); setRegionGrowHuMax(2000); }}
            title="Bone only (500-2000 HU)" style={{ fontSize: '10px', padding: '2px 6px' }}>Bone</button>
          <button className="render-mode-btn" onClick={undoScalpel}
            title="Undo — restore original volume" style={{ fontSize: '10px', padding: '2px 6px' }}
            disabled={!scalpelHasBackup}>Undo</button>
        </div>
        {/* HU range sliders */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 3 }}>
          <span style={{ fontSize: '9px', color: 'var(--text-muted)', width: 24 }}>Min</span>
          <input type="range" min={-500} max={1500} value={regionGrowHuMin}
            onChange={(e) => setRegionGrowHuMin(Number(e.target.value))}
            style={{ flex: 1, height: 2 }} />
          <span style={{ fontSize: '9px', color: 'var(--text-muted)', width: 45, textAlign: 'right' }}>{regionGrowHuMin}</span>
          <span style={{ fontSize: '9px', color: 'var(--text-muted)', width: 24 }}>Max</span>
          <input type="range" min={0} max={3071} value={regionGrowHuMax}
            onChange={(e) => setRegionGrowHuMax(Number(e.target.value))}
            style={{ flex: 1, height: 2 }} />
          <span style={{ fontSize: '9px', color: 'var(--text-muted)', width: 45, textAlign: 'right' }}>{regionGrowHuMax}</span>
        </div>
        {regionGrowStatus && (
          <div style={{ fontSize: '10px', color: regionGrowStatus.includes('Isolated') ? '#4caf50' : 'var(--text-muted)', marginTop: 2, padding: '2px 4px' }}>
            {regionGrowStatus}
          </div>
        )}
      </div>

      {/* Clipping Box */}
      <div style={{ padding: '4px 0', borderTop: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: clipEnabled ? 4 : 0 }}>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)', flexShrink: 0 }}>Clip:</span>
          <button
            className={`render-mode-btn ${clipEnabled ? 'active' : ''}`}
            onClick={() => { const next = !clipEnabled; setClipEnabled(next); applyClipBox(next, clipBox); }}
            style={{ fontSize: '10px', padding: '2px 8px', fontWeight: 600 }}
          >
            {clipEnabled ? 'ON' : 'OFF'}
          </button>
          <button className="render-mode-btn" onClick={() => {
            const b = { xMin: 15, xMax: 85, yMin: 5, yMax: 70, zMin: 25, zMax: 90 };
            setClipBox(b); setClipEnabled(true); applyClipBox(true, b);
          }} style={{ fontSize: '10px', padding: '2px 6px' }} title="Crop to center — remove chest wall">Center</button>
          <button className="render-mode-btn" onClick={() => {
            // LPS: Y+ = posterior (heart is anterior = low Y%), Z+ = superior (heart is upper chest = high Z%)
            const b = { xMin: 25, xMax: 80, yMin: 0, yMax: 55, zMin: 50, zMax: 90 };
            setClipBox(b); setClipEnabled(true); applyClipBox(true, b);
          }} style={{ fontSize: '10px', padding: '2px 6px' }} title="Isolate heart region (anterior, upper chest)">Heart</button>
          <button className="render-mode-btn" onClick={() => {
            const b = { xMin: 0, xMax: 100, yMin: 0, yMax: 100, zMin: 0, zMax: 100 };
            setClipBox(b); setClipEnabled(false); applyClipBox(false, b);
          }} style={{ fontSize: '10px', padding: '2px 6px' }}>Reset</button>
        </div>
        {clipEnabled && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {(['xMin', 'xMax', 'yMin', 'yMax', 'zMin', 'zMax'] as const).map(key => (
              <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: '9px', color: 'var(--text-muted)', width: 28, textAlign: 'right' }}>{key}</span>
                <input type="range" min={0} max={100} value={clipBox[key]}
                  onChange={(e) => setClipBox(prev => ({ ...prev, [key]: Number(e.target.value) }))}
                  onMouseUp={() => applyClipBox(true, clipBox)}
                  style={{ flex: 1, height: 2 }} />
                <span style={{ fontSize: '9px', color: 'var(--text-muted)', width: 24 }}>{clipBox[key]}%</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* C-arm angle display + quick angle views */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', borderTop: '1px solid var(--border)' }}>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)', flexShrink: 0 }}>Angle:</span>
        {cameraAngle && (
          <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--accent)', flexShrink: 0 }}>
            {cameraAngle.laoRao} / {cameraAngle.cranCaud}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button className="render-mode-btn" onClick={() => setAngleView(0, 0)} title="AP view">AP</button>
        <button className="render-mode-btn" onClick={() => setAngleView(30, 0)} title="LAO 30°">LAO30</button>
        <button className="render-mode-btn" onClick={() => setAngleView(-30, 0)} title="RAO 30°">RAO30</button>
        <button className="render-mode-btn" onClick={() => setAngleView(0, 30)} title="Cranial 30°">Cr30</button>
        <button className="render-mode-btn" onClick={() => setAngleView(0, -30)} title="Caudal 30°">Ca30</button>
        <button className="render-mode-btn" onClick={() => setAngleView(90, 0)} title="Left lateral">LAT</button>
      </div>

      {/* 3D Orientation presets */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '4px 0', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '10px', color: 'var(--text-muted)', flexShrink: 0 }}>Orient:</span>
        <button className="render-mode-btn" onClick={() => setOrientationView('anterior')} title="Anterior view" style={{ fontSize: '10px', padding: '2px 6px' }}>Ant</button>
        <button className="render-mode-btn" onClick={() => setOrientationView('posterior')} title="Posterior view" style={{ fontSize: '10px', padding: '2px 6px' }}>Post</button>
        <button className="render-mode-btn" onClick={() => setOrientationView('left')} title="Left view" style={{ fontSize: '10px', padding: '2px 6px' }}>Left</button>
        <button className="render-mode-btn" onClick={() => setOrientationView('right')} title="Right view" style={{ fontSize: '10px', padding: '2px 6px' }}>Right</button>
        <button className="render-mode-btn" onClick={() => setOrientationView('superior')} title="Superior view" style={{ fontSize: '10px', padding: '2px 6px' }}>Sup</button>
        <button className="render-mode-btn" onClick={() => setOrientationView('inferior')} title="Inferior view" style={{ fontSize: '10px', padding: '2px 6px' }}>Inf</button>
      </div>
    </div>
  );
}
