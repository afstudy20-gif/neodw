// Build a DICOM Encapsulated PDF SOP (SOP Class 1.2.840.10008.5.1.4.1.1.104.1)
// from a PDF byte buffer. The resulting Part-10 file can be sent to PACS
// alongside the imaging series for the same study.

import { buildPart10, dicomDate, dicomTime, generateUid, type DicomDataset } from './dicomWriter';

const ENCAPSULATED_PDF_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.104.1';

export interface EncapsulatedPdfInput {
  pdfBytes: Uint8Array;
  studyInstanceUid?: string;
  patientName?: string;
  patientId?: string;
  patientBirthDate?: string;
  patientSex?: string;
  documentTitle: string;
  conceptCode?: { code: string; designator: string; meaning: string };
}

export interface EncapsulatedPdfResult {
  bytes: Uint8Array;
  sopInstanceUid: string;
  seriesInstanceUid: string;
}

const DEFAULT_CONCEPT = { code: '11528-7', designator: 'LN', meaning: 'Radiology Report' };

export function buildEncapsulatedPdf(input: EncapsulatedPdfInput): EncapsulatedPdfResult {
  const sopInstanceUid = generateUid();
  const seriesUid = generateUid();
  const studyUid = input.studyInstanceUid ?? generateUid();
  const contentDate = dicomDate();
  const contentTime = dicomTime();
  const concept = input.conceptCode ?? DEFAULT_CONCEPT;

  // PDF byte stream must be even-length for OB.
  let pdf = input.pdfBytes;
  if (pdf.length % 2 !== 0) {
    const padded = new Uint8Array(pdf.length + 1);
    padded.set(pdf, 0);
    pdf = padded;
  }

  const ds: DicomDataset = [
    // Patient
    { tag: '00100010', vr: 'PN', value: input.patientName ?? 'ANON' },
    { tag: '00100020', vr: 'LO', value: input.patientId ?? '' },
    { tag: '00100030', vr: 'DA', value: input.patientBirthDate ?? '' },
    { tag: '00100040', vr: 'CS', value: input.patientSex ?? '' },

    // Study
    { tag: '0020000d', vr: 'UI', value: studyUid },
    { tag: '00080020', vr: 'DA', value: contentDate },
    { tag: '00080030', vr: 'TM', value: contentTime },

    // Series
    { tag: '0020000e', vr: 'UI', value: seriesUid },
    { tag: '00080060', vr: 'CS', value: 'DOC' },
    { tag: '00200011', vr: 'IS', value: 9999 },
    { tag: '0008103e', vr: 'LO', value: input.documentTitle.slice(0, 64) },

    // Equipment
    { tag: '00080070', vr: 'LO', value: 'NeoDW' },
    { tag: '00081090', vr: 'LO', value: 'NeoDW Viewer' },

    // SOP Common
    { tag: '00080016', vr: 'UI', value: ENCAPSULATED_PDF_SOP_CLASS },
    { tag: '00080018', vr: 'UI', value: sopInstanceUid },
    { tag: '00080023', vr: 'DA', value: contentDate },
    { tag: '00080033', vr: 'TM', value: contentTime },

    // Encapsulated Document Module
    { tag: '00420010', vr: 'ST', value: input.documentTitle },
    { tag: '00420011', vr: 'OB', value: pdf },
    { tag: '00420012', vr: 'LO', value: 'application/pdf' },
    { tag: '0040a043', vr: 'SQ', value: [[
      { tag: '00080100', vr: 'SH', value: concept.code },
      { tag: '00080102', vr: 'SH', value: concept.designator },
      { tag: '00080104', vr: 'LO', value: concept.meaning },
    ]] },
    { tag: '00420013', vr: 'SQ', value: [] },
    { tag: '0040a073', vr: 'SQ', value: [] },
    { tag: '0040a075', vr: 'PN', value: 'NeoDW' },
    { tag: '0040a124', vr: 'UI', value: generateUid() },
    { tag: '0040a370', vr: 'SQ', value: [] },
    { tag: '00080023', vr: 'DA', value: contentDate },
    { tag: '00080033', vr: 'TM', value: contentTime },
  ];

  const bytes = buildPart10(ENCAPSULATED_PDF_SOP_CLASS, sopInstanceUid, ds);
  return { bytes, sopInstanceUid, seriesInstanceUid: seriesUid };
}

export function downloadEncapsulatedPdf(input: EncapsulatedPdfInput, filename = 'report.dcm'): EncapsulatedPdfResult {
  const r = buildEncapsulatedPdf(input);
  const blob = new Blob([r.bytes.buffer as ArrayBuffer], { type: 'application/dicom' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return r;
}
