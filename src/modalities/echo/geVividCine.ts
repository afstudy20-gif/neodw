import * as cornerstone from '@cornerstonejs/core';

// GE Vivid/Logiq proprietary cine decoder (GEMS_Ultrasound_MovieGroup_001).
// Reverse-engineered from SlicerHeart (https://github.com/SlicerHeart/SlicerHeart)
// and GDCM Examples/Cxx/DumpGEMSMovieGroup.cxx. Works for 2D B-mode cine.
// 3D volumetric voxel format is NDA-protected — not decoded here.

export interface GEFrameMeta {
  data: Uint8Array;
  width: number;
  height: number;
  samplesPerPixel: 1 | 3;
  windowCenter: number;
  windowWidth: number;
  pixelSpacingMm: [number, number] | null;
  frameTimeMs: number;
}

export interface GECineResult {
  width: number;
  height: number;
  samplesPerPixel: 1 | 3;
  frames: Uint8Array[];
  frameTimeMs: number;
  gePixelSpacingMm: [number, number] | null;
}

const frameStore = new Map<string, GEFrameMeta>();

const GE_CREATOR_VARIANTS = [
  'GEMS_Ultrasound_MovieGroup_001',
  'GEMS_Ultrasound_MovieGroup_002',
  'GEMS_Ultrasound_MovieGroup_003',
  'GEMS_Ultrasound_ImageGroup_001',
  'GEMS_Ultrasound_ImageGroup_002',
  'GE_VIVID_MOVIE_001',
  'GEMS_Ultrasound_ExamGroup_001',
];

function findCreatorByte(ds: any, creatorName: string): number | null {
  for (const key of Object.keys(ds.elements)) {
    if (!key.startsWith('x7fe1')) continue;
    const elemLow = parseInt(key.slice(5), 16);
    if (elemLow < 0x10 || elemLow > 0xff) continue;
    const el = ds.elements[key];
    const vr = (el.vr || '').toUpperCase();
    if (vr !== 'LO') continue;
    try {
      const s = ds.string(key);
      if (s && s.trim().toLowerCase().includes(creatorName.toLowerCase())) return elemLow;
    } catch {}
  }
  return null;
}

function tag(creatorByte: number, nn: number): string {
  const elem = (creatorByte << 8) | nn;
  return 'x7fe1' + elem.toString(16).padStart(4, '0');
}

export function parseGEVividCine(ds: any, hint?: { rows?: number; columns?: number }): GECineResult | null {
  let cb: number | null = null;
  for (const variant of GE_CREATOR_VARIANTS) {
    cb = findCreatorByte(ds, variant);
    if (cb != null) {
      console.log(`[GE cine] found creator '${variant}' at index 0x${cb.toString(16)}`);
      break;
    }
  }

  if (cb == null) {
    // Brute-force fallback: look for ANY group 7FE1 sequence that starts with 1001 or 1101
    // and contains a Voxel Data Group (xx36).
    for (let b = 0x10; b <= 0x1f; b++) {
      const movieTag = 'x7fe1' + ((b << 8) | 0x01).toString(16).padStart(4, '0');
      const voxelTag = 'x7fe1' + ((b << 8) | 0x36).toString(16).padStart(4, '0');
      if (ds.elements[movieTag] && ds.elements[voxelTag]) {
        cb = b;
        console.log(`[GE cine] brute-force found plausible block at index 0x${cb.toString(16)} (missing LO creator)`);
        break;
      }
    }
    if (cb == null) return null;
  }
  
  return parseWithCreator(ds, cb, hint);
}

function readU32(innerDs: any, el: any): number {
  const offset = innerDs.byteArray.byteOffset + el.dataOffset;
  const dv = new DataView(innerDs.byteArray.buffer, offset, Math.min(el.length, 4));
  return dv.getUint32(0, true);
}

function readF64Array(innerDs: any, el: any, maxCount: number): number[] {
  const offset = innerDs.byteArray.byteOffset + el.dataOffset;
  const count = Math.min(maxCount, Math.floor(el.length / 8));
  const dv = new DataView(innerDs.byteArray.buffer, offset, count * 8);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(dv.getFloat64(i * 8, true));
  return out;
}

function readString(ds: any, tagName: string): string {
  try {
    return (ds.string?.(tagName) || '').trim();
  } catch {
    return '';
  }
}

