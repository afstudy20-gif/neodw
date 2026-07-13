/**
 * Device-specific nominal stent-frame geometry for the virtual valve deployment
 * simulation.
 *
 * Each commercial prosthesis has a characteristic frame profile:
 *  - Balloon-expandable (Edwards Sapien, Meril Myval): a SHORT cylindrical
 *    cell — uniform diameter from inflow to outflow, height scales with label.
 *  - Self-expanding (Medtronic Evolut, Abbott Navitor, Boston ACURATE): a LONG
 *    tapered frame that is narrow at the inflow (annulus) and flares supr-
 *    annularly into the sinuses / STJ, with a skirted inflow region.
 *
 * This is a PARAMETRIC/PROXY model, not finite-element deformation. It places
 * the manufacturer's nominal frame geometry against the patient-specific
 * annulus so the operator can visually assess coverage, implant depth, and
 * coronary-ostium / calcium relationships — the same "visual placement" approach
 * used by commercial tools like 3mensio. Real FEA deformation (VTAVR, UCSF
 * biomechanics) is in-browser impractical and out of scope for this research
 * scaffold.
 *
 * ⚠ CLINICAL SAFETY: the per-device height / flare numbers below are nominal
 * values assembled from manufacturer literature and are NOT verified against a
 * specific IFU revision. They exist to render a recognizable frame shape, not
 * to drive clinical sizing. See the disclaimer in TAVIValveDatabase.ts.
 */

import type { Mesh } from '../la/marchingCubes';
import type { TAVIVector3D } from './TAVITypes';

/** A horizontal ring of the frame, expressed as height + radius above the
 *  annular plane (height in mm along the aortic axis; radius in mm). */
export interface FrameRing {
  /** Signed height along the aortic axis RELATIVE to the annular plane, mm.
   *  Negative = sub-annular (toward LVOT), positive = supra-annular (toward
   *  sinuses / STJ). */
  heightAboveAnnulusMm: number;
  /** Ring radius at this height, mm. */
  radiusMm: number;
}

/** Cross-section profile of a prosthesis frame, from inflow to outflow. */
export interface FrameProfile {
  /** Ordered rings, inflow (most sub-annular) → outflow (most supra-annular). */
  rings: FrameRing[];
  /** Number of stent cells around the circumference (purely visual). */
  strutCount: number;
  /** Whether the device has a PET/ePTFE skirt at the inflow (renders as a band). */
  hasSkirt: boolean;
  /** Total frame height, mm (outflow − inflow). */
  totalHeightMm: number;
}

/**
 * Build the nominal frame profile for a valve family + label size.
 *
 * Heights/flares are approximated from published device dimensions; the goal is
 * a recognizable silhouette, not a metrological match. Balloon-expandable
 * devices are short cylinders; self-expanding devices flare above the annulus.
 */
