import type { DicomSeriesInfo } from './core/dicomLoader';

export interface Preset {
  name: string;
  window: number;
  level: number;
  description: string;
}

export interface MRPreset {
  name: string;
  description: string;
  reset?: boolean;
  lowerQuantile: number;
  upperQuantile: number;
  minWindowFrac?: number;
}

export const MR_PRESETS_TUNED: MRPreset[] = [
  { name: 'Default', reset: true, lowerQuantile: 0, upperQuantile: 1, description: 'DICOM WindowCenter / WindowWidth' },
  { name: 'Auto', lowerQuantile: 0.005, upperQuantile: 0.985, minWindowFrac: 0.08, description: 'Image/volume auto window' },
  { name: 'T1', lowerQuantile: 0.005, upperQuantile: 0.98, minWindowFrac: 0.08, description: 'T1 weighted anatomy' },
  { name: 'T2', lowerQuantile: 0.005, upperQuantile: 0.985, minWindowFrac: 0.08, description: 'T2 weighted fluid bright' },
  { name: 'STIR/TIRM', lowerQuantile: 0.005, upperQuantile: 0.99, minWindowFrac: 0.08, description: 'Fat-suppressed fluid bright' },
  { name: 'PD', lowerQuantile: 0.005, upperQuantile: 0.985, minWindowFrac: 0.08, description: 'Proton density' },
  { name: 'FLAIR', lowerQuantile: 0.005, upperQuantile: 0.985, minWindowFrac: 0.08, description: 'Fluid attenuated inversion recovery' },
  { name: 'DWI/ADC', lowerQuantile: 0.005, upperQuantile: 0.99, minWindowFrac: 0.10, description: 'Diffusion / ADC' },
  { name: 'GRE/T2*', lowerQuantile: 0.005, upperQuantile: 0.985, minWindowFrac: 0.08, description: 'Gradient echo / T2 star' },
];

export const MR_PRESETS: Preset[] = MR_PRESETS_TUNED.map((p) => ({
  name: p.name,
  window: Math.round((p.upperQuantile - p.lowerQuantile) * 2000),
  level: Math.round(((p.upperQuantile + p.lowerQuantile) / 2) * 2000),
  description: p.description,
}));

function text(series: DicomSeriesInfo): string {
  return [
    series.seriesDescription,
    series.studyDescription,
    series.sequenceName,
    series.scanningSequence,
    series.sequenceVariant,
    series.scanOptions,
    series.imageType,
  ].filter(Boolean).join(' ').toUpperCase();
}

function num(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number.parseFloat(String(v).split('\\')[0]);
  return Number.isFinite(n) ? n : undefined;
}

export function pickDefaultWindowLevelPreset(series: DicomSeriesInfo | null): string | undefined {
  if (!series) return undefined;
  const mod = (series.modality || '').toUpperCase();
  if (mod === 'CT') return 'Bone';
  if (mod !== 'MR' && mod !== 'MRI') return undefined;

  const s = text(series);
  const tr = num(series.repetitionTime);
  const te = num(series.echoTime);
  const ti = num(series.inversionTime);

  if (/\bADC\b|DIFF|DWI|TRACEW|\bB[ =_-]?(?:500|800|1000|1200|1500)\b/.test(s)) return 'DWI/ADC';
  if (/FLAIR/.test(s) || (ti != null && ti > 700)) return 'FLAIR';
  if (/\bSTIR\b|\bTIRM\b|\bSPAIR\b|\bSPIR\b|FAT[ _-]?SAT|\bFS\b|FATSUP|FAT[ _-]?SUPP/.test(s)) return 'STIR/TIRM';
  if (/T2\*|T2STAR|\bGRE\b|\bFFE\b|\bFLASH\b|\bMEDIC\b|\bMERGE\b/.test(s)) return 'GRE/T2*';
  if (/(^|[^A-Z0-9])T1([^A-Z0-9]|$)|T1W|TSE[ _-]?T1|T1[ _-]?TSE|MPRAGE|SPGR|BRAVO/.test(s)) return 'T1';
  if (/(^|[^A-Z0-9])T2([^A-Z0-9]|$)|T2W|TSE[ _-]?T2|T2[ _-]?TSE|SPACE|CUBE|HASTE|MYELO/.test(s)) return 'T2';
  if (/(^|[^A-Z0-9])PD([^A-Z0-9]|$)|PROTON/.test(s)) return 'PD';

  if (ti != null && ti > 80) return 'STIR/TIRM';
  if (te != null && te >= 70) return 'T2';
  if (tr != null && tr > 1500 && te != null && te >= 40) return 'T2';
  if (tr != null && tr < 1000 && (te == null || te < 40)) return 'T1';

  return 'Auto';
}

export interface MrVoiRange {
  lower: number;
  upper: number;
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = Math.min(sorted.length - 1, Math.max(0, q * (sorted.length - 1)));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const t = pos - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}

export function computeMrVoiRange(
  scalarData: ArrayLike<number> | undefined,
  presetName: string,
  maxSamples = 80000
): MrVoiRange | null {
  const tuned = MR_PRESETS_TUNED.find((p) => p.name === presetName);
  if (!tuned || tuned.reset) return null;
  if (!scalarData || scalarData.length === 0) return null;

  const stride = Math.max(1, Math.floor(scalarData.length / maxSamples));
  const positive: number[] = [];
  const finite: number[] = [];
  for (let i = 0; i < scalarData.length; i += stride) {
    const v = Number((scalarData as any)[i]);
    if (!Number.isFinite(v)) continue;
    finite.push(v);
    if (v > 0) positive.push(v);
  }

  const samples = positive.length >= 128 ? positive : finite;
  if (samples.length < 128) return null;
  samples.sort((a, b) => a - b);

  let lower = percentile(samples, tuned.lowerQuantile);
  let upper = percentile(samples, tuned.upperQuantile);
  const robustLower = percentile(samples, 0.005);
  const robustUpper = percentile(samples, 0.995);
  const robustSpan = robustUpper - robustLower;
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || !Number.isFinite(robustSpan) || robustSpan <= 0) {
    return null;
  }

  const minWindow = Math.max(8, robustSpan * (tuned.minWindowFrac ?? 0.08));
  if (upper - lower < minWindow) {
    const center = (upper + lower) / 2;
    lower = center - minWindow / 2;
    upper = center + minWindow / 2;
  }

  if (upper <= lower) return null;
  return { lower, upper };
}

export function getScalarDataFromVolume(volume: any): ArrayLike<number> | undefined {
  if (!volume) return undefined;
  try {
    const data = volume.voxelManager?.getScalarData?.();
    if (data?.length) return data;
  } catch { /* noop */ }
  try {
    const data = volume.voxelManager?.getCompleteScalarDataArray?.();
    if (data?.length) return data;
  } catch { /* noop */ }
  try {
    const data = volume.getScalarData?.();
    if (data?.length) return data;
  } catch { /* noop */ }
  try {
    const data = volume.scalarData;
    if (data?.length) return data;
  } catch { /* noop */ }
  try {
    const data = volume.imageData?.getPointData?.().getScalars?.().getData?.();
    if (data?.length) return data;
  } catch { /* noop */ }
  return undefined;
}