function getFirstNestedDataSet(ds: any, tagName: string): any | null {
  const seq = ds.elements?.[tagName];
  const item = seq?.items?.[0];
  return item?.dataSet ?? null;
}

function getMovieLevel2DataSet(rootItem: any, t: (nn: number) => string): any | null {
  const level1 = getFirstNestedDataSet(rootItem, t(0x10));
  if (!level1) return null;
  return getFirstNestedDataSet(level1, t(0x20));
}

function detect3DMovieGroup(rootItem: any, t: (nn: number) => string): boolean {
  const imageType = readString(rootItem, t(0x02));
  if (imageType && imageType.toUpperCase().includes('3D')) return true;

  const level2 = getMovieLevel2DataSet(rootItem, t);
  const image2dSeq = level2?.elements?.[t(0x26)];
  for (const item of image2dSeq?.items ?? []) {
    const inner = item?.dataSet;
    const value = readString(inner, t(0x02));
    if (value && value.toUpperCase().includes('3D')) return true;
  }

  return false;
}

function collectStructuredDimensionCandidates(level2: any, t: (nn: number) => string): Array<{ w: number; h: number; src: string }> {
  const out: Array<{ w: number; h: number; src: string }> = [];
  const image2dSeq = level2?.elements?.[t(0x26)];
  for (const [index, item] of (image2dSeq?.items ?? []).entries()) {
    const inner = item?.dataSet;
    const sizeEl = inner?.elements?.[t(0x86)];
    if (!sizeEl) continue;
    const vr = (sizeEl.vr || '').toUpperCase();
    const wordSize = vr === 'US' || vr === 'SS' ? 2 : 4;
    const count = Math.floor(sizeEl.length / wordSize);
    if (count < 2) continue;
    try {
      const off = inner.byteArray.byteOffset + sizeEl.dataOffset;
      const dv = new DataView(inner.byteArray.buffer, off, count * wordSize);
      const a = wordSize === 2
        ? (vr === 'SS' ? dv.getInt16(0, true) : dv.getUint16(0, true))
        : (vr === 'SL' ? dv.getInt32(0, true) : dv.getUint32(0, true));
      const b = wordSize === 2
        ? (vr === 'SS' ? dv.getInt16(wordSize, true) : dv.getUint16(wordSize, true))
        : (vr === 'SL' ? dv.getInt32(wordSize, true) : dv.getUint32(wordSize, true));
      if (a > 16 && a < 8192 && b > 16 && b < 8192) {
        out.push({ w: a, h: b, src: `structured:${t(0x86)}#${index + 1}` });
      }
    } catch {}
  }
  return out;
}

function getStructuredVoxelGroups(level2: any, t: (nn: number) => string): any[] {
  const out: any[] = [];
  const voxelDataSeq = level2?.elements?.[t(0x36)];
  for (const item of voxelDataSeq?.items ?? []) {
    const inner = item?.dataSet;
    if (inner?.elements?.[t(0x60)]) out.push(inner);
  }
  return out;
}

// Recursive: collect ALL plausible dimension pairs from any SL/UL×N array in the subtree.
function collectDimensionCandidates(ds: any, out: Array<{ w: number; h: number; src: string }> = [], singles: Array<{ v: number; src: string }> = [], depth = 0): Array<{ w: number; h: number; src: string }> {
  if (depth > 6) return out;
  for (const key of Object.keys(ds.elements || {})) {
    const el = ds.elements[key];
    const vr = (el.vr || '').toUpperCase();
    if ((vr === 'SL' || vr === 'UL' || vr === 'US' || vr === 'SS') && el.length >= 4 && el.length <= 64) {
      const wordSize = (vr === 'US' || vr === 'SS') ? 2 : 4;
      const count = Math.floor(el.length / wordSize);
      const arr: number[] = [];
      try {
        const off = ds.byteArray.byteOffset + el.dataOffset;
        const dv = new DataView(ds.byteArray.buffer, off, count * wordSize);
        for (let i = 0; i < count; i++) {
          arr.push(wordSize === 2
            ? (vr === 'SS' ? dv.getInt16(i * 2, true) : dv.getUint16(i * 2, true))
            : (vr === 'UL' ? dv.getUint32(i * 4, true) : dv.getInt32(i * 4, true)));
        }
      } catch { continue; }
      if (count === 1) {
        const v = arr[0];
        if (v > 16 && v < 8192) singles.push({ v, src: key });
        continue;
      }
      const pairs: Array<[number, number]> = [];
      if (count >= 2) { pairs.push([0, 1]); pairs.push([1, 0]); }
      if (count >= 4) { pairs.push([2, 3]); pairs.push([3, 2]); }
      if (count >= 3) { pairs.push([1, 2]); pairs.push([2, 1]); }
      for (const [i, j] of pairs) {
        const w = arr[i];
        const h = arr[j];
        if (w > 16 && w < 8192 && h > 16 && h < 8192) {
          out.push({ w, h, src: `${key}[${i},${j}]` });
        }
      }
    }
    if (el.items && el.items.length) {
      for (const item of el.items) {
        if (item.dataSet) collectDimensionCandidates(item.dataSet, out, singles, depth + 1);
      }
    }
  }
  return out;
}