export function frameProfileFor(
  familyName: string,
  isSelfExpanding: boolean,
  sizeMm: number,
): FrameProfile {
  const r = sizeMm / 2;

  if (!isSelfExpanding) {
    // Balloon-expandable: uniform cylinder. Height grows ~1mm per 3mm of label
    // (Sapien 3: ~14.5mm at 20 → ~19mm at 29). Skirt present on Sapien 3 Ultra.
    const height = 13 + (sizeMm - 20) * 0.55;
    const hasSkirt = /sapien 3 ultra|myval/i.test(familyName);
    return {
      rings: [
        { heightAboveAnnulusMm: 0, radiusMm: r }, // inflow at annulus
        { heightAboveAnnulusMm: height, radiusMm: r }, // outflow
      ],
      strutCount: 12,
      hasSkirt,
      totalHeightMm: height,
    };
  }

  // Self-expanding: long tapered frame with supra-annular flare.
  // Evolut FX/PRO+: ~26-30mm frame, strong flare (outflow ≈ r + 4mm).
  // Navitor: ~27mm, moderate flare.
  // ACURATE neo2: ~28mm, pronounced upper crown + stabilizing arms (rendered
  //   here as a flare since we don't model the arms separately).
  let totalHeight = 28;
  let flareMm = 4;
  if (/evolut/i.test(familyName)) { totalHeight = sizeMm >= 34 ? 31 : 29; flareMm = sizeMm >= 34 ? 5 : 4; }
  else if (/navitor/i.test(familyName)) { totalHeight = 27; flareMm = 3; }
  else if (/acurate/i.test(familyName)) { totalHeight = 28; flareMm = 4.5; }

  // Inflow narrows slightly below nominal (the sealing skirt sits at annulus).
  const inflowR = r;
  const annulusR = r; // at the annular plane
  // Mid-frame tapers inward slightly before flaring (concave waist) — Evolut
  // has a recognizable cell pattern; we approximate with a waist ring.
  const waistR = r * 0.94;
  const outflowR = r + flareMm;

  return {
    rings: [
      { heightAboveAnnulusMm: 0, radiusMm: inflowR }, // inflow (sealed at annulus)
      { heightAboveAnnulusMm: totalHeight * 0.25, radiusMm: waistR }, // waist
      { heightAboveAnnulusMm: totalHeight * 0.55, radiusMm: waistR }, // waist top
      { heightAboveAnnulusMm: totalHeight, radiusMm: outflowR }, // flared outflow
    ],
    strutCount: 24,
    hasSkirt: true,
    totalHeightMm: totalHeight,
  };
}

/**
 * Build the nominal frame profile for a SURGICAL bioprosthesis, used in the
 * valve-in-valve (ViV) view to render the failing surgical valve that the new
 * TAVI prosthesis is deployed inside of.
 *
 * Stented surgical bioprostheses share a recognizable silhouette: a tall
 * (18–22mm) metallic stent frame that is narrow at the sewing ring (annulus
 * level) and flares into an open "crown" at the top (commissural posts). The
 * internal diameter (where the leaflets / new TAVI sits) is the true ID.
 *
 * `outerDiameterMm` is the label size; `innerDiameterMm` is the true ID (smaller).
 * The frame is drawn at the OUTER radius so the TAVI frame nests visibly inside.
 *
 * @param profile   SurgicalFrameProfile silhouette family
 * @param outerDiameterMm  Label size (frame outer diameter)
 * @param innerDiameterMm  True internal diameter (leaflets / TAVI boundary)
 * @param frameHeightMm    Stent frame height
 */
export function surgicalFrameProfile(
  profile: 'perimount' | 'mosaic' | 'trifecta' | 'mitroflow' | 'generic',
  outerDiameterMm: number,
  innerDiameterMm: number,
  frameHeightMm: number,
): FrameProfile {
  const rOuter = outerDiameterMm / 2;
  const rInner = innerDiameterMm / 2;
  // All stented bioprostheses flare from the sewing ring to commissural posts.
  // Flare magnitude differs subtly by platform; we approximate per-family.
  let flareMm = 3;
  if (profile === 'perimount' || profile === 'trifecta') flareMm = 3.5;
  else if (profile === 'mitroflow') flareMm = 2.5;

  const inflowR = rOuter * 0.92; // sewing ring slightly larger than the label
  const outflowR = rOuter + flareMm; // flared commissural crown

  return {
    rings: [
      { heightAboveAnnulusMm: 0, radiusMm: inflowR }, // sewing ring at annulus
      { heightAboveAnnulusMm: frameHeightMm * 0.45, radiusMm: rInner * 1.04 }, // waist (tissue level)
      { heightAboveAnnulusMm: frameHeightMm * 0.75, radiusMm: (rInner + outflowR) / 2 }, // transition
      { heightAboveAnnulusMm: frameHeightMm, radiusMm: outflowR }, // commissural crown
    ],
    strutCount: profile === 'perimount' ? 16 : 18,
    hasSkirt: true,
    totalHeightMm: frameHeightMm,
  };
}

