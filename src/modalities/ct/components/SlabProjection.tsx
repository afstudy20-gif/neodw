import { useCallback, useEffect, useState } from 'react';
import * as cornerstone from '@cornerstonejs/core';

type SlabMode = 'composite' | 'mip' | 'minip' | 'avg';

const MODES: { key: SlabMode; label: string; tip: string }[] = [
  { key: 'composite', label: 'Thin', tip: 'Single slice (no slab)' },
  { key: 'mip', label: 'MIP', tip: 'Maximum intensity — vessels, calcium' },
  { key: 'minip', label: 'MinIP', tip: 'Minimum intensity — airways, gas' },
  { key: 'avg', label: 'Avg', tip: 'Average — noise reduction' },
];

interface Props {
  renderingEngineId: string;
  viewportIds: string[];
}

function modeToBlend(mode: SlabMode): cornerstone.Enums.BlendModes {
  const M = cornerstone.Enums.BlendModes;
  switch (mode) {
    case 'mip': return M.MAXIMUM_INTENSITY_BLEND;
    case 'minip': return M.MINIMUM_INTENSITY_BLEND;
    case 'avg': return M.AVERAGE_INTENSITY_BLEND;
    default: return M.COMPOSITE;
  }
}

export function SlabProjection({ renderingEngineId, viewportIds }: Props) {
  const [mode, setMode] = useState<SlabMode>('composite');
  const [thickness, setThickness] = useState(10);

  const apply = useCallback((newMode: SlabMode, newThickness: number) => {
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    if (!engine) return;
    const blendMode = modeToBlend(newMode);
    for (const id of viewportIds) {
      const vp = engine.getViewport(id) as cornerstone.Types.IVolumeViewport | undefined;
      if (!vp || !vp.setBlendMode) continue;
      try {
        vp.setBlendMode(blendMode);
        if (newMode === 'composite') {
          vp.resetSlabThickness?.();
        } else {
          vp.setSlabThickness?.(Math.max(0.1, newThickness));
        }
        vp.render();
      } catch (e) {
        console.warn('[SlabProjection] could not apply to', id, e);
      }
    }
  }, [renderingEngineId, viewportIds]);

  useEffect(() => {
    apply(mode, thickness);
  }, [apply, mode, thickness]);

  return (
    <div className="slab-projection">
      <div className="slab-projection-head">
        <span className="slab-projection-title">Slab Projection</span>
      </div>
      <div className="slab-projection-modes">
        {MODES.map((m) => (
          <button
            key={m.key}
            className={`slab-projection-btn ${mode === m.key ? 'active' : ''}`}
            onClick={() => setMode(m.key)}
            title={m.tip}
          >
            {m.label}
          </button>
        ))}
      </div>
      <label className={`slab-projection-thickness ${mode === 'composite' ? 'disabled' : ''}`}>
        <span>Thickness</span>
        <input
          type="range"
          min={1}
          max={100}
          step={1}
          value={thickness}
          disabled={mode === 'composite'}
          onChange={(e) => setThickness(Number.parseInt(e.target.value, 10))}
        />
        <span className="slab-projection-value">{thickness} mm</span>
      </label>
    </div>
  );
}
