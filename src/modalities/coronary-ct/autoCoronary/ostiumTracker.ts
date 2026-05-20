import type { VoxelSampler } from './volumeSampler';
import type { WorldPoint3D } from '../coronary/QCATypes';
import type { AutoCoronaryCenterline } from './types';

// Contrast-fill window boundaries (normally contrast is 200 - 550 HU in coronary lumen)
const LUMEN_HU_MIN = 120;
const LUMEN_HU_MAX = 600;

interface OstiumSpec {
  id: AutoCoronaryCenterline['id'];
  label: string;
  color: string;
  offsetI: number; // relative to aorta root
  offsetJ: number;
  dirI: number; // initial growth direction in IJK
  dirJ: number;
  dirK: number;
}

const OSTIA: OstiumSpec[] = [
  // Left Main: slightly left-posterior of root
  { id: 'lm', label: 'Left Main', color: '#8dd6a5', offsetI: 8, offsetJ: -2, dirI: 1, dirJ: -1, dirK: 0 },
  // LAD: continuation of LM anteriorly and slightly inferior
  { id: 'lad', label: 'LAD', color: '#ff9f68', offsetI: 14, offsetJ: 3, dirI: 1, dirJ: 1, dirK: -1 },
  // LCx: LM divides laterally toward atrioventricular groove
  { id: 'lcx', label: 'LCx', color: '#79c7ff', offsetI: 12, offsetJ: -8, dirI: -1, dirJ: -1, dirK: -1 },
  // RCA: right-anterior of root
  { id: 'rca', label: 'RCA', color: '#f8d16c', offsetI: -10, offsetJ: 4, dirI: -1, dirJ: 1, dirK: -1 },
];

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// 3D vector magnitude
function magnitude(v: [number, number, number]): number {
  return Math.hypot(v[0], v[1], v[2]);
}

// Orthonormal basis in the plane perpendicular to the 3D direction vector
function getPerpendicularBasis(
  tangent: [number, number, number]
): { u: [number, number, number]; v: [number, number, number] } {
  const [tx, ty, tz] = tangent;
  
  // Find a vector that is clearly not collinear to the tangent
  let ux = 1, uy = 0, uz = 0;
  if (Math.abs(tx) > 0.9) {
    ux = 0; uy = 1; uz = 0;
  }
  
  // Project onto the perpendicular plane: u = u' - (u' . t) * t
  const dot = ux * tx + uy * ty + uz * tz;
  const px = ux - dot * tx;
  const py = uy - dot * ty;
  const pz = uz - dot * tz;
  
  // Normalize u
  const lenP = Math.hypot(px, py, pz) || 1;
  const u: [number, number, number] = [px / lenP, py / lenP, pz / lenP];
  
  // v = t x u (cross product)
  const v: [number, number, number] = [
    ty * u[2] - tz * u[1],
    tz * u[0] - tx * u[2],
    tx * u[1] - ty * u[0]
  ];
  
  return { u, v };
}

interface RayBoundary {
  distance: number; // distance in voxel indices
  xIJK: [number, number, number];
  valid: boolean;
}

