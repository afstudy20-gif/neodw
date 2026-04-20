/**
 * AHA 17-segment LV bullseye plot.
 * - Outer ring (r=rMid..rBasal): basal segments 1-6, 60° each, seg 1 centered anterior (12 o'clock).
 * - Middle ring (r=rApical..rMid): mid segments 7-12.
 * - Inner ring (r=rApex..rApical): apical segments 13-16, 90° each, seg 13 anterior.
 * - Center disc: apex segment 17.
 * Fill color driven by per-segment mean thickness via lvThicknessToColor.
 */
import { lvThicknessToColor } from '../la/wallThickness';
import type { SegStat } from '../la/aha17';

interface Props {
  segments: SegStat[];
  size?: number;
  title?: string;
}

function mmToFill(mm: number): string {
  if (Number.isNaN(mm)) return '#2a2a2a';
  const [r, g, b] = lvThicknessToColor(mm);
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

interface RingSeg {
  id: number;
  startDeg: number;
  sweepDeg: number;
}

export function Bullseye17({ segments, size = 260, title }: Props) {
  const cx = size / 2;
  const cy = size / 2;
  const rApex = size * 0.09;
  const rApical = size * 0.23;
  const rMid = size * 0.36;
  const rBasal = size * 0.49;
  const map = new Map(segments.map((s) => [s.segment, s]));

  const ringPath = (r1: number, r2: number, startDeg: number, sweepDeg: number): string => {
    const a0 = (startDeg - 90) * Math.PI / 180;
    const a1 = (startDeg + sweepDeg - 90) * Math.PI / 180;
    const x1 = cx + r1 * Math.cos(a0), y1 = cy + r1 * Math.sin(a0);
    const x2 = cx + r2 * Math.cos(a0), y2 = cy + r2 * Math.sin(a0);
    const x3 = cx + r2 * Math.cos(a1), y3 = cy + r2 * Math.sin(a1);
    const x4 = cx + r1 * Math.cos(a1), y4 = cy + r1 * Math.sin(a1);
    const large = sweepDeg > 180 ? 1 : 0;
    return `M ${x1} ${y1} L ${x2} ${y2} A ${r2} ${r2} 0 ${large} 1 ${x3} ${y3} L ${x4} ${y4} A ${r1} ${r1} 0 ${large} 0 ${x1} ${y1} Z`;
  };

  const centerOf = (r1: number, r2: number, startDeg: number, sweepDeg: number): [number, number] => {
    const aMid = (startDeg + sweepDeg / 2 - 90) * Math.PI / 180;
    const rMidR = (r1 + r2) / 2;
    return [cx + rMidR * Math.cos(aMid), cy + rMidR * Math.sin(aMid)];
  };

  const basalSegs: RingSeg[] = [
    { id: 1, startDeg: -30, sweepDeg: 60 },
    { id: 2, startDeg: 30,  sweepDeg: 60 },
    { id: 3, startDeg: 90,  sweepDeg: 60 },
    { id: 4, startDeg: 150, sweepDeg: 60 },
    { id: 5, startDeg: 210, sweepDeg: 60 },
    { id: 6, startDeg: 270, sweepDeg: 60 },
  ];
  const midSegs: RingSeg[] = basalSegs.map((s, i) => ({ ...s, id: 7 + i }));
  const apicalSegs: RingSeg[] = [
    { id: 13, startDeg: -45, sweepDeg: 90 },
    { id: 14, startDeg: 45,  sweepDeg: 90 },
    { id: 15, startDeg: 135, sweepDeg: 90 },
    { id: 16, startDeg: 225, sweepDeg: 90 },
  ];

  const drawRing = (ringSegs: RingSeg[], r1: number, r2: number) =>
    ringSegs.map((r) => {
      const s = map.get(r.id);
      const fill = s ? mmToFill(s.meanMm) : '#2a2a2a';
      const [tx, ty] = centerOf(r1, r2, r.startDeg, r.sweepDeg);
      const label = s && !Number.isNaN(s.meanMm) ? s.meanMm.toFixed(1) : '—';
      return (
        <g key={`seg-${r.id}`}>
          <path d={ringPath(r1, r2, r.startDeg, r.sweepDeg)} fill={fill} stroke="#000" strokeWidth={0.6} />
          <text x={tx} y={ty} fontSize={10} fontWeight={600} textAnchor="middle" dominantBaseline="middle" fill="#fff" style={{ paintOrder: 'stroke', stroke: '#000', strokeWidth: 2 }}>
            {label}
          </text>
          <text x={tx} y={ty + 11} fontSize={8} textAnchor="middle" dominantBaseline="middle" fill="#ccc" style={{ paintOrder: 'stroke', stroke: '#000', strokeWidth: 1.5 }}>
            {r.id}
          </text>
        </g>
      );
    });

  const apex = map.get(17);
  const apexFill = apex ? mmToFill(apex.meanMm) : '#2a2a2a';
  const apexLabel = apex && !Number.isNaN(apex.meanMm) ? apex.meanMm.toFixed(1) : '—';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      {title ? <div style={{ fontSize: 11, fontWeight: 700, color: '#cfe0f4' }}>{title}</div> : null}
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {drawRing(basalSegs, rMid, rBasal)}
        {drawRing(midSegs, rApical, rMid)}
        {drawRing(apicalSegs, rApex, rApical)}
        <circle cx={cx} cy={cy} r={rApex} fill={apexFill} stroke="#000" strokeWidth={0.6} />
        <text x={cx} y={cy - 2} fontSize={10} fontWeight={600} textAnchor="middle" dominantBaseline="middle" fill="#fff" style={{ paintOrder: 'stroke', stroke: '#000', strokeWidth: 2 }}>
          {apexLabel}
        </text>
        <text x={cx} y={cy + 10} fontSize={8} textAnchor="middle" dominantBaseline="middle" fill="#ccc" style={{ paintOrder: 'stroke', stroke: '#000', strokeWidth: 1.5 }}>17</text>
        <text x={cx} y={12} fontSize={10} fontWeight={700} textAnchor="middle" fill="#cfe0f4">ANT</text>
        <text x={cx} y={size - 4} fontSize={10} fontWeight={700} textAnchor="middle" fill="#cfe0f4">INF</text>
        <text x={6} y={cy} fontSize={10} fontWeight={700} textAnchor="start" dominantBaseline="middle" fill="#cfe0f4">SEP</text>
        <text x={size - 6} y={cy} fontSize={10} fontWeight={700} textAnchor="end" dominantBaseline="middle" fill="#cfe0f4">LAT</text>
      </svg>
      <div style={{ fontSize: 9.5, opacity: 0.75, color: '#aac' }}>mm · AHA 17-seg · view from apex</div>
    </div>
  );
}