/**
 * Position a frame profile relative to the annular plane given the implant
 * depth and deployment ratio.
 *
 * The deployment ratio is the sub/supra-annular split for self-expanding frames:
 * '80/20' → 80% of the frame sits supra-annular, 20% sub; '90/10' → 90/10.
 * Balloon-expandable frames are short and are simply centred with the inflow
 * slightly below the annulus by `implantDepthMm`.
 *
 * Returns the SAME rings but with their heightAboveAnnulusMm shifted so the
 * inflow sits at -implantDepthMm (sub-annular) and the distribution matches the
 * requested ratio.
 */
export function positionFrame(
  profile: FrameProfile,
  implantDepthMm: number,
  deploymentRatio: '80/20' | '90/10',
): FrameRing[] {
  // Two controls position the frame along the aortic axis:
  //  - `implantDepthMm`   : absolute depth of the inflow below the annulus (mm).
  //  - `deploymentRatio`  : sub/supra-annular split of the frame LENGTH. For a
  //    self-expanding frame, '80/20' means 80% of the frame sits supra-annular
  //    and 20% sub-annular. We express this as an offset so the annular plane
  //    crosses the frame at the requested sub-fraction of its total height.
  //
  // The inflow ring (profile.rings[0]) is placed at -implantDepthMm. The
  // remaining rings keep their proportional spacing but the whole frame is
  // nudged so the annular plane (height 0) lands at the desired split.
  const subFraction = deploymentRatio === '80/20' ? 0.2 : 0.1;

  // Without an implant-depth bias, place the annular crossing at subFraction of
  // the height below the top. Combine with the explicit implant depth so the
  // operator's depth slider always wins for the inflow position.
  const annularCrossHeight = profile.totalHeightMm * subFraction;

  return profile.rings.map((ring) => ({
    // Shift so ring[0] lands at -implantDepthMm, and the frame's annular-cross
    // sits at the requested ratio. For short balloon-expandable frames the
    // ratio term is small relative to the implant-depth term, so the inflow
    // tracks the depth slider as expected.
    heightAboveAnnulusMm: ring.heightAboveAnnulusMm - annularCrossHeight - implantDepthMm,
    radiusMm: ring.radiusMm,
  }));
}

/**
 * Tessellate a positioned frame into a triangle mesh (positions + normals) in
 * WORLD coordinates, ready to feed LA3DView.
 *
 * The frame is built as a lofted surface: vertical "staves" connect consecutive
 * rings, and each quad is split into two triangles. Normals point outward.
 * `axisOrigin` is the annulus centroid; `axisDir` the aortic-axis direction
 * (normalized); `localX`/`localY` form the in-plane basis.
 *
 * All vectors are in the same world space as the annulus contour / CT volume.
 */
export function buildFrameMesh(
  rings: FrameRing[],
  basis: {
    origin: TAVIVector3D; // annulus centroid
    axis: TAVIVector3D; // normalized aortic axis (toward aorta)
    localX: TAVIVector3D; // in-plane basis (normalized)
    localY: TAVIVector3D; // in-plane basis (normalized)
  },
  radialSegments = 32,
): Mesh {
  // Ring vertices in world space: rows = rings, cols = angular samples.
  // radialSegments must be >= 3.
  const seg = Math.max(3, radialSegments | 0);
  const ringCount = rings.length;
  const vertexCount = ringCount * (seg + 1); // seam-duplicated for easy quads

  const positions = new Float32Array(vertexCount * 3);
  const idx = (ring: number, s: number) => ring * (seg + 1) + s;

  for (let ring = 0; ring < ringCount; ring++) {
    const r = rings[ring];
    const h = r.heightAboveAnnulusMm;
    const rad = r.radiusMm;
    // Ring centre = origin + axis * h
    const cx = basis.origin.x + basis.axis.x * h;
    const cy = basis.origin.y + basis.axis.y * h;
    const cz = basis.origin.z + basis.axis.z * h;
    for (let s = 0; s <= seg; s++) {
      const theta = (s / seg) * Math.PI * 2;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const px = cx + basis.localX.x * cosT * rad + basis.localY.x * sinT * rad;
      const py = cy + basis.localX.y * cosT * rad + basis.localY.y * sinT * rad;
      const pz = cz + basis.localX.z * cosT * rad + basis.localY.z * sinT * rad;
      const vi = idx(ring, s) * 3;
      positions[vi] = px;
      positions[vi + 1] = py;
      positions[vi + 2] = pz;
    }
  }

  // Build quads between consecutive rings, each split into 2 triangles.
  const triangles: number[] = [];
  for (let ring = 0; ring < ringCount - 1; ring++) {
    for (let s = 0; s < seg; s++) {
      const a = idx(ring, s);
      const b = idx(ring, s + 1);
      const c = idx(ring + 1, s + 1);
      const d = idx(ring + 1, s);
      triangles.push(a, b, c, a, c, d);
    }
  }

  return finalizeMesh(positions, triangles);
}

