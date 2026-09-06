import type { WebContents } from "electron";
import type { DesktopPageContextSnapshot, ServiceState } from "../../../../shared/contracts";
import {
  EmbeddedCdpGateway,
  type EmbeddedCdpSurface,
  type EmbeddedCdpSurfaceTab
} from "./gateway";
import type { BrowserSurfaceRegistry } from "../browser-surface-registry";
import { createServiceSurfaceIdentity } from "../../../../shared/surface-identity";

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
  const surfaceIdentity = createServiceSurfaceIdentity(input.service.id);
  const snapshotBrowserTarget = currentPageSnapshot?.pageContext?.browserTarget;
  const snapshotMatchesService = currentPageSnapshot?.pageKind === "webview" && (
    currentPageSnapshot.surfaceId === surfaceIdentity.surfaceId ||
    snapshotBrowserTarget?.surfaceId === surfaceIdentity.surfaceId ||
    (typeof input.contents?.id === "number" && currentPageSnapshot.webContentsId === input.contents.id)
  );
  const surfaceRoute = snapshotMatchesService
    ? currentPageSnapshot?.surfaceRoute || snapshotBrowserTarget?.surfaceRoute || currentPageSnapshot?.route
    : "";
  const snapshotCurrentUrl = snapshotMatchesService && snapshotBrowserTarget?.kind === "webview"
    ? snapshotBrowserTarget.currentUrl
    : "";
  const documentTitle = snapshotMatchesService ? currentPageSnapshot?.pageContext?.title : "";
  const tabId = `service-tab:${surfaceIdentity.surfaceId}`;
  const currentUrl = snapshotCurrentUrl || input.contents?.getURL() || webUrl;
  const title = documentTitle || input.service.name || input.service.id;
  return {
    ...surfaceIdentity,
    id: surfaceIdentity.surfaceId,
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
    const registeredSurfaces = options.browserSurfaces.listRegisteredSurfaces().map((surface) => ({
      ...surface,
      kind: "webview" as const,
      copilotAgentKey: surface.copilotAgentKey || ""
    }));
    const registeredSurfaceIds = new Set(registeredSurfaces.map((surface) => surface.surfaceId));
    const webviewSurfaces = options.browserSurfaces.listBrowserSurfaces()
      .filter((surface) => !registeredSurfaceIds.has(surface.surfaceId))
      .map((surface) => ({
        ...surface,
        kind: "webview" as const,
        copilotAgentKey: surface.copilotAgentKey || ""
      }));
    const chatWorkPanelSurfaces = options.browserSurfaces.listChatWorkPanelSurfaces()
      .filter((surface) => !registeredSurfaceIds.has(surface.surfaceId))
      .map((surface) => ({
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
        const isCurrentService = currentPageSnapshot?.pageKind === "webview" &&
          currentSurfaceId === createServiceSurfaceIdentity(service.id).surfaceId;
        let contents = isCurrentService
          ? typeof currentPageSnapshot.webContentsId === "number"
            ? options.browserSurfaces.findWebContentsById(currentPageSnapshot.webContentsId)
            : null
          : options.browserSurfaces.findWebContentsForSurfaceUrl(webUrl);
        const registeredTarget = contents
          ? options.browserSurfaces.resolveWebviewSurfaceTarget(contents.id)
          : null;
        if (registeredTarget && registeredTarget.surfaceId !== createServiceSurfaceIdentity(service.id).surfaceId) {
          contents = null;
        }
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
      serviceSurfaces = surfaces.filter((surface): surface is EmbeddedCdpSurface => (
        surface !== null && !registeredSurfaceIds.has(surface.surfaceId)
      ));
    } catch (error) {
      console.warn("[embedded-cdp] failed to list service webview targets", error);
    }

    return [...registeredSurfaces, ...webviewSurfaces, ...serviceSurfaces, ...chatWorkPanelSurfaces];
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
