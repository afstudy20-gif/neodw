# NeoDW

Browser-based DICOM workstation. Runs entirely client-side. No server upload, no PHI leaves the tab.

**Live:** https://neodw.drtr.uk/

## Modalities

| Modality | Capabilities |
|---|---|
| **Coronary CTA** | MPR (axial/sagittal/coronal), crosshairs, centerline picking, stretched view, auto stenosis detection, CT-FFR (research), CAC scoring, Auto Coronary (beta: aorta detection + ostium-anchored vessel tracing) |
| **CT** | General CT MPR, 3D volume rendering, TAVI workflow, Left Atrium / LAA / Aorta / LV-ADAS segmentation modules, Hand MR module |
| **Angio (XA)** | Multi-frame cine playback, QCA measurements, W/L presets, series transport |
| **Echo** | Ultrasound cine (including GE Vivid private reverse-engineered decoder), Doppler region parsing, calibration-aware length tool |

## Features

- **Fully local processing** — DICOM files parsed in-browser (`dicom-parser` + `cornerstonejs`). Nothing uploaded.
- **Parallel file parsing** — bounded-concurrency I/O pool scaled to `navigator.hardwareConcurrency`.
- **Volume dedup** — phase separation by AcquisitionTime / AcquisitionNumber, uniform-spacing filter for clean MPR on multi-phase/step-and-shoot CCTA.
- **Cine transport** — play/pause, FPS control, PNG snapshot, WebM video export, DICOM series export.
- **Auto Coronary pipeline** — ascending aorta tracking via axial blob detection → root identification → HU-gradient vessel tracing from ostia.
- **Theme-aware UI** — light/dark modes via `color-mix(oklch)` tokens.
- **i18n** — English / Turkish.

## Tech Stack

- React 18 + TypeScript + Vite
- [Cornerstone3D](https://www.cornerstonejs.org/) for volume rendering and tools
- [dicom-parser](https://github.com/cornerstonejs/dicomParser) + `@cornerstonejs/dicom-image-loader`
- VTK.js (via Cornerstone) for 3D volume visualization

## Development

```bash
npm install
npm run dev        # http://127.0.0.1:5180
npm run typecheck  # TypeScript only
npm run test       # unit tests (vitest)
npm run build      # typecheck + production bundle
npm run preview    # serve build locally
```

### Cross-origin isolation

`SharedArrayBuffer` (faster multi-threaded WASM in Cornerstone) needs a cross-origin isolated page (`Cross-Origin-Opener-Policy: same-origin` plus a `Cross-Origin-Embedder-Policy`).

| Environment | COOP / COEP | Effect |
|---|---|---|
| **Vite dev** (`vite.config.ts`) | `same-origin` + `require-corp` | Full `SharedArrayBuffer`; best for local volume debugging |
| **Production** (`nginx.conf`, Netlify, Vercel) | **Not set** | Single-threaded WASM fallback; avoids breaking third-party embeds on the welcome page |

Production configs intentionally omit COOP/COEP — see the comment in `nginx.conf`. Volume rendering still works via the fallback path. If you later need SAB in production, prefer `Cross-Origin-Embedder-Policy: credentialless` and self-host fonts instead of `require-corp`.

### Debugging DICOM files

When a user reports a file NeoDW won't load, [`scripts/dcm-debug.sh`](scripts/dcm-debug.sh) runs the dcm4che CLI utilities (`dcmdump` + `dcmvalidate` + `dcm2dcm`) to dump the header, validate against the IOD, and re-encode to Explicit-VR Little-Endian. If the re-encoded file loads but the original doesn't, the bug is in the codec / pixel decode path — not the parser.

Install dcm4che (Java 17+ required) from https://sourceforge.net/projects/dcm4che/files/dcm4che3/ and add its `bin/` directory to `PATH`. Usage:

```bash
./scripts/dcm-debug.sh path/to/problem.dcm
```

## Disclaimer

Research scaffold. Not a medical device. Not for clinical decision-making. No regulatory clearance (FDA / CE / etc.). All measurements are advisory.
