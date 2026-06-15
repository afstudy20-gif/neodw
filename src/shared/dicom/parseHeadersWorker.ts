/// <reference lib="webworker" />

// Web Worker entry that runs dicom-parser off the main thread. The pure
// parsing logic lives in `./parseHeaderLogic` so the main thread can also
// fall back to it WITHOUT pulling this file's top-level `expose(api)`
// side effect (which would otherwise install a stray `message` listener
// on `window` and confuse Vite's worker chunk pipeline).

import { expose } from 'comlink';
import { parseHeaderLogic, type ParsedHeader } from './parseHeaderLogic';

const api = {
  parseHeader(bytes: Uint8Array): ParsedHeader {
    return parseHeaderLogic(bytes);
  },
};

export type ParseHeadersWorkerApi = typeof api;

expose(api);
