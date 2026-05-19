// Main-thread façade for the DICOM header parse worker pool.
//
// Each modality loader used to:
//   (1) read the WHOLE file into RAM via `file.arrayBuffer()`
//   (2) call dicom-parser on the main thread to extract metadata
//   (3) call `dataSet.string(tag)` 22 times
//
// On a 2200-slice study that's ~1.15 GB of transient RAM and 10-30 s
// of main-thread blocking. We now:
//   (1) read only the first 256 KB (header always fits well within),
//       falling back to full read on the rare case the parser needs more
//   (2) dispatch parsing to a pool of Web Workers
//   (3) the worker returns a flat Record<string,string> with every tag
//       any modality needs — a single source of truth

import * as Comlink from 'comlink';
import type { ParseHeadersWorkerApi, ParsedHeader } from './parseHeadersWorker';

// 256 KB is enough for >99% of clinical DICOM headers; falls back to
// full-file read when the parser bails out (e.g. multi-frame with
// enormous private blocks before pixel data).
const HEADER_READ_BYTES = 256 * 1024;

const POOL_SIZE = Math.max(2, Math.min(navigator.hardwareConcurrency || 4, 8));
const workers: Worker[] = [];
const proxies: Array<Comlink.Remote<ParseHeadersWorkerApi>> = [];
let rrIndex = 0;

function getProxy(): Comlink.Remote<ParseHeadersWorkerApi> {
  if (proxies.length < POOL_SIZE) {
    const w = new Worker(new URL('./parseHeadersWorker.ts', import.meta.url), {
      type: 'module',
      name: `dicom-parse-${proxies.length}`,
    });
    workers.push(w);
    proxies.push(Comlink.wrap<ParseHeadersWorkerApi>(w));
  }
  const proxy = proxies[rrIndex % proxies.length];
  rrIndex = (rrIndex + 1) % POOL_SIZE;
  return proxy;
}

async function readHeaderSlice(file: File): Promise<Uint8Array> {
  const cap = Math.min(file.size, HEADER_READ_BYTES);
  return new Uint8Array(await file.slice(0, cap).arrayBuffer());
}

async function readFull(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

export interface ParsedFileHeader {
  metadata: Record<string, string>;
  hasPart10Header: boolean;
}

/**
 * Read a header-sized slice of `file`, parse off the main thread,
 * return the metadata record. Falls back to a full-file read +
 * re-parse if the slice was too small for the parser to finish.
 */
export async function parseFileHeader(file: File): Promise<ParsedFileHeader> {
  const proxy = getProxy();

  // Phase A — header slice
  const slice = await readHeaderSlice(file);
  try {
    const result = await proxy.parseHeader(
      Comlink.transfer(slice, [slice.buffer])
    );
    return { metadata: result.metadata, hasPart10Header: result.hasPart10Header };
  } catch {
    // Header overflowed our 256 KB slice. Read the whole file and retry.
    const full = await readFull(file);
    const result = await proxy.parseHeader(
      Comlink.transfer(full, [full.buffer])
    );
    return { metadata: result.metadata, hasPart10Header: result.hasPart10Header };
  }
}

// Re-export the parsed shape so loaders can type-import it without
// reaching into the worker module.
export type { ParsedHeader };
