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
  const rafRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const frameIndexRef = useRef(currentIndex);

  useEffect(() => {
    frameIndexRef.current = currentIndex;
  }, [currentIndex]);

  // When a new series loads (imageCount changes), restart cine from frame 0
  // if we were already playing so "Next Series" / "Prev Series" auto-advance smoothly.
  useEffect(() => {
    frameIndexRef.current = 0;
  }, [imageCount]);

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

  if (imageCount <= 1) return null;

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
          title="Önceki frame (Sol ok)"
        >
          &#x23F4;
        </button>
        <button
          className={`cine-btn cine-play ${isPlaying ? 'active' : ''}`}
          onClick={() => setIsPlaying(!isPlaying)}
          title={isPlaying ? 'Duraklat (Space)' : 'Başlat (Space)'}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>
        <button
          className="cine-btn"
          onClick={() => { setIsPlaying(false); goToFrame(currentIndex + 1); }}
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
      </div>

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
    </div>
  );
}
