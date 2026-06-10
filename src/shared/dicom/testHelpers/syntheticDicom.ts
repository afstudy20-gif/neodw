// Synthetic DICOM builders for unit tests.
//
// We deliberately generate tiny in-memory Part 10 files rather than ship
// binary .dcm fixtures: no PHI to anonymize, fully deterministic, and the
// exact byte layout is reviewable in source. Only what the parser needs is
// emitted (preamble + DICM + File Meta group + a small Explicit-VR-LE
// dataset), which is enough to exercise tag-level logic such as the
// PatientName patcher.
//
// NOTE: this file lives under a `testHelpers/` directory and is imported
// only from *.test.ts, so it is tree-shaken out of the production bundle.

const EXPLICIT_VR_LE_UID = '1.2.840.10008.1.2.1';

function evenPad(bytes: Uint8Array, pad: number): Uint8Array {
  if (bytes.length % 2 === 0) return bytes;
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  out[bytes.length] = pad;
  return out;
}

// Encode one Explicit-VR Little Endian element using the short-length form
// (2-byte length), valid for VRs like UI, PN, SH, CS, etc.
function explicitShortElement(group: number, element: number, vr: string, value: Uint8Array): Uint8Array {
  const padded = evenPad(value, vr === 'UI' ? 0x00 : 0x20);
  const out = new Uint8Array(8 + padded.length);
  out[0] = group & 0xff;
  out[1] = (group >> 8) & 0xff;
  out[2] = element & 0xff;
  out[3] = (element >> 8) & 0xff;
  out[4] = vr.charCodeAt(0);
  out[5] = vr.charCodeAt(1);
  out[6] = padded.length & 0xff;
  out[7] = (padded.length >> 8) & 0xff;
  out.set(padded, 8);
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Build a minimal, valid Explicit-VR Little Endian DICOM Part 10 file
 * containing a PatientName (0010,0010) element. dicom-parser parses this
 * into a dataset with `elements['x00100010']` carrying a `vr` of 'PN'.
 */
export function buildMinimalDicom(patientName: string): Uint8Array {
  const enc = new TextEncoder();

  // --- File Meta group (always Explicit VR LE) ---
  const tsElement = explicitShortElement(0x0002, 0x0010, 'UI', enc.encode(EXPLICIT_VR_LE_UID));
  // (0002,0000) UL group length = byte count of all meta elements that follow.
  const groupLength = tsElement.length;
  const groupLenElement = new Uint8Array([
    0x02, 0x00, 0x00, 0x00, // tag (0002,0000)
    0x55, 0x4c, // VR "UL"
    0x04, 0x00, // length = 4
    groupLength & 0xff,
    (groupLength >> 8) & 0xff,
    (groupLength >> 16) & 0xff,
    (groupLength >> 24) & 0xff,
  ]);

  // --- Dataset (Explicit VR LE) ---
  const patientNameElement = explicitShortElement(0x0010, 0x0010, 'PN', enc.encode(patientName));

  const preamble = new Uint8Array(128); // zeros
  const dicm = enc.encode('DICM');

  return concat([preamble, dicm, groupLenElement, tsElement, patientNameElement]);
}

/**
 * Wrap the synthetic bytes in a File, mirroring what the intake pipeline
 * hands to patchPatientName.
 */
export function buildMinimalDicomFile(patientName: string, fileName = 'synthetic.dcm'): File {
  const bytes = buildMinimalDicom(patientName);
  // Cast through BlobPart — the lib.dom File constructor demands a fixed
  // ArrayBuffer rather than ArrayBufferLike, but Uint8Array<ArrayBufferLike>
  // is safe to pass at runtime. Project-wide convention (see fileIntake.ts).
  return new File([bytes as BlobPart], fileName, { type: 'application/dicom' });
}
