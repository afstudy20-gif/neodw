import React, { useMemo, useRef, useState, useEffect } from 'react';
import type { TAVIFluoroAngleResult } from '../tavi/TAVITypes';

interface PerpendicularityPlotProps {
  /** Perpendicularity curve: array of {laoRaoDeg, cranialCaudalDeg} */
  curve: { laoRaoDeg: number; cranialCaudalDeg: number }[];
  /** RAO projection table (0-40° at 10° steps) */
  raoTable?: { raoDeg: number; cranialCaudalDeg: number; label: string }[];
  /** LAO projection table (0-40° at 10° steps) */
  laoTable?: { laoDeg: number; cranialCaudalDeg: number; label: string }[];
  /** Current coplanar fluoro angle */
  coplanarAngle?: TAVIFluoroAngleResult | null;
  /** Projection confirmation angle */
  confirmationAngle?: TAVIFluoroAngleResult | null;
  /** Selected angle from user interaction */
  selectedAngle?: { laoRaoDeg: number; cranialCaudalDeg: number } | null;
  /** Width in px */
  width?: number;
  /** Height in px */
  height?: number;
}

const PADDING = { top: 24, right: 24, bottom: 32, left: 40 };
const RANGE_X = { min: -50, max: 50 }; // RAO negative, LAO positive
const RANGE_Y = { min: -50, max: 50 }; // Caudal negative, Cranial positive

