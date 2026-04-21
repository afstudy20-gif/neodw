import * as cornerstoneTools from '@cornerstonejs/tools';
import { getToolNames } from './initCornerstone';

const TOOL_GROUP_ID = 'angioStackToolGroup';

export type ToolName = 'WindowLevel' | 'Pan' | 'Zoom' | 'Length';

let toolGroup: cornerstoneTools.Types.IToolGroup | undefined;

export function setupToolGroup(renderingEngineId: string, viewportId: string): void {
  if (toolGroup) return;

  const names = getToolNames();

  let group = cornerstoneTools.ToolGroupManager.createToolGroup(TOOL_GROUP_ID);
  if (!group) {
    cornerstoneTools.ToolGroupManager.destroyToolGroup(TOOL_GROUP_ID);
    group = cornerstoneTools.ToolGroupManager.createToolGroup(TOOL_GROUP_ID);
  }
  if (!group) throw new Error('Failed to create angio tool group');

  group.addTool(names.WindowLevel);
  group.addTool(names.Pan);
  group.addTool(names.Zoom);
  group.addTool(names.StackScroll);
  group.addTool(names.Length);

  group.addViewport(viewportId, renderingEngineId);

  // W/L on primary click
  group.setToolActive(names.WindowLevel, {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
  });

  // Pan on middle-click + Shift+click
  group.setToolActive(names.Pan, {
    bindings: [
      { mouseButton: cornerstoneTools.Enums.MouseBindings.Auxiliary },
      { mouseButton: cornerstoneTools.Enums.MouseBindings.Primary, modifierKey: cornerstoneTools.Enums.KeyboardBindings.Shift },
    ],
  });

  // Zoom on right-click
  group.setToolActive(names.Zoom, {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }],
  });

  // Scroll on wheel (frame navigation)
  group.setToolActive(names.StackScroll, {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel }],
  });

  toolGroup = group;
}

export function setActiveTool(name: ToolName): void {
  if (!toolGroup) return;

  const names = getToolNames();
  const selectedTool = (names as Record<string, string>)[name];
  if (!selectedTool) return;

  const allPrimaryTools = [names.WindowLevel, names.Length, names.Pan, names.Zoom];

  for (const t of allPrimaryTools) {
    toolGroup.setToolPassive(t);
  }

  toolGroup.setToolActive(selectedTool, {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
  });

  // Re-activate Pan on middle-click + Shift+click
  if (name !== 'Pan') {
    toolGroup.setToolActive(names.Pan, {
      bindings: [
        { mouseButton: cornerstoneTools.Enums.MouseBindings.Auxiliary },
        { mouseButton: cornerstoneTools.Enums.MouseBindings.Primary, modifierKey: cornerstoneTools.Enums.KeyboardBindings.Shift },
      ],
    });
  }

  // Re-activate Zoom on right-click
  if (name !== 'Zoom') {
    toolGroup.setToolActive(names.Zoom, {
      bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }],
    });
  }

  // Scroll always on wheel
  toolGroup.setToolActive(names.StackScroll, {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel }],
  });
}

export function destroyToolGroup(): void {
  if (toolGroup) {
    cornerstoneTools.ToolGroupManager.destroyToolGroup(TOOL_GROUP_ID);
    toolGroup = undefined;
  }
}

export function addViewportToToolGroup(renderingEngineId: string, viewportId: string): void {
  if (!toolGroup) return;
  try { toolGroup.addViewport(viewportId, renderingEngineId); } catch { /* already added */ }
}

export function removeViewportFromToolGroup(viewportId: string): void {
  if (!toolGroup) return;
  try {
    const anyGroup = toolGroup as unknown as { removeViewports?: (ids: string[]) => void };
    anyGroup.removeViewports?.([viewportId]);
  } catch { /* ignore */ }
}

export function isToolGroupReady(): boolean {
  return toolGroup != null;
}
