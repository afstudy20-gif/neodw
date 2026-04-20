import { classifyFFR, type PatientFFRResult, type VesselFFRResult } from '../coronary/ffr';

interface Props {
  result: PatientFFRResult | null;
  error: string | null;
  busy: boolean;
}

/**
 * Read-only display of a patient-level CT-FFR run.
 *
 * Shows, per vessel:
 *   - Distal FFR (color-coded by classifyFFR threshold).
 *   - Max translesional ΔFFR across any sliding 10 mm window.
 *   - PPG index (focal vs diffuse character).
 *   - Sparkline pullback curve with the 0.80 ischemia line drawn for
 *     reference so a clinician can spot the transition at a glance.
 */
export function FFRResultsPanel({ result, error, busy }: Props) {
  if (busy) {
    return <div className="ffr-results-empty">Running CT-FFR simulation…</div>;
  }
  if (error) {
    return <div className="ffr-results-empty error">{error}</div>;
  }
  if (!result) {
    return (
      <div className="ffr-results-empty">
        Press <strong>Run CT-FFR</strong> once solver inputs are ready.
      </div>
    );
  }

  return (
    <div className="ffr-results">
      <div className="ffr-results-summary">
        <span>P<sub>a</sub>: {result.meanAorticPressureMmHg} mmHg</span>
        <span>LV mass: {result.myocardialMassG} g</span>
        <span>Hyperemia ×{result.hyperemiaFactor.toFixed(1)}</span>
      </div>
      <ul className="ffr-vessel-list">
        {result.vessels.map((vessel) => (
          <VesselFFRCard key={vessel.vesselId} vessel={vessel} />
        ))}
      </ul>
    </div>
  );
}

function VesselFFRCard({ vessel }: { vessel: VesselFFRResult }) {
  const severity = classifyFFR(vessel.distalFFR);
  return (
    <li className={`ffr-vessel-card severity-${severity}`}>
      <div className="ffr-vessel-head">
        <span className="ffr-vessel-label">{vessel.label}</span>
        <span className={`ffr-value severity-${severity}`}>{vessel.distalFFR.toFixed(2)}</span>
      </div>
      <div className="ffr-vessel-metrics">
        <span title="Largest FFR drop over any 10 mm window">Δ{vessel.maxDeltaFFR.toFixed(2)}</span>
        <span title="Pullback Pressure Gradient: 1=focal, 0=diffuse">PPG {vessel.ppgIndex.toFixed(2)}</span>
        {vessel.isIschemic && <span className="ffr-badge ischemic">Ischemic</span>}
      </div>
      <PullbackSpark pullback={vessel.pullback} />
    </li>
  );
}

function PullbackSpark({ pullback }: { pullback: VesselFFRResult['pullback'] }) {
  const width = 240;
  const height = 54;
  const padX = 4;
  const padY = 4;

  if (pullback.length < 2) {
    return <svg className="ffr-spark" width={width} height={height} />;
  }

  const minD = pullback[0].distanceMm;
  const maxD = pullback[pullback.length - 1].distanceMm;
  const spanD = Math.max(maxD - minD, 1e-6);

  // Force FFR axis range [0.5, 1.0] so 0.80 line always sits in-frame.
  const yMin = 0.5;
  const yMax = 1.0;

  const toX = (d: number) =>
    padX + ((d - minD) / spanD) * (width - padX * 2);
  const toY = (ffr: number) => {
    const clamped = Math.max(yMin, Math.min(yMax, ffr));
    return padY + ((yMax - clamped) / (yMax - yMin)) * (height - padY * 2);
  };

  const path = pullback
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(p.distanceMm).toFixed(1)} ${toY(p.ffr).toFixed(1)}`)
    .join(' ');

  const ischemiaY = toY(0.80);

  return (
    <svg className="ffr-spark" width={width} height={height} role="img" aria-label="FFR pullback curve">
      <line
        x1={padX} x2={width - padX}
        y1={ischemiaY} y2={ischemiaY}
        stroke="rgba(255, 180, 80, 0.55)"
        strokeDasharray="3 3"
        strokeWidth={1}
      />
      <path d={path} stroke="currentColor" strokeWidth={1.5} fill="none" />
    </svg>
  );
}
