# NeoDW Improvement Specification

**Status:** Draft
**Date:** 2026-07-06
**Scope:** Codebase health improvements identified in the 2026-07-06 audit. No new user-facing features; behavior-preserving refactors, safety hardening, test coverage, and tooling.

---

## Background

NeoDW is a client-side browser DICOM workstation (React 18 + TypeScript + Vite + Cornerstone3D, ~66k LOC across 202 source files). The audit found the project structurally sound — strict TS, CI with typecheck/test/build, lazy-loaded modality bundles, correct COOP/COEP and PWA/PHI handling — but with three systemic weaknesses:

1. **Copy-paste duplication** across modality folders (~5,400 removable lines).
2. **Monolithic components** (TAVIPanel.tsx at 4,789 lines; five panels over 2,000 lines).
3. **Silent failure modes in clinical export/import paths** and zero test coverage on code that produces clinician-facing numbers and files (QCA, DICOM writer/SEG).

This spec defines six workstreams (WS1–WS6), ordered by risk-adjusted value. Each workstream is independently shippable and lands as its own PR (or PR series). Later workstreams depend on earlier ones only where noted.

### Guiding constraints

- **No behavior changes** unless the current behavior is a defect (silent data loss counts as a defect).
- **No PHI ever leaves the browser** — nothing in this spec may add network calls, telemetry, or server dependencies.
- **Each phase ≤ 5 files touched** where practical; large refactors are split into review-sized steps.
- **Every PR keeps `npm run build` (typecheck + vite build) and `npm run test` green.**
- Existing public component APIs (props of panels consumed by `CtApp.tsx` etc.) stay stable unless the workstream explicitly says otherwise.

---

## WS1 — Quick wins (housekeeping)

**Goal:** Zero-risk cleanups. One PR.

### Tasks

| # | Task | Files |
|---|------|-------|
| 1.1 | Delete `edge_startup.log` from repo root; add `edge_startup.log` to `.gitignore` | `edge_startup.log`, `.gitignore` |
| 1.2 | Add explicit `Cache-Control: no-cache, no-store, must-revalidate` for `sw.js` in nginx config (parity with netlify.toml / vercel.json) | `nginx.conf` |
| 1.3 | Deduplicate `SecondaryCaptureViewer.tsx`: move the byte-identical file to `src/shared/components/SecondaryCaptureViewer.tsx`; re-point imports in `ct` and `coronary-ct`; delete both modality copies | `src/modalities/ct/components/SecondaryCaptureViewer.tsx`, `src/modalities/coronary-ct/components/SecondaryCaptureViewer.tsx`, `src/shared/components/SecondaryCaptureViewer.tsx`, importers |

### Acceptance criteria

- `git ls-files | grep edge_startup` returns nothing.
- nginx `location = /sw.js` block sets no-cache headers; a comment explains stale-SW risk.
- Exactly one `SecondaryCaptureViewer.tsx` exists, under `src/shared/components/`; both modalities render it unchanged (manual smoke: load a secondary-capture series in CT and CCTA).
- Typecheck, tests, build green.

---

## WS2 — Error surfacing & input validation (patient-safety)

**Goal:** No silent partial failures in file intake; no structurally invalid DICOM output. Highest-priority substantive work.

### 2.1 File intake failure surfacing

**Current defect:** `src/shared/fileIntake.ts` catches zip/rar entry failures and archive extraction failures with `console.warn` and silently drops files. A user loading a patient CD cannot tell that some instances were skipped.

**Design:**

- `fileIntake` returns an intake result object instead of (or alongside) the bare file list:

```ts
export interface IntakeResult {
  files: IntakeFile[];            // existing successful output
  failures: IntakeFailure[];      // NEW
}

export interface IntakeFailure {
  name: string;                   // entry or file name
  source: 'zip' | 'rar' | 'file' | 'directory';
  reason: string;                 // short human-readable cause
}
```

- All existing `catch { console.warn(...) }` sites in `fileIntake.ts` (zip entry, rar entry, zip extract, rar extract) push an `IntakeFailure` in addition to the warn (keep the console.warn for debugging).
- Each modality dropzone/intake call site shows a non-blocking notice when `failures.length > 0`:
  - Text: `"{failed} of {total} files could not be read"` with expandable per-file detail (name + reason).
  - Localized via existing `src/shell/i18n.ts` (EN + TR keys).
  - Dismissible; does not prevent viewing the files that did load.
