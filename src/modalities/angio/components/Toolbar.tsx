import { useEffect, useState } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import { setActiveTool, type ToolName } from '../core/toolManager';
import { WindowLevelPresets } from './WindowLevelPresets';

const TOOLS: { name: ToolName; label: string; shortcut: string }[] = [
  { name: 'WindowLevel', label: 'W/L', shortcut: 'W' },
  { name: 'Pan', label: 'Pan', shortcut: 'H' },
  { name: 'Zoom', label: 'Zoom', shortcut: 'Z' },
  { name: 'Length', label: 'Length', shortcut: 'M' },
];

interface Props {
  renderingEngineId: string;
  viewportId: string;
  onReset?: () => void;
  qcaActive?: boolean;
  onToggleQCA?: () => void;
}

export function Toolbar({ renderingEngineId, viewportId, onReset, qcaActive, onToggleQCA }: Props) {
  const [activeTool, setActiveToolState] = useState<ToolName>('WindowLevel');
  const [inverted, setInverted] = useState(false);

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
      if (lower === 'r') {
        onReset?.();
        setInverted(false);
        setActiveTool('WindowLevel');
        setActiveToolState('WindowLevel');
        return;
      }
      if (lower === 'i') {
        toggleInvert();
        return;
      }
      if (lower === 'q') {
        onToggleQCA?.();
        return;
      }

      const tool = TOOLS.find((entry) => entry.shortcut.toLowerCase() === lower);
      if (!tool) return;

      setActiveTool(tool.name);
      setActiveToolState(tool.name);
    }

    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  });

  function toggleInvert() {
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    if (!engine) return;
    const viewport = engine.getViewport(viewportId) as cornerstone.Types.IStackViewport | undefined;
    if (!viewport) return;
    const next = !inverted;
    viewport.setProperties({ invert: next });
    viewport.render();
    setInverted(next);
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
      <button className={`toolbar-btn ${inverted ? 'active' : ''}`} onClick={toggleInvert}>
        <span>Invert</span>
        <kbd>I</kbd>
      </button>
      <WindowLevelPresets renderingEngineId={renderingEngineId} viewportId={viewportId} />

      <span className="toolbar-separator" />

      <button
        className={`toolbar-btn ${qcaActive ? 'active' : ''}`}
        onClick={onToggleQCA}
        title="Toggle QCA + vFFR Analysis (Q)"
      >
        <span>QCA / vFFR</span>
        <kbd>Q</kbd>
      </button>

      <button className="toolbar-btn danger" onClick={() => { onReset?.(); setInverted(false); }}>
        <span>Reset</span>
        <kbd>R</kbd>
      </button>
    </div>
  );
}
