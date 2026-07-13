# NeoDW — Bugfix Guide for AI Agents

**Audience:** an AI coding agent (or human) fixing bugs in this repo with no prior context from earlier sessions. Read this top to bottom before touching code. Everything needed to orient, run, verify, and safely change the project is here.

---

## 1. What this project is

NeoDW is a **fully client-side, browser-based DICOM medical imaging workstation**. It parses and renders DICOM studies (CT, coronary CTA, X-ray angiography, echocardiography) entirely in the browser tab. **No server, no upload — patient data (PHI) never leaves the browser.** This is a hard invariant, not a preference (see §7).

- **Live site:** https://neodw.drtr.uk/
- **Stack:** React 18 + TypeScript (strict) + Vite 6 + Cornerstone3D (imaging engine) + VTK.js (3D, via Cornerstone). PWA via `vite-plugin-pwa`.
- **Size:** ~66k LOC, 202 source files, 31 test files.

---

## 2. Ground rules (read before editing)

1. **Never add network calls, telemetry, analytics, or any code that sends DICOM/pixel/patient data off-device.** PHI stays in the tab. If a fix seems to need a server, stop and flag it instead.
2. **Do not auto-commit or auto-push.** Make the change, verify locally, then stop and report. The maintainer commits. (This is a standing project rule.)
3. **Minimal diffs for bugfixes.** Fix the bug; don't refactor surrounding code, rename things, or "improve" unrelated files in the same change. Structural refactors are tracked separately in [`IMPROVEMENT_SPEC.md`](IMPROVEMENT_SPEC.md) — do not pull that work into a bugfix.
4. **Re-read a file immediately before editing it.** Do not trust stale memory of file contents.
5. **Preserve behavior except the bug.** A bugfix changes exactly the broken behavior and nothing observable otherwise.
6. **This is clinical software.** Wrong numbers (measurements, stenosis %, FFR, volumes, HU) are worse than crashes — a clinician may act on them. When a fix touches measurement/geometry math, add or update a test with a hand-verified expected value.

---

## 3. Setup, run, verify

```bash
npm install

npm run dev        # dev server on http://127.0.0.1:5180
npm run typecheck  # tsc --noEmit  (MUST pass — this is the type gate)
npm run test       # vitest run    (MUST pass)
npm run build      # typecheck + vite production build (MUST pass)
npm run preview     # serve the production build locally
```

### Definition of done for any bugfix

A fix is **not** complete until all three pass:

1. `npm run typecheck` — zero errors.
2. `npm run test` — all green (add a regression test for the bug where feasible).
3. `npm run build` — succeeds.

The Edit/Write tools report success even when code does not compile. **Always run the three commands above yourself** — do not claim a fix works on the basis of the edit landing. If a bug is visible in the browser, also verify in the running app (`npm run dev` + the preview tooling), never by asking the maintainer to check manually.

### Cross-origin isolation note

The app needs COOP/COEP headers for `SharedArrayBuffer` (multi-threaded WASM decode in Cornerstone). Dev uses `same-origin` + `require-corp` (set in `vite.config.ts`); production uses `same-origin` + `credentialless`. If a bug involves fonts/images/workers failing to load only in production, suspect a Cross-Origin-Resource-Policy mismatch — see the README "Cross-origin isolation" section. Keep all subresources first-party.

---

## 4. Directory map

