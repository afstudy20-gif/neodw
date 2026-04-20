import * as cornerstone from '@cornerstonejs/core';

/**
 * Decorates a Cornerstone metadata provider to:
 * 1. Bypass GE private blocks (0009, 0019, 0021, etc.) that may contain problematic private sequences.
 * 2. Log Transfer Syntax and Pixel Data Structure for debugging.
 */
export function getDecoratedMetaDataProvider(defaultProvider: (type: string, imageId: string) => any) {
  return function (type: string, imageId: string) {
    // 1. Bypass GE Private Blocks
    // GE private groups often contain large or malformed sequences (SQ).
    // Bypassing them at the metadata provider level prevents Cornerstone from 
    // triggering deep parsing of these tags.
    if (
      type.startsWith('x0009') || 
      type.startsWith('x0019') || 
      type.startsWith('x0021') ||
      type.startsWith('x0023') ||
      type.startsWith('x0025') ||
      type.startsWith('x0027') ||
      type.startsWith('x0029')
    ) {
      return undefined;
    }

    const result = defaultProvider(type, imageId);

    // 2. Logging Transfer Syntax and Pixel Data
    // We log when 'imagePixelModule' is requested, as this happens during the main image loading/caching phase.
    if (type === 'imagePixelModule' && result) {
      // Try to get transfer syntax from its specific module
      const tsModule = defaultProvider('transferSyntaxModule', imageId);
      const ts = tsModule?.transferSyntaxUID || 'Unknown Transfer Syntax';
      
      const fileName = imageId.split('/').pop()?.split('?')[0] || 'unknown';
      
      console.log(`%c[DICOM] Data Structure for: ${fileName}`, 'color: #00bcd4; font-weight: bold;');
      console.log(`   - Transfer Syntax: ${ts}`);
      console.log(`   - Dimensions: ${result.rows}x${result.columns}`);
      console.log(`   - Bits: ${result.bitsAllocated}b allocated, ${result.bitsStored}b stored`);
      console.log(`   - Samples: ${result.samplesPerPixel} per pixel (${result.photometricInterpretation || 'Unknown Color Space'})`);
    }

    return result;
  };
}
