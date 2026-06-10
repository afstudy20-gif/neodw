import * as cornerstone from '@cornerstonejs/core';
import dicomImageLoader from '@cornerstonejs/dicom-image-loader';
import { parseFileHeader } from '../../../shared/dicom/parseHeaders';
import { wrapWithPart10Header, isNonImageSopClass } from '../../../shared/dicom/loaderCore';

// wrapWithPart10Header moved to shared/dicom/loaderCore.ts.
// Re-exported for the CtApp facade — keeps the modality's public surface stable.
export { isSecondaryCaptureSopClass } from '../../../shared/dicom/loaderCore';

export interface DicomSeriesInfo {
  seriesInstanceUID: string;
  seriesDescription: string;
  modality: string;
  numImages: number;
  imageIds: string[];
  patientName: string;
  studyDescription: string;
  studyDate: string;
  sopClassUID?: string;
}

interface ParsedFile {
  imageId: string;
  metadata: Record<string, string>;
}

// parseMetadata replaced by shared worker-pool helper.
// isNonImageSopClass + the SOP denylist moved to shared/dicom/loaderCore.ts.

// Load files and group by series, sorted by most images first
export async function loadDicomFiles(files: File[]): Promise<DicomSeriesInfo[]> {
  const seriesMap = new Map<string, ParsedFile[]>();

  let parseFailCount = 0;
  let filteredNonImage = 0;
  const ioConcurrency = Math.max(4, Math.min(32, navigator.hardwareConcurrency || 8));
  
  type Outcome = {
    seriesUID: string;
    entries: ParsedFile[];
  } | null;
  const outcomes: Outcome[] = new Array(files.length).fill(null);

  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= files.length) return;
      const file = files[index];
      try {
        const { metadata, hasPart10Header } = await parseFileHeader(file);

        let fileToLoad: File = file;
        if (!hasPart10Header) {
          const fullBytes = new Uint8Array(await file.arrayBuffer());
          const wrapped = wrapWithPart10Header(fullBytes);
          fileToLoad = new File([wrapped.buffer as ArrayBuffer], file.name, { type: 'application/dicom' });
        }
        const baseImageId = dicomImageLoader.wadouri.fileManager.add(fileToLoad);
        
        const numFrames = Math.max(1, parseInt(metadata.numberOfFrames, 10) || 1);
        const isMultiFrame = numFrames > 1;
        
        const seriesUID = isMultiFrame 
          ? `mf_${metadata.sopInstanceUID || file.name}`
          : (metadata.seriesInstanceUID || 'unknown');

        const entries: ParsedFile[] = [];
        if (isMultiFrame) {
          for (let frame = 1; frame <= numFrames; frame++) {
            entries.push({
              imageId: `${baseImageId}&frame=${frame}`,
              metadata: { ...metadata, instanceNumber: String(frame) },
            });
          }
        } else {
          entries.push({ imageId: baseImageId, metadata });
        }
        
        outcomes[index] = { seriesUID, entries };
      } catch (e) {
        parseFailCount++;
        if (parseFailCount <= 3) {
          console.warn(`[DICOM] Failed to parse ${file.name} (${file.size} bytes):`, e);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(ioConcurrency, files.length) }, worker));

  for (const outcome of outcomes) {
    if (!outcome) continue;
    if (!seriesMap.has(outcome.seriesUID)) {
      seriesMap.set(outcome.seriesUID, []);
    }
    const bucket = seriesMap.get(outcome.seriesUID)!;
    for (const entry of outcome.entries) {
      bucket.push(entry);
    }
  }

  const seriesList: DicomSeriesInfo[] = [];

  for (const [uid, filesList] of seriesMap) {
    // Multi-phase / step-and-shoot / multi-kernel dedup pipeline ported from
    // coronary-ct loader. Mixed-phase slices at overlapping Z produce striping
    // in MPR when cornerstone extrudes the volume with non-uniform spacing —
    // we split by acquisition identity, then by InstanceNumber-ordered
    // Z-direction runs, then keep the longest pass that has ≥90% uniform
    // slice spacing.

    // Trust SeriesInstanceUID as primary grouping (matches Horos/OsiriX).
    // Only sub-UID splitter: uniform z-bucket detection for 4D cardiac
    // interleave. acqKey-based splitting caused single UIDs to emit 12
    // separate series — too aggressive — so we drop it entirely.

    // Splitting disabled per Horos-parity request. Every SeriesInstanceUID
    // returns as a single pass. Z-bucket 4D-interleave splitting +
    // direction-reversal splitting + acqKey splitting all removed. If a
    // study has 4 cardiac phases stored under one UID, they ship as one
    // (long) series — same as Horos/OsiriX default behavior. SC and other
    // single-frame derived images stay intact because nothing now slices
    // a UID into smaller groups.
    function splitGroup(group: typeof filesList): typeof filesList[] {
      if (!group || group.length === 0) return [];
      return [group];
    }

    const passes: typeof filesList[] = splitGroup(filesList);

    for (const pass of passes) {
      if (pass.length >= 2) {
        const first = getSlicePosition(pass[0].metadata);
        const last = getSlicePosition(pass[pass.length - 1].metadata);
        if (last < first) pass.reverse();
      }
    }

    filesList.sort((a, b) => getSlicePosition(a.metadata) - getSlicePosition(b.metadata));

    function measureUniformity(pass: typeof filesList): { score: number; spacing: number } {
      const n = pass.length;
      if (n < 3) return { score: 0, spacing: 0 };
      const positions = new Float64Array(n);
      for (let i = 0; i < n; i += 1) positions[i] = getSlicePosition(pass[i].metadata);
      const diffCount = n - 1;
      const diffs = new Float64Array(diffCount);
      const bins = new Map<number, number>();
      let bestKey = 0;
      let bestCount = 0;
      for (let i = 0; i < diffCount; i += 1) {
        const d = positions[i + 1] - positions[i];
        diffs[i] = d;
        const key = Math.round(d * 1000);
        const nextC = (bins.get(key) ?? 0) + 1;
        bins.set(key, nextC);
        if (nextC > bestCount) { bestCount = nextC; bestKey = key; }
      }
      const spacing = bestKey / 1000;
      if (spacing === 0) return { score: 0, spacing: 0 };
      const tol = Math.abs(spacing) * 0.1;
      let matches = 0;
      for (let i = 0; i < diffCount; i += 1) if (Math.abs(diffs[i] - spacing) <= tol) matches += 1;
      return { score: matches / diffCount, spacing };
    }

    // Emit one series per acquisition pass (phase, kernel, orientation) so the
    // UI matches what Horos/OsiriX show. Each pass is a geometrically coherent
    // slab; vendors stuff multiple per SeriesInstanceUID.
    const measured = passes.map((pass) => ({ pass, ...measureUniformity(pass) }));

    const preferred = measured
      .filter((entry) => entry.pass.length >= 10 && entry.score >= 0.9)
      .sort((a, b) => b.pass.length - a.pass.length);
    const auxiliary = measured
      .filter((entry) => !(entry.pass.length >= 10 && entry.score >= 0.9))
      .sort((a, b) => b.pass.length - a.pass.length);
    const emitted = [...preferred, ...auxiliary];

    console.log(
      `[DICOM] UID ${uid.slice(-12)}: ${passes.length} passes → ${emitted.length} emitted`
    );

    for (let idx = 0; idx < emitted.length; idx += 1) {
      const entry = emitted[idx];
      if (entry.pass.length < 1) continue;
      const first = entry.pass[0]?.metadata ?? {};
      if (isNonImageSopClass(first.sopClassUID || '')) {
        filteredNonImage += 1;
        continue;
      }
      const kernel = first.convolutionKernel ? ` ${first.convolutionKernel}` : '';
      const thickness = first.sliceThickness ? ` ${first.sliceThickness}mm` : '';
      const phaseTag = first.nominalPercentageOfCardiacPhase
        ? ` ${first.nominalPercentageOfCardiacPhase}%`
        : first.triggerTime
          ? ` ${first.triggerTime}ms`
          : first.acquisitionTime
            ? ` @ ${first.acquisitionTime}`
            : '';
      const phaseLabel = emitted.length > 1
        ? ` · ${idx + 1}/${emitted.length}${kernel}${thickness}${phaseTag}`
        : `${kernel}${thickness}`;

      seriesList.push({
        seriesInstanceUID: emitted.length > 1 ? `${uid}__pass${idx}` : uid,
        seriesDescription: `${first.seriesDescription || 'Unknown Series'}${phaseLabel}`.trim(),
        modality: first.modality || 'Unknown',
        numImages: entry.pass.length,
        imageIds: entry.pass.map((f) => f.imageId),
        patientName: first.patientName || 'Unknown',
        studyDescription: first.studyDescription || 'Unknown Study',
        studyDate: first.studyDate || '',
        sopClassUID: first.sopClassUID || '',
      });
    }
  }

  seriesList.sort((a, b) => b.numImages - a.numImages);

  console.log(`[DICOM] Loaded ${files.length} files: ${files.length - parseFailCount} parsed, ${parseFailCount} failed, ${seriesList.length} series, filtered ${filteredNonImage} non-image`);

  return seriesList;
}

