import { useState, useCallback, useRef } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';

interface TissuePreset {
  name: string;
  minHU: number;
  maxHU: number;
  color: string;
  rgba: [number, number, number, number];
}

const TISSUE_PRESETS: TissuePreset[] = [
  { name: 'Epicardial Fat', minHU: -200, maxHU: -30, color: '#FFD700', rgba: [255, 215, 0, 128] },
  { name: 'Pericardium', minHU: -44, maxHU: -1, color: '#00BFFF', rgba: [0, 191, 255, 128] },
  { name: 'Soft Tissue', minHU: -100, maxHU: 100, color: '#FF6B6B', rgba: [255, 107, 107, 128] },
  { name: 'Bone', minHU: 200, maxHU: 3000, color: '#FFFFFF', rgba: [255, 255, 255, 128] },
  { name: 'Blood/Contrast', minHU: 100, maxHU: 400, color: '#FF4444', rgba: [255, 68, 68, 128] },
];

const SEGMENTATION_ID = 'huThresholdSegmentation';
const MPR_VIEWPORT_IDS = ['axial', 'sagittal', 'coronal'];

interface Props {
  renderingEngineId: string;
  volumeId: string;
  isVisible: boolean;
  onToggle: () => void;
  onVolumeCalculated: (name: string, volumeCm3: number) => void;
}

