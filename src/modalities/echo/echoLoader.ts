import * as dicomParser from 'dicom-parser';
import * as cornerstone from '@cornerstonejs/core';
import { parseGEVividCine, registerGECineHandlers, storeGEFrame, type GECineResult } from './geVividCine';

export interface EchoSeriesInfo {
  seriesInstanceUID: string;
  seriesDescription: string;
  modality: string;
  numImages: number;
  imageIds: string[];
  patientName: string;
  studyDescription: string;
  studyDate: string;
  rows: number;
  columns: number;
  samplesPerPixel: number;
  photometricInterpretation: string;
  windowCenter: number | null;
  windowWidth: number | null;
  cineRate: number | null;
  pixelSpacingMm: [number, number] | null; // [row, col] in mm
  hasGEPrivateCine: boolean; // GE Vivid proprietary cine detected but NOT decoded (3D/volumetric)
  geCineDecoded: boolean; // GE Vivid 2D cine successfully decoded via SlicerHeart algorithm
  frameTimeMs: number | null;
}

interface EchoCalibration {
  rowSpacingMm: number;
  colSpacingMm: number;
}

export interface DopplerSpectralRegion {
  /** Region rect in image-pixel coords (y0..y1 inclusive). */
  y0: number;
  y1: number;
  x0: number;
  x1: number;
  /** Image-pixel Y where physical value equals 0 (baseline, zero velocity). */
  refPixelY0: number;
  /** Velocity unit code (4 = cm/s, 7 = m/s). */
  unitY: number;
  /** PhysicalDeltaY (value per pixel), in `unitY` units. */
  deltaY: number;
  /** Normalized m/s per image pixel (absolute value). */
  mpsPerImagePx: number;
}

const calibrationByImageId = new Map<string, EchoCalibration>();
const dopplerByImageId = new Map<string, DopplerSpectralRegion>();
export function getDopplerSpectralRegion(imageId: string): DopplerSpectralRegion | undefined {
  return dopplerByImageId.get(imageId) ?? dopplerByImageId.get(imageId.split('?')[0]);
}
let providerRegistered = false;

let providerLogCount = 0;
function registerEchoProvider() {
  if (providerRegistered) return;
  providerRegistered = true;
  const provider = (type: string, imageId: string) => {
    const withoutFrame = imageId.split('?')[0];
    const cal = calibrationByImageId.get(imageId) ?? calibrationByImageId.get(withoutFrame);
    if (!cal) return undefined;
    if (type === 'imagePlaneModule') {
      const out = {
        // Keep display pixels square. Ultrasound calibration is exposed separately
        // via calibratedPixelSpacing so measurements stay correct without distorting
        // how cine loops are shown on screen.
        rowPixelSpacing: 1,
        columnPixelSpacing: 1,
        pixelSpacing: [1, 1],
        rowCosines: [1, 0, 0],
        columnCosines: [0, 1, 0],
        imagePositionPatient: [0, 0, 0],
        imageOrientationPatient: [1, 0, 0, 0, 1, 0],
      };
      if (providerLogCount < 5) {
        console.log(`[Echo provider] imagePlaneModule row=${cal.rowSpacingMm.toFixed(4)}mm col=${cal.colSpacingMm.toFixed(4)}mm imageId=${imageId.substring(0,80)}`);
        providerLogCount++;
      }
      return out;
    }
    if (type === 'calibratedPixelSpacing') {
      return { rowPixelSpacing: cal.rowSpacingMm, columnPixelSpacing: cal.colSpacingMm };
    }
    return undefined;
  };
  cornerstone.metaData.addProvider(provider, Number.MAX_SAFE_INTEGER);
  console.log('[Echo] metadata provider registered (max priority)');
}

function hasPart10Header(bytes: Uint8Array): boolean {
  return bytes.length >= 132 &&
    bytes[128] === 0x44 && bytes[129] === 0x49 &&
    bytes[130] === 0x43 && bytes[131] === 0x4d;
}

