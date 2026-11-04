import { WORK_PANEL_CHAT_FILE_ALIAS } from "./work-panel-file-address";

export const CHAT_WORK_PANEL_WEB_DIALOG_CHANNEL = "chatWorkPanel.webDialog";
export const CHAT_WORK_PANEL_WEB_DIALOG_RESTORE_REQUESTED = "chatWorkPanel.webDialogRestoreRequested";
export const CHAT_WORK_PANEL_WEB_DIALOG_CLOSE_REQUESTED = "chatWorkPanel.webDialogCloseRequested";
export const CHAT_WORK_PANEL_WEB_DIALOG_OPEN_REQUESTED = "chatWorkPanel.webDialogOpenRequested";
export type WorkPanelWebDialogOpenRequest = { transferId: string; url: string };
export type WorkPanelWebDialogRequest =
  | { action: "prepare"; sourceGuestId: number; agentLabel?: string; chatLabel?: string }
  | { action: "prepareSibling"; transferId: string; itemId: string; stableKey: string; url: string; title: string; sourceGuestId?: number }
  | { action: "open" | "focus" | "reload" | "close" | "restore"; transferId: string };
export type WorkPanelWebDialogResult = { ok: boolean; transferId?: string; surfaceId?: string; ownerChatId?: string; url?: string; restoredItems?: Array<{ transferId: string; surfaceId: string; url: string }> };

export const CHAT_WORK_PANEL_TAB_CONTEXT_MENU_POPUP_CHANNEL =
  "chatWorkPanel.tabContextMenu.popup";
export const CHAT_WORK_PANEL_OPEN_LOCAL_RESOURCE_CHANNEL =
  "chatWorkPanel.openLocalResource";
export const CHAT_WORK_PANEL_REVEAL_LOCAL_RESOURCE_CHANNEL =
  "chatWorkPanel.revealLocalResource";

export type ChatWorkPanelTabContextMenuActionId =
  | "toggle-review"
  | "reload"
  | "open-web-dialog"
  | "copy-url"
  | "copy-title"
  | "copy-path"
  | "download-resource"
  | "reveal-resource"
  | "open-resource-default-app"
  | "open-resource-browser"
  | "close-tab"
  | "close-other-tabs"
  | "toggle-fullscreen";

export type ChatWorkPanelTabContextMenuProfile =
  | "default"
  | "web"
  | "local-file"
  | "artifact"
  | "reference";

export type ChatWorkPanelTabContextMenuPopupRequest =
  | {
      mode: "copy-url";
      x: number;
      y: number;
    }
  | {
      mode: "work-panel";
      x: number;
      y: number;
      profile: ChatWorkPanelTabContextMenuProfile;
      isFullscreen: boolean;
      reviewMode?: "unavailable" | "inactive" | "active";
      documentPathAvailable?: boolean;
      nativeHtml?: { localOriginal: boolean };
      nativeImage?: { localOriginal: boolean };
      canClose: boolean;
      canCloseOthers: boolean;
    };

export type ChatWorkPanelTabContextMenuPopupResult = {
  actionId: ChatWorkPanelTabContextMenuActionId | null;
};

export type ChatWorkPanelLocalResourceProfile = "artifact" | "reference";

export type ChatWorkPanelOpenLocalResourceRequest = {
  ownerChatId: string;
  relativePath: string;
  profile: ChatWorkPanelLocalResourceProfile;
};

export type ChatWorkPanelLocalResourceErrorCode =
  | "invalid_request"
  | "not_found"
  | "not_file"
  | "path_outside_chat"
  | "open_failed";

export type ChatWorkPanelOpenLocalResourceResult = {
  ok: boolean;
  code?: ChatWorkPanelLocalResourceErrorCode;
  message?: string;
};

export type ChatWorkPanelRevealLocalResourceRequest = ChatWorkPanelOpenLocalResourceRequest;

export type ChatWorkPanelRevealLocalResourceResult = ChatWorkPanelOpenLocalResourceResult;

// Keep this set aligned with Agent WebClient's detectViewerContentKind(). The
// Resource Viewer route currently derives contentKind from the file name only,
// so Desktop can make the same presentation-only decision without reading the
// file or weakening Main's path validation.
const CHAT_WORK_PANEL_PREVIEWABLE_RESOURCE_EXTENSIONS = new Set([
  "aac", "apng", "avif", "bmp", "c", "cpp", "css", "csv", "flac", "gif",
  "go", "heic", "heif", "htm", "html", "ico", "java", "jpeg", "jpg", "js",
  "json", "log", "m4a", "m4v", "md", "mjs", "mov", "mp3", "mp4", "mpeg",
  "mpg", "oga", "ogg", "ogv", "opus", "pdf", "png", "py", "rb", "rs",
  "sh", "sql", "svg", "tif", "tiff", "ts", "tsx", "txt", "wav", "weba",
  "webm", "webp", "xhtml", "xml", "yaml", "yml",
]);

