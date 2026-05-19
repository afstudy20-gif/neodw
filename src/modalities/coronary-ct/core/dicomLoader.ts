import * as cornerstone from '@cornerstonejs/core';
import dicomImageLoader from '@cornerstonejs/dicom-image-loader';
import { parseFileHeader } from '../../../shared/dicom/parseHeaders';

export interface DicomSeriesInfo {
  seriesInstanceUID: string;
  seriesDescription: string;
  modality: string;
  numImages: number;
  imageIds: string[];
  patientName: string;
  studyDescription: string;
  sopClassUID?: string;
}

// Secondary Capture variants (incl. multi-frame true/grayscale/color).
// Cornerstone OrthographicViewport expects a multi-slice MONOCHROME2
// volume; SC is typically 1-frame RGB and must render via stack
// viewport instead.
export function isSecondaryCaptureSopClass(sopClassUID: string | undefined): boolean {
  if (!sopClassUID) return false;
  return (
    sopClassUID === '1.2.840.10008.5.1.4.1.1.7' ||
    sopClassUID.startsWith('1.2.840.10008.5.1.4.1.1.7.')
  );
}

interface ParsedFile {
  imageId: string;
  metadata: Record<string, string>;
}

// hasPart10Header removed — worker now reports it in ParsedHeader.

function wrapWithPart10Header(rawBytes: Uint8Array): Uint8Array {
  const tsUid = '1.2.840.10008.1.2';
  const tsBytes = new TextEncoder().encode(tsUid);
  const tsPadded = tsBytes.length % 2 === 0 ? tsBytes : new Uint8Array([...tsBytes, 0x00]);
  const tsElementLength = 8 + tsPadded.length;
  const groupLengthValue = tsElementLength;

  const metaElements: number[] = [];

  metaElements.push(0x02, 0x00, 0x00, 0x00);
  metaElements.push(0x55, 0x4c);
  metaElements.push(0x04, 0x00);
  metaElements.push(
    groupLengthValue & 0xff,
    (groupLengthValue >> 8) & 0xff,
    (groupLengthValue >> 16) & 0xff,
    (groupLengthValue >> 24) & 0xff
  );

  metaElements.push(0x02, 0x00, 0x10, 0x00);
  metaElements.push(0x55, 0x49);
  metaElements.push(tsPadded.length & 0xff, (tsPadded.length >> 8) & 0xff);
  for (let i = 0; i < tsPadded.length; i += 1) {
    metaElements.push(tsPadded[i]);
  }

  const preamble = new Uint8Array(128);
  const dicm = new Uint8Array([0x44, 0x49, 0x43, 0x4d]);
  const metaHeader = new Uint8Array(metaElements);
  const result = new Uint8Array(128 + 4 + metaHeader.length + rawBytes.length);

  result.set(preamble, 0);
  result.set(dicm, 128);
  result.set(metaHeader, 132);
  result.set(rawBytes, 132 + metaHeader.length);

  return result;
}

// parseMetadata replaced by shared worker-pool helper at
// src/shared/dicom/parseHeaders.ts — see PR notes.

function getSlicePosition(metadata: Record<string, string>): number {
  if (metadata.imagePositionPatient) {
    const parts = metadata.imagePositionPatient.split('\\');
    if (parts.length >= 3) {
      const z = Number.parseFloat(parts[2]);
      if (!Number.isNaN(z)) {
        return z;
      }
    }
  }

  if (metadata.sliceLocation) {
    const sliceLocation = Number.parseFloat(metadata.sliceLocation);
    if (!Number.isNaN(sliceLocation)) {
      return sliceLocation;
    }
  }

  if (metadata.instanceNumber) {
    const instanceNumber = Number.parseFloat(metadata.instanceNumber);
    if (!Number.isNaN(instanceNumber)) {
      return instanceNumber;
    }
  }

  return 0;
}

