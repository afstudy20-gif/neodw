// Shared DICOM loader primitives used by every modality loader
// (ct, coronary-ct, angio). Modality-specific concerns — C-arm geometry,
// secondary-capture handling, volume construction — stay in each modality's
// own dicomLoader.ts. Only the pure, modality-agnostic helpers live here.

// Transfer Syntax UID for Implicit VR Little Endian.
const IMPLICIT_VR_LE_UID = '1.2.840.10008.1.2';

/**
 * Wrap a headerless (raw) DICOM byte array into a valid Part 10 file by
 * prepending a 128-byte preamble + "DICM" magic + a minimal File Meta
 * Information group. The meta header is written as Explicit VR Little Endian
 * (per the DICOM standard, group 0002 is always explicit) and declares the
 * dataset transfer syntax as Implicit VR Little Endian.
 *
 * @param rawBytes - raw DICOM dataset bytes with no preamble/meta header
 * @returns a new Uint8Array containing a fully Part 10-compliant file
 */
export function wrapWithPart10Header(rawBytes: Uint8Array): Uint8Array {
  const tsBytes = new TextEncoder().encode(IMPLICIT_VR_LE_UID);
  // DICOM values must be even length; pad UID with a null byte if needed.
  const tsPadded = tsBytes.length % 2 === 0 ? tsBytes : new Uint8Array([...tsBytes, 0x00]);
  const tsElementLength = 8 + tsPadded.length; // tag(4) + VR+len(4) + value
  const groupLengthValue = tsElementLength;

  const metaElements: number[] = [];

  // (0002,0000) UL FileMetaInformationGroupLength
  metaElements.push(0x02, 0x00, 0x00, 0x00); // tag
  metaElements.push(0x55, 0x4c); // VR "UL"
  metaElements.push(0x04, 0x00); // length = 4
  metaElements.push(
    groupLengthValue & 0xff,
    (groupLengthValue >> 8) & 0xff,
    (groupLengthValue >> 16) & 0xff,
    (groupLengthValue >> 24) & 0xff
  );

  // (0002,0010) UI TransferSyntaxUID
  metaElements.push(0x02, 0x00, 0x10, 0x00); // tag
  metaElements.push(0x55, 0x49); // VR "UI"
  metaElements.push(tsPadded.length & 0xff, (tsPadded.length >> 8) & 0xff); // length
  for (let i = 0; i < tsPadded.length; i += 1) {
    metaElements.push(tsPadded[i]);
  }

  const preamble = new Uint8Array(128); // zeros
  const dicm = new Uint8Array([0x44, 0x49, 0x43, 0x4d]); // "DICM"
  const metaHeader = new Uint8Array(metaElements);
  const result = new Uint8Array(128 + 4 + metaHeader.length + rawBytes.length);

  result.set(preamble, 0);
  result.set(dicm, 128);
  result.set(metaHeader, 132);
  result.set(rawBytes, 132 + metaHeader.length);

  return result;
}

/**
 * Secondary Capture variants (incl. multi-frame true/grayscale/color).
 * Cornerstone OrthographicViewport expects a multi-slice MONOCHROME2 volume;
 * SC is typically 1-frame RGB and must render via a stack viewport instead.
 */
export function isSecondaryCaptureSopClass(sopClassUID: string | undefined): boolean {
  if (!sopClassUID) return false;
  return (
    sopClassUID === '1.2.840.10008.5.1.4.1.1.7' ||
    sopClassUID.startsWith('1.2.840.10008.5.1.4.1.1.7.')
  );
}

// SOP Classes that are not image objects and should be hidden from the
// series tile list (radiologist-facing). Horos / OsiriX hide these by
// default. The underlying files are still readable; they just don't appear
// as separate user-facing series. Pattern-based match — any prefix in this
// list deny-lists the series.
const NON_IMAGE_SOP_PREFIXES = [
  '1.2.840.10008.1.3.10',        // Media Storage Directory (DICOMDIR)
  '1.2.840.10008.5.1.4.1.1.8',   // Standalone Overlay Storage
  '1.2.840.10008.5.1.4.1.1.10',  // Standalone VOI LUT Storage
  '1.2.840.10008.5.1.4.1.1.11',  // Presentation State variants
  '1.2.840.10008.5.1.4.1.1.66',  // Segmentation / Surface Segmentation
  '1.2.840.10008.5.1.4.1.1.67',  // Realworld Value Map
  '1.2.840.10008.5.1.4.1.1.78',  // Spectacle Prescription, Macular Grid
  '1.2.840.10008.5.1.4.1.1.88',  // Structured Report variants
  '1.2.840.10008.5.1.4.1.1.9',   // Waveform
  '1.2.840.10008.5.1.4.1.1.104', // Encapsulated PDF / CDA
  '1.2.840.10008.5.1.4.1.1.481', // RT Plan / Structure Set / Dose / Image
];

/**
 * True when the SOP Class UID denotes a non-image object (DICOMDIR, SR,
 * presentation state, segmentation, RT objects, etc.) that should be hidden
 * from the radiologist-facing series list.
 */
export function isNonImageSopClass(sopClassUID: string): boolean {
  if (!sopClassUID) return false;
  for (const prefix of NON_IMAGE_SOP_PREFIXES) {
    if (sopClassUID === prefix || sopClassUID.startsWith(`${prefix}.`)) {
      return true;
    }
  }
  return false;
}