export function shouldShowChatWorkPanelLocalResourceActions(input: {
  ownerChatId: string;
  profile: ChatWorkPanelLocalResourceProfile;
  route: string;
}) {
  const relativePath = resolveChatWorkPanelLocalResourcePath(input);
  if (!relativePath) return false;
  const previewPath = relativePath.split(/[?#]/u, 1)[0];
  const filename = previewPath.split("/").pop() || "";
  const lastDotIndex = filename.lastIndexOf(".");
  const extension = lastDotIndex >= 0 && lastDotIndex < filename.length - 1
    ? filename.slice(lastDotIndex + 1).toLowerCase()
    : "";
  return !CHAT_WORK_PANEL_PREVIEWABLE_RESOURCE_EXTENSIONS.has(extension);
}

export function resolveChatWorkPanelLocalResourcePath(input: {
  ownerChatId: string;
  profile: ChatWorkPanelLocalResourceProfile;
  route: string;
}) {
  const ownerChatId = input.ownerChatId.trim();
  if (!ownerChatId || !input.route.startsWith("/") || input.route.startsWith("//")) return "";
  try {
    const url = new URL(input.route, "https://desktop.invalid");
    if (
      !url.pathname.startsWith("/resource-viewer/") ||
      url.searchParams.get("chatId") !== ownerChatId
    ) {
      return "";
    }
    // The file is an @chat/ address: a literal Chat-relative path once
    // URLSearchParams removes the query encoding. Decoding it again could
    // select a different local file, and a path without @chat/ names none.
    const resourcePath = url.searchParams.get("file") ?? "";
    if (!/^@chat\//iu.test(resourcePath)) return "";
    const rawPath = resourcePath.slice(WORK_PANEL_CHAT_FILE_ALIAS.length);
    if (
      !rawPath ||
      rawPath.length > 2_048 ||
      rawPath.startsWith("/") ||
      rawPath.includes("\\") ||
      /^[a-z]:\//iu.test(rawPath) ||
      /[\u0000-\u001f\u007f]/u.test(rawPath)
    ) {
      return "";
    }
    const parts = rawPath.split("/").filter((part) => part && part !== ".");
    const expectedRoot = input.profile === "artifact" ? "artifacts" : "references";
    const rootReference = input.profile === "reference" && parts.length === 1;
    if ((!rootReference && (parts.length < 2 || parts[0] !== expectedRoot)) || parts.some((part) => part === "..")) {
      return "";
    }
    return parts.join("/");
  } catch {
    return "";
  }
}

export function resolveChatWorkPanelLocalResourceProfile(input: {
  ownerChatId: string;
  profile: ChatWorkPanelLocalResourceProfile;
  route: string;
  resourceId?: string;
}): ChatWorkPanelLocalResourceProfile | null {
  try {
    const url = new URL(input.route, "https://desktop.invalid");
    const sourceKeys = ["sourceKind", "resourceId", "relativePath"];
    if (
      url.searchParams.getAll("chatId").length !== 1 ||
      url.searchParams.getAll("file").length !== 1 ||
      sourceKeys.some((key) => url.searchParams.getAll(key).length > 1) ||
      (url.searchParams.has("sourceKind") && url.searchParams.get("sourceKind") !== input.profile) ||
      (url.searchParams.has("resourceId") &&
        (!input.resourceId || url.searchParams.get("resourceId") !== input.resourceId))
    ) return null;

    const relativePath = resolveChatWorkPanelLocalResourcePath(input);
    if (url.searchParams.has("relativePath") && url.searchParams.get("relativePath") !== relativePath) return null;
    if (relativePath) return input.profile;

    // Generic Chat-file previews historically used an artifact module even for
    // References and root downloads. Correct only those synthetic identities;
    // an explicit published source must keep its declared profile and path.
    const genericResource = /^(?:resource:[1-9]\d*:[a-z0-9]+|chat-file:[a-f0-9]{32})$/u.test(input.resourceId || "");
    if (input.profile !== "artifact" || !genericResource || sourceKeys.some((key) => url.searchParams.has(key))) return null;
    return resolveChatWorkPanelLocalResourcePath({ ...input, profile: "reference" })
      ? "reference"
      : null;
  } catch {
    return null;
  }
}
