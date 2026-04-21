import { useEffect, useState } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import {
  centerViewportsOnCrosshairs,
  resetCrosshairsToCenter,
  setActiveTool,
  type ToolName,
} from '../core/toolManager';
import { WindowLevelPresets } from './WindowLevelPresets';

const TOOLS: { name: ToolName; label: string; shortcut: string }[] = [
  { name: 'Crosshairs', label: 'Crosshairs', shortcut: 'C' },
  { name: 'WindowLevel', label: 'W/L', shortcut: 'W' },
  { name: 'Pan', label: 'Pan', shortcut: 'H' },
  { name: 'Zoom', label: 'Zoom', shortcut: 'Z' },
  { name: 'Length', label: 'Length', shortcut: 'M' },
  { name: 'Probe', label: 'Probe', shortcut: 'P' },
];

interface Props {
  renderingEngineId: string;
  volumeId: string;
  onReset?: () => void;
}

export function Toolbar({ renderingEngineId, volumeId, onReset }: Props) {
  const [activeTool, setActiveToolState] = useState<ToolName>('WindowLevel');
  const [layout, setLayout] = useState<'single' | 'mpr'>('single');

  useEffect(() => {
    function handleLayoutState(event: Event) {
      const detail = (event as CustomEvent).detail;
      if (detail === 'single' || detail === 'mpr') setLayout(detail);
    }
    window.addEventListener('ccta:layout-state', handleLayoutState);
    return () => window.removeEventListener('ccta:layout-state', handleLayoutState);
  }, []);

  function toggleLayout() {
    const next = layout === 'mpr' ? 'single' : 'mpr';
    setLayout(next);
    window.dispatchEvent(new CustomEvent('ccta:layout', { detail: next }));
  }

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      ) {
        return;
      }

      const lower = event.key.toLowerCase();
      if (lower === 'f') {
        centerViewportsOnCrosshairs(renderingEngineId);
        return;
      }
      if (lower === 'r') {
        handleReset();
        return;
      }

      const tool = TOOLS.find((entry) => entry.shortcut.toLowerCase() === lower);
      if (!tool) {
        return;
      }

      setActiveTool(tool.name);
      setActiveToolState(tool.name);
    }

    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  });

  function zoomViewports(factor: number) {
    // Cornerstone parallelScale is inversely proportional to magnification:
    // factor < 1 zooms IN (shrinks the viewed volume), factor > 1 zooms OUT.
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    if (!engine) return;
    for (const viewportId of ['axial', 'sagittal', 'coronal']) {
      const viewport = engine.getViewport(viewportId) as cornerstone.Types.IVolumeViewport | undefined;
      if (!viewport) continue;
      const camera = viewport.getCamera();
      const currentScale = camera.parallelScale;
      if (!currentScale || !isFinite(currentScale)) continue;
      viewport.setCamera({
        ...camera,
        parallelScale: Math.max(1e-3, currentScale * factor),
      });
      viewport.render();
    }
  }

  function handleReset() {
    onReset?.();
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    if (!engine) {
      return;
    }

    for (const viewportId of ['axial', 'sagittal', 'coronal']) {
      const viewport = engine.getViewport(viewportId);
      if (!viewport) {
        continue;
      }
      viewport.resetCamera();
      viewport.render();
    }

    setTimeout(() => {
      try {
        resetCrosshairsToCenter(renderingEngineId, volumeId);
      } catch {
        // Crosshairs are optional in the coronary workflow; a reset should still succeed without them.
      }
      setActiveTool('WindowLevel');
      setActiveToolState('WindowLevel');
    }, 120);
  }

  return (
    <div className="toolbar">
      {TOOLS.map((tool) => (
        <button
          key={tool.name}
          className={`toolbar-btn ${activeTool === tool.name ? 'active' : ''}`}
          onClick={() => {
            setActiveTool(tool.name);
            setActiveToolState(tool.name);
          }}
        >
          <span>{tool.label}</span>
          <kbd>{tool.shortcut}</kbd>
        </button>
      ))}
      <button className="toolbar-btn" onClick={() => centerViewportsOnCrosshairs(renderingEngineId)}>
        <span>Center</span>
        <kbd>F</kbd>
      </button>
      <div className="toolbar-zoom-group">
        <button
          className="toolbar-btn compact"
          onClick={() => zoomViewports(0.8)}
          title="Zoom In"
          aria-label="Zoom In"
        >
          <span>+</span>
        </button>
        <button
          className="toolbar-btn compact"
          onClick={() => zoomViewports(1.25)}
          title="Zoom Out"
          aria-label="Zoom Out"
        >
          <span>−</span>
        </button>
      </div>
      <WindowLevelPresets renderingEngineId={renderingEngineId} />
      <button
        type="button"
        className={`layout-toggle toolbar-inline ${layout === 'mpr' ? 'on' : ''}`}
        onClick={toggleLayout}
        title={layout === 'mpr' ? 'Tek pencere (Axial)' : 'MPR üçlü görünüm (Axial + Sagittal + Coronal)'}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="3" y="3" width="8" height="18" rx="1"/>
          <rect x="13" y="3" width="8" height="8" rx="1"/>
          <rect x="13" y="13" width="8" height="8" rx="1"/>
        </svg>
        <span>{layout === 'mpr' ? 'Tek Pencere' : 'MPR'}</span>
      </button>
      <button className="toolbar-btn danger" onClick={handleReset}>
        <span>Reset</span>
        <kbd>R</kbd>
      </button>
    </div>
  );
}
