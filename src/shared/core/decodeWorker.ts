/// <reference lib="webworker" />

import { expose } from 'comlink';
import { decodeImageFrame } from '@cornerstonejs/dicom-image-loader';

const workerApi = {
  decodeTask({
    imageFrame,
    transferSyntax,
    decodeConfig,
    options,
    pixelData,
    callbackFn,
  }: {
    imageFrame: unknown;
    transferSyntax: string;
    decodeConfig: unknown;
    options: unknown;
    pixelData: Uint8Array;
    callbackFn?: (result: unknown) => void;
  }) {
    return decodeImageFrame(
      imageFrame,
      transferSyntax,
      pixelData,
      decodeConfig,
      options,
      callbackFn
    );
  },
};

expose(workerApi);
