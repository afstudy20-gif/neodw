import * as cornerstone from '@cornerstonejs/core';
import dicomImageLoader from '@cornerstonejs/dicom-image-loader';
import dicomParser from 'dicom-parser';

export interface DicomSeriesInfo {
  seriesInstanceUID: string;
  seriesDescription: string;
  modality: string;
  numImages: number;
  imageIds: string[];
  patientName: string;
  studyDescription: string;
}

interface ParsedFile {
  imageId: string;
  metadata: Record<string, string>;
}

function hasPart10Header(byteArray: Uint8Array): boolean {
  return (
    byteArray.length >= 132 &&
    byteArray[128] === 0x44 &&
    byteArray[129] === 0x49 &&
    byteArray[130] === 0x43 &&
    byteArray[131] === 0x4d
  );
}

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

function parseMetadata(byteArray: Uint8Array): Record<string, string> {
  const parserAny = dicomParser as any;
  let dataSet: any;

  // Primary path: full parse with untilTag so pixel data (largest element) is skipped.
  try {
    dataSet = parserAny.parseDicom(byteArray, { untilTag: 'x7fe00010' });
  } catch {
    try {
      const byteStream = new parserAny.ByteStream(parserAny.littleEndianByteArrayParser, byteArray, 0);
      const elements: Record<string, unknown> = {};
      dataSet = new parserAny.DataSet(byteStream.byteArrayParser, byteArray, elements);
      parserAny.parseDicomDataSetImplicit(dataSet, byteStream, byteArray.length, {
        untilTag: 'x7fe00010',
      });
    } catch {
      const byteStream = new parserAny.ByteStream(parserAny.littleEndianByteArrayParser, byteArray, 0);
      const elements: Record<string, unknown> = {};
      dataSet = new parserAny.DataSet(byteStream.byteArrayParser, byteArray, elements);
      parserAny.parseDicomDataSetExplicit(dataSet, byteStream, byteArray.length, {
        untilTag: 'x7fe00010',
      });
    }
  }

  const getString = (tag: string): string => {
    try {
      return dataSet.string(tag) || '';
    } catch {
      return '';
    }
  };

  return {
    patientName: getString('x00100010'),
    studyDescription: getString('x00081030'),
    seriesDescription: getString('x0008103e'),
    seriesInstanceUID: getString('x0020000e'),
    modality: getString('x00080060'),
    instanceNumber: getString('x00200013'),
    sliceLocation: getString('x00201041'),
    imagePositionPatient: getString('x00200032'),
    acquisitionNumber: getString('x00200012'),
    temporalPositionIdentifier: getString('x00200100'),
    acquisitionTime: getString('x00080032'),
    imageOrientationPatient: getString('x00200037'),
  };
}

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

export async function loadDicomFiles(files: File[]): Promise<DicomSeriesInfo[]> {
  const seriesMap = new Map<string, ParsedFile[]>();
  let parseFailCount = 0;

  // Parallel I/O: bounded concurrency so huge studies don't OOM, but all CPU-bound
  // parsing runs concurrently with file reads.
  const ioConcurrency = Math.max(4, Math.min(32, navigator.hardwareConcurrency || 8));
  const parsed: Array<{ imageId: string; metadata: Record<string, string> } | null> = new Array(files.length).fill(null);

  async function processFile(file: File, index: number) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const byteArray = new Uint8Array(arrayBuffer);
      const needsWrapper = !hasPart10Header(byteArray);
      const metadata = parseMetadata(byteArray);

      let fileToLoad = file;
      if (needsWrapper) {
        // wrapWithPart10Header already returns a fresh Uint8Array; no extra copy needed.
        const wrapped = wrapWithPart10Header(byteArray);
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
    function acqKey(m: Record<string, string>): string {
      return [
        m.imageOrientationPatient || '',
        m.acquisitionTime || '',
        m.acquisitionNumber || '',
        m.temporalPositionIdentifier || '',
      ].join('|');
    }

    const acqGroups = new Map<string, typeof filesList>();
    for (const file of filesList) {
      const key = acqKey(file.metadata);
      if (!acqGroups.has(key)) acqGroups.set(key, []);
      acqGroups.get(key)!.push(file);
    }

    function instanceNumber(m: Record<string, string>): number {
      const n = Number.parseFloat(m.instanceNumber || '');
      return Number.isFinite(n) ? n : 0;
    }

    const passes: typeof filesList[] = [];
    for (const group of acqGroups.values()) {
      // Sort by InstanceNumber (scanner's native acquisition order within this phase).
      group.sort((a, b) => instanceNumber(a.metadata) - instanceNumber(b.metadata));
      // Walk and split whenever Z direction flips or Z stalls (indicates a new pass).
      let current: typeof filesList = [];
      let lastZ: number | null = null;
      let direction: 0 | 1 | -1 = 0;
      for (const file of group) {
        const z = getSlicePosition(file.metadata);
        if (current.length === 0 || lastZ === null) {
          current.push(file);
          lastZ = z;
          continue;
        }
        const dz = z - lastZ;
        const absDz = Math.abs(dz);
        if (absDz < 1e-3) {
          // Duplicate Z → new pass.
          passes.push(current);
          current = [file];
          lastZ = z;
          direction = 0;
          continue;
        }
        const newDir: 1 | -1 = dz > 0 ? 1 : -1;
        if (direction !== 0 && newDir !== direction) {
          passes.push(current);
          current = [file];
          lastZ = z;
          direction = 0;
          continue;
        }
        current.push(file);
        lastZ = z;
        direction = newDir;
      }
      if (current.length > 0) passes.push(current);
    }

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

    // Score passes: prefer long + uniformly-spaced.
    const measured = passes.map((pass) => ({ pass, ...measureUniformity(pass) }));
    let scored = measured
      .filter((entry) => entry.pass.length >= 10 && entry.score >= 0.9)
      .sort((a, b) => b.pass.length - a.pass.length);
    if (scored.length === 0) {
      // Fallback: largest pass (older data without AcquisitionTime/Number tags).
      scored = measured
        .filter((entry) => entry.pass.length >= 2)
        .sort((a, b) => b.pass.length - a.pass.length);
    }

    if (scored.length > 0) {
      const primaryPass = scored[0].pass;
      const first = primaryPass[0]?.metadata ?? {};

      seriesList.push({
        seriesInstanceUID: seriesInstanceUID,
        seriesDescription: first.seriesDescription || 'Unknown Series',
        modality: first.modality || 'Unknown',
        numImages: filesList.length, // Display the true physical length for UI matching
        imageIds: primaryPass.map((entry) => entry.imageId), // Only load geometrically contiguous slices
        patientName: first.patientName || 'Unknown',
        studyDescription: first.studyDescription || 'Unknown Study',
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
    `[DICOM] Loaded ${files.length} files, parsed ${files.length - parseFailCount}, failed ${parseFailCount}`
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
