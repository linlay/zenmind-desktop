import type {
  WebviewContextMenuActionId,
  WebviewContextMenuSemanticTarget,
  WebviewContextMenuSurfaceType
} from "../shared/webview-context-menu";

export type WebviewContextMenuEditFlags = {
  canUndo: boolean;
  canRedo: boolean;
  canCut: boolean;
  canCopy: boolean;
  canPaste: boolean;
  canSelectAll: boolean;
};

export type WebviewContextMenuPolicyContext = {
  surfaceType: WebviewContextMenuSurfaceType;
  trustedAgentWebclient: boolean;
  isEditable: boolean;
  editFlags: WebviewContextMenuEditFlags;
  selectionText: string;
  linkURL: string;
  mediaURL: string;
  mediaType: string;
  hasImageContents: boolean;
  pageURL: string;
  canGoBack: boolean;
  canGoForward: boolean;
  semanticTarget: WebviewContextMenuSemanticTarget | null;
};

export type WebviewContextMenuPolicyItem = {
  id: WebviewContextMenuActionId;
  group: "edit" | "selection" | "content" | "target" | "media" | "page";
};

function isUrlWithProtocols(value: string, protocols: readonly string[]) {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function isDesktopTabUrl(value: string) {
  return isUrlWithProtocols(value, ["http:", "https:"]);
}

export function isExternalApplicationUrl(value: string) {
  return isUrlWithProtocols(value, ["http:", "https:", "mailto:", "tel:"]);
}

export function isSafeMediaDownloadUrl(value: string) {
  return isDesktopTabUrl(value);
}

export function isLoopbackHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return ["localhost", "::1", "[::1]"].includes(parsed.hostname.toLowerCase()) ||
      /^127(?:\.\d{1,3}){3}$/u.test(parsed.hostname);
  } catch {
    return false;
  }
}

function hasCapability(
  target: WebviewContextMenuSemanticTarget,
  capability: WebviewContextMenuSemanticTarget["capabilities"][number]
) {
  return target.capabilities.includes(capability);
}

export function buildWebviewContextMenuPolicy(
  context: WebviewContextMenuPolicyContext
): WebviewContextMenuPolicyItem[] {
  const items: WebviewContextMenuPolicyItem[] = [];
  const add = (group: WebviewContextMenuPolicyItem["group"], id: WebviewContextMenuActionId) => {
    items.push({ group, id });
  };
  const selectionText = context.selectionText.trim();
  const target = context.semanticTarget;

  if (context.isEditable) {
    if (context.editFlags.canUndo) add("edit", "edit.undo");
    if (context.editFlags.canRedo) add("edit", "edit.redo");
    if (context.editFlags.canCut) add("edit", "edit.cut");
    if (context.editFlags.canCopy) add("edit", "edit.copy");
    if (context.editFlags.canPaste) add("edit", "edit.paste");
    if (context.editFlags.canSelectAll) add("edit", "edit.select-all");
  } else if (selectionText) {
    add("selection", "selection.copy");
  } else if (target?.kind === "message" && hasCapability(target, "content.copy")) {
    add("content", "content.copy");
  } else if (target?.kind === "code" && hasCapability(target, "code.copy")) {
    add("content", "code.copy");
  }

  if (target?.kind === "workspace-file") {
    if (hasCapability(target, "workspace.preview")) add("target", "workspace.preview");
    if (hasCapability(target, "workspace.copy-path")) add("target", "workspace.copy-path");
  } else if (target?.kind === "chat-resource") {
    if (hasCapability(target, "resource.preview")) add("target", "resource.preview");
    if (hasCapability(target, "resource.download")) add("target", "resource.download");
  } else {
    const candidateLinkURL = target?.kind === "web-link" && target.url ? target.url : context.linkURL;
    const linkURL = !["browser", "website", "webapp", "chat-work-panel"].includes(context.surfaceType) &&
      isLoopbackHttpUrl(candidateLinkURL)
      ? ""
      : candidateLinkURL;
    if (linkURL) {
      if (
        context.trustedAgentWebclient &&
        target?.kind === "web-link" &&
        hasCapability(target, "link.preview") &&
        isDesktopTabUrl(linkURL)
      ) {
        add("target", "link.open-current");
      } else if (
        ["browser", "website", "webapp", "chat-work-panel"].includes(context.surfaceType) &&
        isDesktopTabUrl(linkURL)
      ) {
        add("target", "link.open-current");
      }
      if (context.surfaceType === "chat-work-panel" && isDesktopTabUrl(linkURL)) {
        add("target", "link.open-work-panel-tab");
      } else if (isDesktopTabUrl(linkURL)) {
        add("target", "link.open-desktop-tab");
      }
      if (isExternalApplicationUrl(linkURL)) add("target", "link.open-external");
      if (isExternalApplicationUrl(linkURL)) add("target", "link.copy");
    }
  }

  if (context.mediaType === "image" && context.hasImageContents) {
    add("media", "media.copy-image");
  }
  if (
    ["image", "audio", "video"].includes(context.mediaType) &&
    target?.kind !== "chat-resource" &&
    (
      ["browser", "website", "webapp", "chat-work-panel"].includes(context.surfaceType) ||
      !isLoopbackHttpUrl(context.mediaURL)
    ) &&
    isSafeMediaDownloadUrl(context.mediaURL)
  ) {
    add("media", "media.save-as");
  }

  const hasLocalTarget = Boolean(
    context.isEditable ||
    selectionText ||
    context.linkURL ||
    context.mediaType !== "none" ||
    target
  );
  if (!hasLocalTarget) {
    if (["browser", "website", "webapp", "chat-work-panel"].includes(context.surfaceType)) {
      if (context.canGoBack) add("page", "page.back");
      if (context.canGoForward) add("page", "page.forward");
      add("page", "page.reload");
      if (isDesktopTabUrl(context.pageURL)) add("page", "page.copy-url");
    } else {
      add("page", "page.reload");
    }
  }

  return items;
}
