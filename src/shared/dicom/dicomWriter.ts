// Minimal DICOM Part-10 writer for Explicit VR Little Endian datasets.
// Used to build DICOM Segmentation Objects and Encapsulated PDF SOPs
// without pulling in dcmjs (~350 KB).
//
// Only encodes a curated subset of VRs needed for SEG + Encapsulated PDF.
// Group lengths are NOT emitted — most modern readers (Cornerstone, dcmjs,
// Orthanc, dcm4che) parse without them.

export type Vr =
  | 'AE' | 'AS' | 'AT' | 'CS' | 'DA' | 'DS' | 'DT' | 'FD' | 'FL' | 'IS'
  | 'LO' | 'LT' | 'OB' | 'OD' | 'OF' | 'OL' | 'OW' | 'PN' | 'SH' | 'SL'
  | 'SQ' | 'SS' | 'ST' | 'TM' | 'UI' | 'UL' | 'UN' | 'UR' | 'US' | 'UT';

// VRs whose length field is 32-bit (with 2-byte reserved padding) in
// Explicit VR encoding.
const LONG_LENGTH_VRS = new Set<Vr>([
  'OB', 'OD', 'OF', 'OL', 'OW', 'SQ', 'UC', 'UR', 'UT', 'UN',
] as Vr[]);

export interface DicomElement {
  tag: string; // "ggggeeee" hex, e.g. "00100010"
  vr: Vr;
  value: string | number | number[] | Uint8Array | Uint16Array | DicomDataset[];
}

export type DicomDataset = DicomElement[];

const ENCODER = new TextEncoder();

function tagToBytes(tagHex: string): Uint8Array {
  const group = Number.parseInt(tagHex.slice(0, 4), 16);
  const element = Number.parseInt(tagHex.slice(4, 8), 16);
  const b = new Uint8Array(4);
  b[0] = group & 0xff;
  b[1] = (group >> 8) & 0xff;
  b[2] = element & 0xff;
  b[3] = (element >> 8) & 0xff;
  return b;
}

function writeU16LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
}

