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
const searchParams = new URLSearchParams(window.location.search);
const theme = searchParams.get("theme") === "dark" ? "dark" : "light";
const surface = searchParams.get("surface") === "local"
  ? "local"
  : searchParams.get("surface") === "artifact"
    ? "artifact"
    : "web";
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
      send: () => undefined,
      reload: () => element.dispatchEvent(new Event("did-stop-loading")),
      loadURL: async (url: string) => {
        currentUrl = url;
        element.setAttribute("src", url);
        element.dispatchEvent(Object.assign(new Event("did-navigate"), { url }));
      },
    });
    if (surface === "artifact" && !element.querySelector("[data-artifact-visual-content]")) {
      const artifact = document.createElement("div");
      artifact.dataset.artifactVisualContent = "true";
      artifact.style.minHeight = "100%";
      artifact.style.background = "#f4f7fc";
      artifact.style.color = "#ffffff";
      artifact.innerHTML = `
        <header style="box-sizing:border-box;min-height:196px;padding:36px 48px;background:linear-gradient(135deg,#2f66e9,#26479d)">
          <h1 style="margin:0 0 18px;font:700 42px/1.15 system-ui,sans-serif">qiuer40_admin_demo 数据仪表板</h1>
          <p style="margin:0;font:500 20px/1.5 system-ui,sans-serif">MySQL @ 10.65.62.54 · 库 qiuer40_admin_demo · 19 张表</p>
        </header>
        <main style="display:grid;grid-template-columns:1fr 1fr;gap:24px;padding:32px 48px;color:#17345f">
          <section style="min-height:100px;padding:24px;border-radius:20px;background:#fff">物料总数<br><strong style="font-size:36px;color:#2f66e9">100</strong></section>
          <section style="min-height:100px;padding:24px;border-radius:20px;background:#fff">制品总数<br><strong style="font-size:36px;color:#16a34a">506</strong></section>
        </main>`;
      element.appendChild(artifact);
    }
    if (element.dataset.visualQaReady !== "true") {
      element.dataset.visualQaReady = "true";
      window.setTimeout(() => {
        element.dispatchEvent(new Event("did-stop-loading"));
        if (surface === "artifact") {
          element.dispatchEvent(Object.assign(new Event("ipc-message"), {
            channel: "workPanel.previewReview.event",
            args: [{
              version: 1,
              event: "capability",
              requestId: "visual-capability",
              kind: "html",
              fileName: "dashboard.html",
              revision: "visual-revision",
            }],
          }));
        }
      }, 50);
    }
  }
};
new MutationObserver(installWebviewStubs).observe(document.documentElement, { childList: true, subtree: true });

Object.assign(window, {
  electronAPI: {
    chatWorkPanel: {
      clearSession: async () => ({ ok: true }),
      localFiles: {
        getReviewPreloadUrl: async () => "file:///qa/work-panel-preview.js",
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
      list: async () => surface === "artifact" ? [{
        id: "agent-webclient",
        name: "Agent WebClient",
        kind: "builtin",
        serviceMode: "service",
        version: "visual",
        description: "Visual QA service",
        installDir: "/qa/agent-webclient",
        paths: {
          programDir: "/qa/agent-webclient",
          configDir: "/qa/config",
          dataDir: "/qa/data",
          stateDir: "/qa/state",
          logDir: "/qa/logs",
        },
        installed: true,
        status: "running",
        statusLabel: "Running",
        message: "",
        frontendMode: "embedded",
        pluginActions: [],
        configFiles: [],
        healthMeta: {
          pid: 101,
          pidFilePath: "/qa/agent-webclient.pid",
          logFilePath: "/qa/agent-webclient.log",
          errorLogFilePath: "/qa/agent-webclient.error.log",
          webUrl: "http://127.0.0.1:5178",
          port: 5178,
          prerequisites: [],
        },
      }] : [],
    },
    serviceWebview: {
      getPreloadUrl: async () => "file:///qa/service-webview-preload.js",
      onSelectionToolbarState: () => dispose,
    },
    sso: { onStatusChanged: () => dispose },
    webs: { webapps: { listOpenWindows: async () => [] } },
  },
});

const visualItem: WorkPanelState["workspaces"][number]["items"][number] = surface === "local"
  ? {
      itemId: "local-tab",
      stableKey: "local-file:dashboard",
      descriptor: {
        kind: "local-file",
        handleId: "visual-local-handle",
        fileName: "dashboard.html",
        previewKind: "html",
        reviewKind: "html",
        workspaceRelativePath: "reports/dashboard.html",
        reviewRevision: "visual-local-revision",
      },
      title: "dashboard.html",
      closable: true,
      pinned: false,
      createdAt: 2,
    }
  : surface === "artifact"
    ? {
        itemId: "artifact-tab",
        stableKey: "artifact:visual-agent:visual-chat:visual-artifact",
        descriptor: {
          kind: "webclient",
          module: "artifact",
          route: "/resource-viewer/visual-agent?chatId=visual-chat&file=artifacts%2Fdashboard.html",
          context: {
            agentKey: "visual-agent",
            chatId: "visual-chat",
            artifactId: "visual-artifact",
          },
          title: "dashboard.html",
        },
        title: "dashboard.html",
        closable: true,
        pinned: false,
        createdAt: 2,
      }
    : {
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
      };

const initialState: WorkPanelState = {
  workspaces: [{
    workspaceId: "visual-workspace",
    ownerChatId: "visual-chat",
    activeItemId: visualItem.itemId,
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
      visualItem,
    ],
  }],
  visibleOwnerChatIds: ["visual-chat"],
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
