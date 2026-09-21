import { type App } from "electron";
import { type BrowserSurfaceRegistry } from "../modules/web-surfaces";
import { type AgentRealtimeDebugTarget } from "../../shared/contracts";

export function sanitizeRealtimeDiagnosticUrl(value: string) {
  const normalized = value.trim();
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol === "file:") return "file:///(redacted)";
    if (parsed.protocol === "data:" || parsed.protocol === "blob:") return `${parsed.protocol}(redacted)`;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().slice(0, 512);
  } catch {
    return normalized.split(/[?#]/u, 1)[0].slice(0, 512);
  }
}

export function createAgentRealtimeRuntimeDiagnostics(
  app: App,
  browserSurfaces: BrowserSurfaceRegistry,
) {
  const webContentsSnapshots = browserSurfaces.listWebContentsDiagnostics();
  const webContentsById = new Map(webContentsSnapshots.map((contents) => [contents.webContentsId, contents]));
  const claimedWebContentsIds = new Set<number>();
  const surfaces = browserSurfaces.listDiagnosticSurfaces();
  const targets: AgentRealtimeDebugTarget[] = surfaces.flatMap((surface): AgentRealtimeDebugTarget[] => {
    if (surface.tabs.length === 0) {
      return [{
        targetId: `surface:${surface.registrationId}`,
        surfaceId: surface.surfaceId,
        registrationId: surface.registrationId,
        label: surface.label,
        surfaceKind: surface.surfaceKind,
        surfaceType: surface.surfaceType,
        surfaceRole: surface.surfaceRole,
        surfaceLevel: surface.surfaceLevel,
        ...(surface.parentSurfaceId ? { parentSurfaceId: surface.parentSurfaceId } : {}),
        interaction: surface.interaction,
        ...(surface.ownerChatId ? { ownerChatId: surface.ownerChatId } : {}),
        ownerWebContentsId: surface.ownerWebContentsId,
        url: sanitizeRealtimeDiagnosticUrl(surface.pageRoute || surface.url),
        title: surface.label,
        active: surface.active,
        loading: false,
        crashed: false,
        devToolsOpened: false,
        backgroundThrottling: true,
        orphaned: false,
      }];
    }
    return surface.tabs.map((tab) => {
      claimedWebContentsIds.add(tab.webContentsId);
      const contents = webContentsById.get(tab.webContentsId);
      return {
        targetId: `surface:${surface.registrationId}:${tab.tabId}`,
        surfaceId: surface.surfaceId,
        registrationId: surface.registrationId,
        label: surface.tabs.length > 1 ? tab.title || surface.label : surface.label,
        surfaceKind: surface.surfaceKind,
        surfaceType: surface.surfaceType,
        surfaceRole: surface.surfaceRole,
        surfaceLevel: surface.surfaceLevel,
        ...(surface.parentSurfaceId ? { parentSurfaceId: surface.parentSurfaceId } : {}),
        interaction: surface.interaction,
        ...(surface.ownerChatId ? { ownerChatId: surface.ownerChatId } : {}),
        ownerWebContentsId: surface.ownerWebContentsId,
        webContentsId: tab.webContentsId,
        ...(contents ? { webContentsType: contents.type, pid: contents.osProcessId } : {}),
        url: sanitizeRealtimeDiagnosticUrl(tab.currentUrl || surface.pageRoute || surface.url),
        title: tab.title || surface.label,
        active: surface.active && surface.activeTabId === tab.tabId,
        loading: contents?.loading ?? tab.isLoading,
        crashed: contents?.crashed ?? false,
        devToolsOpened: contents?.devToolsOpened ?? false,
        backgroundThrottling: contents?.backgroundThrottling ?? true,
        orphaned: false,
      };
    });
  });
  for (const contents of webContentsSnapshots) {
    if (claimedWebContentsIds.has(contents.webContentsId)) continue;
    const orphaned = contents.type === "webview";
    targets.push({
      targetId: `webcontents:${contents.webContentsId}`,
      label: contents.title || `${contents.type} ${contents.webContentsId}`,
      webContentsId: contents.webContentsId,
      webContentsType: contents.type,
      pid: contents.osProcessId,
      url: sanitizeRealtimeDiagnosticUrl(contents.url),
      title: contents.title,
      active: false,
      loading: contents.loading,
      crashed: contents.crashed,
      devToolsOpened: contents.devToolsOpened,
      backgroundThrottling: contents.backgroundThrottling,
      orphaned,
    });
  }
  const targetCountByPid = new Map<number, number>();
  for (const target of targets) {
    if (typeof target.pid !== "number" || target.pid <= 0) continue;
    targetCountByPid.set(target.pid, (targetCountByPid.get(target.pid) || 0) + 1);
  }
  const processes = app.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    ...(metric.name ? { name: metric.name } : {}),
    ...(metric.serviceName ? { serviceName: metric.serviceName } : {}),
    cpuPercent: metric.cpu.percentCPUUsage,
    creationTime: metric.creationTime,
    ...(typeof metric.sandboxed === "boolean" ? { sandboxed: metric.sandboxed } : {}),
    workingSetBytes: metric.memory.workingSetSize * 1024,
    peakWorkingSetBytes: metric.memory.peakWorkingSetSize * 1024,
    ...(typeof metric.memory.privateBytes === "number"
      ? { privateBytes: metric.memory.privateBytes * 1024 }
      : {}),
    targetCount: targetCountByPid.get(metric.pid) || 0,
  }));
  return {
    surfaceCount: new Set(surfaces.map((surface) => surface.surfaceId)).size,
    webviewCount: webContentsSnapshots.filter((contents) => contents.type === "webview").length,
    orphanWebviewCount: targets.filter((target) => target.orphaned).length,
    totalWorkingSetBytes: processes.reduce((total, item) => total + item.workingSetBytes, 0),
    processes,
    targets,
  };
}
