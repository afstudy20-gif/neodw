import React, { useMemo } from 'react';
import type { CoronaryVesselRecord, DerivedQCAMetrics, WorldPoint3D } from '../coronary/QCATypes';
import { interpolateContourRadii, polylineLength } from '../coronary/QCAGeometry';

interface Props {
  record: CoronaryVesselRecord;
  metrics: DerivedQCAMetrics;
  cursorDistanceMm: number;
  onCursorChange: (dist: number) => void;
  width: number;
  height: number;
}

export function LongitudinalProfile({
  record,
  metrics,
  cursorDistanceMm,
  onCursorChange,
  width,
  height,
}: Props) {
  const points = record.centerlinePoints;
  const totalLength = useMemo(() => polylineLength(points), [points]);
  
  const margin = { top: 10, right: 20, bottom: 20, left: 40 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;

  // Sample data at 1mm intervals
  const data = useMemo(() => {
     const samples = [];
     const steps = Math.ceil(totalLength);
     for (let i = 0; i <= steps; i++) {
        const d = (i / steps) * totalLength;
        const radii = interpolateContourRadii(record.lumenContours, points, d);
        samples.push({
           distanceMm: d,
           lumenDiameter: radii.inner * 2,
           vesselDiameter: radii.outer * 2,
           areaMm2: Math.PI * radii.inner * radii.inner
        });
     }
     return samples;
  }, [record.lumenContours, points, totalLength]);

  const maxD = Math.max(8, ...data.map(d => d.vesselDiameter));
  
  const scaleX = (d: number) => margin.left + (d / totalLength) * plotWidth;
  const scaleY = (val: number) => margin.top + plotHeight - (val / maxD) * plotHeight;

  const handleMouseMove = (e: React.MouseEvent) => {
     const rect = e.currentTarget.getBoundingClientRect();
     const x = e.clientX - rect.left;
     const d = ((x - margin.left) / plotWidth) * totalLength;
     if (d >= 0 && d <= totalLength) {
        onCursorChange(d);
     }
  };

  const clinical = metrics.clinical;

  return (
    <div className="longitudinal-profile" style={{ width, height, position: 'relative', cursor: 'crosshair', userSelect: 'none' }} onMouseMove={handleMouseMove}>
      <svg width={width} height={height}>
         {/* Grid Lines */}
         {[0, 1, 2, 3, 4, 5].map(v => (
            <line key={v} x1={margin.left} y1={scaleY(v)} x2={width - margin.right} y2={scaleY(v)} stroke="#333" strokeDasharray="2,2" />
         ))}
         
         {/* Vessel Profile (Area fill) */}
         <path
            d={`M ${data.map(d => `${scaleX(d.distanceMm)} ${scaleY(d.vesselDiameter)}`).join(' L ')} L ${scaleX(totalLength)} ${scaleY(0)} L ${scaleX(0)} ${scaleY(0)} Z`}
            fill="rgba(255, 140, 0, 0.1)"
            stroke="none"
         />
         
         {/* Vessel Boundary */}
         <path
            d={`M ${data.map(d => `${scaleX(d.distanceMm)} ${scaleY(d.vesselDiameter)}`).join(' L ')}`}
            fill="none"
            stroke="orange"
            strokeWidth="1.5"
            opacity="0.5"
         />
         
         {/* Lumen Profile (Area fill) */}
         <path
            d={`M ${data.map(d => `${scaleX(d.distanceMm)} ${scaleY(d.lumenDiameter)}`).join(' L ')} L ${scaleX(totalLength)} ${scaleY(0)} L ${scaleX(0)} ${scaleY(0)} Z`}
            fill="rgba(0, 191, 255, 0.2)"
            stroke="none"
         />
         
         {/* Lumen Boundary */}
         <path
            d={`M ${data.map(d => `${scaleX(d.distanceMm)} ${scaleY(d.lumenDiameter)}`).join(' L ')}`}
            fill="none"
            stroke="#00BFFF"
            strokeWidth="2"
         />

         {/* Clinical Markers */}
         {clinical && clinical.mldDiameterMm > 0 && (
            <g>
               <line x1={scaleX(clinical.mldDistanceMm)} y1={margin.top} x2={scaleX(clinical.mldDistanceMm)} y2={height - margin.bottom} stroke="red" strokeWidth="1" strokeDasharray="3,3" />
               <text x={scaleX(clinical.mldDistanceMm)} y={margin.top + 15} fill="red" fontSize="10" textAnchor="middle">MLD: {clinical.mldDiameterMm.toFixed(2)}</text>
            </g>
         )}

         {/* Reference Markers */}
         {clinical && clinical.proximalReferenceDistanceMm != null && (
            <g opacity="0.6">
               <line x1={scaleX(clinical.proximalReferenceDistanceMm)} y1={margin.top} x2={scaleX(clinical.proximalReferenceDistanceMm)} y2={height - margin.bottom} stroke="#aaa" strokeWidth="1" />
               <text x={scaleX(clinical.proximalReferenceDistanceMm)} y={height - margin.bottom + 12} fill="#aaa" fontSize="10" textAnchor="middle">Prox Ref</text>
            </g>
         )}

         {/* Cursor */}
         <line x1={scaleX(cursorDistanceMm)} y1={0} x2={scaleX(cursorDistanceMm)} y2={height} stroke="yellow" strokeWidth="1" />
         
         {/* Axes */}
         <line x1={margin.left} y1={margin.top} x2={margin.left} y2={height - margin.bottom} stroke="#666" />
         <line x1={margin.left} y1={height - margin.bottom} x2={width - margin.right} y2={height - margin.bottom} stroke="#666" />
         
         <text x={5} y={height / 2} fill="#666" fontSize="10" transform={`rotate(-90, 5, ${height / 2})`}>Diam (mm)</text>
         <text x={width / 2} y={height - 2} fill="#666" fontSize="10" textAnchor="middle">Distance (mm)</text>
      </svg>
    </div>
  );
}
