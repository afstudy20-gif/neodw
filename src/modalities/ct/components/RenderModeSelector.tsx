import { useState, useEffect, useCallback, useRef } from 'react';
import * as cornerstone from '@cornerstonejs/core';

type ScalpelMode = 'off' | 'draw' | 'erase-rect';
type RenderMode = 'volume' | 'mip' | 'soft-tissue' | 'bone' | 'cardiac';

const PRESETS: { key: RenderMode; label: string; preset: string; description: string }[] = [
  { key: 'volume', label: 'Volume', preset: 'CT-Chest-Contrast-Enhanced', description: 'Standard volume rendering' },
  { key: 'mip', label: 'MIP', preset: 'CT-MIP', description: 'Maximum Intensity Projection' },
  { key: 'soft-tissue', label: 'Soft Tissue', preset: 'CT-Soft-Tissue', description: 'Soft tissue only — bone removed' },
  { key: 'bone', label: 'Bone', preset: 'CT-Bone', description: 'Bone structures only' },
  { key: 'cardiac', label: 'Cardiac', preset: 'CT-Cardiac', description: 'Cardiac optimized — bone removed' },
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
  const [mode, setMode] = useState<RenderMode>('volume');
  const [shadingPreset, setShadingPreset] = useState<ShadingPreset>('standard');
  const [showAdvanced, setShowAdvanced] = useState(false);

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
  const [ambient, setAmbient] = useState(0.1);
  const [diffuse, setDiffuse] = useState(0.9);
  const [specular, setSpecular] = useState(0.2);
  const [specularPower, setSpecularPower] = useState(10);
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
  const volumeBackupRef = useRef<{ data: Float32Array | Int16Array | null; saved: boolean }>({ data: null, saved: false });
  const isDrawingRef = useRef(false);

  // Save volume data backup for undo
  const saveVolumeBackup = useCallback(() => {
    if (volumeBackupRef.current.saved) return;
    const volume = cornerstone.cache.getVolume(volumeId) as any;
    if (!volume?.voxelManager) return;
    const data = volume.voxelManager.getCompleteScalarDataArray();
    if (!data) return;
    volumeBackupRef.current = { data: data.slice(), saved: true };
    console.log('[Scalpel] Volume backup saved, length:', data.length);
  }, [volumeId]);

  // Sync volume voxelManager data back to per-image cache.
  // The VTK streaming 3D texture reads from cache.getImage(imageId).voxelManager.getScalarData(),
  // NOT from the volume's voxelManager. So after modifying voxels in the volume,
  // we must also update the corresponding cached image data for changes to be visible in 3D.
  const syncVolumeToCachedImages = useCallback((volume: any, modifiedSlices?: Set<number>) => {
    const imageIds = volume.imageIds as string[];
    const vm = volume.voxelManager;
    const dims = volume.imageData.getDimensions();
    const cols = dims[0];
    const rows = dims[1];

    const slicesToSync = modifiedSlices || new Set(Array.from({ length: dims[2] }, (_, i) => i));
    let synced = 0;

    for (const k of slicesToSync) {
      if (k < 0 || k >= imageIds.length) continue;
      try {
        const cachedImage = cornerstone.cache.getImage(imageIds[k]);
        if (!cachedImage) continue;
        // Get the cached image's scalar data array
        const sliceData = (cachedImage as any).voxelManager?.getScalarData?.()
                       || (cachedImage as any).getPixelData?.();
        if (!sliceData) continue;
        // Copy modified voxels from volume voxelManager to cached image
        for (let j = 0; j < rows; j++) {
          for (let i = 0; i < cols; i++) {
            sliceData[j * cols + i] = vm.getAtIJK(i, j, k);
          }
        }
        synced++;
      } catch { /* skip inaccessible images */ }
    }
    console.log(`[Scalpel] Synced ${synced} slices to image cache`);
  }, []);

  // Undo scalpel: restore original volume data + sync to cached images
  const undoScalpel = useCallback(() => {
    const backup = volumeBackupRef.current;
    if (!backup.saved || !backup.data) return;
    const volume = cornerstone.cache.getVolume(volumeId) as any;
    if (!volume?.voxelManager) return;
    volume.voxelManager.setCompleteScalarDataArray(backup.data);

    // Sync ALL slices back to per-image cache so 3D texture picks up restored data
    syncVolumeToCachedImages(volume);

    // Force 3D texture update
    const viewport = getViewport3d();
    if (viewport) {
      if (volume.imageData) volume.imageData.modified();
      const actor = viewport.getDefaultActor()?.actor;
      const mapper = actor?.getMapper?.();
      if (mapper) (mapper as any).modified?.();
      viewport.render();
    }
    volumeBackupRef.current = { data: null, saved: false };
    console.log('[Scalpel] Volume restored from backup');
  }, [volumeId, syncVolumeToCachedImages]);

  // Apply scalpel: erase voxels under the drawn region via ray-march
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
    const vm = volume.voxelManager;
    const dims = imageData.getDimensions();
    const spacing = imageData.getSpacing();

    // Camera direction
    const camDir = [
      cam.focalPoint[0] - cam.position[0],
      cam.focalPoint[1] - cam.position[1],
      cam.focalPoint[2] - cam.position[2],
    ];
    const camLen = Math.sqrt(camDir[0] ** 2 + camDir[1] ** 2 + camDir[2] ** 2);
    camDir[0] /= camLen; camDir[1] /= camLen; camDir[2] /= camLen;

    // Build bounding box of drawn region
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [px, py] of canvasPoints) {
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }

    // Point-in-polygon test (ray casting algorithm)
    const pointInPoly = (x: number, y: number): boolean => {
      let inside = false;
      const n = canvasPoints.length;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const [xi, yi] = canvasPoints[i];
        const [xj, yj] = canvasPoints[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
      return inside;
    };

    // Sample canvas points at ~2px spacing within bounding box
    const step = 2;
    const rayStep = Math.min(spacing[0], spacing[1], spacing[2]) * 0.7;
    const maxDist = camLen * 2.5;
    let erased = 0;
    const AIR_HU = -1024;
    const modifiedSlices = new Set<number>();

    for (let cx = Math.floor(minX); cx <= Math.ceil(maxX); cx += step) {
      for (let cy = Math.floor(minY); cy <= Math.ceil(maxY); cy += step) {
        if (!pointInPoly(cx, cy)) continue;

        // Get world point at this canvas position
        const worldTarget = (viewport as any).canvasToWorld?.([cx, cy]);
        if (!worldTarget) continue;

        // Ray direction from camera through this point
        const dir = [
          worldTarget[0] - cam.position![0],
          worldTarget[1] - cam.position![1],
          worldTarget[2] - cam.position![2],
        ];
        const dLen = Math.sqrt(dir[0] ** 2 + dir[1] ** 2 + dir[2] ** 2);
        dir[0] /= dLen; dir[1] /= dLen; dir[2] /= dLen;

        // March along ray, erase ALL non-air voxels
        for (let d = camLen * 0.1; d < maxDist; d += rayStep) {
          const wx = cam.position![0] + dir[0] * d;
          const wy = cam.position![1] + dir[1] * d;
          const wz = cam.position![2] + dir[2] * d;

          const ijk = imageData.worldToIndex([wx, wy, wz]);
          const i = Math.round(ijk[0]);
          const j = Math.round(ijk[1]);
          const k = Math.round(ijk[2]);

          if (i < 0 || i >= dims[0] || j < 0 || j >= dims[1] || k < 0 || k >= dims[2]) continue;

          const hu = vm.getAtIJK(i, j, k);
          if (hu > -200) { // non-air
            vm.setAtIJK(i, j, k, AIR_HU);
            modifiedSlices.add(k);
            erased++;
          }
        }
      }
    }

    if (erased > 0) {
      // CRITICAL: Sync modified slices to per-image cache so the streaming
      // 3D texture picks up the changes. Without this, erased voxels are
      // invisible because the GPU texture reads from cached image data.
      syncVolumeToCachedImages(volume, modifiedSlices);

      imageData.modified();
      // Force mapper to detect data change and rebuild scalar texture
      const actor = viewport.getDefaultActor()?.actor;
      const mapper = actor?.getMapper?.();
      if (mapper) (mapper as any).modified?.();
      viewport.render();
      console.log(`[Scalpel] Erased ${erased} voxels across ${modifiedSlices.size} slices`);
    }
  }, [volumeId, saveVolumeBackup, syncVolumeToCachedImages]);

  // Setup/teardown scalpel canvas overlay on 3D viewport
  useEffect(() => {
    const viewport = getViewport3d();

    if (scalpelMode === 'off') {
      // Remove canvas & re-enable VTK interactor
      if (scalpelCanvasRef.current) {
        scalpelCanvasRef.current.remove();
        scalpelCanvasRef.current = null;
      }
      // Re-enable VTK interactor
      try {
        const renderer = (viewport as any)?.getRenderer?.();
        const interactor = renderer?.getRenderWindow?.()?.getInteractor?.();
        if (interactor) interactor.setEnabled(true);
      } catch { /* ignore */ }
      return;
    }

    if (!viewport?.element) return;
    const el = viewport.element;

    // DISABLE VTK interactor so it doesn't steal mouse events
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
      canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:55;cursor:crosshair;';
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

    // Use DOCUMENT-level listeners to bypass any VTK event capturing.
    // Filter by checking if mouse is within the canvas bounding rect.
    const isInCanvas = (e: MouseEvent) => {
      const rect = canvas!.getBoundingClientRect();
      return e.clientX >= rect.left && e.clientX <= rect.right &&
             e.clientY >= rect.top && e.clientY <= rect.bottom;
    };

    const toLocal = (e: MouseEvent): [number, number] => {
      const rect = canvas!.getBoundingClientRect();
      return [e.clientX - rect.left, e.clientY - rect.top];
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || !isInCanvas(e)) return;
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
      const mapper = actor?.getMapper?.();
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
    const vm = volume.voxelManager;
    const dims = imageData.getDimensions();
    const [nx, ny, nz] = dims;
    const totalVoxels = nx * ny * nz;

    // Verify seed is in range
    const seedHU = vm.getAtIJK(seedIJK[0], seedIJK[1], seedIJK[2]);
    if (seedHU < minHU || seedHU > maxHU) {
      setRegionGrowStatus(`Seed HU=${seedHU} outside range [${minHU}, ${maxHU}]`);
      return;
    }

    // BFS flood fill — use Uint8Array as visited mask
    const mask = new Uint8Array(totalVoxels); // 0 = not in region, 1 = in region
    const toIdx = (i: number, j: number, k: number) => k * nx * ny + j * nx + i;

    const queue: number[] = []; // flat indices
    const seedIdx = toIdx(seedIJK[0], seedIJK[1], seedIJK[2]);
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
        const hu = vm.getAtIJK(ni, nj, nk);
        if (hu >= minHU && hu <= maxHU) {
          mask[nIdx] = 1;
          queue.push(nIdx);
        }
      }
    }

    console.log(`[RegionGrow] Found ${regionSize} voxels in region`);

    // Erase everything OUTSIDE the region
    const AIR_HU = -1024;
    let erased = 0;
    const modifiedSlices = new Set<number>();
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const idx = toIdx(i, j, k);
          if (!mask[idx] && vm.getAtIJK(i, j, k) > -200) {
            vm.setAtIJK(i, j, k, AIR_HU);
            modifiedSlices.add(k);
            erased++;
          }
        }
      }
    }

    console.log(`[RegionGrow] Erased ${erased} voxels outside region`);

    // Sync to cached images
    syncVolumeToCachedImages(volume, modifiedSlices);

    imageData.modified();
    const actor = viewport.getDefaultActor()?.actor;
    const mapper = actor?.getMapper?.();
    if (mapper) (mapper as any).modified?.();
    viewport.render();

    setRegionGrowStatus(`Isolated ${regionSize.toLocaleString()} voxels (${modifiedSlices.size} slices)`);
  }, [volumeId, saveVolumeBackup, syncVolumeToCachedImages]);

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
          disabled={!volumeBackupRef.current.saved}>Undo</button>
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
            disabled={!volumeBackupRef.current.saved}>Undo</button>
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
