import type { WebContents } from "electron";
import type { DesktopPageContextSnapshot } from "../shared/contracts";
import {
  BUILTIN_BROWSER_DEFAULT_URL,
  BUILTIN_BROWSER_SURFACE_ID,
  BUILTIN_BROWSER_SURFACE_LABEL
} from "../shared/browser-surfaces";

export type BrowserSurface = {
  id: string;
  label: string;
  url: string;
  active: boolean;
  agentKey?: string;
  currentUrl?: string;
  title?: string;
  webContentsId?: number;
  surfaceRoute?: string;
  embedPath?: string;
};

type WebContentsAccess = {
  getAllWebContents(): WebContents[];
};

export type BrowserSurfaceRegistryOptions = {
  webContents: WebContentsAccess;
  listWebEntries(): { items: Array<{ id: string; entryKey: string; label: string; url: string; agentKey?: string }> };
  getCurrentPageSnapshot(): DesktopPageContextSnapshot | null;
};

export function normalizeSurfaceMatchText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//u, "")
    .replace(/^www\./u, "")
    .replace(/\/+$/u, "");
}

export function webEntryMatchesSurfaceTarget(item: BrowserSurface, target: string) {
  const normalizedTarget = normalizeSurfaceMatchText(target);
  if (!normalizedTarget) {
    return false;
  }
  const candidates = [
    item.id,
    item.label,
    item.url,
    (() => {
      try {
        return new URL(item.url).hostname;
      } catch {
        return "";
      }
    })()
  ].map(normalizeSurfaceMatchText);

  return candidates.some((candidate) =>
    candidate === normalizedTarget ||
    candidate.includes(normalizedTarget) ||
    normalizedTarget.includes(candidate)
  );
}

export function createBrowserSurfaceRegistry(options: BrowserSurfaceRegistryOptions) {
  function currentPageSnapshotMatchesSurface(surfaceId: string, contents?: WebContents | null) {
    const currentPageSnapshot = options.getCurrentPageSnapshot();
    const snapshotBrowserTarget = currentPageSnapshot?.pageContext?.browserTarget;
    return currentPageSnapshot?.pageKind === "webview" && (
      currentPageSnapshot.surfaceId === surfaceId ||
      snapshotBrowserTarget?.surfaceId === surfaceId ||
      (typeof contents?.id === "number" && currentPageSnapshot.webContentsId === contents.id)
    );
  }

  function findWebContentsForSurfaceUrl(surfaceUrl: string) {
    let target: URL | null = null;
    try {
      target = new URL(surfaceUrl);
    } catch {
      return null;
    }

    return options.webContents.getAllWebContents().find((contents) => {
      if (contents.isDestroyed()) {
        return false;
      }
      if (contents.getType() !== "webview") {
        return false;
      }
      try {
        const current = new URL(contents.getURL());
        return (
          current.href === target.href ||
          current.hostname === target.hostname ||
          current.href.startsWith(target.href)
        );
      } catch {
        return false;
      }
    }) ?? null;
  }

  function builtinBrowserSurface(contents: WebContents | null, url = BUILTIN_BROWSER_DEFAULT_URL): BrowserSurface {
    return {
      id: BUILTIN_BROWSER_SURFACE_ID,
      label: BUILTIN_BROWSER_SURFACE_LABEL,
      url,
      active: currentPageSnapshotMatchesSurface(BUILTIN_BROWSER_SURFACE_ID, contents),
      currentUrl: contents?.getURL(),
      title: contents?.getTitle(),
      webContentsId: contents?.id
    };
  }

  function listBrowserSurfaces(): BrowserSurface[] {
    const builtinContents = findWebContentsForSurfaceUrl(BUILTIN_BROWSER_DEFAULT_URL);
    return [
      builtinBrowserSurface(builtinContents),
      ...options.listWebEntries().items.map((item) => {
        const contents = findWebContentsForSurfaceUrl(item.url);
        return {
          id: item.entryKey,
          label: item.label,
          url: item.url,
          agentKey: item.agentKey,
          active: currentPageSnapshotMatchesSurface(item.entryKey, contents),
          currentUrl: contents?.getURL(),
          title: contents?.getTitle(),
          webContentsId: contents?.id
        };
      })
    ];
  }

  return {
    currentPageSnapshotMatchesSurface,
    findWebContentsForSurfaceUrl,
    builtinBrowserSurface,
    listBrowserSurfaces,
    webEntryMatchesSurfaceTarget
  };
}

export type BrowserSurfaceRegistry = ReturnType<typeof createBrowserSurfaceRegistry>;
