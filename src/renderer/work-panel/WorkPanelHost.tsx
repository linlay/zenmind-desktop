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
import { BUILTIN_BROWSER_DEFAULT_URL } from "../../shared/browser-surfaces";
import type { WorkPanelCommand, WorkPanelCommandResult, WorkPanelState } from "../../shared/work-panel";
import { normalizeWorkPanelWebUrl, stableWorkPanelHash } from "../../shared/work-panel";
import { registerDesktopActionProviderForScope } from "../services/desktopActionRegistry";
import { useI18n } from "../i18n/useI18n";
import { createChatChildSurfaceIdentity } from "../../shared/surface-identity";

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
  isMac: boolean;
  isWindows: boolean;
};

function actionError(code: string, message: string, details?: unknown) {
  return { ok: false as const, error: { code, message, ...(details === undefined ? {} : { details }) } };
}

function itemPartition(workspaceId: string, itemId: string) {
  return `work-panel-${stableWorkPanelHash(workspaceId)}-${stableWorkPanelHash(itemId)}`;
}

function serializeLegacyWorkspace(workspace: WorkPanelState["workspaces"][number] | null) {
  return workspace
    ? {
        open: true,
        surfaceId: workspace.workspaceId,
        activeTabId: workspace.activeItemId ?? undefined,
        tabs: workspace.items.map((item) => ({
          id: item.itemId,
          title: item.title,
          ...(item.descriptor.kind === "web" ? { url: item.descriptor.url } : {}),
        })),
      }
    : { open: false, tabs: [] };
}