export function getSeriesPreferenceScore(series: Pick<DicomSeriesInfo, 'seriesDescription' | 'numImages'>): number {
  const desc = (series.seriesDescription || '').toLowerCase();
  let score = series.numImages;

  // Coronary CTA MPR should strongly prefer the diastolic temporal phase
  // instead of derived BONE/LUNG/scout reconstructions.
  const isTemporal = /\btemporal\b|\bphase\b/.test(desc);
  const has75Phase =
    /\b75(?:\.0)?\s*%/.test(desc) ||
    /\b75\s*phase\b/.test(desc) ||
    /\bphase\s*75\b/.test(desc) ||
    /\b75\b/.test(desc);
  const hasMidDiastolicPhase =
    /\b(?:70|75|80)(?:\.0)?\s*%/.test(desc) ||
    /\b(?:70|75|80)\b/.test(desc);

  if (isTemporal && has75Phase) {
    score += 10000;
  } else if (isTemporal && hasMidDiastolicPhase) {
    score += 7000;
  } else if (isTemporal) {
    score += 3500;
  }

  if (/\bangi[oo]\b|\bcta\b|\bcor\b|\bcardiac\b/.test(desc)) {
    score += 1200;
  }

  if (/\bbone\b|\blung\b|\bscout\b|\bsmart score\b|\bsmart prep\b|\bcalcium\b/.test(desc)) {
    score -= 9000;
  }

  if (/\bsegment\b|\bthin\b|\b0\.625\b/.test(desc)) {
    score -= 1200;
  }

  return score;
}

// SOP Classes that are not image objects and should be hidden from the
// series tile list (radiologist-facing). Horos / OsiriX hide these by
// default. The underlying files are still readable; they just don't
// appear as separate user-facing series. Pattern-based match — any
// prefix in this list deny-lists the series.
const NON_IMAGE_SOP_PREFIXES = [
  '1.2.840.10008.5.1.4.1.1.11',   // Presentation State variants
  '1.2.840.10008.5.1.4.1.1.66',   // Segmentation / Surface Segmentation
  '1.2.840.10008.5.1.4.1.1.67',   // Realworld Value Map
  '1.2.840.10008.5.1.4.1.1.78',   // Spectacle Prescription, Macular Grid
  '1.2.840.10008.5.1.4.1.1.88',   // Structured Report variants
  '1.2.840.10008.5.1.4.1.1.9',    // Waveform (covers 9.x — guarded by exact prefix below for image overlap)
  '1.2.840.10008.5.1.4.1.1.104',  // Encapsulated PDF / CDA
  '1.2.840.10008.5.1.4.1.1.481',  // RT Plan / Structure Set / Dose / Image
];

function isNonImageSopClass(sopClassUID: string): boolean {
  if (!sopClassUID) return false;
  for (const prefix of NON_IMAGE_SOP_PREFIXES) {
    if (sopClassUID === prefix || sopClassUID.startsWith(`${prefix}.`)) {
      return true;
    }
  }
  return false;
}

