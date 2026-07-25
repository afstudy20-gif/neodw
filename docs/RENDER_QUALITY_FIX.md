# 3D Volume Render Quality — Fix Plan

**Status:** Draft / investigation complete
**Date:** 2026-07-13
**Symptom:** The CT `volume3d` render (the KaloLumen-style VRT panel) looks blocky / voxelated / low-resolution, not the smooth surface KaloLumen shows.

---

## Root cause — PROVEN LIVE (not static analysis)

Measured directly in the running app (real 990-slice contrast CT loaded, 3D mode entered) via the VTK mapper/canvas:

```
volume3d canvas: backing store = 300 × 150 px,  CSS size = 1280 × 583 px
```

The 3D canvas's **drawing buffer is 300×150** — the browser's *default* `<canvas>` size — stretched ~4.3× to fill 1280×583 CSS pixels. That upscale is the blockiness.

**Confirmation experiment (decisive):** setting the canvas backing store to its container size and re-rendering — **changing nothing else** (no interpolation, sample-distance, or preset change) — turned the render from blocky to sharp (visible ribs, vertebrae, sternum, contrast lumen). Reverting proves the dependency.

```js
// exactly what the app's resizeViewports() already calls:
engine.resize(true, false)   // 300×150 → 744×643 backing → SHARP
```

So the app already has the right call; it just runs at the wrong time.

### Why the canvas is stuck at 300×150

`resizeViewports()` (`src/modalities/ct/CtApp.tsx:695`) resizes on a **fixed `setTimeout(…, 150)`** (`CtApp.tsx:697`) then `engine.resize(true, false)` (`:700`). On entering 3D mode (`CtApp.tsx:1000` `setViewportMode('volume-3d')` → `resizeViewports()` at `:1003`), the 150 ms fires **before** the `.main-content--volume-3d` / `ViewportGrid` flex layout has given the `#viewport-3d` cell its final size. `engine.resize` therefore sizes the 3D canvas against a not-yet-laid-out (default/tiny) element, and **nothing re-fires a resize afterward** — so it stays 300×150 for the whole session.

It is a pure **timing race against layout**, not a DPR/texture/interpolation problem. A static read of the code (which "rules out" canvas resolution because `engine.resize` *looks* correct) misses it — only the runtime measurement exposes it.

### Same latent race elsewhere

The identical fixed-`setTimeout`-then-`engine.resize` pattern is used for:
- TAVI mode entry — `CtApp.tsx:728` (150 ms)
- panel-toggle exits — `CtApp.tsx:744`
- LA/Aorta/… panel show/hide — `CtApp.tsx:219,223` (60 ms)
- `resizeViewportsPreservingMprCameras` — `CtApp.tsx:671` (180 ms)

All can lose the same race on a slow/animated layout. One robust mechanism should fix them all.

---

## Fix — Workstream A (PRIMARY, fixes the blockiness)

Goal: the 3D (and every) viewport canvas backing store always matches its container, regardless of layout timing.

### A1. ResizeObserver on the viewport container (timing-independent, self-correcting)

Attach a `ResizeObserver` (the repo already uses this pattern widely — `ContourOverlay.tsx:435`, `ValveVisualization3D.tsx:75`, etc.) to the Cornerstone viewport container element(s) in `ViewportGrid.tsx` (the `#viewport-3d` cell at `ViewportGrid.tsx:117`, and the MPR grid container). On any observed size change, call `renderingEngine.resize(true, false)` (debounced to an animation frame).

- This fires whenever the 3D cell *actually* reaches its final size — no guessing a timeout.
- It also covers window resizes, panel open/close, and the TAVI/LA layout changes for free.
- Guard against feedback loops: only resize when the container's `clientWidth/Height` differs from the last-applied size.

### A2. Replace fixed-timeout resizes on mode change with a double-rAF (belt-and-braces)

