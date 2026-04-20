import { useState, useEffect, useCallback, useRef } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import { setActiveTool, resetCrosshairsToCenter, centerViewportsOnCrosshairs, ToolName } from '../core/toolManager';

const tools: { name: ToolName; label: string; icon: string; shortcut: string; key: string }[] = [
  { name: 'Crosshairs', label: 'Crosshairs', icon: '+', shortcut: 'C', key: 'c' },
  { name: 'WindowLevel', label: 'W/L', icon: '◐', shortcut: 'W', key: 'w' },
  { name: 'Pan', label: 'Pan', icon: '✋', shortcut: 'H', key: 'h' },
  { name: 'Zoom', label: 'Zoom', icon: '🔍', shortcut: 'Z', key: 'z' },
  { name: 'Length', label: 'Measure', icon: '📏', shortcut: 'M', key: 'm' },
  { name: 'ArrowAnnotate', label: 'Arrow', icon: '➜', shortcut: 'A', key: 'a' },
  { name: 'Angle', label: 'Angle', icon: '∠', shortcut: 'G', key: 'g' },
];

const MPR_VP_IDS = ['axial', 'sagittal', 'coronal'];
const VOLUME_ID = 'cornerstoneStreamingImageVolume:myVolume';

interface Props {
  renderingEngineId: string;
  onReset?: () => void;
  onSwitchToMPR?: () => void;
  isStack2D?: boolean;
}

