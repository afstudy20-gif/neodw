/**
 * Border-zone corridor detection (ADAS-LV style conducting channel finder).
 *
 * Algorithm:
 * 1. Classify each mesh vertex by thickness:
 *    - Core scar (<scarMaxMm, default 3mm) = electrically inert
 *    - Border zone (scarMax..bzMax, default 3-5mm) = slow conduction pathway
 *    - Healthy (>bzMax) = fast myocardium
 * 2. Spatially weld shared mesh vertices (MC output duplicates vertices per triangle).
 * 3. Build adjacency graph via triangle edges on welded vertex set.
 * 4. BFS over BZ welded vertices → connected components.
 * 5. Filter components: must be bounded by BOTH core scar AND healthy tissue
 *    (slow conduction isthmus with entry/exit to excitable myocardium).
 * 6. Return corridors sorted by size (vertex count).
 *
 * NOTE: length is bbox diagonal — approximate. Proper centerline skeletonization
 * would require medial-axis computation; deferred.
 */
import type { Mesh } from './marchingCubes';

export interface Corridor {
  vertexIds: number[];
  size: number;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
  lengthMm: number;
  touchesHealthy: number;
  touchesCore: number;
}

export interface CorridorResult {
  corridors: Corridor[];
  coreCount: number;
  bzCount: number;
  healthyCount: number;
  measurable: number;
}

export interface CorridorOptions {
  scarMaxMm?: number;
  bzMaxMm?: number;
  weldTolMm?: number;
  minCorridorVerts?: number;
}

export function computeBZCorridors(
  mesh: Mesh,
  thickness: Float32Array,
  opts: CorridorOptions = {}
): CorridorResult {
  const scarMax = opts.scarMaxMm ?? 3;
  const bzMax = opts.bzMaxMm ?? 5;
  const weldTol = opts.weldTolMm ?? 0.3;
  const minCorridor = opts.minCorridorVerts ?? 30;

  const triCount = mesh.triangleCount;
  const vertexCount = triCount * 3;
  const positions = mesh.positions;

  const CLS_CORE = 0, CLS_BZ = 1, CLS_HEALTHY = 2, CLS_UNK = 3;
  const cls = new Uint8Array(vertexCount);
  let core = 0, bz = 0, healthy = 0, measurable = 0;
  for (let v = 0; v < vertexCount; v++) {
    const t = thickness[v];
    if (Number.isNaN(t)) { cls[v] = CLS_UNK; continue; }
    measurable++;
    if (t < scarMax) { cls[v] = CLS_CORE; core++; }
    else if (t < bzMax) { cls[v] = CLS_BZ; bz++; }
    else { cls[v] = CLS_HEALTHY; healthy++; }
  }

  const invTol = 1 / weldTol;
  const keyToId = new Map<string, number>();
  const weld = new Int32Array(vertexCount);
  let weldedCount = 0;
  for (let v = 0; v < vertexCount; v++) {
    const p0 = v * 3;
    const kx = Math.round(positions[p0] * invTol);
    const ky = Math.round(positions[p0 + 1] * invTol);
    const kz = Math.round(positions[p0 + 2] * invTol);
    const k = `${kx},${ky},${kz}`;
    let id = keyToId.get(k);
    if (id === undefined) { id = weldedCount++; keyToId.set(k, id); }
    weld[v] = id;
  }

  const weldCls = new Uint8Array(weldedCount);
  weldCls.fill(CLS_UNK);
  for (let v = 0; v < vertexCount; v++) {
    const w = weld[v];
    const c = cls[v];
    if (c === CLS_UNK) continue;
    // Most scar-like wins when conflict (CORE=0 < BZ=1 < HEALTHY=2)
    if (weldCls[w] === CLS_UNK || c < weldCls[w]) weldCls[w] = c;
  }

  const adj: Set<number>[] = new Array(weldedCount);
  for (let i = 0; i < weldedCount; i++) adj[i] = new Set();
  for (let t = 0; t < triCount; t++) {
    const a = weld[t * 3], b = weld[t * 3 + 1], c = weld[t * 3 + 2];
    if (a !== b) { adj[a].add(b); adj[b].add(a); }
    if (a !== c) { adj[a].add(c); adj[c].add(a); }
    if (b !== c) { adj[b].add(c); adj[c].add(b); }
  }

  const weldToRaw: number[][] = new Array(weldedCount);
  for (let v = 0; v < vertexCount; v++) {
    const w = weld[v];
    if (!weldToRaw[w]) weldToRaw[w] = [];
    weldToRaw[w].push(v);
  }

  const visited = new Uint8Array(weldedCount);
  const corridors: Corridor[] = [];
  for (let seed = 0; seed < weldedCount; seed++) {
    if (visited[seed]) continue;
    if (weldCls[seed] !== CLS_BZ) continue;
    const stack: number[] = [seed];
    visited[seed] = 1;
    const comp: number[] = [];
    let touchesHealthy = 0, touchesCore = 0;
    while (stack.length > 0) {
      const w = stack.pop()!;
      comp.push(w);
      for (const n of adj[w]) {
        const cc = weldCls[n];
        if (cc === CLS_HEALTHY) touchesHealthy++;
        else if (cc === CLS_CORE) touchesCore++;
        else if (cc === CLS_BZ && !visited[n]) {
          visited[n] = 1;
          stack.push(n);
        }
      }
    }
    if (comp.length < minCorridor) continue;
    if (touchesHealthy === 0 || touchesCore === 0) continue;

    const rawIds: number[] = [];
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const w of comp) {
      for (const raw of weldToRaw[w]) {
        rawIds.push(raw);
        const p0 = raw * 3;
        const x = positions[p0], y = positions[p0 + 1], z = positions[p0 + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
    }
    const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
    corridors.push({
      vertexIds: rawIds,
      size: comp.length,
      bboxMin: [minX, minY, minZ],
      bboxMax: [maxX, maxY, maxZ],
      lengthMm: Math.hypot(dx, dy, dz),
      touchesHealthy,
      touchesCore,
    });
  }
  corridors.sort((a, b) => b.size - a.size);

  return { corridors, coreCount: core, bzCount: bz, healthyCount: healthy, measurable };
}

const CORRIDOR_PALETTE: Array<[number, number, number]> = [
  [0.20, 0.85, 0.95], // cyan
  [0.95, 0.50, 0.95], // magenta
  [0.98, 0.75, 0.20], // amber
  [0.35, 0.95, 0.50], // lime
  [0.95, 0.30, 0.30], // red
  [0.50, 0.60, 1.00], // periwinkle
];

/**
 * Build per-vertex color buffer for corridor highlight mode.
 * Corridor vertices get palette color (cycled by corridor index).
 * Non-corridor vertices get dim grey.
 */
export function buildCorridorColors(
  vertexCount: number,
  corridors: Corridor[]
): Float32Array {
  const colors = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    colors[i * 3] = 0.22; colors[i * 3 + 1] = 0.22; colors[i * 3 + 2] = 0.24;
  }
  corridors.forEach((c, idx) => {
    const [r, g, b] = CORRIDOR_PALETTE[idx % CORRIDOR_PALETTE.length];
    for (const v of c.vertexIds) {
      colors[v * 3] = r; colors[v * 3 + 1] = g; colors[v * 3 + 2] = b;
    }
  });
  return colors;
}
