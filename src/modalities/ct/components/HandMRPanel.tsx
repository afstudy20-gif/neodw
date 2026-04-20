import { useState, useCallback, useEffect, useImperativeHandle, forwardRef } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import { setActiveTool } from '../core/toolManager';
import type { DicomSeriesInfo } from '../core/dicomLoader';

export interface HandMRPanelHandle {
  resetAll: () => void;
}

interface Props {
  renderingEngineId: string;
  volumeId: string;
  seriesList: DicomSeriesInfo[];
  onLoadSeries?: (series: DicomSeriesInfo) => void;
}

// Measurement definitions with normal ranges
interface MeasurementDef {
  key: string;
  label: string;
  tool: 'Length' | 'Angle' | 'CobbAngle';
  unit: string;
  normalRange?: [number, number];
  normalLabel?: string;
  description: string;
  plane: string; // recommended viewing plane
}

const MEASUREMENTS: MeasurementDef[] = [
  {
    key: 'sl-angle',
    label: 'Scapholunate Angle',
    tool: 'Angle',
    unit: '°',
    normalRange: [30, 60],
    normalLabel: '30-60° (>70° = DISI)',
    description: 'Scaphoid ve lunate eksenleri arası açı',
    plane: 'Sagittal',
  },
  {
    key: 'sl-interval',
    label: 'SL Interval Width',
    tool: 'Length',
    unit: 'mm',
    normalRange: [0, 3],
    normalLabel: '<3 mm normal',
    description: 'Scaphoid-lunate arası mesafe',
    plane: 'Coronal',
  },
  {
    key: 'ulnar-variance',
    label: 'Ulnar Variance',
    tool: 'Length',
    unit: 'mm',
    normalRange: [-2, 2],
    normalLabel: '-2 to +2 mm',
    description: 'Radius ve ulna distal yüzey farkı',
    plane: 'Coronal',
  },
  {
    key: 'carpal-height-dist',
    label: 'Carpal Height (distance)',
    tool: 'Length',
    unit: 'mm',
    description: '3. MC tabanı → distal radius mesafesi',
    plane: 'Coronal',
  },
  {
    key: 'carpal-mc-length',
    label: '3rd MC Length',
    tool: 'Length',
    unit: 'mm',
    description: '3. metakarp uzunluğu (ratio için)',
    plane: 'Coronal',
  },
  {
    key: 'free-length',
    label: 'Free Measurement',
    tool: 'Length',
    unit: 'mm',
    description: 'Serbest uzunluk ölçümü',
    plane: 'Any',
  },
  {
    key: 'free-angle',
    label: 'Free Angle',
    tool: 'Angle',
    unit: '°',
    description: 'Serbest açı ölçümü',
    plane: 'Any',
  },
];

interface MeasurementResult {
  key: string;
  value: number;
  annotationUID?: string;
}

