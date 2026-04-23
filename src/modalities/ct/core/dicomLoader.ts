import * as cornerstone from '@cornerstonejs/core';
import dicomImageLoader from '@cornerstonejs/dicom-image-loader';
import dicomParser from 'dicom-parser';

/**
 * Check if a byte array has a valid DICOM Part 10 header (DICM magic at byte 128).
 */
function hasPart10Header(byteArray: Uint8Array): boolean {
  if (byteArray.length < 132) return false;
  return (
    byteArray[128] === 0x44 && // D
    byteArray[129] === 0x49 && // I
    byteArray[130] === 0x43 && // C
    byteArray[131] === 0x4d    // M
  );
}

/**
 * Wrap a headerless (raw) DICOM byte array into a valid Part 10 file
 * by prepending 128-byte preamble + "DICM" + minimal meta header.
 * The meta header declares Implicit VR Little Endian transfer syntax.
 */
function wrapWithPart10Header(rawBytes: Uint8Array): Uint8Array {
  // Transfer syntax UID for Implicit VR Little Endian
  const tsUID = '1.2.840.10008.1.2';
  const tsBytes = new TextEncoder().encode(tsUID);
  // Pad to even length
  const tsPadded = tsBytes.length % 2 === 0 ? tsBytes : new Uint8Array([...tsBytes, 0x00]);

  // Build meta header elements:
  // (0002,0000) UL FileMetaInformationGroupLength
  // (0002,0010) UI TransferSyntaxUID
  const tsElementLength = 8 + tsPadded.length; // tag(4) + length(4) + value
  const groupLengthValue = tsElementLength;

  // Group length element: tag(4) + VR(0 since implicit) + length(4) + value(4) = but meta header is always explicit LE
  // Actually, the File Meta Header (group 0002) is ALWAYS Explicit VR Little Endian per DICOM standard
  // So we need to write it as explicit VR

  const metaElements: number[] = [];

  // (0002,0000) UL - File Meta Information Group Length
  // Tag: 02 00 00 00, VR: UL, Length: 4, Value: groupLengthValue
  metaElements.push(0x02, 0x00, 0x00, 0x00); // tag
  metaElements.push(0x55, 0x4C); // VR = "UL"
  metaElements.push(0x04, 0x00); // length = 4
  metaElements.push(
    groupLengthValue & 0xFF,
    (groupLengthValue >> 8) & 0xFF,
    (groupLengthValue >> 16) & 0xFF,
    (groupLengthValue >> 24) & 0xFF
  ); // value

  // (0002,0010) UI - Transfer Syntax UID
  metaElements.push(0x02, 0x00, 0x10, 0x00); // tag
  metaElements.push(0x55, 0x49); // VR = "UI"
  metaElements.push(tsPadded.length & 0xFF, (tsPadded.length >> 8) & 0xFF); // length
  for (let i = 0; i < tsPadded.length; i++) {
    metaElements.push(tsPadded[i]);
  }

  // Build full file: 128-byte preamble + "DICM" + meta header + original data
  const preamble = new Uint8Array(128); // zeros
  const dicm = new Uint8Array([0x44, 0x49, 0x43, 0x4D]); // "DICM"
  const metaHeader = new Uint8Array(metaElements);

  const result = new Uint8Array(128 + 4 + metaHeader.length + rawBytes.length);
  result.set(preamble, 0);
  result.set(dicm, 128);
  result.set(metaHeader, 132);
  result.set(rawBytes, 132 + metaHeader.length);

  return result;
}

export interface DicomSeriesInfo {
  seriesInstanceUID: string;
  seriesDescription: string;
  modality: string;
  numImages: number;
  imageIds: string[];
  patientName: string;
  studyDescription: string;
  studyDate: string;
}

interface ParsedFile {
  imageId: string;
  metadata: Record<string, string>;
}

