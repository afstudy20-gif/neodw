import { useEffect, useRef, useState, useCallback } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import type { DicomSeriesInfo } from '../core/dicomLoader';

interface Props {
  seriesList: DicomSeriesInfo[];
  activeSeriesUID: string;
  onSelectSeries: (series: DicomSeriesInfo) => void;
  isLoading: boolean;
}

function SeriesThumbnail({ imageId }: { imageId: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!imageId || !canvasRef.current) return;
    let cancelled = false;

    cornerstone.imageLoader.loadAndCacheImage(imageId).then((image: any) => {
      if (cancelled || !canvasRef.current) return;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const { width, height } = image;
      const pixelData = image.getPixelData();

      let min = Infinity, max = -Infinity;
      for (let i = 0; i < pixelData.length; i++) {
        if (pixelData[i] < min) min = pixelData[i];
        if (pixelData[i] > max) max = pixelData[i];
      }
      const range = max - min || 1;

      const imgData = ctx.createImageData(canvas.width, canvas.height);
      const scaleX = width / canvas.width;
      const scaleY = height / canvas.height;

      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const srcX = Math.floor(x * scaleX);
          const srcY = Math.floor(y * scaleY);
          const srcIdx = srcY * width + srcX;
          const val = Math.round(((pixelData[srcIdx] - min) / range) * 255);
          const dstIdx = (y * canvas.width + x) * 4;
          imgData.data[dstIdx] = val;
          imgData.data[dstIdx + 1] = val;
          imgData.data[dstIdx + 2] = val;
          imgData.data[dstIdx + 3] = 255;
        }
      }
      ctx.putImageData(imgData, 0, 0);
    }).catch(() => {});

    return () => { cancelled = true; };
  }, [imageId]);

  return <canvas ref={canvasRef} className="series-thumbnail" width={72} height={72} />;
}

function renderFrameToCanvas(ctx: CanvasRenderingContext2D, image: any, w: number, h: number) {
  const pixelData = image.getPixelData();
  const imgData = ctx.createImageData(w, h);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < pixelData.length; i++) {
    if (pixelData[i] < min) min = pixelData[i];
    if (pixelData[i] > max) max = pixelData[i];
  }
  const range = max - min || 1;
  for (let i = 0; i < pixelData.length; i++) {
    const val = Math.round(((pixelData[i] - min) / range) * 255);
    imgData.data[i * 4] = val;
    imgData.data[i * 4 + 1] = val;
    imgData.data[i * 4 + 2] = val;
    imgData.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
}

