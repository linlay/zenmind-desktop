import {
  AppstoreOutlined,
  BugOutlined,
  CloseOutlined,
  DashboardOutlined,
  DeploymentUnitOutlined,
  DiffOutlined,
  FileTextOutlined,
  GlobalOutlined,
  ProjectOutlined,
  RobotOutlined,
} from "@ant-design/icons";
import { lazy, Suspense, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { WorkPanelCommand, WorkPanelCommandResult, WorkPanelState } from "../../shared/work-panel";
import { normalizeWorkPanelWebUrl, stableWorkPanelHash } from "../../shared/work-panel";
import {
  resolveChatWorkPanelLocalResourcePath,
  type ChatWorkPanelTabContextMenuProfile,
} from "../../shared/chat-work-panel-tab-context-menu";
import {
  AGENT_WEBCLIENT_WORKPANEL_RESOURCE_DOWNLOAD_ACTION,
  AGENT_WEBCLIENT_WORKPANEL_RESOURCE_DOWNLOAD_VERSION,
} from "../../shared/contracts/agent-webclient-bridge";
import { SERVICE_WEBVIEW_BRIDGE_ACTION_CHANNEL } from "../../shared/service-webview-bridge";
import { registerDesktopActionProviderForScope } from "../services/desktopActionRegistry";
import { useI18n } from "../i18n/useI18n";
import { createChatChildSurfaceIdentity } from "../../shared/surface-identity";
import { createAgentWebclientOverviewPath } from "../../shared/agent-webclient-routes";

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
  if (item.descriptor.kind === "native") return <AppstoreOutlined />;
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

export function WorkPanelHost({
  activeChatId,
  state,
  dispatchCommand,
  fullscreenOwnerChatId,
  onFullscreenChange,
  hasPanelToggle,
  isMac,
  isWindows,
}: WorkPanelHostProps) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef(state);
  const previousWebPartitionsRef = useRef(new Set<string>());
  const [loadingWebItems, setLoadingWebItems] = useState<Set<string>>(() => new Set());
  stateRef.current = state;

  const closeWorkPanelStep = (ownerChatId: string) => {
    const workspace = stateRef.current.workspaces.find((item) => item.ownerChatId === ownerChatId);
    if (!workspace) return false;
    const activeItem = workspace?.items.find((item) => item.itemId === workspace.activeItemId);
    const closableItems = workspace.items.filter((item) => item.closable && !item.pinned);
    const itemToClose = activeItem?.closable && !activeItem.pinned
      ? activeItem
      : closableItems[closableItems.length - 1];
    if (itemToClose) {
      const result = dispatchCommand({
        type: "closeItem",
        ownerChatId,
        itemId: itemToClose.itemId,
      });
      return result.ok;
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
      rootRef.current?.querySelectorAll<HTMLElement>("[data-work-panel-item]") ?? [],
    );
    const itemHost = itemHosts.find((candidate) =>
      candidate.dataset.workPanelOwner === ownerChatId && candidate.dataset.workPanelItem === itemId,
    );
    return itemHost?.querySelector("webview") as Electron.WebviewTag | null;
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
    const result = await window.electronAPI.chatWorkPanelTabContextMenu.popup({
      mode: "work-panel",
      x: event.clientX,
      y: event.clientY,
      profile: tabContextMenuProfile(item),
      isFullscreen: fullscreenOwnerChatId === ownerChatId,
      canClose: item.closable && !item.pinned,
      canCloseOthers: workspace?.items.some((candidate) =>
        candidate.itemId !== item.itemId && candidate.closable && !candidate.pinned,
      ) ?? false,
    });
    if (result.actionId === "reload") {
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
    if (
      result.actionId === "open-resource-default-app" &&
      item.descriptor.kind === "webclient" &&
      (item.descriptor.module === "artifact" || item.descriptor.module === "reference")
    ) {
      const relativePath = resolveChatWorkPanelLocalResourcePath({
        ownerChatId,
        profile: item.descriptor.module,
        route: item.descriptor.route,
      });
      if (!relativePath) {
        console.warn("[work-panel] refused invalid local resource path", item.descriptor.route);
        return;
      }
      const opened = await window.electronAPI.chatWorkPanelTabContextMenu.openLocalResource({
        ownerChatId,
        profile: item.descriptor.module,
        relativePath,
      });
      if (!opened.ok) {
        console.warn("[work-panel] failed to open local resource", opened.code, opened.message);
      }
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
      dispatchCommand({ type: "closeItem", ownerChatId, itemId: item.itemId });
      return;
    }
    if (result.actionId === "close-other-tabs") {
      dispatchCommand({ type: "closeOtherItems", ownerChatId, itemId: item.itemId });
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
    const nextPartitions = new Set(
      state.workspaces.flatMap((workspace) => workspace.items
        .filter((item) => item.descriptor.kind === "web")
        .map((item) => itemPartition(workspace.workspaceId, item.itemId))),
    );
    for (const partition of previousWebPartitionsRef.current) {
      if (nextPartitions.has(partition)) continue;
      void window.electronAPI.chatWorkPanel?.clearSession?.({ partition }).catch(() => undefined);
    }
    previousWebPartitionsRef.current = nextPartitions;
  }, [state.workspaces]);

  useEffect(() => window.electronAPI.onWebviewOpenTab(({ target, sourceGuestId, url }) => {
    if (target !== "work-panel") return;
    const normalizedUrl = normalizeWorkPanelWebUrl(url);
    if (!normalizedUrl || !Number.isSafeInteger(sourceGuestId) || sourceGuestId <= 0) return;
    const webviews = Array.from(rootRef.current?.querySelectorAll("webview") ?? []) as Electron.WebviewTag[];
    const sourceWebview = webviews.find((webview) => readWebviewGuestId(webview) === sourceGuestId);
    const itemHost = sourceWebview?.closest<HTMLElement>("[data-work-panel-item]");
    const ownerChatId = itemHost?.dataset.workPanelOwner || "";
    const sourceItemId = itemHost?.dataset.workPanelItem || "";
    const sourceWorkspace = stateRef.current.workspaces.find(
      (workspace) => workspace.ownerChatId === ownerChatId,
    );
    const sourceItem = sourceWorkspace?.items.find((item) => item.itemId === sourceItemId);
    if (!ownerChatId || sourceItem?.descriptor.kind !== "web") return;
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
        if (ownerAgentKey) {
          const bootstrapFailure = ensureTrustedWorkspace();
          if (bootstrapFailure) return bootstrapFailure;
        }
        return execute({ type: "openItem", ownerChatId, descriptor: args.descriptor as any });
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
      publishFocusState(Boolean(visiblePanel && root.contains(visiblePanel)));
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
      const webviews = Array.from(root.querySelectorAll("webview")) as Electron.WebviewTag[];
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
                    </button>
                    {closable ? (
                      <button
                        type="button"
                        className="chat-work-panel-tab-close"
                        aria-label={t("chatWorkPanel.closeTab", { title: item.title })}
                        onClick={(event) => {
                          event.stopPropagation();
                          dispatchCommand({
                            type: "closeItem",
                            ownerChatId: workspace.ownerChatId,
                            itemId: item.itemId,
                          });
                        }}
                      >
                        <CloseOutlined />
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <div className="chat-work-panel-body">
              <Suspense fallback={null}>
                {workspace.items.map((item) => {
                  const active = visible && workspace.activeItemId === item.itemId;
                  return (
                    <div
                      key={item.itemId}
                      className={`chat-work-panel-item${active ? " is-active" : ""}`}
                      data-work-panel-active={active ? "true" : "false"}
                      data-work-panel-item={item.itemId}
                      data-work-panel-owner={workspace.ownerChatId}
                      hidden={!active}
                      aria-hidden={!active}
                    >
                      {item.descriptor.kind === "webclient" ? (
                        <ServiceWebviewSurface
                          active={active}
                          embedPath={item.descriptor.route}
                          hostTheme={document.documentElement.dataset.theme === "dark" ? "dark" : "light"}
                          loadInitialEmbeddedUrlDirectly
                          ownerChatId={workspace.ownerChatId}
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
                      ) : item.descriptor.kind === "web" ? (
                        <ExternalWebviewPage
                          active={active}
                          allowTabUrlCopy
                          allowUserTabCreation={false}
                          cdpActive={false}
                          chrome="browser"
                          enableDesktopWebActions={false}
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
                          ownerChatId={workspace.ownerChatId}
                          partition={itemPartition(workspace.workspaceId, item.itemId)}
                          publishPageContext={false}
                          registerPublicWebSurface={false}
                          showToolbar={false}
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
                          url={item.descriptor.url}
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