// Find voxel data group(s): element xx36 SQ with items containing xx37 (count), xx60 (pixels).
function findVoxelGroups(ds: any, t: (nn: number) => string, out: any[] = [], depth = 0): any[] {
  if (depth > 5) return out;
  const vdg = ds.elements?.[t(0x36)];
  if (vdg?.items?.length) {
    for (const item of vdg.items) {
      if (item.dataSet?.elements?.[t(0x60)]) out.push(item.dataSet);
    }
  }
  for (const key of Object.keys(ds.elements || {})) {
    const el = ds.elements[key];
    if (el.items && el.items.length) {
      for (const item of el.items) {
        if (item.dataSet) findVoxelGroups(item.dataSet, t, out, depth + 1);
      }
    }
  }
  return out;
}

function parseWithCreator(ds: any, cb: number, hint?: { rows?: number; columns?: number }): GECineResult | null {
  const t = (nn: number) => tag(cb, nn);
  const root = ds.elements[t(0x01)];
  if (!root?.items?.length) return null;
  const rootItem = root.items[0].dataSet;
  if (!rootItem) return null;
  if (detect3DMovieGroup(rootItem, t)) {
    console.warn('[GE cine] movie group advertises 3D content; skipping 2D decoder');
    return null;
  }

  const level2 = getMovieLevel2DataSet(rootItem, t);
  const dimCandidates = [
    ...collectStructuredDimensionCandidates(level2, t),
    ...collectDimensionCandidates(rootItem),
  ];
  if (hint?.rows && hint?.columns) {
    dimCandidates.unshift({ w: hint.columns, h: hint.rows, src: 'dicom_hint' });
  }
  
  const commonGE = [
    { w: 640, h: 480 }, { w: 480, h: 640 },
    { w: 768, h: 576 }, { w: 576, h: 768 },
    { w: 800, h: 600 }, { w: 600, h: 800 },
    { w: 1024, h: 768 }, { w: 768, h: 1024 },
    { w: 1024, h: 1024 }, { w: 512, h: 512 }
  ];
  for (const c of commonGE) {
    if (!dimCandidates.some(a => a.w === c.w && a.h === c.h)) {
      dimCandidates.push({ ...c, src: 'common_ge' });
    }
  }

  const voxelGroups = [
    ...getStructuredVoxelGroups(level2, t),
    ...findVoxelGroups(rootItem, t),
  ];
  if (voxelGroups.length === 0) return null;

  let best: {
    g: any;
    width: number;
    height: number;
    samplesPerPixel: 1 | 3;
    frameCount: number;
    bytesPerFrame: number;
    pixEl: any;
    score: number;
  } | null = null;

  const measureRowSmoothness = (g: any, pixEl: any, frameOffset: number, W: number, H: number): number => {
    const off = g.byteArray.byteOffset + pixEl.dataOffset + frameOffset;
    if (off + (W * H) > g.byteArray.length) return 999999;
    const buf = new Uint8Array(g.byteArray.buffer, off, W * H);
    let sum = 0;
    const sampleRows = Math.min(H - 1, 60);
    const sampleCols = Math.min(W, 80);
    const rowStep = Math.max(1, Math.floor((H - 1) / sampleRows));
    const colStep = Math.max(1, Math.floor(W / sampleCols));
    let n = 0;
    for (let r = 0; r < H - 1; r += rowStep) {
      for (let c = 0; c < W; c += colStep) {
        const a = buf[r * W + c];
        const b = buf[(r + 1) * W + c];
        sum += (a - b) * (a - b);
        n++;
      }
    }
    return n > 0 ? sum / n : 999999;
  };

  // Column smoothness: adjacent pixels within a row (horizontal).
  const measureColSmoothness = (g: any, pixEl: any, frameOffset: number, W: number, H: number): number => {
    const off = g.byteArray.byteOffset + pixEl.dataOffset + frameOffset;
    if (off + (W * H) > g.byteArray.length) return 999999;
    const buf = new Uint8Array(g.byteArray.buffer, off, W * H);
    let sum = 0;
    const sampleRows = Math.min(H, 60);
    const sampleCols = Math.min(W - 1, 80);
    const rowStep = Math.max(1, Math.floor(H / sampleRows));
    const colStep = Math.max(1, Math.floor((W - 1) / sampleCols));
    let n = 0;
    for (let r = 0; r < H; r += rowStep) {
      for (let c = 0; c < W - 1; c += colStep) {
        const a = buf[r * W + c];
        const b = buf[r * W + c + 1];
        sum += (a - b) * (a - b);
        n++;
      }
    }
    return n > 0 ? sum / n : 999999;
  };

  for (const g of voxelGroups) {
    const cntEl = g.elements[tag(cb, 0x37)];
    const pixEl = g.elements[tag(cb, 0x60)];
    if (!pixEl) continue;
    const declaredCount = cntEl ? readU32(g, cntEl) : 0;
    const bufLen = pixEl.length;

    const allCands: Array<{ w: number; h: number; src: string }> = [...dimCandidates];
    if (declaredCount > 0 && bufLen % declaredCount === 0) {
      const bpf = bufLen / declaredCount;
      for (let w = 80; w * w <= bpf * 2; w++) {
        if (bpf % w === 0) {
          const h = bpf / w;
          if (h >= 64 && h <= 4096 && w <= 4096) {
            allCands.push({ w, h, src: `factor(${bpf})` });
            allCands.push({ w: h, h: w, src: `factor(${bpf})_T` });
          }
        }
      }
    }

    const candidateScores: Array<{ cand: any; spp: number; count: number; score: number; smoothness: number; colSmoothness: number }> = [];

    for (const cand of allCands) {
      const { w, h } = cand;
      const grayFrame = w * h;
      const rgbFrame = w * h * 3;
      for (const [spp, frameSize] of [[1, grayFrame], [3, rgbFrame]] as const) {
        if (bufLen % frameSize !== 0) continue;
        const count = bufLen / frameSize;
        if (count < 1 || count > 10000) continue;
        
        let score = 0;
        if (declaredCount && count === declaredCount) score += 100;
        if (hint?.rows && hint?.columns) {
          if (w === hint.columns && h === hint.rows) score += 50;
        }

        const ar = h / w;
        if (ar >= 0.5 && ar <= 2.0) score += 10;
        
        let smoothness = 999999;
        let colSmoothness = 999999;
        if (spp === 1 && count >= 1) {
          try {
            smoothness = measureRowSmoothness(g, pixEl, 0, w, h);
            colSmoothness = measureColSmoothness(g, pixEl, 0, w, h);
            // Sum row + col smoothness — natural image has BOTH low. Transposed stride = one high.
            const combined = smoothness + colSmoothness;
            score += Math.max(0, 4000 - combined);
          } catch {}
        }
        candidateScores.push({ cand, spp: spp as 1|3, count, score, smoothness, colSmoothness });
      }
    }

    candidateScores.sort((a, b) => b.score - a.score);
    if (candidateScores.length > 0) {
      console.log(`[GE cine] top candidates:`);
      candidateScores.slice(0, 5).forEach((cs, i) => {
        console.log(`  #${i+1}: ${cs.cand.w}x${cs.cand.h} spp=${cs.spp} count=${cs.count} score=${cs.score.toFixed(0)} rowSm=${cs.smoothness.toFixed(0)} colSm=${cs.colSmoothness.toFixed(0)} (${cs.cand.src})`);
      });
      
      const winner = candidateScores[0];
      if (!best || winner.score > best.score) {
        best = { 
          g, 
          width: winner.cand.w, 
          height: winner.cand.h, 
          samplesPerPixel: winner.spp, 
          frameCount: winner.count, 
          bytesPerFrame: winner.cand.w * winner.cand.h * winner.spp, 
          pixEl, 
          score: winner.score 
        };
      }
    }
  }

  if (!best) return null;

  const frames: Uint8Array[] = [];
  const srcOffset = best.g.byteArray.byteOffset + best.pixEl.dataOffset;
  const srcBuf = new Uint8Array(best.g.byteArray.buffer, srcOffset, best.pixEl.length);
  for (let f = 0; f < best.frameCount; f++) {
    const start = f * best.bytesPerFrame;
    frames.push(new Uint8Array(srcBuf.slice(start, start + best.bytesPerFrame)));
  }

  let frameTimeMs = 33;
  const tsEl = best.g.elements[tag(cb, 0x43)];
  if (tsEl && tsEl.length >= 16 && best.frameCount >= 2) {
    const ts = readF64Array(best.g, tsEl, best.frameCount);
    if (ts.length >= 2) {
      const dt = Math.abs(ts[1] - ts[0]);
      if (dt > 0.0001 && dt < 10) frameTimeMs = dt * 1000;
    }
  }

  // Scan GE private FD arrays for pixel spacing (usually stored as m/pixel; typical values 1e-5 to 1e-3).
  const gePixelSpacingMm = scanGEPixelSpacing(rootItem);
  if (gePixelSpacingMm) {
    console.log(`[GE cine] FD spacing rowMm=${gePixelSpacingMm[0].toFixed(4)} colMm=${gePixelSpacingMm[1].toFixed(4)}`);
  }

  // GE Vivid stores cine buffer rotated vs clinical display. Transpose + swap W/H.
  const srcW = best.width;
  const srcH = best.height;
  const spp = best.samplesPerPixel;
  const outW = srcH;
  const outH = srcW;
  const transposedFrames: Uint8Array[] = [];
  for (const src of frames) {
    const dst = new Uint8Array(src.length);
    if (spp === 1) {
      for (let r = 0; r < outH; r++) {
        for (let c = 0; c < outW; c++) {
          dst[r * outW + c] = src[c * srcW + r];
        }
      }
    } else {
      for (let r = 0; r < outH; r++) {
        for (let c = 0; c < outW; c++) {
          const dOff = (r * outW + c) * 3;
          const sOff = (c * srcW + r) * 3;
          dst[dOff] = src[sOff];
          dst[dOff + 1] = src[sOff + 1];
          dst[dOff + 2] = src[sOff + 2];
        }
      }
    }
    transposedFrames.push(dst);
  }

  // After transpose row/col spacing also swap
  const outPixelSpacingMm: [number, number] | null = gePixelSpacingMm
    ? [gePixelSpacingMm[1], gePixelSpacingMm[0]]
    : null;

  console.log(`[GE cine] decode: buffer ${srcW}x${srcH} → display ${outW}x${outH} (transposed) spacing=${outPixelSpacingMm?.map((v) => v.toFixed(4)).join('x') ?? 'null'}`);
  return {
    width: outW,
    height: outH,
    samplesPerPixel: best.samplesPerPixel,
    frames: transposedFrames,
    frameTimeMs,
    gePixelSpacingMm: outPixelSpacingMm,
  };
}

