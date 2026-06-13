import { describe, it, expect } from 'vitest';
import { frangiVesselness, symmetricEigenvalues3x3, type Volume3D } from './frangiVesselness';

const NX = 24, NY = 24, NZ = 24;

function emptyVol(): Float32Array {
  return new Float32Array(NX * NY * NZ);
}
const at = (d: Float32Array, x: number, y: number, z: number) => d[x + y * NX + z * NX * NY];

// A bright cylinder of radius r along the z axis centred in x,y.
function tubeVolume(radius: number): Volume3D {
  const d = emptyVol();
  const cx = NX / 2, cy = NY / 2;
  for (let z = 0; z < NZ; z++)
    for (let y = 0; y < NY; y++)
      for (let x = 0; x < NX; x++) {
        const rr = Math.hypot(x - cx, y - cy);
        d[x + y * NX + z * NX * NY] = rr <= radius ? 300 : 0;
      }
  return { data: d, dimensions: [NX, NY, NZ] };
}

// A bright solid sphere centred in the volume.
function blobVolume(radius: number): Volume3D {
  const d = emptyVol();
  const c = NX / 2;
  for (let z = 0; z < NZ; z++)
    for (let y = 0; y < NY; y++)
      for (let x = 0; x < NX; x++) {
        const rr = Math.hypot(x - c, y - c, z - c);
        d[x + y * NX + z * NX * NY] = rr <= radius ? 300 : 0;
      }
  return { data: d, dimensions: [NX, NY, NZ] };
}

describe('symmetricEigenvalues3x3', () => {
  it('returns the diagonal of a diagonal matrix (ascending)', () => {
    expect(symmetricEigenvalues3x3(3, 0, 0, -1, 0, 7)).toEqual([-1, 3, 7]);
  });
  it('matches a known symmetric matrix', () => {
    // [[2,0,0],[0,2,0],[0,0,2]] → all 2
    expect(symmetricEigenvalues3x3(2, 0, 0, 2, 0, 2)).toEqual([2, 2, 2]);
  });
  it('handles off-diagonal coupling (eigenvalues of [[0,1,0],[1,0,0],[0,0,5]])', () => {
    const e = symmetricEigenvalues3x3(0, 1, 0, 0, 0, 5);
    expect(e[0]).toBeCloseTo(-1, 6);
    expect(e[1]).toBeCloseTo(1, 6);
    expect(e[2]).toBeCloseTo(5, 6);
  });
});

describe('frangiVesselness', () => {
  it('returns values in [0,1] with the right length', () => {
    const v = frangiVesselness(tubeVolume(3), { scales: [2] });
    expect(v).toHaveLength(NX * NY * NZ);
    for (const x of v) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
    }
  });

  it('scores the tube core higher than the background', () => {
    const v = frangiVesselness(tubeVolume(3), { scales: [2, 3] });
    const core = at(v, NX / 2, NY / 2, NZ / 2);
    const bg = at(v, 2, 2, NZ / 2);
    expect(core).toBeGreaterThan(0.3);
    expect(core).toBeGreaterThan(bg + 0.2);
  });

  it('responds more strongly to a tube than to a blob of similar radius', () => {
    const tube = frangiVesselness(tubeVolume(3), { scales: [2, 3] });
    const blob = frangiVesselness(blobVolume(3), { scales: [2, 3] });
    const tubeCore = at(tube, NX / 2, NY / 2, NZ / 2);
    const blobCore = at(blob, NX / 2, NY / 2, NZ / 2);
    expect(tubeCore).toBeGreaterThan(blobCore);
  });

  it('throws when data is shorter than the dimensions imply', () => {
    expect(() => frangiVesselness({ data: new Float32Array(10), dimensions: [10, 10, 10] }))
      .toThrow(/shorter than dimensions/);
  });
});
