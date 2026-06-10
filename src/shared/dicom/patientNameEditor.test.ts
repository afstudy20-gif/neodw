import { describe, it, expect } from 'vitest';
import dicomParser from 'dicom-parser';
import { patchPatientName, readFirstPatientName } from './patientNameEditor';
import { buildMinimalDicomFile } from './testHelpers/syntheticDicom';

async function parseName(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ds = dicomParser.parseDicom(bytes);
  return (ds.string('x00100010') ?? '').trim();
}

describe('patchPatientName', () => {
  it('replaces the PatientName and keeps the file re-parseable', async () => {
    const file = buildMinimalDicomFile('DOE^JOHN');
    const result = await patchPatientName(file, 'SMITH^JANE');
    expect(result.originalName).toBe('DOE^JOHN');
    expect(result.newName).toBe('SMITH^JANE');
    expect(await parseName(result.patched)).toBe('SMITH^JANE');
  });

  it('handles a longer replacement (length field grows, offsets shift)', async () => {
    const file = buildMinimalDicomFile('A^B');
    const result = await patchPatientName(file, 'VERYLONGFAMILY^VERYLONGGIVEN');
    expect(await parseName(result.patched)).toBe('VERYLONGFAMILY^VERYLONGGIVEN');
  });

  it('handles a shorter replacement (length field shrinks)', async () => {
    const file = buildMinimalDicomFile('LONGNAME^PATIENT');
    const result = await patchPatientName(file, 'X^Y');
    expect(await parseName(result.patched)).toBe('X^Y');
  });

  it('pads an odd-length name to even byte length', async () => {
    const file = buildMinimalDicomFile('A^B');
    // "ODD^NAME^X" is 10 chars (even); use a 7-char odd value instead.
    const result = await patchPatientName(file, 'ODD^NAM'); // 7 chars → padded to 8
    const bytes = new Uint8Array(await result.patched.arrayBuffer());
    const ds = dicomParser.parseDicom(bytes);
    expect(ds.elements['x00100010'].length % 2).toBe(0);
    expect((ds.string('x00100010') ?? '').trim()).toBe('ODD^NAM');
  });

  it('preserves the original file name', async () => {
    const file = buildMinimalDicomFile('DOE^JOHN', 'study001.dcm');
    const result = await patchPatientName(file, 'ANON^ANON');
    expect(result.patched.name).toBe('study001.dcm');
  });

  it('throws on non-DICOM input', async () => {
    const junk = new File([new Uint8Array([1, 2, 3, 4, 5])], 'junk.bin');
    await expect(patchPatientName(junk, 'X^Y')).rejects.toThrow();
  });
});

describe('readFirstPatientName', () => {
  it('returns the PatientName of the first parseable file', async () => {
    const files = [
      new File([new Uint8Array([0, 1, 2])], 'junk.bin'),
      buildMinimalDicomFile('FIRST^REAL'),
      buildMinimalDicomFile('SECOND^REAL'),
    ];
    expect(await readFirstPatientName(files)).toBe('FIRST^REAL');
  });

  it('returns empty string when nothing parses', async () => {
    const files = [new File([new Uint8Array([0, 1, 2])], 'junk.bin')];
    expect(await readFirstPatientName(files)).toBe('');
  });
});
