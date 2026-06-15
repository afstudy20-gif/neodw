// Unified file intake: expands ZIP/RAR archives, detects DICOM files regardless of extension.
// Used by all modality loaders so users can drop .zip, .rar, or raw DICOM with any/no extension.

import JSZip from 'jszip';

const DICOM_MAGIC = [0x44, 0x49, 0x43, 0x4d]; // "DICM" at byte offset 128

// Check DICOM Part-10 magic "DICM" at offset 128.
export async function isDicomByMagic(file: File | Blob): Promise<boolean> {
  if (file.size < 132) return false;
  try {
    const buf = new Uint8Array(await file.slice(0, 132).arrayBuffer());
    for (let i = 0; i < 4; i++) {
      if (buf[128 + i] !== DICOM_MAGIC[i]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Heuristic for Part-10-less DICOM (implicit VR, little endian, no preamble).
// Scan first 1024 bytes for a plausible tag pattern (group 0x0002, 0x0008, or 0x7fe0).
export async function looksLikeImplicitDicom(file: File | Blob): Promise<boolean> {
  if (file.size < 128) return false;
  try {
    const buf = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
    // Implicit VR: first 4 bytes = tag (group, element), next 4 = length
    // Common first tags: (0002,0000), (0008,0000), (0008,0005), (0008,0008), (0008,0016)...
    const group = buf[0] | (buf[1] << 8);
    const element = buf[2] | (buf[3] << 8);
    if ((group === 0x0002 || group === 0x0008 || group === 0x0010) && element < 0x1000) {
      return true;
    }
  } catch {}
  return false;
}

function cloneFile(name: string, data: Uint8Array, lastModified = Date.now()): File {
  return new File([data as any], name, { type: 'application/dicom', lastModified });
}

async function extractZip(file: File): Promise<File[]> {
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files);

  // Parallelize entry decompression. JSZip's `entry.async()` is internally
  // async and concurrency-friendly; the previous sequential `for/await` made
  // a 2200-file CD export take an order of magnitude longer than necessary.
  const decoded = await Promise.all(
    names.map(async (name) => {
      const entry = zip.files[name];
      if (entry.dir) return null;
      if (name.startsWith('__MACOSX/') || name.endsWith('/.DS_Store') || name.endsWith('Thumbs.db')) {
        return null;
      }
      try {
        const data = await entry.async('uint8array');
        const base = name.split('/').pop() || name;
        return cloneFile(base, data, entry.date?.getTime());
      } catch (e) {
        console.warn('[intake] zip entry failed', name, e);
        return null;
      }
    })
  );

  return decoded.filter((f): f is File => f != null);
}

// Store the init promise (not a bool flag) so two concurrent extractRar
// calls share one init pass. Prior `if (!flag) { init(); flag = true; }`
// raced when both calls passed the check before either flipped the flag,
// potentially calling Archive.init() twice and double-registering the
// WASM worker.
let libarchiveInitPromise: Promise<void> | null = null;
async function extractRar(file: File): Promise<File[]> {
  try {
    const mod: any = await import('libarchive.js');
    const Archive = mod.Archive ?? mod.default?.Archive ?? mod.default;
    if (!libarchiveInitPromise && Archive?.init) {
      libarchiveInitPromise = Promise.resolve(
        Archive.init({
          workerUrl: new URL('libarchive.js/dist/worker-bundle.js', import.meta.url).toString(),
        })
      );
    }
    if (libarchiveInitPromise) {
      await libarchiveInitPromise;
    }
    const archive = await Archive.open(file);
    const entries = await archive.getFilesArray();
    const out: File[] = [];
    for (const entry of entries) {
      try {
        const extracted = await entry.file.extract();
        if (extracted instanceof File) {
          out.push(extracted);
        } else {
          const data = await extracted.arrayBuffer();
          out.push(cloneFile(entry.file.name, new Uint8Array(data)));
        }
      } catch (e) {
        console.warn('[intake] rar entry failed', entry.file?.name, e);
      }
    }
    return out;
  } catch (e) {
    console.warn('[intake] rar extraction failed', e);
    return [];
  }
}

export function isArchiveName(name: string): 'zip' | 'rar' | 'tar' | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.rar')) return 'rar';
  if (lower.endsWith('.tar') || lower.endsWith('.tgz') || lower.endsWith('.tar.gz') || lower.endsWith('.7z')) return 'tar';
  return null;
}

// Raster images we can decode via the browser canvas and wrap as Secondary
// Capture DICOM (animated GIF / multi-page TIFF are intentionally excluded).
function isRasterImageName(name: string): boolean {
  return /\.(jpe?g|png|bmp|webp)$/i.test(name);
}

// Sniff JPEG (FF D8 FF) / PNG (89 50 4E 47) magic regardless of extension.
async function sniffRasterImage(file: File): Promise<boolean> {
  if (file.size < 4) return false;
  try {
    const b = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true; // JPEG
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true; // PNG
  } catch { /* ignore */ }
  return false;
}

// Convert a raster image File to a Secondary Capture DICOM File (best-effort).
async function convertImageToDicom(file: File): Promise<File | null> {
  try {
    const { jpegFileToDicom } = await import('./dicom/jpegToDicom');
    const bytes = await jpegFileToDicom(file, {
      seriesDescription: `Imported: ${file.name}`,
    });
    const base = (file.name.split('/').pop() || file.name).replace(/\.[^.]+$/, '');
    return new File([bytes as BlobPart], `${base}.dcm`, { type: 'application/dicom' });
  } catch (e) {
    console.warn('[intake] image→DICOM conversion failed', file.name, e);
    return null;
  }
}

// Sniff first 4 bytes to detect archive regardless of extension.
export async function sniffArchive(file: File): Promise<'zip' | 'rar' | null> {
  if (file.size < 8) return null;
  try {
    const buf = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    // ZIP: 50 4B 03 04
    if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05) && (buf[3] === 0x04 || buf[3] === 0x06)) {
      return 'zip';
    }
    // RAR v1.5: 52 61 72 21 1A 07 00 ; RAR v5: 52 61 72 21 1A 07 01 00
    if (buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21) {
      return 'rar';
    }
  } catch {}
  return null;
}

