import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import {
  pseudoVNCa,
  pseudoLowKevVMI,
  calciumBloomReduction,
  huToImageData,
  type SliceView,
} from '../../../shared/dicom/pseudoPCCT';

/**
 * Pseudo-PCCT post-processing panel.
 *
 * Reads the active axial slice from a Cornerstone3D volume and renders
 * three "PCCT-like" visualisations alongside the original. All output is
 * a heuristic approximation; see banner copy.
 */

interface Props {
  renderingEngineId: string;
  volumeId: string;
  axialViewportId: string;
  onClose: () => void;
}

interface VNCaParams { thresholdHU: number; dilation: number; medianRadius: number; }
interface VMIParams { boost: number; center: number; bandwidth: number; }
interface BloomParams { thresholdHU: number; amount: number; radius: number; }

const DEFAULT_VNCA: VNCaParams = { thresholdHU: 300, dilation: 1, medianRadius: 1 };
const DEFAULT_VMI: VMIParams = { boost: 0.6, center: 120, bandwidth: 200 };
const DEFAULT_BLOOM: BloomParams = { thresholdHU: 300, amount: 0.8, radius: 2 };

function extractAxialSlice(volumeId: string, sliceIndex: number): SliceView | null {
  const volume: any = cornerstone.cache.getVolume(volumeId);
  if (!volume?.dimensions) return null;
  const [dx, dy, dz] = volume.dimensions as [number, number, number];
  if (sliceIndex < 0 || sliceIndex >= dz) return null;

  let scalar: ArrayLike<number> | null = volume.scalarData ?? null;
  if (!scalar && typeof volume.getScalarData === 'function') {
    try { scalar = volume.getScalarData(); } catch { /* ignore */ }
  }
  // Voxel-manager fallback (some Cornerstone3D builds use this lazy view).
  const vm = volume.voxelManager;
  if (!scalar && vm?.getCompleteScalarDataArray) {
    try { scalar = vm.getCompleteScalarDataArray(); } catch { /* ignore */ }
  }
  if (!scalar) return null;

  const sliceSize = dx * dy;
  const offset = sliceIndex * sliceSize;
  const out = new Int16Array(sliceSize);
  for (let i = 0; i < sliceSize; i += 1) {
    out[i] = scalar[offset + i];
  }
  return { data: out, width: dx, height: dy };
}

function getAxialSliceIndex(renderingEngineId: string, viewportId: string): number {
  try {
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    const vp: any = engine?.getViewport(viewportId);
    if (vp?.getCurrentImageIdIndex) return vp.getCurrentImageIdIndex();
    if (vp?.getSliceIndex) return vp.getSliceIndex();
  } catch { /* ignore */ }
  return 0;
}

function getViewportWindowLevel(
  renderingEngineId: string,
  viewportId: string,
): { center: number; width: number } {
  try {
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    const vp: any = engine?.getViewport(viewportId);
    const props = vp?.getProperties?.();
    const voiRange = props?.voiRange;
    if (voiRange && Number.isFinite(voiRange.lower) && Number.isFinite(voiRange.upper)) {
      const width = voiRange.upper - voiRange.lower;
      const center = (voiRange.upper + voiRange.lower) / 2;
      return { center, width };
    }
  } catch { /* ignore */ }
  // Mediastinal default
  return { center: 40, width: 400 };
}

