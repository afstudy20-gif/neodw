import type { DicomSeriesInfo } from '../core/dicomLoader';

interface Props {
  seriesList: DicomSeriesInfo[];
  activeSeriesUID: string;
  onSelectSeries: (series: DicomSeriesInfo) => void;
  isLoading: boolean;
}

export function SeriesPanel({ seriesList, activeSeriesUID, onSelectSeries, isLoading }: Props) {
  return (
    <aside className="series-panel">
      <div className="panel-header">
        <span>Series</span>
        <span className="panel-pill">{seriesList.length}</span>
      </div>
      <div className="series-list">
        {seriesList.map((series) => (
          <button
            key={series.seriesInstanceUID}
            className={`series-card ${series.seriesInstanceUID === activeSeriesUID ? 'active' : ''}`}
            onClick={() => onSelectSeries(series)}
            disabled={isLoading}
          >
            <div className="series-card-top">
              <span className="series-modality">{series.modality}</span>
              <span className="panel-pill">{series.numImages}</span>
            </div>
            <strong>{series.seriesDescription || 'Unknown Series'}</strong>
            <span>{series.studyDescription || 'Unknown Study'}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
