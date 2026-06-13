import { describe, it, expect } from 'vitest';
import dicomParser from 'dicom-parser';
import { buildSecondaryCaptureDicom } from './jpegToDicom';

describe('buildSecondaryCaptureDicom', () => {
  it('builds a parseable RGB Secondary Capture with correct image-pixel tags', () => {
    const rows = 2, columns = 3;
    const pixels = new Uint8Array(rows * columns * 3);
    for (let i = 0; i < pixels.length; i++) pixels[i] = i * 7; // arbitrary
    const bytes = buildSecondaryCaptureDicom({ rows, columns, pixels, patientName: 'TEST^SC' });

    const ds = dicomParser.parseDicom(bytes);
    expect((ds.string('x00080016') ?? '').trim()).toBe('1.2.840.10008.5.1.4.1.1.7'); // SC SOP class
    expect(ds.uint16('x00280002')).toBe(3); // SamplesPerPixel
    expect((ds.string('x00280004') ?? '').trim()).toBe('RGB');
    expect(ds.uint16('x00280010')).toBe(rows);
    expect(ds.uint16('x00280011')).toBe(columns);
    expect(ds.uint16('x00280100')).toBe(8); // BitsAllocated
    expect((ds.string('x00100010') ?? '').trim()).toBe('TEST^SC');
    expect(ds.uint16('x00280006')).toBe(0); // PlanarConfiguration present for RGB
    const px = ds.elements['x7fe00010'];
    expect(px).toBeDefined();
    expect(px.length).toBe(rows * columns * 3); // 18, already even
  });

  it('builds a MONOCHROME2 grayscale SC with 1 sample per pixel and no planar config', () => {
    const rows = 4, columns = 4;
    const pixels = new Uint8Array(rows * columns).fill(128);
    const bytes = buildSecondaryCaptureDicom({ rows, columns, pixels, photometric: 'MONOCHROME2' });
    const ds = dicomParser.parseDicom(bytes);
    expect(ds.uint16('x00280002')).toBe(1);
    expect((ds.string('x00280004') ?? '').trim()).toBe('MONOCHROME2');
    expect(ds.elements['x00280006']).toBeUndefined(); // no PlanarConfiguration for 1 sample
  });

  it('pads odd-length pixel data to an even length', () => {
    // 1×1 RGB = 3 bytes (odd) → padded to 4.
    const bytes = buildSecondaryCaptureDicom({ rows: 1, columns: 1, pixels: new Uint8Array([10, 20, 30]) });
    const ds = dicomParser.parseDicom(bytes);
    expect(ds.elements['x7fe00010'].length).toBe(4);
  });

  it('reuses a supplied study/series UID for grouping', () => {
    const studyUID = '2.25.123';
    const seriesUID = '2.25.456';
    const bytes = buildSecondaryCaptureDicom({
      rows: 2, columns: 2, pixels: new Uint8Array(12), studyInstanceUID: studyUID, seriesInstanceUID: seriesUID,
    });
    const ds = dicomParser.parseDicom(bytes);
    expect((ds.string('x0020000d') ?? '').trim()).toBe(studyUID);
    expect((ds.string('x0020000e') ?? '').trim()).toBe(seriesUID);
  });

  it('throws when the pixel buffer is too short for the dimensions', () => {
    expect(() => buildSecondaryCaptureDicom({ rows: 4, columns: 4, pixels: new Uint8Array(5) }))
      .toThrow(/too short/);
  });
});
