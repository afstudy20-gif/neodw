import { useCallback, useEffect, useState } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import { probeGpu, recommendedBackend, type GpuCapabilities } from './webgpu';
import { heuristicCoronarySeg, type HeuristicSegResult } from './heuristicSeg';
import { downloadSeg } from '../../../shared/dicom/dicomSeg';
import { computeVolumeStats, statsToCsv, downloadCsv } from '../../../shared/dicom/volumeStats';
import { buildPdfReport, downloadPdf } from '../../../shared/dicom/pdfReport';
import { downloadEncapsulatedPdf } from '../../../shared/dicom/encapsulatedPdf';

interface Props {
  renderingEngineId: string;
  volumeId: string;
  axialViewportId: string;
  onClose: () => void;
}

interface SeedState {
  ijk: [number, number, number] | null;
  hu?: number;
}

export function CoronarySegPanel({ renderingEngineId, volumeId, axialViewportId, onClose }: Props) {
  const [caps, setCaps] = useState<GpuCapabilities | null>(null);
  const [seed, setSeed] = useState<SeedState>({ ijk: null });
  const [picking, setPicking] = useState(false);
  const [huMin, setHuMin] = useState(180);
  const [huMax, setHuMax] = useState(600);
  const [result, setResult] = useState<HeuristicSegResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void probeGpu().then(setCaps);
  }, []);

  // Pick seed via axial-viewport click → world → ijk
  useEffect(() => {
    if (!picking) return;
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    const vp = engine?.getViewport(axialViewportId) as cornerstone.Types.IVolumeViewport | undefined;
    if (!vp) return;
    const element = vp.element;

    const handler = (evt: MouseEvent) => {
      const rect = element.getBoundingClientRect();
      const canvasPt: [number, number] = [evt.clientX - rect.left, evt.clientY - rect.top];
      try {
        const world = vp.canvasToWorld(canvasPt);
        const volume = cornerstone.cache.getVolume(volumeId) as unknown as {
          imageData: { worldToIndex: (w: number[]) => number[] };
        } | undefined;
        if (!volume) return;
        const idx = volume.imageData.worldToIndex([world[0], world[1], world[2]]);
        const ijk: [number, number, number] = [
          Math.round(idx[0]),
          Math.round(idx[1]),
          Math.round(idx[2]),
        ];
        const v = cornerstone.cache.getVolume(volumeId) as unknown as {
          voxelManager?: { getAtIJK?: (x: number, y: number, z: number) => number };
        } | undefined;
        const hu = v?.voxelManager?.getAtIJK?.(ijk[0], ijk[1], ijk[2]);
        setSeed({ ijk, hu });
        setPicking(false);
      } catch (e) {
        console.warn('[CoronarySeg] seed pick failed', e);
        setPicking(false);
      }
    };

    element.addEventListener('click', handler, { capture: true });
    return () => {
      element.removeEventListener('click', handler, { capture: true } as EventListenerOptions);
    };
  }, [picking, renderingEngineId, axialViewportId, volumeId]);

  const runHeuristic = useCallback(() => {
    setError(null);
    setResult(null);
    if (!seed.ijk) {
      setError('Önce damar lümeninden bir seed noktası seçin.');
      return;
    }
    const volume = cornerstone.cache.getVolume(volumeId) as unknown as {
      voxelManager?: { getCompleteScalarDataArray: () => Float32Array | Int16Array | Uint16Array };
      imageData?: { getDimensions: () => number[]; getSpacing: () => number[] };
    } | undefined;
    if (!volume || !volume.voxelManager || !volume.imageData) {
      setError('Volume not available');
      return;
    }
    const scalarData = volume.voxelManager.getCompleteScalarDataArray();
    const dims = volume.imageData.getDimensions() as [number, number, number];
    const spacing = volume.imageData.getSpacing() as [number, number, number];
    setRunning(true);
    setTimeout(() => {
      try {
        const r = heuristicCoronarySeg({
          scalarData,
          dims,
          spacing,
          huMin,
          huMax,
          seed: seed.ijk!,
        });
        setResult(r);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Inference failed');
      } finally {
        setRunning(false);
      }
    }, 0);
  }, [seed.ijk, huMin, huMax, volumeId]);

  const exportSeg = useCallback(() => {
    if (!result) return;
    const volume = cornerstone.cache.getVolume(volumeId) as unknown as {
      imageData?: { getDimensions: () => number[]; getSpacing: () => number[]; getOrigin: () => number[]; getDirection: () => number[] };
      imageIds?: string[];
    } | undefined;
    if (!volume?.imageData) return;
    const dims = volume.imageData.getDimensions() as [number, number, number];
    const spacing = volume.imageData.getSpacing() as [number, number, number];
    const origin = volume.imageData.getOrigin() as [number, number, number];
    const direction = volume.imageData.getDirection();
    const imageIds = volume.imageIds ?? [];

    // Extract SOP Instance UIDs from imageIds (wadouri:... format)
    const sopInstanceUids = imageIds.map((id) => {
      const meta = cornerstone.metaData.get('instance', id) as { SOPInstanceUID?: string } | undefined;
      return meta?.SOPInstanceUID ?? '';
    }).filter(Boolean);
    const firstMeta = imageIds[0]
      ? cornerstone.metaData.get('instance', imageIds[0]) as {
          StudyInstanceUID?: string;
          SeriesInstanceUID?: string;
          SOPClassUID?: string;
          PatientName?: string;
          PatientID?: string;
          PatientBirthDate?: string;
          PatientSex?: string;
        } | undefined
      : undefined;

    try {
      downloadSeg({
        mask: result.mask,
        rows: dims[1],
        columns: dims[0],
        slices: dims[2],
        pixelSpacing: [spacing[1], spacing[0]],
        sliceThickness: spacing[2],
        imagePositionPatient: origin,
        imageOrientationPatient: [direction[0], direction[1], direction[2], direction[3], direction[4], direction[5]],
        source: {
          studyInstanceUid: firstMeta?.StudyInstanceUID ?? '',
          seriesInstanceUid: firstMeta?.SeriesInstanceUID ?? '',
          sopInstanceUids,
          sopClassUid: firstMeta?.SOPClassUID ?? '1.2.840.10008.5.1.4.1.1.2',
          patientName: firstMeta?.PatientName,
          patientId: firstMeta?.PatientID,
          patientBirthDate: firstMeta?.PatientBirthDate,
          patientSex: firstMeta?.PatientSex,
        },
        label: 'Coronary lumen (heuristic)',
        algorithmName: 'NeoDW heuristic HU flood fill',
        segmentColor: [255, 60, 60],
      }, `coronary-seg-${Date.now()}.dcm`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'SEG export failed');
    }
  }, [result, volumeId]);

  const exportCsv = useCallback(() => {
    if (!result) return;
    const volume = cornerstone.cache.getVolume(volumeId) as unknown as {
      voxelManager?: { getCompleteScalarDataArray: () => Float32Array | Int16Array | Uint16Array };
      imageData?: { getDimensions: () => number[]; getSpacing: () => number[] };
    } | undefined;
    if (!volume?.imageData) return;
    const stats = computeVolumeStats({
      mask: result.mask,
      scalarData: volume.voxelManager?.getCompleteScalarDataArray(),
      dims: volume.imageData.getDimensions() as [number, number, number],
      spacing: volume.imageData.getSpacing() as [number, number, number],
    });
    const csv = statsToCsv([{
      label: 'Coronary lumen (heuristic)',
      stats,
      extra: { hu_min_threshold: huMin, hu_max_threshold: huMax, seed_i: seed.ijk?.[0] ?? '', seed_j: seed.ijk?.[1] ?? '', seed_k: seed.ijk?.[2] ?? '' },
    }]);
    downloadCsv(csv, `coronary-seg-stats-${Date.now()}.csv`);
  }, [result, volumeId, huMin, huMax, seed.ijk]);

  const exportPdf = useCallback(async (encapsulate: boolean) => {
    if (!result) return;
    const volume = cornerstone.cache.getVolume(volumeId) as unknown as {
      voxelManager?: { getCompleteScalarDataArray: () => Float32Array | Int16Array | Uint16Array };
      imageData?: { getDimensions: () => number[]; getSpacing: () => number[] };
      imageIds?: string[];
    } | undefined;
    if (!volume?.imageData) return;
    const stats = computeVolumeStats({
      mask: result.mask,
      scalarData: volume.voxelManager?.getCompleteScalarDataArray(),
      dims: volume.imageData.getDimensions() as [number, number, number],
      spacing: volume.imageData.getSpacing() as [number, number, number],
    });
    const firstMeta = volume.imageIds?.[0]
      ? cornerstone.metaData.get('instance', volume.imageIds[0]) as {
          StudyInstanceUID?: string;
          StudyDescription?: string;
          PatientName?: string;
          PatientID?: string;
          PatientBirthDate?: string;
          PatientSex?: string;
        } | undefined
      : undefined;
    const pdf = await buildPdfReport({
      title: 'Coronary Segmentation Report',
      patientName: firstMeta?.PatientName,
      patientId: firstMeta?.PatientID,
      studyDescription: firstMeta?.StudyDescription,
      modality: 'CT',
      sections: [
        {
          title: 'Heuristic parameters',
          rows: [
            { label: 'HU window', value: `[${huMin}, ${huMax}]` },
            { label: 'Seed ijk', value: seed.ijk ? `(${seed.ijk.join(', ')})` : '—' },
            { label: 'Seed HU', value: seed.hu?.toFixed(0) ?? '—' },
          ],
        },
        {
          title: 'Segmentation result',
          rows: [
            { label: 'Voxel count', value: stats.voxelCount.toLocaleString() },
            { label: 'Volume', value: stats.volumeMl.toFixed(2), unit: 'ml' },
            { label: 'Mean HU', value: Number.isFinite(stats.meanHu) ? stats.meanHu.toFixed(1) : '—' },
            { label: 'Std HU', value: Number.isFinite(stats.stdHu) ? stats.stdHu.toFixed(1) : '—' },
            { label: 'Min / Max HU', value: `${stats.minHu.toFixed(0)} / ${stats.maxHu.toFixed(0)}` },
            { label: 'Bounding box size', value: `${stats.bboxSizeMm[0].toFixed(1)} × ${stats.bboxSizeMm[1].toFixed(1)} × ${stats.bboxSizeMm[2].toFixed(1)}`, unit: 'mm' },
            { label: 'Truncated', value: result.truncated ? 'YES (voxel cap)' : 'no' },
          ],
        },
      ],
      footnote: 'Heuristic flood-fill segmentation — placeholder until neural model integration. Research use only.',
    });
    if (encapsulate) {
      downloadEncapsulatedPdf({
        pdfBytes: pdf,
        studyInstanceUid: firstMeta?.StudyInstanceUID,
        patientName: firstMeta?.PatientName,
        patientId: firstMeta?.PatientID,
        patientBirthDate: firstMeta?.PatientBirthDate,
        patientSex: firstMeta?.PatientSex,
        documentTitle: 'Coronary Segmentation Report',
      }, `coronary-seg-report-${Date.now()}.dcm`);
    } else {
      downloadPdf(pdf, `coronary-seg-report-${Date.now()}.pdf`);
    }
  }, [result, volumeId, huMin, huMax, seed]);

  const backend = caps ? recommendedBackend(caps) : null;

  return (
    <div className="coronary-seg-overlay">
      <div className="coronary-seg-modal">
        <header className="coronary-seg-header">
          <div>
            <h2>Coronary Tree Segmentation</h2>
            <p>
              Scaffold: HU-window + 3D flood fill heuristic. Real neural model (TorchScript via ONNX
              Runtime Web) integration deferred.
            </p>
          </div>
          <button className="coronary-seg-close" onClick={onClose} aria-label="Kapat">✕</button>
        </header>

        <div className="coronary-seg-body">
          <section className="coronary-seg-section">
            <h3>Compute backend</h3>
            {!caps ? (
              <p>Probing GPU…</p>
            ) : (
              <ul className="coronary-seg-caps">
                <li>WebGPU: <strong>{caps.hasWebGpu ? 'available' : 'unavailable'}</strong></li>
                <li>WebGL2: <strong>{caps.hasWebGl2 ? 'available' : 'unavailable'}</strong></li>
                {caps.adapterName && <li>Adapter: {caps.adapterName}</li>}
                {caps.adapterVendor && <li>Vendor: {caps.adapterVendor}</li>}
                {caps.reason && <li className="coronary-seg-warn">Reason: {caps.reason}</li>}
                <li>Recommended: <strong>{backend}</strong></li>
              </ul>
            )}
            <p className="coronary-seg-note">
              Neural inference path (ONNX Runtime Web + TotalSegmentator-Cardiac) requires WebGPU and
              a hosted model file. Heuristic fallback below runs on CPU.
            </p>
          </section>

          <section className="coronary-seg-section">
            <h3>Heuristic seed-fill (fallback)</h3>
            <div className="coronary-seg-row">
              <button
                className={`coronary-seg-btn ${picking ? 'active' : ''}`}
                onClick={() => setPicking((p) => !p)}
              >
                {picking ? 'Cancel pick' : 'Pick seed on axial'}
              </button>
              {seed.ijk && (
                <span className="coronary-seg-seed">
                  Seed ijk: ({seed.ijk[0]}, {seed.ijk[1]}, {seed.ijk[2]})
                  {seed.hu !== undefined ? ` · HU ${seed.hu.toFixed(0)}` : ''}
                </span>
              )}
            </div>
            <div className="coronary-seg-row">
              <label>HU min
                <input type="number" value={huMin} onChange={(e) => setHuMin(Number.parseInt(e.target.value, 10) || 0)} />
              </label>
              <label>HU max
                <input type="number" value={huMax} onChange={(e) => setHuMax(Number.parseInt(e.target.value, 10) || 0)} />
              </label>
              <button className="coronary-seg-btn primary" disabled={!seed.ijk || running} onClick={runHeuristic}>
                {running ? 'Running…' : 'Run'}
              </button>
            </div>
            {error && <p className="coronary-seg-warn">{error}</p>}
            {result && (
              <div className="coronary-seg-result">
                <strong>{result.voxelCount.toLocaleString()}</strong> voxels ·{' '}
                <strong>{result.volumeMl.toFixed(2)} ml</strong>
                {result.truncated && <span className="coronary-seg-warn"> (truncated at safety cap)</span>}
                {result.bbox && (
                  <div className="coronary-seg-bbox">
                    bbox ijk: ({result.bbox.min.join(', ')}) → ({result.bbox.max.join(', ')})
                  </div>
                )}
                <div className="coronary-seg-exports">
                  <button className="coronary-seg-btn" onClick={exportSeg} title="DICOM Segmentation (.dcm)">
                    Export DICOM-SEG
                  </button>
                  <button className="coronary-seg-btn" onClick={exportCsv} title="Volume + HU statistics (.csv)">
                    Export CSV
                  </button>
                  <button className="coronary-seg-btn" onClick={() => void exportPdf(false)} title="Report (.pdf)">
                    Export PDF
                  </button>
                  <button className="coronary-seg-btn" onClick={() => void exportPdf(true)} title="Encapsulated PDF DICOM (.dcm)">
                    Export PDF-in-DCM
                  </button>
                </div>
                <p className="coronary-seg-note">
                  Mask not yet rendered to viewport. Next step: bind into cornerstone labelmap
                  segmentation for overlay + 3D visualization.
                </p>
              </div>
            )}
          </section>

          <section className="coronary-seg-section">
            <h3>Roadmap</h3>
            <ol className="coronary-seg-roadmap">
              <li>Bind mask into cornerstone Labelmap segmentation → overlay on MPR + 3D.</li>
              <li>Centerline extraction (3D thinning / Lee algorithm) from mask.</li>
              <li>Diameter sampling along centerline → table (diameter, % stenosis vs. proximal ref).</li>
              <li>ONNX Runtime Web + WebGPU EP for real coronary U-Net (when model published).</li>
            </ol>
          </section>
        </div>
      </div>
    </div>
  );
}