In the 3D/TAVI/panel mode-change handlers, replace `setTimeout(resize, 150)` with
`requestAnimationFrame(() => requestAnimationFrame(() => engine.resize(true, false)))`
so the resize runs after the browser has laid out and painted the new layout, not on a wall-clock guess. (Keep the camera-preserving variant's save/restore.)

With A1 in place A2 is a fast-path optimization; A1 alone is sufficient for correctness.

### A3. devicePixelRatio (retina sharpness) — verify, low priority

Preview measured `devicePixelRatio = 1`. On retina Macs Cornerstone should render at DPR automatically. After A1/A2, verify on a HiDPI display that the backing store = container × dpr; if Cornerstone isn't honoring DPR for `VOLUME_3D`, set the render resolution accordingly. Do not force >1 on low-end GPUs (perf).

---

## Fix — Workstream B (SECONDARY, smoothness polish, not the blockiness)

These do **not** cause the current blocky look (proven: fixing the canvas alone made it sharp), but they improve trilinear filtering and stop quality dropping during rotation. Confirmed by both live mapper readout and the pipeline audit.

Live-measured 3D actor state: `interpolationType` non-nearest, `sampleDistance ≈ 0.86 mm`, `maxSamplesPerRay = 4000`, **`autoAdjustSampleDistances = true`**.

### B1. Apply the existing quality helper to the 3D actor

`applyLinearInterpolation()` (`src/shared/core/cornerstone.ts:159`) already does the right thing — true `setInterpolationTypeToLinear()`, `setAutoAdjustSampleDistances(false)`, `setMaximumSamplesPerRay(4000)`, fine `setSampleDistance(~0.5×minSpacing)`. It is **imported but never called for `volume3d`** in CtApp (`CtApp.tsx:13`).

- Call it once after the initial 3D preset (`CtApp.tsx:607`).
- Cornerstone's `applyPreset` sets **FAST_LINEAR** and runs on every `setProperties({preset})`, overriding true LINEAR. So re-call `applyLinearInterpolation(volume3dViewport)` after each preset/appearance change in `RenderModeSelector.tsx`: `setRenderMode` (`:186`), `applyTissueVisibility` (`:294`), `applyHuCrop` (`:1342` region), `applyDrr`. Centralize in one `reassert3dQuality()` helper so no path is forgotten.

### B2. Disable `autoAdjustSampleDistances` for the 3D mapper

So rotation doesn't coarsen sampling into visible steps. (B1 already does this; call it out explicitly and make it stick across preset re-application.)

### B3. Default sample quality

`sampleQuality` defaults to `1.0` (`RenderModeSelector.tsx:153`). Consider shipping a slightly finer default `sampleDistanceMultiplier` (≈0.5) for the 3D viewport, exposed by the existing slider (`handleSampleQuality`, `:231`). Balance against GPU cost on large volumes.

---

## Explicitly ruled out (do not spend time here)

- **Texture bit-depth / 8-bit conversion** — no `preferSizeOverAccuracy` / `maxTextureSize` / Uint8 path; default 16-bit. (audit + no evidence live)
- **Gradient opacity / shading** — not a blockiness factor.
- **Interpolation being NEAREST** — live readout shows it is not nearest; FAST_LINEAR-vs-LINEAR is a subtle polish (B1), not the blocky cause.

---

## Sequencing

| Order | WS | Effort | Risk | Effect |
|-------|----|--------|------|--------|
| 1 | A1 ResizeObserver | ~0.5 day | low | **Fixes the blockiness** (primary) |
| 2 | A2 double-rAF resizes | ~0.5 day | low | Removes the race at the source; snappier entry |
| 3 | B1/B2 reassert 3D quality after presets | ~0.5 day | low | Smoother trilinear + stable quality on rotate |
| 4 | A3 DPR verify, B3 sample default | ~0.5 day | low | HiDPI sharpness, tunable |

A1 is the single highest-value change and is independently shippable. Do it first, verify visually, then layer B.

## Verification (each step)

1. `npm run typecheck && npm run test && npm run build` green.
2. Load a real volumetric CT, enter 3D.
3. Live assert: `volume3d` canvas backing store `=== ` container `clientWidth/Height` (× dpr) — not 300×150.
4. Screenshot before/after; confirm sharp ribs/vessels; rotate and confirm it does not coarsen.
5. Repeat for TAVI mode and LA/Aorta panels (shared resize path).

## Notes

- No behavior change beyond render resolution/quality; no PHI/network impact.
- Root cause was found by **live runtime measurement**, not static reading — the fix plan is anchored on the proven canvas-resolution race, with the interpolation/sampling items as secondary polish rather than the headline.