/**
 * Expand archives and filter files to DICOM-like content.
 * - Unpacks .zip files (and files that are ZIP by content).
 * - Tries .rar via libarchive.js (WASM, best-effort).
 * - Includes files with DICOM Part-10 magic OR implicit-VR heuristic, regardless of extension.
 * - Includes files already matching *.dcm / *.dicom / *.ima extensions.
 */
export async function expandAndFilterDicom(files: File[]): Promise<File[]> {
  const expanded: File[] = [];
  for (const f of files) {
    const byName = isArchiveName(f.name);
    const byContent = byName ?? (await sniffArchive(f));
    if (byContent === 'zip') {
      try {
        const entries = await extractZip(f);
        expanded.push(...entries);
      } catch (e) {
        console.warn('[intake] zip extract failed', f.name, e);
      }
      continue;
    }
    if (byContent === 'rar') {
      const entries = await extractRar(f);
      if (entries.length > 0) {
        expanded.push(...entries);
      } else {
        console.warn('[intake] rar extraction returned no entries — libarchive.js may be unavailable');
      }
      continue;
    }
    if (byName === 'tar') {
      console.warn('[intake] tar/tgz/7z not supported yet, skipping', f.name);
      continue;
    }
    expanded.push(f);
  }

  // Filter: exclude obvious non-DICOM junk; everything else falls through
  // to the per-modality dicom-parser which has its own try/catch, so a
  // stray garbage file is only a per-file parse warning. Being permissive
  // here matters because many PACS/CD exports drop files without any
  // extension and without a Part-10 preamble (implicit VR), and the
  // heuristic can miss when a private tag sits at offset 0.
  // jpeg/png/bmp/webp are NOT junk — converted to Secondary Capture DICOM below.
  const JUNK_EXT = /\.(gif|tiff?|pdf|txt|rtf|doc|docx|xls|xlsx|ppt|pptx|xml|json|html?|css|js|ts|zip|rar|7z|tgz|tar|gz|bz2|mp3|mp4|mov|avi|wmv|mkv|webm|exe|bat|sh|app|msi|log)$/i;
  const out: File[] = [];
  for (const f of expanded) {
    const lower = f.name.toLowerCase();
    // Skip DICOMDIR — not a single image, would confuse loader
    if (lower === 'dicomdir' || lower.endsWith('/dicomdir')) continue;
    // Skip hidden / system files
    const base = lower.split('/').pop() || lower;
    if (base.startsWith('.') || base === 'thumbs.db') continue;
    // Raster images → wrap as Secondary Capture DICOM so they load like any series.
    if (isRasterImageName(base) || (await sniffRasterImage(f))) {
      const converted = await convertImageToDicom(f);
      if (converted) out.push(converted);
      continue;
    }
    // Skip known non-DICOM extensions
    if (JUNK_EXT.test(base)) continue;
    // Skip tiny files that can't possibly be DICOM (< 256 bytes)
    if (f.size < 256) continue;
    out.push(f);
  }
  return out;
}
