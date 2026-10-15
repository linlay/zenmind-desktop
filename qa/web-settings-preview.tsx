// Real settings and control-center components with isolated, in-memory APIs.
import React, { useLayoutEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Routes, Route, useNavigate } from "react-router-dom";
import { SettingsPage } from "../src/renderer/pages/settings/SettingsPage";
import { ServicesProvider } from "../src/renderer/services/ServicesContext";
import { AppearanceProvider, useAppearance } from "../src/renderer/appearance/AppearanceProvider";
import { DesktopBackground } from "../src/renderer/appearance/DesktopBackground";
import { SettingsSidebarIcon } from "../src/renderer/app-shell/navigation/SettingsSidebarIcon";
import type { WebsiteEntry, WebappEntry, WebappRuntimeState } from "../src/shared/contracts";
import { createTranslator, DEFAULT_LOCALE, type SupportedLocale } from "../src/shared/i18n";
import { RendererI18nContext, defaultRendererI18nContextValue } from "../src/renderer/i18n/i18n-context";
import "../src/renderer/styles.css";
import photo from "./assets/alpine-lake.png";

const noop = () => {};
const asyncNoop = async () => {};
let mode = "light";
let skinId = "default";
let withPhoto = false;
const appearanceResult = () => ({ ok: true, settings: { skinId, background: withPhoto ? { id: "a".repeat(32), name: "lake.png", width: 1586, height: 992 } : null, backgroundDataUrl: withPhoto ? photo : null } });
const previewTime = Date.UTC(2026, 9, 14);
const websites: WebsiteEntry[] = [{ kind: "website", id: "forum", entryKey: "website:forum", label: "示例站点", url: "https://forum.example.test", copilotAgentKey: "", createdAt: previewTime, updatedAt: previewTime }];
const webapps: WebappEntry[] = [{ kind: "webapp", id: "notes", entryKey: "webapp:notes", label: "便签", key: "notes", schemaVersion: 2, version: "1.3.0", target: "any", openMode: "workspace", removable: true, frontend: { root: "frontend", index: "index.html", routeConfig: { backendPrefixes: [] } }, appConfig: {}, userConfig: { fields: [] }, createdAt: previewTime, updatedAt: previewTime }];
let bridgeItems = [{ schemaVersion: 2, id: "sample-forum", name: "Sample Forum", version: "2.0.0", origins: { forum: { url: "https://forum.example.test", name: "示例论坛" } }, enabled: true,
  description: "为示例页面提供查询和原生操作。",
  pages: { search: { origin: "forum", path: "/forum" }, compose: { origin: "forum", path: "/forum/new", name: "发帖" }, post: { origin: "forum", path: "/forum/posts/:postId", match: [{ title: "帖子详情" }], shared: ["core", "forum/comment"] } } }];
