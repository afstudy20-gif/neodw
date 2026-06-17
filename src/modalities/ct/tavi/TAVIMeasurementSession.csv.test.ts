import { describe, it, expect } from 'vitest';
import { TAVIMeasurementSession } from './TAVIMeasurementSession';
import type { TAVIGeometryResult } from './TAVITypes';

function rows(csv: string): string[][] {
  return csv.split('\n').map((line) => line.split(',').map((c) => c.replace(/^"|"$/g, '')));
}

function geom(overrides: Partial<TAVIGeometryResult> = {}): TAVIGeometryResult {
  return {
    perimeterMm: 72.0,
    areaMm2: 400.0,
    equivalentDiameterMm: 22.6,
    minimumDiameterMm: 20.0,
    maximumDiameterMm: 25.0,
    centroid: { x: 0, y: 0, z: 0 },
    planeNormal: { x: 0, y: 0, z: 1 },
    majorAxisDirection: { x: 1, y: 0, z: 0 },
    minorAxisDirection: { x: 0, y: 1, z: 0 },
    ...overrides,
  };
}

describe('TAVIMeasurementSession.csvReport', () => {
  it('emits a header row plus the always-present cusp-grade and access rows for an empty session', () => {
    const s = new TAVIMeasurementSession();
    const r = rows(s.csvReport());
    expect(r[0]).toEqual(['Parameter', 'Value', 'Unit']);
    // Empty session: header + LCC/RCC/NCC Ca Grade (always emitted) + 2 access rows.
    const labels = r.map((row) => row[0]);
    expect(labels).toEqual([
      'Parameter', 'LCC Ca Grade', 'RCC Ca Grade', 'NCC Ca Grade',
      'Planned Access', 'Planned Pigtail Access',
    ]);
  });

  it('every cell is double-quoted and every row has exactly 3 columns', () => {
    const s = new TAVIMeasurementSession();
    s.annulusGeometry = geom();
    const csv = s.csvReport();
    for (const line of csv.split('\n')) {
      expect(line.split(',')).toHaveLength(3);
      for (const cell of line.split(',')) {
        expect(cell.startsWith('"') && cell.endsWith('"')).toBe(true);
      }
    }
  });

  it('renders annulus perimeter (1dp) and eccentricity (3dp) from the active geometry', () => {
    const s = new TAVIMeasurementSession();
    s.annulusGeometry = geom({ perimeterMm: 72.34, minimumDiameterMm: 20, maximumDiameterMm: 25 });
    const r = rows(s.csvReport());
    const perim = r.find((row) => row[0] === 'Annulus Perimeter');
    expect(perim).toEqual(['Annulus Perimeter', '72.3', 'mm']);
    const ecc = r.find((row) => row[0] === 'Annulus Eccentricity');
    // 1 - 20/25 = 0.2
    expect(ecc).toEqual(['Annulus Eccentricity', '0.200', '']);
  });

  it('uses the assisted geometry when useAssistedAnnulusForPlanning is set', () => {
    const s = new TAVIMeasurementSession();
    s.annulusGeometry = geom({ perimeterMm: 60.0 });
    s.assistedAnnulusGeometry = geom({ perimeterMm: 80.0 });
    s.useAssistedAnnulusForPlanning = true;
    const r = rows(s.csvReport());
    const perim = r.find((row) => row[0] === 'Annulus Perimeter');
    expect(perim?.[1]).toBe('80.0');
  });

  it('includes coronary heights when present', () => {
    const s = new TAVIMeasurementSession();
    s.leftCoronaryHeightMm = 12.4;
    s.rightCoronaryHeightMm = 15.6;
    const r = rows(s.csvReport());
    expect(r.find((row) => row[0] === 'LCA Height')).toEqual(['LCA Height', '12.4', 'mm']);
    expect(r.find((row) => row[0] === 'RCA Height')).toEqual(['RCA Height', '15.6', 'mm']);
  });
});

describe('TAVIMeasurementSession.annulusPointsCsvReport', () => {
  it('exports cusps, ostia, raw annulus points, and interpolated annulus points', () => {
    const s = new TAVIMeasurementSession();
    s.cuspLCC = { x: 1, y: 2, z: 3 };
    s.leftOstiumSnapshot = { worldPoint: { x: 4, y: 5, z: 6 } };
    s.leftCoronaryHeightMm = 12.25;
    s.annulusRawContourPoints = [
      { x: 10, y: 11, z: 12 },
      { x: 13, y: 14, z: 15 },
    ];
    s.annulusSnapshot = {
      worldPoints: [{ x: 20, y: 21, z: 22 }],
      pixelPoints: [],
      planeOrigin: { x: 10, y: 11, z: 12 },
      planeNormal: { x: 0, y: 0, z: 1 },
    };

    const r = rows(s.annulusPointsCsvReport());
    expect(r[0]).toEqual(['Group', 'Label', 'Index', 'X', 'Y', 'Z', 'Note']);
    expect(r).toContainEqual(['Cusp', 'LCC', '', '1.000', '2.000', '3.000', '']);
    expect(r).toContainEqual(['Ostium', 'LCA', '', '4.000', '5.000', '6.000', 'height 12.3 mm']);
    expect(r).toContainEqual(['Annulus raw contour', 'Raw', '1', '13.000', '14.000', '15.000', '']);
    expect(r).toContainEqual(['Annulus interpolated contour', 'Interpolated', '0', '20.000', '21.000', '22.000', '']);
  });
});
