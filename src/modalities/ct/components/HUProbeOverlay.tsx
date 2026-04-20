import { useEffect, useCallback } from 'react';
import * as cornerstone from '@cornerstonejs/core';

/**
 * HUProbeOverlay: Shows the Hounsfield Unit value under the mouse cursor
 * on ALL viewports (axial, sagittal, coronal, volume3d).
 * For 2D: uses canvasToWorld + volume sampling.
 * For 3D: uses camera ray-march through volume data.
 */

interface Props {
  renderingEngineId: string;
  volumeId: string;
}

// Tissue classification
function classifyHU(hu: number): { tissue: string; color: string } {
  if (hu < -900) return { tissue: 'Air', color: '#4a90d9' };
  if (hu < -500) return { tissue: 'Lung', color: '#4a90d9' };
  if (hu < -100) return { tissue: 'Fat', color: '#d4a574' };
  if (hu < 60)   return { tissue: 'Soft', color: '#e8967a' };
  if (hu < 500)  return { tissue: 'Contrast', color: '#ff4444' };
  if (hu < 1000) return { tissue: 'Bone', color: '#e8e8d0' };
  return { tissue: 'Dense Bone', color: '#ffffff' };
}

export function HUProbeOverlay({ renderingEngineId, volumeId }: Props) {
  const getEngine = useCallback(() => {
    return cornerstone.getRenderingEngine(renderingEngineId) ?? null;
  }, [renderingEngineId]);

  useEffect(() => {
    const engine = getEngine();
    if (!engine) return;

    const ALL_VP_IDS = ['axial', 'sagittal', 'coronal', 'volume3d'];
    const cleanups: (() => void)[] = [];

    for (const vpId of ALL_VP_IDS) {
      const vp = engine.getViewport(vpId);
      if (!vp?.element) continue;
      const el = vp.element;
      const is3D = vpId === 'volume3d';

      // Create overlay div
      const overlay = document.createElement('div');
      overlay.style.cssText = `
        position:absolute; pointer-events:none; z-index:60;
        background:rgba(0,0,0,0.85); color:#fff;
        font-size:13px; font-family:-apple-system,monospace;
        padding:4px 8px; border-radius:4px;
        border:1px solid rgba(255,255,255,0.2);
        display:none; white-space:nowrap; font-weight:600;
      `;
      el.style.position = 'relative';
      el.appendChild(overlay);

      // Sample HU at world position from volume
      function sampleHU(worldPos: number[]): number | null {
        const volume = cornerstone.cache.getVolume(volumeId);
        if (!volume?.imageData) return null;
        const imageData = volume.imageData;
        const ijkFloat = imageData.worldToIndex(worldPos);
        const dims = imageData.getDimensions();
        const i = Math.round(ijkFloat[0]);
        const j = Math.round(ijkFloat[1]);
        const k = Math.round(ijkFloat[2]);
        if (i < 0 || i >= dims[0] || j < 0 || j >= dims[1] || k < 0 || k >= dims[2]) return null;
        const scalars = imageData.getPointData().getScalars();
        const idx = k * dims[0] * dims[1] + j * dims[0] + i;
        return scalars.getTuple(idx)?.[0] ?? null;
      }

      // For 3D: ray-march from camera through mouse position to find first opaque voxel
      function rayMarchHU(canvasX: number, canvasY: number): { hu: number; depth: number } | null {
        const cam = vp.getCamera();
        if (!cam.position || !cam.focalPoint) return null;

        // Get world point on focal plane from canvas coords
        const worldTarget = (vp as any).canvasToWorld?.([canvasX, canvasY]);
        if (!worldTarget) return null;

        // Ray direction: from camera position toward worldTarget
        const dir = [
          worldTarget[0] - cam.position[0],
          worldTarget[1] - cam.position[1],
          worldTarget[2] - cam.position[2],
        ];
        const len = Math.sqrt(dir[0] ** 2 + dir[1] ** 2 + dir[2] ** 2);
        if (len < 0.001) return null;
        dir[0] /= len; dir[1] /= len; dir[2] /= len;

        const volume = cornerstone.cache.getVolume(volumeId);
        if (!volume?.imageData) return null;
        const spacing = volume.imageData.getSpacing();
        const step = Math.min(spacing[0], spacing[1], spacing[2]) * 0.8;
        const maxDist = len * 2; // march up to 2x focal distance

        // Start from a bit before the volume center
        const startDist = Math.max(0, len * 0.2);

        for (let d = startDist; d < maxDist; d += step) {
          const p = [
            cam.position[0] + dir[0] * d,
            cam.position[1] + dir[1] * d,
            cam.position[2] + dir[2] * d,
          ];
          const hu = sampleHU(p);
          if (hu !== null && hu > -200) { // Found non-air voxel
            return { hu, depth: d };
          }
        }
        return null;
      }

      const onMouseMove = (e: MouseEvent) => {
        // Only process if this viewport is actually visible
        if (el.clientWidth === 0 || el.clientHeight === 0) return;

        try {
          const rect = el.getBoundingClientRect();
          const canvasX = e.clientX - rect.left;
          const canvasY = e.clientY - rect.top;

          let hu: number | null = null;

          if (is3D) {
            // 3D: ray-march through volume
            const result = rayMarchHU(canvasX, canvasY);
            hu = result?.hu ?? null;
          } else {
            // 2D: direct canvas→world→sample
            const worldPos = (vp as any).canvasToWorld?.([canvasX, canvasY]);
            if (worldPos) hu = sampleHU(worldPos);
          }

          if (hu === null || hu === undefined) {
            overlay.style.display = 'none';
            return;
          }

          const { tissue, color } = classifyHU(hu);

          // Position near cursor
          let left = canvasX + 15;
          let top = canvasY - 30;
          if (left + 140 > rect.width) left = canvasX - 140;
          if (top < 0) top = canvasY + 15;

          overlay.style.left = `${left}px`;
          overlay.style.top = `${top}px`;
          overlay.style.display = 'block';
          overlay.innerHTML =
            `<span style="color:${color}">${Math.round(hu)} HU</span>` +
            `<span style="color:${color};opacity:0.7;font-size:10px;margin-left:4px">${tissue}</span>`;
        } catch {
          overlay.style.display = 'none';
        }
      };

      const onMouseLeave = () => {
        overlay.style.display = 'none';
      };

      el.addEventListener('mousemove', onMouseMove);
      el.addEventListener('mouseleave', onMouseLeave);

      cleanups.push(() => {
        el.removeEventListener('mousemove', onMouseMove);
        el.removeEventListener('mouseleave', onMouseLeave);
        if (overlay.parentElement === el) el.removeChild(overlay);
      });
    }

    return () => { cleanups.forEach(fn => fn()); };
  }, [renderingEngineId, volumeId, getEngine]);

  return null;
}
