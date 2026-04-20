import type { Mesh } from './marchingCubes';

/**
 * Write a binary STL blob from a triangle soup mesh.
 * Binary STL format:
 *   80 bytes header
 *   4 bytes little-endian triangle count (uint32)
 *   per triangle: 12 floats (normal xyz + 3 × vertex xyz) + 2 bytes attribute (0)
 */
export function meshToBinarySTL(mesh: Mesh, header = 'Left Atrium — antidicom'): Blob {
  const triCount = mesh.triangleCount;
  const byteSize = 80 + 4 + triCount * (12 * 4 + 2);
  const buf = new ArrayBuffer(byteSize);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // Header: ASCII padded to 80 bytes
  const hdr = header.slice(0, 79);
  for (let i = 0; i < hdr.length; i++) u8[i] = hdr.charCodeAt(i);
  // Remaining header bytes already zero

  view.setUint32(80, triCount, true);

  let off = 84;
  for (let t = 0; t < triCount; t++) {
    const vOff = t * 9;
    const nx = mesh.normals[vOff];
    const ny = mesh.normals[vOff + 1];
    const nz = mesh.normals[vOff + 2];
    view.setFloat32(off, nx, true); off += 4;
    view.setFloat32(off, ny, true); off += 4;
    view.setFloat32(off, nz, true); off += 4;
    for (let v = 0; v < 3; v++) {
      view.setFloat32(off, mesh.positions[vOff + v * 3], true); off += 4;
      view.setFloat32(off, mesh.positions[vOff + v * 3 + 1], true); off += 4;
      view.setFloat32(off, mesh.positions[vOff + v * 3 + 2], true); off += 4;
    }
    view.setUint16(off, 0, true); off += 2;
  }

  return new Blob([buf], { type: 'model/stl' });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