function wrapPart10(raw: Uint8Array): Uint8Array {
  const tsUid = '1.2.840.10008.1.2';
  const tsBytes = new TextEncoder().encode(tsUid);
  const tsPadded = tsBytes.length % 2 === 0 ? tsBytes : new Uint8Array([...tsBytes, 0x00]);
  const tsElementLength = 8 + tsPadded.length;
  const groupLengthValue = tsElementLength;
  const meta: number[] = [];
  meta.push(0x02, 0x00, 0x00, 0x00, 0x55, 0x4c, 0x04, 0x00);
  meta.push(groupLengthValue & 0xff, (groupLengthValue >> 8) & 0xff, (groupLengthValue >> 16) & 0xff, (groupLengthValue >> 24) & 0xff);
  meta.push(0x02, 0x00, 0x10, 0x00, 0x55, 0x49, tsPadded.length & 0xff, (tsPadded.length >> 8) & 0xff);
  for (const b of tsPadded) meta.push(b);
  const metaBytes = new Uint8Array(meta);
  const out = new Uint8Array(128 + 4 + metaBytes.length + raw.length);
  out[128] = 0x44; out[129] = 0x49; out[130] = 0x43; out[131] = 0x4d;
  out.set(metaBytes, 132);
  out.set(raw, 132 + metaBytes.length);
  return out;
}

function firstFloat(s: string | undefined): number | null {
  if (!s) return null;
  const first = s.split('\\')[0];
  const n = parseFloat(first);
  return isNaN(n) ? null : n;
}

// Count frames in encapsulated pixel data (JPEG/JPEG-LS/JPEG2000) by scanning SOI markers.
// DICOM encapsulated pixel data: (7FE0,0010) with items; each item = one frame bitstream.
function inferFrameCount(ds: any): number {
  try {
    const pd = ds.elements['x7fe00010'];
    let tsUid = '';
    try { tsUid = ds.string('x00020010') || ''; } catch {}
    const pdInfo = pd ? {
      hasItems: !!pd.items,
      itemsLen: pd.items?.length,
      dataLen: pd.length,
    } : null;
    // List private groups + any 7FE1 (GE private pixel data)
    const privateTags: string[] = [];
    for (const key of Object.keys(ds.elements)) {
      const group = parseInt(key.slice(1, 5), 16);
      if (group % 2 === 1 || key.startsWith('x7fe1') || key.startsWith('x0028')) {
        const el = ds.elements[key];
        privateTags.push(`${key}(vr=${el.vr || '?'}, len=${el.length}, items=${el.items?.length ?? 0})`);
      }
    }
    console.log(`[Echo pixeldata] tsUid=${tsUid} pd=${JSON.stringify(pdInfo)}`);
    console.log(`[Echo privateTags] ${privateTags.join(' | ')}`);

    // GE private cine data lives at (7FE1,1001) SQ with nested items containing per-frame pixel data
    const geCine = ds.elements['x7fe11001'];
    if (geCine?.items && geCine.items.length > 0) {
      console.log(`[Echo GE 7FE1,1001] items=${geCine.items.length}`);
      const topItem = geCine.items[0];
      const inner = topItem?.dataSet;
      if (inner) {
        console.log(`[Echo GE 7FE1,1001 inner elements] ${Object.keys(inner.elements).join(',')}`);
        for (const tag of Object.keys(inner.elements)) {
          const el = inner.elements[tag];
          const encap = el.items ? `items=${el.items.length}` : '';
          console.log(`  ${tag}: vr=${el.vr} len=${el.length} dataOffset=${el.dataOffset} ${encap}`);
          // If this element has items, it's likely the frame list
          // Skip 7FE1,1008 timestamps — real pixel data is in 7FE1,1010 or 7FE1,1070
          if (tag === 'x7fe11008') continue;
          if (el.items && el.items.length > 1) {
            // GE private cine — too deeply nested / proprietary. Cornerstone can't decode it.
            // Fall back to standard single-frame pixel data (7FE0,0010). Matches Horos behavior.
            console.warn(`[Echo GE ${tag}] detected ${el.items.length} items — GE proprietary cine, cornerstone cannot decode. Showing single frame from standard pixel data.`);
            (globalThis as any).__echoGEPrivateCineDetected = true;
            return 1;
            /* Dead code — was returning items.length triggering decode failure:
            const frameCount = el.items.length;
            console.log(`[Echo GE inner ${tag}] items=${frameCount} → frames=${frameCount}`);
            for (let idx = 0; idx < Math.min(2, el.items.length); idx++) {
              const frameItem = el.items[idx];
              const fDs = frameItem?.dataSet;
              if (fDs) {
                const keys = Object.keys(fDs.elements);
                console.log(`[Echo GE seg#${idx}] elements: ${keys.join(',')}`);
                for (const k of keys) {
                  const e = fDs.elements[k];
                  console.log(`    ${k}: vr=${e.vr} len=${e.length} items=${e.items?.length ?? 0}`);
                  // Drill into 7FE1,1020 (the big pixel blob container)
                  if (k === 'x7fe11020' && e.items && e.items.length > 0) {
                    const inner1020 = e.items[0]?.dataSet;
                    if (inner1020) {
                      console.log(`    [7FE1,1020 item0] elements: ${Object.keys(inner1020.elements).join(',')}`);
                      for (const k2 of Object.keys(inner1020.elements)) {
                        const e2 = inner1020.elements[k2];
                        console.log(`        ${k2}: vr=${e2.vr} len=${e2.length} items=${e2.items?.length ?? 0} dataOffset=${e2.dataOffset}`);
                        // If it contains more sequences, peek one level deeper
                        if (e2.items && e2.items.length > 0 && e2.items.length <= 5) {
                          const deepDs = e2.items[0]?.dataSet;
                          if (deepDs) {
                            console.log(`            [${k2} item0] elements: ${Object.keys(deepDs.elements).join(',')}`);
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
            return frameCount;
            */
          }
        }
      }
    }
    if (!pd) return 1;
    // Encapsulated: items[] present (first is basic offset table)
    if (pd.items && pd.items.length > 0) {
      // items[0] = offset table (possibly empty). Frames = items.length - 1.
      const frames = Math.max(1, pd.items.length - 1);
      return frames;
    }
    // Non-encapsulated: scan for JPEG SOI (ff d8 ff) markers as fallback
    if (pd.dataOffset != null && pd.length > 0) {
      const bytes = ds.byteArray;
      let count = 0;
      const end = Math.min(bytes.length - 2, pd.dataOffset + pd.length);
      for (let i = pd.dataOffset; i < end - 2; i++) {
        if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) count++;
      }
      if (count > 1) return count;
    }
  } catch {}
  return 1;
}

