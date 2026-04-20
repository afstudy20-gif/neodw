import { useState, useRef, useEffect, useCallback } from 'react';
import * as cornerstone from '@cornerstonejs/core';

interface Preset {
  name: string;
  window: number;
  level: number;
  description: string;
}

const CT_PRESETS: Preset[] = [
  { name: 'Default', window: 700, level: 350, description: 'Coronary arteries (standard)' },
  { name: 'Lung', window: 1500, level: -600, description: 'Lung parenchyma' },
  { name: 'Abdomen', window: 400, level: 40, description: 'Soft tissue' },
  { name: 'Mediastinum', window: 350, level: 50, description: 'Mediastinal' },
  { name: 'Chest', window: 800, level: 200, description: 'Thorax overview' },
  { name: 'Bone', window: 2000, level: 300, description: 'Bone structures' },
  { name: 'CT Angio', window: 600, level: 300, description: 'Vascular contrast' },
  { name: 'TAVI', window: 555, level: 208, description: 'Aortic valve planning' },
  { name: 'Cardiac Fat', window: 170, level: -115, description: 'Epicardial fat' },
];

const MR_PRESETS: Preset[] = [
  { name: 'Default', window: 800, level: 400, description: 'T1 weighted — anatomy' },
  { name: 'T2', window: 1200, level: 600, description: 'T2 weighted — fluid bright' },
  { name: 'STIR/PD', window: 1500, level: 750, description: 'STIR / Proton Density' },
  { name: 'Tendon', window: 450, level: 225, description: 'Tendons (T1/PD)' },
  { name: 'Ligament', window: 350, level: 175, description: 'Ligaments (SL, TFCC)' },
  { name: 'Bone Marrow', window: 700, level: 350, description: 'Bone marrow edema' },
  { name: 'Edema', window: 1800, level: 900, description: 'Fluid/edema (STIR)' },
  { name: 'Nerve', window: 400, level: 200, description: 'Peripheral nerve' },
  { name: 'Bright', window: 2000, level: 1000, description: 'High signal overview' },
];

// Colormaps — VTK.js preset names
const COLORMAPS = [
  'Grayscale',
  'hsv', 'jet', 'rainbow', 'Warm to Cool', 'Cool to Warm',
  'Inferno (matplotlib)', 'Viridis (matplotlib)', 'Plasma (matplotlib)',
  'Black-Body Radiation', 'X Ray', 'bone_Matlab',
];

interface Props {
  renderingEngineId: string;
  viewportIds: string[];
  modality?: string;
}

