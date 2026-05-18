// Build a minimal DICOM Segmentation Object (SOP Class 1.2.840.10008.5.1.4.1.1.66.4)
// from a single-label binary mask + reference series metadata.
//
// Output bytes are a Part-10 file ready to dump to disk or upload to PACS.
// Single segment, BINARY segmentation type, Explicit-VR LE.
//
// Reference: DICOM PS3.3 § C.8.20 Segmentation Module.

import {
  buildPart10,
  dicomDate,
  dicomTime,
  generateUid,
  packBits,
  type DicomDataset,
  type DicomElement,
} from './dicomWriter';

const SEG_SOP_CLASS_UID = '1.2.840.10008.5.1.4.1.1.66.4';

export interface SegSourceRef {
  studyInstanceUid: string;
  seriesInstanceUid: string;
  // SOP Instance UIDs per referenced slice (ordered same as mask z-axis)
  sopInstanceUids: string[];
  // Referenced SOP Class UID (e.g. CT Image Storage: 1.2.840.10008.5.1.4.1.1.2)
  sopClassUid: string;
  patientName?: string;
  patientId?: string;
  patientBirthDate?: string;
  patientSex?: string;
}

export interface SegInput {
  // Mask layout: [z, y, x] flat array, mask[z*rows*cols + y*cols + x] ∈ {0, 1}
  mask: Uint8Array;
  rows: number;
  columns: number;
  slices: number;
  // mm per voxel
  pixelSpacing: [number, number]; // [row spacing, col spacing]
  sliceThickness: number;
  // World coords of first slice's top-left voxel
  imagePositionPatient: [number, number, number];
  // Direction cosines, 6 values [Xx Xy Xz Yx Yy Yz]
  imageOrientationPatient: [number, number, number, number, number, number];
  // Inter-slice spacing direction (z) — usually [0,0,1] in patient coords scaled by sliceThickness
  source: SegSourceRef;
  label: string;
  algorithmName?: string;
  algorithmVersion?: string;
  categoryCode?: { code: string; designator: string; meaning: string }; // SCT preferred
  typeCode?: { code: string; designator: string; meaning: string };
  segmentColor?: [number, number, number]; // RGB 0-255
}

export interface SegBuildResult {
  bytes: Uint8Array;
  segSopInstanceUid: string;
  segSeriesInstanceUid: string;
}

const DEFAULT_CATEGORY = { code: 'T-D000A', designator: 'SRT', meaning: 'Anatomical Structure' };
const DEFAULT_TYPE = { code: 'T-D0050', designator: 'SRT', meaning: 'Tissue' };

