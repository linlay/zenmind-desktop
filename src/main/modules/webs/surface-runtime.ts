import type { App, BrowserWindow, WebContents } from "electron";
import type { CopilotDevToolsTarget, DesktopPageContextSnapshot } from "../../../shared/contracts";
import {
  createBrowserSurfaceRegistry,
  type BrowserSurfaceRegistryOptions
} from "../web-surfaces";
import { listWebEntries } from "./ipc";
import type { WebsFacade } from "./facade";
import {
  BUILTIN_BROWSER_DEFAULT_URL,
  BUILTIN_BROWSER_ROUTE,
  BUILTIN_BROWSER_SURFACE_LABEL,
  isBuiltinBrowserSurfaceTarget,
  resolveBuiltinBrowserUrl
} from "../../../shared/browser-surfaces";

export type WebSurfaceRuntimeOptions = {
  app: App;
  websFacade: WebsFacade;
  getMainWindow: () => BrowserWindow | null;
  webContents: BrowserSurfaceRegistryOptions["webContents"];
  reportRegistrationDiagnostic?: BrowserSurfaceRegistryOptions["reportRegistrationDiagnostic"];
  navigateMainWindow: (targetPath: string) => void;
  delay: (ms: number) => Promise<void>;
  t: (key: any, values?: any) => string;
};

export function createWebSurfaceRuntime(options: WebSurfaceRuntimeOptions) {
  let currentPageSnapshot: DesktopPageContextSnapshot | null = null;
  let copilotDevToolsTarget: CopilotDevToolsTarget | null = null;

  function listBrowserRegistryWebItems() {
    const entries = listWebEntries(options.app, options.websFacade.webappManager).items;
    const items: Array<{
      id: string;
      entryKey: string;
      kind: "website" | "webapp";
      label: string;
      url: string;
      copilotAgentKey?: string;
    }> = [];
    for (const item of entries) {
      if (item.kind === "website") {
        items.push({
          id: item.id,
          entryKey: item.entryKey,
          kind: item.kind,
          label: item.label,
          url: item.url,
          copilotAgentKey: item.copilotAgentKey
        });
        continue;
      }
      const state = options.websFacade.webappRuntime.getStatus(options.app, item.id);
      if (state?.webUrl) {
        items.push({
          id: item.id,
          entryKey: item.entryKey,
          kind: item.kind,
          label: item.label,
          url: state.webUrl,
          copilotAgentKey: item.copilotAgentKey
        });
      }
    }
    return { items };
  }

  const browserSurfaceRegistry = createBrowserSurfaceRegistry({
    webContents: options.webContents,
    listWebEntries: listBrowserRegistryWebItems,
    getCurrentPageSnapshot: () => currentPageSnapshot,
    reportRegistrationDiagnostic: options.reportRegistrationDiagnostic,
  });

  async function openBrowserUrl(input: {
    url: string;
    label?: string;
    requireOperableTarget?: boolean;
    partition?: string;
    userAgent?: string;
  }) {
    const targetUrl = input.url || BUILTIN_BROWSER_DEFAULT_URL;
    options.navigateMainWindow(BUILTIN_BROWSER_ROUTE);
    await options.delay(450);
    options.getMainWindow()?.webContents.send("webview.openTab", {
      target: "desktop-browser",
      navigationKind: "network",
      sourceGuestId: -1,
      url: targetUrl,
      partition: input.partition,
      userAgent: input.userAgent
    });
    if (input.requireOperableTarget === false) {
      return {
        ok: true,
        action: "open_url",
        target: targetUrl,
        url: targetUrl,
        message: options.t("main.sentToBuiltinBrowser", { label: input.label || targetUrl })
      };
    }
    for (let attempt = 0; attempt < 32; attempt += 1) {
      await options.delay(250);
      const contents = browserSurfaceRegistry.findWebContentsForSurfaceUrl(targetUrl);
      if (contents) {
        const surface = browserSurfaceRegistry.builtinBrowserSurface(contents, targetUrl);
        return {
          ok: true,
          action: "open_url",
          target: targetUrl,
          url: contents.getURL(),
          title: contents.getTitle(),
          message: options.t("main.builtinBrowserOpened", { label: input.label || BUILTIN_BROWSER_SURFACE_LABEL }),
          data: {
            surface
          }
        };
      }
    }
    return {
      ok: false,
      action: "open_url",
      target: targetUrl,
      url: targetUrl,
      error: "browser_webview_not_ready",
      message: options.t("main.builtinBrowserNotReady", { label: input.label || targetUrl })
    };
  }

  async function activateBrowserSurface(target: string) {
    if (isBuiltinBrowserSurfaceTarget(target)) {
      return openBrowserUrl(resolveBuiltinBrowserUrl(target));
    }
    const surfaces = browserSurfaceRegistry.listBrowserSurfaces();
    const surface = surfaces.find((candidate) => browserSurfaceRegistry.webEntryMatchesSurfaceTarget(candidate, target));
    if (!surface) {
      return {
        ok: false,
        action: "activate_surface",
        target,
        error: "surface_not_found",
        message: options.t("main.embeddedSurfaceNotFound", { target }),
        data: {
          surfaces
        }
      };
    }

    options.navigateMainWindow(`/webs/${surface.entryKey || surface.id}`);
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await options.delay(250);
      const contents = browserSurfaceRegistry.findWebContentsForSurfaceUrl(surface.url);
      if (contents) {
        const activatedSurface = {
          ...surface,
          active: true,
          currentUrl: contents.getURL(),
          title: contents.getTitle(),
          webContentsId: contents.id
        };
        return {
          ok: true,
          action: "activate_surface",
          target,
          url: activatedSurface.currentUrl,
          title: activatedSurface.title,
          message: options.t("main.embeddedSurfaceOpened", { label: activatedSurface.label }),
          data: {
            surface: activatedSurface
          }
        };
      }
    }

    return {
      ok: false,
      action: "activate_surface",
      target,
      url: surface.url,
      error: "surface_load_timeout",
      message: options.t("main.embeddedSurfaceNotReady", { label: surface.label }),
      data: {
        surface
      }
    };
  }

  return {
    browserSurfaceRegistry,
    getCurrentPageSnapshot: () => currentPageSnapshot,
    setCurrentPageSnapshot: (snapshot: DesktopPageContextSnapshot | null) => {
      currentPageSnapshot = snapshot;
    },
    getCopilotDevToolsTarget: () => copilotDevToolsTarget,
    setCopilotDevToolsTarget: (target: CopilotDevToolsTarget | null) => {
      copilotDevToolsTarget = target;
    },
    listBrowserRegistryWebItems,
    openBrowserUrl,
    activateBrowserSurface
  };
}

export type WebSurfaceRuntime = ReturnType<typeof createWebSurfaceRuntime>;