type WorkPanelItem = WorkPanelState["workspaces"][number]["items"][number];

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
      return <FileTextOutlined />;
    case "planning":
      return <DeploymentUnitOutlined />;
    case "agent":
    case "copilot":
      return <RobotOutlined />;
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
  isMac,
  isWindows,
}: WorkPanelHostProps) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef(state);
  const previousWebPartitionsRef = useRef(new Set<string>());
  const [fullscreenOwnerChatId, setFullscreenOwnerChatId] = useState<string | null>(null);
  stateRef.current = state;

  const closeActiveItem = (ownerChatId: string) => {
    const workspace = stateRef.current.workspaces.find((item) => item.ownerChatId === ownerChatId);
    const activeItem = workspace?.items.find((item) => item.itemId === workspace.activeItemId);
    if (!activeItem || activeItem.pinned || !activeItem.closable) return false;
    const result = dispatchCommand({
      type: "closeItem",
      ownerChatId,
      itemId: activeItem.itemId,
    });
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
    const result = await window.electronAPI.chatWorkPanelTabContextMenu.popup({
      mode: "work-panel",
      x: event.clientX,
      y: event.clientY,
      canCopyUrl: item.descriptor.kind === "web",
      isFullscreen: fullscreenOwnerChatId === ownerChatId,
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
    if (result.actionId === "toggle-fullscreen") {
      if (fullscreenOwnerChatId === ownerChatId) {
        setFullscreenOwnerChatId(null);
        return;
      }
      const activation = dispatchCommand({
        type: "activateItem",
        ownerChatId,
        itemId: item.itemId,
      });
      if (activation.ok) {
        setFullscreenOwnerChatId(ownerChatId);
      }
    }
  };

  useEffect(() => {
    if (!fullscreenOwnerChatId) return;
    const workspaceStillVisible = activeChatId === fullscreenOwnerChatId && state.workspaces.some(
      (workspace) => workspace.ownerChatId === fullscreenOwnerChatId,
    );
    if (!workspaceStillVisible) {
      setFullscreenOwnerChatId(null);
    }
  }, [activeChatId, fullscreenOwnerChatId, state.workspaces]);

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

  useEffect(() => registerDesktopActionProviderForScope("global", async (request) => {
    const formal = request.action.startsWith("desktop.workpanel.");
    const legacy = request.action.startsWith("desktop.chatWorkPanel.");
    if (!formal && !legacy) return null;
    const ownerChatId = request.source?.chatId?.trim() || "";
    if (!ownerChatId) return actionError("source_chat_required", "A trusted source.chatId is required.");
    const args = request.args ?? {};
    const forbidden = ["chatId", "workspaceId", "stableKey", "preload", "webPreferences"].filter((key) => key in args);
    if (forbidden.length > 0) return actionError("invalid_request", `WorkPanel does not accept: ${forbidden.join(", ")}.`);
    const current = () => stateRef.current.workspaces.find((workspace) => workspace.ownerChatId === ownerChatId) ?? null;
    const execute = (command: WorkPanelCommand, legacyResponse = false) => {
      const result = dispatchCommand(command);
      const { nextState: _nextState, ...publicResult } = result;
      if (result.ok && legacyResponse) {
        const workspace = result.nextState.workspaces.find((item) => item.ownerChatId === ownerChatId) ?? null;
        return { ok: true as const, result: serializeLegacyWorkspace(workspace) };
      }
      return publicResult.ok
        ? { ok: true as const, result: publicResult }
        : { ok: false as const, error: publicResult.error };
    };

    if (formal) {
      switch (request.action) {
        case "desktop.workpanel.getState": {
          const workspace = current();
          return { ok: true, result: { ok: true, workspaceId: workspace?.workspaceId || "", state: workspace ?? undefined } };
        }
        case "desktop.workpanel.openItem":
          return execute({ type: "openItem", ownerChatId, descriptor: args.descriptor as any });
        case "desktop.workpanel.activateItem":
          return execute({ type: "activateItem", ownerChatId, itemId: String(args.itemId || "") });
        case "desktop.workpanel.closeItem":
          return execute({ type: "closeItem", ownerChatId, itemId: String(args.itemId || "") });
        case "desktop.workpanel.closeWorkspace":
          return execute({ type: "closeWorkspace", ownerChatId });
        default:
          return null;
      }
    }

    switch (request.action) {
      case "desktop.chatWorkPanel.getState": {
        const workspace = current();
        return { ok: true, result: serializeLegacyWorkspace(workspace) };
      }
      case "desktop.chatWorkPanel.open":
        return execute({
          type: "openItem",
          ownerChatId,
          legacy: true,
          descriptor: { kind: "web", url: BUILTIN_BROWSER_DEFAULT_URL, title: t("chatWorkPanel.blankTab") },
        }, true);
      case "desktop.chatWorkPanel.close":
        return execute({ type: "closeWorkspace", ownerChatId, legacy: true }, true);
      case "desktop.chatWorkPanel.openTab": {
        const requestedUrl = String(args.url || "").trim();
        const url = requestedUrl === "about:blank" ? BUILTIN_BROWSER_DEFAULT_URL : normalizeWorkPanelWebUrl(requestedUrl);
        if (!url) return actionError("invalid_url", "url must use http: or https:.");
        return execute({
          type: "openItem",
          ownerChatId,
          legacy: true,
          descriptor: { kind: "web", url, ...(typeof args.title === "string" ? { title: args.title } : {}) },
        }, true);
      }
      case "desktop.chatWorkPanel.activateTab":
        return execute({ type: "activateItem", ownerChatId, itemId: String(args.tabId || ""), legacy: true }, true);
      case "desktop.chatWorkPanel.closeTab":
        return execute({ type: "closeItem", ownerChatId, itemId: String(args.tabId || ""), legacy: true }, true);
      default:
        return null;
    }
  }), [dispatchCommand, t]);

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
        setFullscreenOwnerChatId(null);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!isCloseShortcut(event)) return;
      const activeElement = document.activeElement as HTMLElement | null;
      const visiblePanel = activeElement?.closest<HTMLElement>(".chat-work-panel.is-visible");
      if (!visiblePanel || !root.contains(visiblePanel)) return;
      const ownerChatId = visiblePanel.dataset.workPanelChat || "";
      if (!ownerChatId || !closeActiveItem(ownerChatId)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    root.addEventListener("keydown", handleKeyDown, true);
    const disposeGuestShortcut = window.electronAPI.onWorkPanelCloseShortcut(({ guestId }) => {
      if (!Number.isSafeInteger(guestId) || guestId <= 0) return;
      const webviews = Array.from(root.querySelectorAll("webview")) as Electron.WebviewTag[];
      const matchingWebview = webviews.find((webview) => readWebviewGuestId(webview) === guestId);
      const itemHost = matchingWebview?.closest<HTMLElement>("[data-work-panel-item]");
      const ownerChatId = itemHost?.dataset.workPanelOwner || "";
      const itemId = itemHost?.dataset.workPanelItem || "";
      const workspace = stateRef.current.workspaces.find((item) => item.ownerChatId === ownerChatId);
      if (!workspace || workspace.ownerChatId !== activeChatId || workspace.activeItemId !== itemId) return;
      closeActiveItem(ownerChatId);
    });
    return () => {
      root.removeEventListener("keydown", handleKeyDown, true);
      disposeGuestShortcut();
    };
  }, [activeChatId, dispatchCommand, fullscreenOwnerChatId, isMac, isWindows]);

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
            className={`chat-work-panel${visible ? " is-visible" : ""}`}
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
                      <span className="chat-work-panel-tab-icon" aria-hidden="true">
                        <WorkPanelItemIcon item={item} />
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
                        />
                      ) : item.descriptor.kind === "web" ? (
                        <ExternalWebviewPage
                          active={active}
                          allowTabUrlCopy
                          allowUserTabCreation={false}
                          cdpActive={false}
                          chrome="browser"
                          enableDesktopWebActions={false}
                          openPopupsInCurrentTab
                          ownerChatId={workspace.ownerChatId}
                          partition={itemPartition(workspace.workspaceId, item.itemId)}
                          publishPageContext={false}
                          registerPublicWebSurface={false}
                          showToolbar={false}
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
