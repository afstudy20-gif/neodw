import { describe, expect, it } from 'vitest';
import {
  distance3,
  angle3,
  computeValue,
  formatMeasurement,
  serializeRecord,
  deserializeRecord,
  storageKey,
  type MeasurementRecord,
  type Vec3,
} from './measure3d';

describe('distance3', () => {
  it('measures a 3-4-5 triangle hypotenuse', () => {
    expect(distance3([0, 0, 0], [3, 4, 0])).toBeCloseTo(5, 9);
  });
  it('is zero for identical points', () => {
    expect(distance3([1, 2, 3], [1, 2, 3])).toBe(0);
  });
});

describe('angle3', () => {
  it('is 90° for perpendicular arms', () => {
    expect(angle3([1, 0, 0], [0, 0, 0], [0, 1, 0])).toBeCloseTo(90, 6);
  });
  it('is 180° for opposite arms', () => {
    expect(angle3([1, 0, 0], [0, 0, 0], [-1, 0, 0])).toBeCloseTo(180, 6);
  });
  it('is 0° for coincident arms', () => {
    expect(angle3([1, 0, 0], [0, 0, 0], [1, 0, 0])).toBeCloseTo(0, 6);
  });
  it('returns 0 (not NaN) for a degenerate zero-length arm', () => {
    expect(angle3([0, 0, 0], [0, 0, 0], [1, 0, 0])).toBe(0);
  });
});

describe('computeValue', () => {
  const pts: Vec3[] = [[0, 0, 0], [3, 4, 0], [0, 4, 0]];
  it('needs 2 points for distance, else null', () => {
    expect(computeValue('distance', pts.slice(0, 1))).toBeNull();
    expect(computeValue('distance', pts.slice(0, 2))).toBeCloseTo(5, 9);
  });
  it('needs 3 points for angle, else null', () => {
    expect(computeValue('angle', pts.slice(0, 2))).toBeNull();
    expect(computeValue('angle', pts)).toBeGreaterThan(0);
  });
});

describe('formatMeasurement', () => {
  it('labels distance in mm and angle in degrees', () => {
    expect(formatMeasurement({ id: 'a', kind: 'distance', points: [], value: 42.73 })).toBe('42.7 mm');
    expect(formatMeasurement({ id: 'b', kind: 'angle', points: [], value: 118.37 })).toBe('118.4°');
  });
});

describe('persistence round-trip', () => {
  const record: MeasurementRecord = {
    seriesKey: '1.2.3.4',
    measurements: [{ id: 'm1', kind: 'distance', points: [[0, 0, 0], [1, 0, 0]], value: 1 }],
    annotations: [{ id: 'a1', point: [2, 3, 4], text: 'calcium nodule' }],
  };

  it('serializes and deserializes losslessly', () => {
    const back = deserializeRecord('1.2.3.4', serializeRecord(record));
    expect(back).toEqual(record);
  });

  it('returns an empty record for missing storage', () => {
    expect(deserializeRecord('s', null)).toEqual({ seriesKey: 's', measurements: [], annotations: [] });
  });

  it('recovers from a corrupt entry without throwing', () => {
    expect(deserializeRecord('s', '{not json')).toEqual({ seriesKey: 's', measurements: [], annotations: [] });
  });

  it('tolerates partial records (missing arrays)', () => {
    const back = deserializeRecord('s', JSON.stringify({ seriesKey: 's' }));
    expect(back.measurements).toEqual([]);
    expect(back.annotations).toEqual([]);
  });

  it('namespaces the storage key', () => {
    expect(storageKey('1.2.3')).toBe('neodw:measure3d:1.2.3');
  });
});
