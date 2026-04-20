interface VolumeResult {
  name: string;
  volumeCm3: number;
}

interface Props {
  results: VolumeResult[];
}

export function VolumeStats({ results }: Props) {
  if (results.length === 0) return null;

  return (
    <div className="volume-stats">
      <h4>Volume Measurements</h4>
      {results.map((result, i) => (
        <div key={i} className="volume-stat-row">
          <span className="volume-stat-name">{result.name}</span>
          <span className="volume-stat-value">{result.volumeCm3.toFixed(2)} cm³</span>
        </div>
      ))}
    </div>
  );
}
