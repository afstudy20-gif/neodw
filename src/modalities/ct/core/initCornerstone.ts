import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import dicomImageLoader from '@cornerstonejs/dicom-image-loader';

import { getDecoratedMetaDataProvider } from '../../../shell/dicomMetadataDecorators';

let initialized = false;

export async function initCornerstone(): Promise<void> {
  if (initialized) return;

  // Initialize cornerstone3D rendering engine
  cornerstone.init();

  // Manually register DICOM image loaders and metadata provider
  // (We skip dicomImageLoader.init() because its built-in worker creation
  //  breaks under Vite's pre-bundling — import.meta.url points to wrong location)
  cornerstone.registerImageLoader('wadouri', dicomImageLoader.wadouri.loadImage);
  cornerstone.registerImageLoader('dicomfile', dicomImageLoader.wadouri.loadImage);
  
  // Wrap the default metadata provider to bypass GE private blocks and log structure
  const decoratedProvider = getDecoratedMetaDataProvider(dicomImageLoader.wadouri.metaData.metaDataProvider);
  cornerstone.metaData.addProvider(decoratedProvider);


  // Register our own Vite-bundled decode worker instead of the broken one
  const workerFn = () =>
    new Worker(new URL('./decodeWorker.ts', import.meta.url), { type: 'module' });

  const workerManager = cornerstone.getWebWorkerManager();
  workerManager.registerWorker('dicomImageLoader', workerFn, {
    maxWorkerInstances: Math.max(1, Math.floor((navigator.hardwareConcurrency || 4) / 2)),
  });

  // Register the streaming image volume loader
  cornerstone.volumeLoader.registerVolumeLoader(
    'cornerstoneStreamingImageVolume',
    cornerstone.cornerstoneStreamingImageVolumeLoader as unknown as cornerstone.Types.VolumeLoaderFn
  );

  // Initialize cornerstone tools
  cornerstoneTools.init();

  const {
    WindowLevelTool,
    PanTool,
    ZoomTool,
    StackScrollTool,
    LengthTool,
    AngleTool,
    CobbAngleTool,
    ArrowAnnotateTool,
    BidirectionalTool,
    CrosshairsTool,
    TrackballRotateTool,
    PlanarFreehandROITool,
    ProbeTool,
  } = cornerstoneTools;

  cornerstoneTools.addTool(WindowLevelTool);
  cornerstoneTools.addTool(PanTool);
  cornerstoneTools.addTool(ZoomTool);
  cornerstoneTools.addTool(StackScrollTool);
  cornerstoneTools.addTool(LengthTool);
  cornerstoneTools.addTool(AngleTool);
  cornerstoneTools.addTool(CobbAngleTool);
  cornerstoneTools.addTool(ArrowAnnotateTool);
  cornerstoneTools.addTool(BidirectionalTool);
  cornerstoneTools.addTool(CrosshairsTool);
  cornerstoneTools.addTool(TrackballRotateTool);
  cornerstoneTools.addTool(PlanarFreehandROITool);
  cornerstoneTools.addTool(ProbeTool);

  initialized = true;
  console.log('[DICOM] Cornerstone initialized successfully');
}

export function getToolNames() {
  return {
    WindowLevel: cornerstoneTools.WindowLevelTool.toolName,
    Pan: cornerstoneTools.PanTool.toolName,
    Zoom: cornerstoneTools.ZoomTool.toolName,
    StackScroll: cornerstoneTools.StackScrollTool.toolName,
    Length: cornerstoneTools.LengthTool.toolName,
    Crosshairs: cornerstoneTools.CrosshairsTool.toolName,
    TrackballRotate: cornerstoneTools.TrackballRotateTool.toolName,
    PlanarFreehandROI: cornerstoneTools.PlanarFreehandROITool.toolName,
    Probe: cornerstoneTools.ProbeTool.toolName,
    Angle: cornerstoneTools.AngleTool.toolName,
    CobbAngle: cornerstoneTools.CobbAngleTool.toolName,
    ArrowAnnotate: cornerstoneTools.ArrowAnnotateTool.toolName,
    Bidirectional: cornerstoneTools.BidirectionalTool.toolName,
  };
}
