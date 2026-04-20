import { DicomSeriesInfo } from '../core/dicomLoader';

interface Props {
  series: DicomSeriesInfo | null;
  isVisible: boolean;
  onToggle: () => void;
}

export function MetadataPanel({ series, isVisible, onToggle }: Props) {
  return (
    <>
      <button className="metadata-toggle" onClick={onToggle} title="DICOM Info">
        {isVisible ? '✕' : 'ℹ'}
      </button>
      {isVisible && series && (
        <div className="metadata-panel">
          <h3>DICOM Information</h3>
          <div className="metadata-section">
            <h4>Patient</h4>
            <MetadataRow label="Name" value={series.patientName} />
          </div>
          <div className="metadata-section">
            <h4>Study</h4>
            <MetadataRow label="Description" value={series.studyDescription} />
          </div>
          <div className="metadata-section">
            <h4>Series</h4>
            <MetadataRow label="Description" value={series.seriesDescription} />
            <MetadataRow label="Modality" value={series.modality} />
            <MetadataRow label="Images" value={String(series.numImages)} />
            <MetadataRow label="Series UID" value={series.seriesInstanceUID} />
          </div>
        </div>
      )}
    </>
  );
}

function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="metadata-row">
      <span className="metadata-label">{label}</span>
      <span className="metadata-value" title={value}>{value || '—'}</span>
    </div>
  );
}