/**
 * Tessellate the annulus contour (closed polyline in world space) into a flat
 * disc mesh — rendered semi-transparently to show the annular plane under the
 * deployed frame.
 */
export function buildAnnulusDiscMesh(
  contour: TAVIVector3D[],
): Mesh {
  const n = contour.length;
  if (n < 3) return { positions: new Float32Array(0), normals: new Float32Array(0), triangleCount: 0 };

  // Centroid as fan apex.
  let cx = 0, cy = 0, cz = 0;
  for (const p of contour) { cx += p.x; cy += p.y; cz += p.z; }
  cx /= n; cy /= n; cz /= n;

  const positions = new Float32Array((n + 1) * 3);
  positions[0] = cx; positions[1] = cy; positions[2] = cz;
  for (let i = 0; i < n; i++) {
    const vi = (i + 1) * 3;
    positions[vi] = contour[i].x;
    positions[vi + 1] = contour[i].y;
    positions[vi + 2] = contour[i].z;
  }
  const triangles: number[] = [];
  for (let i = 0; i < n; i++) {
    const cur = i + 1;
    const next = ((i + 1) % n) + 1;
    triangles.push(0, cur, next);
  }

  return finalizeMesh(positions, triangles);
}

/**
 * Convert a flat position array + triangle index list into the Mesh format
 * (non-indexed, per-vertex normals via cross-product face normals).
 */
function finalizeMesh(
  positions: Float32Array,
  triangles: number[],
): Mesh {
  const triCount = triangles.length / 3;
  const outPositions = new Float32Array(triCount * 9);
  const outNormals = new Float32Array(triCount * 9);

  for (let t = 0; t < triCount; t++) {
    const ia = triangles[t * 3] * 3;
    const ib = triangles[t * 3 + 1] * 3;
    const ic = triangles[t * 3 + 2] * 3;

    const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
    const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
    const cxv = positions[ic], cyv = positions[ic + 1], czv = positions[ic + 2];

    // Face normal via (b-a) × (c-a)
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cxv - ax, vy = cyv - ay, vz = czv - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const nlen = Math.hypot(nx, ny, nz) || 1;
    nx /= nlen; ny /= nlen; nz /= nlen;

    const oi = t * 9;
    // Write three vertices
    outPositions[oi] = ax; outPositions[oi + 1] = ay; outPositions[oi + 2] = az;
    outPositions[oi + 3] = bx; outPositions[oi + 4] = by; outPositions[oi + 5] = bz;
    outPositions[oi + 6] = cxv; outPositions[oi + 7] = cyv; outPositions[oi + 8] = czv;
    outNormals[oi] = nx; outNormals[oi + 1] = ny; outNormals[oi + 2] = nz;
    outNormals[oi + 3] = nx; outNormals[oi + 4] = ny; outNormals[oi + 5] = nz;
    outNormals[oi + 6] = nx; outNormals[oi + 7] = ny; outNormals[oi + 8] = nz;
  }

  return { positions: outPositions, normals: outNormals, triangleCount: triCount };
}
