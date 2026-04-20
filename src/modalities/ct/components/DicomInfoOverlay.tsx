import { useEffect, useState, useRef } from 'react';
import * as cornerstone from '@cornerstonejs/core';

interface Props {
  renderingEngineId: string;
  patientName?: string;
  studyDescription?: string;
  seriesDescription?: string;
  modality?: string;
  hidden?: boolean;
}

interface ViewportInfo {
  sliceIndex: number;
  totalSlices: number;
  ww: number;
  wl: number;
  zoom: number;
  thickness: number;
}

const MPR_VP_IDS = ['axial', 'sagittal', 'coronal'];

export function DicomInfoOverlay({ renderingEngineId, patientName, studyDescription, seriesDescription, modality, hidden }: Props) {
  const [infos, setInfos] = useState<Record<string, ViewportInfo>>({});
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (hidden) return;

    const update = () => {
      const engine = cornerstone.getRenderingEngine(renderingEngineId);
      if (!engine) return;

      const newInfos: Record<string, ViewportInfo> = {};
      for (const vpId of MPR_VP_IDS) {
        const vp = engine.getViewport(vpId) as cornerstone.Types.IVolumeViewport | undefined;
        if (!vp || vp.element.clientWidth === 0) continue;

        try {
          const cam = vp.getCamera();
          const props = vp.getProperties();
          const voiRange = (props as any)?.voiRange;
          const ww = voiRange ? Math.round(voiRange.upper - voiRange.lower) : 0;
          const wl = voiRange ? Math.round((voiRange.upper + voiRange.lower) / 2) : 0;

          // Estimate slice index from focal point
          let sliceIndex = 0;
          let totalSlices = 0;
          try {
            const volume = cornerstone.cache.getVolume('cornerstoneStreamingImageVolume:myVolume');
            if (volume?.imageData && cam.focalPoint) {
              const ijk = volume.imageData.worldToIndex(cam.focalPoint);
              const dims = volume.imageData.getDimensions();
              // Determine which axis this viewport scrolls along
              const vpn = cam.viewPlaneNormal || [0, 0, 1];
              const absVpn = [Math.abs(vpn[0]), Math.abs(vpn[1]), Math.abs(vpn[2])];
              const maxAxis = absVpn.indexOf(Math.max(...absVpn));
              sliceIndex = Math.round(ijk[maxAxis]);
              totalSlices = dims[maxAxis];
            }
          } catch { /* ignore */ }

          // Zoom
          const zoom = cam.parallelScale ? Math.round(100 / (cam.parallelScale / 250)) : 100;

          newInfos[vpId] = { sliceIndex, totalSlices, ww, wl, zoom, thickness: 0 };
        } catch { /* ignore */ }
      }
      setInfos(newInfos);
    };

    timerRef.current = window.setInterval(update, 200);
    update();

    // Also listen for VOI changes and camera changes for immediate updates
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    const handlers: (() => void)[] = [];
    if (engine) {
      for (const vpId of MPR_VP_IDS) {
        const vp = engine.getViewport(vpId);
        if (vp?.element) {
          const h = () => setTimeout(update, 50);
          vp.element.addEventListener(cornerstone.Enums.Events.VOI_MODIFIED, h as any);
          vp.element.addEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, h as any);
          handlers.push(() => {
            vp.element.removeEventListener(cornerstone.Enums.Events.VOI_MODIFIED, h as any);
            vp.element.removeEventListener(cornerstone.Enums.Events.CAMERA_MODIFIED, h as any);
          });
        }
      }
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      handlers.forEach(h => h());
    };
  }, [renderingEngineId, hidden]);

  if (hidden) return null;

  const overlayStyle = (vpId: string): React.CSSProperties => ({
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    pointerEvents: 'none',
    zIndex: 15,
    padding: '4px 6px',
    fontSize: '10px',
    fontFamily: '-apple-system, monospace',
    color: 'rgba(255,255,255,0.75)',
    lineHeight: 1.4,
  });

  return (
    <>
      {MPR_VP_IDS.map(vpId => {
        const el = document.getElementById(`viewport-${vpId}`);
        if (!el || el.clientWidth === 0) return null;
        const info = infos[vpId];

        return (
          <div key={vpId} id={`dicom-overlay-${vpId}`} style={{
            position: 'absolute',
            top: el.offsetTop,
            left: el.offsetLeft,
            width: el.clientWidth,
            height: el.clientHeight,
            pointerEvents: 'none',
            zIndex: 15,
          }}>
            {/* Top-left: Patient info */}
            <div className="dicom-patient-text" style={{ position: 'absolute', top: 20, left: 6, fontSize: '10px', fontFamily: 'monospace', color: 'rgba(255,255,255,0.7)', lineHeight: 1.5 }}>
              {patientName && <div>{patientName}</div>}
              {studyDescription && <div>{studyDescription}</div>}
              {seriesDescription && <div>{seriesDescription}</div>}
            </div>

            {/* Top-right: Technical info */}
            <div style={{ position: 'absolute', top: 20, right: 6, fontSize: '10px', fontFamily: 'monospace', color: 'rgba(255,255,255,0.7)', textAlign: 'right', lineHeight: 1.5 }}>
              {modality && <div>{modality}</div>}
            </div>

            {/* Bottom-left: Slice info */}
            {info && (
              <div style={{ position: 'absolute', bottom: 20, left: 6, fontSize: '10px', fontFamily: 'monospace', color: 'rgba(255,200,100,0.85)', lineHeight: 1.5 }}>
                <div>Im: {info.sliceIndex}/{info.totalSlices}</div>
                <div>W: {info.ww} L: {info.wl}</div>
              </div>
            )}

            {/* Bottom-right: Zoom */}
            {info && (
              <div style={{ position: 'absolute', bottom: 20, right: 6, fontSize: '10px', fontFamily: 'monospace', color: 'rgba(255,200,100,0.85)', textAlign: 'right', lineHeight: 1.5 }}>
                <div>Zoom: {info.zoom}%</div>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