function getSlicePosition(metadata: Record<string, string>): number {
  const ipp = metadata.imagePositionPatient;
  if (ipp) {
    const parts = ipp.split('\\');
    if (parts.length >= 3) {
      const z = parseFloat(parts[2]);
      if (!isNaN(z)) return z;
    }
  }
  if (metadata.sliceLocation) {
    const sl = parseFloat(metadata.sliceLocation);
    if (!isNaN(sl)) return sl;
  }
  if (metadata.instanceNumber) {
    const inst = parseFloat(metadata.instanceNumber);
    if (!isNaN(inst)) return inst;
  }
  return 0;
}

// Load images in parallel with concurrency limit to populate metadata cache
async function preloadAllImages(
  imageIds: string[],
  concurrency = Math.max(8, Math.min(32, (navigator.hardwareConcurrency || 8) * 2)),
  onProgress?: (loaded: number, total: number) => void
): Promise<void> {
  // Deduplicate base imageIds for multi-frame so we only download the file once
  const uniqueBaseIds = new Set<string>();
  const idsToLoad: string[] = [];
  for (const id of imageIds) {
    const ampIdx = id.indexOf('&frame=');
    const base = ampIdx >= 0 ? id.slice(0, ampIdx) : id;
    if (!uniqueBaseIds.has(base)) {
      uniqueBaseIds.add(base);
      idsToLoad.push(id);
    }
  }

  let loaded = 0;
  const total = idsToLoad.length;

  const pool = async (ids: string[]) => {
    for (const imageId of ids) {
      try {
        await cornerstone.imageLoader.loadAndCacheImage(imageId);
      } catch {
        // Skip failed images
      }
      loaded++;
      onProgress?.(loaded, total);
    }
  };

  // Split into chunks for concurrent loading
  const chunkSize = Math.max(1, Math.ceil(idsToLoad.length / concurrency));
  const chunks: string[][] = [];
  for (let i = 0; i < idsToLoad.length; i += chunkSize) {
    chunks.push(idsToLoad.slice(i, i + chunkSize));
  }

  await Promise.all(chunks.map(pool));
}

// Create a volume from a series of DICOM images
export async function createVolume(
  volumeId: string,
  imageIds: string[],
  onProgress?: (loaded: number, total: number) => void
): Promise<cornerstone.Types.IImageVolume> {
  console.log('[DICOM] Pre-loading all images for metadata...', imageIds.length, 'images');

  await preloadAllImages(imageIds, 16, (loaded, total) => {
    if (loaded % 50 === 0 || loaded === total) {
      console.log(`[DICOM] Pre-loaded ${loaded}/${total} images`);
    }
    onProgress?.(loaded, total);
  });

  console.log('[DICOM] All images pre-loaded. Creating volume...');
  const volume = await cornerstone.volumeLoader.createAndCacheVolume(volumeId, {
    imageIds,
  });
  console.log('[DICOM] Volume created. Starting background load...');

  if ('load' in volume && typeof volume.load === 'function') {
    (volume as cornerstone.Types.IStreamingImageVolume).load();
  }

  return volume;
}
