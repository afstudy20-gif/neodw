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

function parseMetadata(arrayBuffer: ArrayBuffer): Record<string, string> {
  const parserAny = dicomParser as any;
  const byteArray = new Uint8Array(arrayBuffer);
  let dataSet: any;

  try {
    dataSet = parserAny.parseDicom(byteArray);
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

export async function loadDicomFiles(files: File[]): Promise<DicomSeriesInfo[]> {
  const seriesMap = new Map<string, ParsedFile[]>();
  let parseFailCount = 0;

  for (const file of files) {
    const arrayBuffer = await file.arrayBuffer();
    const byteArray = new Uint8Array(arrayBuffer);
    const needsWrapper = !hasPart10Header(byteArray);

    let metadata: Record<string, string>;
    try {
      metadata = parseMetadata(arrayBuffer);
    } catch (error) {
      parseFailCount += 1;
      if (parseFailCount <= 3) {
        console.warn(`[DICOM] Failed to parse ${file.name}:`, error);
      }
      continue;
    }

    let fileToLoad = file;
    if (needsWrapper) {
      const wrapped = wrapWithPart10Header(byteArray);
      const wrappedCopy = new Uint8Array(wrapped.length);
      wrappedCopy.set(wrapped);
      fileToLoad = new File([wrappedCopy.buffer], file.name, { type: 'application/dicom' });
    }

    const imageId = dicomImageLoader.wadouri.fileManager.add(fileToLoad);
    const seriesUid = metadata.seriesInstanceUID || 'unknown';

    if (!seriesMap.has(seriesUid)) {
      seriesMap.set(seriesUid, []);
    }

    seriesMap.get(seriesUid)?.push({ imageId, metadata });
  }

  const seriesList: DicomSeriesInfo[] = [];

  for (const [seriesInstanceUID, filesList] of seriesMap) {
    // 1. Sort strictly by ascending Z position using ImagePositionPatient
    filesList.sort((lhs, rhs) => getSlicePosition(lhs.metadata) - getSlicePosition(rhs.metadata));

    // 2. Separate interleaved phases and discard step-and-shoot redundant slices
    // We group slices into multiple "passes".
    const passes: typeof filesList[] = [];
    const Z_TOLERANCE = 0.05; // 0.05mm minimum slice spacing

    for (const file of filesList) {
      const z = getSlicePosition(file.metadata);
      let placed = false;

      for (const pass of passes) {
        if (pass.length === 0) {
          pass.push(file);
          placed = true;
          break;
        }
        const lastZ = getSlicePosition(pass[pass.length - 1].metadata);
        if (z - lastZ > Z_TOLERANCE) {
          pass.push(file);
          placed = true;
          break;
        }
      }

      if (!placed) {
        passes.push([file]);
      }
    }

    // A real sub-volume should have a similar number of slices to the main pass.
    // Step-and-shoot boundaries usually generate a pass with just 1 or 2 slices.
    const maxSlices = Math.max(...passes.map(p => p.length));
    const validPasses = passes.filter(p => p.length >= maxSlices * 0.4); // At least 40% of max

    for (let passIdx = 0; passIdx < validPasses.length; passIdx++) {
      const parsedFiles = validPasses[passIdx];
      const first = parsedFiles[0]?.metadata ?? {};

      let desc = first.seriesDescription || 'Unknown Series';
      // Append pass info if we found multiple interleaved phases
      if (validPasses.length > 1) {
        // Try to identify it using Trigger Time or Phase
        const phaseMarker = first.temporalPosition || first.triggerTime || first.acquisitionNumber;
        if (phaseMarker) {
          desc = `${desc} (Phase/Acq: ${phaseMarker})`;
        } else {
          desc = `${desc} (Sub-volume ${passIdx + 1})`;
        }
      }

      seriesList.push({
        seriesInstanceUID: validPasses.length > 1 ? `${seriesInstanceUID}_pass${passIdx}` : seriesInstanceUID,
        seriesDescription: desc,
        modality: first.modality || 'Unknown',
        numImages: parsedFiles.length,
        imageIds: parsedFiles.map((entry) => entry.imageId),
        patientName: first.patientName || 'Unknown',
        studyDescription: first.studyDescription || 'Unknown Study',
      });
    }
  }

  seriesList.sort((lhs, rhs) => rhs.numImages - lhs.numImages);
  console.log(
    `[DICOM] Loaded ${files.length} files, parsed ${files.length - parseFailCount}, failed ${parseFailCount}`
  );

  return seriesList;
}

async function preloadAllImages(
  imageIds: string[],
  concurrency = 12,
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
  await preloadAllImages(imageIds, 12, onProgress);

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