function parseDopplerSpectralRegion(ds: any): DopplerSpectralRegion | null {
  try {
    const seq = ds.elements['x00186011'];
    if (!seq?.items?.length) return null;
    for (const item of seq.items) {
      const inner = item?.dataSet;
      if (!inner) continue;
      let dataType = 0;
      try { dataType = inner.uint16('x00186014') ?? 0; } catch {}
      // 3 = Spectral Doppler, 4 = Waveform
      if (dataType !== 3 && dataType !== 4) continue;
      const readU = (tag: string): number => {
        try {
          const el = inner.elements[tag];
          if (el && el.length >= 4) {
            const dv = new DataView(inner.byteArray.buffer, inner.byteArray.byteOffset + el.dataOffset, 4);
            return dv.getUint32(0, true);
          }
        } catch {}
        return 0;
      };
      const readS = (tag: string): number => {
        try {
          const el = inner.elements[tag];
          if (el && el.length >= 4) {
            const dv = new DataView(inner.byteArray.buffer, inner.byteArray.byteOffset + el.dataOffset, 4);
            return dv.getInt32(0, true);
          }
        } catch {}
        return 0;
      };
      const readF = (tag: string): number | null => {
        try {
          const el = inner.elements[tag];
          if (!el) return null;
          const vr = (el.vr || '').toUpperCase();
          if (vr === 'FD' && el.length >= 8) {
            const dv = new DataView(inner.byteArray.buffer, inner.byteArray.byteOffset + el.dataOffset, 8);
            return dv.getFloat64(0, true);
          }
          if (vr === 'FL' && el.length >= 4) {
            const dv = new DataView(inner.byteArray.buffer, inner.byteArray.byteOffset + el.dataOffset, 4);
            return dv.getFloat32(0, true);
          }
          const s = inner.string(tag); if (s) return parseFloat(s);
        } catch {}
        return null;
      };
      const x0 = readU('x00186018');
      const y0 = readU('x0018601a');
      const x1 = readU('x0018601c');
      const y1 = readU('x0018601e');
      const refPixelY0 = readS('x00186022');
      const unitY = (() => { try { return inner.uint16('x00186026') ?? 0; } catch { return 0; } })();
      const deltaY = readF('x0018602e');
      if (deltaY == null || deltaY === 0) continue;
      if (x1 <= x0 || y1 <= y0) continue;
      // refPixelY0 is relative to region origin — convert to absolute image-pixel Y
      const baselineAbsY = y0 + refPixelY0;
      // Convert deltaY to m/s per pixel. unitY: 4 = cm/s, 7 = m/s, 3 = cm (not velocity)
      let mpsPerImagePx: number;
      if (unitY === 7) mpsPerImagePx = Math.abs(deltaY);
      else if (unitY === 4) mpsPerImagePx = Math.abs(deltaY) / 100;
      else mpsPerImagePx = Math.abs(deltaY); // best-effort
      return { y0, y1, x0, x1, refPixelY0: baselineAbsY, unitY, deltaY, mpsPerImagePx };
    }
  } catch (e) {
    console.warn('[Echo doppler-region] parse fail', e);
  }
  return null;
}

