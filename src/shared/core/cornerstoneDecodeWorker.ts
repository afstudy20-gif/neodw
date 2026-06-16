/// <reference lib="webworker" />

// Thin shim re-running Cornerstone's decode worker entrypoint inside a
// Vite-emitted worker chunk. Imported via `?worker` in cornerstone.ts so
// Vite produces a real worker URL valid in both dev and prod — the
// package's own `new Worker(new URL('./decodeImageFrameWorker.js',
// import.meta.url))` inside init() resolves to a path Vite never ships.
// Direct node_modules path bypasses the package's restrictive `exports`
// field (the file IS shipped, just not advertised via a subpath specifier).
import '../../../node_modules/@cornerstonejs/dicom-image-loader/dist/esm/decodeImageFrameWorker.js';
