import * as Comlink from 'comlink';
import { parseHeaderLogic, type ParsedHeader } from './parseHeaderLogic';
import type { ParseHeadersWorkerApi } from './parseHeadersWorker';

// 256 KB is enough for >99% of clinical DICOM headers; falls back to
// full-file read when the parser bails out (e.g. multi-frame with
// enormous private blocks before pixel data).
const HEADER_READ_BYTES = 256 * 1024;

const POOL_SIZE = Math.max(2, Math.min(navigator.hardwareConcurrency || 4, 8));
const workers: Worker[] = [];
const proxies: Array<Comlink.Remote<ParseHeadersWorkerApi>> = [];
let rrIndex = 0;
let isWorkerPoolHealthy = true;

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
 * Includes a timeout fallback to main-thread parsing if the Web Worker pool hangs.
 */
export async function parseFileHeader(file: File): Promise<ParsedFileHeader> {
  const slice = await readHeaderSlice(file);

  if (isWorkerPoolHealthy) {
    try {
      const proxy = getProxy();
      const sliceCopy = slice.slice();
      // Run with a 600ms timeout
      const result = await Promise.race([
        proxy.parseHeader(Comlink.transfer(sliceCopy, [sliceCopy.buffer])),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Worker parse timeout')), 600)
        ),
      ]);
      return { metadata: result.metadata, hasPart10Header: result.hasPart10Header };
    } catch (err) {
      console.warn('[DICOM] Web Worker parse failed or timed out. Falling back to main-thread parsing:', err);
      isWorkerPoolHealthy = false;
    }
  }

  // Fallback to main-thread parsing
  try {
    const result = parseHeaderLogic(slice);
    return { metadata: result.metadata, hasPart10Header: result.hasPart10Header };
  } catch {
    const full = await readFull(file);
    const result = parseHeaderLogic(full);
    return { metadata: result.metadata, hasPart10Header: result.hasPart10Header };
  }
}

// Re-export the parsed shape so loaders can type-import it without
// reaching into the worker module.
export type { ParsedHeader };
