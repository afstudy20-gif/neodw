import * as cornerstone from '@cornerstonejs/core';
import dicomImageLoader from '@cornerstonejs/dicom-image-loader';
import { parseFileHeader } from '../../../shared/dicom/parseHeaders';
import { wrapWithPart10Header } from '../../../shared/dicom/loaderCore';

export interface CArmGeometry {
  primaryAngle: number;    // PositionerPrimaryAngle, degrees (LAO+/RAO-)
  secondaryAngle: number;  // PositionerSecondaryAngle, degrees (CRA+/CAU-)
  sid: number;             // DistanceSourceToDetector, mm
  sod: number;             // DistanceSourceToPatient, mm
  pixelSpacing: number;    // ImagerPixelSpacing or PixelSpacing, mm/px
  rows: number;
  columns: number;
}

export interface DicomSeriesInfo {
  seriesInstanceUID: string;
  seriesDescription: string;
  modality: string;
  numImages: number;
  imageIds: string[];
  patientName: string;
  studyDescription: string;
  thumbnailImageId: string;  // first frame imageId for thumbnail
  geometry?: CArmGeometry;   // present when C-arm tags available (XA series)
}

interface ParsedFile {
  imageId: string;
  metadata: Record<string, string>;
}

// hasPart10Header removed — worker reports it.
// wrapWithPart10Header moved to shared/dicom/loaderCore.ts.
// parseMetadata replaced by shared worker-pool helper.

function parseGeometry(metadata: Record<string, string>): CArmGeometry | undefined {
  const primaryAngle = Number.parseFloat(metadata.primaryAngle);
  const secondaryAngle = Number.parseFloat(metadata.secondaryAngle);
  const sid = Number.parseFloat(metadata.sid);
  const sod = Number.parseFloat(metadata.sod);
  if (
    Number.isNaN(primaryAngle) ||
    Number.isNaN(secondaryAngle) ||
    Number.isNaN(sid) ||
    Number.isNaN(sod) ||
    sid <= 0 ||
    sod <= 0
  ) {
    return undefined;
  }

  const spacingStr = metadata.imagerPixelSpacing || metadata.pixelSpacing;
  const spacingParts = spacingStr ? spacingStr.split('\\') : [];
  const pixelSpacing = spacingParts.length > 0 ? Number.parseFloat(spacingParts[0]) : Number.NaN;

  const rows = Number.parseInt(metadata.rows, 10);
  const columns = Number.parseInt(metadata.columns, 10);

  return {
    primaryAngle,
    secondaryAngle,
    sid,
    sod,
    pixelSpacing: Number.isFinite(pixelSpacing) && pixelSpacing > 0 ? pixelSpacing : 0.2,
    rows: Number.isFinite(rows) ? rows : 512,
    columns: Number.isFinite(columns) ? columns : 512,
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
      const { metadata, hasPart10Header } = await parseFileHeader(file);

      let fileToLoad = file;
      if (!hasPart10Header) {
        const fullBytes = new Uint8Array(await file.arrayBuffer());
        const wrapped = wrapWithPart10Header(fullBytes);
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
      geometry: parseGeometry(first),
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
