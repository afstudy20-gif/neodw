/**
 * Pseudo-PCCT post-processing filters for single-energy CT data.
 *
 * IMPORTANT — clinical disclaimer
 * ─────────────────────────────────
 * Genuine PCCT clinical tools (VNCa, VMI, K-edge, iodine maps) require
 * energy-resolved photon-counting data that single-energy CT does not
 * carry. These functions are PURELY VISUAL APPROXIMATIONS using
 * HU-threshold heuristics and intensity remapping. Output is for
 * education and visualisation only and MUST NOT be used for diagnosis
 * or any clinical decision.
 *
 * All algorithms operate on a single 2D slice (Int16Array of HU). The
 * caller extracts the slice from a Cornerstone3D volume and renders the
 * processed output to a side canvas — the source volume is never
 * mutated.
 */

export interface SliceView {
  /** HU values, length = width * height. */
  data: Int16Array;
  width: number;
  height: number;
}

/**
 * Pseudo-VNCa (Virtual Non-Calcium) approximation.
 *
 * Pipeline:
 *   1. Build a binary mask of voxels with HU ≥ threshold (calcium-like).
 *   2. Dilate the mask by `dilation` pixels so the bright halo around
 *      a calcified lesion is also suppressed.
 *   3. Replace each masked voxel with the median of its non-masked
 *      neighbours inside a (2*radius+1)^2 window. If every neighbour is
 *      itself masked, fall back to a soft-tissue baseline (40 HU).
 *
 * The 3×3 median inpaint is intentionally simple — it is not a true
 * diffusion-based inpainting algorithm, just a fast heuristic. Result
 * resembles a "calcium subtraction" image at a distance but lacks the
 * spectral fidelity of genuine VNCa.
 */
export function pseudoVNCa(
  slice: SliceView,
  options: { thresholdHU?: number; dilation?: number; medianRadius?: number } = {}
): Int16Array {
  const { thresholdHU = 300, dilation = 1, medianRadius = 1 } = options;
  const { data, width, height } = slice;
  const n = width * height;

  // 1. binary mask
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    if (data[i] >= thresholdHU) mask[i] = 1;
  }

  // 2. dilation (square structuring element)
  for (let pass = 0; pass < dilation; pass += 1) {
    const next = new Uint8Array(mask);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const idx = y * width + x;
        if (mask[idx]) continue;
        let neighbour = 0;
        for (let dy = -1; dy <= 1 && !neighbour; dy += 1) {
          for (let dx = -1; dx <= 1 && !neighbour; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            if (mask[ny * width + nx]) neighbour = 1;
          }
        }
        if (neighbour) next[idx] = 1;
      }
    }
    mask.set(next);
  }

  // 3. median inpaint of masked voxels
  const out = new Int16Array(data);
  const window: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      if (!mask[idx]) continue;
      window.length = 0;
      for (let dy = -medianRadius; dy <= medianRadius; dy += 1) {
        for (let dx = -medianRadius; dx <= medianRadius; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const j = ny * width + nx;
          if (!mask[j]) window.push(data[j]);
        }
      }
      if (window.length === 0) {
        out[idx] = 40; // soft-tissue baseline fallback
      } else {
        window.sort((a, b) => a - b);
        out[idx] = window[window.length >> 1];
      }
    }
  }
  return out;
}

/**
 * Pseudo Low-keV VMI (40-50 keV virtual mono-energetic look).
 *
 * Genuine VMI uses material-decomposed iodine and water maps from a
 * dual-energy or photon-counting acquisition to synthesise an image
 * at an arbitrary energy. We do not have those maps, so we mimic the
 * *visual* effect of a low-keV scan — soft-tissue iodine appears
 * brighter, bone gets a touch hotter, air stays air — by applying a
 * sigmoid HU remap centered on the iodine band (~120 HU).
 *
 * `boost` ∈ [0..1] controls how aggressive the iodine band lift is.
 * 0 = identity, 1 = ~80 HU added at the iodine peak.
 */
export function pseudoLowKevVMI(
  slice: SliceView,
  options: { boost?: number; center?: number; bandwidth?: number } = {}
): Int16Array {
  const { boost = 0.6, center = 120, bandwidth = 200 } = options;
  const { data } = slice;
  const out = new Int16Array(data.length);
  // Gain that decays away from `center` over `bandwidth`. Capped at +160 HU
  // so we never push intensities past a plausible iodine bump.
  const peakGain = boost * 160;
  for (let i = 0; i < data.length; i += 1) {
    const hu = data[i];
    const z = (hu - center) / bandwidth;
    const w = 1 / (1 + z * z);
    out[i] = (hu + peakGain * w) | 0;
  }
  return out;
}

