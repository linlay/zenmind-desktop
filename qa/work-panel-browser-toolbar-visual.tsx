import React, { useCallback, useState } from "react";
import ReactDOM from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { ServicesProvider } from "../src/renderer/services/ServicesContext";
import { WorkPanelHost } from "../src/renderer/work-panel/WorkPanelHost";
import { reduceWorkPanelCommand, type WorkPanelCommand, type WorkPanelState } from "../src/shared/work-panel";
import { EMPTY_WORK_PANEL_REVIEW_RUNTIME_STATE } from "../src/shared/work-panel-review";
import "../src/renderer/styles/theme.css";
import "../src/renderer/styles/base.css";
import "../src/renderer/styles/app-shell.css";
import "../src/renderer/styles/external-webview.css";

const dispose = () => undefined;
const theme = new URLSearchParams(window.location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = theme;
document.body.style.background = theme === "dark" ? "#171a1f" : "#ffffff";

const installWebviewStubs = () => {
  for (const element of document.querySelectorAll("webview")) {
    const webview = element as unknown as Electron.WebviewTag;
    let currentUrl = element.getAttribute("src") || "";
    Object.assign(webview, {
      canGoBack: () => true,
      canGoForward: () => false,
      goBack: () => undefined,
      goForward: () => undefined,
      getTitle: () => "www.baidu.com",
      getURL: () => currentUrl,
      getWebContentsId: () => 101,
      isLoading: () => false,
      reload: () => element.dispatchEvent(new Event("did-stop-loading")),
      loadURL: async (url: string) => {
        currentUrl = url;
        element.setAttribute("src", url);
        element.dispatchEvent(Object.assign(new Event("did-navigate"), { url }));
      },
    });
    window.queueMicrotask(() => element.dispatchEvent(new Event("did-stop-loading")));
  }
};
new MutationObserver(installWebviewStubs).observe(document.documentElement, { childList: true, subtree: true });

Object.assign(window, {
  electronAPI: {
    chatWorkPanel: {
      clearSession: async () => ({ ok: true }),
      localFiles: {
        getReviewPreloadUrl: async () => "",
        select: async () => ({ ok: false, files: [] }),
        claim: async () => ({ ok: false }),
        release: async () => ({ ok: true }),
        open: async () => ({ ok: true }),
        reveal: async () => ({ ok: true }),
      },
    },
    chatWorkPanelTabContextMenu: {
      popup: async () => ({ actionId: null }),
      revealLocalResource: async () => ({ ok: true }),
      openLocalResource: async () => ({ ok: true }),
    },
    clipboard: { writeText: async () => undefined },
    desktopActions: { respond: async () => undefined, onCall: () => dispose },
    desktopShell: {
      setWorkPanelKeyboardFocusActive: () => undefined,
      setWebviewModalOverlayVisible: () => undefined,
      requestWindowClose: () => undefined,
    },
    canonicalChatSync: {
      onRequest: () => dispose,
      respond: () => undefined,
    },
    copilot: {
      publishDevToolsTarget: async () => undefined,
    },
    diagnostics: {
      reportRendererError: () => undefined,
    },
    embeddedCdp: {
      getSurfaceTargetState: async () => ({ ok: false }),
      registerSurface: async () => ({ ok: true }),
      unregisterSurface: async () => ({ ok: true }),
      updateSurface: async () => ({ ok: true }),
    },
    onWebviewOpenTab: () => dispose,
    onWorkPanelCloseShortcut: () => dispose,
    onWorkPanelFullscreenExitShortcut: () => dispose,
    onServicesChanged: () => dispose,
    plugins: {
      install: async () => ({ ok: false }),
      uninstall: async () => ({ ok: false }),
    },
    services: {
      list: async () => [],
    },
    serviceWebview: {
      getPreloadUrl: async () => "",
      onSelectionToolbarState: () => dispose,
    },
    sso: { onStatusChanged: () => dispose },
    webs: { webapps: { listOpenWindows: async () => [] } },
  },
});

const initialState: WorkPanelState = {
  workspaces: [{
    workspaceId: "visual-workspace",
    ownerChatId: "visual-chat",
    activeItemId: "web-tab",
    items: [
      {
        itemId: "overview-tab",
        stableKey: "webclient:overview:visual-chat",
        descriptor: {
          kind: "webclient",
          module: "overview",
          route: "/overview/visual-chat",
          context: { agentKey: "visual-agent", chatId: "visual-chat" },
          title: "Overview",
        },
        title: "Overview",
        closable: false,
        pinned: true,
        createdAt: 1,
      },
      {
        itemId: "web-tab",
        stableKey: "web:https://www.baidu.com/",
        descriptor: {
          kind: "web",
          url: "https://www.baidu.com/",
          title: "www.baidu.com",
        },
        title: "www.baidu.com",
        closable: true,
        pinned: false,
        createdAt: 2,
      },
    ],
  }],
  visibleOwnerChatIds: ["visual-chat"],
  webSessionKeysByItemId: {},
  review: EMPTY_WORK_PANEL_REVIEW_RUNTIME_STATE,
};

function WorkPanelBrowserToolbarVisualQA() {
  const [state, setState] = useState(initialState);
  const dispatchCommand = useCallback((command: WorkPanelCommand) => {
    const result = reduceWorkPanelCommand(state, command);
    setState(result.nextState);
    return result;
  }, [state]);

  return (
    <MemoryRouter>
      <ServicesProvider>
        <div className="work-panel-browser-toolbar-shell app-shell has-chat-work-panel">
          <div className="app-content">
            <WorkPanelHost
              activeChatId="visual-chat"
              state={state}
              dispatchCommand={dispatchCommand}
              fullscreenOwnerChatId={null}
              onFullscreenChange={async () => true}
              isMac
              isWindows={false}
              launcher={{
                agentKey: "visual-agent",
                agentMode: "CODER",
                projectEnabled: true,
                lastRunId: "visual-run",
                webapps: [],
                onOpenWebapp: () => undefined,
                onFocusWebappWindow: () => undefined,
              }}
            />
          </div>
        </div>
      </ServicesProvider>
    </MemoryRouter>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<WorkPanelBrowserToolbarVisualQA />);
