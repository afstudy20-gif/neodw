import { useEffect, useRef, useState } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import type { DicomSeriesInfo } from '../core/dicomLoader';

interface Props {
  series: DicomSeriesInfo;
  onClose: () => void;
}

// Render a Secondary Capture (typically pre-rendered 3D from the scanner
// workstation, often RGB) directly via cornerstone's loadImageToCanvas.
// We skip the MPR volume pipeline because SC is not a volumetric CT
// dataset — it's a screenshot/photo embedded in DICOM. Horos and similar
// PACS viewers handle SC with a simple 2D image viewer; we do the same.
export function SecondaryCaptureViewer({ series, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [frame, setFrame] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const imageId = series.imageIds[frame] ?? series.imageIds[0];
  const totalFrames = series.imageIds.length;

  useEffect(() => {
    let cancelled = false;
    async function render() {
      if (!canvasRef.current || !imageId) return;
      setLoading(true);
      setError(null);
      try {
        await cornerstone.utilities.loadImageToCanvas({
          canvas: canvasRef.current,
          imageId,
          requestType: cornerstone.Enums.RequestType.Interaction,
          imageAspect: true,
        });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load SC image');
      }
      if (!cancelled) setLoading(false);
    }
    void render();
    return () => {
      cancelled = true;
    };
  }, [imageId]);

  return (
    <div className="sc-viewer-overlay">
      <header className="sc-viewer-header">
        <div>
          <h2>{series.seriesDescription || 'Secondary Capture'}</h2>
          <p>{series.modality} · {totalFrames} frame{totalFrames === 1 ? '' : 's'}</p>
        </div>
        <button className="sc-viewer-close" onClick={onClose} aria-label="Kapat">✕</button>
      </header>
      <div className="sc-viewer-canvas-wrap">
        <canvas ref={canvasRef} className="sc-viewer-canvas" />
        {loading && <div className="sc-viewer-loading">Loading…</div>}
        {error && <div className="sc-viewer-error">{error}</div>}
      </div>
      {totalFrames > 1 && (
        <div className="sc-viewer-controls">
          <label>
            Frame
            <input
              type="range"
              min={0}
              max={totalFrames - 1}
              value={frame}
              onChange={(e) => setFrame(Number.parseInt(e.target.value, 10))}
            />
            <span>{frame + 1}/{totalFrames}</span>
          </label>
        </div>
      )}
    </div>
  );
}
