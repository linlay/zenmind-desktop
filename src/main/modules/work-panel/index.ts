export { registerChatWorkPanelDocumentHtmlIpcHandlers, workPanelDocumentHtmlRegistry } from "./document-html";
export { registerChatWorkPanelLocalFileIpcHandlers, registerChatWorkPanelLocalFileProtocolScheme, normalizeWorkPanelLocalFileRelativePath, resolveWorkPanelLocalFileFromWorkspace, workPanelLocalFileRegistry } from "./local-files";
export type { WorkPanelLocalFilePathResolution } from "./local-files";
export { resolveWorkPanelDocumentFromWorkspace } from "./document-workspace-path";
export { registerChatWorkPanelResourceImageIpcHandlers, workPanelResourceImageRegistry } from "./resource-images";
export { normalizeChatWorkPanelOpenLocalResourceRequest } from "./resource-open";
export { createDocumentLocalOpenService } from "./document-local-open";
export { createWorkPanelDocumentReader } from "./document-local-reader";
export { registerChatWorkPanelTabContextMenuIpcHandlers } from "./tab-context-menu-ipc";
