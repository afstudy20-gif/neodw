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

  for (let fi = 0; fi < files.length; fi++) {
    // Yield to UI thread every 5 files to prevent freezing
    if (fi > 0 && fi % 5 === 0) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    const file = files[fi];
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

    const baseImageId = dicomImageLoader.wadouri.fileManager.add(fileToLoad);
    const numFrames = Math.max(1, Number.parseInt(metadata.numberOfFrames, 10) || 1);

    // For multi-frame XA DICOM: each frame gets its own imageId
    // Group multi-frame files by SOP Instance UID (each file = one cine run)
    // Group single-frame files by Series Instance UID (traditional grouping)
    const isMultiFrame = numFrames > 1;
    const groupKey = isMultiFrame
      ? `mf_${metadata.sopInstanceUID || file.name}`
      : (metadata.seriesInstanceUID || 'unknown');

    if (!seriesMap.has(groupKey)) {
      seriesMap.set(groupKey, []);
    }

    if (isMultiFrame) {
      // Cornerstone dicom-image-loader uses &frame=N (1-indexed) for multi-frame
      for (let frame = 1; frame <= numFrames; frame++) {
        const frameImageId = `${baseImageId}&frame=${frame}`;
        seriesMap.get(groupKey)?.push({
          imageId: frameImageId,
          metadata: { ...metadata, instanceNumber: String(frame) },
        });
      }
    } else {
      seriesMap.get(groupKey)?.push({ imageId: baseImageId, metadata });
    }
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
  const concurrency = 12;
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