export function WindowLevelPresets({ renderingEngineId, viewportIds, modality }: Props) {
  const mod = modality?.trim().toUpperCase() || '';
  const PRESETS = (mod === 'MR' || mod === 'MRI') ? MR_PRESETS : CT_PRESETS;
  const [activePreset, setActivePreset] = useState<string | null>('Default');
  const [isOpen, setIsOpen] = useState(false);
  const [showColormap, setShowColormap] = useState(false);
  const [activeColormap, setActiveColormap] = useState('Grayscale');
  const [invertColors, setInvertColors] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const colormapRef = useRef<HTMLDivElement>(null);

  // Get all target viewport IDs including stack2d if it exists
  const getAllTargetVpIds = useCallback(() => {
    const ids = [...viewportIds];
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    if (engine) {
      try { if (engine.getViewport('stack2d')) ids.push('stack2d'); } catch {}
    }
    return ids;
  }, [renderingEngineId, viewportIds]);

  const applyPreset = useCallback((preset: Preset) => {
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    if (!engine) return;

    const isMR = (mod === 'MR' || mod === 'MRI');
    let dataMax = 2000;
    if (isMR) {
      try {
        const volume = cornerstone.cache.getVolume('cornerstoneStreamingImageVolume:myVolume') as any;
        if (volume?.voxelManager) {
          const range = volume.voxelManager.getRange();
          if (range) dataMax = range[1];
        }
      } catch { /* ignore */ }
    }

    for (const vpId of getAllTargetVpIds()) {
      const viewport = engine.getViewport(vpId);
      if (!viewport || viewport.type === cornerstone.Enums.ViewportType.VOLUME_3D) continue;

      let w = preset.window;
      let l = preset.level;
      if (isMR) {
        const scale = dataMax / 2000;
        w = Math.round(preset.window * scale);
        l = Math.round(preset.level * scale);
      }

      (viewport as any).setProperties({
        voiRange: { lower: l - w / 2, upper: l + w / 2 },
      });
      viewport.render();
    }
    setActivePreset(preset.name);
    setIsOpen(false);
  }, [renderingEngineId, mod, getAllTargetVpIds]);

  const applyColormap = useCallback((name: string) => {
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    if (!engine) return;
    for (const vpId of getAllTargetVpIds()) {
      const viewport = engine.getViewport(vpId);
      if (!viewport || viewport.type === cornerstone.Enums.ViewportType.VOLUME_3D) continue;
      try {
        if (name === 'Grayscale') {
          // Remove colormap — try multiple approaches
          const vp = viewport as any;
          if (vp.setColormap) {
            vp.setColormap(undefined);
          }
          // Also reset via the actor's color transfer function
          try {
            const actor = vp.getDefaultActor?.()?.actor;
            if (actor) {
              const property = actor.getProperty?.();
              if (property) {
                const cfun = property.getRGBTransferFunction?.(0);
                if (cfun) {
                  cfun.removeAllPoints();
                  cfun.addRGBPoint(0, 0, 0, 0);
                  cfun.addRGBPoint(1, 1, 1, 1);
                  property.modified();
                }
              }
            }
          } catch {}
          vp.setProperties({ invert: invertColors });
        } else {
          (viewport as any).setProperties({ colormap: { name } as any });
        }
        viewport.render();
      } catch { /* ignore */ }
    }
    setActiveColormap(name);
    setShowColormap(false);
  }, [renderingEngineId, invertColors, getAllTargetVpIds]);

  const toggleInvert = useCallback(() => {
    const next = !invertColors;
    setInvertColors(next);
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    if (!engine) return;
    for (const vpId of getAllTargetVpIds()) {
      const viewport = engine.getViewport(vpId);
      if (!viewport || viewport.type === cornerstone.Enums.ViewportType.VOLUME_3D) continue;
      (viewport as any).setProperties({ invert: next });
      viewport.render();
    }
  }, [invertColors, renderingEngineId, viewportIds]);

  // Number key shortcuts (1-9) for presets
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const num = parseInt(e.key);
      if (num >= 1 && num <= PRESETS.length) {
        e.preventDefault();
        applyPreset(PRESETS[num - 1]);
      }
      if (e.key === 'i' || e.key === 'I') {
        toggleInvert();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [PRESETS, applyPreset, toggleInvert]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen && !showColormap) return;
    const handler = (e: MouseEvent) => {
      if (isOpen && dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setIsOpen(false);
      if (showColormap && colormapRef.current && !colormapRef.current.contains(e.target as Node)) setShowColormap(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen, showColormap]);

  const itemStyle = (active: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    width: '100%', padding: '7px 12px', background: 'none', border: 'none',
    color: active ? 'var(--accent)' : 'var(--text-primary)', cursor: 'pointer',
    fontSize: '13px', textAlign: 'left',
  });

  return (
    <>
      {/* W/L Presets */}
      <div className="wl-dropdown" ref={dropdownRef} style={{ position: 'relative' }}>
        <button
          className={`toolbar-btn ${isOpen ? 'active' : ''}`}
          onClick={() => { setIsOpen(!isOpen); setShowColormap(false); }}
          title="Window/Level Presets (1-9)"
        >
          <span className="tool-icon">◐</span>
          <span className="tool-label">{activePreset || 'W/L'}</span>
          <span style={{ fontSize: '8px', marginLeft: 2 }}>{isOpen ? '▲' : '▼'}</span>
        </button>
        {isOpen && (
          <div style={{
            position: 'absolute', top: '100%', left: 0, zIndex: 100, minWidth: 200,
            background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)', padding: '4px 0',
            color: 'var(--text-primary)',
          }}>
            {PRESETS.map((preset, idx) => (
              <button
                key={preset.name}
                style={itemStyle(activePreset === preset.name)}
                onClick={() => applyPreset(preset)}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'color-mix(in oklch, var(--nd-ink) 6%, transparent)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
              >
                <span>
                  {activePreset === preset.name && <span style={{ marginRight: 6 }}>&#10003;</span>}
                  {preset.name}
                </span>
                <span style={{ color: 'var(--text-muted)', fontSize: '12px', fontWeight: 600 }}>{idx + 1}</span>
              </button>
            ))}
            <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
            <button
              style={itemStyle(invertColors)}
              onClick={toggleInvert}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'color-mix(in oklch, var(--nd-ink) 6%, transparent)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
            >
              <span>{invertColors && <span style={{ marginRight: 6 }}>&#10003;</span>}Negative</span>
              <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>I</span>
            </button>
          </div>
        )}
      </div>

      {/* Colormap */}
      <div ref={colormapRef} style={{ position: 'relative' }}>
        <button
          className={`toolbar-btn ${showColormap ? 'active' : ''}`}
          onClick={() => { setShowColormap(!showColormap); setIsOpen(false); }}
          title="Pseudo Color Map"
        >
          <span className="tool-icon" style={{ background: 'linear-gradient(90deg, #000, #f00, #ff0, #fff)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', fontWeight: 900 }}>C</span>
          <span className="tool-label">Color</span>
          <span style={{ fontSize: '8px', marginLeft: 2 }}>{showColormap ? '▲' : '▼'}</span>
        </button>
        {showColormap && (
          <div style={{
            position: 'absolute', top: '100%', left: 0, zIndex: 100, minWidth: 180,
            background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)', padding: '4px 0',
            color: 'var(--text-primary)',
          }}>
            {COLORMAPS.map(cm => (
              <button
                key={cm}
                style={itemStyle(activeColormap === cm)}
                onClick={() => applyColormap(cm)}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'color-mix(in oklch, var(--nd-ink) 6%, transparent)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
              >
                <span>{activeColormap === cm && <span style={{ marginRight: 6 }}>&#10003;</span>}{cm}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
