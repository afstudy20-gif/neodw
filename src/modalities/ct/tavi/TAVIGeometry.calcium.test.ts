import { describe, it, expect } from 'vitest';
import { TAVIGeometry } from './TAVIGeometry';

describe('TAVIGeometry.calciumResultForPixelValues', () => {
  it('scores zero when every pixel is below 130 HU', () => {
    const px = Float32Array.from([0, 50, 100, 129]);
    const r = TAVIGeometry.calciumResultForPixelValues(px, 1, 850);
    expect(r.agatstonScore2D).toBe(0);
    expect(r.samplesAboveThreshold).toBe(0);
    expect(r.fractionAboveThreshold).toBe(0);
  });

  it('applies the 130/200/300/400 density-factor ladder (pixelArea=1)', () => {
    expect(TAVIGeometry.calciumResultForPixelValues(Float32Array.from([130]), 1, 850).agatstonScore2D).toBe(1);
    expect(TAVIGeometry.calciumResultForPixelValues(Float32Array.from([200]), 1, 850).agatstonScore2D).toBe(2);
    expect(TAVIGeometry.calciumResultForPixelValues(Float32Array.from([300]), 1, 850).agatstonScore2D).toBe(3);
    expect(TAVIGeometry.calciumResultForPixelValues(Float32Array.from([400]), 1, 850).agatstonScore2D).toBe(4);
  });

  it('Agatston is independent of thresholdHU; only the dense fraction tracks it', () => {
    const px = Float32Array.from([100, 500, 900, 1300]);
    const a = TAVIGeometry.calciumResultForPixelValues(px, 1, 850);
    const b = TAVIGeometry.calciumResultForPixelValues(px, 1, 1200);
    expect(a.agatstonScore2D).toBe(b.agatstonScore2D); // fixed 130/400 bands
    expect(a.samplesAboveThreshold).toBe(2); // 900, 1300 ≥ 850
    expect(b.samplesAboveThreshold).toBe(1); // only 1300 ≥ 1200
  });

  it('derives areas from sample counts', () => {
    const px = Float32Array.from([50, 500, 500, 50]);
    const r = TAVIGeometry.calciumResultForPixelValues(px, 0.25, 130);
    expect(r.totalAreaMm2).toBeCloseTo(4 * 0.25, 6);
    expect(r.hyperdenseAreaMm2).toBeCloseTo(2 * 0.25, 6);
  });

  it('guards against an empty array (no div-by-zero)', () => {
    const r = TAVIGeometry.calciumResultForPixelValues(new Float32Array(0), 1, 850);
    expect(r.agatstonScore2D).toBe(0);
    expect(r.fractionAboveThreshold).toBe(0);
    expect(r.totalSamples).toBe(0);
  });
});

describe('TAVIGeometry.discOnPlane', () => {
  const center = { x: 5, y: -3, z: 2 };
  const normal = { x: 0, y: 0, z: 1 };
  const ring = TAVIGeometry.discOnPlane(center, normal, 6, 24);

  it('returns the requested number of vertices', () => {
    expect(ring).toHaveLength(24);
  });

  it('places every vertex at the requested radius from the center', () => {
    for (const p of ring) {
      const d = Math.hypot(p.x - center.x, p.y - center.y, p.z - center.z);
      expect(d).toBeCloseTo(6, 5);
    }
  });

  it('keeps every vertex on the plane through the center', () => {
    for (const p of ring) {
      // normal is +z, so all z should equal center.z
      expect(p.z).toBeCloseTo(center.z, 6);
    }
  });
});