// Scan all FD elements recursively. Return [rowMm, colMm] if finds plausible 2-value FD array.
// GE stores spacing in METERS (typical 1e-5..1e-3). Convert to mm.
function scanGEPixelSpacing(ds: any, depth = 0): [number, number] | null {
  if (depth > 6) return null;
  const candidates: Array<{ values: number[]; src: string }> = [];
  const walk = (d: any, lvl: number) => {
    if (lvl > 6) return;
    for (const key of Object.keys(d.elements || {})) {
      const el = d.elements[key];
      const vr = (el.vr || '').toUpperCase();
      if (vr === 'FD' && el.length >= 16 && el.length <= 64) {
        try {
          const off = d.byteArray.byteOffset + el.dataOffset;
          const count = Math.floor(el.length / 8);
          const dv = new DataView(d.byteArray.buffer, off, count * 8);
          const values: number[] = [];
          for (let i = 0; i < count; i++) values.push(dv.getFloat64(i * 8, true));
          candidates.push({ values, src: key });
        } catch {}
      }
      if (el.items && el.items.length) {
        for (const item of el.items) {
          if (item.dataSet) walk(item.dataSet, lvl + 1);
        }
      }
    }
  };
  walk(ds, depth);

  // Pick arrays with exactly 2 or 3 values, all in typical spacing range.
  for (const c of candidates) {
    const vals = c.values.filter((v) => v > 1e-6 && v < 1e-2);
    if (vals.length >= 2) {
      const a = vals[0];
      const b = vals[1];
      console.log(`[GE cine] FD spacing candidate ${c.src}: ${c.values.map((v) => v.toExponential(3)).join(', ')}`);
      return [a * 1000, b * 1000]; // meters → mm
    }
  }
  return null;
}