// Cast a radial boundary ray in a perpendicular cross section
function castRayBoundary(
  sampler: VoxelSampler,
  centerIJK: [number, number, number],
  u: [number, number, number],
  v: [number, number, number],
  angle: number,
  coreHU: number,
  voxelSpacingMm: number
): RayBoundary {
  const [w, h, d] = sampler.dims;
  const [ci, cj, ck] = centerIJK;
  
  // 3D unit ray vector in cross-sectional plane
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const rx = cosA * u[0] + sinA * v[0];
  const ry = cosA * u[1] + sinA * v[1];
  const rz = cosA * u[2] + sinA * v[2];
  
  // Adaptive intensity threshold to define vessel boundary (contrast drops below 55% of core or 130 HU)
  const dropThreshold = Math.max(LUMEN_HU_MIN, Math.min(220, coreHU * 0.55));
  
  const stepMm = 0.5; // step in 0.5mm intervals
  const maxRadiusMm = 7.0; // maximum physiological coronary radius
  const maxSteps = Math.round(maxRadiusMm / stepMm);
  
  let prevHU = coreHU;
  
  for (let s = 1; s <= maxSteps; s++) {
    const distMm = s * stepMm;
    const distVoxels = distMm / voxelSpacingMm;
    
    const ii = Math.round(ci + rx * distVoxels);
    const jj = Math.round(cj + ry * distVoxels);
    const kk = Math.round(ck + rz * distVoxels);
    
    // Out of bounds check
    if (ii < 0 || ii >= w || jj < 0 || jj >= h || kk < 0 || kk >= d) {
      return { distance: distVoxels, xIJK: [ii, jj, kk], valid: false };
    }
    
    const hu = sampler.sampleIJK(ii, jj, kk);
    
    // Boundary transition detected
    if (hu < dropThreshold) {
      const fraction = (prevHU - dropThreshold) / ((prevHU - hu) || 1);
      const exactDistVoxels = (distMm - (1 - fraction) * stepMm) / voxelSpacingMm;
      const exactIJK: [number, number, number] = [
        ci + rx * exactDistVoxels,
        cj + ry * exactDistVoxels,
        ck + rz * exactDistVoxels
      ];
      return { distance: exactDistVoxels, xIJK: exactIJK, valid: true };
    }
    
    prevHU = hu;
  }
  
  // Ray is completely open/invalid (e.g. leaking into the massive aorta root)
  const maxDistVoxels = maxRadiusMm / voxelSpacingMm;
  return {
    distance: maxDistVoxels,
    xIJK: [ci + rx * maxDistVoxels, cj + ry * maxDistVoxels, ck + rz * maxDistVoxels],
    valid: false
  };
}