export const PerpendicularityPlot: React.FC<PerpendicularityPlotProps> = ({
  curve,
  raoTable,
  laoTable,
  coplanarAngle,
  confirmationAngle,
  selectedAngle,
  width: propWidth,
  height: propHeight = 220,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const width = propWidth || containerWidth || 320;
  const height = propHeight;
  const plotW = width - PADDING.left - PADDING.right;
  const plotH = height - PADDING.top - PADDING.bottom;

  const toX = (deg: number) => PADDING.left + ((deg - RANGE_X.min) / (RANGE_X.max - RANGE_X.min)) * plotW;
  const toY = (deg: number) => PADDING.top + ((RANGE_Y.max - deg) / (RANGE_Y.max - RANGE_Y.min)) * plotH;

  const curvePath = useMemo(() => {
    if (curve.length === 0) return '';
    const filtered = curve.filter(
      (p) => p.laoRaoDeg >= RANGE_X.min && p.laoRaoDeg <= RANGE_X.max
    );
    return filtered
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(p.laoRaoDeg).toFixed(1)},${toY(p.cranialCaudalDeg).toFixed(1)}`)
      .join(' ');
  }, [curve, width, height]);

  // Grid lines at 10° intervals
  const gridLinesX = [];
  const gridLinesY = [];
  for (let d = RANGE_X.min; d <= RANGE_X.max; d += 10) {
    gridLinesX.push(d);
  }
  for (let d = RANGE_Y.min; d <= RANGE_Y.max; d += 10) {
    gridLinesY.push(d);
  }

  // Convert coplanar angle to plot coordinates
  const coplanarX = coplanarAngle
    ? (coplanarAngle.laoRaoLabel === 'LAO' ? coplanarAngle.laoRaoDegrees : -coplanarAngle.laoRaoDegrees)
    : null;
  const coplanarY = coplanarAngle
    ? (coplanarAngle.cranialCaudalLabel === 'CRANIAL' ? coplanarAngle.cranialCaudalDegrees : -coplanarAngle.cranialCaudalDegrees)
    : null;

  const confirmX = confirmationAngle
    ? (confirmationAngle.laoRaoLabel === 'LAO' ? confirmationAngle.laoRaoDegrees : -confirmationAngle.laoRaoDegrees)
    : null;
  const confirmY = confirmationAngle
    ? (confirmationAngle.cranialCaudalLabel === 'CRANIAL' ? confirmationAngle.cranialCaudalDegrees : -confirmationAngle.cranialCaudalDegrees)
    : null;

  return (
    <div ref={containerRef} style={{ width: '100%' }}>
    <svg
      className="perpendicularity-plot"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
    >
      {/* Background */}
      <rect x={PADDING.left} y={PADDING.top} width={plotW} height={plotH} fill="#0a0e14" rx={2} />

      {/* Grid lines */}
      {gridLinesX.map((d) => (
        <line
          key={`gx-${d}`}
          x1={toX(d)} y1={PADDING.top}
          x2={toX(d)} y2={PADDING.top + plotH}
          stroke={d === 0 ? '#484f58' : '#1c2333'}
          strokeWidth={d === 0 ? 1 : 0.5}
        />
      ))}
      {gridLinesY.map((d) => (
        <line
          key={`gy-${d}`}
          x1={PADDING.left} y1={toY(d)}
          x2={PADDING.left + plotW} y2={toY(d)}
          stroke={d === 0 ? '#484f58' : '#1c2333'}
          strokeWidth={d === 0 ? 1 : 0.5}
        />
      ))}

      {/* Axis labels */}
      <text x={PADDING.left - 4} y={PADDING.top - 8} fill="#8b949e" fontSize={9} textAnchor="start">Cranial</text>
      <text x={PADDING.left - 4} y={PADDING.top + plotH + 12} fill="#8b949e" fontSize={9} textAnchor="start">Caudal</text>
      <text x={PADDING.left} y={PADDING.top + plotH + 26} fill="#8b949e" fontSize={9} textAnchor="middle">RAO</text>
      <text x={PADDING.left + plotW} y={PADDING.top + plotH + 26} fill="#8b949e" fontSize={9} textAnchor="middle">LAO</text>

      {/* Tick labels */}
      {gridLinesX.filter((d) => d % 20 === 0 && d !== 0).map((d) => (
        <text key={`tx-${d}`} x={toX(d)} y={PADDING.top + plotH + 14} fill="#6e7681" fontSize={8} textAnchor="middle">
          {Math.abs(d)}°
        </text>
      ))}
      {gridLinesY.filter((d) => d % 20 === 0 && d !== 0).map((d) => (
        <text key={`ty-${d}`} x={PADDING.left - 6} y={toY(d) + 3} fill="#6e7681" fontSize={8} textAnchor="end">
          {Math.abs(d)}°
        </text>
      ))}

      {/* Perpendicularity curve */}
      {curvePath && (
        <path d={curvePath} fill="none" stroke="#d29922" strokeWidth={2} strokeLinejoin="round" />
      )}

      {/* RAO projection markers */}
      {raoTable?.map((entry) => {
        const x = toX(-entry.raoDeg); // RAO is negative
        const y = toY(entry.cranialCaudalDeg);
        if (x < PADDING.left || x > PADDING.left + plotW) return null;
        if (y < PADDING.top || y > PADDING.top + plotH) return null;
        return (
          <g key={`rao-${entry.raoDeg}`}>
            <circle cx={x} cy={y} r={3} fill="#58a6ff" stroke="#0d1117" strokeWidth={1} />
            <text x={x + 6} y={y + 3} fill="#58a6ff" fontSize={8}>R{entry.raoDeg}</text>
          </g>
        );
      })}

      {/* LAO projection markers */}
      {laoTable?.map((entry) => {
        const x = toX(entry.laoDeg); // LAO is positive
        const y = toY(entry.cranialCaudalDeg);
        if (x < PADDING.left || x > PADDING.left + plotW) return null;
        if (y < PADDING.top || y > PADDING.top + plotH) return null;
        return (
          <g key={`lao-${entry.laoDeg}`}>
            <circle cx={x} cy={y} r={3} fill="#bc8cff" stroke="#0d1117" strokeWidth={1} />
            <text x={x + 6} y={y + 3} fill="#bc8cff" fontSize={8}>L{entry.laoDeg}</text>
          </g>
        );
      })}

      {/* Coplanar angle marker */}
      {coplanarX != null && coplanarY != null && (
        <g>
          <circle cx={toX(coplanarX)} cy={toY(coplanarY)} r={5} fill="none" stroke="#58a6ff" strokeWidth={2} />
          <circle cx={toX(coplanarX)} cy={toY(coplanarY)} r={2} fill="#58a6ff" />
        </g>
      )}

      {/* Confirmation angle marker */}
      {confirmX != null && confirmY != null && (
        <g>
          <circle cx={toX(confirmX)} cy={toY(confirmY)} r={5} fill="none" stroke="#3fb950" strokeWidth={2} />
          <circle cx={toX(confirmX)} cy={toY(confirmY)} r={2} fill="#3fb950" />
        </g>
      )}

      {/* Selected angle marker */}
      {selectedAngle && (
        <g>
          {/* Crosshair */}
          <line
            x1={toX(selectedAngle.laoRaoDeg)} y1={PADDING.top}
            x2={toX(selectedAngle.laoRaoDeg)} y2={PADDING.top + plotH}
            stroke="#f85149" strokeWidth={0.5} strokeDasharray="3,3"
          />
          <line
            x1={PADDING.left} y1={toY(selectedAngle.cranialCaudalDeg)}
            x2={PADDING.left + plotW} y2={toY(selectedAngle.cranialCaudalDeg)}
            stroke="#f85149" strokeWidth={0.5} strokeDasharray="3,3"
          />
          <circle
            cx={toX(selectedAngle.laoRaoDeg)}
            cy={toY(selectedAngle.cranialCaudalDeg)}
            r={4} fill="#f85149" stroke="#0d1117" strokeWidth={1}
          />
        </g>
      )}

      {/* Title */}
      <text x={width / 2} y={14} fill="#e6edf3" fontSize={11} fontWeight={600} textAnchor="middle">
        Perpendicularity
      </text>
    </svg>
    </div>
  );
};
