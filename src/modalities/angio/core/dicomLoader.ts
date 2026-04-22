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
  thumbnailImageId: string;  // first frame imageId for thumbnail
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
    sopInstanceUID: getString('x00080018'),
    modality: getString('x00080060'),
    instanceNumber: getString('x00200013'),
    sliceLocation: getString('x00201041'),
    imagePositionPatient: getString('x00200032'),
    numberOfFrames: getString('x00280008'),
    acquisitionNumber: getString('x00200012'),
    acquisitionTime: getString('x00080032'),
  };
}

function getSlicePosition(metadata: Record<string, string>): number {
  if (metadata.instanceNumber) {
    const instanceNumber = Number.parseFloat(metadata.instanceNumber);
    if (!Number.isNaN(instanceNumber)) {
      return instanceNumber;
    }
  }

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

  return 0;
}

export async function loadDicomFiles(files: File[]): Promise<DicomSeriesInfo[]> {
  const seriesMap = new Map<string, ParsedFile[]>();
  let parseFailCount = 0;

  const ioConcurrency = Math.max(4, Math.min(32, navigator.hardwareConcurrency || 8));
  type Outcome = {
    groupKey: string;
    entries: ParsedFile[];
  } | null;
  const outcomes: Outcome[] = new Array(files.length).fill(null);

  async function processFile(file: File, index: number) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const byteArray = new Uint8Array(arrayBuffer);
      const needsWrapper = !hasPart10Header(byteArray);
      const metadata = parseMetadata(byteArray);

      let fileToLoad = file;
      if (needsWrapper) {
        const wrapped = wrapWithPart10Header(byteArray);
        fileToLoad = new File([wrapped.buffer as ArrayBuffer], file.name, { type: 'application/dicom' });
      }

      const baseImageId = dicomImageLoader.wadouri.fileManager.add(fileToLoad);
      const numFrames = Math.max(1, Number.parseInt(metadata.numberOfFrames, 10) || 1);
      const isMultiFrame = numFrames > 1;
      const groupKey = isMultiFrame
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
      outcomes[index] = { groupKey, entries };
    } catch (error) {
      parseFailCount += 1;
      if (parseFailCount <= 3) {
        console.warn(`[DICOM] Failed to parse ${file.name}:`, error);
      }
    }
  }

  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= files.length) return;
      await processFile(files[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(ioConcurrency, files.length) }, worker));

  for (const outcome of outcomes) {
    if (!outcome) continue;
    if (!seriesMap.has(outcome.groupKey)) seriesMap.set(outcome.groupKey, []);
    const bucket = seriesMap.get(outcome.groupKey)!;
    for (const entry of outcome.entries) bucket.push(entry);
  }

  const seriesList: DicomSeriesInfo[] = [];

  for (const [groupKey, parsedFiles] of seriesMap) {
    parsedFiles.sort((lhs, rhs) => getSlicePosition(lhs.metadata) - getSlicePosition(rhs.metadata));
    const first = parsedFiles[0]?.metadata ?? {};

    seriesList.push({
      seriesInstanceUID: groupKey,
      seriesDescription: first.seriesDescription || 'Unknown Series',
      modality: first.modality || 'Unknown',
      numImages: parsedFiles.length,
      imageIds: parsedFiles.map((entry) => entry.imageId),
      patientName: first.patientName || 'Unknown',
      studyDescription: first.studyDescription || 'Unknown Study',
      thumbnailImageId: parsedFiles[0]?.imageId ?? '',
    });
  }

  // Keep original load order (files come in filesystem/acquisition order)
  // Don't re-sort by numImages as that shuffles the clinical sequence
  console.log(
    `[DICOM] Loaded ${files.length} files, parsed ${files.length - parseFailCount}, failed ${parseFailCount}`
  );

  return seriesList;
}

export async function preloadImages(
  imageIds: string[],
  onProgress?: (loaded: number, total: number) => void
): Promise<void> {
  // For multi-frame series, deduplicate base imageIds to avoid redundant loads.
  // Cornerstone loads the full DICOM file on the first frame request; subsequent
  // frame requests read from the already-cached dataset.
  const uniqueBaseIds = new Set<string>();
  const idsToLoad: string[] = [];
  for (const id of imageIds) {
    const ampIdx = id.indexOf('&frame=');
    const base = ampIdx >= 0 ? id.slice(0, ampIdx) : id;
    if (!uniqueBaseIds.has(base)) {
      uniqueBaseIds.add(base);
      idsToLoad.push(id); // load first frame to cache the dataset
    }
  }

  let loaded = 0;
  const total = idsToLoad.length;
  const concurrency = Math.max(8, Math.min(32, (navigator.hardwareConcurrency || 8) * 2));
  const chunkSize = Math.max(1, Math.ceil(idsToLoad.length / concurrency));
  const chunks: string[][] = [];

  for (let i = 0; i < idsToLoad.length; i += chunkSize) {
    chunks.push(idsToLoad.slice(i, i + chunkSize));
  }

  await Promise.all(
    chunks.map(async (chunk) => {
      for (const imageId of chunk) {
        try {
          await cornerstone.imageLoader.loadAndCacheImage(imageId);
        } catch {
          // Skip individual image failures so the series can still load.
        }
        loaded += 1;
        onProgress?.(loaded, total);
      }
    })
  );
}