let loaderRegistered = false;
let providerRegistered = false;

export function registerGECineHandlers() {
  if (!loaderRegistered) {
    const imageLoader: any = (cornerstone as any).imageLoader;
    imageLoader.registerImageLoader('geusmovie', geusmovieLoader);
    loaderRegistered = true;
    console.log('[GE cine] loader registered (geusmovie:)');
  }
  if (!providerRegistered) {
    cornerstone.metaData.addProvider(geusmovieMetaProvider, 10000);
    providerRegistered = true;
  }
}

function geusmovieLoader(imageId: string) {
  const promise = new Promise<any>((resolve, reject) => {
    const frame = frameStore.get(imageId);
    if (!frame) {
      reject(new Error(`GE cine frame not found: ${imageId}`));
      return;
    }
    const { data, width, height, samplesPerPixel } = frame;
    const isColor = samplesPerPixel === 3;

    const image = {
      imageId,
      minPixelValue: 0,
      maxPixelValue: 255,
      slope: 1,
      intercept: 0,
      windowCenter: frame.windowCenter,
      windowWidth: frame.windowWidth,
      getPixelData: () => data,
      rows: height,
      columns: width,
      height,
      width,
      color: isColor,
      rgba: false,
      numberOfComponents: samplesPerPixel,
      // Keep raster display square; calibration is delivered by metadata provider.
      columnPixelSpacing: 1,
      rowPixelSpacing: 1,
      invert: false,
      sizeInBytes: data.byteLength,
      photometricInterpretation: isColor ? 'RGB' : 'MONOCHROME2',
      bitsAllocated: 8,
      bitsStored: 8,
      highBit: 7,
      pixelRepresentation: 0,
      samplesPerPixel,
      dataType: 'Uint8Array',
      voiLUTFunction: 'LINEAR',
    };
    resolve(image);
  });
  return { promise };
}

