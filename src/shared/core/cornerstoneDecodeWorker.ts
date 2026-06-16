/// <reference lib="webworker" />

// Thin shim re-running Cornerstone's decode worker entrypoint inside a
// Vite-emitted worker chunk. Imported via `?worker` in cornerstone.ts so
// Vite produces a real worker URL valid in both dev and prod — the
// package's own `new Worker(new URL('./decodeImageFrameWorker.js',
// import.meta.url))` inside init() resolves to a path Vite never ships.
//
// The import specifier is a private alias defined in vite.config.ts that
// maps to the actual file inside node_modules — needed because the
// package's `exports` field does not advertise the worker entry, so neither
// a bare specifier nor a relative node_modules path resolves through Vite's
// `?worker` sub-rollup. The alias bypasses package-exports enforcement.
import '@cornerstonejs/dicom-image-loader/__decodeImageFrameWorker';