export function SegmentationPanel({
  renderingEngineId,
  volumeId,
  isVisible,
  onToggle,
  onVolumeCalculated,
}: Props) {
  const [minHU, setMinHU] = useState(-200);
  const [maxHU, setMaxHU] = useState(-30);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [segmentationActive, setSegmentationActive] = useState(false);
  const segLabelmapVolumeRef = useRef<string | null>(null);

  const applyThreshold = useCallback(
    async (min: number, max: number, presetName?: string, color?: [number, number, number, number]) => {
      setMinHU(min);
      setMaxHU(max);
      setActivePreset(presetName || null);

      const sourceVolume = cornerstone.cache.getVolume(volumeId);
      if (!sourceVolume) return;

      const sourceData = sourceVolume.voxelManager?.getCompleteScalarDataArray?.();
      if (!sourceData) return;

      const { spacing } = sourceVolume;
      const voxelVolumeMm3 = spacing[0] * spacing[1] * spacing[2];

      // Count voxels in range and calculate volume
      let voxelCount = 0;
      for (let i = 0; i < sourceData.length; i++) {
        if (sourceData[i] >= min && sourceData[i] <= max) {
          voxelCount++;
        }
      }
      const volumeCm3 = (voxelCount * voxelVolumeMm3) / 1000;
      onVolumeCalculated(presetName || `Custom (${min} to ${max} HU)`, volumeCm3);

      // Create or update labelmap segmentation
      try {
        await createLabelmapSegmentation(sourceVolume, sourceData, min, max, color || [255, 215, 0, 128]);
        setSegmentationActive(true);
      } catch (err) {
        console.error('[SEG] Failed to create segmentation overlay:', err);
        // Volume calculation still succeeded even if overlay fails
        setSegmentationActive(true);
      }
    },
    [volumeId, onVolumeCalculated]
  );

  const createLabelmapSegmentation = async (
    sourceVolume: cornerstone.Types.IImageVolume | cornerstone.Types.IStreamingImageVolume,
    sourceData: ArrayLike<number>,
    min: number,
    max: number,
    color: [number, number, number, number]
  ) => {
    const { segmentation } = cornerstoneTools;
    const segmentationId = SEGMENTATION_ID;

    // Remove existing segmentation if any
    if (segLabelmapVolumeRef.current) {
      try {
        segmentation.removeSegmentation(segmentationId);
      } catch {
        // ignore
      }
      try {
        cornerstone.cache.removeVolumeLoadObject(segLabelmapVolumeRef.current);
      } catch {
        // ignore
      }
      segLabelmapVolumeRef.current = null;
    }

    // Create a new labelmap volume with same dimensions as source
    const labelmapVolumeId = `${volumeId}_labelmap_${Date.now()}`;
    const labelmapVolume = cornerstone.volumeLoader.createAndCacheDerivedLabelmapVolume(
      volumeId,
      { volumeId: labelmapVolumeId }
    );

    // Fill the labelmap: 1 where HU is in range, 0 otherwise
    const labelmapData = labelmapVolume.voxelManager?.getCompleteScalarDataArray?.();
    if (labelmapData) {
      for (let i = 0; i < sourceData.length; i++) {
        (labelmapData as any)[i] = (sourceData[i] >= min && sourceData[i] <= max) ? 1 : 0;
      }
    }

    segLabelmapVolumeRef.current = labelmapVolumeId;

    // Add segmentation
    segmentation.addSegmentations([
      {
        segmentationId,
        representation: {
          type: cornerstoneTools.Enums.SegmentationRepresentations.Labelmap,
          data: {
            volumeId: labelmapVolumeId,
          },
        },
      },
    ]);

    // Add representation to each MPR viewport
    for (const viewportId of MPR_VIEWPORT_IDS) {
      await segmentation.addLabelmapRepresentationToViewport(viewportId, [
        {
          segmentationId,
          config: {
            colorLUTOrIndex: [
              [0, 0, 0, 0],      // segment 0 (background) — transparent
              color,              // segment 1 (thresholded region)
            ] as any,
          },
        },
      ]);
    }

    // Render
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    engine?.renderViewports(MPR_VIEWPORT_IDS);
  };

  const clearSegmentation = useCallback(() => {
    const { segmentation } = cornerstoneTools;

    // Remove representations from all viewports
    for (const viewportId of MPR_VIEWPORT_IDS) {
      try {
        segmentation.removeSegmentationRepresentations(viewportId, {
          segmentationId: SEGMENTATION_ID,
        });
      } catch {
        // ignore
      }
    }

    try {
      segmentation.removeSegmentation(SEGMENTATION_ID);
    } catch {
      // ignore
    }

    if (segLabelmapVolumeRef.current) {
      try {
        cornerstone.cache.removeVolumeLoadObject(segLabelmapVolumeRef.current);
      } catch {
        // ignore
      }
      segLabelmapVolumeRef.current = null;
    }

    setSegmentationActive(false);
    setActivePreset(null);

    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    engine?.renderViewports(MPR_VIEWPORT_IDS);
  }, [renderingEngineId]);

  if (!isVisible) {
    return (
      <button className="seg-toggle" onClick={onToggle} title="Segmentation">
        Seg
      </button>
    );
  }

  return (
    <div className="segmentation-panel">
      <div className="seg-header">
        <h3>HU Segmentation</h3>
        <button className="seg-close" onClick={onToggle}>✕</button>
      </div>

      <div className="seg-section">
        <h4>Tissue Presets</h4>
        {TISSUE_PRESETS.map((preset) => (
          <button
            key={preset.name}
            className={`seg-preset-btn ${activePreset === preset.name ? 'active' : ''}`}
            onClick={() => applyThreshold(preset.minHU, preset.maxHU, preset.name, preset.rgba)}
            style={{ borderLeftColor: preset.color }}
          >
            <span className="seg-preset-name">{preset.name}</span>
            <span className="seg-preset-range">{preset.minHU} to {preset.maxHU} HU</span>
          </button>
        ))}
      </div>

      <div className="seg-section">
        <h4>Custom Range</h4>
        <div className="seg-range-inputs">
          <label>
            Min HU
            <input
              type="number"
              value={minHU}
              onChange={(e) => setMinHU(Number(e.target.value))}
            />
          </label>
          <label>
            Max HU
            <input
              type="number"
              value={maxHU}
              onChange={(e) => setMaxHU(Number(e.target.value))}
            />
          </label>
        </div>
        <div className="seg-range-slider">
          <input
            type="range"
            min={-1024}
            max={3071}
            value={minHU}
            onChange={(e) => setMinHU(Number(e.target.value))}
          />
          <input
            type="range"
            min={-1024}
            max={3071}
            value={maxHU}
            onChange={(e) => setMaxHU(Number(e.target.value))}
          />
        </div>
        <button
          className="seg-apply-btn"
          onClick={() => applyThreshold(minHU, maxHU)}
        >
          Apply Threshold
        </button>
      </div>

      {segmentationActive && (
        <button className="seg-clear-btn" onClick={clearSegmentation}>
          Clear Segmentation
        </button>
      )}
    </div>
  );
}
