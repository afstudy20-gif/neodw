import { describe, expect, it } from 'vitest';
import { computeMrVoiRange, pickDefaultWindowLevelPreset } from './windowLevel';
import type { DicomSeriesInfo } from './core/dicomLoader';

function series(patch: Partial<DicomSeriesInfo>): DicomSeriesInfo {
  return {
    seriesInstanceUID: '1',
    seriesDescription: '',
    modality: 'MR',
    numImages: 1,
    imageIds: [],
    patientName: 'P',
    studyDescription: '',
    studyDate: '',
    ...patch,
  };
}

describe('pickDefaultWindowLevelPreset', () => {
  it('keeps CT spine on bone', () => {
    expect(pickDefaultWindowLevelPreset(series({ modality: 'CT', seriesDescription: 'L Lomber 1.0' }))).toBe('Bone');
  });

  it('detects common lumbar MR sequences from series text', () => {
    expect(pickDefaultWindowLevelPreset(series({ seriesDescription: 'sag t1_tse' }))).toBe('T1');
    expect(pickDefaultWindowLevelPreset(series({ seriesDescription: 'tra T2 TSE' }))).toBe('T2');
    expect(pickDefaultWindowLevelPreset(series({ seriesDescription: 'sag T2 TIRM' }))).toBe('STIR/TIRM');
    expect(pickDefaultWindowLevelPreset(series({ seriesDescription: 'SAG FLAIR' }))).toBe('FLAIR');
    expect(pickDefaultWindowLevelPreset(series({ seriesDescription: 'ep2d_diff_b1000 ADC' }))).toBe('DWI/ADC');
  });

  it('falls back to TR/TE/TI when description is vague', () => {
    expect(pickDefaultWindowLevelPreset(series({ seriesDescription: 'SAG', repetitionTime: '500', echoTime: '12' }))).toBe('T1');
    expect(pickDefaultWindowLevelPreset(series({ seriesDescription: 'TRA', repetitionTime: '3500', echoTime: '105' }))).toBe('T2');
    expect(pickDefaultWindowLevelPreset(series({ seriesDescription: 'COR', inversionTime: '160' }))).toBe('STIR/TIRM');
  });
});

describe('computeMrVoiRange', () => {
  it('uses robust MR percentiles and ignores zero background plus bright outliers', () => {
    const values = [
      ...Array(500).fill(0),
      ...Array.from({ length: 9000 }, (_, i) => 120 + (i % 700)),
      ...Array(20).fill(12000),
    ];

    const range = computeMrVoiRange(values, 'T1');

    expect(range).not.toBeNull();
    expect(range!.lower).toBeGreaterThanOrEqual(120);
    expect(range!.upper).toBeLessThan(1200);
    expect(range!.upper).toBeGreaterThan(range!.lower);
  });

  it('keeps T2 SPACE from using the full outlier range', () => {
    const values = [
      ...Array(1000).fill(0),
      ...Array.from({ length: 7000 }, (_, i) => 80 + (i % 260)),
      ...Array.from({ length: 2000 }, (_, i) => 420 + (i % 520)),
      ...Array(40).fill(6000),
    ];

    const range = computeMrVoiRange(values, 'T2');

    expect(range).not.toBeNull();
    expect(range!.lower).toBeGreaterThanOrEqual(80);
    expect(range!.upper).toBeLessThan(1200);
  });

  it('waits instead of applying a black zero-width window when volume data is not ready', () => {
    expect(computeMrVoiRange(undefined, 'T2')).toBeNull();
  });
});