function writeU32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
  buf[offset + 2] = (value >> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

function padEvenLength(b: Uint8Array, padByte = 0x00): Uint8Array {
  if (b.length % 2 === 0) return b;
  const out = new Uint8Array(b.length + 1);
  out.set(b, 0);
  out[b.length] = padByte;
  return out;
}

function encodeStringValue(value: string, vr: Vr): Uint8Array {
  // PN, DA, TM, DT, CS, SH, LO, ST, LT, UT, IS, DS, AS, AE, UI, UR
  // Use null byte padding for UI, space for others (DICOM PS3.5 § 6.2)
  const bytes = ENCODER.encode(value);
  const padByte = vr === 'UI' ? 0x00 : 0x20;
  return padEvenLength(bytes, padByte);
}

function encodeMultiValue(values: string[], vr: Vr): Uint8Array {
  // Multi-value strings joined with backslash.
  return encodeStringValue(values.join('\\'), vr);
}

function encodeNumberArray(value: number | number[], vr: Vr): Uint8Array {
  const arr = Array.isArray(value) ? value : [value];
  switch (vr) {
    case 'US': {
      const buf = new Uint8Array(arr.length * 2);
      for (let i = 0; i < arr.length; i += 1) writeU16LE(buf, i * 2, arr[i] & 0xffff);
      return buf;
    }
    case 'SS': {
      const buf = new Uint8Array(arr.length * 2);
      for (let i = 0; i < arr.length; i += 1) {
        const v = arr[i] < 0 ? arr[i] + 0x10000 : arr[i];
        writeU16LE(buf, i * 2, v & 0xffff);
      }
      return buf;
    }
    case 'UL': {
      const buf = new Uint8Array(arr.length * 4);
      for (let i = 0; i < arr.length; i += 1) writeU32LE(buf, i * 4, arr[i]);
      return buf;
    }
    case 'SL': {
      const buf = new Uint8Array(arr.length * 4);
      for (let i = 0; i < arr.length; i += 1) {
        const v = arr[i] < 0 ? arr[i] + 0x100000000 : arr[i];
        writeU32LE(buf, i * 4, v >>> 0);
      }
      return buf;
    }
    case 'FL': {
      const dv = new DataView(new ArrayBuffer(arr.length * 4));
      for (let i = 0; i < arr.length; i += 1) dv.setFloat32(i * 4, arr[i], true);
      return new Uint8Array(dv.buffer);
    }
    case 'FD': {
      const dv = new DataView(new ArrayBuffer(arr.length * 8));
      for (let i = 0; i < arr.length; i += 1) dv.setFloat64(i * 8, arr[i], true);
      return new Uint8Array(dv.buffer);
    }
    case 'IS':
    case 'DS': {
      return encodeMultiValue(arr.map((n) => String(n)), vr);
    }
    default:
      throw new Error(`Unsupported numeric VR: ${vr}`);
  }
}

function encodeElementValue(el: DicomElement): Uint8Array {
  if (el.vr === 'SQ') {
    const items = el.value as DicomDataset[];
    const parts: Uint8Array[] = [];
    for (const item of items) {
      const itemBytes = encodeDataset(item);
      // Item tag (FFFE,E000) + length (UL, 32-bit)
      const header = new Uint8Array(8);
      header.set([0xfe, 0xff, 0x00, 0xe0]); // (FFFE,E000)
      writeU32LE(header, 4, itemBytes.length);
      parts.push(header, itemBytes);
    }
    return concat(parts);
  }
  if (el.vr === 'OB' || el.vr === 'UN') {
    const v = el.value;
    if (v instanceof Uint8Array) return padEvenLength(v);
    if (typeof v === 'string') return padEvenLength(ENCODER.encode(v));
    if (Array.isArray(v)) return padEvenLength(new Uint8Array(v as number[]));
    throw new Error('OB/UN requires Uint8Array');
  }
  if (el.vr === 'OW') {
    const v = el.value;
    if (v instanceof Uint16Array) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    if (v instanceof Uint8Array) return padEvenLength(v);
    throw new Error('OW requires Uint16Array');
  }
  if (typeof el.value === 'string') {
    return encodeStringValue(el.value, el.vr);
  }
  if (typeof el.value === 'number' || Array.isArray(el.value) && typeof el.value[0] === 'number') {
    return encodeNumberArray(el.value as number | number[], el.vr);
  }
  if (Array.isArray(el.value) && el.value.length === 0) {
    return new Uint8Array(0);
  }
  if (typeof el.value === 'string') {
    return encodeStringValue(el.value, el.vr);
  }
  throw new Error(`Unsupported value for VR ${el.vr}`);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function encodeElement(el: DicomElement): Uint8Array {
  const tag = tagToBytes(el.tag);
  const value = encodeElementValue(el);
  const vrBytes = ENCODER.encode(el.vr);
  const isLong = LONG_LENGTH_VRS.has(el.vr);

  if (isLong) {
    // tag (4) + VR (2) + reserved (2) + length (4) + value
    const header = new Uint8Array(12);
    header.set(tag, 0);
    header.set(vrBytes, 4);
    // bytes 6-7 reserved = 0
    writeU32LE(header, 8, value.length);
    return concat([header, value]);
  }
  // tag (4) + VR (2) + length (2) + value
  const header = new Uint8Array(8);
  header.set(tag, 0);
  header.set(vrBytes, 4);
  writeU16LE(header, 6, value.length);
  return concat([header, value]);
}

export function encodeDataset(dataset: DicomDataset): Uint8Array {
  // Sort by tag to satisfy DICOM PS3.5 § 7.2 ordering rules.
  const sorted = [...dataset].sort((a, b) => a.tag.localeCompare(b.tag));
  return concat(sorted.map(encodeElement));
}

// Build a Part-10 file: 128-byte preamble + "DICM" + File Meta Info group + dataset.
export function buildPart10(
  sopClassUid: string,
  sopInstanceUid: string,
  dataset: DicomDataset,
  transferSyntaxUid = '1.2.840.10008.1.2.1' // Explicit VR Little Endian
): Uint8Array {
  const meta: DicomDataset = [
    { tag: '00020001', vr: 'OB', value: new Uint8Array([0x00, 0x01]) },
    { tag: '00020002', vr: 'UI', value: sopClassUid },
    { tag: '00020003', vr: 'UI', value: sopInstanceUid },
    { tag: '00020010', vr: 'UI', value: transferSyntaxUid },
    { tag: '00020012', vr: 'UI', value: '1.2.826.0.1.3680043.10.1338.1' }, // implementation class UID
    { tag: '00020013', vr: 'SH', value: 'NEODW_1.0' },
    { tag: '00020016', vr: 'AE', value: 'NEODW' },
  ];
  const metaBytes = encodeDataset(meta);

  // Insert group length (0002,0000) at top of meta.
  const groupLengthEl: DicomElement = {
    tag: '00020000',
    vr: 'UL',
    value: metaBytes.length,
  };
  const metaWithGroupLen = concat([encodeElement(groupLengthEl), metaBytes]);

  const datasetBytes = encodeDataset(dataset);

  const preamble = new Uint8Array(128);
  const dicm = ENCODER.encode('DICM');

  return concat([preamble, dicm, metaWithGroupLen, datasetBytes]);
}

// ── UID generation ────────────────────────────────────────────────────────
// Root: 2.25.<128-bit-random> per RFC 4122 / DICOM PS3.5 § B.2.
const UID_ROOT = '2.25.';

function rand128(): bigint {
  // Combine 16 random bytes into a 128-bit big-endian integer.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let v = 0n;
  for (let i = 0; i < 16; i += 1) {
    v = (v << 8n) | BigInt(bytes[i]);
  }
  return v;
}

export function generateUid(): string {
  const v = rand128();
  return `${UID_ROOT}${v.toString()}`;
}

// ── Date/time helpers ─────────────────────────────────────────────────────

export function dicomDate(date = new Date()): string {
  const y = date.getFullYear().toString().padStart(4, '0');
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  return `${y}${m}${d}`;
}

export function dicomTime(date = new Date()): string {
  const h = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  const s = date.getSeconds().toString().padStart(2, '0');
  return `${h}${m}${s}`;
}

// Pack a Uint8Array of {0,1} mask values into bit-packed Uint8Array
// (little-endian within byte, bit 0 = first sample). Used for SEG BINARY pixel data.
export function packBits(mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(mask.length / 8));
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i]) {
      out[i >> 3] |= 1 << (i & 7);
    }
  }
  return out;
}