function parseUSRegion(ds: any): EchoCalibration | null {
  try {
    const seq = ds.elements['x00186011'];
    if (!seq || !seq.items || seq.items.length === 0) {
      console.warn('[Echo] no SequenceOfUltrasoundRegions');
      return null;
    }
    // Collect all valid regions with area, pick largest
    const candidatesAll: Array<{ cal: EchoCalibration; type: number; area: number }> = [];
    for (const item of seq.items) {
      const innerDs = item.dataSet;
      if (!innerDs) continue;
      // PhysicalDeltaX (0018,602C) + PhysicalDeltaY (0018,602E) — FD (float64) in cm/pixel
      let dx: number | null = null;
      let dy: number | null = null;
      const readSpacing = (tag: string): number | null => {
        const el = innerDs.elements[tag];
        if (!el) return null;
        const vr = (el.vr || '').toUpperCase();
        const len = el.length;
        const candidates: Array<{ src: string; v: number }> = [];

        // Check declared VR first
        try {
          if (vr === 'FD' && len >= 8) {
            const dv = new DataView(innerDs.byteArray.buffer, innerDs.byteArray.byteOffset + el.dataOffset, 8);
            candidates.push({ src: 'FD', v: dv.getFloat64(0, true) });
          } else if (vr === 'FL' && len >= 4) {
            const dv = new DataView(innerDs.byteArray.buffer, innerDs.byteArray.byteOffset + el.dataOffset, 4);
            candidates.push({ src: 'FL', v: dv.getFloat32(0, true) });
          } else if (vr === 'DS' || !vr) {
            try {
              const s = innerDs.string(tag);
              if (s) candidates.push({ src: 'DS', v: parseFloat(s) });
            } catch {}
          }
        } catch {}

        // Also try as raw float64 if length=8 (standard FD)
        if (len === 8) {
          try {
            const dv = new DataView(innerDs.byteArray.buffer, innerDs.byteArray.byteOffset + el.dataOffset, 8);
            const v = dv.getFloat64(0, true);
            if (!candidates.some((c) => c.src === 'FD')) candidates.push({ src: 'FD-alt', v });
          } catch {}
        }
        // Try as string
        try {
          const s = innerDs.string(tag);
          if (s) {
            const n = parseFloat(s);
            if (!candidates.some((c) => c.src === 'DS')) candidates.push({ src: 'DS-alt', v: n });
          }
        } catch {}

        // Accept first finite positive value in sensible cm/px range
        for (const c of candidates) {
          if (Number.isFinite(c.v) && c.v > 0.00001 && c.v < 10) return c.v;
        }
        return null;
      };
      dx = readSpacing('x0018602c');
      dy = readSpacing('x0018602e');
      let unitsX = 3, unitsY = 3;
      try {
        const u = innerDs.uint16('x00186024');
        if (u != null) unitsX = u;
      } catch {}
      try {
        const u = innerDs.uint16('x00186026');
        if (u != null) unitsY = u;
      } catch {}
      // Region data type (0018,6014): 1 = tissue, skip scrolling waveform regions (2, 3, 4)
      let dataType = 1;
      try {
        const u = innerDs.uint16('x00186014');
        if (u != null) dataType = u;
      } catch {}
      // prefer tissue (1) but accept any valid positive dx/dy with unit cm (3) or mm
      const validUnit = (unitsX === 3 || unitsX === 0) && (unitsY === 3 || unitsY === 0);
      if (dx != null && dy != null && dx > 0 && dy > 0 && validUnit) {
        const toMm = (v: number, unit: number) => (unit === 3 ? v * 10 : v);
        const cal = { colSpacingMm: toMm(dx, unitsX), rowSpacingMm: toMm(dy, unitsY) };
        // Region bounds for area calc
        const readU = (tag: string): number => {
          try {
            const el = innerDs.elements[tag];
            if (el && el.length >= 4) {
              const dv = new DataView(innerDs.byteArray.buffer, innerDs.byteArray.byteOffset + el.dataOffset, 4);
              return dv.getUint32(0, true);
            }
          } catch {}
          return 0;
        };
        const x0 = readU('x00186018');
        const y0 = readU('x0018601a');
        const x1 = readU('x0018601c');
        const y1 = readU('x0018601e');
        const area = Math.max(0, (x1 - x0)) * Math.max(0, (y1 - y0));
        candidatesAll.push({ cal, type: dataType, area });
      }
    }
    if (candidatesAll.length === 0) return null;
    // Pick largest region — primary diagnostic view (handles M-mode, large 2D, spectral)
    const picked = candidatesAll.reduce((a, b) => (b.area > a.area ? b : a));
    console.log(`[Echo calibration picked] type=${picked.type} area=${picked.area} rowSpacingMm=${picked.cal.rowSpacingMm.toFixed(4)} colSpacingMm=${picked.cal.colSpacingMm.toFixed(4)}`);
    return picked.cal;
  } catch (e) {
    console.warn('[Echo] US region parse fail', e);
  }
  return null;
}

