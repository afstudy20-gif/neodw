import { useEffect, useState } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import { setActiveTool, type ToolName } from '../core/toolManager';
import { WindowLevelPresets } from './WindowLevelPresets';

const TOOLS: { name: ToolName; label: string; shortcut: string }[] = [
  { name: 'WindowLevel', label: 'W/L', shortcut: 'W' },
  { name: 'Pan', label: 'Pan', shortcut: 'H' },
  { name: 'Zoom', label: 'Zoom', shortcut: 'Z' },
  { name: 'Length', label: 'Length', shortcut: 'M' },
  { name: 'ArrowAnnotate', label: 'Ok', shortcut: 'A' },
];

const ANNOT_COLORS = ['#ffd43b', '#ff6b6b', '#51cf66', '#4dabf7', '#ffffff', '#000000'];

function applyAnnotationStyle(color: string) {
  try {
    const cfg: any = (cornerstoneTools as any).annotation?.config?.style;
    const setGlobal = cfg?.setGlobalStyle ?? cfg?.setDefaultToolStyles ?? cfg?.setGlobalToolStyle;
    if (setGlobal) {
      setGlobal({ color, colorHighlighted: color, colorSelected: color, lineWidth: 2 });
    }
  } catch { /* ignore */ }
}

function clearAllAnnotations() {
  try {
    const anno: any = (cornerstoneTools as any).annotation?.state;
    const mgr = anno?.getAnnotationManager?.();
    if (mgr?.removeAllAnnotations) mgr.removeAllAnnotations();
    else if (anno?.removeAllAnnotations) anno.removeAllAnnotations();
  } catch { /* ignore */ }
}

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
  const [annotColor, setAnnotColor] = useState<string>('#ffd43b');

  useEffect(() => {
    applyAnnotationStyle(annotColor);
  }, [annotColor]);

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

      <div className="annot-group" title="Annotation renk / temizle">
        {ANNOT_COLORS.map((c) => (
          <button
            key={c}
            onClick={() => setAnnotColor(c)}
            title={c}
            style={{
              width: 18, height: 18, borderRadius: 4, padding: 0, cursor: 'pointer',
              background: c,
              border: annotColor === c ? '2px solid var(--nd-accent, #4dabf7)' : '1px solid var(--line, #444)',
            }}
          />
        ))}
        <input
          type="color"
          value={annotColor}
          onChange={(e) => setAnnotColor(e.target.value)}
          style={{ width: 22, height: 20, border: '1px solid var(--line, #444)', borderRadius: 4, padding: 0, background: 'transparent', cursor: 'pointer' }}
          title="Özel renk"
        />
        <button
          className="toolbar-btn compact"
          onClick={() => { clearAllAnnotations(); const engine = cornerstone.getRenderingEngine(renderingEngineId); engine?.getViewport(viewportId)?.render(); }}
          title="Tüm annotation/ölçümleri temizle"
        >
          <span>Annot Clear</span>
        </button>
      </div>

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