export function Toolbar({ renderingEngineId, onReset, onSwitchToMPR, isStack2D }: Props) {
  const [activeTool, setActive] = useState<ToolName>('Crosshairs');
  const [mipEnabled, setMipEnabled] = useState(true);
  const [slabThickness, setSlabThickness] = useState(5);

  // View settings
  const [showViewMenu, setShowViewMenu] = useState(false);
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [hidePatientInfo, setHidePatientInfo] = useState(false);
  const [showCrossRef, setShowCrossRef] = useState(true);
  const viewMenuRef = useRef<HTMLDivElement>(null);

  // Cine player state
  const [cineActive, setCineActive] = useState(false);
  const [cineVpId, setCineVpId] = useState('axial');
  const [cineFps, setCineFps] = useState(15);
  const cineTimerRef = useRef<number | null>(null);

  const handleToolClick = useCallback((name: ToolName) => {
    setActiveTool(name);
    setActive(name);
  }, []);

  const handleCenter = useCallback(() => {
    centerViewportsOnCrosshairs(renderingEngineId);
  }, [renderingEngineId]);

  // ── Slab MIP controls ──
  const applyMip = useCallback((enabled: boolean, thickness: number) => {
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    if (!engine) return;
    for (const vpId of MPR_VP_IDS) {
      const vp = engine.getViewport(vpId) as cornerstone.Types.IVolumeViewport | undefined;
      if (!vp || !('setBlendMode' in vp)) continue;
      if (enabled) {
        (vp as any).setBlendMode(cornerstone.Enums.BlendModes.MAXIMUM_INTENSITY_BLEND);
        (vp as any).setSlabThickness(thickness);
      } else {
        (vp as any).setBlendMode(cornerstone.Enums.BlendModes.COMPOSITE);
        (vp as any).resetSlabThickness?.();
      }
      vp.render();
    }
  }, [renderingEngineId]);

  const toggleMip = useCallback(() => {
    const newVal = !mipEnabled;
    setMipEnabled(newVal);
    applyMip(newVal, slabThickness);
  }, [mipEnabled, slabThickness, applyMip]);

  const handleSlabChange = useCallback((newThickness: number) => {
    setSlabThickness(newThickness);
    if (mipEnabled) applyMip(true, newThickness);
  }, [mipEnabled, applyMip]);

  const handleReset = useCallback(() => {
    if (onReset) onReset();
    setMipEnabled(false);
    setSlabThickness(5);
    applyMip(false, 5);
    stopCine();
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    if (!engine) return;
    for (const vpId of ['axial', 'sagittal', 'coronal', 'volume3d']) {
      const vp = engine.getViewport(vpId) as any;
      if (!vp) continue;
      // Reset colormap
      try { if (vp.setColormap) vp.setColormap(undefined); } catch {}
      try { vp.setProperties({ invert: false }); } catch {}
      vp.resetCamera();
      vp.render();
    }
    setTimeout(() => resetCrosshairsToCenter(renderingEngineId), 100);
  }, [renderingEngineId, onReset, applyMip]);

  // ── Cine player ──
  const scrollViewport = useCallback((vpId: string, delta: number) => {
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    if (!engine) return;

    // Check if stack2d viewport exists (2D mode)
    const stackVp = engine.getViewport('stack2d') as cornerstone.Types.IStackViewport | undefined;
    if (stackVp && stackVp.type === cornerstone.Enums.ViewportType.STACK) {
      const currentIdx = stackVp.getCurrentImageIdIndex();
      const imageIds = (stackVp as any).getImageIds?.() || [];
      const newIdx = Math.max(0, Math.min(imageIds.length - 1, currentIdx + delta));
      if (newIdx !== currentIdx) {
        stackVp.setImageIdIndex(newIdx);
      }
      return;
    }

    // Volume viewport scroll
    const vp = engine.getViewport(vpId) as cornerstone.Types.IVolumeViewport | undefined;
    if (!vp) return;
    const cam = vp.getCamera();
    if (!cam.viewPlaneNormal || !cam.focalPoint || !cam.position) return;
    const volume = cornerstone.cache.getVolume(VOLUME_ID);
    const spacing = volume?.imageData?.getSpacing?.() || [1, 1, 1];
    const sliceSpacing = Math.min(spacing[0], spacing[1], spacing[2]);
    const dist = delta * sliceSpacing;
    const n = cam.viewPlaneNormal;
    vp.setCamera({
      ...cam,
      focalPoint: [cam.focalPoint[0] + n[0] * dist, cam.focalPoint[1] + n[1] * dist, cam.focalPoint[2] + n[2] * dist] as cornerstone.Types.Point3,
      position: [cam.position[0] + n[0] * dist, cam.position[1] + n[1] * dist, cam.position[2] + n[2] * dist] as cornerstone.Types.Point3,
    });
    vp.render();
  }, [renderingEngineId]);

  const startCine = useCallback((direction: 1 | -1 = 1) => {
    stopCine();
    setCineActive(true);
    const interval = Math.round(1000 / cineFps);
    cineTimerRef.current = window.setInterval(() => {
      scrollViewport(cineVpId, direction);
    }, interval);
  }, [cineFps, cineVpId, scrollViewport]);

  const stopCine = useCallback(() => {
    setCineActive(false);
    if (cineTimerRef.current !== null) {
      clearInterval(cineTimerRef.current);
      cineTimerRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => () => { if (cineTimerRef.current) clearInterval(cineTimerRef.current); }, []);

  // ── View settings handlers ──
  const toggleAnnotations = useCallback(() => {
    const next = !showAnnotations;
    setShowAnnotations(next);
    try {
      const annotations = cornerstoneTools.annotation.state.getAllAnnotations();
      for (const ann of annotations) {
        (ann as any).isVisible = next;
      }
      const engine = cornerstone.getRenderingEngine(renderingEngineId);
      if (engine) engine.renderViewports(MPR_VP_IDS);
    } catch { /* ignore */ }
  }, [showAnnotations, renderingEngineId]);

  const togglePatientInfo = useCallback(() => {
    const next = !hidePatientInfo;
    setHidePatientInfo(next);
    // Toggle .hide-patient-info class on body
    document.body.classList.toggle('hide-patient-info', next);
  }, [hidePatientInfo]);

  const toggleCrossRef = useCallback(() => {
    const next = !showCrossRef;
    setShowCrossRef(next);
    try {
      const toolGroup = cornerstoneTools.ToolGroupManager.getToolGroup('mprToolGroup');
      if (toolGroup) {
        if (next) {
          toolGroup.setToolEnabled('Crosshairs');
        } else {
          toolGroup.setToolDisabled('Crosshairs');
        }
      }
      const engine = cornerstone.getRenderingEngine(renderingEngineId);
      if (engine) engine.renderViewports(MPR_VP_IDS);
    } catch { /* ignore */ }
  }, [showCrossRef, renderingEngineId]);

  // Close view menu on outside click
  useEffect(() => {
    if (!showViewMenu) return;
    const handler = (e: MouseEvent) => {
      if (viewMenuRef.current && !viewMenuRef.current.contains(e.target as Node)) setShowViewMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showViewMenu]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'f' || e.key === 'F') { handleCenter(); return; }
      if (e.key === 'r' || e.key === 'R') { handleReset(); return; }
      if (e.key === ' ') { e.preventDefault(); cineActive ? stopCine() : startCine(1); return; }
      const tool = tools.find(t => t.key === e.key.toLowerCase());
      if (tool) handleToolClick(tool.name);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleToolClick, handleCenter, handleReset, cineActive, startCine, stopCine]);

  const menuItemStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
    padding: '6px 12px', background: 'none', border: 'none',
    color: 'var(--text-primary)', fontSize: '12px', cursor: 'pointer', textAlign: 'left',
  };

  return (
    <div className="toolbar">
      {tools.map((tool) => (
        <button
          key={tool.name}
          className={`toolbar-btn ${activeTool === tool.name ? 'active' : ''}`}
          onClick={() => handleToolClick(tool.name)}
          title={`${tool.label} (${tool.shortcut})`}
        >
          <span className="tool-icon">{tool.icon}</span>
          <span className="tool-label">{tool.label}</span>
          <span className="tool-shortcut">{tool.shortcut}</span>
        </button>
      ))}
      <button className="toolbar-btn" onClick={handleCenter} title="Center viewports on crosshairs (F)">
        <span className="tool-icon">⊕</span>
        <span className="tool-label">Center</span>
        <span className="tool-shortcut">F</span>
      </button>
      <button className="toolbar-btn reset-btn" onClick={handleReset} title="Reset all viewports (R)">
        <span className="tool-icon">↺</span>
        <span className="tool-label">Reset</span>
        <span className="tool-shortcut">R</span>
      </button>

      <div className="toolbar-divider" />

      {/* Cine Player */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <select
          value={isStack2D ? 'stack2d' : cineVpId}
          onChange={(e) => {
            const val = e.target.value;
            if (val !== 'stack2d' && isStack2D && onSwitchToMPR) {
              // Switching from 2D to MPR mode
              onSwitchToMPR();
              setCineVpId(val);
            } else {
              setCineVpId(val);
            }
            if (cineActive) stopCine();
          }}
          style={{ fontSize: '10px', padding: '2px 4px', background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 3, height: 24 }}
          title={isStack2D ? 'Select Ax/Sag/Cor to switch to MPR' : 'Cine viewport'}
        >
          {isStack2D && <option value="stack2d">2D</option>}
          <option value="axial">Ax</option>
          <option value="sagittal">Sag</option>
          <option value="coronal">Cor</option>
        </select>
        <button className="toolbar-btn" onClick={() => { stopCine(); scrollViewport(cineVpId, -5); }} title="Step back 5" style={{ padding: '2px 5px', minWidth: 0 }}>
          <span style={{ fontSize: '12px' }}>|◀</span>
        </button>
        <button className={`toolbar-btn ${cineActive ? 'active' : ''}`}
          onClick={() => cineActive ? stopCine() : startCine(1)}
          title={cineActive ? 'Stop (Space)' : 'Play (Space)'}
          style={{ padding: '2px 8px', minWidth: 0 }}
        >
          <span style={{ fontSize: '14px' }}>{cineActive ? '■' : '▶'}</span>
        </button>
        <button className="toolbar-btn" onClick={() => { stopCine(); scrollViewport(cineVpId, 5); }} title="Step forward 5" style={{ padding: '2px 5px', minWidth: 0 }}>
          <span style={{ fontSize: '12px' }}>▶|</span>
        </button>
        {cineActive && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <input type="range" min={2} max={60} value={cineFps}
              onChange={(e) => { const fps = Number(e.target.value); setCineFps(fps); if (cineActive) { stopCine(); setTimeout(() => startCine(1), 10); } }}
              style={{ width: 50, height: 3 }} title={`Speed: ${cineFps} fps`} />
            <span style={{ fontSize: '10px', color: 'var(--text-muted)', minWidth: 28 }}>{cineFps}fps</span>
          </div>
        )}
      </div>

      <div className="toolbar-divider" />

      {/* MIP toggle + slab */}
      <button className={`toolbar-btn ${mipEnabled ? 'active' : ''}`} onClick={toggleMip} title="Toggle Slab MIP">
        <span className="tool-icon">◈</span>
        <span className="tool-label">MIP</span>
      </button>
      {mipEnabled && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 4px' }}>
          <input type="range" min={1} max={60} value={slabThickness}
            onChange={(e) => handleSlabChange(Number(e.target.value))}
            style={{ width: 80, height: 3 }} title={`Slab: ${slabThickness}mm`} />
          <span style={{ fontSize: '10px', color: 'var(--text-muted)', minWidth: 30 }}>{slabThickness}mm</span>
        </div>
      )}

      <div className="toolbar-divider" />

      {/* View Settings Dropdown */}
      <div ref={viewMenuRef} style={{ position: 'relative' }}>
        <button className={`toolbar-btn ${showViewMenu ? 'active' : ''}`}
          onClick={() => setShowViewMenu(!showViewMenu)} title="View Settings">
          <span className="tool-icon">👁</span>
          <span className="tool-label">View</span>
          <span style={{ fontSize: '8px', marginLeft: 2 }}>{showViewMenu ? '▲' : '▼'}</span>
        </button>
        {showViewMenu && (
          <div style={{
            position: 'absolute', top: '100%', right: 0, zIndex: 100, minWidth: 220,
            background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)', padding: '4px 0',
          }}>
            <button style={menuItemStyle} onClick={toggleAnnotations} onMouseEnter={(e) => (e.currentTarget.style.background = 'color-mix(in oklch, var(--nd-ink) 6%, transparent)')} onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}>
              <span style={{ width: 18 }}>{showAnnotations ? '✓' : ''}</span>Annotations
            </button>
            <button style={menuItemStyle} onClick={togglePatientInfo} onMouseEnter={(e) => (e.currentTarget.style.background = 'color-mix(in oklch, var(--nd-ink) 6%, transparent)')} onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}>
              <span style={{ width: 18 }}>{hidePatientInfo ? '✓' : ''}</span>Hide patient info
            </button>
            <button style={menuItemStyle} onClick={toggleCrossRef} onMouseEnter={(e) => (e.currentTarget.style.background = 'color-mix(in oklch, var(--nd-ink) 6%, transparent)')} onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}>
              <span style={{ width: 18 }}>{showCrossRef ? '✓' : ''}</span>Cross reference line
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
