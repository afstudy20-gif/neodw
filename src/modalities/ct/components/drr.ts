/**
 * DRR — digitally reconstructed radiograph (X-ray fluoroscopy simulation).
 *
 * A radiograph is the line integral of X-ray attenuation along each ray:
 *
 *     S(u, v) = ∫ μ(HU(x)) dl
 *
 * We realise this physically on the GPU with VTK.js's ADDITIVE_INTENSITY_BLEND
 * volume ray-cast: the mapper accumulates colour·opacity at each sample along the
 * ray. Mapping the colour to a flat white ramp and the opacity to μ(HU) makes the
 * accumulated value proportional to ∫μ dl — a true attenuation projection, from
 * whatever direction the camera points (arbitrary-angle fluoroscopy). Denser
 * tissue accumulates more, so bone is bright on a black field, matching a
 * fluoroscopy/DRR positive.
 *
 * Cornerstone's BlendModes enum does not expose additive blend, so the caller
 * sets it on the underlying vtk mapper directly (setBlendModeToAdditiveIntensity
 * / setBlendMode(4)). This module holds the pure, GPU-independent math so it can
 * be unit-tested without a WebGL context.
 */

/** HU at/below which a voxel is air and contributes no attenuation. */
export const DRR_HU_AIR = -1000;

/** HU control points spanning the CT range for the attenuation transfer function. */
export const DRR_HU_POINTS = [-1000, -500, -200, 0, 200, 500, 1000, 2000, 3071];

/**
 * Relative linear attenuation coefficient for a CT number (water = 1.0 at 0 HU).
 *
 *     μ(HU) = 1 + HU/1000   for HU > -1000, clamped at 0.
 *
 * This is the standard first-order relation between CT number and attenuation
 * (HU is defined as 1000·(μ − μ_water)/μ_water, so μ/μ_water = 1 + HU/1000).
 * Air (HU ≤ -1000) and anything below it contributes nothing.
 */
export function huToAttenuation(hu: number): number {
  if (hu <= DRR_HU_AIR) return 0;
  return Math.max(0, 1 + hu / 1000);
}

/**
 * Build a VTK scalarOpacity transfer-function string whose opacity at each HU is
 * μ(HU) scaled by `density`. Under additive blend the mapper then accumulates
 * roughly `density · ∫μ dl` along each ray.
 *
 * `density` is the exposure gain: higher makes the projection brighter/denser.
 * The per-sample opacity is clamped to [0, 1] as the mapper requires.
 */
export function buildAttenuationOpacity(density: number, huPoints: number[] = DRR_HU_POINTS): string {
  const gain = Math.max(0, density);
  const pts = huPoints.map(
    (hu) => [hu, Math.max(0, Math.min(1, huToAttenuation(hu) * gain))] as [number, number],
  );
  return pts.length * 2 + ' ' + pts.map(([h, o]) => `${h} ${o.toFixed(5)}`).join(' ');
}

/**
 * Flat white colour ramp so the additive accumulation reads out as grayscale
 * (a radiograph). Two control points across the full CT range are enough.
 */
export function buildRadiographColor(): string {
  // 'N hu r g b  hu r g b ...' — white at both ends.
  return `2 ${DRR_HU_AIR} 1 1 1 3071 1 1 1`;
}

/**
 * Map a 0..1 UI exposure slider to a transfer-function density gain. The response
 * is exponential so the low end has fine control (typical for X-ray exposure):
 * exposure 0 → very faint, 1 → dense. Anchored so the mid slider is a sensible
 * default for chest/abdomen CT.
 */
export function exposureToDensity(exposure01: number): number {
  const e = Math.max(0, Math.min(1, exposure01));
  // 0.004 … 0.08 spanning two decades, exponential.
  return 0.004 * Math.pow(20, e);
}
