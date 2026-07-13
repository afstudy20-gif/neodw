/**
 * Build a true 3D aortic-root surface for the TAVI panel, reusing the seeded
 * flood-fill segmentation + marching-cubes pipeline proven in the Aorta panel.
 *
 * The annulus centroid (already captured during the valve workflow) is a
 * reliable seed point inside the contrast-enhanced aortic lumen. We grow a
 * single-seed region at the standard contrast-lumen HU band, march it into a
 * triangle mesh, and smooth it — producing a semi-transparent surface that can
 * be layered under the deployed prosthesis in ValveDeploy3D.
 *
 * This is an AS.AORT-side capability: the surface is built on demand and shared
 * with the valve deployment view via a ref/state the caller controls.
 */
import { useState, useCallback, useRef } from 'react';
import { segmentLeftAtrium, worldToIJK } from '../la/leftAtriumSegmentation';
import { marchingCubesBinary, type Mesh } from '../la/marchingCubes';
import { taubinSmooth } from '../la/meshSmoothing';
import type { TAVIVector3D } from './TAVITypes';

export interface AorticRootSurfaceState {
  /** Smoothed triangle mesh of the aortic root + ascending aorta, or null. */
  mesh: Mesh | null;
  /** Segmented volume in cm³, if available. */
  volumeCm3: number | null;
  /** True while a segmentation/marching-cubes build is in flight. */
  building: boolean;
  /** Last error message, or null. */
  error: string | null;
  /** Build (or rebuild) the surface from a seed. Idempotent guard included. */
  build: (seed: TAVIVector3D) => Promise<void>;
  /** Discard the current surface. */
  clear: () => void;
}

const ROOT_MIN_HU = 150; // contrast-enhanced aortic lumen floor
const ROOT_MAX_HU = 450; // stay below cortical bone / heavy calcium

export function useAorticRootSurface(volumeId: string): AorticRootSurfaceState {
  const [mesh, setMesh] = useState<Mesh | null>(null);
  const [volumeCm3, setVolumeCm3] = useState<number | null>(null);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const build = useCallback(async (seed: TAVIVector3D) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBuilding(true);
    setError(null);
    try {
      const seedIJK = worldToIJK(volumeId, [seed.x, seed.y, seed.z]);
      if (!seedIJK) {
        setError('Seed point is outside the CT volume bounds.');
        return;
      }
      // Yield once so the spinner can paint before the (synchronous-feeling)
      // flood-fill + march runs.
      await new Promise((r) => setTimeout(r, 20));

      const res = await segmentLeftAtrium(volumeId, {
        minHU: ROOT_MIN_HU,
        maxHU: ROOT_MAX_HU,
        seedIJK,
      });
      if (!res) {
        setError('Segmentation failed: CT volume unavailable.');
        return;
      }

      const raw = marchingCubesBinary(res.data, res.dims, res.voxelToWorld);
      const smoothed = taubinSmooth(raw);
      setMesh(smoothed);
      setVolumeCm3(res.volumeCm3);
    } catch (err: any) {
      setError(err?.message || '3D root surface build failed.');
    } finally {
      setBuilding(false);
      inFlight.current = false;
    }
  }, [volumeId]);

  const clear = useCallback(() => {
    setMesh(null);
    setVolumeCm3(null);
    setError(null);
  }, []);

  return { mesh, volumeCm3, building, error, build, clear };
}
