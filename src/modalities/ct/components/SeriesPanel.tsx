import { useState, useEffect, useRef, useCallback } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import { DicomSeriesInfo } from '../core/dicomLoader';

interface Props {
  seriesList: DicomSeriesInfo[];
  activeSeriesUID: string;
  onSelectSeries: (series: DicomSeriesInfo) => void;
  onOpen2DViewer?: (series: DicomSeriesInfo) => void;
  isLoading: boolean;
}

async function generateThumbnail(imageId: string): Promise<string | null> {
  try {
    const image = await cornerstone.imageLoader.loadAndCacheImage(imageId);
    if (!image) return null;
    const canvas = document.createElement('canvas');
    const size = 64;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const { rows, columns } = image;
    const pixelData = image.getPixelData();
    if (!pixelData || pixelData.length === 0) return null;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < pixelData.length; i++) {
      if (pixelData[i] < min) min = pixelData[i];
      if (pixelData[i] > max) max = pixelData[i];
    }
    const range = max - min || 1;
    const imgData = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const srcX = Math.floor(x * columns / size);
        const srcY = Math.floor(y * rows / size);
        const val = Math.round(((pixelData[srcY * columns + srcX] - min) / range) * 255);
        const clamped = Math.max(0, Math.min(255, val));
        const dstIdx = (y * size + x) * 4;
        imgData.data[dstIdx] = clamped;
        imgData.data[dstIdx + 1] = clamped;
        imgData.data[dstIdx + 2] = clamped;
        imgData.data[dstIdx + 3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch { return null; }
}

export function SeriesPanel({ seriesList, activeSeriesUID, onSelectSeries, onOpen2DViewer, isLoading }: Props) {
  const [thumbnails, setThumbnails] = useState<Record<string, string | null>>({});
  const loadedRef = useRef<Set<string>>(new Set());

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; series: DicomSeriesInfo } | null>(null);

  useEffect(() => {
    for (const series of seriesList) {
      if (loadedRef.current.has(series.seriesInstanceUID)) continue;
      loadedRef.current.add(series.seriesInstanceUID);
      const midIdx = Math.floor(series.imageIds.length / 2);
      generateThumbnail(series.imageIds[midIdx]).then(thumb => {
        if (thumb) setThumbnails(prev => ({ ...prev, [series.seriesInstanceUID]: thumb }));
      });
    }
  }, [seriesList]);

  // Close context menu on click elsewhere
  useEffect(() => {
    if (!ctxMenu) return;
    const handler = () => setCtxMenu(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [ctxMenu]);

  const handleContextMenu = useCallback((e: React.MouseEvent, series: DicomSeriesInfo) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, series });
  }, []);

  return (
    <div className="series-panel">
      <div className="series-panel-header">
        <h3>SERIES</h3>
        <span className="series-count">{seriesList.length}</span>
      </div>
      <div className="series-panel-list">
        {seriesList.map((series) => {
          const thumb = thumbnails[series.seriesInstanceUID];
          const isActive = series.seriesInstanceUID === activeSeriesUID;
          return (
            <button
              key={series.seriesInstanceUID}
              className={`series-panel-item ${isActive ? 'active' : ''}`}
              onClick={() => onSelectSeries(series)}
              onContextMenu={(e) => handleContextMenu(e, series)}
              disabled={isLoading}
              title={`${series.seriesDescription}\n${series.modality} - ${series.numImages} images\nRight-click for options`}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', minHeight: 52 }}
            >
              <div style={{
                width: 48, height: 48, flexShrink: 0,
                background: '#111', borderRadius: 4, overflow: 'hidden',
                border: isActive ? '2px solid var(--accent)' : '2px solid transparent',
              }}>
                {thumb && <img src={thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
              </div>
              <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                <div className="series-panel-item-header" style={{ marginBottom: 2 }}>
                  <span className="series-modality">{series.modality}</span>
                  <span className="series-count-badge">{series.numImages}</span>
                </div>
                <div className="series-panel-item-desc" style={{ fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {series.seriesDescription || 'Unknown'}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Context Menu */}
      {ctxMenu && (
        <div style={{
          position: 'fixed', top: ctxMenu.y, left: ctxMenu.x, zIndex: 200,
          background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 6,
          boxShadow: '0 8px 24px rgba(0,0,0,0.6)', padding: '4px 0', minWidth: 180,
        }}>
          <button
            style={{ display: 'block', width: '100%', padding: '8px 14px', background: 'none', border: 'none', color: 'var(--text-primary)', fontSize: '12px', cursor: 'pointer', textAlign: 'left' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'color-mix(in oklch, var(--nd-ink) 6%, transparent)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
            onClick={() => { onSelectSeries(ctxMenu.series); setCtxMenu(null); }}
          >
            Open in MPR
          </button>
          <button
            style={{ display: 'block', width: '100%', padding: '8px 14px', background: 'none', border: 'none', color: 'var(--text-primary)', fontSize: '12px', cursor: 'pointer', textAlign: 'left' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'color-mix(in oklch, var(--nd-ink) 6%, transparent)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
            onClick={() => { onOpen2DViewer?.(ctxMenu.series); setCtxMenu(null); }}
          >
            Open in 2D Viewer
          </button>
          <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
          <button
            style={{ display: 'block', width: '100%', padding: '8px 14px', background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '11px', cursor: 'pointer', textAlign: 'left' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'color-mix(in oklch, var(--nd-ink) 6%, transparent)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
            onClick={() => setCtxMenu(null)}
          >
            {ctxMenu.series.seriesDescription} ({ctxMenu.series.numImages} images)
          </button>
        </div>
      )}
    </div>
  );
}
