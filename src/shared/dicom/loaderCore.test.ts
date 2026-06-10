import { describe, it, expect } from 'vitest';
import {
  wrapWithPart10Header,
  isSecondaryCaptureSopClass,
  isNonImageSopClass,
} from './loaderCore';

describe('wrapWithPart10Header', () => {
  const raw = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
  const wrapped = wrapWithPart10Header(raw);

  it('prepends a 128-byte zero preamble', () => {
    expect(wrapped.slice(0, 128).every((b) => b === 0)).toBe(true);
  });

  it('writes the "DICM" magic at offset 128', () => {
    const magic = String.fromCharCode(...wrapped.slice(128, 132));
    expect(magic).toBe('DICM');
  });

  it('appends the original dataset bytes unchanged at the end', () => {
    expect(Array.from(wrapped.slice(-4))).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
  });

  it('emits the FileMetaInformationGroupLength element (0002,0000) UL', () => {
    // tag 02 00 00 00, VR "UL", length 04 00
    const meta = wrapped.slice(132, 142);
    expect(Array.from(meta.slice(0, 4))).toEqual([0x02, 0x00, 0x00, 0x00]);
    expect(String.fromCharCode(meta[4], meta[5])).toBe('UL');
    expect(meta[6]).toBe(0x04); // length low byte
    expect(meta[7]).toBe(0x00); // length high byte
  });

  it('declares Implicit VR Little Endian as the transfer syntax', () => {
    // group-length element is 12 bytes (4 tag + 2 VR + 2 len + 4 value),
    // so the TransferSyntaxUID element starts at 132 + 12 = 144.
    const tsElement = wrapped.slice(144);
    expect(Array.from(tsElement.slice(0, 4))).toEqual([0x02, 0x00, 0x10, 0x00]);
    expect(String.fromCharCode(tsElement[4], tsElement[5])).toBe('UI');
    const len = tsElement[6] | (tsElement[7] << 8);
    const uid = String.fromCharCode(...tsElement.slice(8, 8 + len)).replace(/\0+$/, '');
    expect(uid).toBe('1.2.840.10008.1.2');
  });

  it('pads the transfer syntax UID to an even length', () => {
    // "1.2.840.10008.1.2" is 17 chars (odd) → padded to 18 with a null byte.
    const len = wrapped[150] | (wrapped[151] << 8);
    expect(len % 2).toBe(0);
    expect(len).toBe(18);
  });

  it('returns a new array without mutating the input', () => {
    const input = new Uint8Array([1, 2, 3]);
    const before = Array.from(input);
    wrapWithPart10Header(input);
    expect(Array.from(input)).toEqual(before);
  });
});

describe('isSecondaryCaptureSopClass', () => {
  it('matches the base Secondary Capture SOP Class', () => {
    expect(isSecondaryCaptureSopClass('1.2.840.10008.5.1.4.1.1.7')).toBe(true);
  });

  it('matches multi-frame Secondary Capture variants', () => {
    expect(isSecondaryCaptureSopClass('1.2.840.10008.5.1.4.1.1.7.2')).toBe(true);
    expect(isSecondaryCaptureSopClass('1.2.840.10008.5.1.4.1.1.7.4')).toBe(true);
  });

  it('rejects CT Image Storage and other non-SC classes', () => {
    expect(isSecondaryCaptureSopClass('1.2.840.10008.5.1.4.1.1.2')).toBe(false);
    expect(isSecondaryCaptureSopClass('1.2.840.10008.5.1.4.1.1.77')).toBe(false);
  });

  it('returns false for undefined/empty input', () => {
    expect(isSecondaryCaptureSopClass(undefined)).toBe(false);
    expect(isSecondaryCaptureSopClass('')).toBe(false);
  });
});

describe('isNonImageSopClass', () => {
  it('flags DICOMDIR, SR, presentation state, segmentation, and RT objects', () => {
    expect(isNonImageSopClass('1.2.840.10008.1.3.10')).toBe(true); // DICOMDIR
    expect(isNonImageSopClass('1.2.840.10008.5.1.4.1.1.88.11')).toBe(true); // SR
    expect(isNonImageSopClass('1.2.840.10008.5.1.4.1.1.11.1')).toBe(true); // PR State
    expect(isNonImageSopClass('1.2.840.10008.5.1.4.1.1.66')).toBe(true); // Segmentation
    expect(isNonImageSopClass('1.2.840.10008.5.1.4.1.1.481.5')).toBe(true); // RT Plan
  });

  it('allows true image SOP classes (CT, MR, XA, US)', () => {
    expect(isNonImageSopClass('1.2.840.10008.5.1.4.1.1.2')).toBe(false); // CT
    expect(isNonImageSopClass('1.2.840.10008.5.1.4.1.1.4')).toBe(false); // MR
    expect(isNonImageSopClass('1.2.840.10008.5.1.4.1.1.12.1')).toBe(false); // XA
  });

  it('does not treat a prefix-lookalike as a match without a dot boundary', () => {
    // "...1.1.88" is non-image, but "...1.1.888" (hypothetical) must not match.
    expect(isNonImageSopClass('1.2.840.10008.5.1.4.1.1.888')).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(isNonImageSopClass('')).toBe(false);
  });
});
