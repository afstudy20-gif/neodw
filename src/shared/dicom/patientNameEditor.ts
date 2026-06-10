import dicomParser from 'dicom-parser';
import JSZip from 'jszip';

/**
 * In-place PatientName (0010,0010) byte patcher.
 *
 * Strategy: parse the file with dicom-parser to locate the element's
 * dataOffset and length, build a new buffer with the value replaced,
 * and rewrite the length field. Works for both Explicit-VR and
 * Implicit-VR datasets because dicom-parser sets `element.vr` only on
 * explicit encodings.
 *
 * Length change handling: if the new value is longer or shorter than
 * the original, every absolute byte offset after PatientName shifts.
 * That's fine for any consumer that re-parses sequentially (browser
 * viewers, dcm4che CLI, Cornerstone). It would break tools that cache
 * pre-computed absolute offsets — none of which apply here.
 *
 * We deliberately avoid pulling in dcmjs (~300 kB) since this single
 * tag patch is the whole feature scope.
 */

export interface PatchResult {
  patched: File;
  originalName: string;
  newName: string;
}

function writeU16LE(buf: Uint8Array, off: number, val: number): void {
  buf[off] = val & 0xff;
  buf[off + 1] = (val >>> 8) & 0xff;
}

function writeU32LE(buf: Uint8Array, off: number, val: number): void {
  buf[off] = val & 0xff;
  buf[off + 1] = (val >>> 8) & 0xff;
  buf[off + 2] = (val >>> 16) & 0xff;
  buf[off + 3] = (val >>> 24) & 0xff;
}

function readCurrentPatientName(dataSet: dicomParser.DataSet): string {
  try {
    return (dataSet.string('x00100010') ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * Patch the PatientName tag in a single DICOM file.
 * Throws if the file isn't valid DICOM or the tag isn't present.
 */
export async function patchPatientName(
  file: File,
  newName: string
): Promise<PatchResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const dataSet = dicomParser.parseDicom(bytes);

  const el = dataSet.elements['x00100010'];
  if (!el) {
    throw new Error(`${file.name}: PatientName tag (0010,0010) not found`);
  }
  if (el.dataOffset == null) {
    throw new Error(`${file.name}: PatientName has no data offset`);
  }

  const originalName = readCurrentPatientName(dataSet);

  // DICOM PN VR limits: 64 chars per component; we ignore the component
  // limit and only enforce the byte-length cap for the short-form length
  // field (Explicit VR PN uses a 16-bit length).
  let encoded = new TextEncoder().encode(newName);
  if (encoded.length % 2 === 1) {
    const padded = new Uint8Array(encoded.length + 1);
    padded.set(encoded);
    padded[encoded.length] = 0x20; // space pad to even length
    encoded = padded;
  }

  const isExplicit = !!el.vr;
  // Explicit VR (short form): 4-byte tag + 2-byte VR + 2-byte length.
  // Implicit VR: 4-byte tag + 4-byte length.
  const lengthFieldOffset = isExplicit ? el.dataOffset - 2 : el.dataOffset - 4;

  if (isExplicit && encoded.length > 0xfffe) {
    throw new Error(
      `${file.name}: new PatientName is ${encoded.length} bytes — max 65534 for Explicit-VR PN`
    );
  }

  const before = bytes.subarray(0, el.dataOffset);
  const after = bytes.subarray(el.dataOffset + el.length);
  const out = new Uint8Array(before.length + encoded.length + after.length);
  out.set(before, 0);
  out.set(encoded, before.length);
  out.set(after, before.length + encoded.length);

  if (isExplicit) {
    writeU16LE(out, lengthFieldOffset, encoded.length);
  } else {
    writeU32LE(out, lengthFieldOffset, encoded.length);
  }

  const patched = new File([out], file.name, { type: file.type || 'application/dicom' });
  return { patched, originalName, newName };
}

/**
 * Patch every file in `files`, zip them, and trigger a browser download.
 * Files that fail to patch (non-DICOM, missing tag) are included unchanged
 * so the user doesn't lose the source set; the failure count is reported.
 */
export async function patchAndDownloadZip(
  files: File[],
  newName: string,
  zipName: string,
  onProgress?: (current: number, total: number) => void
): Promise<{ patched: number; failed: number; firstOriginal: string | null }> {
  const zip = new JSZip();
  let patched = 0;
  let failed = 0;
  let firstOriginal: string | null = null;

  for (let i = 0; i < files.length; i += 1) {
    onProgress?.(i, files.length);
    const file = files[i];
    try {
      const result = await patchPatientName(file, newName);
      if (firstOriginal === null && result.originalName) {
        firstOriginal = result.originalName;
      }
      zip.file(file.name, await result.patched.arrayBuffer());
      patched += 1;
    } catch (err) {
      console.warn(`[patient-name] skipping ${file.name}:`, err);
      // Include the unmodified original so the output set is still complete.
      zip.file(file.name, await file.arrayBuffer());
      failed += 1;
    }
  }
  onProgress?.(files.length, files.length);

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = zipName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);

  return { patched, failed, firstOriginal };
}

/**
 * Read the PatientName of the first file in the list — used to seed the
 * editor's input field so the user sees the current value.
 */
export async function readFirstPatientName(files: File[]): Promise<string> {
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const dataSet = dicomParser.parseDicom(bytes);
      const name = readCurrentPatientName(dataSet);
      if (name) return name;
    } catch {
      continue;
    }
  }
  return '';
}
