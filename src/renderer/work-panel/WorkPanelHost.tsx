import type { ExternalWebviewController } from "../pages/external-webview/ExternalWebviewPage";
import { documentSourceFromWebclientDescriptor } from "../../shared/work-panel-document-source";
import { registerDesktopCloseShortcutHandler } from "../services/desktopCloseShortcutRegistry";
import {
  AppstoreOutlined,
  BugOutlined,
  CloseOutlined,
  DashboardOutlined,
  DeploymentUnitOutlined,
  DiffOutlined,
  ExportOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  MessageOutlined,
  PlusOutlined,
  PictureOutlined,
  ProjectOutlined,
  RobotOutlined,
} from "@ant-design/icons";
import { Button, Modal } from "antd";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { flushSync } from "react-dom";
import type { WorkPanelCommand, WorkPanelCommandResult, WorkPanelState } from "../../shared/work-panel";
import {
  isLocalDocumentDraftOwnerKey,
  normalizeWorkPanelWebUrl,
} from "../../shared/work-panel";
import { DESKTOP_SSO_WEBVIEW_PARTITION } from "../../shared/sso";
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
  isLoopbackWorkPanelReviewUrl,
  sanitizeWorkPanelReviewWebUrl,
  type ReviewSourceRevision,
  type WorkPanelPreviewReviewEvent,
  type WorkPanelReviewKind,
  type WorkPanelReviewSession,
} from "../../shared/work-panel-review";
import { registerDesktopActionProviderForScope } from "../services/desktopActionRegistry";
import { useI18n } from "../i18n/useI18n";
import { MAIN_CHAT_SURFACE_ID, createChatChildSurfaceIdentity } from "../../shared/surface-identity";
import {
  WORK_PANEL_HTML_FILE_CAPABILITIES,
  WORK_PANEL_WEB_CAPABILITIES,
  createWorkPanelItemSurfaceId,
  workPanelItemCapabilities,
  type WorkPanelSurfaceCapability,
} from "../../shared/work-panel-surface";
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
import { WorkPanelFullscreenControls } from "./WorkPanelFullscreenControls";
import { WorkPanelResourceImage } from "./WorkPanelResourceImage";
import { WorkPanelDocumentHtml, type HtmlAnnotation, type HtmlDocumentController } from "./WorkPanelDocumentHtml";
import { WorkPanelDocumentImageReadonly } from "./WorkPanelDocumentImageReadonly";
import { WorkPanelNewTab } from "./WorkPanelNewTab";
import { WorkPanelTab } from "./WorkPanelTab";
import { WorkPanelLocalDocument, type WorkPanelLocalDocumentData } from "./WorkPanelLocalDocument";

const ExternalWebviewPage = lazy(() =>
  import("../pages/external-webview/ExternalWebviewPage").then((module) => ({ default: module.ExternalWebviewPage })),
);
const ServiceWebviewSurface = lazy(() =>
  import("../service-webview/ServiceWebviewSurface").then((module) => ({ default: module.ServiceWebviewSurface })),
);

type WorkPanelHostProps = {
  activeChatId: string | null;
  activeOwnerKey?: string | null;
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
    agentLabel: string;
    chatLabel: string;
    projectVisible: boolean;
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

function itemRuntimeKey(ownerChatId: string, itemId: string) {
  return `${ownerChatId}\u0000${itemId}`;
}

type WorkPanelItem = WorkPanelState["workspaces"][number]["items"][number];

type WebclientDocumentState = {
  dirty: boolean;
  busy: boolean;
  annotationCount: number;
  targetKey: string;
};

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
  if (item.descriptor.kind === "native" && item.descriptor.surfaceKey === "document-html") {
    const source = item.descriptor.context.sourceKind;
    if (source === "artifact" || source === "reference") return source;
  }
  if (item.descriptor.kind === "webclient" && item.descriptor.module === "artifact") {
    return "artifact";
  }
  if (item.descriptor.kind === "webclient" && item.descriptor.module === "reference") {
    return "reference";
  }
  return "default";
}

function workPanelDocumentPath(ownerChatId: string, item: WorkPanelItem) {
  if (item.descriptor.kind === "webclient") {
    if (item.descriptor.module === "file") {
      return item.descriptor.context.path.trim();
    }
    if (item.descriptor.module === "artifact" || item.descriptor.module === "reference") {
      return item.descriptor.context.relativePath?.trim() || resolveChatWorkPanelLocalResourcePath({
        ownerChatId,
        profile: item.descriptor.module,
        route: item.descriptor.route,
      });
    }
  }
  if (item.descriptor.kind === "local-file") {
    return item.descriptor.workspaceRelativePath?.trim() || "";
  }
  if (item.descriptor.kind === "native") {
    if (item.descriptor.surfaceKey === "document-html") return String(item.descriptor.context.displayUrl || "");
    const relativePath = item.descriptor.context.relativePath;
    return typeof relativePath === "string" ? relativePath.trim() : "";
  }
  return "";
}