```
src/
  App.tsx                 # top-level router; lazy-loads the 4 modality apps
  main.tsx                # entry; imports fonts; exposes debug handles on window
  shell/                  # app-shell: i18n (EN/TR), Welcome page, metadata decorators
  theme/                  # light/dark theme provider (oklch color-mix tokens)
  shared/                 # cross-modality code — FIX SHARED BUGS HERE, not per-modality
    core/                 # cornerstone init + shims (loglevel, lodash.get, xmlbuilder2, etc.)
    dicom/                # DICOM parse/write/SEG/PDF, loaders, headers  ← clinical I/O
    volume/               # frangi vesselness, fuzzy connectedness (segmentation math)
    measure/              # lesionVolume, etc.
    roi/                  # enhancement curves
    components/           # shared React components (FloatingPanel, editors)
    fileIntake.ts         # zip/rar/folder/file intake pipeline (entry point for loading studies)
  modalities/
    ct/                   # general CT: MPR, 3D VR, TAVI, LA/LAA/Aorta/LV-ADAS segmentation, Hand MR
      core/               # dicomLoader, toolManager, initCornerstone (modality-scoped)
      components/         # panels + viewers (several are 2000+ lines — see §6)
      tavi/               # TAVI measurement engine (well-tested; geometry + session)
      pcct/               # pseudo photon-counting CT panel
    coronary-ct/          # coronary CTA: MPR, centerline, stenosis, CT-FFR, CAC, auto-coronary
      coronary/           # QCA geometry, centerline overlays
      autoCoronary/       # aorta detection + ostium-anchored vessel tracing (10 files)
      ffr/                # CT-FFR solver
    angio/                # X-ray angiography (XA): cine, QCA, biplane geometry, FFR
      qca/                # quantitative coronary analysis (edge detection, measurement, FFR)
    echo/                 # echocardiography cine; GE Vivid private-tag decoder
```

**Rule of placement:** if a bug is in logic shared across modalities, fix it in `src/shared/`. If it is modality-specific, fix it inside that modality folder. Watch for **duplicated code** (§6) — the same bug may exist in 2–3 near-identical copies; grep before concluding you fixed it everywhere (see §8, semantic-search caveat).

---

## 5. How to locate code

This repo has a codebase knowledge-graph MCP available. Prefer it for structural questions:

- `search_graph` (by name/label/qualified-name) to find functions/classes.
- `trace_path` to follow call chains (who calls X, what X calls).
- `get_code_snippet` for exact symbol source.
- `search_code` for graph-augmented text search.
- If the project isn't indexed yet, run `index_repository` first.

Fall back to Grep/Glob/Read for text, configs, and non-code files. **Always Read a file before editing it.**

---

## 6. Known hazards (where bugs hide / how to change safely)

