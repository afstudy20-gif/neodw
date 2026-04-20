import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import dicomImageLoader from '@cornerstonejs/dicom-image-loader';

import { getDecoratedMetaDataProvider } from '../../../shell/dicomMetadataDecorators';

let initialized = false;

class SafeCrosshairsTool extends cornerstoneTools.CrosshairsTool {
  public static toolName = cornerstoneTools.CrosshairsTool.toolName;

  constructor(...args: any[]) {
    super(...args);

    const originalMouseMove = this.mouseMoveCallback?.bind(this);
    if (originalMouseMove) {
      this.mouseMoveCallback = (evt: any, filteredToolAnnotations: any[] = []) =>
        originalMouseMove(evt, Array.isArray(filteredToolAnnotations) ? filteredToolAnnotations : []);
    }
  }
}

export async function initCornerstone(): Promise<void> {
  if (initialized) {
    return;
  }

  cornerstone.init();
  // Debug exposure (dev only)
  (window as unknown as { cornerstone?: unknown }).cornerstone = cornerstone;
  (window as unknown as { cornerstoneTools?: unknown }).cornerstoneTools = cornerstoneTools;
  cornerstone.Settings.getRuntimeSettings().set('useCursors', false);

  cornerstone.registerImageLoader('wadouri', dicomImageLoader.wadouri.loadImage);
  cornerstone.registerImageLoader('dicomfile', dicomImageLoader.wadouri.loadImage);
  
  // Wrap the default metadata provider to bypass GE private blocks and log structure
  const decoratedProvider = getDecoratedMetaDataProvider(dicomImageLoader.wadouri.metaData.metaDataProvider);
  cornerstone.metaData.addProvider(decoratedProvider);

  const workerFn = () =>
    new Worker(new URL('./decodeWorker.ts', import.meta.url), { type: 'module' });

  const workerManager = cornerstone.getWebWorkerManager();
  workerManager.registerWorker('dicomImageLoader', workerFn, {
    maxWorkerInstances: Math.max(1, Math.floor((navigator.hardwareConcurrency || 4) / 2)),
  });

  cornerstone.volumeLoader.registerVolumeLoader(
    'cornerstoneStreamingImageVolume',
    cornerstone.cornerstoneStreamingImageVolumeLoader as unknown as cornerstone.Types.VolumeLoaderFn
  );

  cornerstoneTools.init();

  const svgMouseCursor = (cornerstoneTools as any)?.cursors?.SVGMouseCursor;
  if (svgMouseCursor?.getDefinedCursor) {
    svgMouseCursor.getDefinedCursor = () => undefined;
  }

  const {
    WindowLevelTool,
    PanTool,
    ZoomTool,
    StackScrollTool,
    LengthTool,
    ProbeTool,
    TrackballRotateTool,
  } = cornerstoneTools;

  cornerstoneTools.addTool(WindowLevelTool);
  cornerstoneTools.addTool(PanTool);
  cornerstoneTools.addTool(ZoomTool);
  cornerstoneTools.addTool(StackScrollTool);
  cornerstoneTools.addTool(LengthTool);
  cornerstoneTools.addTool(SafeCrosshairsTool);
  cornerstoneTools.addTool(ProbeTool);
  cornerstoneTools.addTool(TrackballRotateTool);

  initialized = true;
}

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
  };
}