export async function loadDicomFiles(files: File[]): Promise<DicomSeriesInfo[]> {
  const seriesMap = new Map<string, ParsedFile[]>();
  let parseFailCount = 0;
  let filteredNonImage = 0;

  // Parallel I/O: bounded concurrency so huge studies don't OOM, but all CPU-bound
  // parsing runs concurrently with file reads.
  const ioConcurrency = Math.max(4, Math.min(32, navigator.hardwareConcurrency || 8));
  const parsed: Array<{ imageId: string; metadata: Record<string, string> } | null> = new Array(files.length).fill(null);

  async function processFile(file: File, index: number) {
    try {
      // Off-main-thread header parse with header-only slice read.
      const { metadata, hasPart10Header } = await parseFileHeader(file);

      // Most files are Part-10 (DICM preamble at byte 128). Only the
      // headerless implicit-VR exports need the Part-10 wrapper, which
      // requires the full byte buffer.
      let fileToLoad = file;
      if (!hasPart10Header) {
        const fullBytes = new Uint8Array(await file.arrayBuffer());
        const wrapped = wrapWithPart10Header(fullBytes);
        fileToLoad = new File([wrapped.buffer as ArrayBuffer], file.name, { type: 'application/dicom' });
      }

      const imageId = dicomImageLoader.wadouri.fileManager.add(fileToLoad);
      parsed[index] = { imageId, metadata };
    } catch (error) {
      parseFailCount += 1;
      if (parseFailCount <= 3) {
        console.warn(`[DICOM] Failed to parse ${file.name}:`, error);
      }
    }
  }

  // Simple concurrency pool.
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= files.length) return;
      await processFile(files[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(ioConcurrency, files.length) }, worker));

  for (const entry of parsed) {
    if (!entry) continue;
    const seriesUid = entry.metadata.seriesInstanceUID || 'unknown';
    if (!seriesMap.has(seriesUid)) {
      seriesMap.set(seriesUid, []);
    }
    seriesMap.get(seriesUid)!.push(entry);
  }

  const seriesList: DicomSeriesInfo[] = [];

  for (const [seriesInstanceUID, filesList] of seriesMap) {
    // Strategy:
    //  1. Group by acquisition identity (orientation + AcquisitionTime + AcquisitionNumber +
    //     TemporalPositionIdentifier). Different heartbeats / kernels / phases differ on at
    //     least one of these tags in every vendor we've seen.
    //  2. Within each group: sort by InstanceNumber (stable per acquisition), then walk
    //     forward and start a new pass whenever Z direction reverses or a duplicate Z occurs.
    //  3. Among all resulting passes, pick the one with the most slices that also has
    //     uniform spacing (≥90% of consecutive deltas match modal spacing within tolerance).
    // Splitting strategy: trust SeriesInstanceUID as the primary grouping
    // (matches how Horos/OsiriX/PACS systems present series). The ONLY
    // sub-UID splitter is uniform z-bucket detection for 4D cardiac
    // interleave, where multiple cardiac-phase reconstructions are stuffed
    // under one SeriesInstanceUID. acqKey-based splitting (kernel,
    // thickness, acquisitionNumber, temporalPosition) caused massive
    // over-splitting — single UIDs emitted 12 series — so we drop it and
    // let the natural UID grouping carry the load.

    // Splitting disabled per Horos-parity request. One SeriesInstanceUID =
    // one emitted series. Z-bucket 4D-interleave + direction-reversal +
    // acqKey-based splitting all removed; they caused over-splitting (SC
    // screenshots, motion-corrected reconstructions) more often than they
    // helped. Real 4D cardiac stays as one (long) UID, same as Horos.
    function splitGroup(group: typeof filesList): typeof filesList[] {
      if (!group || group.length === 0) return [];
      return [group];
    }

    const passes: typeof filesList[] = splitGroup(filesList);

    // Normalise passes so Z increases within each (sagittal/coronal MPR expects ascending Z).
    for (const pass of passes) {
      if (pass.length >= 2) {
        const first = getSlicePosition(pass[0].metadata);
        const last = getSlicePosition(pass[pass.length - 1].metadata);
        if (last < first) pass.reverse();
      }
    }

    // Keep filesList in Z-sorted form for UI numImages display.
    filesList.sort((lhs, rhs) => getSlicePosition(lhs.metadata) - getSlicePosition(rhs.metadata));

    function measureUniformity(pass: typeof filesList): { score: number; spacing: number } {
      const n = pass.length;
      if (n < 3) return { score: 0, spacing: 0 };
      // Cache positions once; compute diffs + histogram in single pass.
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
        const next = (bins.get(key) ?? 0) + 1;
        bins.set(key, next);
        if (next > bestCount) { bestCount = next; bestKey = key; }
      }
      const spacing = bestKey / 1000;
      if (spacing === 0) return { score: 0, spacing: 0 };
      const tol = Math.abs(spacing) * 0.1;
      let matches = 0;
      for (let i = 0; i < diffCount; i += 1) if (Math.abs(diffs[i] - spacing) <= tol) matches += 1;
      return { score: matches / diffCount, spacing };
    }

    // Emit one series per *acquisition pass* (different phase, kernel, or orientation
    // within the same SeriesInstanceUID). Vendors routinely stuff 8-20 cardiac
    // phases under a single SeriesInstanceUID — Horos/OsiriX split them, and so
    // should we. Score-based ordering still applies (best volumetric pass first).
    const measured = passes.map((pass) => ({ pass, ...measureUniformity(pass) }));

    // Preferred set: long, uniformly spaced volumetric passes.
    const preferred = measured
      .filter((entry) => entry.pass.length >= 10 && entry.score >= 0.9)
      .sort((a, b) => b.pass.length - a.pass.length);

    // Auxiliary set: localizers, topograms, derived screenshots, short stacks.
    // Kept so the UI mirrors what the scanner produced — user can pick any.
    const auxiliary = measured
      .filter((entry) => !(entry.pass.length >= 10 && entry.score >= 0.9))
      .sort((a, b) => b.pass.length - a.pass.length);

    const emitted = [...preferred, ...auxiliary];

    console.log(
      `[DICOM] UID ${seriesInstanceUID.slice(-12)}: ${passes.length} passes → ${emitted.length} emitted`
    );

    for (let idx = 0; idx < emitted.length; idx += 1) {
      const entry = emitted[idx];
      if (entry.pass.length < 1) continue;
      const first = entry.pass[0]?.metadata ?? {};
      if (isNonImageSopClass(first.sopClassUID || '')) {
        filteredNonImage += 1;
        continue;
      }
      const baseDescription = first.seriesDescription || 'Unknown Series';
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
        seriesInstanceUID: emitted.length > 1
          ? `${seriesInstanceUID}__pass${idx}`
          : seriesInstanceUID,
        seriesDescription: `${baseDescription}${phaseLabel}`.trim(),
        modality: first.modality || 'Unknown',
        numImages: entry.pass.length,
        imageIds: entry.pass.map((f) => f.imageId),
        patientName: first.patientName || 'Unknown',
        studyDescription: first.studyDescription || 'Unknown Study',
        sopClassUID: first.sopClassUID || '',
      });
    }
  }

  seriesList.sort((lhs, rhs) => {
    const scoreDelta = getSeriesPreferenceScore(rhs) - getSeriesPreferenceScore(lhs);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }

    const imageDelta = rhs.numImages - lhs.numImages;
    if (imageDelta !== 0) {
      return imageDelta;
    }

    return lhs.seriesDescription.localeCompare(rhs.seriesDescription);
  });
  console.log(
    `[DICOM] Loaded ${files.length} files, parsed ${files.length - parseFailCount}, failed ${parseFailCount}, filtered ${filteredNonImage} non-image series`
  );

  return seriesList;
}

