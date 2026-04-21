import { useEffect, useRef } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import type { DicomSeriesInfo } from '../core/dicomLoader';

interface Props {
  seriesList: DicomSeriesInfo[];
  activeSeriesUID: string;
  onSelectSeries: (series: DicomSeriesInfo) => void;
  isLoading: boolean;
}

function SeriesThumb({ imageId }: { imageId: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!imageId || !canvasRef.current) return;
    let cancelled = false;
    const canvas = canvasRef.current;

    cornerstone.imageLoader
      .loadAndCacheImage(imageId)
      .then((image: any) => {
        if (cancelled || !canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const pixelData = image.getPixelData?.() ?? image.imageFrame?.pixelData;
        if (!pixelData) return;
        const { width, height } = image;
        // Sample a representative WL from the scan: use DICOM window if
        // available, otherwise fall back to min/max contrast stretch.
        let minPx = Infinity;
        let maxPx = -Infinity;
        for (let i = 0; i < pixelData.length; i++) {
          const v = pixelData[i];
          if (v < minPx) minPx = v;
          if (v > maxPx) maxPx = v;
        }
        const range = maxPx - minPx || 1;
        const tmp = document.createElement('canvas');
        tmp.width = width;
        tmp.height = height;
        const tctx = tmp.getContext('2d');
        if (!tctx) return;
        const img = tctx.createImageData(width, height);
        const samples = Math.round(pixelData.length / (width * height));
        for (let i = 0, j = 0; i < pixelData.length; i += samples, j += 4) {
          const v = Math.max(0, Math.min(255, Math.round(((pixelData[i] - minPx) / range) * 255)));
          img.data[j] = v;
          img.data[j + 1] = v;
          img.data[j + 2] = v;
          img.data[j + 3] = 255;
        }
        tctx.putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const ratio = Math.min(canvas.width / width, canvas.height / height);
        const w = width * ratio;
        const h = height * ratio;
        ctx.drawImage(tmp, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      })
      .catch(() => { /* non-renderable, leave blank */ });

    return () => { cancelled = true; };
  }, [imageId]);

  return <canvas ref={canvasRef} className="ccta-series-thumb" width={96} height={72} />;
}

export function SeriesPanel({ seriesList, activeSeriesUID, onSelectSeries, isLoading }: Props) {
  return (
    <aside className="series-panel">
      <div className="panel-header">
        <span>Series</span>
        <span className="panel-pill">{seriesList.length}</span>
      </div>
      <div className="series-list">
        {seriesList.map((series) => {
          // Pick a middle-slice imageId for a more diagnostic thumbnail
          // than scout/first slice.
          const mid = Math.floor(series.imageIds.length / 2);
          const thumbId = series.imageIds[mid] ?? series.imageIds[0];
          return (
            <button
              key={series.seriesInstanceUID}
              className={`series-card with-thumb ${series.seriesInstanceUID === activeSeriesUID ? 'active' : ''}`}
              onClick={() => onSelectSeries(series)}
              disabled={isLoading}
            >
              <SeriesThumb imageId={thumbId} />
              <div className="series-card-info">
                <div className="series-card-top">
                  <span className="series-modality">{series.modality}</span>
                  <span className="panel-pill">{series.numImages}</span>
                </div>
                <strong>{series.seriesDescription || 'Unknown Series'}</strong>
                <span>{series.studyDescription || 'Unknown Study'}</span>
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
