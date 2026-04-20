// Custom worker factory that creates the DICOM decode worker
// This is needed because Vite pre-bundles @cornerstonejs/dicom-image-loader
// which breaks the `new URL('./decodeImageFrameWorker.js', import.meta.url)` pattern.
// By creating the worker through Vite's worker import syntax, it gets bundled properly.

export function createDicomWorker() {
  return new Worker(
    new URL(
      '../../node_modules/@cornerstonejs/dicom-image-loader/dist/esm/decodeImageFrameWorker.js',
      import.meta.url
    ),
    { type: 'module' }
  );
}
