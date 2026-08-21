export const CHAT_WORK_PANEL_TAB_CONTEXT_MENU_POPUP_CHANNEL =
  "chatWorkPanel.tabContextMenu.popup";
export const CHAT_WORK_PANEL_OPEN_LOCAL_RESOURCE_CHANNEL =
  "chatWorkPanel.openLocalResource";
export const CHAT_WORK_PANEL_REVEAL_LOCAL_RESOURCE_CHANNEL =
  "chatWorkPanel.revealLocalResource";

export type ChatWorkPanelTabContextMenuActionId =
  | "reload"
  | "copy-url"
  | "copy-title"
  | "download-resource"
  | "reveal-resource"
  | "open-resource-default-app"
  | "close-tab"
  | "close-other-tabs"
  | "toggle-fullscreen";

export type ChatWorkPanelTabContextMenuProfile =
  | "default"
  | "web"
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

export type ChatWorkPanelOpenLocalResourceResult = {
  ok: boolean;
  path?: string;
  code?: "invalid_request" | "not_found" | "not_file" | "path_outside_chat" | "open_failed";
  message?: string;
};

export type ChatWorkPanelRevealLocalResourceRequest = ChatWorkPanelOpenLocalResourceRequest;

export type ChatWorkPanelRevealLocalResourceResult = ChatWorkPanelOpenLocalResourceResult;

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
    const encodedArtifactPath = url.searchParams.get("file")?.replace(/\\/gu, "/") ?? "";
    let rawPath = "";
    try {
      // artifact_publish returns a URL whose individual filename segments are encoded.
      // Resource Viewer then places that URL inside a query parameter, adding another
      // encoding layer. URLSearchParams removes the outer layer; remove the artifact
      // URL layer here before resolving the existing file on disk.
      rawPath = decodeURIComponent(encodedArtifactPath);
    } catch {
      return "";
    }
    if (
      !rawPath ||
      rawPath.length > 2_048 ||
      rawPath.startsWith("/") ||
      /^[a-z]:\//iu.test(rawPath) ||
      /[\u0000-\u001f\u007f]/u.test(rawPath)
    ) {
      return "";
    }
    const parts = rawPath.split("/").filter((part) => part && part !== ".");
    const expectedRoot = input.profile === "artifact" ? "artifacts" : "references";
    if (parts.length < 2 || parts[0] !== expectedRoot || parts.some((part) => part === "..")) {
      return "";
    }
    return parts.join("/");
  } catch {
    return "";
  }
}
