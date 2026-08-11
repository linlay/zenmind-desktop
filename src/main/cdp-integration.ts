import type { WebContents } from "electron";
import type { DesktopPageContextSnapshot, ServiceState } from "../shared/contracts";
import {
  EmbeddedCdpGateway,
  type EmbeddedCdpSurface,
  type EmbeddedCdpSurfaceTab
} from "./embedded-cdp-gateway";
import type { BrowserSurfaceRegistry } from "./browser-surface-registry";

type ServiceLister = () => Promise<ServiceState[]> | ServiceState[];

type CdpIntegrationOptions = {
  browserSurfaces: BrowserSurfaceRegistry;
  getCurrentPageSnapshot(): DesktopPageContextSnapshot | null;
  listServices: ServiceLister;
  isLoopbackUrl(value: string): unknown;
  switchTab(surfaceId: string, tabId: string, ownerChatId?: string): Promise<unknown>;
  closeTab(surfaceId: string, tabId: string, ownerChatId?: string): Promise<unknown>;
  version: string;
};

type ServiceSurfaceInput = {
  service: Pick<ServiceState, "id" | "name" | "status" | "frontendMode"> & {
    healthMeta?: { webUrl?: string };
  };
  currentPageSnapshot: DesktopPageContextSnapshot | null;
  contents?: Pick<WebContents, "id" | "getURL" | "getTitle"> | null;
  isLoopbackUrl(value: string): unknown;
};

export function createEmbeddedCdpServiceSurface(input: ServiceSurfaceInput): EmbeddedCdpSurface | null {
  const webUrl = input.service.status === "running" ? String(input.service.healthMeta?.webUrl ?? "").trim() : "";
  if (input.service.frontendMode === "none" || !webUrl || !input.isLoopbackUrl(webUrl)) {
    return null;
  }
  const currentPageSnapshot = input.currentPageSnapshot;
  const snapshotBrowserTarget = currentPageSnapshot?.pageContext?.browserTarget;
  const snapshotMatchesService = currentPageSnapshot?.pageKind === "webview" && (
    currentPageSnapshot.surfaceId === input.service.id ||
    snapshotBrowserTarget?.surfaceId === input.service.id ||
    (typeof input.contents?.id === "number" && currentPageSnapshot.webContentsId === input.contents.id)
  );
  const surfaceRoute = snapshotMatchesService
    ? currentPageSnapshot?.surfaceRoute || snapshotBrowserTarget?.surfaceRoute || currentPageSnapshot?.route
    : "";
  const snapshotCurrentUrl = snapshotMatchesService && snapshotBrowserTarget?.kind === "webview"
    ? snapshotBrowserTarget.currentUrl
    : "";
  const documentTitle = snapshotMatchesService ? currentPageSnapshot?.pageContext?.title : "";
  const tabId = `service-tab:${input.service.id}`;
  const currentUrl = snapshotCurrentUrl || input.contents?.getURL() || webUrl;
  const title = documentTitle || input.service.name || input.service.id;
  return {
    id: input.service.id,
    label: input.service.name || input.service.id,
    url: webUrl,
    kind: "webview",
    active: snapshotMatchesService,
    currentUrl,
    title,
    webContentsId: input.contents?.id,
    surfaceKind: "service",
    open: Boolean(input.contents),
    tabs: input.contents
      ? [{
          tabId,
          currentUrl,
          title,
          webContentsId: input.contents.id
        }]
      : [],
    activeTabId: input.contents ? tabId : null,
    ...(surfaceRoute ? { surfaceRoute } : {}),
    ...(snapshotMatchesService && currentPageSnapshot?.embedPath ? { embedPath: currentPageSnapshot.embedPath } : {})
  };
}

export function createCdpIntegration(options: CdpIntegrationOptions) {
  let embeddedCdpGateway: EmbeddedCdpGateway | null = null;

  async function listSurfaces(): Promise<EmbeddedCdpSurface[]> {
    const webviewSurfaces = options.browserSurfaces.listBrowserSurfaces().map((surface) => ({
      ...surface,
      kind: "webview" as const,
      copilotAgentKey: surface.copilotAgentKey || ""
    }));
    const chatWorkPanelSurfaces = options.browserSurfaces.listChatWorkPanelSurfaces().map((surface) => ({
      ...surface,
      kind: "webview" as const
    }));

    let serviceSurfaces: EmbeddedCdpSurface[] = [];
    try {
      const services = await options.listServices();
      const currentPageSnapshot = options.getCurrentPageSnapshot();
      const currentSurfaceId = currentPageSnapshot?.surfaceId ||
        currentPageSnapshot?.pageContext?.browserTarget?.surfaceId ||
        "";
      const surfaces = await Promise.all(services.map(async (service): Promise<EmbeddedCdpSurface | null> => {
        const webUrl = service.status === "running" ? service.healthMeta.webUrl.trim() : "";
        const isCurrentService = currentPageSnapshot?.pageKind === "webview" && currentSurfaceId === service.id;
        const contents = isCurrentService
          ? typeof currentPageSnapshot.webContentsId === "number"
            ? options.browserSurfaces.findWebContentsById(currentPageSnapshot.webContentsId)
            : null
          : options.browserSurfaces.findWebContentsForSurfaceUrl(webUrl);
        const surface = createEmbeddedCdpServiceSurface({
          service,
          currentPageSnapshot,
          contents,
          isLoopbackUrl: options.isLoopbackUrl
        });
        if (!surface) {
          return null;
        }
        return surface;
      }));
      serviceSurfaces = surfaces.filter((surface): surface is EmbeddedCdpSurface => surface !== null);
    } catch (error) {
      console.warn("[embedded-cdp] failed to list service webview targets", error);
    }

    return [...webviewSurfaces, ...serviceSurfaces, ...chatWorkPanelSurfaces];
  }

  function resolveWebContents(_surface: EmbeddedCdpSurface, tab: EmbeddedCdpSurfaceTab): WebContents | null {
    return options.browserSurfaces.findWebContentsById(tab.webContentsId);
  }

  async function activateTarget(surface: EmbeddedCdpSurface, tab: EmbeddedCdpSurfaceTab) {
    if (surface.activeTabId === tab.tabId || (surface.tabs?.length ?? 0) <= 1) {
      return;
    }
    await options.switchTab(surface.id, tab.tabId, surface.ownerChatId);
  }

  async function closeTarget(surface: EmbeddedCdpSurface, tab: EmbeddedCdpSurfaceTab) {
    return options.closeTab(surface.id, tab.tabId, surface.ownerChatId);
  }

  function start() {
    if (embeddedCdpGateway) {
      return embeddedCdpGateway;
    }
    embeddedCdpGateway = new EmbeddedCdpGateway({
      getSurfaces: listSurfaces,
      resolveWebContents,
      activateTarget,
      closeTarget,
      version: options.version
    });
    embeddedCdpGateway.start();
    return embeddedCdpGateway;
  }

  async function stop() {
    const gateway = embeddedCdpGateway;
    embeddedCdpGateway = null;
    await gateway?.stop();
  }

  return {
    listSurfaces,
    resolveWebContents,
    activateTarget,
    closeTarget,
    start,
    stop
  };
}