function WorkPanelItemIcon({ item }: { item: WorkPanelItem }) {
  if (item.descriptor.kind === "web") return <GlobalOutlined />;
  if (item.descriptor.kind === "webapp-ref") return <AppstoreOutlined />;
  if (item.descriptor.kind === "local-file") return <FileTextOutlined />;
  if (item.descriptor.kind === "native") return item.descriptor.surfaceKey === "local-document" ? <FileTextOutlined /> : <PictureOutlined />;
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

/** Network pages stay renderable while hidden; previews and observers do not. */
function isWorkPanelBackgroundWebItem(item: WorkPanelItem) {
  return item.descriptor.kind === "web" && Boolean(normalizeWorkPanelWebUrl(item.descriptor.url));
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
  webPage?: { url?: string; title?: string; liveProjectWeb?: boolean },
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
        ...(webPage?.liveProjectWeb ? { liveProjectWeb: true as const } : {}),
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
  activeOwnerKey = activeChatId,
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
  const [modal, modalContext] = Modal.useModal();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastVisiblePanelSizes = useRef(new Map<string, { width: number; height: number }>());
  const stateRef = useRef(state);
  const previousLocalFileHandlesRef = useRef(new Map<string, string>());
  const previousResourceImageHandlesRef = useRef(new Map<string, string>());
  const previousDocumentHtmlHandlesRef = useRef(new Map<string, string>());
  const previousSystemDocumentIdsRef = useRef(new Set<string>());
  const rendererGenerationRef = useRef(globalThis.crypto.randomUUID());
  const [loadingWebItems, setLoadingWebItems] = useState<Set<string>>(() => new Set());
  // Launchers are renderer-only tabs: they never create a guest or acquire Run permissions.
  const [newTabs, setNewTabs] = useState<Array<{ id: string; ownerChatId: string; urlDraft: string }>>([]);
  const [selectedNewTabs, setSelectedNewTabs] = useState<Record<string, { id: string; anchor: string | null }>>({});
  const selectedNewTabsRef = useRef(selectedNewTabs);
  selectedNewTabsRef.current = selectedNewTabs;
  const [openWebappWindowIds, setOpenWebappWindowIds] = useState<Set<string>>(() => new Set());
  const [reviewPreloadUrl, setReviewPreloadUrl] = useState("");
  const webControllers = useRef(new Map<string, ExternalWebviewController>());
  const webDialogTransfers = useRef(new Set<string>());
  const failedWebDialogTransfers = useRef(new Set<string>());
  const nativeHtmlControllers = useRef(new Map<string, HtmlDocumentController>());
  const htmlFileControllers = useRef(new Map<string, ExternalWebviewController>());
  const [resourceReviewCapabilities, setResourceReviewCapabilities] = useState<Record<string, ResourceReviewCapability>>({});
  const [reviewPreviewMetadata, setReviewPreviewMetadata] = useState<Record<string, ReviewPreviewMetadata>>({});
  const [reviewHandoffBusyKeys, setReviewHandoffBusyKeys] = useState<Set<string>>(() => new Set());
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({});
  const [activeImageEditorItemIds, setActiveImageEditorItemIds] = useState<Record<string, string>>({});
  const [webclientDocumentStates, setWebclientDocumentStates] = useState<Record<string, WebclientDocumentState>>({});
  const pendingReviewRequestsRef = useRef(new Map<string, PendingReviewRequest>());
  stateRef.current = state;

  let revealLocalResourceLabel = t("chatWorkPanel.tabContextMenu.revealInFileManager");
  if (isMac) {
    revealLocalResourceLabel = t("chatWorkPanel.tabContextMenu.revealInFinder");
  } else if (isWindows) {
    revealLocalResourceLabel = t("chatWorkPanel.tabContextMenu.revealInExplorer");
  }

  const closeNewTabSelection = (ownerChatId: string) => {
    setSelectedNewTabs(current => {
      const next = { ...current };
      delete next[ownerChatId];
      return next;
    });
  };

  const closeNewTab = (ownerChatId: string, id: string) => {
    setNewTabs(current => current.filter(tab => tab.id !== id));
    if (selectedNewTabsRef.current[ownerChatId]?.id === id) closeNewTabSelection(ownerChatId);
  };

  const openNewTab = (ownerChatId: string) => {
    const id = globalThis.crypto.randomUUID();
    const anchor = stateRef.current.workspaces.find(workspace => workspace.ownerChatId === ownerChatId)?.activeItemId ?? null;
    setNewTabs(current => [...current, { id, ownerChatId, urlDraft: "" }]);
    setSelectedNewTabs(current => ({ ...current, [ownerChatId]: { id, anchor } }));
    void window.electronAPI.webs.webapps.listOpenWindows()
      .then(ids => setOpenWebappWindowIds(new Set(ids)))
      .catch(() => setOpenWebappWindowIds(new Set()));
  };

  const openWebFromNewTab = (ownerChatId: string, url: string) => {
    const selected = selectedNewTabsRef.current[ownerChatId];
    const result = dispatchCommand({ type: "openItem", ownerChatId, descriptor: { kind: "web", url },
      webInstanceId: selected?.id ?? globalThis.crypto.randomUUID() });
    if (result.ok && selected) closeNewTab(ownerChatId, selected.id);
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
    closeNewTabSelection(ownerChatId);
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
    closeNewTabSelection(ownerChatId);
  };

  const openFilesFromMenu = async (ownerChatId: string) => {
    const originalFiles = stateRef.current.workspaces.find(workspace => workspace.ownerChatId === ownerChatId)?.items
      .some(item => item.descriptor.kind === "native" && item.descriptor.surfaceKey === "local-document");
    if (isLocalDocumentDraftOwnerKey(ownerChatId) || originalFiles) {
      // Main reads the trusted current nonce/Chat; a UI draft key is never an API Chat ID.
      await window.electronAPI.localDocuments.select();
      closeNewTabSelection(ownerChatId);
      return;
    }
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
    closeNewTabSelection(ownerChatId);
  };

  const closeWorkPanelStep = (ownerChatId: string) => {
    const workspace = stateRef.current.workspaces.find((item) => item.ownerChatId === ownerChatId);
    if (!workspace) return false;
    const selected = selectedNewTabsRef.current[ownerChatId];
    if (selected && selected.anchor === workspace.activeItemId) {
      closeNewTab(ownerChatId, selected.id);
      return true;
    }
    const activeItem = workspace?.items.find((item) => item.itemId === workspace.activeItemId);
    const closableItems = workspace.items.filter((item) => item.closable && !item.pinned);
    const itemToClose = activeItem?.closable && !activeItem.pinned
      ? activeItem
      : closableItems[closableItems.length - 1];
    if (itemToClose) {
      return closeItemWithReviewProtection(ownerChatId, itemToClose.itemId, true);
    }
    const result = dispatchCommand({
      type: "closeWorkspace",
      ownerChatId,
      force: true,
    });
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

  const closeItemWithReviewProtection = (ownerChatId: string, itemId: string, closeImplicitWorkspace = false) => {
    const nativeImageBusy = rootRef.current?.querySelector<HTMLElement>(
      `[data-work-panel-owner="${CSS.escape(ownerChatId)}"][data-work-panel-item="${CSS.escape(itemId)}"] [data-native-image-saving="true"], ` +
      `[data-work-panel-owner="${CSS.escape(ownerChatId)}"][data-work-panel-item="${CSS.escape(itemId)}"] [data-native-image-ai-busy="true"], ` +
      `[data-work-panel-owner="${CSS.escape(ownerChatId)}"][data-work-panel-item="${CSS.escape(itemId)}"] [data-work-panel-document-busy="true"], ` +
      `[data-work-panel-owner="${CSS.escape(ownerChatId)}"][data-work-panel-item="${CSS.escape(itemId)}"][data-webclient-document-busy="true"]`,
    );
    if (nativeImageBusy) return false;
    const dirtyNativeImage = rootRef.current?.querySelector<HTMLElement>(
      `[data-work-panel-owner="${CSS.escape(ownerChatId)}"][data-work-panel-item="${CSS.escape(itemId)}"] [data-native-image-dirty="true"], ` +
      `[data-work-panel-owner="${CSS.escape(ownerChatId)}"][data-work-panel-item="${CSS.escape(itemId)}"] [data-work-panel-document-dirty="true"], ` +
      `[data-work-panel-owner="${CSS.escape(ownerChatId)}"][data-work-panel-item="${CSS.escape(itemId)}"][data-webclient-document-dirty="true"]`,
    );
    if (dirtyNativeImage && !window.confirm(t("chatWorkPanel.image.confirmDiscardDraft"))) return false;
    const session = getWorkPanelReviewSession(stateRef.current.review, ownerChatId, itemId);
    const force = hasWorkPanelReviewDraft(session)
      ? confirmDiscardReview("chatWorkPanel.review.confirmDiscard")
      : false;
    if (hasWorkPanelReviewDraft(session) && !force) return false;
    return dispatchCommand({
      type: "closeItem", ownerChatId, itemId,
      ...(force ? { force: true } : {}),
      ...(closeImplicitWorkspace ? { closeImplicitWorkspace: true } : {}),
    }).ok;
  };

  useEffect(() => window.electronAPI.chatWorkPanelTabContextMenu.onWebDialogCloseRequested((transferId) => {
    const dialog = stateRef.current.dialogItems?.find((entry) => entry.transferId === transferId);
    if (dialog) closeItemWithReviewProtection(dialog.ownerChatId, dialog.itemId);
  }), [dispatchCommand, t]);

  const closeOtherItemsWithReviewProtection = (ownerChatId: string, itemId: string) => {
    const workspace = stateRef.current.workspaces.find((candidate) => candidate.ownerChatId === ownerChatId);
    const removedIds = workspace?.items
      .filter((candidate) => candidate.itemId !== itemId && candidate.closable && !candidate.pinned)
      .map((candidate) => candidate.itemId) ?? [];
    const hasDrafts = removedIds.some((removedId) =>
      hasWorkPanelReviewDraft(getWorkPanelReviewSession(stateRef.current.review, ownerChatId, removedId)),
    );
    const hasNativeDrafts = removedIds.some((removedId) => rootRef.current?.querySelector(
      `[data-work-panel-owner="${CSS.escape(ownerChatId)}"][data-work-panel-item="${CSS.escape(removedId)}"] [data-native-image-dirty="true"], ` +
      `[data-work-panel-owner="${CSS.escape(ownerChatId)}"][data-work-panel-item="${CSS.escape(removedId)}"] [data-work-panel-document-dirty="true"], ` +
      `[data-work-panel-owner="${CSS.escape(ownerChatId)}"][data-work-panel-item="${CSS.escape(removedId)}"][data-webclient-document-dirty="true"]`,
    ));
    const hasBusyNativeImages = removedIds.some((removedId) => rootRef.current?.querySelector(
      `[data-work-panel-owner="${CSS.escape(ownerChatId)}"][data-work-panel-item="${CSS.escape(removedId)}"] [data-native-image-saving="true"], ` +
      `[data-work-panel-owner="${CSS.escape(ownerChatId)}"][data-work-panel-item="${CSS.escape(removedId)}"] [data-native-image-ai-busy="true"], ` +
      `[data-work-panel-owner="${CSS.escape(ownerChatId)}"][data-work-panel-item="${CSS.escape(removedId)}"] [data-work-panel-document-busy="true"], ` +
      `[data-work-panel-owner="${CSS.escape(ownerChatId)}"][data-work-panel-item="${CSS.escape(removedId)}"][data-webclient-document-busy="true"]`,
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
            liveProjectWeb: ownerChatId === activeChatId &&
              launcher.agentMode.trim().toUpperCase() === "CODER" &&
              launcher.projectEnabled &&
              isLoopbackWorkPanelReviewUrl(webPage?.url || readWebviewUrl(findItemWebview(ownerChatId, item.itemId))),
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

  const insertDocumentComposerDraft = async (ownerChatId: string, text: string) => {
    const mainChatWebview = getServiceSurfaceWebview(MAIN_CHAT_SURFACE_ID);
    const normalizedText = text.trim().slice(0, 50_000);
    if (!mainChatWebview || !normalizedText) return false;
    const requestId = globalThis.crypto.randomUUID();
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
        if (payload?.event === "composer-draft-result" && payload.requestId === requestId) {
          finish(payload.ok);
        }
      };
      const timer = window.setTimeout(() => finish(false), 8_000);
      mainChatWebview.addEventListener("ipc-message", handleMessage as EventListener);
    });
    try {
      mainChatWebview.send(SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL, {
        action: AGENT_WEBCLIENT_COMPOSER_DRAFT_ACTION,
        version: AGENT_WEBCLIENT_COMPOSER_DRAFT_VERSION,
        requestId,
        ownerChatId,
        text: normalizedText,
      });
      return await result;
    } catch {
      return false;
    }
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
      // Resource Viewer routes sync by review kind, so keep the completed session's
      // kind while explicitly disabling review and removing every annotation.
      sendReviewStateToPreview(
        ownerChatId,
        item,
        { ...session, annotations: [] },
        false,
      );
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
      (item.descriptor.surfaceKey !== "resource-image" && item.descriptor.surfaceKey !== "document-image") ||
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
        sourceKind: context.profile === "reference"
          ? "reference"
          : context.profile === "workspace-file"
            ? "workspace-file"
            : "artifact",
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

  const handoffNativeHtmlReview = async (
    ownerChatId: string,
    item: WorkPanelItem,
    annotations: HtmlAnnotation[],
  ) => {
    if (
      item.descriptor.kind !== "native" ||
      item.descriptor.surfaceKey !== "document-html" ||
      annotations.length === 0
    ) return false;
    const context = item.descriptor.context;
    const now = Date.now();
    const session: WorkPanelReviewSession = {
      version: WORK_PANEL_REVIEW_VERSION,
      ownerChatId,
      itemId: item.itemId,
      kind: "html",
      source: {
        sourceKind: context.sourceKind as "workspace-file" | "artifact" | "reference",
        fileName: String(context.fileName || item.title),
        revision: String(context.revision || ""),
      },
      annotations: annotations.map((annotation, index) => ({
        id: annotation.id,
        number: index + 1,
        kind: "html-element" as const,
        fullXPath: annotation.xpath,
        cssSelector: annotation.selector,
        tagName: annotation.selector.replace(/^[#.]/u, "").split(/[\s:#.[\]]/u, 1)[0] || "element",
        attributes: {},
        textExcerpt: annotation.text,
        rect: annotation.rect,
        requirement: annotation.note.trim() || `Review ${annotation.selector}: ${annotation.text || "selected element"}`,
      })),
      createdAt: now,
      updatedAt: now,
    };
    return insertReviewComposerDraft(
      ownerChatId,
      session,
      buildWorkPanelReviewComposerDraft(session),
      null,
    );
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
    const documentPath = workPanelDocumentPath(ownerChatId, item);
    const nativeHtml = item.descriptor.kind === "native" && item.descriptor.surfaceKey === "document-html" ? item.descriptor.context : null;
    const nativeImage = item.descriptor.kind === "native" &&
      (item.descriptor.surfaceKey === "resource-image" || item.descriptor.surfaceKey === "document-image")
      ? item.descriptor.context : null;
    const htmlController = nativeHtmlControllers.current.get(itemRuntimeKey(ownerChatId, item.itemId));
    const result = await window.electronAPI.chatWorkPanelTabContextMenu.popup({
      mode: "work-panel",
      x: event.clientX,
      y: event.clientY,
      profile: tabContextMenuProfile(item),
      isFullscreen: fullscreenOwnerChatId === ownerChatId,
      reviewMode: htmlController ? (htmlController.isAnnotating() ? "active" : "inactive") : reviewSource ? (reviewActive ? "active" : "inactive") : "unavailable",
      ...(nativeImage ? { nativeImage: { localOriginal: nativeImage.localOriginal === true } } : {}),
      ...(nativeHtml ? { nativeHtml: { localOriginal: nativeHtml.localOriginal === true } } : {}),
      ...(documentPath ? { documentPathAvailable: true } : {}),
      canClose: item.closable && !item.pinned,
      canCloseOthers: workspace?.items.some((candidate) =>
        candidate.itemId !== item.itemId && candidate.closable && !candidate.pinned,
      ) ?? false,
    });
    const currentItem = stateRef.current.workspaces.find((candidate) => candidate.ownerChatId === ownerChatId)?.items.find((candidate) => candidate.itemId === item.itemId && candidate.stableKey === item.stableKey);
    if (!currentItem) return;
    if (nativeImage) {
      if (currentItem.descriptor.kind !== "native" || currentItem.descriptor.context.handleId !== nativeImage.handleId) return;
      if (result.actionId === "reveal-resource" || result.actionId === "open-resource-default-app") {
        const request = { ownerChatId, rendererGeneration: rendererGenerationRef.current, handleId: String(nativeImage.handleId) };
        try {
          const outcome = result.actionId === "reveal-resource"
            ? await window.electronAPI.chatWorkPanel.resourceImages.reveal(request)
            : await window.electronAPI.chatWorkPanel.resourceImages.openExternal({ ...request, mode: "default" });
          if (!outcome.ok && outcome.message) modal.error({ content: outcome.message });
        } catch { modal.error({ content: t("chatWorkPanel.resourceActions.failed") }); }
        return;
      }
      if (result.actionId === "copy-title") { await window.electronAPI.clipboard.writeText(String(nativeImage.fileName)); return; }
    }
    if (nativeHtml) {
      if (currentItem.descriptor.kind !== "native" || currentItem.descriptor.surfaceKey !== "document-html" || currentItem.descriptor.context.handleId !== nativeHtml.handleId) return;
      const currentController = nativeHtmlControllers.current.get(itemRuntimeKey(ownerChatId, item.itemId));
      const actions = { "reveal-resource": "reveal", "open-resource-default-app": "open-default", "open-resource-browser": "open-browser", "download-resource": "save-copy" } as const;
      const action = actions[result.actionId as keyof typeof actions];
      if (action) {
        try {
          const outcome = await window.electronAPI.chatWorkPanel.documentHtml.fileAction({
            ownerChatId, rendererGeneration: rendererGenerationRef.current,
            handleId: String(nativeHtml.handleId), action,
          });
          if (!outcome.ok) modal.error({ content: outcome.message || t("chatWorkPanel.resourceActions.failed") });
        } catch { modal.error({ content: t("chatWorkPanel.resourceActions.failed") }); }
        return;
      }
      if (result.actionId === "reload") { currentController?.reload(); return; }
      if (result.actionId === "toggle-review") { currentController?.toggleReview(); return; }
      if (result.actionId === "copy-title") { await window.electronAPI.clipboard.writeText(String(nativeHtml.fileName)); return; }
    }
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
    if (result.actionId === "open-web-dialog" && currentItem.descriptor.kind === "web") {
      failedWebDialogTransfers.current.clear();
      await moveWebToDialog(ownerChatId, currentItem);
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
    if (result.actionId === "copy-path" && documentPath) {
      await window.electronAPI.clipboard.writeText(documentPath);
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
    const nextDocumentIds = new Set<string>();
    for (const workspace of state.workspaces) {
      for (const item of workspace.items) {
        if (item.descriptor.kind === "native" && item.descriptor.surfaceKey === "local-document") {
          const documentId = String(item.descriptor.context.documentId || "");
          if (documentId) nextDocumentIds.add(documentId);
        }
      }
    }
    for (const documentId of previousSystemDocumentIdsRef.current) {
      if (nextDocumentIds.has(documentId)) continue;
      void window.electronAPI.localDocuments.close(documentId).catch(() => undefined);
    }
    previousSystemDocumentIdsRef.current = nextDocumentIds;
    // Hiding a Chat or remounting this host does not revoke a system-opened file.
    // Main owns renderer/window teardown; only removed WorkPanel items release here.
  }, [state.workspaces]);

  useEffect(() => {
    const nextHandles = new Map<string, string>();
    for (const workspace of state.workspaces) {
      for (const item of workspace.items) {
        if (
          item.descriptor.kind === "native" &&
          (item.descriptor.surfaceKey === "resource-image" || item.descriptor.surfaceKey === "document-image")
        ) {
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
    const nextHandles = new Map<string, string>();
    for (const workspace of state.workspaces) {
      for (const item of workspace.items) {
        if (item.descriptor.kind === "native" && item.descriptor.surfaceKey === "document-html") {
          const handleId = String(item.descriptor.context.handleId || "");
          if (handleId) nextHandles.set(handleId, workspace.ownerChatId);
        }
      }
    }
    for (const [handleId, ownerChatId] of previousDocumentHtmlHandlesRef.current) {
      if (nextHandles.has(handleId)) continue;
      void window.electronAPI.chatWorkPanel.documentHtml.release({
        ownerChatId,
        rendererGeneration: rendererGenerationRef.current,
        handleIds: [handleId],
      }).catch(() => undefined);
    }
    previousDocumentHtmlHandlesRef.current = nextHandles;
  }, [state.workspaces]);

  useEffect(() => () => {
    for (const [handleId, ownerChatId] of previousDocumentHtmlHandlesRef.current) {
      void window.electronAPI.chatWorkPanel.documentHtml.release({
        ownerChatId,
        rendererGeneration: rendererGenerationRef.current,
        handleIds: [handleId],
      }).catch(() => undefined);
    }
  }, []);

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
    const owners = new Set(state.workspaces.map(workspace => workspace.ownerChatId));
    setNewTabs(current => current.every(tab => owners.has(tab.ownerChatId))
      ? current : current.filter(tab => owners.has(tab.ownerChatId)));
    setSelectedNewTabs(current => {
      const entries = Object.entries(current).filter(([owner, selection]) =>
        state.workspaces.some(workspace => workspace.ownerChatId === owner && workspace.activeItemId === selection.anchor));
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
  }, [state.workspaces]);

  async function moveWebToDialog(ownerChatId: string, item: WorkPanelItem) {
    if (item.descriptor.kind !== "web") return;
    const transferKey = itemRuntimeKey(ownerChatId, item.itemId);
    if (webDialogTransfers.current.has(transferKey) || failedWebDialogTransfers.current.has(transferKey)) return;
    if (stateRef.current.dialogItems?.some((entry) => entry.ownerChatId === ownerChatId && entry.itemId === item.itemId)) return;
    const anchor = stateRef.current.dialogItems?.find((entry) => entry.ownerChatId === ownerChatId);
    const guest = findItemWebview(ownerChatId, item.itemId);
    const sourceGuestId = guest ? readWebviewGuestId(guest) : null;
    if (!anchor && !sourceGuestId) return;
    webDialogTransfers.current.add(transferKey);
    let transferId: string | undefined;
    let transferPhase = "prepare";
    try {
      const prepared = await window.electronAPI.chatWorkPanelTabContextMenu.webDialog(anchor
        ? { action: "prepareSibling", transferId: anchor.transferId, itemId: item.itemId, stableKey: item.stableKey,
            url: stateRef.current.webItemUrls?.[transferKey] || item.descriptor.url, title: item.title,
            ...(sourceGuestId ? { sourceGuestId } : {}) }
        : { action: "prepare", sourceGuestId: sourceGuestId!, agentLabel: launcher.agentLabel || launcher.agentKey,
            chatLabel: launcher.chatLabel || ownerChatId });
      transferId = prepared.transferId;
      if (!prepared.ok || !transferId || !prepared.surfaceId || prepared.ownerChatId !== ownerChatId) throw new Error("prepare_failed");
      transferPhase = "presentation";
      let moved = false;
      flushSync(() => {
        moved = dispatchCommand({ type: "setDialogPresentation", ownerChatId, itemId: item.itemId,
          dialog: { ownerChatId, itemId: item.itemId, surfaceId: prepared.surfaceId!, transferId: transferId! },
        }).ok;
      });
      if (!moved) throw new Error("item_unavailable");
      transferPhase = "open";
      const opened = await window.electronAPI.chatWorkPanelTabContextMenu.webDialog({ action: "open", transferId });
      if (!opened.ok) throw new Error("open_failed");
      dispatchCommand({ type: "stopReview", ownerChatId, itemId: item.itemId });
      dispatchCommand({ type: "markReviewInvalid", ownerChatId, itemId: item.itemId, reason: "preview_reloaded" });
    } catch {
      console.warn("[work-panel-web-dialog] transfer failed", { phase: transferPhase, itemId: item.itemId, sourceGuestId });
      failedWebDialogTransfers.current.add(transferKey);
      if (transferId) {
        await window.electronAPI.chatWorkPanelTabContextMenu.webDialog({ action: "close", transferId }).catch(() => undefined);
        dispatchCommand({ type: "setDialogPresentation", ownerChatId, itemId: item.itemId, dialog: null });
      }
      modal.error({ content: t("chatWorkPanel.resourceActions.failed") });
    } finally { webDialogTransfers.current.delete(transferKey); }
  }

  // A dialog is a presentation of the Chat's complete web workspace. Newly
  // opened items use the existing Main reservation even when another Chat is active.
  useEffect(() => {
    for (const workspace of state.workspaces) {
      if (!state.dialogItems?.some((entry) => entry.ownerChatId === workspace.ownerChatId)) continue;
      for (const item of workspace.items) {
        if (item.descriptor.kind === "web") void moveWebToDialog(workspace.ownerChatId, item);
      }
    }
  }, [state]);

  useEffect(() => window.electronAPI.chatWorkPanelTabContextMenu.onWebDialogOpenRequested(({ transferId, url }) => {
    const source = stateRef.current.dialogItems?.find((entry) => entry.transferId === transferId);
    const normalized = normalizeWorkPanelWebUrl(url);
    if (source && normalized) dispatchCommand({ type: "openItem", ownerChatId: source.ownerChatId, descriptor: { kind: "web", url: normalized } });
  }), [dispatchCommand]);

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
    if (!ownerChatId || ownerChatId.startsWith("file-draft:")) return actionError("source_chat_required", "A trusted canonical source.chatId is required.");
    const ownerAgentKey = request.source?.agentKey?.trim() || "";
    const args = request.args ?? {};
    const forbidden = [
      "chatId", "ownerChatId", "agentKey", "runId", "workspaceId", "stableKey", "preload", "webPreferences",
    ].filter((key) => key in args);
    if (forbidden.length > 0) return actionError("invalid_request", `WorkPanel does not accept: ${forbidden.join(", ")}.`);
    const current = () => stateRef.current.workspaces.find((workspace) => workspace.ownerChatId === ownerChatId) ?? null;
    // Every tab has one surfaceId for Agent tools. Webpages and HTML file
    // previews use their live page surfaceId; other tabs only have an item
    // identity that can be activated or closed. Main enforces page capabilities.
    const describeItemSurface = async (ownerChatId: string, item: WorkPanelItem, waitMs: number): Promise<{
      surfaceId: string | null;
      capabilities: WorkPanelSurfaceCapability[];
    }> => {
      const key = itemRuntimeKey(ownerChatId, item.itemId);
      const descriptor = item.descriptor;
      const htmlFile = (descriptor.kind === "local-file" && descriptor.previewKind === "html") ||
        (descriptor.kind === "native" && descriptor.surfaceKey === "document-html");
      if (descriptor.kind !== "web" && !htmlFile) {
        return { surfaceId: createWorkPanelItemSurfaceId(item.itemId), capabilities: workPanelItemCapabilities(item.closable) };
      }
      const readPageSurfaceId = async () => {
        if (descriptor.kind === "native") return nativeHtmlControllers.current.get(key)?.readSurfaceId() ?? null;
        const controller = (descriptor.kind === "web" ? webControllers : htmlFileControllers).current.get(key);
        const page = controller ? await controller.getState().catch(() => null) : null;
        return page?.tabs.find((tab) => tab.tabId === page.activeTabId)?.surfaceId ?? null;
      };
      const deadline = Date.now() + waitMs;
      let surfaceId = await readPageSurfaceId().catch(() => null);
      while (!surfaceId && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 100));
        surfaceId = await readPageSurfaceId().catch(() => null);
      }
      const capabilities = descriptor.kind === "web" ? WORK_PANEL_WEB_CAPABILITIES : WORK_PANEL_HTML_FILE_CAPABILITIES;
      return { surfaceId, capabilities: item.closable ? [...capabilities] : capabilities.filter((name) => name !== "close") };
    };
    const withItemSurfaces = async <T,>(response: T, waitForItemId = ""): Promise<T> => {
      const record = response as { ok?: boolean; result?: { item?: WorkPanelItem; state?: { ownerChatId: string; items: WorkPanelItem[] } } };
      const state = record?.ok ? record.result?.state : undefined;
      if (!state || !Array.isArray(state.items) || state.items.length === 0) return response;
      const items = await Promise.all(state.items.map(async (item) => ({
        ...item,
        ...await describeItemSurface(state.ownerChatId, item, item.itemId === waitForItemId ? 8_000 : 0),
      })));
      const item = record.result?.item && items.find((candidate) => candidate.itemId === record.result!.item!.itemId);
      return { ...record, result: { ...record.result, state: { ...state, items }, ...(item ? { item } : {}) } } as T;
    };
    const execute = (command: WorkPanelCommand) => {
      const result = dispatchCommand(command);
      // Dispatch has committed; React props may still contain the previous state.
      // Immediate action checks must read the committed state, not wait for render.
      stateRef.current = result.nextState;
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
        return withItemSurfaces({ ok: true, result: { ok: true, workspaceId: workspace?.workspaceId || "", state: workspace ?? undefined } });
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
        const surfaceKey = args.surfaceKey === "document-image" ? "document-image" : "resource-image";
        const opened = execute({
          type: "openItem",
          ownerChatId,
          descriptor: {
            kind: "native",
            surfaceKey,
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
      case "desktop.workpanel.openDocumentHtml": {
        const claimId = typeof args.claimId === "string" ? args.claimId.trim() : "";
        if (!claimId) return actionError("target_unavailable", "Native HTML claim is unavailable.");
        const bootstrapFailure = ensureTrustedWorkspace();
        if (bootstrapFailure) return bootstrapFailure;
        const claimed = await window.electronAPI.chatWorkPanel.documentHtml.claim({
          ownerChatId,
          rendererGeneration: rendererGenerationRef.current,
          claimId,
        });
        if (!claimed.ok || !claimed.document) {
          return actionError("target_unavailable", claimed.message || "Native HTML claim is unavailable.");
        }
        const document = claimed.document;
        const opened = execute({
          type: "openItem",
          ownerChatId,
          descriptor: {
            kind: "native",
            surfaceKey: "document-html",
            context: { ...document },
            title: typeof args.title === "string" && args.title.trim()
              ? args.title.trim()
              : document.fileName,
          },
        });
        if (!opened.ok && !claimed.reused) {
          await window.electronAPI.chatWorkPanel.documentHtml.release({
            ownerChatId,
            rendererGeneration: rendererGenerationRef.current,
            handleIds: [document.handleId],
          }).catch(() => undefined);
        }
        return opened;
      }
      case "desktop.workpanel.openWeb": {
        const url = normalizeWorkPanelWebUrl(args.url);
        if (!url) return actionError("invalid_url", "url must use http: or https: without credentials.");
        const bootstrapFailure = ensureTrustedWorkspace();
        if (bootstrapFailure) return bootstrapFailure;
        const opened = execute({ type: "openItem", ownerChatId, descriptor: { kind: "web", url } });
        if (!opened.ok) return opened;
        const itemId = opened.result.item?.itemId;
        const deadline = Date.now() + 8_000;
        while (itemId && Date.now() < deadline) {
          const item = current()?.items.find((candidate) => candidate.itemId === itemId);
          if (!item) return actionError("surface_not_found", "The opened page was closed.");
          const controller = webControllers.current.get(itemRuntimeKey(ownerChatId, itemId));
          if (controller) {
            const state = await controller.getState();
            const page = state.tabs.find((tab) => tab.tabId === state.activeTabId);
            if (page) {
              const described = await withItemSurfaces(opened);
              return { ok: true, result: { ...described.result, containerId: state.containerId, surfaceId: page.surfaceId, status: page.isLoading ? "loading" : "ready" } };
            }
          }
          await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
        return actionError("surface_not_ready", "The page opened but has not registered yet. Use Surface.list to rediscover it; do not open another page.");
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
        return withItemSurfaces(opened, file.previewKind === "html" ? opened.result.item?.itemId : "");
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
        const dialog = stateRef.current.dialogItems?.find((entry) => entry.ownerChatId === ownerChatId && entry.itemId === item.itemId);
        if (dialog) {
          const refreshed = await window.electronAPI.chatWorkPanelTabContextMenu.webDialog({ action: "reload", transferId: dialog.transferId });
          return refreshed.ok ? execute({ type: "activateItem", ownerChatId, itemId: item.itemId })
            : actionError("target_unavailable", "WorkPanel dialog is unavailable.");
        }
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

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const disposeFullscreenExitShortcut = window.electronAPI.onWorkPanelFullscreenExitShortcut(() => {
      if (fullscreenOwnerChatId === activeOwnerKey) {
        void onFullscreenChange(null);
      }
    });
    const disposeGuestShortcut = registerDesktopCloseShortcutHandler(({
      guestId,
      website,
    }) => {
      if (website) return false;
      if (guestId === null) {
        if (activeOwnerKey) {
          closeWorkPanelStep(activeOwnerKey);
          return true;
        }
        return false;
      }
      if (!Number.isSafeInteger(guestId) || guestId <= 0) return false;
      const webviews = Array.from(document.querySelectorAll("webview")) as Electron.WebviewTag[];
      const matchingWebview = webviews.find((webview) => readWebviewGuestId(webview) === guestId);
      const itemHost = matchingWebview?.closest<HTMLElement>("[data-work-panel-item]");
      const ownerChatId = itemHost?.dataset.workPanelOwner || "";
      const itemId = itemHost?.dataset.workPanelItem || "";
      const workspace = stateRef.current.workspaces.find((item) => item.ownerChatId === ownerChatId);
      if (!workspace || workspace.ownerChatId !== activeOwnerKey || workspace.activeItemId !== itemId) return false;
      closeWorkPanelStep(ownerChatId);
      return true;
    });
    return () => {
      disposeFullscreenExitShortcut();
      disposeGuestShortcut();
    };
  }, [activeOwnerKey, dispatchCommand, fullscreenOwnerChatId, onFullscreenChange]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const visiblePanel = activeOwnerKey
      ? root.querySelector<HTMLElement>(`[data-work-panel-chat="${CSS.escape(activeOwnerKey)}"]`)
      : null;
    const activeItemId = activeOwnerKey
      ? state.workspaces.find((workspace) => workspace.ownerChatId === activeOwnerKey)?.activeItemId ?? null
      : null;
    const isActiveItemHost = (element: HTMLElement | null) => Boolean(
      element &&
      activeOwnerKey &&
      activeItemId &&
      element.dataset.workPanelOwner === activeOwnerKey &&
      element.dataset.workPanelItem === activeItemId,
    );
    const activeElement = document.activeElement as HTMLElement | null;
    const focusedItem = activeElement?.closest<HTMLElement>(
      "[data-work-panel-item][data-work-panel-owner]",
    ) ?? null;
    if (
      activeElement &&
      ((root.contains(activeElement) && !visiblePanel) ||
        (focusedItem && !isActiveItemHost(focusedItem)))
    ) {
      activeElement.blur();
    }

    if (isWindows) {
      const webviews = Array.from(document.querySelectorAll(
        "[data-work-panel-item][data-work-panel-owner] webview",
      )) as Electron.WebviewTag[];
      for (const webview of webviews) {
        const itemHost = webview.closest<HTMLElement>(
          "[data-work-panel-item][data-work-panel-owner]",
        );
        if (!isActiveItemHost(itemHost)) {
          webview.blur();
        }
      }
    } else if (isMac && focusedItem && !isActiveItemHost(focusedItem)) {
      (focusedItem.querySelector("webview") as Electron.WebviewTag | null)?.blur();
    }
  }, [activeOwnerKey, isMac, isWindows, state.workspaces]);

  // Remember the box each workspace had while shown. A hidden workspace keeps
  // that viewport for its web pages instead of following the foreground
  // panel's width; fullscreen is a transient presentation and is not recorded.
  const workPanelFullscreen = Boolean(activeOwnerKey && fullscreenOwnerChatId === activeOwnerKey);
  useEffect(() => {
    const visiblePanel = rootRef.current?.querySelector<HTMLElement>(".chat-work-panel.is-visible");
    const ownerChatId = visiblePanel?.dataset.workPanelChat;
    if (!visiblePanel || !ownerChatId || workPanelFullscreen || typeof ResizeObserver === "undefined") return;
    const record = () => {
      const { width, height } = visiblePanel.getBoundingClientRect();
      if (!visiblePanel.hidden && width > 0 && height > 0) {
        lastVisiblePanelSizes.current.set(ownerChatId, { width, height });
      }
    };
    record();
    const observer = new ResizeObserver(record);
    observer.observe(visiblePanel);
    return () => observer.disconnect();
  }, [activeOwnerKey, state.workspaces, workPanelFullscreen]);

  useEffect(() => () => {
    const root = rootRef.current;
    if (!root) return;
    const activeElement = document.activeElement as HTMLElement | null;
    if (isMac) {
      if (activeElement && root.contains(activeElement)) activeElement.blur();
    } else if (isWindows) {
      const webviews = Array.from(root.querySelectorAll("webview")) as Electron.WebviewTag[];
      for (const webview of webviews) webview.blur();
    } else if (activeElement && root.contains(activeElement)) {
      activeElement.blur();
    }
  }, [isMac, isWindows]);

  return (
    <div
      ref={rootRef}
      className={`work-panel-host${activeOwnerKey && fullscreenOwnerChatId === activeOwnerKey ? " is-fullscreen" : ""}`}
    >
      {modalContext}
      {activeOwnerKey && fullscreenOwnerChatId === activeOwnerKey && (
        <WorkPanelFullscreenControls
          key={activeOwnerKey}
          isMac={isMac}
          isWindows={isWindows}
          onExit={() => { void onFullscreenChange(null); }}
        />
      )}
      {state.workspaces.map((workspace) => {
        const visible = workspace.ownerChatId === activeOwnerKey;
        const selectedNewTab = selectedNewTabs[workspace.ownerChatId];
        const newTabActive = Boolean(selectedNewTab && selectedNewTab.anchor === workspace.activeItemId);
        const localOnly = isLocalDocumentDraftOwnerKey(workspace.ownerChatId) || (visible && !activeChatId);
        // A background Run keeps operating its own Chat's web pages, so a
        // hidden workspace with web items retains a non-zero viewport.
        const hasBackgroundWeb = !visible && workspace.items.some(isWorkPanelBackgroundWebItem);
        const backgroundSize = hasBackgroundWeb ? lastVisiblePanelSizes.current.get(workspace.ownerChatId) : undefined;
        return (
          <aside
            key={workspace.workspaceId}
            className={`chat-work-panel${visible ? " is-visible" : ""}${visible && hasPanelToggle ? " has-panel-toggle" : ""}${hasBackgroundWeb ? " has-background-web" : ""}`}
            style={backgroundSize ? { width: backgroundSize.width, height: backgroundSize.height } : undefined}
            hidden={!visible}
            aria-hidden={!visible}
            aria-label={t("chatWorkPanel.title")}
            data-work-panel-chat={workspace.ownerChatId}
          >
            <div className="chat-work-panel-tabs" role="tablist" aria-label={t("chatWorkPanel.title")}>
              {workspace.items.map((item) => {
                if (state.dialogItems?.some((dialog) => dialog.ownerChatId === workspace.ownerChatId && dialog.itemId === item.itemId)) return null;
                const active = !newTabActive && workspace.activeItemId === item.itemId;
                const closable = item.closable && !item.pinned;
                const overview = item.descriptor.kind === "webclient" && item.descriptor.module === "overview";
                const itemLoading = loadingWebItems.has(itemRuntimeKey(workspace.ownerChatId, item.itemId));
                const documentPath = workPanelDocumentPath(workspace.ownerChatId, item);
                const reviewSession = getWorkPanelReviewSession(
                  state.review,
                  workspace.ownerChatId,
                  item.itemId,
                );
                return (
                  <WorkPanelTab
                    key={item.itemId}
                    active={active}
                    overview={overview}
                    loading={itemLoading}
                    title={item.title}
                    tooltip={documentPath || item.title}
                    icon={<WorkPanelItemIcon item={item} />}
                    onContextMenu={(event) => {
                      if (isLocalDocumentDraftOwnerKey(workspace.ownerChatId)) return;
                      void handleTabContextMenu(event, workspace.ownerChatId, item).catch(() => undefined);
                    }}
                    onActivate={() => {
                      closeNewTabSelection(workspace.ownerChatId);
                      dispatchCommand({ type: "activateItem", ownerChatId: workspace.ownerChatId, itemId: item.itemId });
                    }}
                    badge={reviewSession?.annotations.length ? (
                        <span
                          className="chat-work-panel-tab-review-count"
                          aria-label={t("chatWorkPanel.review.annotationCount", {
                            count: reviewSession.annotations.length,
                          })}
                        >
                          {reviewSession.annotations.length}
                        </span>
                      ) : null}
                    closeLabel={t("chatWorkPanel.closeTab", { title: item.title })}
                    onClose={closable ? () => closeItemWithReviewProtection(workspace.ownerChatId, item.itemId) : undefined}
                  />
                );
              })}
              {newTabs.filter(tab => tab.ownerChatId === workspace.ownerChatId).map(tab => (
                <WorkPanelTab key={tab.id} title={t("chatWorkPanel.newTab.title")}
                  active={newTabActive && selectedNewTab?.id === tab.id} icon={<GlobalOutlined />}
                  onActivate={() => setSelectedNewTabs(current => ({ ...current,
                    [workspace.ownerChatId]: { id: tab.id, anchor: workspace.activeItemId } }))}
                  closeLabel={t("chatWorkPanel.closeTab", { title: t("chatWorkPanel.newTab.title") })}
                  closeShortcut={isMac ? "⌘W" : isWindows ? "Ctrl+W" : undefined}
                  onClose={() => closeNewTab(workspace.ownerChatId, tab.id)} />
              ))}
              <div className="chat-work-panel-add-tab" role="presentation">
                <button type="button" className="chat-work-panel-add-button"
                  aria-label={t("chatWorkPanel.add.openMenu")}
                  onClick={() => openNewTab(workspace.ownerChatId)}><PlusOutlined /></button>
              </div>
            </div>
            <div className="chat-work-panel-body">
              {visible && newTabActive && <WorkPanelNewTab key={selectedNewTab?.id}
                urlDraft={newTabs.find(tab => tab.id === selectedNewTab?.id)?.urlDraft ?? ""}
                onUrlDraftChange={urlDraft => setNewTabs(current => current.map(tab =>
                  tab.id === selectedNewTab?.id ? { ...tab, urlDraft } : tab))}
                localOnly={localOnly} projectVisible={launcher.projectVisible} projectEnabled={launcher.projectEnabled}
                projectDisabledReason={launcher.projectDisabledReason}
                webapps={launcher.webapps} openWebappWindowIds={openWebappWindowIds}
                websites={workspace.items.flatMap(item => item.descriptor.kind === "web"
                  ? [{ id: item.itemId, title: item.title, url: item.descriptor.url }] : [])}
                onOpenWeb={url => openWebFromNewTab(workspace.ownerChatId, url)}
                onOpenFiles={() => openFilesFromMenu(workspace.ownerChatId)}
                onOpenSideChat={() => openSideChatFromMenu(workspace.ownerChatId)}
                onOpenProject={() => openProjectFromMenu(workspace.ownerChatId)}
                onOpenWebapp={webapp => {
                  if (openWebappWindowIds.has(webapp.id)) launcher.onFocusWebappWindow(webapp.id);
                  else launcher.onOpenWebapp(workspace.ownerChatId, webapp);
                  closeNewTabSelection(workspace.ownerChatId);
                }} />}
              <Suspense fallback={null}>
                {workspace.items.map((item) => {
                  if (state.dialogItems?.some((dialog) => dialog.ownerChatId === workspace.ownerChatId && dialog.itemId === item.itemId)) return null;
                  // New dialog-bound items must not briefly mount a second guest
                  // in the main window. Existing guests stay until Main captures them.
                  if (item.descriptor.kind === "web" &&
                      state.dialogItems?.some((dialog) => dialog.ownerChatId === workspace.ownerChatId) &&
                      !webControllers.current.has(itemRuntimeKey(workspace.ownerChatId, item.itemId)) &&
                      !failedWebDialogTransfers.current.has(itemRuntimeKey(workspace.ownerChatId, item.itemId))) return null;
                  const active = visible && !newTabActive && workspace.activeItemId === item.itemId;
                  if (item.descriptor.kind === "webclient" &&
                      (isLocalDocumentDraftOwnerKey(workspace.ownerChatId) || (visible && !activeChatId))) return null;
                  // Read-only observers belong to the visible, committed Main Chat.
                  // A hidden guest can fail registration after a Chat switch and
                  // retain a permanently closed Frame Port when shown again.
                  // Recreate these guests on activation; keep editable items alive.
                  if (!active && item.descriptor.kind === "webclient" &&
                    (item.descriptor.module === "overview" || item.descriptor.module === "debug")) return null;
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
                  const webclientDocumentState = webclientDocumentStates[reviewRuntimeKey];
                  const webReviewPreloadEnabled = item.descriptor.kind === "web" &&
                    Boolean(normalizeWorkPanelWebUrl(item.descriptor.url));
                  const needsReviewPreload = webReviewPreloadEnabled || (
                    item.descriptor.kind === "local-file" && Boolean(item.descriptor.reviewKind)
                  );
                  const waitingForReviewPreload = needsReviewPreload && !reviewPreloadUrl;
                  return (
                    <div
                      key={item.itemId}
                      className={`chat-work-panel-item${active ? " is-active" : ""}${!active && isWorkPanelBackgroundWebItem(item) ? " is-background-web" : ""}${reviewActive && reviewSession ? " is-reviewing" : ""}${reviewActive && reviewSession?.kind === "html" ? " is-html-review" : ""}`}
                      data-work-panel-active={active ? "true" : "false"}
                      data-work-panel-item={item.itemId}
                      data-work-panel-owner={workspace.ownerChatId}
                      data-webclient-document-dirty={webclientDocumentState?.dirty ? "true" : "false"}
                      data-webclient-document-busy={webclientDocumentState?.busy ? "true" : "false"}
                      hidden={!active}
                      aria-hidden={!active}
                    >
                      {item.descriptor.kind === "native" && item.descriptor.surfaceKey === "local-document" ? (
                        <WorkPanelLocalDocument
                          document={item.descriptor.context as unknown as WorkPanelLocalDocumentData}
                          active={active}
                          onLoadingChange={(isLoading) => {
                            const key = itemRuntimeKey(workspace.ownerChatId, item.itemId);
                            setLoadingWebItems((current) => {
                              if (current.has(key) === isLoading) return current;
                              const next = new Set(current);
                              if (isLoading) next.add(key);
                              else next.delete(key);
                              return next;
                            });
                          }}
                        />
                      ) : item.descriptor.kind === "native" && item.descriptor.surfaceKey === "document-html" ? (
                        <WorkPanelDocumentHtml
                          ref={(controller) => {
                            const key = itemRuntimeKey(workspace.ownerChatId, item.itemId);
                            if (controller) nativeHtmlControllers.current.set(key, controller);
                            else nativeHtmlControllers.current.delete(key);
                          }}
                          active={active}
                          preloadUrl={reviewPreloadUrl.replace(/work-panel-preview\.js$/u, "document-html-review.js")}
                          ownerChatId={workspace.ownerChatId}
                          surfaceIdentityKey={item.stableKey}
                          label={item.title}
                          rendererGeneration={rendererGenerationRef.current}
                          document={item.descriptor.context as unknown as import("../../shared/work-panel-document-html").WorkPanelDocumentHtmlSelection}
                          onHandoff={(annotations) => handoffNativeHtmlReview(
                            workspace.ownerChatId,
                            item,
                            annotations,
                          )}
                        />
                      ) : item.descriptor.kind === "native" && (
                        item.descriptor.surfaceKey === "resource-image" || item.descriptor.surfaceKey === "document-image"
                      ) ? (
                        item.descriptor.context.editable === false ? (
                          <WorkPanelDocumentImageReadonly
                            ownerChatId={workspace.ownerChatId}
                            rendererGeneration={rendererGenerationRef.current}
                            resource={item.descriptor.context as unknown as import("../../shared/work-panel-resource-image").WorkPanelResourceImageSelection}
                          />
                        ) : <WorkPanelResourceImage
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
                                surfaceKey: item.descriptor.kind === "native" && item.descriptor.surfaceKey === "document-image"
                                  ? "document-image"
                                  : "resource-image",
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
                          documentSource={documentSourceFromWebclientDescriptor(item.descriptor)}
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
                          onAgentWebclientDocumentState={(documentState) => {
                            setWebclientDocumentStates((current) => {
                              const previous = current[reviewRuntimeKey];
                              if (
                                previous?.dirty === documentState.dirty &&
                                previous.busy === documentState.busy &&
                                previous.annotationCount === documentState.annotationCount &&
                                previous.targetKey === documentState.targetKey
                              ) {
                                return current;
                              }
                              return { ...current, [reviewRuntimeKey]: documentState };
                            });
                          }}
                          onAgentWebclientDocumentHandoff={(text) => {
                            void insertDocumentComposerDraft(workspace.ownerChatId, text);
                          }}
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
                          initialTabId={item.itemId}
                          onControllerReady={item.descriptor.kind === "web" ? (controller) => {
                            const key = itemRuntimeKey(workspace.ownerChatId, item.itemId);
                            if (controller) webControllers.current.set(key, controller);
                            else webControllers.current.delete(key);
                          } : item.descriptor.previewKind === "html" ? (controller) => {
                            const key = itemRuntimeKey(workspace.ownerChatId, item.itemId);
                            if (controller) htmlFileControllers.current.set(key, controller);
                            else htmlFileControllers.current.delete(key);
                          } : undefined}
                          onCloseSurface={() => dispatchCommand({ type: "closeItem", ownerChatId: workspace.ownerChatId, itemId: item.itemId })}
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
                          onCurrentUrlChange={(nextUrl) => {
                            const session = getWorkPanelReviewSession(
                              stateRef.current.review,
                              workspace.ownerChatId,
                              item.itemId,
                            );
                            if (
                              session?.source.sourceKind === "web" &&
                              session.source.liveProjectWeb &&
                              !isLoopbackWorkPanelReviewUrl(nextUrl)
                            ) {
                              const sanitizedUrl = sanitizeWorkPanelReviewWebUrl(nextUrl);
                              if (!sanitizedUrl) return;
                              dispatchCommand({
                                type: "startReview",
                                ownerChatId: workspace.ownerChatId,
                                itemId: item.itemId,
                                kind: session.kind,
                                source: {
                                  ...session.source,
                                  revision: sanitizedUrl,
                                  url: sanitizedUrl,
                                  liveProjectWeb: undefined,
                                },
                              });
                            }
                          }}
                          onIpcMessage={(event) => handleReviewIpcMessage(
                            workspace.ownerChatId,
                            item,
                            event,
                          )}
                          ownerChatId={workspace.ownerChatId}
                          partition={item.descriptor.kind === "local-file"
                            ? createWorkPanelLocalFilePartition(item.descriptor.handleId)
                            : DESKTOP_SSO_WEBVIEW_PARTITION}
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
                          refreshOnDesktopSso={item.descriptor.kind === "web" && Boolean(
                            normalizeWorkPanelWebUrl(item.descriptor.url),
                          )}
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
                            : state.webItemUrls?.[itemRuntimeKey(workspace.ownerChatId, item.itemId)] || item.descriptor.url}
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
    </div>
  );
}