async function preloadAllImages(
  imageIds: string[],
  concurrency = Math.max(8, Math.min(32, (navigator.hardwareConcurrency || 8) * 2)),
  onProgress?: (loaded: number, total: number) => void
): Promise<void> {
  let loaded = 0;
  let failed = 0;
  const total = imageIds.length;
  const chunkSize = Math.max(1, Math.ceil(imageIds.length / concurrency));
  const chunks: string[][] = [];

  for (let i = 0; i < imageIds.length; i += chunkSize) {
    chunks.push(imageIds.slice(i, i + chunkSize));
  }

  await Promise.all(
    chunks.map(async (chunk) => {
      for (const imageId of chunk) {
        try {
          await cornerstone.imageLoader.loadAndCacheImage(imageId);
        } catch (err) {
          failed += 1;
          if (failed <= 3) {
            console.warn(`[DICOM] Failed to load image ${imageId}:`, err);
          }
        }
        loaded += 1;
        onProgress?.(loaded, total);
      }
    })
  );

  if (failed === total) {
    throw new Error(`All ${total} images failed to load. Check browser console for details.`);
  }
  if (failed > 0) {
    console.warn(`[DICOM] ${failed}/${total} images failed to load`);
  }
}

export async function createVolume(
  volumeId: string,
  imageIds: string[],
  onProgress?: (loaded: number, total: number) => void
): Promise<cornerstone.Types.IImageVolume> {
  await preloadAllImages(imageIds, undefined, onProgress);

  let volume: cornerstone.Types.IImageVolume;
  try {
    volume = await cornerstone.volumeLoader.createAndCacheVolume(volumeId, { imageIds });
  } catch (err: any) {
    // Common cause: SharedArrayBuffer not available (missing COOP/COEP headers)
    const sab = typeof SharedArrayBuffer !== 'undefined';
    throw new Error(
      `createVolume failed: ${err?.message || err}` +
      (!sab ? ' — SharedArrayBuffer is not available. Ensure Cross-Origin-Embedder-Policy and Cross-Origin-Opener-Policy headers are set.' : '')
    );
  }

  if ('load' in volume && typeof volume.load === 'function') {
    (volume as cornerstone.Types.IStreamingImageVolume).load();
  }

  return volume;
}
