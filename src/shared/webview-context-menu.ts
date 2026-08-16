export const WEBVIEW_CONTEXT_MENU_SEMANTIC_VERSION = 1 as const;

export const WEBVIEW_CONTEXT_MENU_SEMANTIC_RESPONSE_CHANNEL =
  "desktop:webview-context-menu:semantic-response";

export const WEBVIEW_CONTEXT_MENU_RESOLVE_ACTION = "contextMenu.resolve";
export const WEBVIEW_CONTEXT_MENU_EXECUTE_ACTION = "contextMenu.execute";

export type WebviewContextMenuSurfaceType =
  | "agent-chat"
  | "agent-copilot"
  | "agent-summary"
  | "agent-debug"
  | "agent-project"
  | "agent-management"
  | "project"
  | "browser"
  | "website"
  | "webapp"
  | "chat-work-panel"
  | "help"
  | "service";

export type WebviewContextMenuActionId =
  | "edit.undo"
  | "edit.redo"
  | "edit.cut"
  | "edit.copy"
  | "edit.paste"
  | "edit.select-all"
  | "selection.copy"
  | "content.copy"
  | "code.copy"
  | "link.open-current"
  | "link.open-desktop-tab"
  | "link.open-external"
  | "link.copy"
  | "workspace.preview"
  | "workspace.copy-path"
  | "resource.preview"
  | "resource.download"
  | "media.copy-image"
  | "media.save-as"
  | "page.back"
  | "page.forward"
  | "page.reload"
  | "page.copy-url";

export type WebviewContextMenuSemanticCapability =
  | "content.copy"
  | "code.copy"
  | "link.preview"
  | "workspace.preview"
  | "workspace.copy-path"
  | "resource.preview"
  | "resource.download";

export type WebviewContextMenuSemanticTargetKind =
  | "message"
  | "code"
  | "web-link"
  | "workspace-file"
  | "chat-resource";

export type WebviewContextMenuSemanticTarget = {
  version: typeof WEBVIEW_CONTEXT_MENU_SEMANTIC_VERSION;
  targetId: string;
  kind: WebviewContextMenuSemanticTargetKind;
  capabilities: WebviewContextMenuSemanticCapability[];
  url?: string;
  title?: string;
  name?: string;
  mediaType?: "image" | "audio" | "video" | "file";
};

export type WebviewContextMenuResolveRequest = {
  action: typeof WEBVIEW_CONTEXT_MENU_RESOLVE_ACTION;
  version: typeof WEBVIEW_CONTEXT_MENU_SEMANTIC_VERSION;
  requestId: string;
  x: number;
  y: number;
};

export type WebviewContextMenuSemanticResponse = {
  version: typeof WEBVIEW_CONTEXT_MENU_SEMANTIC_VERSION;
  requestId: string;
  target: WebviewContextMenuSemanticTarget | null;
};

export type WebviewContextMenuExecuteCommand =
  | "copy-content"
  | "copy-code"
  | "preview-link"
  | "preview-workspace"
  | "copy-workspace-path"
  | "preview-resource"
  | "download-resource";

export type WebviewContextMenuExecuteRequest = {
  action: typeof WEBVIEW_CONTEXT_MENU_EXECUTE_ACTION;
  version: typeof WEBVIEW_CONTEXT_MENU_SEMANTIC_VERSION;
  requestId: string;
  targetId: string;
  targetKind: WebviewContextMenuSemanticTargetKind;
  command: WebviewContextMenuExecuteCommand;
  x: number;
  y: number;
};