### Giant components
`TAVIPanel.tsx` (~4,789 lines) and five panels over 2,000 lines (`LVADASPanel`, `LeftAtriumPanel`, `LAAPanel`, `AortaPanel`, `VascularPanel`). They mix workflow state machines, overlays, geometry, risk scoring, and export in one file. When fixing a bug here:
- Locate the specific phase/handler; don't read the whole file into working memory blindly (read in ranges).
- Keep the fix local. Do **not** split the file as part of a bugfix (that's `IMPROVEMENT_SPEC.md` WS6).

### Copy-paste triplets (fix the bug in ALL copies)
These are ~97% identical. A bug in one almost certainly exists in the others:
- `ct/components/LeftAtriumPanel.tsx` ≈ `LAAPanel.tsx` ≈ `AortaPanel.tsx` (differ only in segmentation IDs, HU thresholds, labels).
- `DicomDropzone.tsx`, `WindowLevelPresets.tsx`, `Toolbar.tsx` exist per-modality (`angio`/`ct`/`coronary-ct`) with divergent feature levels — the CT versions are the most complete.
- `dicomLoader.ts` / `toolManager.ts` exist per-modality.

Before declaring a bug fixed, grep the parallel files for the same pattern.

### Untested clinical code (change with extra care — add a test)
No tests currently cover these, and they produce clinician-facing numbers/files:
- `src/modalities/angio/qca/*` — edge detection, QCA measurement, FFR calculation.
- `src/shared/dicom/dicomWriter.ts`, `dicomSeg.ts`, `pdfReport.ts` — DICOM encoding & report output.
- `src/modalities/coronary-ct/autoCoronary/*`.

If your fix touches these, **write a regression test with a hand-computed expected value** (see §9). TAVI (`ct/tavi/*`) and CAC/FFR-solver already have good tests — mirror their style.

### Silent failure modes (common bug class here)
The audit found errors that are logged and swallowed rather than surfaced:
- `src/shared/fileIntake.ts` — corrupt zip/rar entries are `console.warn`'d then dropped; the user isn't told files were skipped. If a report is "some images missing after loading a CD," this is the likely cause.
- `src/shared/dicom/dicomSeg.ts` — no input validation; a mask/frame-count mismatch yields invalid DICOM silently.
- `src/shared/dicom/pdfReport.ts` — a failed `import('jspdf')` is caught silently.

When fixing "nothing happened / partial result with no error," check for a swallowed `catch` first.

### Type-safety escape hatches
~481 `any` usages (337 `as any`), many are Cornerstone3D API escapes. A bug may be masked by an `as any` that hides a real type mismatch. When touching such a line, consider whether the cast is hiding the actual defect.

---

## 7. Hard invariants (never break these)

| Invariant | Why |
|-----------|-----|
| No PHI/pixel/DICOM data sent over the network | Core privacy guarantee; legal/clinical |
| No new third-party embeds without `Cross-Origin-Resource-Policy: cross-origin` | Would break credentialless COEP in production |
| Service worker never caches DICOM files or `/api/` paths | PHI must not persist in SW cache |
| Every shipped JS chunk stays precached | Offline app-shell integrity |
| Measurement math changes require a test | Clinical correctness |

---

## 8. Search discipline (no AST-wide rename safety)

When changing a function/type/variable name or signature as part of a fix, grep **separately** for:
- direct calls/references,
- type-level references (interfaces, generics),
- string literals containing the name,
- dynamic imports / `require`,
- re-exports / barrel files,
- test files and mocks.

Assume one grep did **not** catch everything. This matters doubly here because of the copy-paste triplets (§6).

Also: tool results over ~50k chars may be truncated. If a search returns suspiciously few hits, re-run it with narrower scope and say so.

---

## 9. Bugfix workflow (follow this order)

1. **Reproduce.** Get the exact failing input/steps. For UI bugs, run `npm run dev` and reproduce in the browser (use the preview tooling to inspect console, DOM, network — never guess from a screenshot for colors/values).
2. **Locate root cause.** Use the knowledge-graph MCP / grep. Trace from symptom to cause; don't patch the symptom. Suspect swallowed `catch` for "silent" bugs, copy-paste triplets for "fixed it but still broken elsewhere."
3. **Write a failing test first** where the logic is testable (all `src/shared/` and modality `*/qca`, `*/tavi`, `*/coronary`, `*/ffr` math). Use `src/shared/dicom/testHelpers/syntheticDicom.ts` for DICOM fixtures. Expected values must be hand-verified, documented inline.
4. **Make the minimal fix.** Immutable updates (new objects, no in-place mutation). Handle the error explicitly rather than swallowing.
5. **Check the triplets.** If the bug is in one of the duplicated files (§6), apply the same fix to its copies.
6. **Verify:** `npm run typecheck && npm run test && npm run build` — all green. Re-verify the repro in the browser for UI bugs.
7. **Report** what was broken, the root cause, the fix, files touched, and how you verified. **Do not commit or push** — leave that to the maintainer.

---

## 10. Reporting template

When done, report in this shape:

```
## Bug
<one line: observed vs expected>

## Root cause
<file:line — the actual defect, not the symptom>

## Fix
<what changed and why it's correct; note if triplets/copies were also updated>

## Tests
<new/updated test, and the hand-verified expected value>

## Verification
- typecheck: pass
- test: pass (N passed)
- build: pass
- browser repro: <resolved / N/A>

## Not committed — ready for maintainer review.
```

---

## 11. Pointers

- Deeper structural work (refactors, dedup, test-coverage expansion, tooling) is specified in [`docs/IMPROVEMENT_SPEC.md`](IMPROVEMENT_SPEC.md). A bugfix should never silently absorb that scope.
- README covers the cross-origin isolation model and deployment header requirements in detail.
- CI (`.github/workflows/ci.yml`) runs `typecheck → test → build`. There is currently **no lint step** (no ESLint/Prettier configured), so run the three npm commands manually — CI will not catch style, only type/test/build breakage.