export function buildDicomSeg(input: SegInput): SegBuildResult {
  const segSeriesUid = generateUid();
  const segSopUid = generateUid();
  const frameOfReferenceUid = generateUid();
  const contentDate = dicomDate();
  const contentTime = dicomTime();

  // ── Determine which slices contain segmentation foreground (non-empty frames)
  const sliceSize = input.rows * input.columns;
  const includedFrames: number[] = [];
  for (let z = 0; z < input.slices; z += 1) {
    let any = false;
    const base = z * sliceSize;
    for (let i = 0; i < sliceSize; i += 1) {
      if (input.mask[base + i]) { any = true; break; }
    }
    if (any) includedFrames.push(z);
  }
  if (includedFrames.length === 0) {
    // Include all to avoid empty SEG. Reader still gets a valid object.
    for (let z = 0; z < input.slices; z += 1) includedFrames.push(z);
  }

  // ── Build packed pixel data from included frames
  const totalVoxels = includedFrames.length * sliceSize;
  const flat = new Uint8Array(totalVoxels);
  for (let f = 0; f < includedFrames.length; f += 1) {
    const z = includedFrames[f];
    flat.set(input.mask.subarray(z * sliceSize, (z + 1) * sliceSize), f * sliceSize);
  }
  const packed = packBits(flat);

  // ── Reference series + instances
  const refImages: DicomDataset[] = input.source.sopInstanceUids.map((uid) => ([
    { tag: '00081150', vr: 'UI', value: input.source.sopClassUid },
    { tag: '00081155', vr: 'UI', value: uid },
  ] as DicomDataset));

  const refSeriesItem: DicomDataset = [
    { tag: '0020000e', vr: 'UI', value: input.source.seriesInstanceUid },
    { tag: '00081115', vr: 'SQ', value: refImages },
  ];

  // ── Segment Sequence (single segment)
  const cat = input.categoryCode ?? DEFAULT_CATEGORY;
  const typ = input.typeCode ?? DEFAULT_TYPE;
  const color = input.segmentColor ?? [255, 0, 0];

  const segmentItem: DicomDataset = [
    { tag: '00620004', vr: 'US', value: 1 },         // Segment Number
    { tag: '00620005', vr: 'LO', value: input.label },
    { tag: '00620006', vr: 'ST', value: input.label },
    { tag: '0062000c', vr: 'US', value: color },     // Recommended Display CIELab — using RGB approx
    { tag: '0062000d', vr: 'US', value: color },     // Recommended Display Grayscale (fallback)
    { tag: '00620008', vr: 'CS', value: input.algorithmName ? 'AUTOMATIC' : 'SEMIAUTOMATIC' },
    { tag: '00620009', vr: 'LO', value: input.algorithmName ?? 'NeoDW heuristic flood-fill' },
    {
      tag: '00620003', vr: 'SQ', value: [[
        { tag: '00080100', vr: 'SH', value: cat.code },
        { tag: '00080102', vr: 'SH', value: cat.designator },
        { tag: '00080104', vr: 'LO', value: cat.meaning },
      ]],
    },
    {
      tag: '0062000f', vr: 'SQ', value: [[
        { tag: '00080100', vr: 'SH', value: typ.code },
        { tag: '00080102', vr: 'SH', value: typ.designator },
        { tag: '00080104', vr: 'LO', value: typ.meaning },
      ]],
    },
  ];

  // ── Shared Functional Groups: PixelMeasures + PlaneOrientation
  const sharedFG: DicomDataset = [
    {
      tag: '00289110', vr: 'SQ', value: [[
        { tag: '00180050', vr: 'DS', value: input.sliceThickness },
        { tag: '00280030', vr: 'DS', value: input.pixelSpacing as unknown as number[] },
        { tag: '00180088', vr: 'DS', value: input.sliceThickness },
      ]],
    },
    {
      tag: '00209116', vr: 'SQ', value: [[
        { tag: '00200037', vr: 'DS', value: input.imageOrientationPatient as unknown as number[] },
      ]],
    },
  ];

  // ── Per-Frame Functional Groups
  const perFrameItems: DicomDataset[] = includedFrames.map((z) => {
    // ImagePositionPatient for this frame = base + z * thickness along Z direction.
    // For axial CT this normally means +sliceThickness in z.
    const ipp: [number, number, number] = [
      input.imagePositionPatient[0],
      input.imagePositionPatient[1],
      input.imagePositionPatient[2] + z * input.sliceThickness,
    ];
    const item: DicomDataset = [
      {
        tag: '00209113', vr: 'SQ', value: [[
          { tag: '00200032', vr: 'DS', value: ipp as unknown as number[] },
        ]],
      },
      {
        tag: '00209111', vr: 'SQ', value: [[
          { tag: '00081160', vr: 'IS', value: z + 1 },
          { tag: '00209157', vr: 'UL', value: [1, 1, 1, z + 1] }, // DimensionIndexValues
          {
            tag: '00081140', vr: 'SQ', value: [[
              { tag: '00081150', vr: 'UI', value: input.source.sopClassUid },
              { tag: '00081155', vr: 'UI', value: input.source.sopInstanceUids[z] ?? input.source.sopInstanceUids[0] },
            ]],
          },
        ]],
      },
      {
        tag: '0062000a', vr: 'SQ', value: [[
          { tag: '0062000b', vr: 'US', value: 1 },
        ]],
      },
    ];
    return item;
  });

  // ── Dimension Organization
  const dimOrgUid = generateUid();
  const dimOrgSeq: DicomDataset[] = [[
    { tag: '00209164', vr: 'UI', value: dimOrgUid },
  ]];
  const dimIndexSeq: DicomDataset[] = [
    [
      { tag: '00209165', vr: 'AT', value: '0020000d' }, // pointer to ReferencedSegmentNumber
      { tag: '00209164', vr: 'UI', value: dimOrgUid },
    ],
    [
      { tag: '00209165', vr: 'AT', value: '00200032' }, // ImagePositionPatient
      { tag: '00209164', vr: 'UI', value: dimOrgUid },
    ],
  ];

  // ── Main dataset
  const ds: DicomDataset = [
    // Patient
    { tag: '00100010', vr: 'PN', value: input.source.patientName ?? 'ANON' },
    { tag: '00100020', vr: 'LO', value: input.source.patientId ?? '' },
    { tag: '00100030', vr: 'DA', value: input.source.patientBirthDate ?? '' },
    { tag: '00100040', vr: 'CS', value: input.source.patientSex ?? '' },

    // Study
    { tag: '0020000d', vr: 'UI', value: input.source.studyInstanceUid },

    // Series
    { tag: '00080060', vr: 'CS', value: 'SEG' },
    { tag: '00200011', vr: 'IS', value: 1000 },
    { tag: '0008103e', vr: 'LO', value: `NeoDW Segmentation: ${input.label}` },
    { tag: '0020000e', vr: 'UI', value: segSeriesUid },

    // Equipment
    { tag: '00080070', vr: 'LO', value: 'NeoDW' },
    { tag: '00081090', vr: 'LO', value: 'NeoDW Viewer' },
    { tag: '00181020', vr: 'LO', value: input.algorithmVersion ?? '1.0' },

    // SOP Common
    { tag: '00080016', vr: 'UI', value: SEG_SOP_CLASS_UID },
    { tag: '00080018', vr: 'UI', value: segSopUid },
    { tag: '00080020', vr: 'DA', value: contentDate },
    { tag: '00080030', vr: 'TM', value: contentTime },
    { tag: '00080023', vr: 'DA', value: contentDate },
    { tag: '00080033', vr: 'TM', value: contentTime },

    // Image Pixel
    { tag: '00280002', vr: 'US', value: 1 },              // SamplesPerPixel
    { tag: '00280004', vr: 'CS', value: 'MONOCHROME2' },
    { tag: '00280010', vr: 'US', value: input.rows },
    { tag: '00280011', vr: 'US', value: input.columns },
    { tag: '00280008', vr: 'IS', value: includedFrames.length },
    { tag: '00280100', vr: 'US', value: 1 },              // BitsAllocated
    { tag: '00280101', vr: 'US', value: 1 },              // BitsStored
    { tag: '00280102', vr: 'US', value: 0 },              // HighBit
    { tag: '00280103', vr: 'US', value: 0 },              // PixelRepresentation
    { tag: '00080008', vr: 'CS', value: 'DERIVED\\PRIMARY' },
    { tag: '00200052', vr: 'UI', value: frameOfReferenceUid },

    // Segmentation specific
    { tag: '00620001', vr: 'CS', value: 'BINARY' },       // SegmentationType
    { tag: '0062000a', vr: 'CS', value: 'NO' },           // SegmentationFractionalType n/a for BINARY (placeholder)
    { tag: '00620002', vr: 'SQ', value: [segmentItem] },

    // Reference + functional groups
    { tag: '00081115', vr: 'SQ', value: [refSeriesItem] },
    { tag: '52009229', vr: 'SQ', value: [sharedFG] },
    { tag: '52009230', vr: 'SQ', value: perFrameItems },

    // Dimension organization
    { tag: '00209221', vr: 'SQ', value: dimOrgSeq },
    { tag: '00209222', vr: 'SQ', value: dimIndexSeq },

    // Pixel Data (OB, bit-packed)
    { tag: '7fe00010', vr: 'OB', value: packed },
  ];

  // Strip undefined values + filter empty
  const filtered: DicomDataset = ds.filter((el: DicomElement) => {
    if (el.value === undefined || el.value === null) return false;
    if (typeof el.value === 'string' && el.value.length === 0) {
      // Keep empty UIDs out, but allow empty PN/DA etc since they're type-2
      return el.vr !== 'UI';
    }
    return true;
  });

  const bytes = buildPart10(SEG_SOP_CLASS_UID, segSopUid, filtered);

  return { bytes, segSopInstanceUid: segSopUid, segSeriesInstanceUid: segSeriesUid };
}

// Download helper
export function downloadSeg(input: SegInput, filename = 'segmentation.dcm'): SegBuildResult {
  const result = buildDicomSeg(input);
  const blob = new Blob([result.bytes.buffer as ArrayBuffer], { type: 'application/dicom' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return result;
}
