import { lazy, Suspense, useEffect, useRef } from "react";
import { BUILTIN_BROWSER_DEFAULT_URL } from "../../shared/browser-surfaces";
import type { WorkPanelCommand, WorkPanelCommandResult, WorkPanelState } from "../../shared/work-panel";
import { normalizeWorkPanelWebUrl, stableWorkPanelHash } from "../../shared/work-panel";
import { registerDesktopActionProviderForScope } from "../services/desktopActionRegistry";
import { useI18n } from "../i18n/useI18n";

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
  stateRef.current = state;

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
        const webview = visible.querySelector("webview") as Electron.WebviewTag | null;
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
    <div ref={rootRef} className="work-panel-host">
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
            <div className="chat-work-panel-tabs" role="tablist">
              {workspace.items.map((item) => (
                <button
                  key={item.itemId}
                  type="button"
                  role="tab"
                  aria-selected={workspace.activeItemId === item.itemId}
                  onClick={() => dispatchCommand({ type: "activateItem", ownerChatId: workspace.ownerChatId, itemId: item.itemId })}
                >
                  {item.title}
                  {item.closable && !item.pinned ? (
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={t("chatWorkPanel.close")}
                      onClick={(event) => {
                        event.stopPropagation();
                        dispatchCommand({ type: "closeItem", ownerChatId: workspace.ownerChatId, itemId: item.itemId });
                      }}
                    >×</span>
                  ) : null}
                </button>
              ))}
            </div>
            <div className="chat-work-panel-body">
              <Suspense fallback={null}>
                {workspace.items.map((item) => {
                  const active = visible && workspace.activeItemId === item.itemId;
                  if (item.descriptor.kind === "webclient") {
                    return (
                      <ServiceWebviewSurface
                        key={item.itemId}
                        active={active}
                        embedPath={item.descriptor.route}
                        hostTheme={document.documentElement.classList.contains("dark") ? "dark" : "light"}
                        loadInitialEmbeddedUrlDirectly
                        ownerChatId={workspace.ownerChatId}
                        serviceId="agent-webclient"
                        surfaceId={`workpanel-${item.itemId}`}
                        surfaceLabel={item.title}
                      />
                    );
                  }
                  if (item.descriptor.kind !== "web") return null;
                  return (
                    <ExternalWebviewPage
                      key={item.itemId}
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
                      surfaceId={`workpanel-web:${stableWorkPanelHash(item.itemId)}`}
                      surfaceKind="chat-work-panel"
                      surfaceLabel={item.title}
                      title={item.title}
                      url={item.descriptor.url}
                    />
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
