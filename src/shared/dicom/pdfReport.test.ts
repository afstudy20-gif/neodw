import { describe, expect, it } from 'vitest';
import { buildPdfReport } from './pdfReport';

describe('buildPdfReport', () => {
  it('loads jsPDF and returns PDF bytes', async () => {
    const bytes = await buildPdfReport({
      title: 'NeoDW Test Report',
      generatedAt: new Date('2026-01-01T00:00:00.000Z'),
      sections: [
        {
          title: 'Measurements',
          rows: [
            { label: 'Diameter', value: '24.0', unit: 'mm' },
          ],
        },
      ],
    });

    expect(bytes.slice(0, 4)).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    expect(bytes.length).toBeGreaterThan(500);
  });
});
