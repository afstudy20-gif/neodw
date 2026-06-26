import dicomImageLoader from '@cornerstonejs/dicom-image-loader';
import type { DicomSeriesInfo } from '../../modalities/ct/core/dicomLoader';

// Per-imageId metadata as cornerstone WADO-RS expects it: an array of
// JSON-DICOM dataset objects keyed by tag. QIDO `/metadata` returns exactly
// this shape, so we register it verbatim — no field mapping required.
type Tagged = { vr: string; Value?: unknown[] };
type InstanceMetadata = Record<string, Tagged>;

const TAG = {
  StudyInstanceUID: '0020000D',
  SeriesInstanceUID: '0020000E',
  SOPInstanceUID: '00080018',
  SeriesDescription: '0008103E',
  StudyDescription: '00081030',
  StudyDate: '00080020',
  PatientName: '00100010',
  Modality: '00080060',
  InstanceNumber: '00200013',
  ImagePositionPatient: '00200032',
  SliceLocation: '00201041',
  NumberOfFrames: '00280008',
} as const;

function firstValue<T = string>(meta: InstanceMetadata, tag: string): T | undefined {
  const el = meta[tag];
  if (!el || !el.Value || el.Value.length === 0) return undefined;
  const v = el.Value[0];
  if (v && typeof v === 'object' && 'Alphabetic' in (v as any)) {
    return (v as any).Alphabetic as T;
  }
  return v as T;
}

function allValues<T = string>(meta: InstanceMetadata, tag: string): T[] {
  const el = meta[tag];
  if (!el || !el.Value) return [];
  return el.Value as T[];
}

export interface DicomWebSource {
  /** DICOMweb root URL, e.g. https://xxx.trycloudflare.com/dicom-web */
  baseUrl: string;
  /** StudyInstanceUID */
  studyUID: string;
  /** Optional Basic-auth token (base64 of "user:pass"). */
  token?: string;
  /** Only emit series for these modalities. */
  modalities?: string[];
}

let authConfigured = false;
function configureAuth(token: string | undefined) {
  // Cornerstone's WADO-RS XHR pipeline accepts a beforeSend hook that returns
  // extra headers. setOptions is idempotent — overwriting on each fetch is
  // cheaper than tracking config drift across modalities.
  if (!token) return;
  dicomImageLoader.internal.setOptions({
    beforeSend: () => ({ Authorization: `Basic ${token}` }),
  });
  authConfigured = true;
}

async function qidoFetch<T>(url: string, token?: string): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/dicom+json' };
  if (token) headers.Authorization = `Basic ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`DICOMweb ${res.status} on ${url}`);
  }
  // Some servers return 204 for empty lists.
  if (res.status === 204) return [] as unknown as T;
  return (await res.json()) as T;
}

function slicePosition(meta: InstanceMetadata): number {
  const ipp = allValues<number>(meta, TAG.ImagePositionPatient);
  if (ipp.length >= 3) {
    const z = Number(ipp[2]);
    if (Number.isFinite(z)) return z;
  }
  const sl = firstValue<number>(meta, TAG.SliceLocation);
  if (sl != null && Number.isFinite(Number(sl))) return Number(sl);
  const inst = firstValue<number>(meta, TAG.InstanceNumber);
  if (inst != null && Number.isFinite(Number(inst))) return Number(inst);
  return 0;
}

/**
 * Fetch a study from a DICOMweb server (QIDO + metadata) and return
 * CT/MR series ready to feed into the existing CT viewer. WADO-RS imageIds
 * are registered with cornerstone's WADORS metadata manager so the viewport
 * can pull pixel data on demand without a second metadata round-trip.
 */
export async function loadDicomWebStudy(src: DicomWebSource): Promise<DicomSeriesInfo[]> {
  configureAuth(src.token);
  if (src.token && !authConfigured) configureAuth(src.token);

  const base = src.baseUrl.replace(/\/$/, '');
  const wanted = (src.modalities ?? ['CT', 'MR']).map((m) => m.toUpperCase());

  // 1. QIDO series under this study.
  const seriesList = await qidoFetch<InstanceMetadata[]>(
    `${base}/studies/${encodeURIComponent(src.studyUID)}/series`,
    src.token
  );

  const out: DicomSeriesInfo[] = [];

  for (const seriesEntry of seriesList) {
    const seriesUID = firstValue<string>(seriesEntry, TAG.SeriesInstanceUID);
    if (!seriesUID) continue;
    const modality = (firstValue<string>(seriesEntry, TAG.Modality) || '').toUpperCase();
    if (!wanted.includes(modality)) continue;

    // 2. Series metadata — array of instance metadata objects.
    const instanceMetas = await qidoFetch<InstanceMetadata[]>(
      `${base}/studies/${encodeURIComponent(src.studyUID)}/series/${encodeURIComponent(seriesUID)}/metadata`,
      src.token
    );

    if (instanceMetas.length === 0) continue;

    // 3. Build wadors imageIds and register metadata per imageId.
    const items: Array<{ imageId: string; meta: InstanceMetadata; pos: number }> = [];
    for (const meta of instanceMetas) {
      const sopUID = firstValue<string>(meta, TAG.SOPInstanceUID);
      if (!sopUID) continue;
      const frameCount = Number(firstValue(meta, TAG.NumberOfFrames) ?? 1) || 1;
      for (let frame = 1; frame <= frameCount; frame += 1) {
        const imageId = `wadors:${base}/studies/${encodeURIComponent(src.studyUID)}/series/${encodeURIComponent(seriesUID)}/instances/${encodeURIComponent(sopUID)}/frames/${frame}`;
        dicomImageLoader.wadors.metaDataManager.add(imageId, meta as any);
        items.push({ imageId, meta, pos: slicePosition(meta) });
      }
    }

    items.sort((a, b) => a.pos - b.pos);
    // If positions descend, the volume builds inverted — flip once so the
    // top slice is first (matches the file-loader's behaviour).
    if (items.length >= 2 && items[items.length - 1].pos < items[0].pos) {
      items.reverse();
    }

    const first = seriesEntry;
    out.push({
      seriesInstanceUID: seriesUID,
      seriesDescription: firstValue(first, TAG.SeriesDescription) || `${modality} series`,
      modality,
      numImages: items.length,
      imageIds: items.map((i) => i.imageId),
      patientName: firstValue(first, TAG.PatientName) || 'Unknown',
      studyDescription: firstValue(first, TAG.StudyDescription) || '',
      studyDate: firstValue(first, TAG.StudyDate) || '',
    });
  }

  out.sort((a, b) => b.numImages - a.numImages);
  return out;
}

export interface DicomWebUrlParams {
  dicomweb: string;
  study: string;
  modality: 'ct' | 'mr';
  token?: string;
}

/**
 * Parse `?dicomweb=...&study=...&modality=...` plus `#token=...` from the
 * current location. Returns null when the required pair is absent.
 */
export function parseDicomWebUrlParams(loc: Location = window.location): DicomWebUrlParams | null {
  const qs = new URLSearchParams(loc.search);
  const dicomweb = qs.get('dicomweb');
  const study = qs.get('study');
  if (!dicomweb || !study) return null;
  const modality = ((qs.get('modality') || 'ct').toLowerCase() === 'mr' ? 'mr' : 'ct') as 'ct' | 'mr';
  const hash = new URLSearchParams(loc.hash.replace(/^#/, ''));
  const token = hash.get('token') || undefined;
  return { dicomweb, study, modality, token };
}