function parseOne(arrayBuffer: ArrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let ds: any;
  try {
    ds = dicomParser.parseDicom(bytes);
  } catch {
    try {
      const stream = new (dicomParser as any).ByteStream((dicomParser as any).littleEndianByteArrayParser, bytes, 0);
      ds = new (dicomParser as any).DataSet(stream.byteArrayParser, bytes, {});
      // Allow parsing to go beyond pixel data (7FE0) to find GE private cine groups (7FE1)
      (dicomParser as any).parseDicomDataSetImplicit(ds, stream, bytes.length, { untilTag: 'x7fe1ffff' });
    } catch {
      return null;
    }
  }
  const get = (tag: string) => { try { return ds.string(tag) || ''; } catch { return ''; } };
  const getInt = (tag: string) => { try { const v = ds.intString(tag); return v != null ? parseInt(String(v), 10) : null; } catch { return null; } };
  const getFloat = (tag: string) => { try { const v = ds.floatString(tag); return v != null ? Number(v) : null; } catch { return null; } };

  const inferred = inferFrameCount(ds);
  const stdRows = getInt('x00280010') || 0;
  const stdCols = getInt('x00280011') || 0;

  // Only invoke GE proprietary decoder when standard pixel data (7FE0,0010)
  // is absent OR empty. Otherwise Horos-style standard rendering produces
  // the correct image and the GE decoder only adds artifacts.
  const stdPd = ds.elements['x7fe00010'];
  const hasStdPixelData = !!stdPd && (
    (stdPd.items && stdPd.items.length > 1) ||
    (stdPd.length != null && stdPd.length > 0)
  );
  const stdFrames = Math.max(getInt('x00280008') || 1, inferred);
  const stdIsMultiframe = stdFrames > 1;

  // Always attempt GE proprietary decode. Then decide at route time:
  //   - Standard path if standard pixel data alone already yields >=
  //     GE frame count (regular single-frame or multi-frame DICOM).
  //   - GE path only when GE decoder produced strictly more frames than
  //     the standard block exposes (GE Vivid cines: standard holds 1
  //     preview frame, private 7FE1 block holds the full cine).
  void hasStdPixelData; void stdIsMultiframe;
  const geCineAttempt = parseGEVividCine(ds, { rows: stdRows, columns: stdCols });
  const geCine = (geCineAttempt && geCineAttempt.frames.length > stdFrames)
    ? geCineAttempt
    : null;

  return {
    seriesInstanceUID: get('x0020000e') || 'unknown',
    sopInstanceUID: get('x00080018') || '',
    seriesDescription: get('x0008103e') || get('x00081030') || '',
    studyDescription: get('x00081030') || '',
    studyDate: get('x00080020') || '',
    modality: get('x00080060') || 'US',
    patientName: get('x00100010') || '',
    rows: getInt('x00280010') || 0,
    columns: getInt('x00280011') || 0,
    samplesPerPixel: getInt('x00280002') || 1,
    photometricInterpretation: get('x00280004') || '',
    numberOfFrames: Math.max(getInt('x00280008') || 1, inferred),
    windowCenter: firstFloat(get('x00281050')) ?? getFloat('x00281050') ?? null,
    windowWidth: firstFloat(get('x00281051')) ?? getFloat('x00281051') ?? null,
    cineRate: getFloat('x00180040') ?? getInt('x00082144') ?? null,
    calibration: parseUSRegion(ds),
    dopplerRegion: parseDopplerSpectralRegion(ds),
    geCine,
  };
}

