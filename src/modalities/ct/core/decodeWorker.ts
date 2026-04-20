/// <reference lib="webworker" />
// Custom DICOM decode worker that Vite bundles correctly.
// Re-exports the same API as @cornerstonejs/dicom-image-loader's worker
// but goes through Vite's bundler so CJS codec imports get ESM-wrapped.

import { expose } from 'comlink';
import { decodeImageFrame } from '@cornerstonejs/dicom-image-loader';

const obj = {
  decodeTask({
    imageFrame,
    transferSyntax,
    decodeConfig,
    options,
    pixelData,
    callbackFn,
  }: {
    imageFrame: any;
    transferSyntax: string;
    decodeConfig: any;
    options: any;
    pixelData: Uint8Array;
    callbackFn?: (result: any) => void;
  }) {
    return decodeImageFrame(imageFrame, transferSyntax, pixelData, decodeConfig, options, callbackFn);
  },
};

expose(obj);
