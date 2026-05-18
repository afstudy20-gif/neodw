// Volume + intensity statistics for a binary mask over a scalar volume.
// Used by segmentation panels to produce CSV/JSON reports.

export interface VolumeStatsInput {
  mask: Uint8Array;
  scalarData?: Float32Array | Int16Array | Uint16Array;
  dims: [number, number, number]; // [cols, rows, slices]
  spacing: [number, number, number]; // mm
}

export interface VolumeStatsResult {
  voxelCount: number;
  volumeMm3: number;
  volumeMl: number;
  meanHu: number;
  stdHu: number;
  minHu: number;
  maxHu: number;
  bboxIjkMin: [number, number, number];
  bboxIjkMax: [number, number, number];
  bboxSizeMm: [number, number, number];
}

export function computeVolumeStats(input: VolumeStatsInput): VolumeStatsResult {
  const { mask, scalarData, dims, spacing } = input;
  const [cols, rows, slices] = dims;
  const sliceSize = cols * rows;

  let count = 0;
  let sum = 0;
  let sumSq = 0;
  let minHu = Number.POSITIVE_INFINITY;
  let maxHu = Number.NEGATIVE_INFINITY;
  let minX = cols, maxX = -1;
  let minY = rows, maxY = -1;
  let minZ = slices, maxZ = -1;

  for (let z = 0; z < slices; z += 1) {
    const baseZ = z * sliceSize;
    for (let y = 0; y < rows; y += 1) {
      const baseY = baseZ + y * cols;
      for (let x = 0; x < cols; x += 1) {
        if (!mask[baseY + x]) continue;
        count += 1;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        if (scalarData) {
          const v = scalarData[baseY + x];
          sum += v;
          sumSq += v * v;
          if (v < minHu) minHu = v;
          if (v > maxHu) maxHu = v;
        }
      }
    }
  }

  const voxelMm3 = spacing[0] * spacing[1] * spacing[2];
  const volumeMm3 = count * voxelMm3;

  const meanHu = count > 0 && scalarData ? sum / count : 0;
  const variance = count > 0 && scalarData ? Math.max(0, sumSq / count - meanHu * meanHu) : 0;
  const stdHu = Math.sqrt(variance);

  const bboxIjkMin: [number, number, number] = count > 0 ? [minX, minY, minZ] : [0, 0, 0];
  const bboxIjkMax: [number, number, number] = count > 0 ? [maxX, maxY, maxZ] : [0, 0, 0];
  const bboxSizeMm: [number, number, number] = count > 0
    ? [
        (maxX - minX + 1) * spacing[0],
        (maxY - minY + 1) * spacing[1],
        (maxZ - minZ + 1) * spacing[2],
      ]
    : [0, 0, 0];

  return {
    voxelCount: count,
    volumeMm3,
    volumeMl: volumeMm3 / 1000,
    meanHu: scalarData ? meanHu : Number.NaN,
    stdHu: scalarData ? stdHu : Number.NaN,
    minHu: scalarData && Number.isFinite(minHu) ? minHu : Number.NaN,
    maxHu: scalarData && Number.isFinite(maxHu) ? maxHu : Number.NaN,
    bboxIjkMin,
    bboxIjkMax,
    bboxSizeMm,
  };
}

export interface StatsCsvRow {
  label: string;
  stats: VolumeStatsResult;
  extra?: Record<string, string | number>;
}

export function statsToCsv(rows: StatsCsvRow[]): string {
  if (rows.length === 0) return '';
  const baseHeaders = [
    'label',
    'voxel_count',
    'volume_mm3',
    'volume_ml',
    'mean_hu',
    'std_hu',
    'min_hu',
    'max_hu',
    'bbox_min_i', 'bbox_min_j', 'bbox_min_k',
    'bbox_max_i', 'bbox_max_j', 'bbox_max_k',
    'bbox_size_mm_x', 'bbox_size_mm_y', 'bbox_size_mm_z',
  ];
  const extraKeys = new Set<string>();
  for (const r of rows) {
    if (r.extra) for (const k of Object.keys(r.extra)) extraKeys.add(k);
  }
  const headers = [...baseHeaders, ...extraKeys];
  const lines: string[] = [headers.join(',')];

  for (const r of rows) {
    const s = r.stats;
    const cells: (string | number)[] = [
      escape(r.label),
      s.voxelCount,
      s.volumeMm3.toFixed(2),
      s.volumeMl.toFixed(3),
      Number.isFinite(s.meanHu) ? s.meanHu.toFixed(2) : '',
      Number.isFinite(s.stdHu) ? s.stdHu.toFixed(2) : '',
      Number.isFinite(s.minHu) ? s.minHu.toFixed(1) : '',
      Number.isFinite(s.maxHu) ? s.maxHu.toFixed(1) : '',
      s.bboxIjkMin[0], s.bboxIjkMin[1], s.bboxIjkMin[2],
      s.bboxIjkMax[0], s.bboxIjkMax[1], s.bboxIjkMax[2],
      s.bboxSizeMm[0].toFixed(2), s.bboxSizeMm[1].toFixed(2), s.bboxSizeMm[2].toFixed(2),
    ];
    for (const k of extraKeys) {
      const v = r.extra?.[k];
      cells.push(v === undefined ? '' : escape(String(v)));
    }
    lines.push(cells.join(','));
  }
  return lines.join('\n');
}

function escape(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function downloadCsv(csv: string, filename = 'volume-stats.csv'): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