// Upgraded high-fidelity vessel tracking engine with Adaptive cross-sectional centering & momentum direction smoothing
function traceVesselAdaptive(
  sampler: VoxelSampler,
  startIJK: [number, number, number],
  initialDirWorld: [number, number, number],
  maxLengthMm: number = 135
): WorldPoint3D[] {
  const [w, h, d] = sampler.dims;
  const points: WorldPoint3D[] = [];
  
  const wStart = sampler.worldAt(Math.round(startIJK[0]), Math.round(startIJK[1]), Math.round(startIJK[2]));
  const wNeighbor = sampler.worldAt(Math.min(Math.round(startIJK[0]) + 1, w - 1), Math.round(startIJK[1]), Math.round(startIJK[2]));
  const voxelSpacingMm = Math.max(0.1, Math.abs(wNeighbor[0] - wStart[0])) || 0.5;
  
  let ci = startIJK[0];
  let cj = startIJK[1];
  let ck = startIJK[2];
  
  points.push({ x: wStart[0], y: wStart[1], z: wStart[2] });
  
  // Convert initial world direction to unit tangent vector
  let tx = initialDirWorld[0];
  let ty = initialDirWorld[1];
  let tz = initialDirWorld[2];
  const lenT = Math.hypot(tx, ty, tz) || 1;
  tx /= lenT; ty /= lenT; tz /= lenT;
  
  const stepMm = 1.0; // 1.0 mm step size
  const stepVoxels = stepMm / voxelSpacingMm;
  const maxSteps = Math.round(maxLengthMm / stepMm);
  
  let consecutiveInvalidCentroids = 0;
  
  for (let step = 0; step < maxSteps; step++) {
    const prevI = ci;
    const prevJ = cj;
    const prevK = ck;
    
    // 1. Advance candidate forward along tangent
    const candidateI = ci + tx * stepVoxels;
    const candidateJ = cj + ty * stepVoxels;
    const candidateK = ck + tz * stepVoxels;
    
    const rcI = clamp(Math.round(candidateI), 0, w - 1);
    const rcJ = clamp(Math.round(candidateJ), 0, h - 1);
    const rcK = clamp(Math.round(candidateK), 0, d - 1);
    const coreHU = sampler.sampleIJK(rcI, rcJ, rcK);
    
    // 2. Build cross-sectional perpendicular plane basis
    const { u, v } = getPerpendicularBasis([tx, ty, tz]);
    
    // 3. Cast 12 radial boundary rays
    const numRays = 12;
    const boundaries: RayBoundary[] = [];
    let validCount = 0;
    let sumValidDist = 0;
    
    for (let r = 0; r < numRays; r++) {
      const angle = (r * 2 * Math.PI) / numRays;
      const b = castRayBoundary(sampler, [candidateI, candidateJ, candidateK], u, v, angle, coreHU, voxelSpacingMm);
      boundaries.push(b);
      if (b.valid) {
        validCount++;
        sumValidDist += b.distance;
      }
    }
    
    let refinedI = candidateI;
    let refinedJ = candidateJ;
    let refinedK = candidateK;
    let avgRadiusMm = 2.0;
    
    if (validCount >= 3) {
      let sumI = 0, sumJ = 0, sumK = 0;
      const avgDistVoxels = sumValidDist / validCount;
      
      for (let r = 0; r < numRays; r++) {
        const b = boundaries[r];
        if (b.valid) {
          sumI += b.xIJK[0];
          sumJ += b.xIJK[1];
          sumK += b.xIJK[2];
        } else {
          // Exclude aorta distortion: substitute leaking ray boundary with the local average of non-leaking rays
          const angle = (r * 2 * Math.PI) / numRays;
          const cosA = Math.cos(angle);
          const sinA = Math.sin(angle);
          const rx = cosA * u[0] + sinA * v[0];
          const ry = cosA * u[1] + sinA * v[1];
          const rz = cosA * u[2] + sinA * v[2];
          
          sumI += candidateI + rx * avgDistVoxels;
          sumJ += candidateJ + ry * avgDistVoxels;
          sumK += candidateK + rz * avgDistVoxels;
        }
      }
      
      refinedI = sumI / numRays;
      refinedJ = sumJ / numRays;
      refinedK = sumK / numRays;
      
      avgRadiusMm = avgDistVoxels * voxelSpacingMm;
      consecutiveInvalidCentroids = 0;
    } else {
      consecutiveInvalidCentroids++;
      if (consecutiveInvalidCentroids > 3) {
        break; // stop: we left the tubular vessel shape completely
      }
    }
    
    refinedI = clamp(refinedI, 0, w - 1);
    refinedJ = clamp(refinedJ, 0, h - 1);
    refinedK = clamp(refinedK, 0, d - 1);
    
    const refinedHU = sampler.sampleIJK(Math.round(refinedI), Math.round(refinedJ), Math.round(refinedK));
    
    // Dynamic Termination:
    // a. Core HU falls below standard vascular soft tissue limit
    if (refinedHU < 110) {
      break;
    }
    // b. Too large (dilated or leaking into cardiac cavity / ventricle)
    if (avgRadiusMm > 5.5) {
      break;
    }
    // c. Tapered out too narrow (capillary distal end)
    if (avgRadiusMm < 0.45 && step > 12) {
      break;
    }
    
    // 4. Update coordinates & tangent vector using a smooth momentum model (45% tracking update, 55% previous tangent)
    const rawDx = refinedI - prevI;
    const rawDy = refinedJ - prevJ;
    const rawDz = refinedK - prevK;
    const rawLen = Math.hypot(rawDx, rawDy, rawDz);
    
    if (rawLen > 0.05) {
      const propX = rawDx / rawLen;
      const propY = rawDy / rawLen;
      const propZ = rawDz / rawLen;
      
      const blend = 0.45;
      tx = tx * (1 - blend) + propX * blend;
      ty = ty * (1 - blend) + propY * blend;
      tz = tz * (1 - blend) + propZ * blend;
      
      const norm = Math.hypot(tx, ty, tz) || 1;
      tx /= norm; ty /= norm; tz /= norm;
    }
    
    ci = refinedI;
    cj = refinedJ;
    ck = refinedK;
    
    const world = sampler.worldAt(Math.round(ci), Math.round(cj), Math.round(ck));
    points.push({ x: world[0], y: world[1], z: world[2] });
  }
  
  return points;
}

