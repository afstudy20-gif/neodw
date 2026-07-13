import { describe, it, expect } from 'vitest';
import { computeDeploymentResult } from './ValveDeployment';
import type { ValveFamily, ValveSize } from './TAVIValveDatabase';

function family(type: 'balloon-expandable' | 'self-expanding'): ValveFamily {
  return {
    name: type === 'balloon-expandable' ? 'Sapien 3' : 'Evolut FX',
    manufacturer: 'test',
    type,
    sizes: [],
  };
}
function size(label: number): ValveSize {
  return {
    size: label,
    perimeterDiameterMin: 0, perimeterDiameterMax: 0,
    areaMin: 0, areaMax: 0, perimeterMin: 0, perimeterMax: 0,
  };
}

describe('computeDeploymentResult — cover index / oversizing', () => {
  it('uses AREA metric for balloon-expandable', () => {
    // Annulus perimeter 75mm → perim-diameter ≈ 23.87; area 440 mm².
    const res = computeDeploymentResult({
      family: family('balloon-expandable'),
      size: size(26),
      annulus: { perimeterMm: 75, areaMm2: 440, minimumDiameterMm: 22, maximumDiameterMm: 26 },
      frameOutflowHeightMm: 15,
      coronaryHeights: {},
      calciumGrades: { annulus: 0, cusp: 0 },
    });
    expect(res.oversizingMetric).toBe('area');
    // Device area = π·13² ≈ 530.9; oversizing ≈ (530.9/440 − 1)·100 ≈ 20.7%
    expect(res.oversizingPct).toBeCloseTo(20.7, 0);
  });

  it('uses PERIMETER metric for self-expanding', () => {
    const res = computeDeploymentResult({
      family: family('self-expanding'),
      size: size(26),
      annulus: { perimeterMm: 75, areaMm2: 440, minimumDiameterMm: 22, maximumDiameterMm: 26 },
      frameOutflowHeightMm: 28,
      coronaryHeights: {},
      calciumGrades: { annulus: 0, cusp: 0 },
    });
    expect(res.oversizingMetric).toBe('perimeter');
    // Perimeter oversizing = (π·26/75 − 1)·100 ≈ 8.8%
    expect(res.oversizingPct).toBeCloseTo(8.8, 0);
  });

  it('cover index reflects (device − annulus)/device', () => {
    const res = computeDeploymentResult({
      family: family('balloon-expandable'),
      size: size(26),
      annulus: { perimeterMm: 75, areaMm2: 440, minimumDiameterMm: 22, maximumDiameterMm: 26 },
      frameOutflowHeightMm: 15,
      coronaryHeights: {},
      calciumGrades: { annulus: 0, cusp: 0 },
    });
    // perimDiameter = 75/π ≈ 23.87; CI = (26 − 23.87)/26·100 ≈ 8.2%
    expect(res.coverIndexPct).toBeCloseTo(8.2, 0);
  });
});

describe('computeDeploymentResult — coronary clearance', () => {
  it('flags high risk when the frame rim sits above the ostium', () => {
    const res = computeDeploymentResult({
      family: family('self-expanding'),
      size: size(29),
      annulus: { perimeterMm: 80, areaMm2: 500, minimumDiameterMm: 24, maximumDiameterMm: 28 },
      frameOutflowHeightMm: 12,
      coronaryHeights: { left: 9, right: 14 },
      calciumGrades: { annulus: 0, cusp: 0 },
    });
    const left = res.coronary.find((c) => c.side === 'left')!;
    expect(left.clearanceMm).toBeCloseTo(-3, 6); // 9 − 12
    expect(left.risk).toBe('high');
    const right = res.coronary.find((c) => c.side === 'right')!;
    expect(right.clearanceMm).toBeCloseTo(2, 6); // 14 − 12
    expect(right.risk).toBe('moderate');
  });

  it('marks low risk when the ostium clears the rim comfortably', () => {
    const res = computeDeploymentResult({
      family: family('balloon-expandable'),
      size: size(26),
      annulus: { perimeterMm: 75, areaMm2: 440, minimumDiameterMm: 22, maximumDiameterMm: 26 },
      frameOutflowHeightMm: 8,
      coronaryHeights: { left: 16, right: 18 },
      calciumGrades: { annulus: 0, cusp: 0 },
    });
    expect(res.coronary.every((c) => c.risk === 'low')).toBe(true);
  });

  it('omits a side when its height is not measured', () => {
    const res = computeDeploymentResult({
      family: family('balloon-expandable'),
      size: size(26),
      annulus: { perimeterMm: 75, areaMm2: 440, minimumDiameterMm: 22, maximumDiameterMm: 26 },
      frameOutflowHeightMm: 8,
      coronaryHeights: { left: 16 },
      calciumGrades: { annulus: 0, cusp: 0 },
    });
    expect(res.coronary).toHaveLength(1);
    expect(res.coronary[0].side).toBe('left');
  });
});

