import {
  AppstoreOutlined,
  BugOutlined,
  CloseOutlined,
  DashboardOutlined,
  DeploymentUnitOutlined,
  DiffOutlined,
  EditOutlined,
  ExportOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  MessageOutlined,
  PlusOutlined,
  PictureOutlined,
  ProjectOutlined,
  RobotOutlined,
  RightOutlined,
  CodeOutlined,
} from "@ant-design/icons";
import { Button } from "antd";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import type { WorkPanelCommand, WorkPanelCommandResult, WorkPanelState } from "../../shared/work-panel";
import {
  normalizeWorkPanelWebUrl,
  resolveWorkPanelWebSessionKey,
  stableWorkPanelHash,
} from "../../shared/work-panel";
import { normalizeWebviewBlobPopupUrl } from "../../shared/webview-popup";
import {
  resolveChatWorkPanelLocalResourcePath,
  shouldShowChatWorkPanelLocalResourceActions,
  type ChatWorkPanelOpenLocalResourceResult,
  type ChatWorkPanelTabContextMenuProfile,
} from "../../shared/chat-work-panel-tab-context-menu";
import {
  AGENT_WEBCLIENT_COMPOSER_DRAFT_ACTION,
  AGENT_WEBCLIENT_COMPOSER_DRAFT_VERSION,
  AGENT_WEBCLIENT_WORKPANEL_PREVIEW_REVIEW_ACTION,
  AGENT_WEBCLIENT_WORKPANEL_PREVIEW_REVIEW_VERSION,
  AGENT_WEBCLIENT_WORKPANEL_RESOURCE_DOWNLOAD_ACTION,
  AGENT_WEBCLIENT_WORKPANEL_RESOURCE_DOWNLOAD_VERSION,
} from "../../shared/contracts/agent-webclient-bridge";
import {
  SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL,
  type AgentWebclientCurrentResourceIdentity,
} from "../../shared/service-webview-bridge";
import {
  WORK_PANEL_PREVIEW_REVIEW_ACTION_CHANNEL,
  WORK_PANEL_PREVIEW_REVIEW_EVENT_CHANNEL,
  WORK_PANEL_REVIEW_MAX_PNG_BYTES,
  WORK_PANEL_REVIEW_VERSION,
  buildWorkPanelReviewComposerDraft,
  getWorkPanelReviewSession,
  hasWorkPanelReviewDraft,
  isWorkPanelReviewReadyForComposer,
  type ReviewSourceRevision,
  type WorkPanelPreviewReviewEvent,
  type WorkPanelReviewKind,
  type WorkPanelReviewSession,
} from "../../shared/work-panel-review";
import { registerDesktopActionProviderForScope } from "../services/desktopActionRegistry";
import { useI18n } from "../i18n/useI18n";
import { MAIN_CHAT_SURFACE_ID, createChatChildSurfaceIdentity } from "../../shared/surface-identity";
import { getServiceSurfaceWebview } from "../services/serviceSurfaceWebviewRefs";
import {
  createAgentWebclientBtwPath,
  createAgentWebclientOverviewPath,
  createAgentWebclientProjectPath,
} from "../../shared/agent-webclient-routes";
import {
  createWorkPanelLocalFilePartition,
  createWorkPanelLocalFileUrl,
} from "../../shared/chat-work-panel";
import { WorkPanelReviewPanel } from "./WorkPanelReviewPanel";
import { WorkPanelResourceImage } from "./WorkPanelResourceImage";
import { SidebarActionIcon } from "../components/BrandMark";

const ExternalWebviewPage = lazy(() =>
  import("../pages/external-webview/ExternalWebviewPage").then((module) => ({ default: module.ExternalWebviewPage })),
);
const ServiceWebviewSurface = lazy(() =>
  import("../service-webview/ServiceWebviewSurface").then((module) => ({ default: module.ServiceWebviewSurface })),
);

type WorkPanelHostProps = {
  activeChatId: string | null;
  state: WorkPanelState;
  dispatchCommand(command: WorkPanelCommand): WorkPanelCommandResult;
  fullscreenOwnerChatId: string | null;
  onFullscreenChange(ownerChatId: string | null): Promise<boolean>;
  hasPanelToggle?: boolean;
  isMac: boolean;
  isWindows: boolean;
  launcher: {
    agentKey: string;
    agentMode: string;
    projectEnabled: boolean;
    projectDisabledReason?: string;
    lastRunId?: string;
    webapps: Array<{ id: string; label: string }>;
    onOpenWebapp(ownerChatId: string, webapp: { id: string; label: string }): void;
    onFocusWebappWindow(webappId: string): void;
  };
};

function actionError(code: string, message: string, details?: unknown) {
  return { ok: false as const, error: { code, message, ...(details === undefined ? {} : { details }) } };
}

function itemPartition(workspaceId: string, itemId: string) {
  return `work-panel-${stableWorkPanelHash(workspaceId)}-${stableWorkPanelHash(itemId)}`;
}

function itemRuntimeKey(ownerChatId: string, itemId: string) {
  return `${ownerChatId}\u0000${itemId}`;
}

type WorkPanelItem = WorkPanelState["workspaces"][number]["items"][number];

function localResourceProfile(item: WorkPanelItem) {
  if (
    item.descriptor.kind === "webclient" &&
    (item.descriptor.module === "artifact" || item.descriptor.module === "reference")
  ) {
    return item.descriptor.module;
  }
  return null;
}

function matchesLocalResourceIdentity(
  ownerChatId: string,
  item: WorkPanelItem,
  resource: AgentWebclientCurrentResourceIdentity,
) {
  const profile = localResourceProfile(item);
  if (!profile || item.descriptor.kind !== "webclient") return false;
  const relativePath = resolveChatWorkPanelLocalResourcePath({
    ownerChatId,
    profile,
    route: item.descriptor.route,
  });
  return resource.chatId === ownerChatId &&
    resource.profile === profile &&
    resource.relativePath === relativePath;
}

function tabContextMenuProfile(item: WorkPanelItem): ChatWorkPanelTabContextMenuProfile {
  if (item.descriptor.kind === "web") return "web";
  if (item.descriptor.kind === "webclient" && item.descriptor.module === "artifact") {
    return "artifact";
  }
  if (item.descriptor.kind === "webclient" && item.descriptor.module === "reference") {
    return "reference";
  }
  return "default";
}

function WorkPanelItemIcon({ item }: { item: WorkPanelItem }) {
  if (item.descriptor.kind === "web") return <GlobalOutlined />;
  if (item.descriptor.kind === "webapp-ref") return <AppstoreOutlined />;
  if (item.descriptor.kind === "local-file") return <FileTextOutlined />;
  if (item.descriptor.kind === "native") return <PictureOutlined />;
  switch (item.descriptor.module) {
    case "overview":
      return <DashboardOutlined />;
    case "debug":
      return <BugOutlined />;
    case "project":
      return <ProjectOutlined />;
    case "file-diff":
      return <DiffOutlined />;
    case "artifact":
    case "reference":
    case "file":
    case "source":
      return <FileTextOutlined />;
    case "btw":
      return <RobotOutlined />;
    case "planning":
      return <DeploymentUnitOutlined />;
    case "agent":
    case "copilot":
      return <RobotOutlined />;
    case "skill":
      return <AppstoreOutlined />;
  }
}

function readWebviewGuestId(webview: Electron.WebviewTag) {
  try {
    const guestId = webview.getWebContentsId();
    return Number.isSafeInteger(guestId) && guestId > 0 ? guestId : null;
  } catch {
    return null;
  }
}

function readWebviewUrl(webview: Electron.WebviewTag | null | undefined) {
  if (!webview) return "";
  try {
    return normalizeWorkPanelWebUrl(webview.getURL());
  } catch {
    return "";
  }
}

type ResourceReviewCapability = {
  kind: WorkPanelReviewKind;
  fileName: string;
  revision: string;
};

type ReviewPreviewMetadata = {
  width?: number;
  height?: number;
};

type PendingReviewRequest = {
  resolve: (event: WorkPanelPreviewReviewEvent) => void;
  timer: number;
};

function readReviewEvent(event: Event & { channel?: string; args?: unknown[] }) {
  if (event.channel !== WORK_PANEL_PREVIEW_REVIEW_EVENT_CHANNEL) return null;
  const payload = event.args?.[0];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const candidate = payload as WorkPanelPreviewReviewEvent;
  return candidate.version === WORK_PANEL_REVIEW_VERSION && typeof candidate.event === "string"
    ? candidate
    : null;
}

function reviewSourceForItem(
  item: WorkPanelItem,
  capability?: ResourceReviewCapability,
  webPage?: { url?: string; title?: string },
): { kind: WorkPanelReviewKind; source: ReviewSourceRevision } | null {
  if (item.descriptor.kind === "web") {
    const url = normalizeWorkPanelWebUrl(webPage?.url || item.descriptor.url);
    if (!url) return null;
    return {
      kind: "html",
      source: {
        sourceKind: "web",
        fileName: webPage?.title?.trim() || item.title || url,
        revision: url,
        url,
      },
    };
  }
  if (
    item.descriptor.kind === "local-file" &&
    item.descriptor.reviewKind &&
    item.descriptor.workspaceRelativePath &&
    item.descriptor.reviewRevision
  ) {
    return {
      kind: item.descriptor.reviewKind,
      source: {
        sourceKind: "workspace-file",
        fileName: item.descriptor.fileName,
        relativePath: item.descriptor.workspaceRelativePath,
        revision: item.descriptor.reviewRevision,
      },
    };
  }
  if (
    capability &&
    item.descriptor.kind === "webclient" &&
    (item.descriptor.module === "artifact" || item.descriptor.module === "reference")
  ) {
    const resourceId = item.descriptor.module === "artifact"
      ? item.descriptor.context.artifactId
      : item.descriptor.context.referenceId;
    if (!resourceId) return null;
    return {
      kind: capability.kind,
      source: {
        sourceKind: item.descriptor.module,
        fileName: capability.fileName || item.title,
        revision: capability.revision,
        resourceId,
      },
    };
  }
  return null;
}