- No UI change when `failures.length === 0`.

**Files:** `src/shared/fileIntake.ts`, `src/shell/i18n.ts`, one shared notice component (`src/shared/components/IntakeFailureNotice.tsx`), the four modality intake call sites.

### 2.2 DICOM SEG input validation

**Current defect:** `src/shared/dicom/dicomSeg.ts` performs no validation; a mask/frame-count mismatch produces invalid DICOM silently.

**Design:** `buildDicomSeg(input)` validates before encoding and throws `Error` with a descriptive message on:

- `input.mask` depth ≠ `input.sourceRef.sopInstanceUids.length` (frame count mismatch);
- mask width/height ≠ referenced series rows/columns;
- empty or malformed UIDs (must match DICOM UI VR: digits and dots, ≤ 64 chars);
- empty mask (zero segmented voxels) — throw, caller decides whether that's a user error.

Callers (segmentation export UI) catch and show the message to the user; export button never appears to succeed when the build threw.

### 2.3 PDF report failure surfacing

**Current defect:** `src/shared/dicom/pdfReport.ts` swallows a failed dynamic `import('jspdf')` and follows undefined behavior.

**Design:** on import failure, throw `Error('PDF export unavailable: failed to load jsPDF')`; caller surfaces it. No silent catch remains in the file.

### 2.4 Tests (written first, per TDD)

- `fileIntake.test.ts`: extend with corrupted-zip fixture → expect intact files in `files`, corrupted entry in `failures` with correct `source`/`reason`.
- New `dicomSeg.test.ts`: valid input round-trip parses (via `dicom-parser`); each validation rule above has a rejection case.
- `pdfReport`: unit-test the error path with a mocked failing import.

### Acceptance criteria

- Loading an archive with one corrupt member shows the notice with correct counts; the remaining members display normally.
- `buildDicomSeg` rejects every malformed-input class above with a distinct message; valid input still produces a SEG parsable by `dicom-parser`.
- No `catch` block in `fileIntake.ts`, `dicomSeg.ts`, `pdfReport.ts` discards an error without either surfacing to UI or rethrowing.
- All new/changed logic covered by unit tests; suite green.

---

## WS3 — Panel triplet consolidation

**Goal:** Replace the three 97%-identical 2,253-line panels (`LeftAtriumPanel`, `LAAPanel`, `AortaPanel`) with one parameterized implementation. Removes ~4,500 lines.

**Depends on:** nothing (WS1.3 recommended first as warm-up).

### Design

New `src/modalities/ct/components/OrganSegmentationPanel.tsx` plus a config module:

```ts
// src/modalities/ct/segmentation/organConfigs.ts
export interface OrganSegmentationConfig {
  key: 'la' | 'laa' | 'aorta';
  segmentationId: string;
  labels: { panelTitle: string; meshName: string; /* i18n keys, not literals */ };
  hu: { defaultMin: number; defaultMax: number };
  voxelCap: number;
  mesh: { color: [number, number, number]; bg: [number, number, number]; alpha: number };
  // Any behavioral divergence found during diff (seed strategy, smoothing passes, etc.)
  // becomes an explicit config field here — never an if(organ === ...) branch in the panel.
}

export const LA_CONFIG: OrganSegmentationConfig = { ... };
export const LAA_CONFIG: OrganSegmentationConfig = { ... };
export const AORTA_CONFIG: OrganSegmentationConfig = { ... };
```

- The three existing exports become thin wrappers so `CtApp.tsx` and imperative-handle consumers change minimally:

```tsx
export const LeftAtriumPanel = forwardRef<OrganPanelHandle, OrganPanelProps>(
  (props, ref) => <OrganSegmentationPanel ref={ref} config={LA_CONFIG} {...props} />
);
```

- The three `*PanelHandle` interfaces unify into one `OrganPanelHandle`; old names remain as type aliases for one release.

### Procedure (review-sized steps)