// Fallback legacy tracer (strictly centroid, non-adaptive) as a secondary backup
function traceVesselLegacy(
  sampler: VoxelSampler,
  startIJK: [number, number, number],
  dir: [number, number, number]
): WorldPoint3D[] {
  const [w, h, d] = sampler.dims;
  const points: WorldPoint3D[] = [];

  let ci = startIJK[0];
  let cj = startIJK[1];
  let ck = startIJK[2];

  const wStart = sampler.worldAt(ci, cj, ck);
  points.push({ x: wStart[0], y: wStart[1], z: wStart[2] });

  const spacingMm = Math.max(
    0.3,
    Math.abs(
      sampler.worldAt(Math.min(ci + 1, w - 1), cj, ck)[0] - wStart[0]
    ) || 0.5
  );
  const voxelStep = Math.max(1, Math.round(1.0 / spacingMm));

  let [di, dj, dk] = dir;
  const norm = Math.hypot(di, dj, dk) || 1;
  di /= norm;
  dj /= norm;
  dk /= norm;

  for (let step = 0; step < 120; step += 1) {
    const ni = clamp(Math.round(ci + di * voxelStep), 0, w - 1);
    const nj = clamp(Math.round(cj + dj * voxelStep), 0, h - 1);
    const nk = clamp(Math.round(ck + dk * voxelStep), 0, d - 1);

    let sumI = 0;
    let sumJ = 0;
    let sumK = 0;
    let count = 0;
    for (let oi = -2; oi <= 2; oi += 1) {
      for (let oj = -2; oj <= 2; oj += 1) {
        for (let ok = -1; ok <= 1; ok += 1) {
          const ii = clamp(ni + oi, 0, w - 1);
          const jj = clamp(nj + oj, 0, h - 1);
          const kk = clamp(nk + ok, 0, d - 1);
          const hu = sampler.sampleIJK(ii, jj, kk);
          if (hu >= 140 && hu <= LUMEN_HU_MAX) {
            sumI += ii;
            sumJ += jj;
            sumK += kk;
            count += 1;
          }
        }
      }
    }
    if (count < 4) break;

    const refI = sumI / count;
    const refJ = sumJ / count;
    const refK = sumK / count;

    const newDi = refI - ci;
    const newDj = refJ - cj;
    const newDk = refK - ck;
    const newNorm = Math.hypot(newDi, newDj, newDk);
    if (newNorm < 0.2) break;

    ci = refI;
    cj = refJ;
    ck = refK;
    di = newDi / newNorm;
    dj = newDj / newNorm;
    dk = newDk / newNorm;

    const world = sampler.worldAt(Math.round(ci), Math.round(cj), Math.round(ck));
    points.push({ x: world[0], y: world[1], z: world[2] });
  }

  return points;
}

export function traceCoronariesFromAortaRoot(
  sampler: VoxelSampler,
  rootIJK: [number, number, number]
): AutoCoronaryCenterline[] {
  const [w, h, d] = sampler.dims;
  const lines: AutoCoronaryCenterline[] = [];

  for (const spec of OSTIA) {
    const startI = clamp(rootIJK[0] + spec.offsetI, 0, w - 1);
    const startJ = clamp(rootIJK[1] + spec.offsetJ, 0, h - 1);
    const startK = clamp(rootIJK[2] - 2, 0, d - 1);

    const initialDirWorld = sampler.worldAt(startI, startJ, startK);
    const rootWorld = sampler.worldAt(rootIJK[0], rootIJK[1], rootIJK[2]);
    const rDir: [number, number, number] = [
      initialDirWorld[0] - rootWorld[0],
      initialDirWorld[1] - rootWorld[1],
      initialDirWorld[2] - rootWorld[2]
    ];

    const points = traceVesselAdaptive(
      sampler,
      [startI, startJ, startK],
      rDir,
      spec.id === 'lm' ? 15 : 120
    );

    lines.push({
      id: spec.id,
      label: spec.label,
      color: spec.color,
      points,
      confidence: points.length > 8 ? 0.75 : 0.35,
    });
  }

  return lines;
}

