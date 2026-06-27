import { useState, useRef, useEffect, useCallback } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import {
  computeMrVoiRange,
  getScalarDataFromVolume,
  MR_PRESETS,
  MR_PRESETS_TUNED,
  type Preset,
} from '../windowLevel';

const CT_PRESETS: Preset[] = [
  { name: 'Soft Tissue', window: 400, level: 40, description: 'Default soft-tissue window' },
  { name: 'Bone', window: 1800, level: 400, description: 'Bone / spine' },
  { name: 'Lung', window: 1500, level: -600, description: 'Lung parenchyma' },
  { name: 'Brain', window: 80, level: 40, description: 'Brain parenchyma' },
  { name: 'Abdomen', window: 350, level: 40, description: 'Abdominal soft tissue' },
  { name: 'Mediastinum', window: 350, level: 50, description: 'Mediastinum' },
  { name: 'Liver', window: 150, level: 30, description: 'Liver / narrow soft tissue' },
  { name: 'CT Angio', window: 600, level: 100, description: 'Vascular contrast' },
  { name: 'Stroke', window: 40, level: 40, description: 'Narrow stroke window' },
];

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
  defaultPreset?: string;
  volumeKey?: string;
}

export function WindowLevelPresets({ renderingEngineId, viewportIds, modality, defaultPreset, volumeKey }: Props) {
  const mod = modality?.trim().toUpperCase() || '';
  const PRESETS = (mod === 'MR' || mod === 'MRI') ? MR_PRESETS : CT_PRESETS;
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [showColormap, setShowColormap] = useState(false);
  const [activeColormap, setActiveColormap] = useState('Grayscale');
  const [invertColors, setInvertColors] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const colormapRef = useRef<HTMLDivElement>(null);

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
    const tuned = isMR ? MR_PRESETS_TUNED.find((p) => p.name === preset.name) : undefined;
    if (tuned?.reset) {
      for (const vpId of getAllTargetVpIds()) {
        const viewport = engine.getViewport(vpId) as any;
        if (!viewport || viewport.type === cornerstone.Enums.ViewportType.VOLUME_3D) continue;
        try { viewport.resetProperties?.(); } catch { /* ignore */ }
        viewport.render();
      }
      setActivePreset(preset.name);
      setIsOpen(false);
      return;
    }

    let mrVoiRange: { lower: number; upper: number } | null = null;
    if (isMR && tuned) {
      try {
        const volume = cornerstone.cache.getVolume('cornerstoneStreamingImageVolume:myVolume') as any;
        mrVoiRange = computeMrVoiRange(getScalarDataFromVolume(volume), tuned.name);
      } catch { /* ignore */ }
      if (!mrVoiRange) return;
    }

    for (const vpId of getAllTargetVpIds()) {
      const viewport = engine.getViewport(vpId);
      if (!viewport || viewport.type === cornerstone.Enums.ViewportType.VOLUME_3D) continue;

      let lower: number;
      let upper: number;
      if (isMR && tuned && mrVoiRange) {
        lower = mrVoiRange.lower;
        upper = mrVoiRange.upper;
      } else {
        const w = preset.window;
        const l = preset.level;
        lower = l - w / 2;
        upper = l + w / 2;
      }

      (viewport as any).setProperties({ voiRange: { lower, upper } });
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
          const vp = viewport as any;
          if (vp.setColormap) {
            vp.setColormap(undefined);
          }
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
  }, [invertColors, renderingEngineId, getAllTargetVpIds]);

  useEffect(() => {
    if (!defaultPreset || !volumeKey) return;
    const preset = PRESETS.find((p) => p.name === defaultPreset);
    if (!preset) return;

    const apply = () => {
      const engine = cornerstone.getRenderingEngine(renderingEngineId);
      if (!engine) return;
      const ready = getAllTargetVpIds().some((id) => {
        try { return !!engine.getViewport(id); } catch { return false; }
      });
      if (ready) applyPreset(preset);
    };

    const onCompleted = () => apply();
    const onModified = () => apply();
    const target = cornerstone.eventTarget as unknown as EventTarget;
    target.addEventListener(cornerstone.Enums.Events.IMAGE_VOLUME_LOADING_COMPLETED, onCompleted);
    target.addEventListener(cornerstone.Enums.Events.IMAGE_VOLUME_MODIFIED, onModified);

    const timers = [600, 2000, 5000, 12000].map((ms) => setTimeout(apply, ms));

    return () => {
      target.removeEventListener(cornerstone.Enums.Events.IMAGE_VOLUME_LOADING_COMPLETED, onCompleted);
      target.removeEventListener(cornerstone.Enums.Events.IMAGE_VOLUME_MODIFIED, onModified);
      timers.forEach(clearTimeout);
    };
  }, [volumeKey, defaultPreset, PRESETS, renderingEngineId, getAllTargetVpIds, applyPreset]);

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