export const HandMRPanel = forwardRef<HandMRPanelHandle, Props>(function HandMRPanel(
  { renderingEngineId, volumeId, seriesList, onLoadSeries },
  ref
) {
  const [activeMeasurement, setActiveMeasurement] = useState<string | null>(null);
  const [results, setResults] = useState<Map<string, MeasurementResult>>(new Map());
  const [showMeasurements, setShowMeasurements] = useState(false);
  const [showComputedValues, setShowComputedValues] = useState(false);

  useImperativeHandle(ref, () => ({
    resetAll: () => {
      setActiveMeasurement(null);
      setResults(new Map());
      // Remove all annotations
      try {
        const annotationState = cornerstoneTools.annotation.state;
        const allAnnotations = annotationState.getAllAnnotations();
        for (const ann of allAnnotations) {
          annotationState.removeAnnotation(ann.annotationUID!);
        }
        const engine = cornerstone.getRenderingEngine(renderingEngineId);
        if (engine) engine.renderViewports(['axial', 'sagittal', 'coronal']);
      } catch { /* ignore */ }
    },
  }));

  // Start a measurement
  const startMeasurement = useCallback((def: MeasurementDef) => {
    setActiveMeasurement(def.key);
    setActiveTool(def.tool as any);
  }, []);

  // Poll for completed annotations to capture results
  useEffect(() => {
    if (!activeMeasurement) return;
    const def = MEASUREMENTS.find(m => m.key === activeMeasurement);
    if (!def) return;

    const interval = setInterval(() => {
      try {
        const toolName = def.tool === 'Angle' ? 'Angle' : def.tool === 'CobbAngle' ? 'CobbAngle' : 'Length';
        const annotations = cornerstoneTools.annotation.state.getAllAnnotations();

        // Find the most recent completed annotation for this tool
        const toolAnnotations = annotations.filter(
          (a: any) => a.metadata?.toolName === toolName && !a.isLocked
        );

        if (toolAnnotations.length > 0) {
          const latest = toolAnnotations[toolAnnotations.length - 1] as any;
          const data = latest.data;

          let value = 0;
          if (def.tool === 'Length') {
            value = data?.cachedStats?.['1']?.length ?? data?.length ?? 0;
            // Try alternative stat paths
            if (value === 0) {
              const stats = Object.values(data?.cachedStats || {}) as any[];
              if (stats.length > 0 && stats[0]?.length) value = stats[0].length;
            }
          } else {
            value = data?.cachedStats?.['1']?.angle ?? data?.angle ?? 0;
            if (value === 0) {
              const stats = Object.values(data?.cachedStats || {}) as any[];
              if (stats.length > 0 && stats[0]?.angle) value = stats[0].angle;
            }
          }

          if (value > 0) {
            setResults(prev => {
              const next = new Map(prev);
              next.set(def.key, { key: def.key, value, annotationUID: latest.annotationUID });
              return next;
            });
            setActiveMeasurement(null);
            // Switch back to crosshairs
            setActiveTool('Crosshairs');
          }
        }
      } catch { /* ignore */ }
    }, 500);

    return () => clearInterval(interval);
  }, [activeMeasurement]);

  // Compute carpal height ratio when both measurements exist
  const carpalHeightRatio = (() => {
    const dist = results.get('carpal-height-dist');
    const mc = results.get('carpal-mc-length');
    if (dist && mc && mc.value > 0) {
      return (dist.value / mc.value);
    }
    return null;
  })();

  const getStatusColor = (def: MeasurementDef, value: number): string => {
    if (!def.normalRange) return 'var(--accent)';
    const [min, max] = def.normalRange;
    if (value >= min && value <= max) return '#4caf50'; // green — normal
    return '#ff5252'; // red — abnormal
  };

  const sectionStyle: React.CSSProperties = {
    padding: '8px 12px',
    borderBottom: '1px solid var(--border)',
  };
  const headerStyle: React.CSSProperties = {
    fontSize: '11px',
    fontWeight: 700,
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    marginBottom: 6,
  };
  const btnStyle = (active: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    padding: '6px 8px',
    marginBottom: 3,
    background: active ? 'var(--accent-glow)' : 'color-mix(in oklch, var(--nd-ink) 6%, transparent)',
    border: active ? '1px solid var(--accent)' : '1px solid var(--border)',
    borderRadius: 4,
    color: 'var(--text-primary)',
    cursor: 'pointer',
    fontSize: '12px',
    textAlign: 'left' as const,
  });

  return (
    <div className="tavi-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'auto' }}>
      {/* Header */}
      <div style={{ padding: '10px 12px', borderBottom: '2px solid var(--accent)', background: 'rgba(59,130,246,0.08)' }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--accent)' }}>Hand MR</div>
        <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>El / Bilek MRI Inceleme Araclari</div>
      </div>

      {/* Measurements — collapsible */}
      <div style={sectionStyle}>
        <div style={{ ...headerStyle, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: showMeasurements ? 6 : 0 }}
             onClick={() => setShowMeasurements(!showMeasurements)}>
          <span>Measurements {results.size > 0 && `(${results.size})`}</span>
          <span style={{ fontSize: '10px' }}>{showMeasurements ? '▼' : '▶'}</span>
        </div>
        {showMeasurements && MEASUREMENTS.map(def => {
          const result = results.get(def.key);
          const isActive = activeMeasurement === def.key;
          return (
            <button
              key={def.key}
              style={btnStyle(isActive)}
              onClick={() => startMeasurement(def)}
              title={`${def.description} — ${def.plane} plane`}
            >
              <div>
                <div style={{ fontWeight: 600 }}>{def.label}</div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                  {def.plane} {def.normalLabel && `| Normal: ${def.normalLabel}`}
                </div>
              </div>
              <div style={{ textAlign: 'right', minWidth: 60 }}>
                {isActive && (
                  <span style={{ color: 'var(--accent)', fontSize: '10px', fontStyle: 'italic' }}>
                    Measuring...
                  </span>
                )}
                {result && !isActive && (
                  <span style={{ fontWeight: 700, fontSize: '13px', color: getStatusColor(def, result.value) }}>
                    {result.value.toFixed(1)}{def.unit}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Carpal Height Ratio (computed) — collapsible */}
      <div style={sectionStyle}>
        <div style={{ ...headerStyle, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: showComputedValues ? 6 : 0 }}
             onClick={() => setShowComputedValues(!showComputedValues)}>
          <span>Computed Values {carpalHeightRatio ? `(${carpalHeightRatio.toFixed(3)})` : ''}</span>
          <span style={{ fontSize: '10px' }}>{showComputedValues ? '▼' : '▶'}</span>
        </div>
        {showComputedValues && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}>
            <div>
              <div style={{ fontSize: '12px', fontWeight: 600 }}>Carpal Height Ratio (Youm)</div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Normal: 0.51-0.57</div>
            </div>
            <div style={{ fontWeight: 700, fontSize: '14px', color: carpalHeightRatio
              ? (carpalHeightRatio >= 0.51 && carpalHeightRatio <= 0.57 ? '#4caf50' : '#ff5252')
              : 'var(--text-muted)' }}>
              {carpalHeightRatio ? carpalHeightRatio.toFixed(3) : '—'}
            </div>
          </div>
        )}
      </div>

      {/* Results Summary */}
      {results.size > 0 && (
        <div style={sectionStyle}>
          <div style={headerStyle}>Results Summary</div>
          <table style={{ width: '100%', fontSize: '11px', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: 'left', padding: '3px 0', color: 'var(--text-muted)' }}>Measurement</th>
                <th style={{ textAlign: 'right', padding: '3px 0', color: 'var(--text-muted)' }}>Value</th>
                <th style={{ textAlign: 'right', padding: '3px 0', color: 'var(--text-muted)' }}>Normal</th>
              </tr>
            </thead>
            <tbody>
              {Array.from(results.entries()).map(([key, r]) => {
                const def = MEASUREMENTS.find(m => m.key === key);
                if (!def) return null;
                return (
                  <tr key={key} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '3px 0' }}>{def.label}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: getStatusColor(def, r.value), padding: '3px 0' }}>
                      {r.value.toFixed(1)}{def.unit}
                    </td>
                    <td style={{ textAlign: 'right', color: 'var(--text-muted)', padding: '3px 0' }}>
                      {def.normalLabel || '—'}
                    </td>
                  </tr>
                );
              })}
              {carpalHeightRatio && (
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '3px 0' }}>Carpal Height Ratio</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, padding: '3px 0',
                    color: carpalHeightRatio >= 0.51 && carpalHeightRatio <= 0.57 ? '#4caf50' : '#ff5252' }}>
                    {carpalHeightRatio.toFixed(3)}
                  </td>
                  <td style={{ textAlign: 'right', color: 'var(--text-muted)', padding: '3px 0' }}>0.51-0.57</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Series Comparison */}
      <div style={sectionStyle}>
        <div style={headerStyle}>Series Comparison</div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: 6 }}>
          Seri secin — farkli sekanslari karsilastirin
        </div>
        {seriesList.map(s => (
          <button
            key={s.seriesInstanceUID}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              padding: '5px 8px', marginBottom: 2, borderRadius: 4,
              background: 'color-mix(in oklch, var(--nd-ink) 6%, transparent)', border: '1px solid var(--border)',
              color: 'var(--text-primary)', cursor: 'pointer', fontSize: '11px',
            }}
            onClick={() => onLoadSeries?.(s)}
            title={`Load: ${s.seriesDescription} (${s.numImages} images)`}
          >
            <span style={{ fontWeight: 600, color: 'var(--accent)', marginRight: 6 }}>{s.modality}</span>
            <span>{s.seriesDescription}</span>
            <span style={{ float: 'right', color: 'var(--text-muted)' }}>{s.numImages}</span>
          </button>
        ))}
      </div>

      {/* Quick Actions */}
      <div style={sectionStyle}>
        <div style={headerStyle}>Tools</div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          <button className="tavi-btn" onClick={() => setActiveTool('Crosshairs')} style={{ fontSize: '11px', padding: '4px 8px' }}>
            Crosshairs
          </button>
          <button className="tavi-btn" onClick={() => setActiveTool('Length')} style={{ fontSize: '11px', padding: '4px 8px' }}>
            Length
          </button>
          <button className="tavi-btn" onClick={() => setActiveTool('Angle')} style={{ fontSize: '11px', padding: '4px 8px' }}>
            Angle
          </button>
          <button className="tavi-btn" onClick={() => setActiveTool('Pan')} style={{ fontSize: '11px', padding: '4px 8px' }}>
            Pan
          </button>
          <button className="tavi-btn" onClick={() => setActiveTool('Zoom')} style={{ fontSize: '11px', padding: '4px 8px' }}>
            Zoom
          </button>
          <button className="tavi-btn" onClick={() => setActiveTool('WindowLevel')} style={{ fontSize: '11px', padding: '4px 8px' }}>
            W/L
          </button>
        </div>
      </div>

      {/* Instructions */}
      <div style={{ padding: '8px 12px', fontSize: '10px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
        <strong>Kullanim:</strong><br />
        1. Olcum butonuna tiklayin<br />
        2. Viewport uzerinde olcum yapin<br />
        3. Sonuc otomatik panelde gosterilir<br />
        4. Yesil = normal, Kirmizi = anormal
      </div>
    </div>
  );
});
