import { describe, it, expect } from 'vitest';
import {
  isDicomByMagic,
  looksLikeImplicitDicom,
  isArchiveName,
  sniffArchive,
} from './fileIntake';

function fileFrom(bytes: number[], name = 'f.bin'): File {
  return new File([new Uint8Array(bytes)], name);
}

describe('isDicomByMagic', () => {
  it('detects "DICM" at byte offset 128', async () => {
    const bytes = new Array(132).fill(0);
    bytes[128] = 0x44; // D
    bytes[129] = 0x49; // I
    bytes[130] = 0x43; // C
    bytes[131] = 0x4d; // M
    expect(await isDicomByMagic(fileFrom(bytes))).toBe(true);
  });

  it('rejects files shorter than 132 bytes', async () => {
    expect(await isDicomByMagic(fileFrom(new Array(131).fill(0)))).toBe(false);
  });

  it('rejects files with the wrong magic at offset 128', async () => {
    const bytes = new Array(132).fill(0);
    bytes[128] = 0x4d; // wrong order
    bytes[129] = 0x43;
    bytes[130] = 0x49;
    bytes[131] = 0x44;
    expect(await isDicomByMagic(fileFrom(bytes))).toBe(false);
  });
});

describe('looksLikeImplicitDicom', () => {
  it('accepts a leading group 0x0002 tag with a low element number', async () => {
    // tag (0002,0000): group LE = 02 00, element LE = 00 00
    const bytes = [0x02, 0x00, 0x00, 0x00, ...new Array(124).fill(0)];
    expect(await looksLikeImplicitDicom(fileFrom(bytes))).toBe(true);
  });

  it('accepts a leading group 0x0008 tag', async () => {
    const bytes = [0x08, 0x00, 0x05, 0x00, ...new Array(124).fill(0)];
    expect(await looksLikeImplicitDicom(fileFrom(bytes))).toBe(true);
  });

  it('rejects a non-DICOM group', async () => {
    const bytes = [0xff, 0xab, 0x00, 0x00, ...new Array(124).fill(0)];
    expect(await looksLikeImplicitDicom(fileFrom(bytes))).toBe(false);
  });

  it('rejects files shorter than 128 bytes', async () => {
    expect(await looksLikeImplicitDicom(fileFrom([0x02, 0x00, 0x00, 0x00]))).toBe(false);
  });
});

describe('isArchiveName', () => {
  it('classifies zip / rar / tar-family by extension (case-insensitive)', () => {
    expect(isArchiveName('study.zip')).toBe('zip');
    expect(isArchiveName('STUDY.ZIP')).toBe('zip');
    expect(isArchiveName('disc.rar')).toBe('rar');
    expect(isArchiveName('export.tar')).toBe('tar');
    expect(isArchiveName('export.tar.gz')).toBe('tar');
    expect(isArchiveName('export.tgz')).toBe('tar');
    expect(isArchiveName('export.7z')).toBe('tar');
  });

  it('returns null for non-archive names', () => {
    expect(isArchiveName('image.dcm')).toBeNull();
    expect(isArchiveName('IM0001')).toBeNull();
  });
});

describe('sniffArchive', () => {
  it('detects ZIP by the PK\\x03\\x04 signature regardless of name', async () => {
    const zip = fileFrom([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0], 'noext');
    expect(await sniffArchive(zip)).toBe('zip');
  });

  it('detects RAR by the "Rar!" signature', async () => {
    const rar = fileFrom([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, 0x00], 'noext');
    expect(await sniffArchive(rar)).toBe('rar');
  });

  it('returns null for non-archive content', async () => {
    const dcm = fileFrom([0x02, 0x00, 0x00, 0x00, 0, 0, 0, 0], 'noext');
    expect(await sniffArchive(dcm)).toBeNull();
  });

  it('returns null for files shorter than 8 bytes', async () => {
    expect(await sniffArchive(fileFrom([0x50, 0x4b, 0x03]))).toBeNull();
  });
});
