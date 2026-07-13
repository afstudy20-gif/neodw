import { describe, expect, it } from 'vitest';
import { buildDicomSeg, type SegInput } from './dicomSeg';

function baseInput(): SegInput {
  return {
    mask: new Uint8Array([1, 0, 0, 0, 0, 1, 0, 0]),
    rows: 2,
    columns: 2,
    slices: 2,
    pixelSpacing: [0.5, 0.5],
    sliceThickness: 1,
    imagePositionPatient: [0, 0, 0],
    imageOrientationPatient: [1, 0, 0, 0, 1, 0],
    source: {
      studyInstanceUid: '1.2.3',
      seriesInstanceUid: '1.2.3.4',
      sopInstanceUids: ['1.2.3.4.1', '1.2.3.4.2'],
      sopClassUid: '1.2.840.10008.5.1.4.1.1.2',
      patientName: 'ANON',
      patientId: 'P1',
    },
    label: 'Test segment',
  };
}

describe('buildDicomSeg input validation', () => {
  it('rejects mask length mismatches before writing invalid pixel data', () => {
    const input = baseInput();
    input.mask = new Uint8Array(7);

    expect(() => buildDicomSeg(input)).toThrow(
      'SEG mask length mismatch: expected 8 bytes (2 slices x 2 rows x 2 columns), got 7'
    );
  });

  it('rejects source frame-count mismatches before writing invalid references', () => {
    const input = baseInput();
    input.source.sopInstanceUids = ['1.2.3.4.1'];

    expect(() => buildDicomSeg(input)).toThrow(
      'SEG source SOP Instance UID count mismatch: expected 2, got 1'
    );
  });

  it('writes a Part-10 SEG object for valid input', () => {
    const result = buildDicomSeg(baseInput());

    expect(result.bytes.slice(128, 132)).toEqual(new Uint8Array([0x44, 0x49, 0x43, 0x4d]));
    expect(result.segSopInstanceUid).toMatch(/^2\.25\./);
    expect(result.segSeriesInstanceUid).toMatch(/^2\.25\./);
  });
});
