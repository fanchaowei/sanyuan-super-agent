import { editFileTool, listDirectoryTool, readFileTool, writeFileTool } from './file-tools';
import { globTool, grepTool } from './search-tools';
import { bashTool } from './shell-tools';
import type { ToolDefinition } from './tool-registry';
import { calculatorTool, weatherTool } from './unity-tools';
import { pickSearchTool, webFetchTool } from './web-search';

export const allTools: ToolDefinition[] = [
  weatherTool,
  calculatorTool,
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  editFileTool,
  globTool,
  grepTool,
  bashTool,
  pickSearchTool(),
  webFetchTool,
];

export {
  bashTool, calculatorTool, editFileTool, globTool, grepTool, listDirectoryTool, readFileTool, weatherTool, writeFileTool
};