export async function loadEchoFiles(files: File[]): Promise<EchoSeriesInfo[]> {
  registerEchoProvider();
  registerGECineHandlers();

  interface Parsed {
    imageId: string;
    imageIds: string[];
    meta: NonNullable<ReturnType<typeof parseOne>>;
    hasGECineUndecoded: boolean;
    geCineDecoded: boolean;
    frameTimeMs: number | null;
  }
  const map = new Map<string, Parsed[]>();

  for (const file of files) {
    const buf = await file.arrayBuffer();
    let bytes = new Uint8Array(buf);
    const meta = parseOne(bytes.buffer);
    if (!meta) continue;

    const geCine: GECineResult | null = meta.geCine;
    const geDetectedFlag = !!(globalThis as any).__echoGEPrivateCineDetected;
    (globalThis as any).__echoGEPrivateCineDetected = false;

    let imageIds: string[];
    let baseId: string;
    let geCineDecoded = false;
    let frameTimeMs: number | null = null;

    if (geCine) {
      // Use reverse-engineered decoder path — register synthesized frames
      const sid = (crypto as any).randomUUID ? (crypto as any).randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);
      baseId = `geusmovie:${sid}`;
      imageIds = geCine.frames.map((_, i) => `${baseId}?frame=${i}`);
      const wc = meta.windowCenter ?? 127;
      const ww = meta.windowWidth ?? 255;
      // Prefer GE private FD spacing (often more accurate), fall back to US region calibration
      const psMm: [number, number] | null = geCine.gePixelSpacingMm
        ?? (meta.calibration ? [meta.calibration.rowSpacingMm, meta.calibration.colSpacingMm] : null);
      for (let i = 0; i < geCine.frames.length; i++) {
        storeGEFrame(imageIds[i], {
          data: geCine.frames[i],
          width: geCine.width,
          height: geCine.height,
          samplesPerPixel: geCine.samplesPerPixel,
          windowCenter: wc,
          windowWidth: ww,
          pixelSpacingMm: psMm,
          frameTimeMs: geCine.frameTimeMs,
        });
      }
      geCineDecoded = true;
      frameTimeMs = geCine.frameTimeMs;
      console.log(`[Echo] file=${file.name} GE cine DECODED: ${geCine.frames.length} frames ${geCine.width}x${geCine.height} spp=${geCine.samplesPerPixel} frameTime=${geCine.frameTimeMs.toFixed(1)}ms`);
    } else {
      let toLoad: Blob = file;
      if (!hasPart10Header(bytes)) {
        const wrapped = wrapPart10(bytes);
        toLoad = new Blob([wrapped], { type: 'application/dicom' });
      }
      const blobUrl = URL.createObjectURL(toLoad);
      baseId = `wadouri:${blobUrl}`;
      const nFrames = Math.max(1, meta.numberOfFrames);
      imageIds = nFrames > 1
        ? Array.from({ length: nFrames }, (_, i) => `${baseId}?frame=${i}`)
        : [baseId];
      console.log(`[Echo] file=${file.name} nFrames=${nFrames} (dicom tag/inferred=${meta.numberOfFrames}) geDetected=${geDetectedFlag} baseId=${baseId.substring(0, 80)}`);
    }

    // Cache calibration for every frame imageId so length tool gets correct spacing
    if (meta.calibration) {
      calibrationByImageId.set(baseId, meta.calibration);
      for (const id of imageIds) calibrationByImageId.set(id, meta.calibration);
    }
    if (meta.dopplerRegion) {
      dopplerByImageId.set(baseId, meta.dopplerRegion);
      for (const id of imageIds) dopplerByImageId.set(id, meta.dopplerRegion);
    }

    // Group per-file (SOP instance) — each cine clip is its own entry, not merged by series UID
    const uid = (meta as any).sopInstanceUID || `${meta.seriesInstanceUID}:${file.name}`;
    if (!map.has(uid)) map.set(uid, []);
    map.get(uid)!.push({
      imageId: baseId,
      imageIds,
      meta,
      hasGECineUndecoded: geDetectedFlag && !geCine,
      geCineDecoded,
      frameTimeMs,
    });
  }

  const out: EchoSeriesInfo[] = [];
  let clipIdx = 0;
  for (const [uid, parsed] of map) {
    clipIdx++;
    const allImageIds = parsed.flatMap((p) => p.imageIds);
    const first = parsed[0].meta;
    const pixelSpacingMm: [number, number] | null = first.calibration
      ? [first.calibration.rowSpacingMm, first.calibration.colSpacingMm]
      : null;
    const decoded = parsed.some((p) => p.geCineDecoded);
    const ftRaw = parsed.find((p) => p.frameTimeMs != null)?.frameTimeMs ?? null;
    const derivedCineRate = ftRaw != null && ftRaw > 0 ? 1000 / ftRaw : first.cineRate;
    const isMultiframe = allImageIds.length > 1;
    const baseDesc = first.seriesDescription || 'Unknown Series';
    const label = `${baseDesc} #${clipIdx} · ${isMultiframe ? 'cine' : 'still'}`;
    out.push({
      seriesInstanceUID: uid,
      seriesDescription: label,
      modality: first.modality || 'US',
      numImages: allImageIds.length,
      imageIds: allImageIds,
      patientName: first.patientName || 'Unknown',
      studyDescription: first.studyDescription || 'Unknown Study',
      studyDate: first.studyDate || '',
      rows: first.rows,
      columns: first.columns,
      samplesPerPixel: first.samplesPerPixel,
      photometricInterpretation: first.photometricInterpretation,
      windowCenter: first.windowCenter,
      windowWidth: first.windowWidth,
      cineRate: derivedCineRate ?? null,
      pixelSpacingMm,
      hasGEPrivateCine: parsed.some((p) => p.hasGECineUndecoded),
      geCineDecoded: decoded,
      frameTimeMs: ftRaw,
    });
  }
  out.sort((a, b) => b.numImages - a.numImages);
  return out;
}