// Parse metadata from a single DICOM file (supports both Part 10 and raw/headerless DICOM)
function parseMetadata(byteArray: Uint8Array): Record<string, string> {
  let dataSet: dicomParser.DataSet;
  try {
    // Primary path: stop before pixel data (largest element) for ~2-5× faster metadata parse.
    dataSet = dicomParser.parseDicom(byteArray, { untilTag: 'x7fe00010' });
  } catch {
    // Fallback: parse as raw/implicit little-endian DICOM (no Part 10 header).
    // Many PACS exports and older scanners produce files without the DICM preamble.
    // We create a ByteStream and parse directly as implicit LE, stopping before pixel data.
    try {
      const byteStream = new dicomParser.ByteStream(dicomParser.littleEndianByteArrayParser, byteArray, 0);
      const elements: Record<string, any> = {};
      dataSet = new dicomParser.DataSet(byteStream.byteArrayParser, byteArray, elements);
      (dicomParser as any).parseDicomDataSetImplicit(dataSet, byteStream, byteArray.length, {
        untilTag: 'x7fe00010',
      });
    } catch {
      // If implicit parsing also fails, try explicit LE without header
      const byteStream = new dicomParser.ByteStream(dicomParser.littleEndianByteArrayParser, byteArray, 0);
      const elements: Record<string, any> = {};
      dataSet = new dicomParser.DataSet(byteStream.byteArrayParser, byteArray, elements);
      (dicomParser as any).parseDicomDataSetExplicit(dataSet, byteStream, byteArray.length, {
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
    studyDate: getString('x00080020'),
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

// Load files and group by series, sorted by most images first
export async function loadDicomFiles(files: File[]): Promise<DicomSeriesInfo[]> {
  const seriesMap = new Map<string, ParsedFile[]>();

  let parseFailCount = 0;
  const ioConcurrency = Math.max(4, Math.min(32, navigator.hardwareConcurrency || 8));
  const parsed: Array<{ imageId: string; metadata: Record<string, string>; seriesUID: string } | null> =
    new Array(files.length).fill(null);

  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= files.length) return;
      const file = files[index];
      try {
        const arrayBuffer = await file.arrayBuffer();
        const byteArray = new Uint8Array(arrayBuffer);
        const needsWrapper = !hasPart10Header(byteArray);
        const metadata = parseMetadata(byteArray);

        let fileToLoad: File = file;
        if (needsWrapper) {
          const wrapped = wrapWithPart10Header(byteArray);
          fileToLoad = new File([wrapped], file.name, { type: 'application/dicom' });
        }
        const imageId = dicomImageLoader.wadouri.fileManager.add(fileToLoad);
        parsed[index] = {
          imageId,
          metadata,
          seriesUID: metadata.seriesInstanceUID || 'unknown',
        };
      } catch (e) {
        parseFailCount++;
        if (parseFailCount <= 3) {
          console.warn(`[DICOM] Failed to parse ${file.name} (${file.size} bytes):`, e);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(ioConcurrency, files.length) }, worker));

  for (const entry of parsed) {
    if (!entry) continue;
    if (!seriesMap.has(entry.seriesUID)) {
      seriesMap.set(entry.seriesUID, []);
    }
    seriesMap.get(entry.seriesUID)!.push({ imageId: entry.imageId, metadata: entry.metadata });
  }

  const seriesList: DicomSeriesInfo[] = [];

  for (const [uid, filesList] of seriesMap) {
    // Multi-phase / step-and-shoot / multi-kernel dedup pipeline ported from
    // coronary-ct loader. Mixed-phase slices at overlapping Z produce striping
    // in MPR when cornerstone extrudes the volume with non-uniform spacing —
    // we split by acquisition identity, then by InstanceNumber-ordered
    // Z-direction runs, then keep the longest pass that has ≥90% uniform
    // slice spacing.

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
      const n = parseFloat(m.instanceNumber || '');
      return Number.isFinite(n) ? n : 0;
    }

    const passes: typeof filesList[] = [];
    for (const group of acqGroups.values()) {
      group.sort((a, b) => instanceNumber(a.metadata) - instanceNumber(b.metadata));
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

    const measured = passes.map((pass) => ({ pass, ...measureUniformity(pass) }));
    let scored = measured
      .filter((entry) => entry.pass.length >= 10 && entry.score >= 0.9)
      .sort((a, b) => b.pass.length - a.pass.length);
    if (scored.length === 0) {
      scored = measured
        .filter((entry) => entry.pass.length >= 2)
        .sort((a, b) => b.pass.length - a.pass.length);
    }

    if (scored.length > 0) {
      const primaryPass = scored[0].pass;
      const first = primaryPass[0]?.metadata ?? {};

      seriesList.push({
        seriesInstanceUID: uid,
        seriesDescription: first.seriesDescription || 'Unknown Series',
        modality: first.modality || 'Unknown',
        numImages: filesList.length,
        imageIds: primaryPass.map((f) => f.imageId),
        patientName: first.patientName || 'Unknown',
        studyDescription: first.studyDescription || 'Unknown Study',
        studyDate: first.studyDate || '',
      });
    }
  }

  seriesList.sort((a, b) => b.numImages - a.numImages);

  console.log(`[DICOM] Loaded ${files.length} files: ${files.length - parseFailCount} parsed, ${parseFailCount} failed, ${seriesList.length} series found`);

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
  let loaded = 0;
  const total = imageIds.length;

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
  const chunkSize = Math.ceil(imageIds.length / concurrency);
  const chunks: string[][] = [];
  for (let i = 0; i < imageIds.length; i += chunkSize) {
    chunks.push(imageIds.slice(i, i + chunkSize));
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
