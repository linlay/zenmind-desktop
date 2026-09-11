export { registerChatWorkPanelDocumentHtmlIpcHandlers, workPanelDocumentHtmlRegistry } from "./document-html";
export { registerChatWorkPanelLocalFileIpcHandlers, registerChatWorkPanelLocalFileProtocolScheme, resolveWorkPanelLocalFileFromWorkspace, workPanelLocalFileRegistry } from "./local-files";
export type { WorkPanelLocalFilePathResolution } from "./local-files";
export { registerChatWorkPanelResourceImageIpcHandlers, workPanelResourceImageRegistry } from "./resource-images";
export { normalizeChatWorkPanelOpenLocalResourceRequest } from "./resource-open";
export { registerChatWorkPanelTabContextMenuIpcHandlers } from "./tab-context-menu-ipc";