1. **Diff audit:** produce exact 3-way diff; enumerate every divergent line into config fields or documented intentional differences. This list goes in the PR description — it is the correctness contract.
2. Introduce `OrganSegmentationPanel` implemented from `LeftAtriumPanel` (the base copy), parameterized by config.
3. Switch LA → wrapper; verify. Switch LAA → wrapper; verify. Switch Aorta → wrapper; verify. (Three commits.)
4. Delete dead originals.

### Verification

- The diff audit from step 1 must show zero unexplained behavioral lines.
- Manual smoke per organ on a real CT series: run segmentation, adjust HU range, generate mesh, export. Compare voxel counts / volume stats before vs after refactor — must be identical (same inputs, same numbers).
- Typecheck + tests green after each step.

### Acceptance criteria

- Single implementation file (< 800 lines target; if it can't get under 800, split by concern: seeding, mesh, export).
- `LeftAtriumPanel.tsx` / `LAAPanel.tsx` / `AortaPanel.tsx` are each < 50-line wrappers or deleted.
- No `if (organ === ...)` branching inside the shared panel body — divergence lives in config only.

---

## WS4 — Clinical-logic test coverage

**Goal:** Tests over the untested code paths that produce clinician-facing numbers and exportable files.

**Depends on:** WS2 (dicomSeg tests land there).

### Targets, in priority order

| Priority | Module | What to test |
|----------|--------|--------------|
| P0 | `src/modalities/angio/qca/edgeDetection.ts` | Edge profile detection on synthetic vessel images (known diameter ramp → detected edges within tolerance) |
| P0 | `src/modalities/angio/qca/qcaMeasurement.ts` | Reference diameter, %stenosis, MLD on synthetic centerline + edge data; degenerate inputs (zero-length centerline, single point) |
| P0 | `src/modalities/angio/qca/ffrCalculation.ts` | Known input → expected FFR; boundary values; NaN/negative guards |
| P1 | `src/shared/dicom/dicomWriter.ts` | Encode → re-parse with `dicom-parser` round-trip: every VR branch, even/odd length padding, explicit little-endian layout, error throws for wrong typed arrays |
| P1 | `src/modalities/coronary-ct/coronary/ffr/*` (beyond existing ffrSolver test) | Boundary flow, arc resampling, PPG — golden-value tests from hand-computed small cases |
| P2 | `src/modalities/coronary-ct/autoCoronary/*` | Aorta blob detection + ostium anchoring on small synthetic volumes (analytic cylinders/spheres) |

### Approach

- Reuse existing synthetic-DICOM helper (`src/shared/dicom/testHelpers/syntheticDicom.ts`); add a synthetic-volume helper (`src/shared/volume/testHelpers/syntheticVolume.ts`) generating analytic phantoms (cylinder at known HU in background) for P2.
- Golden values computed independently (hand calculation or trivially verifiable formula) and documented in the test file next to each expectation.
- Tolerances explicit: geometric results to 1e-6 relative unless the algorithm is inherently discrete (edge detection: ±1 px).

### Acceptance criteria

- P0 modules each have a test file; every exported function has at least: one nominal case with golden value, one degenerate/edge case.
- `dicomWriter` round-trip covers all supported VRs.
- Suite runtime stays < 60 s locally.

---

## WS5 — Lint tooling & type hygiene

**Goal:** Stop new debt; ratchet down existing debt without a big-bang rewrite.

### 5.1 ESLint + Prettier

- Add flat-config ESLint: `typescript-eslint` recommended, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh` (Vite standard).
- Prettier with repo defaults; `format` and `lint` npm scripts.
- CI: add `lint` step between typecheck and test in `.github/workflows/ci.yml`.
- Initial rollout: run `prettier --write` once as an isolated, no-logic-change commit; fix or explicitly disable (with comment) every ESLint error. Rules start at severity that keeps CI green on day one:
  - `@typescript-eslint/no-explicit-any`: **warn** (481 existing occurrences — error would be noise);
  - `no-console`: **warn**, with `console.error` allowed;
  - hooks rules: **error** (these catch real bugs).

### 5.2 tsconfig ratchet

- Enable `noUnusedLocals: true` and `noUnusedParameters: true`; fix fallout (rename intentional unused params to `_`-prefixed).

### 5.3 `any` reduction (targeted, not exhaustive)

- Only in clinical-logic directories (`tavi/`, `qca/`, `coronary/`, `shared/dicom/`): replace `as any` with proper types or narrow `unknown` + type guards. Cornerstone API escapes may remain but must be funneled through typed helper wrappers in `src/shared/core/cornerstone.ts` rather than scattered casts.
- Metric: `grep -c "as any" src/**/tavi src/**/qca src/**/coronary src/shared/dicom` drops by ≥ 50%.

### 5.4 Console noise

- Introduce `src/shared/core/log.ts`: `log.debug/info/warn/error`, where `debug`/`info` are no-ops in production builds (`import.meta.env.PROD`). Migrate `console.log` call sites mechanically; keep `warn`/`error`.

### Acceptance criteria

- CI fails on lint errors; zero errors at merge.
- `noUnusedLocals`/`noUnusedParameters` on, build green.
- No raw `console.log` in `src/` (enforced by lint rule).

---

## WS6 — TAVIPanel decomposition

**Goal:** Split the 4,789-line `TAVIPanel.tsx` into testable modules. Largest effort; do last, after WS3 establishes the pattern and WS5 protects against regressions. **Note:** TAVIPanel has uncommitted in-flight work (valve deployment feature) — this workstream must wait until that lands.

### Target structure

```
src/modalities/ct/tavi/panel/
  TAVIPanel.tsx              // orchestrator: phase state machine + layout only (< 600 lines)
  phases/
    AxisDetectionPhase.tsx
    CenterlineReviewPhase.tsx
    CuspDefinitionPhase.tsx  // includes cusp step machine (lcc/ncc/rcc/verify)
    AnnulusTracingPhase.tsx
    CoronaryHeightsPhase.tsx // navigate/capture LCA-RCA step machine
    ReportPhase.tsx
  overlays/                  // presentational; React.memo-wrapped
    CuspMarkerOverlay.tsx
    AnnulusMeasurementOverlay.tsx
    CoronaryHeightView.tsx
  export/
    taviCsvExport.ts         // pure functions — unit-testable
    taviSegExport.ts
  risk/
    riskScoring.ts           // pure functions: annular disruption, LVOT obstruction, membrane septum
    RiskPanel.tsx
```

### Rules

- State stays in the existing `TAVIMeasurementSession` (already a separate class) — phases receive session + callbacks via props; no new global state library.
- Pure computation (risk scores, CSV/SEG assembly) extracted to `.ts` modules first, with unit tests, before any JSX moves. This is the low-risk high-value part; do it even if the JSX split stalls.
- Each extraction step ≤ 5 files, behavior-identical, own commit.
- Overlays wrapped in `React.memo` on extraction (audit finding: they re-render on every session change).

### Acceptance criteria

- No file in `tavi/panel/` over 800 lines.
- Risk scoring and export logic have unit tests with golden values.
- Manual smoke: full TAVI workflow (load series → axis detection → cusps → annulus → coronary heights → report/export) produces identical measurement values pre/post refactor on the same study.
- Follow-up (separate, same pattern): `LVADASPanel.tsx` (2,622 lines).

---

## Sequencing & effort

| Order | Workstream | Effort | Risk | PRs |
|-------|-----------|--------|------|-----|
| 1 | WS1 Quick wins | ~1 h | none | 1 |
| 2 | WS2 Error surfacing | 1–2 days | low | 1–2 |
| 3 | WS3 Panel triplets | 2–3 days | medium (mitigated by diff audit) | 1 series (4 commits) |
| 4 | WS4 Clinical tests | 2–3 days | none (test-only) | 2–3 |
| 5 | WS5 Lint/type hygiene | 1–2 days | low | 2 (format commit isolated) |
| 6 | WS6 TAVIPanel split | 1–2 weeks | medium | series, pure-logic extraction first |

WS4 and WS5 can run in parallel with WS3 (disjoint files). WS6 blocked on in-flight TAVI valve-deployment work landing.

## Out of scope

- New clinical features or measurement algorithms.
- Visual/UX redesign.
- `SeriesPanel` / `ViewportGrid` consolidation (audit showed < 25% similarity — genuinely divergent, leave separate).
- Server-side anything.

## Global verification (every PR)

1. `npm run typecheck`
2. `npm run test`
3. `npm run build`
4. Manual smoke of the touched modality with a real DICOM study (local preview, per repo convention: verify in preview before commit; no auto-commit/push).
