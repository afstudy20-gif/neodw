import { useEffect, useRef } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import { getToolNames } from '../../../shared/core/cornerstone';
import { RenderModeSelector } from '../../ct/components/RenderModeSelector';

interface Props {
  renderingEngineId: string;
  volumeId: string;
  onClose: () => void;
}

const CARDIAC_3D_TOOL_GROUP_ID = 'cardiac3dToolGroup';

// Full-screen 3D Volume Rendering panel for CCTA. Mounts a fresh VOLUME_3D
// viewport on top of the existing rendering engine, attaches the volume,
// applies the Cardiac VRT preset, and overlays the RenderModeSelector for
// preset / shading / tissue / clip controls. Closing detaches the viewport
// so subsequent MPR work is not affected.
export function Cardiac3DView({ renderingEngineId, volumeId, onClose }: Props) {
  const elRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const engine = cornerstone.getRenderingEngine(renderingEngineId);
    const element = elRef.current;
    if (!engine || !element) return;

    const viewportId = 'volume3d';

    let mounted = true;

    void (async () => {
      try {
        engine.enableElement({
          viewportId,
          type: cornerstone.Enums.ViewportType.VOLUME_3D,
          element,
          defaultOptions: { background: [0.04, 0.05, 0.08] as cornerstone.Types.RGB },
        });

        if (!mounted) return;
        await cornerstone.setVolumesForViewports(engine, [{ volumeId }], [viewportId]);

        const viewport = engine.getViewport(viewportId) as cornerstone.Types.IVolumeViewport | undefined;
        if (viewport) {
          // Cinematic-quality cardiac VRT preset baked into cornerstone/vtk.js.
          viewport.setProperties({ preset: 'CT-Cardiac3' });
          viewport.render();
        }

        // Mouse interaction. VOLUME_3D viewport without a tool group is a
        // static image — primary-drag for trackball rotation, middle/shift
        // for pan, right for zoom. Tool group is scoped to this modal and
        // destroyed on close so it doesn't bleed into MPR interactions.
        try {
          const names = getToolNames();
          try {
            cornerstoneTools.ToolGroupManager.destroyToolGroup(CARDIAC_3D_TOOL_GROUP_ID);
          } catch { /* may not exist yet */ }
          const tg = cornerstoneTools.ToolGroupManager.createToolGroup(CARDIAC_3D_TOOL_GROUP_ID);
          if (tg) {
            tg.addTool(names.TrackballRotate);
            tg.addTool(names.Pan);
            tg.addTool(names.Zoom);
            tg.addViewport(viewportId, renderingEngineId);
            tg.setToolActive(names.TrackballRotate, {
              bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
            });
            tg.setToolActive(names.Pan, {
              bindings: [
                { mouseButton: cornerstoneTools.Enums.MouseBindings.Auxiliary },
                {
                  mouseButton: cornerstoneTools.Enums.MouseBindings.Primary,
                  modifierKey: cornerstoneTools.Enums.KeyboardBindings.Shift,
                },
              ],
            });
            tg.setToolActive(names.Zoom, {
              bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }],
            });
          }
        } catch (toolErr) {
          console.warn('[cardiac-3d] tool group setup failed', toolErr);
        }
      } catch (err) {
        console.warn('[cardiac-3d] setup failed', err);
      }
    })();

    return () => {
      mounted = false;
      try {
        cornerstoneTools.ToolGroupManager.destroyToolGroup(CARDIAC_3D_TOOL_GROUP_ID);
      } catch { /* ignore */ }
      try {
        engine.disableElement('volume3d');
      } catch { /* ignore */ }
    };
  }, [renderingEngineId, volumeId]);

  return (
    <div className="cardiac-3d-overlay">
      <header className="cardiac-3d-header">
        <h2>Cardiac 3D — Volume Rendering</h2>
        <button className="cardiac-3d-close" onClick={onClose} aria-label="Kapat">✕</button>
      </header>
      <div ref={elRef} className="cardiac-3d-viewport" />
      <div className="cardiac-3d-controls">
        <RenderModeSelector renderingEngineId={renderingEngineId} volumeId={volumeId} />
      </div>
    </div>
  );
}