let runtime: WebappRuntimeState = {
  id: "notes", entryKey: "webapp:notes", kind: "webapp", status: "running", version: "1.3.0", target: "any", launcher: "none",
  webUrl: "http://127.0.0.1:19080", backendUrl: "", frontendPort: 19080, backendPort: null, pid: null,
  runtimeVersion: "", externalId: "", prerequisiteIssues: [], ownership: null, message: "", updatedAt: new Date(previewTime).toISOString()
};
const result = () => ({ ok: true, items: [...websites, ...webapps], state: runtime, message: "" });
const bridgeResult = () => ({ ok: true, items: bridgeItems });
const services = ["identity-center", "agent-platform", "agent-webclient", "agent-container-hub"].map(id => ({
  id, name: id, description: "内置服务", kind: "builtin", serviceMode: "service", status: "running", statusLabel: "运行中", installed: true, version: "1.3.0", message: "", frontendMode: "none", installDir: "/preview/program/" + id,
  paths: { programDir: "/preview/program/" + id, dataDir: "/preview/data/" + id, configDir: "/preview/config/" + id, stateDir: "/preview/state/" + id, logDir: "/preview/logs/" + id }, pluginActions: [],
  configFiles: [{ key: "config", label: "config.yaml", relativePath: "config.yaml", absolutePath: "/preview/config/config.yaml", exists: true, editable: true }],
  healthMeta: { pid: 1234, pidFilePath: "/preview/state/service.pid", logFilePath: "/preview/logs/main.log", errorLogFilePath: "", webUrl: "http://127.0.0.1:19090", port: 19090, prerequisites: [] }
}));
const calls: string[] = [];
Object.assign(window, { webSettingsCalls: calls });
window.electronAPI = {
  onServicesChanged: () => noop,
  currentPage: { publishSnapshot: asyncNoop },
  settings: {
    getDataRoot: async () => "C:\\Preview\\ZenMind",
    getGeneralSettings: async () => ({ deviceName: "预览设备", preventSleepWhileRunning: true, desktopActionConfirmationEnabled: true, desktopActionConfirmationTimeoutSeconds: 60 }),
    getDesktopDeviceInfo: async () => ({ deviceName: "预览设备", deviceId: "preview-device" }),
    getEnterpriseImSettings: async () => ({ enabled: false, baseUrl: "" }),
    getUsageProfile: async () => ({ ok: false, error: "notAuthenticated" }),
    getTunnelHubSettings: async () => ({ enabled: false, serverUrl: "", token: "" }),
    getAppInfo: async () => ({ productName: "预览", version: "0.4.50", buildTime: "2026-10-13T00:00:00Z" }),
    getDeviceIdentity: async () => ({ identityPath: "/preview/device.json", version: 1, installId: "preview-install", deviceId: "preview-device", machineHash: "", machineSource: "unavailable", createdAt: "", updatedAt: "" }),
    getThemePreference: async () => mode,
    setNativeThemeSource: async (value: string) => { mode = value; return { ok: true, themeSource: value }; },
    getDesktopSkin: async () => appearanceResult(),
    setDesktopSkin: async (value: string) => { skinId = value; return appearanceResult(); },
    listWebsiteBridges: async () => bridgeResult(),
    readWebsiteBridgeScript: async ({ script }: { script: string }) => ({ ...bridgeResult(), script: `// ${script}\n${Array.from({length: 40}, (_, index) => `const page${index} = { route: "/forum" };`).join("\n")}` }),
    setWebsiteBridgeEnabled: async ({ enabled }: { enabled: boolean }) => { calls.push(`bridge.enabled:${enabled}`); bridgeItems = bridgeItems.map(item => ({ ...item, enabled })); return bridgeResult(); },
    importWebsiteBridge: async (id?: string) => { calls.push(`bridge.import:${id ?? "new"}`); return { ...bridgeResult(), cancelled: true }; },
    exportWebsiteBridge: async () => { calls.push("bridge.export"); return { ...bridgeResult(), cancelled: true }; },
    removeWebsiteBridge: async () => { calls.push("bridge.remove"); return bridgeResult(); }
  },
  services: { list: async () => services, getBrowserWebclient: async () => ({ running: false, url: "" }), readConfig: async () => ({ ok: true, content: "# 服务配置\nPORT: 19090\nHOST: 127.0.0.1", path: "/preview/config/config.yaml", exists: true, source: "installed" }) },
  updates: { onChanged: () => noop, getState: async () => ({ phase: "idle", source: "release", currentVersion: "0.4.50", version: "", autoDownload: true, releaseNotes: [], canInstall: false }) },
  sso: { getStatus: async () => ({ authenticated: false }) },
  market: { getSettings: async () => ({ enabled: false, serverUrl: "" }) },
  kanban: { getSettings: async () => ({ settings: { cloud: { enabled: false, serverUrl: "" } }, connectionState: "disabled" }) },
  tunnelHub: { getStatus: async () => ({ enabled: false, connected: false, state: "disabled" }) },
  desktopPet: { onStateChanged: () => noop, getState: async () => ({ enabled: false, appearanceId: "default", appearanceOptions: [] }) },
  assistant: { getSettings: async () => ({}), listCopilotAgents: async () => ({ ok: true, agents: [] }), listAgents: async () => [], listNavigationAgents: async () => ({ ok: true, agents: [] }) },
  shell: { openExternal: async () => ({ ok: true }) },
  clipboard: { writeText: async () => ({ ok: true }) },
  webs: {
    list: async () => result(),
    websites: { update: async () => { calls.push("website.save"); return result(); }, import: async () => result(), export: async () => result() },
    webapps: {
      getStatus: async () => result(), checkRuntime: async () => ({ ok: true, issues: [], executableName: "" }),
      getUserConfig: async () => ({ ok: true, values: {}, issues: [] }),
      getRuntimeSettings: async () => ({ ok: true, settings: { schemaVersion: 1, runtimeExecutables: {} } }),
      getPublishStatus: async () => ({ ok: true, info: { enabled: false, canPublish: false }, state: null }),
      start: async () => { calls.push("webapp.start"); runtime = { ...runtime, status: "running" }; return result(); },
      stop: async () => { calls.push("webapp.stop"); runtime = { ...runtime, status: "stopped" }; return result(); },
      restart: async () => { calls.push("webapp.restart"); return result(); },
      update: async () => { calls.push("webapp.save"); return result(); },
      install: async () => { calls.push("webapp.import"); return { ...result(), cancelled: true }; }
    }
  }
} as unknown as Window["electronAPI"];