export function PseudoPCCTPanel({ renderingEngineId, volumeId, axialViewportId, onClose }: Props) {
  const [sliceIndex, setSliceIndex] = useState(() =>
    getAxialSliceIndex(renderingEngineId, axialViewportId)
  );
  const wl0 = useMemo(
    () => getViewportWindowLevel(renderingEngineId, axialViewportId),
    [renderingEngineId, axialViewportId]
  );
  const [windowCenter, setWindowCenter] = useState(wl0.center);
  const [windowWidth, setWindowWidth] = useState(wl0.width);

  const [vnca, setVnca] = useState<VNCaParams>(DEFAULT_VNCA);
  const [vmi, setVmi] = useState<VMIParams>(DEFAULT_VMI);
  const [bloom, setBloom] = useState<BloomParams>(DEFAULT_BLOOM);

  const originalRef = useRef<HTMLCanvasElement | null>(null);
  const vncaRef = useRef<HTMLCanvasElement | null>(null);
  const vmiRef = useRef<HTMLCanvasElement | null>(null);
  const bloomRef = useRef<HTMLCanvasElement | null>(null);

  const [slice, setSlice] = useState<SliceView | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Pull slice whenever the index changes.
  useEffect(() => {
    const s = extractAxialSlice(volumeId, sliceIndex);
    if (!s) {
      setError('Aktif hacim okunamadı (volume cache boş veya scalar data yok).');
      setSlice(null);
      return;
    }
    setError(null);
    setSlice(s);
  }, [volumeId, sliceIndex]);

  const draw = useCallback(
    (canvas: HTMLCanvasElement | null, data: Int16Array, width: number, height: number) => {
      if (!canvas) return;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const img = huToImageData({ data, width, height }, windowCenter, windowWidth);
      ctx.putImageData(img, 0, 0);
    },
    [windowCenter, windowWidth]
  );

  // Re-render each filter when slice or its params change.
  useEffect(() => {
    if (!slice) return;
    draw(originalRef.current, slice.data, slice.width, slice.height);
  }, [slice, draw]);

  useEffect(() => {
    if (!slice) return;
    const out = pseudoVNCa(slice, vnca);
    draw(vncaRef.current, out, slice.width, slice.height);
  }, [slice, vnca, draw]);

  useEffect(() => {
    if (!slice) return;
    const out = pseudoLowKevVMI(slice, vmi);
    draw(vmiRef.current, out, slice.width, slice.height);
  }, [slice, vmi, draw]);

  useEffect(() => {
    if (!slice) return;
    const out = calciumBloomReduction(slice, bloom);
    draw(bloomRef.current, out, slice.width, slice.height);
  }, [slice, bloom, draw]);

  // Listen for slice changes from the user scrolling the axial viewport.
  useEffect(() => {
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    const vp: any = engine?.getViewport(axialViewportId);
    const el: HTMLElement | undefined = vp?.element;
    if (!el) return;
    const evt = (cornerstone as any).Enums?.Events?.IMAGE_RENDERED ?? 'IMAGE_RENDERED';
    const handler = () => {
      setSliceIndex(getAxialSliceIndex(renderingEngineId, axialViewportId));
    };
    el.addEventListener(evt, handler);
    return () => el.removeEventListener(evt, handler);
  }, [renderingEngineId, axialViewportId]);

  const dz = useMemo(() => {
    const volume: any = cornerstone.cache.getVolume(volumeId);
    return Number(volume?.dimensions?.[2] ?? 0);
  }, [volumeId]);

  return (
    <div className="pcct-overlay" onClick={onClose}>
      <div className="pcct-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pcct-banner">
          <strong>⚠ Pseudo-PCCT</strong> — Bu görüntüler, tek-enerji CT verisinden HU-eşikli
          sezgisel filtrelerle üretilmiştir. Gerçek PCCT spektral verisi <em>değildir</em>.
          Klinik karar için <strong>kullanılamaz</strong>; eğitim/görselleştirme amaçlıdır.
        </div>

        <div className="pcct-header">
          <h3>Pseudo-PCCT</h3>
          <div className="pcct-header-actions">
            <button onClick={onClose} className="pcct-close">Kapat</button>
          </div>
        </div>

        {error && <div className="pcct-error">{error}</div>}

        <div className="pcct-controls">
          <label>
            Slice: {sliceIndex + 1} / {dz}
            <input
              type="range"
              min={0}
              max={Math.max(0, dz - 1)}
              value={sliceIndex}
              onChange={(e) => setSliceIndex(Number(e.target.value))}
            />
          </label>
          <label>
            W: {windowWidth.toFixed(0)}
            <input
              type="range" min={50} max={2000} step={10}
              value={windowWidth}
              onChange={(e) => setWindowWidth(Number(e.target.value))}
            />
          </label>
          <label>
            L: {windowCenter.toFixed(0)}
            <input
              type="range" min={-200} max={500} step={5}
              value={windowCenter}
              onChange={(e) => setWindowCenter(Number(e.target.value))}
            />
          </label>
        </div>

        <div className="pcct-grid">
          <PcctTile title="Original (single-energy CT)" canvasRef={originalRef} />
          <PcctTile
            title="Pseudo-VNCa (kalsiyum bastırma)"
            canvasRef={vncaRef}
            sliders={
              <>
                <PcctSlider
                  label={`Eşik HU: ${vnca.thresholdHU}`}
                  min={150} max={800} step={10} value={vnca.thresholdHU}
                  onChange={(v) => setVnca((s) => ({ ...s, thresholdHU: v }))}
                />
                <PcctSlider
                  label={`Halo dilation: ${vnca.dilation}px`}
                  min={0} max={4} step={1} value={vnca.dilation}
                  onChange={(v) => setVnca((s) => ({ ...s, dilation: v }))}
                />
                <PcctSlider
                  label={`Median yarıçap: ${vnca.medianRadius}px`}
                  min={1} max={3} step={1} value={vnca.medianRadius}
                  onChange={(v) => setVnca((s) => ({ ...s, medianRadius: v }))}
                />
              </>
            }
          />
          <PcctTile
            title="Pseudo low-keV VMI (iyot boost)"
            canvasRef={vmiRef}
            sliders={
              <>
                <PcctSlider
                  label={`Boost: ${vmi.boost.toFixed(2)}`}
                  min={0} max={1} step={0.05} value={vmi.boost}
                  onChange={(v) => setVmi((s) => ({ ...s, boost: v }))}
                />
                <PcctSlider
                  label={`Center HU: ${vmi.center}`}
                  min={50} max={250} step={5} value={vmi.center}
                  onChange={(v) => setVmi((s) => ({ ...s, center: v }))}
                />
                <PcctSlider
                  label={`Bandwidth: ${vmi.bandwidth}`}
                  min={50} max={400} step={10} value={vmi.bandwidth}
                  onChange={(v) => setVmi((s) => ({ ...s, bandwidth: v }))}
                />
              </>
            }
          />
          <PcctTile
            title="Calcium-Bloom Reduction"
            canvasRef={bloomRef}
            sliders={
              <>
                <PcctSlider
                  label={`Eşik HU: ${bloom.thresholdHU}`}
                  min={150} max={800} step={10} value={bloom.thresholdHU}
                  onChange={(v) => setBloom((s) => ({ ...s, thresholdHU: v }))}
                />
                <PcctSlider
                  label={`Amount: ${bloom.amount.toFixed(2)}`}
                  min={0} max={1.5} step={0.05} value={bloom.amount}
                  onChange={(v) => setBloom((s) => ({ ...s, amount: v }))}
                />
                <PcctSlider
                  label={`Blur radius: ${bloom.radius}px`}
                  min={1} max={5} step={1} value={bloom.radius}
                  onChange={(v) => setBloom((s) => ({ ...s, radius: v }))}
                />
              </>
            }
          />
        </div>
      </div>
    </div>
  );
}

interface TileProps {
  title: string;
  canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  sliders?: React.ReactNode;
}
function PcctTile({ title, canvasRef, sliders }: TileProps) {
  return (
    <div className="pcct-tile">
      <div className="pcct-tile-title">{title}</div>
      <canvas ref={canvasRef} className="pcct-canvas" />
      {sliders && <div className="pcct-sliders">{sliders}</div>}
    </div>
  );
}

interface SliderProps {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}
function PcctSlider({ label, min, max, step, value, onChange }: SliderProps) {
  return (
    <label className="pcct-slider">
      <span>{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
