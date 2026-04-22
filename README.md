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
npm run dev        # http://localhost:5180
npm run build      # production bundle
npm run preview    # serve build locally
```

Cross-Origin-Embedder-Policy and Cross-Origin-Opener-Policy headers are required for `SharedArrayBuffer` (volume rendering). See `nginx.conf`, `netlify.toml`, `vercel.json` for deployment configs.

## Disclaimer

Research scaffold. Not a medical device. Not for clinical decision-making. No regulatory clearance (FDA / CE / etc.). All measurements are advisory.
