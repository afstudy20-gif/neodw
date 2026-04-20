import { useState, useRef, useEffect } from 'react';
import * as cornerstone from '@cornerstonejs/core';

interface Preset {
  name: string;
  window: number;
  level: number;
  description: string;
}

// Multipliers relative to image's natural min/max range.
// window = range * windowFactor, level = range * levelFactor + min
const PRESETS: Array<{ name: string; windowFactor: number; levelFactor: number; description: string }> = [
  { name: 'Default', windowFactor: 1.6, levelFactor: 0.5, description: 'Soft (low contrast)' },
  { name: 'Bright', windowFactor: 1.2, levelFactor: 0.38, description: 'Lighter image' },
  { name: 'Dark', windowFactor: 1.2, levelFactor: 0.62, description: 'Darker image' },
  { name: 'High Contrast', windowFactor: 0.6, levelFactor: 0.5, description: 'Sharp vessel edges' },
  { name: 'Low Contrast', windowFactor: 2.2, levelFactor: 0.5, description: 'Very soft' },
];

interface Props {
  renderingEngineId: string;
  viewportId: string;
}

export function WindowLevelPresets({ renderingEngineId, viewportId }: Props) {
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  const applyPreset = (preset: typeof PRESETS[number]) => {
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    if (!engine) return;

    const viewport = engine.getViewport(viewportId) as any;
    if (!viewport) return;

    if (preset.name === 'Default') {
      try { viewport.resetProperties?.(); } catch {}
      viewport.render();
      setActivePreset(preset.name);
      setIsOpen(false);
      return;
    }

    // Derive from current image's intensity range
    const image = viewport.getImageData?.() ?? null;
    let minP = 0;
    let maxP = 255;
    try {
      const img: any = viewport.csImage ?? viewport.getImage?.();
      if (img) {
        if (typeof img.minPixelValue === 'number') minP = img.minPixelValue;
        if (typeof img.maxPixelValue === 'number') maxP = img.maxPixelValue;
      }
    } catch {}
    if (!(maxP > minP)) { minP = 0; maxP = 255; }
    const range = maxP - minP;
    const window = range * preset.windowFactor;
    const level = minP + range * preset.levelFactor;
    viewport.setProperties({
      voiRange: { lower: level - window / 2, upper: level + window / 2 },
    });
    viewport.render();

    setActivePreset(preset.name);
    setIsOpen(false);
    void image;
  };

  return (
    <div className="wl-dropdown" ref={dropdownRef}>
      <button
        className={`toolbar-btn ${isOpen ? 'active' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        title="Window/Level Presets"
      >
        <span className="tool-label">{activePreset || 'W/L Presets'}</span>
        <span className="wl-arrow">{isOpen ? '\u25B2' : '\u25BC'}</span>
      </button>
      {isOpen && (
        <div className="wl-dropdown-menu">
          {PRESETS.map((preset) => (
            <button
              key={preset.name}
              className={`wl-dropdown-item ${activePreset === preset.name ? 'active' : ''}`}
              onClick={() => applyPreset(preset)}
            >
              <span className="wl-dropdown-name">{preset.name}</span>
              <span className="wl-dropdown-desc">{preset.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
