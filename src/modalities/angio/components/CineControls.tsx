import { useCallback, useEffect, useRef, useState } from 'react';
import * as cornerstone from '@cornerstonejs/core';

interface Props {
  renderingEngineId: string;
  viewportId: string;
  imageCount: number;
  currentIndex: number;
  onFrameChange: (index: number) => void;
  seriesIndex?: number;
  seriesCount?: number;
  onPrevSeries?: () => void;
  onNextSeries?: () => void;
}

export function CineControls({ renderingEngineId, viewportId, imageCount, currentIndex, onFrameChange, seriesIndex, seriesCount, onPrevSeries, onNextSeries }: Props) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [fps, setFps] = useState(15);
  const [loop, setLoop] = useState(true);
  const [exporting, setExporting] = useState<string | null>(null);
  const rafRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const frameIndexRef = useRef(currentIndex);

  function getViewportCanvas(): HTMLCanvasElement | null {
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    const vp = engine?.getViewport(viewportId) as cornerstone.Types.IStackViewport | undefined;
    const el = vp?.element;
    return (el?.querySelector('canvas.cornerstone-canvas') as HTMLCanvasElement) ?? null;
  }

  function savePNG() {
    const canvas = getViewportCanvas();
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `angio-frame-${currentIndex + 1}-${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  }

  async function saveVideo() {
    const canvas = getViewportCanvas();
    if (!canvas || imageCount < 2) return;
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    const vp = engine?.getViewport(viewportId) as cornerstone.Types.IStackViewport | undefined;
    if (!vp) return;

    // Pause cine during recording so playback RAF does not fight with our
    // deterministic frame-by-frame walk.
    setIsPlaying(false);
    setExporting('Preparing…');

    try {
      // Pre-cache every image so setImageIdIndex during recording is instant.
      const getIds = (vp as any).getImageIds?.bind(vp) as (() => string[]) | undefined;
      const ids = getIds?.() ?? [];
      for (let i = 0; i < ids.length; i += 1) {
        setExporting(`Pre-load ${i + 1}/${ids.length}`);
        try { await cornerstone.imageLoader.loadAndCacheImage(ids[i]); } catch { /* skip */ }
      }

      // Higher capture framerate than playback FPS so MediaRecorder doesn't
      // drop the first frame after each setImageIdIndex and the output stays
      // smooth. Encoder targets the same bitrate regardless.
      const captureFps = 60;
      const stream = (canvas as any).captureStream?.(captureFps) as MediaStream | undefined;
      if (!stream) throw new Error('captureStream unavailable');
      const mimeCandidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
      const mime = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? 'video/webm';
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const done = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
      recorder.start();

      const frameInterval = 1000 / Math.max(1, fps);
      const element = vp.element as HTMLElement | undefined;
      const waitFrames = () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r()))
        );
      const waitForRender = () =>
        new Promise<void>((r) => {
          if (!element) return r();
          const evt = (cornerstone as any).Enums?.Events?.IMAGE_RENDERED ?? 'IMAGE_RENDERED';
          const handler = () => { element.removeEventListener(evt, handler); r(); };
          element.addEventListener(evt, handler, { once: true });
          try { vp.render(); } catch { handler(); }
        });

      // Deterministic schedule: target time for frame i+1 = start + (i+1)*interval.
      // Prevents setTimeout drift from decode latency stretching output video.
      const tStart = performance.now();
      for (let i = 0; i < imageCount; i += 1) {
        setExporting(`Recording ${i + 1}/${imageCount}`);
        try { (vp as any).setImageIdIndex?.(i); } catch { /* skip */ }
        await waitForRender();
        await waitFrames();
        const target = tStart + (i + 1) * frameInterval;
        const remain = target - performance.now();
        if (remain > 0) await new Promise<void>((r) => setTimeout(r, remain));
      }

      // Final idle flush so the last frame gets captured before stop().
      await waitFrames();
      recorder.stop();
      await done;

      const blob = new Blob(chunks, { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `angio-series-${seriesIndex != null ? seriesIndex + 1 : ''}-${Date.now()}.webm`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      console.error('[angio] video export failed', err);
    } finally {
      setExporting(null);
    }
  }

  async function saveDicom() {
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    const vp = engine?.getViewport(viewportId) as cornerstone.Types.IStackViewport | undefined;
    if (!vp) return;
    const getIds = (vp as any).getImageIds?.bind(vp) as (() => string[]) | undefined;
    const ids = getIds?.() ?? [];
    if (ids.length === 0) return;
    setExporting('Exporting DICOM…');
    try {
      // Dedup multi-frame base (imageIds like `wadouri:blob:...&frame=N` share a base file)
      const baseIds = new Set<string>();
      for (const id of ids) {
        const idx = id.indexOf('&frame=');
        baseIds.add(idx >= 0 ? id.slice(0, idx) : id);
      }
      let count = 0;
      for (const baseId of baseIds) {
        count += 1;
        setExporting(`Exporting ${count}/${baseIds.size}`);
        const blobUrl = baseId.startsWith('wadouri:') ? baseId.slice('wadouri:'.length) : baseId;
        if (!blobUrl.startsWith('blob:') && !blobUrl.startsWith('http')) continue;
        const resp = await fetch(blobUrl);
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `angio-series-${seriesIndex != null ? seriesIndex + 1 : ''}-${count}.dcm`;
        a.click();
        await new Promise((r) => setTimeout(r, 80));
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error('[angio] DICOM export failed', err);
    } finally {
      setExporting(null);
    }
  }

  useEffect(() => {
    frameIndexRef.current = currentIndex;
  }, [currentIndex]);

  // When a new series loads (imageCount changes), restart cine from frame 0
  // if we were already playing so "Next Series" / "Prev Series" auto-advance smoothly.
  useEffect(() => {
    frameIndexRef.current = 0;
  }, [imageCount]);

  // Global pause signal — emitted by SeriesPanel before starting a video/DICOM
  // export so our cine RAF loop doesn't fight the recorder.
  useEffect(() => {
    const handler = () => setIsPlaying(false);
    window.addEventListener('angio:cine-pause', handler);
    return () => window.removeEventListener('angio:cine-pause', handler);
  }, []);

  const goToFrame = useCallback((index: number) => {
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    if (!engine) return;

    const viewport = engine.getViewport(viewportId) as cornerstone.Types.IStackViewport | undefined;
    if (!viewport) return;

    const clampedIndex = Math.max(0, Math.min(imageCount - 1, index));
    viewport.setImageIdIndex(clampedIndex);
    onFrameChange(clampedIndex);
  }, [renderingEngineId, viewportId, imageCount, onFrameChange]);

  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }

    const interval = 1000 / fps;

    const animate = (time: number) => {
      if (time - lastTimeRef.current >= interval) {
        lastTimeRef.current = time;
        let next = frameIndexRef.current + 1;
        if (next >= imageCount) {
          if (loop) {
            next = 0;
          } else {
            setIsPlaying(false);
            return;
          }
        }
        goToFrame(next);
      }
      rafRef.current = requestAnimationFrame(animate);
    };

    lastTimeRef.current = performance.now();
    rafRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isPlaying, fps, loop, imageCount, goToFrame]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      ) {
        return;
      }

      if (event.key === ' ') {
        event.preventDefault();
        setIsPlaying((p) => !p);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        setIsPlaying(false);
        goToFrame(frameIndexRef.current + 1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setIsPlaying(false);
        goToFrame(frameIndexRef.current - 1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        setIsPlaying(false);
        goToFrame(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        setIsPlaying(false);
        goToFrame(imageCount - 1);
      } else if (event.key === 'PageUp') {
        event.preventDefault();
        onPrevSeries?.();
        setIsPlaying(true);
      } else if (event.key === 'PageDown') {
        event.preventDefault();
        onNextSeries?.();
        setIsPlaying(true);
      }
    }

    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, [goToFrame, imageCount]);

  const singleFrame = imageCount <= 1;

  return (
    <div className="cine-controls">
      <div className="cine-row">
        {onPrevSeries && seriesCount != null && seriesCount > 1 && (
          <button
            className="cine-btn cine-series"
            onClick={() => { onPrevSeries(); setIsPlaying(true); }}
            disabled={seriesIndex === 0}
            title="Önceki seri (PageUp) — otomatik oynatır"
          >
            &#x23EE;
          </button>
        )}
        <button
          className="cine-btn"
          onClick={() => { setIsPlaying(false); goToFrame(currentIndex - 1); }}
          disabled={singleFrame}
          title="Önceki frame (Sol ok)"
        >
          &#x23F4;
        </button>
        <button
          className={`cine-btn cine-play ${isPlaying ? 'active' : ''}`}
          onClick={() => setIsPlaying(!isPlaying)}
          disabled={singleFrame}
          title={isPlaying ? 'Duraklat (Space)' : 'Başlat (Space)'}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? '❚❚' : '►'}
        </button>
        <button
          className="cine-btn"
          onClick={() => { setIsPlaying(false); goToFrame(currentIndex + 1); }}
          disabled={singleFrame}
          title="Sonraki frame (Sağ ok)"
        >
          &#x23F5;&#xFE0E;
        </button>
        {onNextSeries && seriesCount != null && seriesCount > 1 && (
          <button
            className="cine-btn cine-series"
            onClick={() => { onNextSeries(); setIsPlaying(true); }}
            disabled={seriesIndex === seriesCount - 1}
            title="Sonraki seri (PageDown) — otomatik oynatır"
          >
            &#x23ED;
          </button>
        )}

        <span className="cine-frame-label">
          {currentIndex + 1} / {imageCount}
        </span>

        <div className="cine-fps-group">
          {[7.5, 15, 30].map((preset) => (
            <button
              key={preset}
              className={`cine-fps-preset ${fps === preset ? 'active' : ''}`}
              onClick={() => setFps(preset)}
              title={`${preset} FPS`}
            >
              {preset}
            </button>
          ))}
          <input
            type="number"
            min="1"
            max="60"
            step="0.5"
            value={fps}
            onChange={(e) => setFps(Math.max(1, Math.min(60, Number(e.target.value) || 15)))}
            className="cine-fps-input"
          />
        </div>

        <button
          className={`cine-btn cine-loop ${loop ? 'active' : ''}`}
          onClick={() => setLoop(!loop)}
          title="Döngü aç/kapa"
        >
          &#x1F501;
        </button>

        {seriesCount != null && seriesCount > 1 && (
          <span className="cine-series-label">
            Seri {(seriesIndex ?? 0) + 1}/{seriesCount}
          </span>
        )}

        <span className="toolbar-separator" />

        <button
          className="cine-btn"
          onClick={savePNG}
          disabled={!!exporting}
          title="Frame resim olarak indir (PNG)"
          aria-label="Save frame PNG"
        >
          📷
        </button>
        <button
          className="cine-btn"
          onClick={saveVideo}
          disabled={!!exporting || imageCount < 2}
          title="Seriyi video olarak indir (WebM)"
          aria-label="Save series video"
        >
          {exporting?.startsWith('Recording') ? '⏺' : '🎞'}
        </button>
        <button
          className="cine-btn"
          onClick={saveDicom}
          disabled={!!exporting}
          title="Seriyi DICOM olarak indir"
          aria-label="Save series DICOM"
        >
          💾
        </button>
        {exporting && <span className="cine-export-status">{exporting}</span>}
      </div>

      {!singleFrame && (
        <input
          type="range"
          className="cine-slider"
          min="0"
          max={imageCount - 1}
          value={currentIndex}
          onChange={(e) => {
            setIsPlaying(false);
            goToFrame(Number(e.target.value));
          }}
        />
      )}
    </div>
  );
}