export function WorkPanelHost({
  activeChatId,
  state,
  dispatchCommand,
  fullscreenOwnerChatId,
  onFullscreenChange,
  hasPanelToggle,
  isMac,
  isWindows,
  launcher,
}: WorkPanelHostProps) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef(state);
  const previousWebPartitionsRef = useRef(new Set<string>());
  const previousLocalFileHandlesRef = useRef(new Map<string, string>());
  const previousResourceImageHandlesRef = useRef(new Map<string, string>());
  const rendererGenerationRef = useRef(globalThis.crypto.randomUUID());
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const [loadingWebItems, setLoadingWebItems] = useState<Set<string>>(() => new Set());
  const [addMenuOwnerChatId, setAddMenuOwnerChatId] = useState<string | null>(null);
  const [addMenuView, setAddMenuView] = useState<"root" | "web" | "webapp">("root");
  const [addMenuStyle, setAddMenuStyle] = useState<CSSProperties>({});
  const [webUrlInput, setWebUrlInput] = useState("");
  const [webUrlError, setWebUrlError] = useState("");
  const [openWebappWindowIds, setOpenWebappWindowIds] = useState<Set<string>>(() => new Set());
  const [reviewPreloadUrl, setReviewPreloadUrl] = useState("");
  const [resourceReviewCapabilities, setResourceReviewCapabilities] = useState<Record<string, ResourceReviewCapability>>({});
  const [reviewPreviewMetadata, setReviewPreviewMetadata] = useState<Record<string, ReviewPreviewMetadata>>({});
  const [reviewHandoffBusyKeys, setReviewHandoffBusyKeys] = useState<Set<string>>(() => new Set());
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({});
  const [activeImageEditorItemIds, setActiveImageEditorItemIds] = useState<Record<string, string>>({});
  const pendingReviewRequestsRef = useRef(new Map<string, PendingReviewRequest>());
  stateRef.current = state;

  let revealLocalResourceLabel = t("chatWorkPanel.tabContextMenu.revealInFileManager");
  if (isMac) {
    revealLocalResourceLabel = t("chatWorkPanel.tabContextMenu.revealInFinder");
  } else if (isWindows) {
    revealLocalResourceLabel = t("chatWorkPanel.tabContextMenu.revealInExplorer");
  }

  const closeAddMenu = () => {
    setAddMenuOwnerChatId(null);
    setAddMenuView("root");
    setWebUrlInput("");
    setWebUrlError("");
    void window.electronAPI.webs.webapps.listOpenWindows()
      .then((ids) => setOpenWebappWindowIds(new Set(ids)))
      .catch(() => setOpenWebappWindowIds(new Set()));
  };

  const updateAddMenuPosition = () => {
    const button = addButtonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const width = 248;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    setAddMenuStyle({ left, top: rect.bottom + 6, width });
  };

  const openAddMenu = (ownerChatId: string) => {
    if (addMenuOwnerChatId === ownerChatId) {
      closeAddMenu();
      return;
    }
    setAddMenuOwnerChatId(ownerChatId);
    setAddMenuView("root");
    setWebUrlInput("");
    setWebUrlError("");
    requestAnimationFrame(updateAddMenuPosition);
  };

  const focusMenuItem = (direction: "first" | "last" | "next" | "previous") => {
    const menuItems = Array.from(
      addMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );
    if (menuItems.length === 0) return;
    const currentIndex = menuItems.indexOf(document.activeElement as HTMLButtonElement);
    if (direction === "first") menuItems[0].focus();
    else if (direction === "last") menuItems[menuItems.length - 1].focus();
    else if (direction === "next") menuItems[(currentIndex + 1 + menuItems.length) % menuItems.length].focus();
    else menuItems[(currentIndex - 1 + menuItems.length) % menuItems.length].focus();
  };

  const handleAddMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeAddMenu();
      addButtonRef.current?.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      focusMenuItem("next");
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusMenuItem("previous");
    } else if (event.key === "Home") {
      event.preventDefault();
      focusMenuItem("first");
    } else if (event.key === "End") {
      event.preventDefault();
      focusMenuItem("last");
    }
  };

  const openWebFromMenu = (ownerChatId: string) => {
    const url = normalizeWorkPanelWebUrl(webUrlInput);
    if (!url) {
      setWebUrlError(t("chatWorkPanel.add.webInvalid"));
      return;
    }
    dispatchCommand({ type: "openItem", ownerChatId, descriptor: { kind: "web", url } });
    closeAddMenu();
  };

  const openSideChatFromMenu = (ownerChatId: string) => {
    const agentKey = launcher.agentKey.trim();
    const route = createAgentWebclientBtwPath({ chatId: ownerChatId });
    if (!agentKey || !route) return;
    dispatchCommand({
      type: "openItem",
      ownerChatId,
      descriptor: {
        kind: "webclient",
        module: "btw",
        route,
        context: { agentKey, chatId: ownerChatId, instanceId: globalThis.crypto.randomUUID() },
        title: t("chatWorkPanel.add.sideChat"),
      },
    });
    closeAddMenu();
  };

  const openProjectFromMenu = (ownerChatId: string) => {
    if (!launcher.projectEnabled) return;
    const agentKey = launcher.agentKey.trim();
    const route = createAgentWebclientProjectPath({
      agentKey,
      chatId: ownerChatId,
      runId: launcher.lastRunId,
    });
    if (!route) return;
    dispatchCommand({
      type: "openItem",
      ownerChatId,
      descriptor: {
        kind: "webclient",
        module: "project",
        route,
        context: {
          agentKey,
          chatId: ownerChatId,
          ...(launcher.lastRunId ? { runId: launcher.lastRunId } : {}),
        },
        title: t("chatWorkPanel.add.project"),
      },
    });
    closeAddMenu();
  };

  const openFilesFromMenu = async (ownerChatId: string) => {
    const result = await window.electronAPI.chatWorkPanel.localFiles.select({
      ownerChatId,
      rendererGeneration: rendererGenerationRef.current,
    });
    if (!result.ok) return;
    for (const file of result.files) {
      dispatchCommand({
        type: "openItem",
        ownerChatId,
        descriptor: {
          kind: "local-file",
          handleId: file.handleId,
          fileName: file.fileName,
          previewKind: file.previewKind,
          title: file.fileName,
        },
      });
    }
    closeAddMenu();
  };

  const closeWorkPanelStep = (ownerChatId: string) => {
    const workspace = stateRef.current.workspaces.find((item) => item.ownerChatId === ownerChatId);
    if (!workspace) return false;
    const activeItem = workspace?.items.find((item) => item.itemId === workspace.activeItemId);
    const closableItems = workspace.items.filter((item) => item.closable && !item.pinned);
    const itemToClose = activeItem?.closable && !activeItem.pinned
      ? activeItem
      : closableItems[closableItems.length - 1];
    if (itemToClose) {
      return closeItemWithReviewProtection(ownerChatId, itemToClose.itemId);
    }
    const result = dispatchCommand({
      type: "closeWorkspace",
      ownerChatId,
      force: true,
    });
    if (result.ok) {
      window.electronAPI.desktopShell.setWorkPanelKeyboardFocusActive(false);
    }
    return result.ok;
  };

  const findItemWebview = (ownerChatId: string, itemId: string) => {
    const itemHosts = Array.from(
      document.querySelectorAll<HTMLElement>("[data-work-panel-item]"),
    );
    const itemHost = itemHosts.find((candidate) =>
      candidate.dataset.workPanelOwner === ownerChatId && candidate.dataset.workPanelItem === itemId,
    );
    return itemHost?.querySelector("webview") as Electron.WebviewTag | null;
  };

  const confirmDiscardReview = (messageKey:
    | "chatWorkPanel.review.confirmDiscard"
    | "chatWorkPanel.review.confirmDiscardOthers"
    | "chatWorkPanel.review.confirmDiscardSession"
  ) => window.confirm(t(messageKey));

  const closeItemWithReviewProtection = (ownerChatId: string, itemId: string) => {
    const nativeImageBusy = rootRef.current?.querySelector<HTMLElement>(
      `[data-work-panel-owner="${CSS.escape(ownerChatId)}"][data-work-panel-item="${CSS.escape(itemId)}"] [data-native-image-saving="true"], ` +
      `[data-work-panel-owner="${CSS.escape(ownerChatId)}"][data-work-panel-item="${CSS.escape(itemId)}"] [data-native-image-ai-busy="true"]`,
    );
    if (nativeImageBusy) return false;
    const dirtyNativeImage = rootRef.current?.querySelector<HTMLElement>(
      `[data-work-panel-owner="${CSS.escape(ownerChatId)}"][data-work-panel-item="${CSS.escape(itemId)}"] [data-native-image-dirty="true"]`,
    );
    if (dirtyNativeImage && !window.confirm(t("chatWorkPanel.image.confirmDiscardDraft"))) return false;
    const session = getWorkPanelReviewSession(stateRef.current.review, ownerChatId, itemId);
    const force = hasWorkPanelReviewDraft(session)
      ? confirmDiscardReview("chatWorkPanel.review.confirmDiscard")
      : false;
    if (hasWorkPanelReviewDraft(session) && !force) return false;
    return dispatchCommand({ type: "closeItem", ownerChatId, itemId, ...(force ? { force: true } : {}) }).ok;
  };

  const closeOtherItemsWithReviewProtection = (ownerChatId: string, itemId: string) => {
    const workspace = stateRef.current.workspaces.find((candidate) => candidate.ownerChatId === ownerChatId);
    const removedIds = workspace?.items
      .filter((candidate) => candidate.itemId !== itemId && candidate.closable && !candidate.pinned)
      .map((candidate) => candidate.itemId) ?? [];
    const hasDrafts = removedIds.some((removedId) =>
      hasWorkPanelReviewDraft(getWorkPanelReviewSession(stateRef.current.review, ownerChatId, removedId)),
    );
    const hasNativeDrafts = removedIds.some((removedId) => rootRef.current?.querySelector(
      `[data-work-panel-owner="${CSS.escape(ownerChatId)}"][data-work-panel-item="${CSS.escape(removedId)}"] [data-native-image-dirty="true"]`,
    ));
    const hasBusyNativeImages = removedIds.some((removedId) => rootRef.current?.querySelector(
      `[data-work-panel-owner="${CSS.escape(ownerChatId)}"][data-work-panel-item="${CSS.escape(removedId)}"] [data-native-image-saving="true"], ` +
      `[data-work-panel-owner="${CSS.escape(ownerChatId)}"][data-work-panel-item="${CSS.escape(removedId)}"] [data-native-image-ai-busy="true"]`,
    ));
    if (hasBusyNativeImages) return false;
    if (hasNativeDrafts && !window.confirm(t("chatWorkPanel.image.confirmDiscardDraft"))) return false;
    const force = hasDrafts
      ? confirmDiscardReview("chatWorkPanel.review.confirmDiscardOthers")
      : false;
    if (hasDrafts && !force) return false;
    return dispatchCommand({
      type: "closeOtherItems",
      ownerChatId,
      itemId,
      ...(force ? { force: true } : {}),
    }).ok;
  };

  const finishPendingReviewRequest = (event: WorkPanelPreviewReviewEvent) => {
    const requestId = "requestId" in event && typeof event.requestId === "string"
      ? event.requestId
      : "";
    if (!requestId) return false;
    const pending = pendingReviewRequestsRef.current.get(requestId);
    if (!pending) return false;
    window.clearTimeout(pending.timer);
    pendingReviewRequestsRef.current.delete(requestId);
    pending.resolve(event);
    return true;
  };

  const waitForReviewRequest = (requestId: string, timeoutMs = 8_000) =>
    new Promise<WorkPanelPreviewReviewEvent>((resolve) => {
      const timer = window.setTimeout(() => {
        pendingReviewRequestsRef.current.delete(requestId);
        resolve({
          event: "error",
          version: WORK_PANEL_REVIEW_VERSION,
          requestId,
          ok: false,
          code: "timeout",
          message: "WorkPanel preview review request timed out.",
        });
      }, timeoutMs);
      pendingReviewRequestsRef.current.set(requestId, { resolve, timer });
    });

  const handleReviewIpcMessage = useCallback((
    ownerChatId: string,
    item: WorkPanelItem,
    event: Event & { channel?: string; args?: unknown[] },
  ) => {
    const payload = readReviewEvent(event);
    if (!payload) return;
    const runtimeKey = itemRuntimeKey(ownerChatId, item.itemId);
    if (payload.event === "capability") {
      if (
        (payload.kind !== "html" && payload.kind !== "image") ||
        typeof payload.fileName !== "string" ||
        typeof payload.revision !== "string" ||
        payload.fileName.length > 512 ||
        payload.revision.length > 512
      ) {
        setResourceReviewCapabilities((current) => {
          if (!current[runtimeKey]) return current;
          const next = { ...current };
          delete next[runtimeKey];
          return next;
        });
        return;
      }
      const capabilityKind = payload.kind;
      const capabilityFileName = payload.fileName;
      const capabilityRevision = payload.revision;
      if (
        item.descriptor.kind !== "webclient" ||
        (item.descriptor.module !== "artifact" && item.descriptor.module !== "reference")
      ) return;
      const existingSession = getWorkPanelReviewSession(
        stateRef.current.review,
        ownerChatId,
        item.itemId,
      );
      if (
        existingSession &&
        payload.revision.trim() &&
        existingSession.source.revision !== payload.revision.trim()
      ) {
        dispatchCommand({
          type: "markReviewInvalid",
          ownerChatId,
          itemId: item.itemId,
          reason: "source_revision_changed",
        });
      }
      setResourceReviewCapabilities((current) => {
        const nextCapability = {
          kind: capabilityKind,
          fileName: capabilityFileName.trim() || item.title,
          revision: capabilityRevision.trim() || item.stableKey,
        };
        const previous = current[runtimeKey];
        if (
          previous?.kind === nextCapability.kind &&
          previous.fileName === nextCapability.fileName &&
          previous.revision === nextCapability.revision
        ) {
          return current;
        }
        return { ...current, [runtimeKey]: nextCapability };
      });
      return;
    }
    if (payload.event === "ready") {
      setReviewErrors((current) => current[runtimeKey] === ""
        ? current
        : { ...current, [runtimeKey]: "" });
      setReviewPreviewMetadata((current) => {
        const nextMetadata = {
          ...(Number.isFinite(payload.width) ? { width: payload.width } : {}),
          ...(Number.isFinite(payload.height) ? { height: payload.height } : {}),
        };
        const previous = current[runtimeKey];
        if (
          previous?.width === nextMetadata.width &&
          previous?.height === nextMetadata.height
        ) {
          return current;
        }
        return { ...current, [runtimeKey]: nextMetadata };
      });
      return;
    }
    if (payload.event === "unavailable") {
      const message = t("chatWorkPanel.review.unsupportedDocumentType");
      setReviewErrors((current) => current[runtimeKey] === message
        ? current
        : { ...current, [runtimeKey]: message });
      return;
    }
    if (payload.event === "image-region-created") {
      dispatchCommand({
        type: "addImageReviewAnnotation",
        ownerChatId,
        itemId: item.itemId,
        annotation: {
          id: globalThis.crypto.randomUUID(),
          rect: payload.rect,
          normalizedRect: payload.normalizedRect,
        },
      });
      setReviewPreviewMetadata((current) => {
        const previous = current[runtimeKey];
        if (
          previous?.width === payload.imageWidth &&
          previous?.height === payload.imageHeight
        ) {
          return current;
        }
        return {
          ...current,
          [runtimeKey]: { width: payload.imageWidth, height: payload.imageHeight },
        };
      });
      return;
    }
    if (payload.event === "html-element-selected") {
      dispatchCommand({
        type: "addHtmlReviewAnnotation",
        ownerChatId,
        itemId: item.itemId,
        annotation: {
          id: globalThis.crypto.randomUUID(),
          fullXPath: payload.fullXPath,
          cssSelector: payload.cssSelector,
          tagName: payload.tagName,
          attributes: payload.attributes,
          textExcerpt: payload.textExcerpt,
          rect: payload.rect,
        },
      });
      return;
    }
    if (payload.event === "annotation-invalid") {
      dispatchCommand({
        type: "markReviewInvalid",
        ownerChatId,
        itemId: item.itemId,
        annotationId: payload.annotationId,
        reason: payload.reason,
      });
      return;
    }
    finishPendingReviewRequest(payload);
  }, [dispatchCommand, t]);

  const sendReviewStateToPreview = (
    ownerChatId: string,
    item: WorkPanelItem,
    session: WorkPanelReviewSession | null,
    enabled: boolean,
  ) => {
    const webview = findItemWebview(ownerChatId, item.itemId);
    if (!webview) return false;
    try {
      if (item.descriptor.kind === "web") {
        webview.send(WORK_PANEL_PREVIEW_REVIEW_ACTION_CHANNEL, {
          action: "sync",
          version: WORK_PANEL_REVIEW_VERSION,
          kind: "html",
          enabled,
          annotations: session?.annotations ?? [],
        });
        return true;
      }
      if (item.descriptor.kind === "local-file") {
        if (!item.descriptor.reviewKind) return false;
        webview.send(WORK_PANEL_PREVIEW_REVIEW_ACTION_CHANNEL, {
          action: "sync",
          version: WORK_PANEL_REVIEW_VERSION,
          kind: item.descriptor.reviewKind,
          enabled,
          annotations: session?.annotations ?? [],
        });
        return true;
      }
      if (
        item.descriptor.kind === "webclient" &&
        (item.descriptor.module === "artifact" || item.descriptor.module === "reference") &&
        session
      ) {
        webview.send(SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL, {
          action: AGENT_WEBCLIENT_WORKPANEL_PREVIEW_REVIEW_ACTION,
          version: AGENT_WEBCLIENT_WORKPANEL_PREVIEW_REVIEW_VERSION,
          requestId: globalThis.crypto.randomUUID(),
          operation: "sync",
          kind: session.kind,
          enabled,
          annotations: session.annotations,
        });
        return true;
      }
    } catch {
      // The preview may still be attaching or may have been replaced.
    }
    return false;
  };

  const toggleReviewForItem = (
    ownerChatId: string,
    item: WorkPanelItem,
    webPage?: { url?: string; title?: string },
  ) => {
    const runtimeKey = itemRuntimeKey(ownerChatId, item.itemId);
    const review = stateRef.current.review;
    const active = review.activeItemIdsByOwnerChatId[ownerChatId] === item.itemId;
    if (active) {
      dispatchCommand({ type: "stopReview", ownerChatId, itemId: item.itemId });
      sendReviewStateToPreview(
        ownerChatId,
        item,
        getWorkPanelReviewSession(review, ownerChatId, item.itemId),
        false,
      );
      return;
    }
    const capability = resourceReviewCapabilities[itemRuntimeKey(ownerChatId, item.itemId)];
    const reviewSource = reviewSourceForItem(
      item,
      capability,
      item.descriptor.kind === "web"
        ? {
            url: webPage?.url || readWebviewUrl(findItemWebview(ownerChatId, item.itemId)),
            title: webPage?.title || item.title,
          }
        : undefined,
    );
    if (!reviewSource) return;
    setReviewErrors((current) => ({ ...current, [runtimeKey]: "" }));
    dispatchCommand({ type: "activateItem", ownerChatId, itemId: item.itemId });
    const started = dispatchCommand({
      type: "startReview",
      ownerChatId,
      itemId: item.itemId,
      kind: reviewSource.kind,
      source: reviewSource.source,
    });
    if (started.ok) {
      const session = getWorkPanelReviewSession(started.nextState.review, ownerChatId, item.itemId);
      window.requestAnimationFrame(() => sendReviewStateToPreview(ownerChatId, item, session, true));
    }
  };

  const exportReviewImage = async (
    ownerChatId: string,
    item: WorkPanelItem,
    session: WorkPanelReviewSession,
  ) => {
    const requestId = globalThis.crypto.randomUUID();
    const webview = findItemWebview(ownerChatId, item.itemId);
    if (!webview) return null;
    const pending = waitForReviewRequest(requestId);
    try {
      if (item.descriptor.kind === "local-file") {
        webview.send(WORK_PANEL_PREVIEW_REVIEW_ACTION_CHANNEL, {
          action: "export-image",
          version: WORK_PANEL_REVIEW_VERSION,
          requestId,
          annotations: session.annotations,
        });
      } else {
        webview.send(SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL, {
          action: AGENT_WEBCLIENT_WORKPANEL_PREVIEW_REVIEW_ACTION,
          version: AGENT_WEBCLIENT_WORKPANEL_PREVIEW_REVIEW_VERSION,
          requestId,
          operation: "export-image",
          kind: "image",
          annotations: session.annotations,
        });
      }
    } catch {
      const pendingRequest = pendingReviewRequestsRef.current.get(requestId);
      if (pendingRequest) {
        window.clearTimeout(pendingRequest.timer);
        pendingReviewRequestsRef.current.delete(requestId);
      }
      return null;
    }
    const result = await pending;
    if (
      result.event !== "image-exported" ||
      !result.ok ||
      result.sizeBytes <= 0 ||
      result.sizeBytes > WORK_PANEL_REVIEW_MAX_PNG_BYTES ||
      !result.dataUrl.startsWith("data:image/png;base64,")
    ) return null;
    return result;
  };

  const insertReviewComposerDraft = async (
    ownerChatId: string,
    session: WorkPanelReviewSession,
    text: string,
    imageExport: Extract<WorkPanelPreviewReviewEvent, { event: "image-exported"; ok: true }> | null,
  ) => {
    const mainChatWebview = getServiceSurfaceWebview(MAIN_CHAT_SURFACE_ID);
    if (!mainChatWebview) return false;
    const requestId = globalThis.crypto.randomUUID();
    let cancelPendingResult: () => void = () => undefined;
    const result = new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        mainChatWebview.removeEventListener("ipc-message", handleMessage as EventListener);
        resolve(ok);
      };
      const handleMessage = (event: Event) => {
        const payload = readReviewEvent(event as Event & { channel?: string; args?: unknown[] });
        if (
          payload?.event === "composer-draft-result" &&
          payload.requestId === requestId
        ) finish(payload.ok);
      };
      const timer = window.setTimeout(() => finish(false), 8_000);
      mainChatWebview.addEventListener("ipc-message", handleMessage as EventListener);
      cancelPendingResult = () => finish(false);
    });
    const sourceName = session.source.fileName.replace(/[\r\n]/gu, "").slice(0, 220) || "review.png";
    try {
      mainChatWebview.send(SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL, {
        action: AGENT_WEBCLIENT_COMPOSER_DRAFT_ACTION,
        version: AGENT_WEBCLIENT_COMPOSER_DRAFT_VERSION,
        requestId,
        ownerChatId,
        text,
        ...(imageExport ? {
          attachment: {
            name: `annotated-${sourceName.replace(/\.[^.]+$/u, "")}.png`,
            mimeType: "image/png",
            dataBase64: imageExport.dataUrl.slice("data:image/png;base64,".length),
            sizeBytes: imageExport.sizeBytes,
          },
        } : {}),
        reviewData: {
          version: WORK_PANEL_REVIEW_VERSION,
          sourceKind: session.source.sourceKind,
          kind: session.kind,
          source: {
            fileName: session.source.fileName,
            revision: session.source.revision,
            ...(session.source.relativePath
              ? { relativePath: session.source.relativePath }
              : {}),
            ...(session.source.resourceId
              ? { resourceId: session.source.resourceId }
              : {}),
            ...(session.source.url
              ? { url: session.source.url }
              : {}),
          },
          annotations: session.annotations,
        },
      });
    } catch {
      cancelPendingResult();
      return false;
    }
    return result;
  };

  const handoffReview = async (ownerChatId: string, item: WorkPanelItem) => {
    const runtimeKey = itemRuntimeKey(ownerChatId, item.itemId);
    const session = getWorkPanelReviewSession(stateRef.current.review, ownerChatId, item.itemId);
    if (!session || !isWorkPanelReviewReadyForComposer(session)) return;
    setReviewHandoffBusyKeys((current) => new Set(current).add(runtimeKey));
    setReviewErrors((current) => ({ ...current, [runtimeKey]: "" }));
    try {
      const metadata = reviewPreviewMetadata[runtimeKey];
      const imageExport = session.kind === "image"
        ? await exportReviewImage(ownerChatId, item, session)
        : null;
      if (session.kind === "image" && !imageExport) {
        setReviewErrors((current) => ({
          ...current,
          [runtimeKey]: t("chatWorkPanel.review.exportFailed"),
        }));
        return;
      }
      const text = buildWorkPanelReviewComposerDraft(
        session,
        metadata?.width && metadata?.height
          ? { width: metadata.width, height: metadata.height }
          : undefined,
      );
      const inserted = await insertReviewComposerDraft(ownerChatId, session, text, imageExport);
      if (!inserted) {
        setReviewErrors((current) => ({
          ...current,
          [runtimeKey]: t("chatWorkPanel.review.handoffFailed"),
        }));
        return;
      }
      dispatchCommand({ type: "discardReview", ownerChatId, itemId: item.itemId });
      sendReviewStateToPreview(ownerChatId, item, null, false);
    } finally {
      setReviewHandoffBusyKeys((current) => {
        const next = new Set(current);
        next.delete(runtimeKey);
        return next;
      });
    }
  };

  const handoffNativeImageReview = async (
    ownerChatId: string,
    item: WorkPanelItem,
    input: {
      annotations: import("../../shared/work-panel-review").ImageRegionAnnotation[];
      dataBase64: string;
      sizeBytes: number;
      width: number;
      height: number;
    },
  ) => {
    if (
      item.descriptor.kind !== "native" ||
      item.descriptor.surfaceKey !== "resource-image" ||
      input.sizeBytes <= 0 ||
      input.sizeBytes > WORK_PANEL_REVIEW_MAX_PNG_BYTES
    ) return false;
    const context = item.descriptor.context;
    const now = Date.now();
    const session: WorkPanelReviewSession = {
      version: WORK_PANEL_REVIEW_VERSION,
      ownerChatId,
      itemId: item.itemId,
      kind: "image",
      source: {
        sourceKind: context.profile === "reference" ? "reference" : "artifact",
        fileName: String(context.fileName || item.title),
        revision: String(context.revision || ""),
        relativePath: String(context.relativePath || ""),
        resourceId: String(context.resourceId || ""),
      },
      annotations: input.annotations,
      createdAt: now,
      updatedAt: now,
    };
    const text = buildWorkPanelReviewComposerDraft(session, {
      width: input.width,
      height: input.height,
    });
    return insertReviewComposerDraft(ownerChatId, session, text, {
      event: "image-exported",
      version: WORK_PANEL_REVIEW_VERSION,
      requestId: globalThis.crypto.randomUUID(),
      ok: true,
      dataUrl: `data:image/png;base64,${input.dataBase64}`,
      width: input.width,
      height: input.height,
      sizeBytes: input.sizeBytes,
    });
  };

  const handleLocalResourceAction = async (
    ownerChatId: string,
    item: WorkPanelItem,
    action: "reveal" | "open-default",
  ): Promise<ChatWorkPanelOpenLocalResourceResult> => {
    const profile = localResourceProfile(item);
    if (!profile || item.descriptor.kind !== "webclient") {
      return {
        ok: false,
        code: "invalid_request",
        message: t("chatWorkPanel.resourceActions.failed"),
      };
    }
    const relativePath = resolveChatWorkPanelLocalResourcePath({
      ownerChatId,
      profile,
      route: item.descriptor.route,
    });
    if (!relativePath) {
      return {
        ok: false,
        code: "invalid_request",
        message: t("chatWorkPanel.resourceActions.failed"),
      };
    }

    try {
      const request = { ownerChatId, profile, relativePath };
      const result = action === "reveal"
        ? await window.electronAPI.chatWorkPanelTabContextMenu.revealLocalResource(request)
        : await window.electronAPI.chatWorkPanelTabContextMenu.openLocalResource(request);
      if (!result.ok) {
        console.warn(
          `[work-panel] failed to ${action === "reveal" ? "reveal" : "open"} local resource`,
          result.code,
        );
      }
      return result;
    } catch {
      console.warn("[work-panel] local resource action failed");
      return {
        ok: false,
        code: "open_failed",
        message: t("chatWorkPanel.resourceActions.failed"),
      };
    }
  };

  const handleTabContextMenu = async (
    event: ReactMouseEvent<HTMLDivElement>,
    ownerChatId: string,
    item: WorkPanelItem,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const workspace = stateRef.current.workspaces.find(
      (candidate) => candidate.ownerChatId === ownerChatId,
    );
    const reviewSource = reviewSourceForItem(
      item,
      resourceReviewCapabilities[itemRuntimeKey(ownerChatId, item.itemId)],
      item.descriptor.kind === "web"
        ? {
            url: readWebviewUrl(findItemWebview(ownerChatId, item.itemId)),
            title: item.title,
          }
        : undefined,
    );
    const reviewActive = stateRef.current.review.activeItemIdsByOwnerChatId[ownerChatId] === item.itemId;
    const result = await window.electronAPI.chatWorkPanelTabContextMenu.popup({
      mode: "work-panel",
      x: event.clientX,
      y: event.clientY,
      profile: tabContextMenuProfile(item),
      isFullscreen: fullscreenOwnerChatId === ownerChatId,
      reviewMode: reviewSource ? (reviewActive ? "active" : "inactive") : "unavailable",
      canClose: item.closable && !item.pinned,
      canCloseOthers: workspace?.items.some((candidate) =>
        candidate.itemId !== item.itemId && candidate.closable && !candidate.pinned,
      ) ?? false,
    });
    if (result.actionId === "toggle-review") {
      toggleReviewForItem(ownerChatId, item);
      return;
    }
    if (result.actionId === "reload") {
      const session = getWorkPanelReviewSession(stateRef.current.review, ownerChatId, item.itemId);
      if (session?.kind === "html" && session.annotations.length > 0) {
        dispatchCommand({
          type: "markReviewInvalid",
          ownerChatId,
          itemId: item.itemId,
          reason: "preview reloaded",
        });
      }
      try {
        findItemWebview(ownerChatId, item.itemId)?.reload();
      } catch {
        // The guest may have been replaced while the native menu was open.
      }
      return;
    }
    if (result.actionId === "copy-url" && item.descriptor.kind === "web") {
      let currentUrl = "";
      try {
        currentUrl = normalizeWorkPanelWebUrl(findItemWebview(ownerChatId, item.itemId)?.getURL());
      } catch {
        // Fall back to the descriptor URL if the guest has already gone away.
      }
      await window.electronAPI.clipboard.writeText(currentUrl || item.descriptor.url);
      return;
    }
    if (result.actionId === "copy-title") {
      await window.electronAPI.clipboard.writeText(item.title);
      return;
    }
    if (result.actionId === "reveal-resource") {
      await handleLocalResourceAction(ownerChatId, item, "reveal");
      return;
    }
    if (result.actionId === "open-resource-default-app") {
      await handleLocalResourceAction(ownerChatId, item, "open-default");
      return;
    }
    if (
      result.actionId === "download-resource" &&
      item.descriptor.kind === "webclient" &&
      (item.descriptor.module === "artifact" || item.descriptor.module === "reference")
    ) {
      const resourceWebview = findItemWebview(ownerChatId, item.itemId);
      if (!resourceWebview) return;
      try {
        resourceWebview.send(
          SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL,
          {
            action: AGENT_WEBCLIENT_WORKPANEL_RESOURCE_DOWNLOAD_ACTION,
            version: AGENT_WEBCLIENT_WORKPANEL_RESOURCE_DOWNLOAD_VERSION,
          },
        );
      } catch {
        // The Resource Viewer may have been replaced while the native menu was open.
      }
      return;
    }
    if (result.actionId === "close-tab") {
      closeItemWithReviewProtection(ownerChatId, item.itemId);
      return;
    }
    if (result.actionId === "close-other-tabs") {
      closeOtherItemsWithReviewProtection(ownerChatId, item.itemId);
      return;
    }
    if (result.actionId === "toggle-fullscreen") {
      if (fullscreenOwnerChatId === ownerChatId) {
        await onFullscreenChange(null);
        return;
      }
      const activation = dispatchCommand({
        type: "activateItem",
        ownerChatId,
        itemId: item.itemId,
      });
      if (activation.ok) {
        await onFullscreenChange(ownerChatId);
      }
    }
  };

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.chatWorkPanel.localFiles.getReviewPreloadUrl()
      .then((url) => {
        if (!cancelled && typeof url === "string" && url.startsWith("file:")) {
          setReviewPreloadUrl(url);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timers: number[] = [];
    const publish = () => {
      for (const workspace of stateRef.current.workspaces) {
        for (const item of workspace.items) {
          if (
            item.descriptor.kind !== "webclient" ||
            (item.descriptor.module !== "artifact" && item.descriptor.module !== "reference")
          ) continue;
          const webview = findItemWebview(workspace.ownerChatId, item.itemId);
          if (!webview) continue;
          try {
            webview.send(SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL, {
              action: AGENT_WEBCLIENT_WORKPANEL_PREVIEW_REVIEW_ACTION,
              version: AGENT_WEBCLIENT_WORKPANEL_PREVIEW_REVIEW_VERSION,
              requestId: globalThis.crypto.randomUUID(),
              operation: "capabilities",
            });
          } catch {
            // The Resource Viewer may not have reached dom-ready yet.
          }
        }
      }
    };
    timers.push(window.setTimeout(publish, 0));
    timers.push(window.setTimeout(publish, 500));
    timers.push(window.setTimeout(publish, 1_500));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [state.workspaces]);

  useEffect(() => {
    for (const workspace of state.workspaces) {
      const activeItemId = state.review.activeItemIdsByOwnerChatId[workspace.ownerChatId];
      for (const item of workspace.items) {
        const session = getWorkPanelReviewSession(
          state.review,
          workspace.ownerChatId,
          item.itemId,
        );
        if (!session && item.descriptor.kind !== "local-file") continue;
        sendReviewStateToPreview(
          workspace.ownerChatId,
          item,
          session,
          activeItemId === item.itemId,
        );
      }
    }
  }, [loadingWebItems, reviewPreloadUrl, state.review, state.workspaces]);

  useEffect(() => () => {
    for (const pending of pendingReviewRequestsRef.current.values()) {
      window.clearTimeout(pending.timer);
    }
    pendingReviewRequestsRef.current.clear();
  }, []);

  useEffect(() => {
    const nextHandles = new Map<string, string>();
    for (const workspace of state.workspaces) {
      for (const item of workspace.items) {
        if (item.descriptor.kind === "native" && item.descriptor.surfaceKey === "resource-image") {
          const handleId = String(item.descriptor.context.handleId || "");
          if (handleId) nextHandles.set(handleId, workspace.ownerChatId);
        }
      }
    }
    for (const [handleId, ownerChatId] of previousResourceImageHandlesRef.current) {
      if (nextHandles.has(handleId)) continue;
      void window.electronAPI.chatWorkPanel.resourceImages.release({
        ownerChatId,
        rendererGeneration: rendererGenerationRef.current,
        handleIds: [handleId],
      }).catch(() => undefined);
    }
    previousResourceImageHandlesRef.current = nextHandles;
  }, [state.workspaces]);

  useEffect(() => () => {
    for (const [handleId, ownerChatId] of previousResourceImageHandlesRef.current) {
      void window.electronAPI.chatWorkPanel.resourceImages.release({
        ownerChatId,
        rendererGeneration: rendererGenerationRef.current,
        handleIds: [handleId],
      }).catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    const nextPartitions = new Set(
      state.workspaces.flatMap((workspace) => workspace.items
        .filter((item) => item.descriptor.kind === "web")
        .map((item) => itemPartition(
          workspace.workspaceId,
          resolveWorkPanelWebSessionKey(state, workspace.workspaceId, item.itemId),
        ))),
    );
    for (const partition of previousWebPartitionsRef.current) {
      if (nextPartitions.has(partition)) continue;
      void window.electronAPI.chatWorkPanel?.clearSession?.({ partition }).catch(() => undefined);
    }
    previousWebPartitionsRef.current = nextPartitions;
  }, [state.webSessionKeysByItemId, state.workspaces]);

  useEffect(() => {
    const nextHandles = new Map<string, string>();
    for (const workspace of state.workspaces) {
      for (const item of workspace.items) {
        if (item.descriptor.kind === "local-file") {
          nextHandles.set(item.descriptor.handleId, workspace.ownerChatId);
        }
      }
    }
    for (const [handleId, ownerChatId] of previousLocalFileHandlesRef.current) {
      if (nextHandles.has(handleId)) continue;
      void window.electronAPI.chatWorkPanel.localFiles.release({
        ownerChatId,
        rendererGeneration: rendererGenerationRef.current,
        handleIds: [handleId],
      }).catch(() => undefined);
    }
    previousLocalFileHandlesRef.current = nextHandles;
  }, [state.workspaces]);

  useEffect(() => () => {
    for (const [handleId, ownerChatId] of previousLocalFileHandlesRef.current) {
      void window.electronAPI.chatWorkPanel.localFiles.release({
        ownerChatId,
        rendererGeneration: rendererGenerationRef.current,
        handleIds: [handleId],
      }).catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    if (!addMenuOwnerChatId) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (addMenuRef.current?.contains(target) || addButtonRef.current?.contains(target))) return;
      closeAddMenu();
    };
    const handleWindowChange = () => updateAddMenuPosition();
    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("resize", handleWindowChange);
    window.addEventListener("scroll", handleWindowChange, true);
    requestAnimationFrame(() => focusMenuItem("first"));
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("resize", handleWindowChange);
      window.removeEventListener("scroll", handleWindowChange, true);
    };
  }, [addMenuOwnerChatId, addMenuView]);

  useEffect(() => window.electronAPI.onWebviewOpenTab(({
    target,
    navigationKind,
    sourceGuestId,
    url,
  }) => {
    if (target !== "work-panel") return;
    if (!Number.isSafeInteger(sourceGuestId) || sourceGuestId <= 0) return;
    const webviews = Array.from(document.querySelectorAll("webview")) as Electron.WebviewTag[];
    const sourceWebview = webviews.find((webview) => readWebviewGuestId(webview) === sourceGuestId);
    const itemHost = sourceWebview?.closest<HTMLElement>("[data-work-panel-item]");
    const ownerChatId = itemHost?.dataset.workPanelOwner || "";
    const sourceItemId = itemHost?.dataset.workPanelItem || "";
    const sourceWorkspace = stateRef.current.workspaces.find(
      (workspace) => workspace.ownerChatId === ownerChatId,
    );
    const sourceItem = sourceWorkspace?.items.find((item) => item.itemId === sourceItemId);
    if (
      !ownerChatId ||
      (sourceItem?.descriptor.kind !== "web" && sourceItem?.descriptor.kind !== "webapp-ref")
    ) return;
    if (navigationKind === "blob") {
      if (sourceItem.descriptor.kind !== "web") return;
      const normalizedBlobUrl = normalizeWebviewBlobPopupUrl(url);
      if (!normalizedBlobUrl) return;
      dispatchCommand({
        type: "openBlobPopup",
        ownerChatId,
        sourceItemId,
        url: normalizedBlobUrl,
      });
      return;
    }
    const normalizedUrl = normalizeWorkPanelWebUrl(url);
    if (!normalizedUrl) return;
    dispatchCommand({
      type: "openItem",
      ownerChatId,
      descriptor: { kind: "web", url: normalizedUrl },
    });
  }), [dispatchCommand]);

  useEffect(() => registerDesktopActionProviderForScope("global", async (request) => {
    if (!request.action.startsWith("desktop.workpanel.")) return null;
    const ownerChatId = request.source?.chatId?.trim() || "";
    if (!ownerChatId) return actionError("source_chat_required", "A trusted source.chatId is required.");
    const ownerAgentKey = request.source?.agentKey?.trim() || "";
    const args = request.args ?? {};
    const forbidden = [
      "chatId", "ownerChatId", "agentKey", "runId", "workspaceId", "stableKey", "preload", "webPreferences",
    ].filter((key) => key in args);
    if (forbidden.length > 0) return actionError("invalid_request", `WorkPanel does not accept: ${forbidden.join(", ")}.`);
    const current = () => stateRef.current.workspaces.find((workspace) => workspace.ownerChatId === ownerChatId) ?? null;
    const execute = (command: WorkPanelCommand) => {
      const result = dispatchCommand(command);
      const { nextState: _nextState, ...publicResult } = result;
      return publicResult.ok
        ? { ok: true as const, result: publicResult }
        : { ok: false as const, error: publicResult.error };
    };
    const ensureTrustedWorkspace = () => {
      if (current()) return null;
      if (!ownerAgentKey) {
        return actionError(
          "source_owner_required",
          "A trusted source.agentKey is required to create a WorkPanel workspace.",
        );
      }
      const created = execute({
        type: "openItem",
        ownerChatId,
        descriptor: {
          kind: "webclient",
          module: "overview",
          route: createAgentWebclientOverviewPath({ chatId: ownerChatId }),
          context: { chatId: ownerChatId, agentKey: ownerAgentKey },
          title: t("chatWorkPanel.overview"),
          pinned: true,
          closable: false,
        },
      });
      return created.ok ? null : created;
    };

    switch (request.action) {
      case "desktop.workpanel.getState": {
        const workspace = current();
        return { ok: true, result: { ok: true, workspaceId: workspace?.workspaceId || "", state: workspace ?? undefined } };
      }
      case "desktop.workpanel.openTab": {
        const descriptor = args.descriptor as { kind?: unknown } | undefined;
        if (
          !descriptor ||
          (descriptor.kind !== "webclient" && descriptor.kind !== "web")
        ) {
          return actionError("invalid_request", "This WorkPanel item kind is host-only.");
        }
        if (ownerAgentKey) {
          const bootstrapFailure = ensureTrustedWorkspace();
          if (bootstrapFailure) return bootstrapFailure;
        }
        return execute({ type: "openItem", ownerChatId, descriptor: descriptor as any });
      }
      case "desktop.workpanel.openResourceImage": {
        const claimId = typeof args.claimId === "string" ? args.claimId.trim() : "";
        if (!claimId) return actionError("target_unavailable", "Native image claim is unavailable.");
        const bootstrapFailure = ensureTrustedWorkspace();
        if (bootstrapFailure) return bootstrapFailure;
        const claimed = await window.electronAPI.chatWorkPanel.resourceImages.claim({
          ownerChatId,
          rendererGeneration: rendererGenerationRef.current,
          claimId,
        });
        if (!claimed.ok || !claimed.resource) {
          return actionError("target_unavailable", claimed.message || "Native image claim is unavailable.");
        }
        const resource = claimed.resource;
        const opened = execute({
          type: "openItem",
          ownerChatId,
          descriptor: {
            kind: "native",
            surfaceKey: "resource-image",
            context: { ...resource },
            title: typeof args.title === "string" && args.title.trim()
              ? args.title.trim()
              : resource.fileName,
          },
        });
        if (!opened.ok && !claimed.reused) {
          await window.electronAPI.chatWorkPanel.resourceImages.release({
            ownerChatId,
            rendererGeneration: rendererGenerationRef.current,
            handleIds: [resource.handleId],
          }).catch(() => undefined);
        }
        return opened;
      }
      case "desktop.workpanel.openWeb": {
        const url = normalizeWorkPanelWebUrl(args.url);
        if (!url) return actionError("invalid_url", "url must use http: or https: without credentials.");
        const bootstrapFailure = ensureTrustedWorkspace();
        if (bootstrapFailure) return bootstrapFailure;
        return execute({
          type: "openItem",
          ownerChatId,
          descriptor: { kind: "web", url },
        });
      }
      case "desktop.workpanel.openLocalFile": {
        const claimId = typeof args.claimId === "string" ? args.claimId.trim() : "";
        if (!claimId) return actionError("target_unavailable", "Local file claim is unavailable.");
        const bootstrapFailure = ensureTrustedWorkspace();
        if (bootstrapFailure) return bootstrapFailure;
        const claimed = await window.electronAPI.chatWorkPanel.localFiles.claim({
          ownerChatId,
          rendererGeneration: rendererGenerationRef.current,
          claimId,
        });
        if (!claimed.ok || !claimed.file) {
          return actionError(
            "target_unavailable",
            claimed.message || "Local file claim is unavailable.",
          );
        }
        const file = claimed.file;
        const opened = execute({
          type: "openItem",
          ownerChatId,
          descriptor: {
            kind: "local-file",
            handleId: file.handleId,
            fileName: file.fileName,
            previewKind: file.previewKind,
            ...(file.reviewKind ? { reviewKind: file.reviewKind } : {}),
            ...(file.workspaceRelativePath
              ? { workspaceRelativePath: file.workspaceRelativePath }
              : {}),
            ...(file.reviewRevision ? { reviewRevision: file.reviewRevision } : {}),
            title: typeof args.title === "string" && args.title.trim()
              ? args.title.trim()
              : file.fileName,
          },
        });
        if (!opened.ok) {
          if (!claimed.reused) {
            await window.electronAPI.chatWorkPanel.localFiles.release({
              ownerChatId,
              rendererGeneration: rendererGenerationRef.current,
              handleIds: [file.handleId],
            }).catch(() => undefined);
          }
          return opened;
        }
        if (claimed.reused && file.previewKind !== "unsupported") {
          const item = current()?.items.find((candidate) =>
            candidate.descriptor.kind === "local-file" &&
            candidate.descriptor.handleId === file.handleId,
          );
          if (item) {
            try {
              findItemWebview(ownerChatId, item.itemId)?.reload();
            } catch {
              // The existing local preview may still be remounting after activation.
            }
          }
        }
        return opened;
      }
      case "desktop.workpanel.refreshWeb": {
        const url = normalizeWorkPanelWebUrl(args.url);
        if (!url) return actionError("invalid_url", "url must use http: or https: without credentials.");
        const workspace = current();
        if (!workspace) return actionError("target_unavailable", "WorkPanel workspace is unavailable.");
        const item = workspace.items.find((candidate) =>
          candidate.descriptor.kind === "web" && candidate.descriptor.url === url,
        );
        if (!item) return actionError("target_unavailable", "WorkPanel WebView item is unavailable.");
        const webview = findItemWebview(ownerChatId, item.itemId);
        if (!webview) return actionError("target_unavailable", "WorkPanel WebView guest is unavailable.");
        try {
          webview.reload();
        } catch (error) {
          return actionError(
            "target_unavailable",
            error instanceof Error ? error.message : "WorkPanel WebView could not be refreshed.",
          );
        }
        return execute({ type: "activateItem", ownerChatId, itemId: item.itemId });
      }
      case "desktop.workpanel.activateTab":
        return execute({ type: "activateItem", ownerChatId, itemId: String(args.tabId || "") });
      case "desktop.workpanel.closeTab":
        return execute({ type: "closeItem", ownerChatId, itemId: String(args.tabId || "") });
      case "desktop.workpanel.closeWorkpanel":
        return execute({ type: "closeWorkspace", ownerChatId });
      default:
        return null;
    }
  }), [dispatchCommand, t]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let workPanelFocusActive: boolean | null = null;
    const publishFocusState = (active: boolean) => {
      if (workPanelFocusActive === active) return;
      workPanelFocusActive = active;
      window.electronAPI.desktopShell.setWorkPanelKeyboardFocusActive(active);
    };
    const updateFocusState = (target: EventTarget | null) => {
      const element = target instanceof Element ? target : null;
      const visiblePanel = element?.closest<HTMLElement>(".chat-work-panel.is-visible");
      const canonicalWebapp = element?.closest<HTMLElement>(".canonical-webapp-surface.is-active");
      publishFocusState(Boolean(
        (visiblePanel && root.contains(visiblePanel)) ||
        (canonicalWebapp?.dataset.workPanelOwner && canonicalWebapp.dataset.workPanelOwner === activeChatId),
      ));
    };
    const handlePointerDown = (event: PointerEvent) => {
      updateFocusState(event.target);
    };
    const handleFocusIn = () => publishFocusState(true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    root.addEventListener("focusin", handleFocusIn, true);
    updateFocusState(document.activeElement);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      root.removeEventListener("focusin", handleFocusIn, true);
      publishFocusState(false);
    };
  }, [activeChatId]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const isCloseShortcut = (event: KeyboardEvent) => {
      if (event.type !== "keydown" || event.repeat || event.key.toLowerCase() !== "w") return false;
      if (isMac) return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
      if (isWindows) return event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
      return false;
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && fullscreenOwnerChatId === activeChatId) {
        void onFullscreenChange(null);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!isCloseShortcut(event)) return;
      const activeElement = document.activeElement as HTMLElement | null;
      const visiblePanel = activeElement?.closest<HTMLElement>(".chat-work-panel.is-visible");
      if (!visiblePanel || !root.contains(visiblePanel)) return;
      const ownerChatId = visiblePanel.dataset.workPanelChat || "";
      if (!ownerChatId) return;
      event.preventDefault();
      event.stopPropagation();
      closeWorkPanelStep(ownerChatId);
    };
    root.addEventListener("keydown", handleKeyDown, true);
    const disposeFullscreenExitShortcut = window.electronAPI.onWorkPanelFullscreenExitShortcut(() => {
      if (fullscreenOwnerChatId === activeChatId) {
        void onFullscreenChange(null);
      }
    });
    const disposeGuestShortcut = window.electronAPI.onWorkPanelCloseShortcut(({
      guestId,
      fallbackToWindowClose,
      workPanelFocused,
    }) => {
      if (guestId === null) {
        const activeElement = document.activeElement as HTMLElement | null;
        const visiblePanel = activeElement?.closest<HTMLElement>(".chat-work-panel.is-visible");
        const ownerChatId = visiblePanel && root.contains(visiblePanel)
          ? visiblePanel.dataset.workPanelChat || ""
          : "";
        if (ownerChatId) {
          closeWorkPanelStep(ownerChatId);
        } else if (workPanelFocused && activeChatId) {
          closeWorkPanelStep(activeChatId);
        } else if (fallbackToWindowClose) {
          window.electronAPI.desktopShell.requestWindowClose();
        }
        return;
      }
      if (!Number.isSafeInteger(guestId) || guestId <= 0) return;
      const webviews = Array.from(document.querySelectorAll("webview")) as Electron.WebviewTag[];
      const matchingWebview = webviews.find((webview) => readWebviewGuestId(webview) === guestId);
      const itemHost = matchingWebview?.closest<HTMLElement>("[data-work-panel-item]");
      const ownerChatId = itemHost?.dataset.workPanelOwner || "";
      const itemId = itemHost?.dataset.workPanelItem || "";
      const workspace = stateRef.current.workspaces.find((item) => item.ownerChatId === ownerChatId);
      if (!workspace || workspace.ownerChatId !== activeChatId || workspace.activeItemId !== itemId) return;
      closeWorkPanelStep(ownerChatId);
    });
    return () => {
      root.removeEventListener("keydown", handleKeyDown, true);
      disposeFullscreenExitShortcut();
      disposeGuestShortcut();
    };
  }, [activeChatId, dispatchCommand, fullscreenOwnerChatId, isMac, isWindows, onFullscreenChange]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const webviews = Array.from(root.querySelectorAll("webview")) as Electron.WebviewTag[];
    const markReady = (event: Event) => {
      (event.currentTarget as HTMLElement).dataset.workPanelDomReady = "true";
    };
    for (const webview of webviews) webview.addEventListener("dom-ready", markReady);
    const visible = activeChatId
      ? root.querySelector<HTMLElement>(`[data-work-panel-chat="${CSS.escape(activeChatId)}"]`)
      : null;
    if (!visible) {
      const activeElement = document.activeElement as HTMLElement | null;
      if (activeElement && root.contains(activeElement)) activeElement.blur();
    } else {
      window.requestAnimationFrame(() => {
        const webview = visible.querySelector(
          "[data-work-panel-active=\"true\"] webview",
        ) as Electron.WebviewTag | null;
        if (!webview) return;
        if (isMac) {
          webview.focus();
        } else if (isWindows) {
          if (webview.dataset.workPanelDomReady === "true" && document.hasFocus()) webview.focus();
        } else if (document.hasFocus()) {
          webview.focus();
        }
      });
    }
    return () => {
      if (isMac) {
        const activeElement = document.activeElement as HTMLElement | null;
        if (activeElement && root.contains(activeElement)) activeElement.blur();
      } else if (isWindows) {
        for (const webview of webviews) webview.blur();
      }
      for (const webview of webviews) webview.removeEventListener("dom-ready", markReady);
    };
  }, [activeChatId, isMac, isWindows, state.workspaces]);

  return (
    <div
      ref={rootRef}
      className={`work-panel-host${fullscreenOwnerChatId === activeChatId ? " is-fullscreen" : ""}`}
    >
      {state.workspaces.map((workspace) => {
        const visible = workspace.ownerChatId === activeChatId;
        return (
          <aside
            key={workspace.workspaceId}
            className={`chat-work-panel${visible ? " is-visible" : ""}${visible && hasPanelToggle ? " has-panel-toggle" : ""}`}
            hidden={!visible}
            aria-hidden={!visible}
            aria-label={t("chatWorkPanel.title")}
            data-work-panel-chat={workspace.ownerChatId}
          >
            <div className="chat-work-panel-tabs" role="tablist" aria-label={t("chatWorkPanel.title")}>
              {workspace.items.map((item) => {
                const active = workspace.activeItemId === item.itemId;
                const closable = item.closable && !item.pinned;
                const overview = item.descriptor.kind === "webclient" && item.descriptor.module === "overview";
                const itemLoading = loadingWebItems.has(itemRuntimeKey(workspace.ownerChatId, item.itemId));
                const reviewSession = getWorkPanelReviewSession(
                  state.review,
                  workspace.ownerChatId,
                  item.itemId,
                );
                return (
                  <div
                    key={item.itemId}
                    className={`chat-work-panel-tab${active ? " is-active" : ""}${overview ? " is-overview" : ""}${closable ? " has-close" : ""}`}
                    role="presentation"
                    onContextMenu={(event) => {
                      void handleTabContextMenu(event, workspace.ownerChatId, item).catch(() => undefined);
                    }}
                  >
                    <button
                      type="button"
                      role="tab"
                      className="chat-work-panel-tab-trigger"
                      aria-selected={active}
                      title={item.title}
                      onClick={() => dispatchCommand({
                        type: "activateItem",
                        ownerChatId: workspace.ownerChatId,
                        itemId: item.itemId,
                      })}
                    >
                      <span className={`chat-work-panel-tab-icon${itemLoading ? " is-loading" : ""}`} aria-hidden="true">
                        {itemLoading ? <span className="chat-work-panel-tab-loading-spinner" /> : <WorkPanelItemIcon item={item} />}
                      </span>
                      <span className="chat-work-panel-tab-title">{item.title}</span>
                      {reviewSession?.annotations.length ? (
                        <span
                          className="chat-work-panel-tab-review-count"
                          aria-label={t("chatWorkPanel.review.annotationCount", {
                            count: reviewSession.annotations.length,
                          })}
                        >
                          {reviewSession.annotations.length}
                        </span>
                      ) : null}
                    </button>
                    {closable ? (
                      <button
                        type="button"
                        className="chat-work-panel-tab-close"
                        aria-label={t("chatWorkPanel.closeTab", { title: item.title })}
                        onClick={(event) => {
                          event.stopPropagation();
                          closeItemWithReviewProtection(workspace.ownerChatId, item.itemId);
                        }}
                      >
                        <CloseOutlined />
                      </button>
                    ) : null}
                  </div>
                );
              })}
              <div className="chat-work-panel-add-tab" role="presentation">
                <button
                  ref={visible ? addButtonRef : undefined}
                  type="button"
                  className={`chat-work-panel-add-button${addMenuOwnerChatId === workspace.ownerChatId ? " is-open" : ""}`}
                  aria-label={t("chatWorkPanel.add.openMenu")}
                  aria-haspopup="menu"
                  aria-expanded={addMenuOwnerChatId === workspace.ownerChatId}
                  onClick={() => openAddMenu(workspace.ownerChatId)}
                >
                  <PlusOutlined />
                </button>
              </div>
            </div>
            <div className="chat-work-panel-body">
              <Suspense fallback={null}>
                {workspace.items.map((item) => {
                  const active = visible && workspace.activeItemId === item.itemId;
                  const resourceProfile = localResourceProfile(item);
                  const supportsLocalResourceActions = Boolean(
                    resourceProfile &&
                    item.descriptor.kind === "webclient" &&
                    shouldShowChatWorkPanelLocalResourceActions({
                      ownerChatId: workspace.ownerChatId,
                      profile: resourceProfile,
                      route: item.descriptor.route,
                    }),
                  );
                  const reviewSession = getWorkPanelReviewSession(
                    state.review,
                    workspace.ownerChatId,
                    item.itemId,
                  );
                  const reviewActive = state.review.activeItemIdsByOwnerChatId[workspace.ownerChatId] === item.itemId;
                  const reviewRuntimeKey = itemRuntimeKey(workspace.ownerChatId, item.itemId);
                  const resourceReviewCapability = resourceReviewCapabilities[reviewRuntimeKey];
                  const showResourcePreviewToolbar = item.descriptor.kind === "webclient" &&
                    (item.descriptor.module === "artifact" || item.descriptor.module === "reference");
                  const webReviewPreloadEnabled = item.descriptor.kind === "web" &&
                    Boolean(normalizeWorkPanelWebUrl(item.descriptor.url));
                  const needsReviewPreload = webReviewPreloadEnabled || (
                    item.descriptor.kind === "local-file" && Boolean(item.descriptor.reviewKind)
                  );
                  const waitingForReviewPreload = needsReviewPreload && !reviewPreloadUrl;
                  return (
                    <div
                      key={item.itemId}
                      className={`chat-work-panel-item${active ? " is-active" : ""}${showResourcePreviewToolbar ? " has-preview-toolbar" : ""}${reviewActive && reviewSession ? " is-reviewing" : ""}`}
                      data-work-panel-active={active ? "true" : "false"}
                      data-work-panel-item={item.itemId}
                      data-work-panel-owner={workspace.ownerChatId}
                      hidden={!active}
                      aria-hidden={!active}
                    >
                      {showResourcePreviewToolbar ? (
                        <div
                          className="chat-work-panel-preview-toolbar"
                          role="toolbar"
                          aria-label={t("chatWorkPanel.previewToolbar.label")}
                        >
                          <div className="external-webview-page is-work-panel-browser">
                            <div className="external-webview-toolbar">
                              <div className="external-webview-toolbar-actions">
                                <button
                                  type="button"
                                  className="external-webview-toolbar-button"
                                  onClick={() => {
                                    const session = getWorkPanelReviewSession(
                                      stateRef.current.review,
                                      workspace.ownerChatId,
                                      item.itemId,
                                    );
                                    if (hasWorkPanelReviewDraft(session) && !session?.invalidReason) {
                                      dispatchCommand({
                                        type: "markReviewInvalid",
                                        ownerChatId: workspace.ownerChatId,
                                        itemId: item.itemId,
                                        reason: "preview_reloaded",
                                      });
                                    }
                                    try {
                                      findItemWebview(workspace.ownerChatId, item.itemId)?.reload();
                                    } catch {
                                      // The resource guest may have been replaced while this click was handled.
                                    }
                                  }}
                                  aria-label={t("externalWebview.refresh")}
                                  title={t("externalWebview.refresh")}
                                >
                                  <SidebarActionIcon kind="refresh" />
                                </button>
                              </div>
                              <div className="external-webview-toolbar-location">
                                <span className="external-webview-toolbar-location-icon" aria-hidden="true">
                                  <FileTextOutlined />
                                </span>
                                <span
                                  className="external-webview-toolbar-location-input is-static"
                                  title={resourceReviewCapability?.fileName || item.title}
                                >
                                  {resourceReviewCapability?.fileName || item.title}
                                </span>
                                <button
                                  type="button"
                                  className={`external-webview-toolbar-edit${reviewActive ? " is-active" : ""}`}
                                  disabled={!resourceReviewCapability}
                                  onClick={() => toggleReviewForItem(workspace.ownerChatId, item)}
                                  aria-label={t(reviewActive
                                    ? "chatWorkPanel.tabContextMenu.exitReview"
                                    : "chatWorkPanel.tabContextMenu.enterReview")}
                                  aria-pressed={reviewActive}
                                  title={resourceReviewCapability
                                    ? t(reviewActive
                                        ? "chatWorkPanel.tabContextMenu.exitReview"
                                        : "chatWorkPanel.tabContextMenu.enterReview")
                                    : t("chatWorkPanel.review.previewLoading")}
                                >
                                  <EditOutlined aria-hidden="true" />
                                  <span className="external-webview-toolbar-edit-label">
                                    {t(reviewActive
                                      ? "externalWebview.finishPageReview"
                                      : "externalWebview.editPage")}
                                  </span>
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : null}
                      {item.descriptor.kind === "native" && item.descriptor.surfaceKey === "resource-image" ? (
                        <WorkPanelResourceImage
                          active={active}
                          editing={activeImageEditorItemIds[workspace.ownerChatId] === item.itemId}
                          ownerChatId={workspace.ownerChatId}
                          itemId={item.itemId}
                          rendererGeneration={rendererGenerationRef.current}
                          resource={item.descriptor.context as unknown as import("../../shared/work-panel-resource-image").WorkPanelResourceImageSelection}
                          onEditingChange={(editing) => {
                            setActiveImageEditorItemIds((current) => {
                              if (editing) return { ...current, [workspace.ownerChatId]: item.itemId };
                              if (current[workspace.ownerChatId] !== item.itemId) return current;
                              const next = { ...current };
                              delete next[workspace.ownerChatId];
                              return next;
                            });
                          }}
                          onCommitted={(resource) => {
                            dispatchCommand({
                              type: "openItem",
                              ownerChatId: workspace.ownerChatId,
                              descriptor: {
                                kind: "native",
                                surfaceKey: "resource-image",
                                context: { ...resource },
                                title: resource.fileName,
                              },
                            });
                          }}
                          onHandoff={(input) => handoffNativeImageReview(
                            workspace.ownerChatId,
                            item,
                            input,
                          )}
                        />
                      ) : item.descriptor.kind === "webclient" ? (
                        <ServiceWebviewSurface
                          active={active}
                          embedPath={item.descriptor.route}
                          hostTheme={document.documentElement.dataset.theme === "dark" ? "dark" : "light"}
                          loadInitialEmbeddedUrlDirectly
                          ownerChatId={workspace.ownerChatId}
                          onAgentWebclientCurrentResourceAction={
                            supportsLocalResourceActions
                              ? (action, resource) => matchesLocalResourceIdentity(
                                  workspace.ownerChatId,
                                  item,
                                  resource,
                                )
                                ? handleLocalResourceAction(
                                    workspace.ownerChatId,
                                    item,
                                    action,
                                  )
                                : Promise.resolve({
                                    ok: false,
                                    code: "invalid_request" as const,
                                    message: t("chatWorkPanel.resourceActions.failed"),
                                  })
                              : undefined
                          }
                          onIpcMessage={(event) => handleReviewIpcMessage(
                            workspace.ownerChatId,
                            item,
                            event,
                          )}
                          serviceId="agent-webclient"
                          surfaceIdentity={createChatChildSurfaceIdentity(
                            item.descriptor.module,
                            item.stableKey,
                            workspace.ownerChatId
                          )}
                          surfaceIdentityKey={item.stableKey}
                          surfaceLabel={item.title}
                          skipContextRegistration
                        />
                      ) : item.descriptor.kind === "web" || (
                        item.descriptor.kind === "local-file" && item.descriptor.previewKind !== "unsupported"
                      ) ? (
                        waitingForReviewPreload ? (
                          <div className="chat-work-panel-local-file-fallback" aria-live="polite">
                            <FileTextOutlined aria-hidden="true" />
                            <span>{t("common.loading")}</span>
                          </div>
                        ) : <ExternalWebviewPage
                          active={active}
                          allowTabUrlCopy
                          allowUserTabCreation={false}
                          cdpActive={false}
                          chrome="browser"
                          enableDesktopWebActions={false}
                          onLoadingChange={(isLoading) => {
                            const key = itemRuntimeKey(workspace.ownerChatId, item.itemId);
                            if (isLoading) {
                              const currentSession = getWorkPanelReviewSession(
                                stateRef.current.review,
                                workspace.ownerChatId,
                                item.itemId,
                              );
                              if (hasWorkPanelReviewDraft(currentSession) && !currentSession?.invalidReason) {
                                dispatchCommand({
                                  type: "markReviewInvalid",
                                  ownerChatId: workspace.ownerChatId,
                                  itemId: item.itemId,
                                  reason: "preview_reloaded",
                                });
                              }
                            }
                            setLoadingWebItems((current) => {
                              if (current.has(key) === isLoading) return current;
                              const next = new Set(current);
                              if (isLoading) next.add(key);
                              else next.delete(key);
                              return next;
                            });
                          }}
                          onIpcMessage={(event) => handleReviewIpcMessage(
                            workspace.ownerChatId,
                            item,
                            event,
                          )}
                          ownerChatId={workspace.ownerChatId}
                          partition={item.descriptor.kind === "local-file"
                            ? createWorkPanelLocalFilePartition(item.descriptor.handleId)
                            : itemPartition(
                                workspace.workspaceId,
                                resolveWorkPanelWebSessionKey(state, workspace.workspaceId, item.itemId),
                              )}
                          publishPageContext={false}
                          preloadUrl={item.descriptor.kind === "local-file" && item.descriptor.reviewKind
                            ? reviewPreloadUrl
                            : webReviewPreloadEnabled
                              ? reviewPreloadUrl
                              : undefined}
                          pageReviewActive={reviewActive && reviewSession?.kind === "html"}
                          onTogglePageReview={webReviewPreloadEnabled || (
                            item.descriptor.kind === "local-file" && item.descriptor.reviewKind === "html"
                          )
                            ? (page) => toggleReviewForItem(workspace.ownerChatId, item, page)
                            : undefined}
                          registerPublicWebSurface={false}
                          showToolbar={item.descriptor.kind === "web" || (
                            item.descriptor.kind === "local-file" && item.descriptor.reviewKind === "html"
                          )}
                          showLoadingProgress
                          surfaceIdentity={createChatChildSurfaceIdentity(
                            "workpanel-web",
                            item.stableKey,
                            workspace.ownerChatId
                          )}
                          surfaceIdentityKey={item.stableKey}
                          surfaceKind="chat-work-panel"
                          surfaceLabel={item.title}
                          title={item.title}
                          toolbarDocumentName={item.descriptor.kind === "local-file"
                            ? item.descriptor.fileName
                            : undefined}
                          url={item.descriptor.kind === "local-file"
                            ? createWorkPanelLocalFileUrl(item.descriptor.handleId, item.descriptor.fileName)
                            : item.descriptor.url}
                          workPanelToolbarKind={item.descriptor.kind === "local-file" ? "document" : "web"}
                        />
                      ) : item.descriptor.kind === "local-file" ? (
                        <div className="chat-work-panel-local-file-fallback">
                          <FileTextOutlined aria-hidden="true" />
                          <strong>{item.descriptor.fileName}</strong>
                          <span>{t("chatWorkPanel.localFile.noPreview")}</span>
                          <div className="chat-work-panel-local-file-actions">
                            <Button
                              icon={<FolderOpenOutlined />}
                              onClick={() => {
                                void window.electronAPI.chatWorkPanel.localFiles.reveal({
                                  ownerChatId: workspace.ownerChatId,
                                  rendererGeneration: rendererGenerationRef.current,
                                  handleId: item.descriptor.kind === "local-file" ? item.descriptor.handleId : "",
                                });
                              }}
                            >
                              {revealLocalResourceLabel}
                            </Button>
                            <Button
                              type="primary"
                              icon={<ExportOutlined />}
                              onClick={() => {
                                void window.electronAPI.chatWorkPanel.localFiles.open({
                                  ownerChatId: workspace.ownerChatId,
                                  rendererGeneration: rendererGenerationRef.current,
                                  handleId: item.descriptor.kind === "local-file" ? item.descriptor.handleId : "",
                                });
                              }}
                            >
                              {t("chatWorkPanel.tabContextMenu.openInDefaultApp")}
                            </Button>
                          </div>
                        </div>
                      ) : null}
                      {reviewActive && reviewSession ? (
                        <WorkPanelReviewPanel
                          session={reviewSession}
                          busy={reviewHandoffBusyKeys.has(reviewRuntimeKey)}
                          error={reviewErrors[reviewRuntimeKey] || ""}
                          onExit={() => {
                            dispatchCommand({
                              type: "stopReview",
                              ownerChatId: workspace.ownerChatId,
                              itemId: item.itemId,
                            });
                            sendReviewStateToPreview(
                              workspace.ownerChatId,
                              item,
                              reviewSession,
                              false,
                            );
                          }}
                          onDiscard={() => {
                            if (!confirmDiscardReview("chatWorkPanel.review.confirmDiscardSession")) return;
                            dispatchCommand({
                              type: "discardReview",
                              ownerChatId: workspace.ownerChatId,
                              itemId: item.itemId,
                            });
                            sendReviewStateToPreview(
                              workspace.ownerChatId,
                              item,
                              null,
                              false,
                            );
                          }}
                          onHandoff={() => {
                            void handoffReview(workspace.ownerChatId, item);
                          }}
                          onRemove={(annotationId) => {
                            dispatchCommand({
                              type: "removeReviewAnnotation",
                              ownerChatId: workspace.ownerChatId,
                              itemId: item.itemId,
                              annotationId,
                            });
                          }}
                          onRequirementChange={(annotationId, requirement) => {
                            dispatchCommand({
                              type: "updateReviewAnnotation",
                              ownerChatId: workspace.ownerChatId,
                              itemId: item.itemId,
                              annotationId,
                              requirement,
                            });
                          }}
                        />
                      ) : null}
                    </div>
                  );
                })}
              </Suspense>
            </div>
          </aside>
        );
      })}
      {addMenuOwnerChatId ? createPortal(
        <div
          ref={addMenuRef}
          className="chat-work-panel-add-menu sidebar-operation-menu-popover"
          style={addMenuStyle}
          role="menu"
          aria-label={t("chatWorkPanel.add.menu")}
          onKeyDown={handleAddMenuKeyDown}
        >
          {addMenuView === "web" ? (
            <form
              className="chat-work-panel-add-web-form"
              onSubmit={(event) => {
                event.preventDefault();
                openWebFromMenu(addMenuOwnerChatId);
              }}
            >
              <button type="button" className="chat-work-panel-add-menu-back" onClick={() => setAddMenuView("root")}>
                {t("chatWorkPanel.add.back")}
              </button>
              <label htmlFor="chat-work-panel-web-url">{t("chatWorkPanel.add.webPrompt")}</label>
              <input
                id="chat-work-panel-web-url"
                autoFocus
                value={webUrlInput}
                placeholder="example.com"
                onChange={(event) => {
                  setWebUrlInput(event.target.value);
                  setWebUrlError("");
                }}
              />
              {webUrlError ? <span className="chat-work-panel-add-error">{webUrlError}</span> : null}
              <Button type="primary" htmlType="submit" disabled={!webUrlInput.trim()}>
                {t("chatWorkPanel.add.open")}
              </Button>
            </form>
          ) : addMenuView === "webapp" ? (
            <div className="chat-work-panel-add-webapp-list">
              <button type="button" className="chat-work-panel-add-menu-back" onClick={() => setAddMenuView("root")}>
                {t("chatWorkPanel.add.back")}
              </button>
              {launcher.webapps.length === 0 ? (
                <span className="chat-work-panel-add-empty">{t("chatWorkPanel.add.noWebapps")}</span>
              ) : launcher.webapps.map((webapp) => (
                <button
                  key={webapp.id}
                  type="button"
                  role="menuitem"
                  className="chat-work-panel-add-menu-item"
                  onClick={() => {
                    if (openWebappWindowIds.has(webapp.id)) launcher.onFocusWebappWindow(webapp.id);
                    else launcher.onOpenWebapp(addMenuOwnerChatId, webapp);
                    closeAddMenu();
                  }}
                >
                  <AppstoreOutlined aria-hidden="true" />
                  <span>{webapp.label}</span>
                  <small>{openWebappWindowIds.has(webapp.id) ? t("chatWorkPanel.add.webappInWindow") : t("chatWorkPanel.add.moveHere")}</small>
                </button>
              ))}
            </div>
          ) : (
            <>
              <button type="button" role="menuitem" className="chat-work-panel-add-menu-item" disabled>
                <CodeOutlined aria-hidden="true" />
                <span>{t("chatWorkPanel.add.terminal")}</span>
                <small>{t("chatWorkPanel.add.comingSoon")}</small>
              </button>
              <button type="button" role="menuitem" className="chat-work-panel-add-menu-item" onClick={() => setAddMenuView("web")}>
                <GlobalOutlined aria-hidden="true" />
                <span>{t("chatWorkPanel.add.web")}</span>
              </button>
              <button type="button" role="menuitem" className="chat-work-panel-add-menu-item" onClick={() => void openFilesFromMenu(addMenuOwnerChatId)}>
                <FolderOpenOutlined aria-hidden="true" />
                <span>{t("chatWorkPanel.add.files")}</span>
              </button>
              <button type="button" role="menuitem" className="chat-work-panel-add-menu-item" onClick={() => openSideChatFromMenu(addMenuOwnerChatId)}>
                <MessageOutlined aria-hidden="true" />
                <span>{t("chatWorkPanel.add.sideChat")}</span>
              </button>
              {launcher.agentMode === "CODER" || launcher.agentMode === "KBASE" ? (
                <button
                  type="button"
                  role="menuitem"
                  className="chat-work-panel-add-menu-item"
                  disabled={!launcher.projectEnabled}
                  title={launcher.projectDisabledReason}
                  onClick={() => openProjectFromMenu(addMenuOwnerChatId)}
                >
                  <ProjectOutlined aria-hidden="true" />
                  <span>{t("chatWorkPanel.add.project")}</span>
                  {!launcher.projectEnabled ? <small>{launcher.projectDisabledReason}</small> : null}
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                className="chat-work-panel-add-menu-item"
                disabled={launcher.webapps.length === 0}
                onClick={() => setAddMenuView("webapp")}
              >
                <AppstoreOutlined aria-hidden="true" />
                <span>{t("chatWorkPanel.add.webapp")}</span>
                <RightOutlined className="chat-work-panel-add-menu-chevron" aria-hidden="true" />
              </button>
            </>
          )}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