/** Export series as WebM video. Returns abort controller. */
function exportSeriesAsVideo(
  series: DicomSeriesInfo,
  fps: number,
  onProgress: (msg: string) => void,
  signal: AbortSignal,
  loops: number = 1
): Promise<void> {
  return new Promise(async (resolve, reject) => {
    const imageIds = series.imageIds;
    if (imageIds.length < 2) { resolve(); return; }

    let firstImage: any;
    try {
      firstImage = await cornerstone.imageLoader.loadAndCacheImage(imageIds[0]);
    } catch { resolve(); return; }

    const { width, height } = firstImage;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;

    // Pre-cache every frame so the recording loop never stalls on I/O —
    // that was causing the output video to drift slower than the requested
    // FPS (each setTimeout was overshooting by the decode latency).
    const cached: any[] = [];
    for (let i = 0; i < imageIds.length; i++) {
      if (signal.aborted) { reject(new Error('Cancelled')); return; }
      onProgress(`Pre-load ${i + 1}/${imageIds.length}`);
      try {
        cached.push(await cornerstone.imageLoader.loadAndCacheImage(imageIds[i]));
      } catch {
        cached.push(null);
      }
    }

    // captureStream at 60fps ensures MediaRecorder oversamples held frames
    // instead of dropping them when the source canvas updates.
    const stream = canvas.captureStream(60);
    const chunks: Blob[] = [];
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9' : 'video/webm';
    const pixels = width * height;
    const bitrate = Math.min(20_000_000, Math.max(6_000_000, Math.round(pixels * 0.08)));
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    const recDone = new Promise<void>((r) => { recorder.onstop = () => r(); });
    recorder.start();

    // Deterministic timing: schedule each frame against performance.now
    // so we don't accumulate setTimeout drift.
    const frameDurationMs = 1000 / fps;
    const tStart = performance.now();
    const totalFrames = imageIds.length * Math.max(1, loops);
    for (let g = 0; g < totalFrames; g++) {
      if (signal.aborted) {
        recorder.stop();
        reject(new Error('Cancelled'));
        return;
      }
      const i = g % imageIds.length;
      onProgress(`Rec ${g + 1}/${totalFrames}`);
      if (cached[i]) renderFrameToCanvas(ctx, cached[i], width, height);
      const target = tStart + (g + 1) * frameDurationMs;
      const remain = target - performance.now();
      if (remain > 0) await new Promise((r) => setTimeout(r, remain));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }

    recorder.stop();
    await recDone;

    if (signal.aborted) { reject(new Error('Cancelled')); return; }

    const blob = new Blob(chunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const name = (series.seriesDescription || 'angio').replace(/[^a-zA-Z0-9]/g, '_');
    a.download = `${name}_${series.numImages}fr.webm`;
    a.click();
    URL.revokeObjectURL(url);
    resolve();
  });
}

interface ContextMenuState {
  x: number;
  y: number;
  series: DicomSeriesInfo;
}

/** Export multiple series concatenated into a single WebM. */
async function exportSeriesListAsSingleVideo(
  seriesList: DicomSeriesInfo[],
  fps: number,
  onProgress: (msg: string) => void,
  signal: AbortSignal,
  loops: number = 1
): Promise<void> {
  if (seriesList.length === 0) return;

  onProgress('Resolving canvas size…');
  let maxW = 0;
  let maxH = 0;
  const firstImages: Array<any | null> = [];
  for (const s of seriesList) {
    if (signal.aborted) throw new Error('Cancelled');
    try {
      const img: any = await cornerstone.imageLoader.loadAndCacheImage(s.imageIds[0]);
      firstImages.push(img);
      if (img.width > maxW) maxW = img.width;
      if (img.height > maxH) maxH = img.height;
    } catch {
      firstImages.push(null);
    }
  }
  if (maxW === 0 || maxH === 0) return;

  const canvas = document.createElement('canvas');
  canvas.width = maxW;
  canvas.height = maxH;
  const ctx = canvas.getContext('2d')!;

  const stream = canvas.captureStream(60);
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9' : 'video/webm';
  const pixels = maxW * maxH;
  const bitrate = Math.min(20_000_000, Math.max(6_000_000, Math.round(pixels * 0.08)));
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  const recDone = new Promise<void>((r) => { recorder.onstop = () => r(); });
  recorder.start();

  const frameDurationMs = 1000 / Math.max(1, fps);
  const tStart = performance.now();
  let globalIdx = 0;

  for (let si = 0; si < seriesList.length; si += 1) {
    const s = seriesList[si];
    // Pre-cache this series' frames
    const cached: any[] = [];
    for (let i = 0; i < s.imageIds.length; i += 1) {
      if (signal.aborted) { recorder.stop(); throw new Error('Cancelled'); }
      onProgress(`Pre-load ${si + 1}/${seriesList.length} · ${i + 1}/${s.imageIds.length}`);
      try { cached.push(await cornerstone.imageLoader.loadAndCacheImage(s.imageIds[i])); }
      catch { cached.push(null); }
    }
    const perSeriesTotal = s.imageIds.length * Math.max(1, loops);
    for (let g = 0; g < perSeriesTotal; g += 1) {
      if (signal.aborted) { recorder.stop(); throw new Error('Cancelled'); }
      const i = g % s.imageIds.length;
      onProgress(`Rec ${si + 1}/${seriesList.length} · ${g + 1}/${perSeriesTotal}`);
      const img = cached[i];
      if (img) {
        // Render into tmp canvas at native size, then letterbox onto main canvas.
        const tmp = document.createElement('canvas');
        tmp.width = img.width;
        tmp.height = img.height;
        const tctx = tmp.getContext('2d')!;
        renderFrameToCanvas(tctx, img, img.width, img.height);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, maxW, maxH);
        const scale = Math.min(maxW / img.width, maxH / img.height);
        const dw = img.width * scale;
        const dh = img.height * scale;
        ctx.drawImage(tmp, (maxW - dw) / 2, (maxH - dh) / 2, dw, dh);
      }
      globalIdx += 1;
      const target = tStart + globalIdx * frameDurationMs;
      const remain = target - performance.now();
      if (remain > 0) await new Promise((r) => setTimeout(r, remain));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
  }

  recorder.stop();
  await recDone;
  if (signal.aborted) throw new Error('Cancelled');

  const blob = new Blob(chunks, { type: 'video/webm' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `angio_${seriesList.length}series_${Date.now()}.webm`;
  a.click();
  URL.revokeObjectURL(url);
}

async function exportSeriesAsDicom(
  series: DicomSeriesInfo,
  onProgress: (msg: string) => void,
  signal: AbortSignal
): Promise<void> {
  const baseIds = new Set<string>();
  for (const id of series.imageIds) {
    const idx = id.indexOf('&frame=');
    baseIds.add(idx >= 0 ? id.slice(0, idx) : id);
  }
  let count = 0;
  for (const baseId of baseIds) {
    if (signal.aborted) throw new Error('Cancelled');
    count += 1;
    onProgress(`DICOM ${count}/${baseIds.size}`);
    const url = baseId.startsWith('wadouri:') ? baseId.slice('wadouri:'.length) : baseId;
    if (!url.startsWith('blob:') && !url.startsWith('http')) continue;
    try {
      const resp = await fetch(url);
      const blob = await resp.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      const name = (series.seriesDescription || 'angio').replace(/[^a-zA-Z0-9]/g, '_');
      a.download = `${name}_${count}.dcm`;
      a.click();
      await new Promise((r) => setTimeout(r, 80));
      URL.revokeObjectURL(blobUrl);
    } catch { /* skip file */ }
  }
}

export function SeriesPanel({ seriesList, activeSeriesUID, onSelectSeries, isLoading }: Props) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState('');
  const [selectedUIDs, setSelectedUIDs] = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);

  function toggleSelected(uid: string) {
    setSelectedUIDs((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }

  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [contextMenu]);

  const handleExportVideoSeparate = useCallback(async (list: DicomSeriesInfo[], loops: number = 1, fps: number = 15) => {
    setContextMenu(null);
    window.dispatchEvent(new CustomEvent('angio:cine-pause'));
    setExporting(true);
    setExportMsg('Starting…');
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      for (let i = 0; i < list.length; i += 1) {
        const s = list[i];
        setExportMsg(`Series ${i + 1}/${list.length}: ${s.seriesDescription || 'video'}`);
        await exportSeriesAsVideo(s, fps, setExportMsg, ac.signal, loops);
      }
      setExportMsg('Done!');
      await new Promise((r) => setTimeout(r, 400));
    } catch (err: any) {
      if (err.message !== 'Cancelled') console.error('Export failed:', err);
    } finally {
      setExporting(false);
      setExportMsg('');
      abortRef.current = null;
    }
  }, []);

  const handleExportVideoMerged = useCallback(async (list: DicomSeriesInfo[], loops: number = 1, fps: number = 15) => {
    setContextMenu(null);
    window.dispatchEvent(new CustomEvent('angio:cine-pause'));
    setExporting(true);
    setExportMsg('Starting…');
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await exportSeriesListAsSingleVideo(list, fps, setExportMsg, ac.signal, loops);
      setExportMsg('Done!');
      await new Promise((r) => setTimeout(r, 400));
    } catch (err: any) {
      if (err.message !== 'Cancelled') console.error('Merged export failed:', err);
    } finally {
      setExporting(false);
      setExportMsg('');
      abortRef.current = null;
    }
  }, []);

  const handleExportDicom = useCallback(async (list: DicomSeriesInfo[]) => {
    setContextMenu(null);
    setExporting(true);
    setExportMsg('Starting…');
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      for (let i = 0; i < list.length; i += 1) {
        const s = list[i];
        setExportMsg(`Series ${i + 1}/${list.length}: DICOM export`);
        await exportSeriesAsDicom(s, setExportMsg, ac.signal);
      }
      setExportMsg('Done!');
      await new Promise((r) => setTimeout(r, 400));
    } catch (err: any) {
      if (err.message !== 'Cancelled') console.error('Export failed:', err);
    } finally {
      setExporting(false);
      setExportMsg('');
      abortRef.current = null;
    }
  }, []);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const allSelected = seriesList.length > 0 && selectedUIDs.size === seriesList.length;
  const someSelected = selectedUIDs.size > 0 && !allSelected;

  function toggleAll() {
    if (allSelected) setSelectedUIDs(new Set());
    else setSelectedUIDs(new Set(seriesList.map((s) => s.seriesInstanceUID)));
  }

  return (
    <aside className="series-panel">
      <div className="panel-header">
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 11 }}>
          <input
            type="checkbox"
            checked={allSelected}
            ref={(el) => { if (el) el.indeterminate = someSelected; }}
            onChange={toggleAll}
            className="series-check"
            style={{ position: 'static', width: 14, height: 14 }}
            title="Tümünü seç / temizle"
          />
          <span>Series</span>
        </label>
        <span className="panel-pill">{selectedUIDs.size > 0 ? `${selectedUIDs.size}/${seriesList.length}` : seriesList.length}</span>
      </div>
      <div className="series-list">
        {seriesList.map((series) => {
          const uid = series.seriesInstanceUID;
          const checked = selectedUIDs.has(uid);
          return (
            <div
              key={uid}
              className={`series-card compact ${uid === activeSeriesUID ? 'active' : ''} ${checked ? 'selected' : ''}`}
              onClick={() => onSelectSeries(series)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setContextMenu({ x: e.clientX, y: e.clientY, series });
              }}
              draggable={!isLoading}
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-angio-series', uid);
                e.dataTransfer.effectAllowed = 'copy';
              }}
              title="Sol tık: aç · Sağ tık: export menüsü · Checkbox: toplu seçim"
              style={{ opacity: isLoading ? 0.5 : 1, cursor: isLoading ? 'not-allowed' : 'pointer' }}
            >
              <input
                type="checkbox"
                className="series-check"
                checked={checked}
                onClick={(e) => e.stopPropagation()}
                onChange={() => toggleSelected(uid)}
                title="Toplu export için seç"
              />
              <SeriesThumbnail imageId={series.thumbnailImageId} />
              <div className="series-card-info compact">
                <div className="series-card-top">
                  <span className="series-modality">{series.modality}</span>
                  <span className="panel-pill">{series.numImages}</span>
                </div>
                <strong>{series.seriesDescription || 'Unknown Series'}</strong>
                <span>{series.studyDescription || 'Unknown Study'}</span>
              </div>
            </div>
          );
        })}
      </div>

      {contextMenu && (() => {
        const targets = selectedUIDs.size > 0
          ? seriesList.filter((s) => selectedUIDs.has(s.seriesInstanceUID))
          : [contextMenu.series];
        const label = targets.length > 1 ? `${targets.length} seri` : (contextMenu.series.seriesDescription || 'seri');
        const totalFrames = targets.reduce((a, s) => a + s.numImages, 0);
        return (
          <div
            className="series-context-menu"
            style={{ top: contextMenu.y, left: contextMenu.x }}
          >
            <div className="series-context-label">{label}</div>
            {targets.length > 1 && (
              <>
                <div className="series-context-group">Tek video ({targets.length} seri · {totalFrames} frame)</div>
                <button onClick={() => handleExportVideoMerged(targets, 1, 15)}>1 loop · 15 fps</button>
                <button onClick={() => handleExportVideoMerged(targets, 1, 30)}>1 loop · 30 fps</button>
                <button onClick={() => handleExportVideoMerged(targets, 2, 15)}>2 loop · 15 fps</button>
                <button onClick={() => handleExportVideoMerged(targets, 2, 30)}>2 loop · 30 fps</button>
                <div className="series-context-group">Ayrı ayrı video ({targets.length}×)</div>
                <button onClick={() => handleExportVideoSeparate(targets, 1, 15)}>1 loop · 15 fps</button>
                <button onClick={() => handleExportVideoSeparate(targets, 1, 30)}>1 loop · 30 fps</button>
                <button onClick={() => handleExportVideoSeparate(targets, 2, 15)}>2 loop · 15 fps</button>
                <button onClick={() => handleExportVideoSeparate(targets, 2, 30)}>2 loop · 30 fps</button>
              </>
            )}
            {targets.length === 1 && (
              <>
                <div className="series-context-group">Export Video ({totalFrames} frames)</div>
                <button onClick={() => handleExportVideoSeparate(targets, 1, 15)}>1 loop · 15 fps</button>
                <button onClick={() => handleExportVideoSeparate(targets, 1, 30)}>1 loop · 30 fps</button>
                <button onClick={() => handleExportVideoSeparate(targets, 2, 15)}>2 loop · 15 fps</button>
                <button onClick={() => handleExportVideoSeparate(targets, 2, 30)}>2 loop · 30 fps</button>
              </>
            )}
            <div className="series-context-group">Diğer</div>
            <button onClick={() => handleExportDicom(targets)}>
              Export DICOM
            </button>
            <button onClick={() => { onSelectSeries(contextMenu.series); setContextMenu(null); }}>
              Load Series
            </button>
          </div>
        );
      })()}

      {exporting && (
        <div className="series-export-overlay">
          <div className="spinner" />
          <span>{exportMsg}</span>
          <button className="export-cancel-btn" onClick={handleCancel}>Cancel</button>
        </div>
      )}
    </aside>
  );
}
