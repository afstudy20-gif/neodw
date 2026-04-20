import React, { useRef, useEffect, useCallback, useState } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import { TAVIVector3D } from '../tavi/TAVITypes';
import { TAVIGeometry } from '../tavi/TAVIGeometry';
import { DoubleObliqueController } from '../tavi/DoubleObliqueController';

interface CoronaryHeightViewProps {
  /** Controller for navigating viewports */
  controller: DoubleObliqueController | null;
  /** Rendering engine ID */
  renderingEngineId: string;
  /** Annulus centroid (basal plane origin) */
  annulusCentroid?: TAVIVector3D;
  /** Annulus plane normal */
  annulusNormal?: TAVIVector3D;
  /** Left coronary ostium world point */
  leftOstium?: TAVIVector3D;
  /** Right coronary ostium world point */
  rightOstium?: TAVIVector3D;
  /** Left coronary height (mm) */
  leftHeightMm?: number | null;
  /** Right coronary height (mm) */
  rightHeightMm?: number | null;
}

/**
 * Coronary Height Stretched Vessel View — ProSizeAV-style.
 * Shows two side-by-side panels with longitudinal cross-sections
 * through each coronary ostium, with basal plane line and height measurement.
 *
 * Uses the LEFT viewport (longitudinal reference) rotated to face each coronary.
 */