// Premium Interactive Landmark Guided Segmentation Pipeline
export function traceCoronariesFromManualLandmarks(
  sampler: VoxelSampler,
  rootIJK: [number, number, number],
  rcaOstiumIJK: [number, number, number],
  lmcaOstiumIJK: [number, number, number]
): AutoCoronaryCenterline[] {
  const [w, h, d] = sampler.dims;
  const lines: AutoCoronaryCenterline[] = [];

  const rootWorld = sampler.worldAt(rootIJK[0], rootIJK[1], rootIJK[2]);

  // 1. RCA Tracking
  const rcaWorld = sampler.worldAt(rcaOstiumIJK[0], rcaOstiumIJK[1], rcaOstiumIJK[2]);
  const rcaDirWorld: [number, number, number] = [
    rcaWorld[0] - rootWorld[0],
    rcaWorld[1] - rootWorld[1],
    rcaWorld[2] - rootWorld[2]
  ];
  
  const rcaPoints = traceVesselAdaptive(sampler, rcaOstiumIJK, rcaDirWorld, 135);
  lines.push({
    id: 'rca',
    label: 'RCA',
    color: '#f8d16c',
    points: rcaPoints,
    confidence: rcaPoints.length > 8 ? 0.95 : 0.4,
  });

  // 2. Left Main (LM) Tracking - runs for a limited distance (max 16 mm) to reach the bifurcation
  const lmcaWorld = sampler.worldAt(lmcaOstiumIJK[0], lmcaOstiumIJK[1], lmcaOstiumIJK[2]);
  const lmDirWorld: [number, number, number] = [
    lmcaWorld[0] - rootWorld[0],
    lmcaWorld[1] - rootWorld[1],
    lmcaWorld[2] - rootWorld[2]
  ];
  
  const lmPoints = traceVesselAdaptive(sampler, lmcaOstiumIJK, lmDirWorld, 16);
  lines.push({
    id: 'lm',
    label: 'Left Main',
    color: '#8dd6a5',
    points: lmPoints,
    confidence: lmPoints.length > 8 ? 0.95 : 0.4,
  });

  // 3. Self-Calibrating Left Main Bifurcation Search
  let ladPoints: WorldPoint3D[] = [];
  let lcxPoints: WorldPoint3D[] = [];
  let bifurcationSucceeded = false;

  if (lmPoints.length >= 3) {
    const lastIdx = lmPoints.length - 1;
    const bifWorld = lmPoints[lastIdx];
    const bifWorldPrev = lmPoints[lastIdx - 2];
    
    // End tangent direction of the LM trunk
    const lmEndTangent: [number, number, number] = [
      bifWorld.x - bifWorldPrev.x,
      bifWorld.y - bifWorldPrev.y,
      bifWorld.z - bifWorldPrev.z
    ];
    
    const bifIJK_raw = sampler.worldToIndex([bifWorld.x, bifWorld.y, bifWorld.z]);
    const bifIJK: [number, number, number] = [
      clamp(Math.round(bifIJK_raw[0]), 0, w - 1),
      clamp(Math.round(bifIJK_raw[1]), 0, h - 1),
      clamp(Math.round(bifIJK_raw[2]), 0, d - 1)
    ];

    // Generate a cone of candidate branching directions at 45 degrees around LM end tangent
    const numConeRays = 12;
    const candidates: { dirWorld: [number, number, number]; score: number; dirIJK: [number, number, number] }[] = [];
    const { u, v } = getPerpendicularBasis(lmEndTangent);
    
    const coneAngleRad = (40 * Math.PI) / 180; // 40 degree branching angle
    const cosCone = Math.cos(coneAngleRad);
    const sinCone = Math.sin(coneAngleRad);
    
    for (let k = 0; k < numConeRays; k++) {
      const alpha = (k * 2 * Math.PI) / numConeRays;
      const cosA = Math.cos(alpha);
      const sinA = Math.sin(alpha);
      
      const dwx = cosCone * lmEndTangent[0] + sinCone * (cosA * u[0] + sinA * v[0]);
      const dwy = cosCone * lmEndTangent[1] + sinCone * (cosA * u[1] + sinA * v[1]);
      const dwz = cosCone * lmEndTangent[2] + sinCone * (cosA * u[2] + sinA * v[2]);
      
      const lenC = Math.hypot(dwx, dwy, dwz) || 1;
      const dirWorld: [number, number, number] = [dwx / lenC, dwy / lenC, dwz / lenC];
      
      // Probe ahead to evaluate local tubular HU intensity score
      let scoreSum = 0;
      const testSteps = 3;
      const testStepMm = 1.0;
      
      for (let s = 1; s <= testSteps; s++) {
        const testMm = s * testStepMm;
        const testPtWorld: [number, number, number] = [
          bifWorld.x + dirWorld[0] * testMm,
          bifWorld.y + dirWorld[1] * testMm,
          bifWorld.z + dirWorld[2] * testMm
        ];
        
        const testIJK = sampler.worldToIndex(testPtWorld);
        const ti = clamp(Math.round(testIJK[0]), 0, w - 1);
        const tj = clamp(Math.round(testIJK[1]), 0, h - 1);
        const tk = clamp(Math.round(testIJK[2]), 0, d - 1);
        
        scoreSum += sampler.sampleIJK(ti, tj, tk);
      }
      
      const score = scoreSum / testSteps;
      
      // Direction in index coordinates
      const testIJK = sampler.worldToIndex([bifWorld.x + dirWorld[0], bifWorld.y + dirWorld[1], bifWorld.z + dirWorld[2]]);
      const dirIJK: [number, number, number] = [
        testIJK[0] - bifIJK[0],
        testIJK[1] - bifIJK[1],
        testIJK[2] - bifIJK[2]
      ];
      
      candidates.push({ dirWorld, score, dirIJK });
    }
    
    // Sort candidates descending by HU score
    candidates.sort((a, b) => b.score - a.score);
    
    // Select the best branch, and a second branch that is geometrically well-separated (separated by > 45 degrees)
    const branch1 = candidates[0];
    let branch2 = candidates[1]; // default fallback
    
    for (let i = 1; i < candidates.length; i++) {
      const c = candidates[i];
      // Dot product of branch1.dirWorld and c.dirWorld in world space
      const dot = branch1.dirWorld[0] * c.dirWorld[0] + branch1.dirWorld[1] * c.dirWorld[1] + branch1.dirWorld[2] * c.dirWorld[2];
      if (dot < 0.707) { // angle is indeed > 45 degrees
        branch2 = c;
        break;
      }
    }
    
    if (branch1 && branch2) {
      // Differentiate LAD and LCx:
      // Anatomically, the LAD points anteriorly (towards the front, which corresponds to positive J coordinate offset in index space).
      // Compare the Y coordinate (index space J-axis component) of both branch directions:
      const branch1IsAnterior = branch1.dirIJK[1] > branch2.dirIJK[1];
      const ladBranch = branch1IsAnterior ? branch1 : branch2;
      const lcxBranch = branch1IsAnterior ? branch2 : branch1;
      
      ladPoints = traceVesselAdaptive(sampler, bifIJK, ladBranch.dirWorld, 120);
      lcxPoints = traceVesselAdaptive(sampler, bifIJK, lcxBranch.dirWorld, 120);
      bifurcationSucceeded = true;
    }
  }

  // Fallback to legay coordinate-offset seeding if bifurcation finder failed or was too short
  if (!bifurcationSucceeded) {
    const ladStartIJK: [number, number, number] = [
      clamp(lmcaOstiumIJK[0] + 4, 0, w - 1),
      clamp(lmcaOstiumIJK[1] + 5, 0, h - 1),
      clamp(lmcaOstiumIJK[2] - 1, 0, d - 1)
    ];
    ladPoints = traceVesselLegacy(sampler, ladStartIJK, [1, 1, -1]);

    const lcxStartIJK: [number, number, number] = [
      clamp(lmcaOstiumIJK[0] + 2, 0, w - 1),
      clamp(lmcaOstiumIJK[1] - 5, 0, h - 1),
      clamp(lmcaOstiumIJK[2] - 1, 0, d - 1)
    ];
    lcxPoints = traceVesselLegacy(sampler, lcxStartIJK, [-1, -1, -1]);
  }

  lines.push({
    id: 'lad',
    label: 'LAD',
    color: '#ff9f68',
    points: ladPoints,
    confidence: ladPoints.length > 8 ? 0.95 : 0.4,
  });

  lines.push({
    id: 'lcx',
    label: 'LCx',
    color: '#79c7ff',
    points: lcxPoints,
    confidence: lcxPoints.length > 8 ? 0.95 : 0.4,
  });

  return lines;
}
