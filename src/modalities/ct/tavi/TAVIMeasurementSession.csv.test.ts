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
  it('emits a header row plus the always-present access rows for an empty session', () => {
    const s = new TAVIMeasurementSession();
    const r = rows(s.csvReport());
    expect(r[0]).toEqual(['Parameter', 'Value', 'Unit']);
    // Empty session has no annulus/structure rows — only the 2 access rows follow.
    expect(r).toHaveLength(3);
    expect(r[1][0]).toBe('Planned Access');
    expect(r[2][0]).toBe('Planned Pigtail Access');
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