function geusmovieMetaProvider(type: string, imageId: string) {
  if (typeof imageId !== 'string' || !imageId.startsWith('geusmovie:')) return undefined;
  const frame = frameStore.get(imageId);
  if (!frame) return undefined;
  const rs = frame.pixelSpacingMm?.[0] ?? 1;
  const cs = frame.pixelSpacingMm?.[1] ?? 1;

  if (type === 'imagePixelModule') {
    return {
      samplesPerPixel: frame.samplesPerPixel,
      photometricInterpretation: frame.samplesPerPixel === 3 ? 'RGB' : 'MONOCHROME2',
      rows: frame.height,
      columns: frame.width,
      bitsAllocated: 8,
      bitsStored: 8,
      highBit: 7,
      pixelRepresentation: 0,
      planarConfiguration: 0,
      smallestPixelValue: 0,
      largestPixelValue: 255,
      redPaletteColorLookupTableDescriptor: undefined,
    };
  }
  if (type === 'voiLutModule') {
    return { windowCenter: [frame.windowCenter], windowWidth: [frame.windowWidth] };
  }
  if (type === 'modalityLutModule') {
    return { rescaleIntercept: 0, rescaleSlope: 1, rescaleType: 'US' };
  }
  if (type === 'generalSeriesModule') {
    return { modality: 'US', seriesNumber: 1, seriesDescription: 'GE Cine' };
  }
  if (type === 'imagePlaneModule') {
    return {
      rows: frame.height,
      columns: frame.width,
      // Keep displayed cine in native raster aspect; use calibratedPixelSpacing
      // below for measurements.
      rowPixelSpacing: 1,
      columnPixelSpacing: 1,
      pixelSpacing: [1, 1],
      rowCosines: [1, 0, 0],
      columnCosines: [0, 1, 0],
      imagePositionPatient: [0, 0, 0],
      imageOrientationPatient: [1, 0, 0, 0, 1, 0],
      frameOfReferenceUID: 'ge-us-' + imageId,
      sliceThickness: 1,
      sliceLocation: 0,
    };
  }
  if (type === 'calibratedPixelSpacing') {
    return { rowPixelSpacing: rs, columnPixelSpacing: cs };
  }
  return undefined;
}

export function storeGEFrame(imageId: string, frame: GEFrameMeta) {
  frameStore.set(imageId, frame);
}

export function clearGEFrames() {
  frameStore.clear();
}
