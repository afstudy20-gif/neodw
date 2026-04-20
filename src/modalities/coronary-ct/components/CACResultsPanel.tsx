import {
  classifyCACDRS,
  type CACPatientResult,
  type CACVesselResult,
} from '../coronary/cac/cacScoring';

interface Props {
  result: CACPatientResult | null;
  error: string | null;
  busy: boolean;
}

const CATEGORY_LABELS: Record<ReturnType<typeof classifyCACDRS>, string> = {
  zero: 'CAC 0 — No calcium',
  mild: 'CAC 1–99 — Mild',
  moderate: 'CAC 100–399 — Moderate',
  severe: 'CAC ≥ 400 — Severe',
};

/**
 * Read-only display of a patient-level CAC scoring run.
 *
 * Surfaces:
 *   - Total Agatston-equivalent score (surrogate; not DICOM-slice native).
 *   - Total calcium volume (mm^3).
 *   - CAC-DRS category based on the standard cut-points.
 *   - Per-vessel breakdown with peak and mean HU + voxel count so a
 *     clinician can sanity-check where the burden concentrates.
 */
export function CACResultsPanel({ result, error, busy }: Props) {
  if (busy) {
    return <div className="ffr-results-empty">Scanning coronary tree for calcium…</div>;
  }
  if (error) {
    return <div className="ffr-results-empty error">{error}</div>;
  }
  if (!result) {
    return (
      <div className="ffr-results-empty">
        Press <strong>Run Calcium Score</strong> to estimate Agatston, volume, and CAC-DRS category.
      </div>
    );
  }

  return (
    <div className="ffr-results cac-results">
      <div className={`cac-category-banner severity-${result.category}`}>
        <span className="cac-banner-score">{result.totalAgatston}</span>
        <span className="cac-banner-label">{CATEGORY_LABELS[result.category]}</span>
      </div>
      <div className="ffr-results-summary">
        <span>Volume: {result.totalVolumeMm3.toFixed(1)} mm³</span>
        <span>Vessels: {result.vessels.length}</span>
      </div>
      <ul className="ffr-vessel-list">
        {result.vessels.map((vessel) => (
          <VesselCACCard key={vessel.vesselId} vessel={vessel} />
        ))}
      </ul>
    </div>
  );
}

function VesselCACCard({ vessel }: { vessel: CACVesselResult }) {
  const severity = classifyCACDRS(vessel.agatstonScore);
  return (
    <li className={`ffr-vessel-card severity-${severity}`}>
      <div className="ffr-vessel-head">
        <span className="ffr-vessel-label">{vessel.label}</span>
        <span className="ffr-value">{vessel.agatstonScore}</span>
      </div>
      <div className="ffr-vessel-metrics">
        <span title="Total calcium volume around this vessel">{vessel.volumeMm3.toFixed(1)} mm³</span>
        <span title="Peak Hounsfield unit inside calcium voxels">Peak {vessel.peakHU} HU</span>
        <span title="Mean HU across calcium voxels">Mean {vessel.meanCalciumHU} HU</span>
      </div>
    </li>
  );
}
