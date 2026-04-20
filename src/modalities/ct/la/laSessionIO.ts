// Save/load LA segmentation state as JSON.
// Binary masks stored as run-length encoded Uint32 run lengths (base64).
// Two-pass encoder + streaming base64 avoid intermediate number[] (OOM on 500+ slice volumes).

export interface LASessionData {
  version: number;
  patientName?: string;
  studyDate?: string;
  volumeId: string;
  dims: [number, number, number];
  spacing: [number, number, number];
  origin: [number, number, number];
  minHU: number;
  maxHU: number;
  brushRadiusMm: number;
  seedWorld: number[] | null;
  mvPoints: number[][];
  aortaPoints: number[][];
  extraSeeds: number[][];
  voxelVolumeMm3: number | null;
  volumeCm3: number | null;
  voxelCount: number | null;
  maskRLE: { firstValue: 0 | 1; runs: string };
  excludeRLE: { firstValue: 0 | 1; runs: string } | null;
}

function bytesToB64(u8: Uint8Array): string {
  // Stream in 32 KiB chunks; avoid Array.from/spread on large typed arrays.
  const chunk = 0x8000;
  let bin = '';
  for (let i = 0; i < u8.length; i += chunk) {
    bin += String.fromCharCode.apply(
      null,
      u8.subarray(i, i + chunk) as unknown as number[]
    );
  }
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Count runs without allocating. mask of length N has at most N runs.
function countRuns(mask: Uint8Array): number {
  if (mask.length === 0) return 0;
  let n = 1;
  let cur = mask[0] ? 1 : 0;
  for (let i = 1; i < mask.length; i++) {
    const v = mask[i] ? 1 : 0;
    if (v !== cur) { n++; cur = v; }
  }
  return n;
}

export function encodeBinaryRLE(mask: Uint8Array): { firstValue: 0 | 1; runs: string } {
  if (mask.length === 0) return { firstValue: 0, runs: '' };
  const firstValue = (mask[0] ? 1 : 0) as 0 | 1;
  const runCount = countRuns(mask);
  const runs = new Uint32Array(runCount);
  let idx = 0;
  let run = 1;
  let cur: 0 | 1 = firstValue;
  for (let i = 1; i < mask.length; i++) {
    const v = (mask[i] ? 1 : 0) as 0 | 1;
    if (v === cur) {
      run++;
    } else {
      runs[idx++] = run;
      run = 1;
      cur = v;
    }
  }
  runs[idx] = run;
  const u8 = new Uint8Array(runs.buffer, runs.byteOffset, runs.byteLength);
  return { firstValue, runs: bytesToB64(u8) };
}

export function decodeBinaryRLE(
  firstValue: 0 | 1,
  b64: string,
  length: number
): Uint8Array {
  const out = new Uint8Array(length);
  if (!b64) return out;
  const raw = b64ToBytes(b64);
  const runCount = raw.byteLength >>> 2;
  // View directly on raw.buffer — avoid a second huge allocation.
  // raw.byteOffset is always 0 for arrays created via `new Uint8Array(n)`.
  const u32 = new Uint32Array(raw.buffer, raw.byteOffset, runCount);
  let pos = 0;
  let v: 0 | 1 = firstValue;
  for (let r = 0; r < u32.length; r++) {
    const n = u32[r];
    if (v === 1 && n > 0) out.fill(1, pos, pos + n);
    pos += n;
    v = (v === 1 ? 0 : 1) as 0 | 1;
  }
  return out;
}

export function sanitizeForFilename(s: string): string {
  return s
    .replace(/\^/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

export function buildSessionFilename(
  patientName?: string,
  studyDate?: string,
  prefix: string = 'LA'
): string {
  const p = sanitizeForFilename(patientName || 'Unknown');
  const d = sanitizeForFilename(studyDate || new Date().toISOString().slice(0, 10).replace(/-/g, ''));
  return `${prefix}_${p || 'Unknown'}_${d || 'nodate'}.json`;
}

export function downloadSessionJSON(data: LASessionData, filename: string): void {
  // Stream via Blob parts so the full string never exists twice.
  const parts: BlobPart[] = [JSON.stringify(data)];
  const blob = new Blob(parts, { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function readSessionJSON(file: File): Promise<LASessionData> {
  const text = await file.text();
  const parsed = JSON.parse(text) as LASessionData;
  if (typeof parsed.version !== 'number') throw new Error('Invalid session: missing version');
  if (!parsed.dims || parsed.dims.length !== 3) throw new Error('Invalid session: dims');
  if (!parsed.maskRLE) throw new Error('Invalid session: maskRLE');
  return parsed;
}
