import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import dicomImageLoader from '@cornerstonejs/dicom-image-loader';
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

  // 2. dicom-image-loader init — registers the wadouri/wadors/dicomfile image
  // loaders, registers the default metaData provider, AND registers the correct
  // 'dicomImageLoader' Web Worker (the one inside the package, with the full
  // RPC API Cornerstone3D expects). Doing this manually with a homegrown
  // decodeWorker.ts left the worker speaking the wrong protocol — decode tasks
  // never resolved, every image stalled at "Unknown Transfer Syntax", and the
  // panel hung at 0/990 forever.
  await dicomImageLoader.init({
    maxWebWorkers: Math.max(1, Math.floor((navigator.hardwareConcurrency || 4) / 2)),
  });

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
