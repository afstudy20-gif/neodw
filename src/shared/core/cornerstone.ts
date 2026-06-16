import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import dicomImageLoader from '@cornerstonejs/dicom-image-loader';
// Vite-emitted worker shim: see ./cornerstoneDecodeWorker.ts. The package's
// own worker URL doesn't survive Vite, so we re-run its entrypoint here as a
// proper Vite worker chunk and register it on Cornerstone's worker manager.
import CornerstoneDecodeWorker from './cornerstoneDecodeWorker?worker';
import { getDecoratedMetaDataProvider } from '../../shell/dicomMetadataDecorators';

let initialized = false;

/**
 * SafeCrosshairsTool workaround for potential crashes in mouseMoveCallback
 */
export class SafeCrosshairsTool extends cornerstoneTools.CrosshairsTool {
  public static toolName = cornerstoneTools.CrosshairsTool.toolName;

  constructor(...args: any[]) {
    super(...args);
    const originalMouseMove = (this as any).mouseMoveCallback?.bind(this);
    if (originalMouseMove) {
      (this as any).mouseMoveCallback = (evt: any, filteredToolAnnotations: any[] = []) =>
        originalMouseMove(evt, Array.isArray(filteredToolAnnotations) ? filteredToolAnnotations : []);
    }
  }
}

/**
 * Centralized Cornerstone3D initialization
 */
export async function initCornerstone(): Promise<void> {
  if (initialized) {
    return;
  }

  // 1. Core Init — must await: worker registration and tool init below depend
  // on core state. Calling sync left a race window where workerManager was
  // unavailable or codecs unregistered on cold load.
  await cornerstone.init();
  cornerstone.Settings.getRuntimeSettings().set('useCursors', false);

  // 2. dicom-image-loader: register the wadouri/wadors/dicomfile image
  // loaders + default metaData provider via the package's init(). The
  // worker registration inside init() uses `new Worker(new URL(
  // './decodeImageFrameWorker.js', import.meta.url))` from inside the
  // package, which Vite cannot rewrite at build time (the source URL
  // points into node_modules and the bundled chunk lives elsewhere). We
  // call init() purely for the loader/metadata side effects, then
  // register the decode worker ourselves with an absolute, Vite-static-
  // analyzable URL from OUR module so Vite emits a real worker chunk
  // bound to the correct base. maxWebWorkers=1 keeps init's own
  // registration cheap (it can't actually run anyway).
  await dicomImageLoader.init({ maxWebWorkers: 1 });

  const workerManager = cornerstone.getWebWorkerManager();
  const maxWorkerInstances = Math.max(1, Math.floor((navigator.hardwareConcurrency || 4) / 2));
  try {
    // dicomImageLoader.init() already registers a worker under this name
    // using `new Worker(new URL('./decodeImageFrameWorker.js', import.meta.url))`
    // — Vite cannot rewrite that source-relative URL (the file lives inside
    // node_modules; the bundled chunk doesn't), so any task dispatched to it
    // silently fails to instantiate. We terminate the broken instances and
    // overwrite the registration with our Vite-emitted worker chunk.
    (workerManager as any).terminate?.('dicomImageLoader');
    workerManager.registerWorker('dicomImageLoader', () => new CornerstoneDecodeWorker(), {
      maxWorkerInstances,
      overwrite: true,
    } as any);
    console.log('[DICOM] dicomImageLoader worker overridden, instances =', maxWorkerInstances);
  } catch (e) {
    console.error('[DICOM] worker register FAILED:', e);
  }

  // Our metadata decorator (e.g. patient-name patching) must wrap the default
  // provider registered by dicomImageLoader.init() above.
  const decoratedProvider = getDecoratedMetaDataProvider(dicomImageLoader.wadouri.metaData.metaDataProvider);
  cornerstone.metaData.addProvider(decoratedProvider);

  // 4. Volume Loaders
  cornerstone.volumeLoader.registerVolumeLoader(
    'cornerstoneStreamingImageVolume',
    cornerstone.cornerstoneStreamingImageVolumeLoader as unknown as cornerstone.Types.VolumeLoaderFn
  );

  // 5. Tools Init
  cornerstoneTools.init();

  // Hide SVG mouse cursors globally if requested
  const svgMouseCursor = (cornerstoneTools as any)?.cursors?.SVGMouseCursor;
  if (svgMouseCursor?.getDefinedCursor) {
    svgMouseCursor.getDefinedCursor = () => undefined;
  }

  // Register common tools
  const {
    WindowLevelTool,
    PanTool,
    ZoomTool,
    StackScrollTool,
    LengthTool,
    AngleTool,
    ProbeTool,
    TrackballRotateTool,
    ArrowAnnotateTool,
    BidirectionalTool,
    CobbAngleTool,
    PlanarFreehandROITool,
  } = cornerstoneTools;

  const tools = [
    WindowLevelTool,
    PanTool,
    ZoomTool,
    StackScrollTool,
    LengthTool,
    AngleTool,
    ProbeTool,
    TrackballRotateTool,
    ArrowAnnotateTool,
    BidirectionalTool,
    CobbAngleTool,
    PlanarFreehandROITool,
    SafeCrosshairsTool,
  ];

  for (const tool of tools) {
    cornerstoneTools.addTool(tool);
  }

  initialized = true;
  console.log('[DICOM] Cornerstone shared core initialized');
}

