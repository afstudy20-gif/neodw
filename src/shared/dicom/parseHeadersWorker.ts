/// <reference lib="webworker" />

// Web Worker that runs dicom-parser off the main thread.
// Exposes a single `parseHeader(bytes)` function via Comlink. Each
// modality loader dispatches its `processFile` step here so the UI
// stays responsive while N slices are parsed in parallel.

import { expose } from 'comlink';
import dicomParser from 'dicom-parser';

// All metadata tags any modality loader currently extracts. Kept in
// one place so the worker is the single source of truth for what we
// pull from each file's header.
const TAGS: Record<string, string> = {
  patientName: 'x00100010',
  patientID: 'x00100020',
  patientBirthDate: 'x00100030',
  patientSex: 'x00100040',
  studyInstanceUID: 'x0020000d',
  studyDescription: 'x00081030',
  studyDate: 'x00080020',
  studyTime: 'x00080030',
  seriesDescription: 'x0008103e',
  seriesInstanceUID: 'x0020000e',
  sopInstanceUID: 'x00080018',
  sopClassUID: 'x00080016',
  modality: 'x00080060',
  instanceNumber: 'x00200013',
  sliceLocation: 'x00201041',
  imagePositionPatient: 'x00200032',
  acquisitionNumber: 'x00200012',
  temporalPositionIdentifier: 'x00200100',
  acquisitionTime: 'x00080032',
  imageOrientationPatient: 'x00200037',
  numberOfFrames: 'x00280008',
  convolutionKernel: 'x00181210',
  sliceThickness: 'x00180050',
  pixelSpacing: 'x00280030',
  contrastBolusAgent: 'x00180010',
  imageType: 'x00080008',
  cardiacRRIntervalSpecified: 'x0018a005',
  nominalPercentageOfCardiacPhase: 'x00209241',
  triggerTime: 'x00181060',
  // C-arm geometry (angio biplane)
  primaryAngle: 'x00181510',
  secondaryAngle: 'x00181511',
  sid: 'x00181110',
  sod: 'x00181111',
  imagerPixelSpacing: 'x00181164',
  rows: 'x00280010',
  columns: 'x00280011',
};

function parseDataSet(byteArray: Uint8Array): {
  dataSet: ReturnType<typeof dicomParser.parseDicom>;
  hasPart10: boolean;
} {
  const parser: typeof dicomParser & {
    ByteStream?: new (
      byteArrayParser: unknown,
      byteArray: Uint8Array,
      offset: number
    ) => { byteArrayParser: unknown };
    DataSet?: new (
      byteArrayParser: unknown,
      byteArray: Uint8Array,
      elements: Record<string, unknown>
    ) => ReturnType<typeof dicomParser.parseDicom>;
    littleEndianByteArrayParser?: unknown;
    parseDicomDataSetImplicit?: (
      dataSet: ReturnType<typeof dicomParser.parseDicom>,
      byteStream: unknown,
      max: number,
      opts: { untilTag: string }
    ) => void;
    parseDicomDataSetExplicit?: (
      dataSet: ReturnType<typeof dicomParser.parseDicom>,
      byteStream: unknown,
      max: number,
      opts: { untilTag: string }
    ) => void;
  } = dicomParser as never;
  const hasPart10 =
    byteArray.length >= 132 &&
    byteArray[128] === 0x44 &&
    byteArray[129] === 0x49 &&
    byteArray[130] === 0x43 &&
    byteArray[131] === 0x4d;
  try {
    return {
      dataSet: parser.parseDicom(byteArray, { untilTag: 'x7fe00010' }),
      hasPart10,
    };
  } catch {
    // Headerless implicit-VR fallback (CD exports, anonymisers).
    try {
      const byteStream = new parser.ByteStream!(parser.littleEndianByteArrayParser, byteArray, 0);
      const elements: Record<string, unknown> = {};
      const dataSet = new parser.DataSet!(byteStream.byteArrayParser, byteArray, elements);
      parser.parseDicomDataSetImplicit!(dataSet, byteStream, byteArray.length, {
        untilTag: 'x7fe00010',
      });
      return { dataSet, hasPart10 };
    } catch {
      const byteStream = new parser.ByteStream!(parser.littleEndianByteArrayParser, byteArray, 0);
      const elements: Record<string, unknown> = {};
      const dataSet = new parser.DataSet!(byteStream.byteArrayParser, byteArray, elements);
      parser.parseDicomDataSetExplicit!(dataSet, byteStream, byteArray.length, {
        untilTag: 'x7fe00010',
      });
      return { dataSet, hasPart10 };
    }
  }
}

export interface ParsedHeader {
  metadata: Record<string, string>;
  hasPart10Header: boolean;
}

const api = {
  parseHeader(bytes: Uint8Array): ParsedHeader {
    const { dataSet, hasPart10 } = parseDataSet(bytes);
    const ds = dataSet as { string: (tag: string) => string | undefined };
    const metadata: Record<string, string> = {};
    for (const [key, tag] of Object.entries(TAGS)) {
      try {
        metadata[key] = ds.string(tag) ?? '';
      } catch {
        metadata[key] = '';
      }
    }
    return { metadata, hasPart10Header: hasPart10 };
  },
};

export type ParseHeadersWorkerApi = typeof api;

expose(api);