function Preview() {
  const appearance = useAppearance();
  const navigate = useNavigate();
  const [platform, setPlatform] = useState("mac");
  const [sidebarWidth, setSidebarWidth] = useState(190);
  const [empty, setEmpty] = useState(false);
  const [locale, setLocale] = useState<SupportedLocale>(DEFAULT_LOCALE);
  const t = useMemo(() => createTranslator(locale), [locale]);
  useLayoutEffect(() => {
    Object.assign(window, { webSettingsPreview: { appearance, setPlatform, setSidebarWidth, setEmpty, setLocale, navigate, setPhoto: async (enabled: boolean) => { withPhoto = enabled; await appearance.refreshAppearanceFromCanonical(); } } });
  });
  return <div className={`app-shell has-standard-base-surface is-secondary-sidebar-mode is-${platform}-platform`} style={{ "--app-sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}>
    <DesktopBackground background={appearance.background} fallback={null} />
    <div className="app-sidebar-shell"><aside className="app-sidebar"><nav className="sidebar-settings-directory">
      <div className="sidebar-settings-search"><input type="search" aria-label="搜索设置" placeholder="搜索设置..." /></div>
      {[["control", "控制中心"], ["websites", "网站"], ["websiteBridges", "网站桥"], ["webapps", "网页应用"]].map(([id, label]) => <button key={id} className="sidebar-link" onClick={() => navigate("/settings/" + id)}><span className="sidebar-link-icon"><SettingsSidebarIcon kind={id as "control"} /></span><span className="sidebar-link-label">{label}</span></button>)}
    </nav></aside></div>
    <div className="app-content"><main className="app-main">
      <RendererI18nContext.Provider value={{locale,source:defaultRendererI18nContextValue.source,t,setLocale:async value=>setLocale(value)}}>
      <Routes><Route path="/settings/:sectionId" element={<SettingsPage
        themeMode={appearance.themeMode} onThemeModeChange={async mode => { await appearance.setThemeMode(mode); }} isMac={platform === "mac"} isWindows={platform === "windows"}
        sidebarNavOrder={[]} availableSidebarNavOrderItems={[]} onSidebarNavOrderChange={noop} marketEnabled={false}
        webItems={empty ? [] : [...websites, ...webapps]} webOpenEntryKeys={[]} runningWebappCount={1}
        copilotAgentOptions={[]} onRefreshCopilotAgentOptions={asyncNoop} webappPublishStateById={{}} onWebItemsRefresh={asyncNoop} debugVisible={true} onCloseDebug={noop}
      />} /></Routes>
      </RendererI18nContext.Provider>
    </main></div>
  </div>;
}
location.hash = "/settings/control";
createRoot(document.getElementById("root")!).render(<HashRouter><AppearanceProvider><ServicesProvider><Preview /></ServicesProvider></AppearanceProvider></HashRouter>);