/**
 * Calcium-bloom reduction. Calcified voxels in conventional CT spread
 * a bright halo into surrounding lumen because of finite spatial
 * resolution and beam-hardening. We can't undo the physics from a
 * single-energy reconstruction but we can sharpen the edge by an
 * unsharp-mask localised to the high-HU mask.
 *
 *   sharpened = pixel + amount * (pixel - blurred)   (when mask is set)
 *
 * `amount` ∈ [0..1.5]. Larger values pull the halo into a tighter
 * silhouette but can introduce ringing.
 */
export function calciumBloomReduction(
  slice: SliceView,
  options: { thresholdHU?: number; amount?: number; radius?: number } = {}
): Int16Array {
  const { thresholdHU = 300, amount = 0.8, radius = 2 } = options;
  const { data, width, height } = slice;
  const n = width * height;

  // mask around bright voxels (dilated once so the halo is included)
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    if (data[i] >= thresholdHU) mask[i] = 1;
  }
  // dilate by `radius` so the halo is treated alongside the calcium core
  for (let pass = 0; pass < radius; pass += 1) {
    const next = new Uint8Array(mask);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const idx = y * width + x;
        if (mask[idx]) continue;
        let neighbour = 0;
        for (let dy = -1; dy <= 1 && !neighbour; dy += 1) {
          for (let dx = -1; dx <= 1 && !neighbour; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            if (mask[ny * width + nx]) neighbour = 1;
          }
        }
        if (neighbour) next[idx] = 1;
      }
    }
    mask.set(next);
  }

  // simple box-blur (radius `radius`) of the source
  const blur = boxBlur(data, width, height, radius);

  // unsharp mask, applied only where the mask is set
  const out = new Int16Array(data);
  for (let i = 0; i < n; i += 1) {
    if (!mask[i]) continue;
    const sharpened = data[i] + amount * (data[i] - blur[i]);
    out[i] = Math.max(-1024, Math.min(3071, sharpened)) | 0;
  }
  return out;
}

function boxBlur(src: Int16Array, width: number, height: number, radius: number): Int16Array {
  // Separable box-blur: horizontal pass into tmp, vertical pass into dst.
  const tmp = new Int32Array(src.length);
  const dst = new Int16Array(src.length);
  const window = radius * 2 + 1;

  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    const rowStart = y * width;
    // prime with the first `radius` columns mirrored
    for (let i = -radius; i <= radius; i += 1) {
      const x = Math.max(0, Math.min(width - 1, i));
      sum += src[rowStart + x];
    }
    for (let x = 0; x < width; x += 1) {
      tmp[rowStart + x] = (sum / window) | 0;
      const addX = Math.min(width - 1, x + radius + 1);
      const dropX = Math.max(0, x - radius);
      sum += src[rowStart + addX] - src[rowStart + dropX];
    }
  }

  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let j = -radius; j <= radius; j += 1) {
      const y = Math.max(0, Math.min(height - 1, j));
      sum += tmp[y * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      dst[y * width + x] = (sum / window) | 0;
      const addY = Math.min(height - 1, y + radius + 1);
      const dropY = Math.max(0, y - radius);
      sum += tmp[addY * width + x] - tmp[dropY * width + x];
    }
  }
  return dst;
}

/**
 * Convert an HU slice to an 8-bit grayscale ImageData using a
 * window/level pair (W = window width, L = window center).
 */
export function huToImageData(
  slice: { data: Int16Array; width: number; height: number },
  windowCenter: number,
  windowWidth: number
): ImageData {
  const { data, width, height } = slice;
  const out = new Uint8ClampedArray(width * height * 4);
  const lo = windowCenter - windowWidth / 2;
  const range = windowWidth || 1;
  for (let i = 0; i < data.length; i += 1) {
    let v = ((data[i] - lo) * 255) / range;
    if (v < 0) v = 0;
    else if (v > 255) v = 255;
    const o = i * 4;
    out[o] = v;
    out[o + 1] = v;
    out[o + 2] = v;
    out[o + 3] = 255;
  }
  return new ImageData(out, width, height);
}
