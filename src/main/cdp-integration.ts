import type { WebContents } from "electron";
import type { DesktopPageContextSnapshot, ServiceState } from "../shared/contracts";
import { BUILTIN_BROWSER_SURFACE_ID } from "../shared/browser-surfaces";
import {
  EmbeddedCdpGateway,
  type EmbeddedCdpSurface
} from "./embedded-cdp-gateway";
import type { BrowserSurfaceRegistry } from "./browser-surface-registry";

type ServiceLister = () => Promise<ServiceState[]> | ServiceState[];

type CdpIntegrationOptions = {
  browserSurfaces: BrowserSurfaceRegistry;
  getCurrentPageSnapshot(): DesktopPageContextSnapshot | null;
  listServices: ServiceLister;
  isLoopbackUrl(value: string): unknown;
  openBrowserUrl(input: { url: string; label?: string }): Promise<unknown>;
  activateBrowserSurface(target: string): Promise<unknown>;
  showMainWindow(targetPath: string): void;
  delay(ms: number): Promise<void>;
  assistantTargetPath: string;
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
  return {
    id: input.service.id,
    label: input.service.name || input.service.id,
    url: webUrl,
    kind: "webview",
    active: snapshotMatchesService,
    currentUrl: snapshotCurrentUrl || input.contents?.getURL(),
    title: documentTitle || input.service.name || input.service.id,
    webContentsId: input.contents?.id,
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

    let serviceSurfaces: EmbeddedCdpSurface[] = [];
    try {
      const services = await options.listServices();
      const surfaces = await Promise.all(services.map(async (service): Promise<EmbeddedCdpSurface | null> => {
        const webUrl = service.status === "running" ? service.healthMeta.webUrl.trim() : "";
        const surface = createEmbeddedCdpServiceSurface({
          service,
          currentPageSnapshot: options.getCurrentPageSnapshot(),
          contents: options.browserSurfaces.findWebContentsForSurfaceUrl(webUrl),
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

    return [...webviewSurfaces, ...serviceSurfaces];
  }

  function resolveWebContents(surface: EmbeddedCdpSurface): WebContents | null {
    if (surface.webContentsId) {
      const contents = options.browserSurfaces.findWebContentsForSurfaceUrl(surface.currentUrl || surface.url);
      if (contents && contents.id === surface.webContentsId && !contents.isDestroyed() && contents.getType() === "webview") {
        return contents;
      }
    }
    return options.browserSurfaces.findWebContentsForSurfaceUrl(surface.currentUrl || surface.url);
  }

  async function activateSurface(surface: EmbeddedCdpSurface) {
    if (surface.id === BUILTIN_BROWSER_SURFACE_ID) {
      await options.openBrowserUrl({ url: surface.currentUrl || surface.url, label: surface.label });
      return;
    }
    try {
      const services = await options.listServices();
      if (services.some((service) => service.id === surface.id)) {
        const targetPath = surface.id === "agent-webclient" ? options.assistantTargetPath : `/service/${surface.id}`;
        options.showMainWindow(targetPath);
        await options.delay(450);
        return;
      }
    } catch {
      // Fall through to custom sidebar activation if service state is unavailable.
    }
    await options.activateBrowserSurface(surface.id || surface.url);
  }

  async function openUrl(url: string) {
    await options.openBrowserUrl({ url });
  }

  function start() {
    if (embeddedCdpGateway) {
      return embeddedCdpGateway;
    }
    embeddedCdpGateway = new EmbeddedCdpGateway({
      getSurfaces: listSurfaces,
      resolveWebContents,
      activateSurface,
      openUrl,
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
    activateSurface,
    openUrl,
    start,
    stop
  };
}
