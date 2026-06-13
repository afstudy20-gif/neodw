import { describe, it, expect } from 'vitest';
import { TAVIGeometry } from './TAVIGeometry';

describe('TAVIGeometry.perpendicularityDeviationDegrees', () => {
  it('is 0° for identical normals', () => {
    expect(TAVIGeometry.perpendicularityDeviationDegrees({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 1 })).toBeCloseTo(0, 6);
  });
  it('folds antiparallel normals to 0° (en-face from either side)', () => {
    expect(TAVIGeometry.perpendicularityDeviationDegrees({ x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 })).toBeCloseTo(0, 6);
  });
  it('is 90° for orthogonal normals', () => {
    expect(TAVIGeometry.perpendicularityDeviationDegrees({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })).toBeCloseTo(90, 6);
  });
  it('measures a 30° tilt', () => {
    const n = { x: Math.sin((30 * Math.PI) / 180), y: 0, z: Math.cos((30 * Math.PI) / 180) };
    expect(TAVIGeometry.perpendicularityDeviationDegrees(n, { x: 0, y: 0, z: 1 })).toBeCloseTo(30, 4);
  });
  it('normalizes non-unit inputs', () => {
    expect(TAVIGeometry.perpendicularityDeviationDegrees({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 1 })).toBeCloseTo(0, 6);
  });
  it('returns 0 defensively for a zero vector', () => {
    expect(TAVIGeometry.perpendicularityDeviationDegrees({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })).toBe(0);
  });
});

describe('TAVIGeometry.discRingPoints', () => {
  const centroid = { x: 1, y: 2, z: 3 };
  const normal = { x: 0, y: 0, z: 1 };
  const ring = TAVIGeometry.discRingPoints(centroid, normal, 5, 32);

  it('returns the requested number of points', () => {
    expect(ring).toHaveLength(32);
  });
  it('places every point at the requested radius', () => {
    for (const p of ring) {
      expect(Math.hypot(p.x - centroid.x, p.y - centroid.y, p.z - centroid.z)).toBeCloseTo(5, 5);
    }
  });
  it('keeps every point on the plane through the centroid', () => {
    for (const p of ring) {
      expect(TAVIGeometry.distanceFromPointToPlane(p, centroid, normal)).toBeCloseTo(0, 6);
    }
  });
});