export const CoronaryHeightView: React.FC<CoronaryHeightViewProps> = ({
  controller,
  renderingEngineId,
  annulusCentroid,
  annulusNormal,
  leftOstium,
  rightOstium,
  leftHeightMm,
  rightHeightMm,
}) => {
  const leftCanvasRef = useRef<HTMLCanvasElement>(null);
  const rightCanvasRef = useRef<HTMLCanvasElement>(null);
  const [leftThumb, setLeftThumb] = useState<string | null>(null);
  const [rightThumb, setRightThumb] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);

  // Store viewport-to-world mapping info for overlay drawing
  const leftViewInfoRef = useRef<{ parallelScale: number; vpWidth: number; vpHeight: number } | null>(null);
  const rightViewInfoRef = useRef<{ parallelScale: number; vpWidth: number; vpHeight: number } | null>(null);

  const captureViews = useCallback(async () => {
    if (!controller || !annulusCentroid || !annulusNormal) return;
    if (!leftOstium && !rightOstium) return;

    setCapturing(true);

    // Save current state
    const savedState = controller.getState();
    const leftVpId = controller.getLeftViewportId();

    const wait = () => new Promise<void>(r => {
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50)));
    });

    // For each coronary, rotate the longitudinal view to face the ostium
    // and capture the LEFT viewport (which shows the stretched vessel view)

    // Capture left coronary view
    if (leftOstium) {
      // Compute rotation to face left ostium
      const rotAngle = controller.computeRotationAngleToward(leftOstium);
      controller.setRotationAngle(rotAngle);

      // Move focal point to midpoint between annulus and ostium level
      const midPoint = TAVIGeometry.vectorScale(
        TAVIGeometry.vectorAdd(annulusCentroid, leftOstium), 0.5
      );
      const axisDir = controller.getAxisDirection();
      const dist = TAVIGeometry.distanceFromPointToPlane(midPoint, annulusCentroid, axisDir);
      controller.showPlaneAtDistanceFromOrigin(annulusCentroid, dist);

      // Zoom in: set parallelScale to ~40mm for a tighter view
      const engine = cornerstone.getRenderingEngine(renderingEngineId);
      const leftVp = engine?.getViewport(leftVpId);
      if (leftVp) {
        const cam = leftVp.getCamera();
        leftVp.setCamera({ ...cam, parallelScale: 45 });
        leftVp.render();
      }

      await wait();

      if (leftVp?.element) {
        const canvas = leftVp.element.querySelector('canvas');
        if (canvas) {
          leftViewInfoRef.current = {
            parallelScale: leftVp.getCamera().parallelScale || 45,
            vpWidth: canvas.clientWidth,
            vpHeight: canvas.clientHeight,
          };
          setLeftThumb(canvas.toDataURL('image/png'));
        }
      }
    }

    // Capture right coronary view
    if (rightOstium) {
      const rotAngle = controller.computeRotationAngleToward(rightOstium);
      controller.setRotationAngle(rotAngle);

      const midPoint = TAVIGeometry.vectorScale(
        TAVIGeometry.vectorAdd(annulusCentroid, rightOstium), 0.5
      );
      const axisDir = controller.getAxisDirection();
      const dist = TAVIGeometry.distanceFromPointToPlane(midPoint, annulusCentroid, axisDir);
      controller.showPlaneAtDistanceFromOrigin(annulusCentroid, dist);

      const engine = cornerstone.getRenderingEngine(renderingEngineId);
      const leftVp = engine?.getViewport(leftVpId);
      if (leftVp) {
        const cam = leftVp.getCamera();
        leftVp.setCamera({ ...cam, parallelScale: 45 });
        leftVp.render();
      }

      await wait();

      if (leftVp?.element) {
        const canvas = leftVp.element.querySelector('canvas');
        if (canvas) {
          rightViewInfoRef.current = {
            parallelScale: leftVp.getCamera().parallelScale || 45,
            vpWidth: canvas.clientWidth,
            vpHeight: canvas.clientHeight,
          };
          setRightThumb(canvas.toDataURL('image/png'));
        }
      }
    }

    // Restore original state
    controller.restoreState({
      axisPoint: savedState.axisPoint,
      axisDirection: savedState.axisDirection,
      rotationAngle: savedState.rotationAngle,
      tiltAngle: savedState.tiltAngle,
    });

    // Restore left viewport zoom
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    const leftVp = engine?.getViewport(leftVpId);
    if (leftVp) {
      const cam = leftVp.getCamera();
      leftVp.setCamera({ ...cam, parallelScale: 100 });
      leftVp.render();
    }

    setCapturing(false);
  }, [controller, renderingEngineId, annulusCentroid, annulusNormal, leftOstium, rightOstium]);

  // Draw overlay on captured thumbnail — ProSizeAV-style with real coordinate mapping
  const drawOverlay = useCallback((
    canvas: HTMLCanvasElement,
    thumb: string,
    heightMm: number | null | undefined,
    side: 'left' | 'right',
    ostium: TAVIVector3D | undefined,
  ) => {
    if (!annulusCentroid || !annulusNormal) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const img = new Image();
    img.onload = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.scale(dpr, dpr);

      // Draw thumbnail
      ctx.drawImage(img, 0, 0, w, h);

      // We need to compute where the annular plane and ostium are in viewport coordinates
      // The LEFT viewport during capture had:
      //   - Focal point at midpoint between annulus and ostium
      //   - viewUp = axisDirection (axis is vertical in the image)
      //   - parallelScale = 45mm (90mm total vertical FOV)
      //
      // Annular plane position: project onto axis from focal point
      // The axis runs vertically in the viewport, positive axis = up

      if (heightMm != null && ostium) {
        const totalFOV = 90; // 2 * parallelScale = 2 * 45mm
        const mmPerPixel = totalFOV / h;

        // The annulus centroid and ostium are at specific positions along the axis
        // Focal point was at their midpoint, so:
        //   - Annulus is heightMm/2 below center
        //   - Ostium is heightMm/2 above center
        // In viewport coordinates (y increases downward):
        const annulusY = h / 2 + (heightMm / 2) / mmPerPixel;
        const ostiumY = h / 2 - (heightMm / 2) / mmPerPixel;

        // --- Draw annular plane horizontal line (green, solid) ---
        ctx.strokeStyle = '#3fb950';
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(0, annulusY);
        ctx.lineTo(w, annulusY);
        ctx.stroke();

        // "Basal plane" label
        ctx.fillStyle = '#3fb950';
        ctx.font = 'bold 11px -apple-system, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText('Basal plane', w - 6, annulusY + 14);

        // --- Height measurement vertical line ---
        // LCO: line on RIGHT side of image, RCO: line on LEFT side
        const lineX = side === 'left' ? w * 0.65 : w * 0.35;
        const measureColor = side === 'left' ? '#d29922' : '#f85149';

        // Ostium marker dot (at top of measurement)
        ctx.fillStyle = measureColor;
        ctx.beginPath();
        ctx.arc(lineX, ostiumY, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Vertical measurement line from ostium down to basal plane
        ctx.strokeStyle = measureColor;
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(lineX, ostiumY);
        ctx.lineTo(lineX, annulusY);
        ctx.stroke();

        // Horizontal ticks at both ends
        const tickW = 10;
        ctx.beginPath();
        ctx.moveTo(lineX - tickW / 2, annulusY);
        ctx.lineTo(lineX + tickW / 2, annulusY);
        ctx.moveTo(lineX - tickW / 2, ostiumY);
        ctx.lineTo(lineX + tickW / 2, ostiumY);
        ctx.stroke();

        // Small circle at basal plane intersection
        ctx.fillStyle = '#3fb950';
        ctx.beginPath();
        ctx.arc(lineX, annulusY, 4, 0, Math.PI * 2);
        ctx.fill();

        // Height label — position on the side with more space
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 13px -apple-system, sans-serif';
        const labelX = side === 'left' ? lineX - 12 : lineX + 12;
        ctx.textAlign = side === 'left' ? 'right' : 'left';
        ctx.fillText(`Height: ${heightMm.toFixed(1)}mm`, labelX, (annulusY + ostiumY) / 2 + 5);
      }

      // Side label at top
      ctx.fillStyle = '#e6edf3';
      ctx.font = 'bold 12px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(side === 'left' ? 'Left Coronary' : 'Right Coronary', w / 2, 18);

      // Orientation labels (L/R and A/P style)
      ctx.fillStyle = '#6e7681';
      ctx.font = '10px -apple-system, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('S', 4, h / 2 - 4);
      ctx.textAlign = 'right';
      ctx.fillText('I', w - 4, h / 2 + 4);
    };
    img.src = thumb;
  }, [annulusCentroid, annulusNormal]);

  // Draw overlays when thumbnails change
  useEffect(() => {
    if (leftThumb && leftCanvasRef.current) {
      drawOverlay(leftCanvasRef.current, leftThumb, leftHeightMm, 'left', leftOstium);
    }
  }, [leftThumb, leftHeightMm, drawOverlay, leftOstium]);

  useEffect(() => {
    if (rightThumb && rightCanvasRef.current) {
      drawOverlay(rightCanvasRef.current, rightThumb, rightHeightMm, 'right', rightOstium);
    }
  }, [rightThumb, rightHeightMm, drawOverlay, rightOstium]);

  // Auto-generate views when component mounts with data
  useEffect(() => {
    if (controller && annulusCentroid && annulusNormal && (leftOstium || rightOstium) && !leftThumb && !rightThumb) {
      // Small delay to ensure viewports are ready
      const timer = setTimeout(() => captureViews(), 300);
      return () => clearTimeout(timer);
    }
  }, [controller, annulusCentroid, annulusNormal, leftOstium, rightOstium]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasData = leftOstium || rightOstium;

  return (
    <div className="coronary-height-view">
      <h4 style={{ margin: '0 0 8px', fontSize: '0.85rem', color: 'var(--text-primary)' }}>
        Coronary Ostium Heights — Stretched Vessel
      </h4>

      {!hasData && (
        <p className="tavi-step-hint">No coronary ostia captured. Mark LCO/RCO to see height views.</p>
      )}

      {(leftThumb || rightThumb) && (
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
          {leftThumb && (
            <div style={{ flex: 1, position: 'relative' }}>
              <canvas
                ref={leftCanvasRef}
                style={{ width: '100%', maxWidth: 400, height: 280, borderRadius: 'var(--radius-sm)', background: '#000', objectFit: 'contain' }}
              />
              {leftHeightMm != null && (
                <div style={{
                  textAlign: 'center', marginTop: 4, fontSize: '0.85rem', fontWeight: 600,
                  color: leftHeightMm < 10 ? '#f85149' : '#3fb950',
                }}>
                  LCO: {leftHeightMm.toFixed(1)} mm {leftHeightMm < 10 ? '⚠ Low' : ''}
                </div>
              )}
            </div>
          )}
          {rightThumb && (
            <div style={{ flex: 1, position: 'relative' }}>
              <canvas
                ref={rightCanvasRef}
                style={{ width: '100%', maxWidth: 400, height: 280, borderRadius: 'var(--radius-sm)', background: '#000', objectFit: 'contain' }}
              />
              {rightHeightMm != null && (
                <div style={{
                  textAlign: 'center', marginTop: 4, fontSize: '0.85rem', fontWeight: 600,
                  color: rightHeightMm < 10 ? '#f85149' : '#3fb950',
                }}>
                  RCO: {rightHeightMm.toFixed(1)} mm {rightHeightMm < 10 ? '⚠ Low' : ''}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {hasData && (
        <button
          onClick={captureViews}
          className="tavi-button"
          style={{ width: '100%', marginTop: 8, fontSize: '0.75rem' }}
          disabled={capturing}
        >
          {capturing ? 'Capturing...' : (leftThumb || rightThumb) ? 'Recapture Views' : 'Generate Coronary Height Views'}
        </button>
      )}
    </div>
  );
};