describe('computeDeploymentResult — PVL indicator', () => {
  it('undersizing dominates the PVL score', () => {
    const res = computeDeploymentResult({
      family: family('balloon-expandable'),
      size: size(20),
      annulus: { perimeterMm: 90, areaMm2: 600, minimumDiameterMm: 27, maximumDiameterMm: 30 },
      frameOutflowHeightMm: 10,
      coronaryHeights: {},
      calciumGrades: { annulus: 0, cusp: 0 },
    });
    // perimDiameter ≈ 28.6; CI = (20 − 28.6)/20·100 = −43% → strongly negative
    expect(res.coverIndexPct).toBeLessThan(0);
    // Undersizing alone (35 pts) lands at the top of moderate; combined with
    // eccentricity/calcium it crosses into high. Either band is acceptable here.
    expect(['moderate', 'high']).toContain(res.pvl.band);
    expect(res.pvl.factors.some((f) => /Undersized/.test(f))).toBe(true);
  });

  it('undersizing + severe calcium pushes PVL into high', () => {
    const res = computeDeploymentResult({
      family: family('balloon-expandable'),
      size: size(20),
      annulus: { perimeterMm: 90, areaMm2: 600, minimumDiameterMm: 27, maximumDiameterMm: 30 },
      frameOutflowHeightMm: 10,
      coronaryHeights: {},
      calciumGrades: { annulus: 3, cusp: 2 },
    });
    // 35 (undersizing) + 25 (severe annular Ca) + 8 (cusp Ca) = 68 → high
    expect(res.pvl.band).toBe('high');
  });

  it('severe annular calcium raises PVL band', () => {
    const res = computeDeploymentResult({
      family: family('self-expanding'),
      size: size(26),
      annulus: { perimeterMm: 75, areaMm2: 440, minimumDiameterMm: 22, maximumDiameterMm: 26 },
      frameOutflowHeightMm: 28,
      coronaryHeights: {},
      calciumGrades: { annulus: 3, cusp: 2 },
    });
    expect(res.pvl.score).toBeGreaterThanOrEqual(33); // 25 (annulus) + 8 (cusp)
    expect(['moderate', 'high']).toContain(res.pvl.band);
  });

  it('a well-sized round annulus with no calcium is low PVL', () => {
    const res = computeDeploymentResult({
      family: family('balloon-expandable'),
      size: size(26),
      annulus: { perimeterMm: 78, areaMm2: 480, minimumDiameterMm: 24, maximumDiameterMm: 25 },
      frameOutflowHeightMm: 10,
      coronaryHeights: {},
      calciumGrades: { annulus: 0, cusp: 0 },
    });
    expect(res.pvl.band).toBe('low');
  });

  it('PVL score is capped at 100', () => {
    const res = computeDeploymentResult({
      family: family('balloon-expandable'),
      size: size(20),
      annulus: { perimeterMm: 95, areaMm2: 700, minimumDiameterMm: 28, maximumDiameterMm: 34 },
      frameOutflowHeightMm: 10,
      coronaryHeights: {},
      calciumGrades: { annulus: 3, cusp: 3 },
    });
    expect(res.pvl.score).toBeLessThanOrEqual(100);
  });
});