/**
 * Returns common tool names for consistency
 */
export function getToolNames() {
  return {
    WindowLevel: cornerstoneTools.WindowLevelTool.toolName,
    Pan: cornerstoneTools.PanTool.toolName,
    Zoom: cornerstoneTools.ZoomTool.toolName,
    StackScroll: cornerstoneTools.StackScrollTool.toolName,
    Length: cornerstoneTools.LengthTool.toolName,
    Crosshairs: cornerstoneTools.CrosshairsTool.toolName,
    Probe: cornerstoneTools.ProbeTool.toolName,
    TrackballRotate: cornerstoneTools.TrackballRotateTool.toolName,
    Angle: cornerstoneTools.AngleTool.toolName,
    CobbAngle: cornerstoneTools.CobbAngleTool.toolName,
    ArrowAnnotate: cornerstoneTools.ArrowAnnotateTool.toolName,
    Bidirectional: cornerstoneTools.BidirectionalTool.toolName,
    PlanarFreehandROI: cornerstoneTools.PlanarFreehandROITool.toolName,
  };
}

/**
 * Helper to apply linear interpolation to a viewport
 * This fixes the "dashed line" / staircase artifact issue in MPR views
 */
export function applyLinearInterpolation(viewport: cornerstone.Types.IViewport) {
  if (!viewport) return;

  // 1. Level: Viewport properties
  try {
    if ('setProperties' in viewport) {
      (viewport as any).setProperties({
        interpolationType: cornerstone.Enums.InterpolationType.LINEAR,
      });
    }
  } catch {}

  // 2. Level: Deep Actor properties (VTK level)
  // Orthographic MPR viewports ignore sampleDistanceMultiplier, so the
  // mapper itself must be tuned to avoid slice-step artifacts on oblique views.
  try {
    const actors = (viewport as any).getActors?.() ?? [];
    for (const entry of actors) {
      const actor = entry.actor ?? entry;
      const prop = actor?.getProperty?.();
      if (prop?.setInterpolationTypeToLinear) {
        prop.setInterpolationTypeToLinear();
      } else if (prop?.setInterpolationType) {
        prop.setInterpolationType(1); // 1 = Linear in VTK
      }

      // Force finer sampling on the underlying VTK Volume Mapper
      const mapper = actor?.getMapper?.();
      if (mapper?.setSampleDistance) {
        const imageData = mapper.getInputData?.();
        if (imageData?.getSpacing) {
          const spacing = imageData
            .getSpacing()
            .filter((value: number) => Number.isFinite(value) && value > 0);

          if (spacing.length > 0) {
            const minSpacing = Math.min(...spacing);
            const defaultSampleDistance =
              spacing.reduce((sum: number, value: number) => sum + value, 0) /
              (spacing.length * 2);
            const targetSampleDistance = Math.min(defaultSampleDistance, minSpacing * 0.5);

            mapper.setAutoAdjustSampleDistances?.(false);
            mapper.setImageSampleDistance?.(1);
            mapper.setMaximumSamplesPerRay?.(
              Math.max(4000, mapper.getMaximumSamplesPerRay?.() ?? 0)
            );
            mapper.setSampleDistance(targetSampleDistance);
          }
        }
      }
    }
  } catch {}
}
