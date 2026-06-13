// JPEG / raster image → DICOM Secondary Capture.
//
// Builds a valid uncompressed Secondary Capture (SC) DICOM Part 10 object from
// decoded pixels (Explicit VR Little Endian, native pixel data — no JPEG
// encapsulation, so any DICOM reader can open it). A thin browser wrapper
// decodes a JPEG/PNG File via canvas and feeds the pure builder.

import {
  buildPart10,
  generateUid,
  dicomDate,
  dicomTime,
  type DicomDataset,
  type DicomElement,
} from './dicomWriter';

const SC_SOP_CLASS_UID = '1.2.840.10008.5.1.4.1.1.7'; // Secondary Capture Image Storage

export interface SecondaryCaptureOptions {
  rows: number;
  columns: number;
  /** Interleaved pixel bytes: RGB (3×) or single-channel (1×), 8-bit. */
  pixels: Uint8Array;
  photometric?: 'RGB' | 'MONOCHROME2';
  patientName?: string;
  patientID?: string;
  studyDescription?: string;
  seriesDescription?: string;
  /** Reuse an existing study/series to group converted images; auto-generated otherwise. */
  studyInstanceUID?: string;
  seriesInstanceUID?: string;
  instanceNumber?: number;
}

/**
 * Build an uncompressed Secondary Capture DICOM from decoded 8-bit pixels.
 * Pure — no DOM. RGB pixels must be interleaved (R,G,B,R,G,B,…).
 */
export function buildSecondaryCaptureDicom(opts: SecondaryCaptureOptions): Uint8Array {
  const photometric = opts.photometric ?? 'RGB';
  const samplesPerPixel = photometric === 'RGB' ? 3 : 1;
  const expected = opts.rows * opts.columns * samplesPerPixel;
  if (opts.pixels.length < expected) {
    throw new Error(
      `buildSecondaryCaptureDicom: pixels too short (${opts.pixels.length} < ${expected} for ${opts.columns}×${opts.rows}×${samplesPerPixel})`
    );
  }

  // Pixel data must be even length (DICOM PS3.5 §7.1.1).
  let pixelData = opts.pixels.subarray(0, expected);
  if (pixelData.length % 2 === 1) {
    const padded = new Uint8Array(pixelData.length + 1);
    padded.set(pixelData);
    pixelData = padded;
  }

  const sopInstanceUid = generateUid();
  const now = new Date();

  const dataset: DicomDataset = [
    // Patient
    { tag: '00100010', vr: 'PN', value: opts.patientName ?? 'ANONYMOUS' },
    { tag: '00100020', vr: 'LO', value: opts.patientID ?? '' },
    // General Study
    { tag: '00080020', vr: 'DA', value: dicomDate(now) },
    { tag: '00080030', vr: 'TM', value: dicomTime(now) },
    { tag: '0020000D', vr: 'UI', value: opts.studyInstanceUID ?? generateUid() },
    { tag: '00080050', vr: 'SH', value: '' },
    { tag: '00081030', vr: 'LO', value: opts.studyDescription ?? 'Imported image' },
    // General Series — SC is modality OT (Other).
    { tag: '00080060', vr: 'CS', value: 'OT' },
    { tag: '0020000E', vr: 'UI', value: opts.seriesInstanceUID ?? generateUid() },
    { tag: '00200011', vr: 'IS', value: '1' },
    { tag: '0008103E', vr: 'LO', value: opts.seriesDescription ?? 'Secondary Capture' },
    // SC Equipment
    { tag: '00080064', vr: 'CS', value: 'WSD' }, // Conversion Type: Workstation
    { tag: '00080070', vr: 'LO', value: 'NeoDW' },
    // SOP Common
    { tag: '00080016', vr: 'UI', value: SC_SOP_CLASS_UID },
    { tag: '00080018', vr: 'UI', value: sopInstanceUid },
    { tag: '00200013', vr: 'IS', value: String(opts.instanceNumber ?? 1) },
    // Image Pixel
    { tag: '00280002', vr: 'US', value: samplesPerPixel },
    { tag: '00280004', vr: 'CS', value: photometric },
    { tag: '00280010', vr: 'US', value: opts.rows },
    { tag: '00280011', vr: 'US', value: opts.columns },
    { tag: '00280100', vr: 'US', value: 8 },
    { tag: '00280101', vr: 'US', value: 8 },
    { tag: '00280102', vr: 'US', value: 7 },
    { tag: '00280103', vr: 'US', value: 0 },
    { tag: '7FE00010', vr: 'OB', value: pixelData },
  ];

  // Planar configuration is only defined for multi-sample images.
  if (samplesPerPixel > 1) {
    const planar: DicomElement = { tag: '00280006', vr: 'US', value: 0 }; // interleaved
    dataset.splice(dataset.findIndex((e) => e.tag === '00280010'), 0, planar);
  }

  return buildPart10(SC_SOP_CLASS_UID, sopInstanceUid, dataset);
}

/**
 * Browser helper: decode a JPEG/PNG File to RGB pixels via canvas and wrap it
 * as a Secondary Capture DICOM. Requires a DOM (createImageBitmap + canvas).
 */
export async function jpegFileToDicom(
  file: File,
  meta: Omit<SecondaryCaptureOptions, 'rows' | 'columns' | 'pixels' | 'photometric'> = {}
): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('jpegFileToDicom: 2D canvas context unavailable');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const rgba = ctx.getImageData(0, 0, width, height).data; // RGBA

  // Strip alpha → interleaved RGB.
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }

  return buildSecondaryCaptureDicom({
    ...meta,
    rows: height,
    columns: width,
    pixels: rgb,
    photometric: 'RGB',
  });
}
