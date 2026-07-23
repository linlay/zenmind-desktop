import type { WebContents } from "electron";
import type { DesktopPageContextSnapshot } from "../shared/contracts";
import type {
  EmbeddedCdpSiteSurfaceRegistration,
  EmbeddedCdpSiteSurfaceRemoval,
  EmbeddedCdpSiteSurfaceKind,
  EmbeddedCdpSurfaceKind
} from "../shared/embedded-cdp";
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
  copilotAgentKey?: string;
  currentUrl?: string;
  title?: string;
  webContentsId?: number;
  surfaceRoute?: string;
  embedPath?: string;
  surfaceKind: EmbeddedCdpSurfaceKind;
  open: boolean;
};

type WebContentsAccess = {
  getAllWebContents(): WebContents[];
  fromId(id: number): WebContents | undefined;
};

export type BrowserSurfaceRegistryOptions = {
  webContents: WebContentsAccess;
  listWebEntries(): {
    items: Array<{
      id: string;
      entryKey: string;
      kind: EmbeddedCdpSiteSurfaceKind;
      label: string;
      url: string;
      copilotAgentKey?: string;
    }>;
  };
  getCurrentPageSnapshot(): DesktopPageContextSnapshot | null;
};

type RegisteredSiteSurface = EmbeddedCdpSiteSurfaceRegistration & {
  ownerWebContentsId: number;
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
  const registeredSiteSurfaces = new Map<string, RegisteredSiteSurface>();

  function expectedSiteSurfaceIdPrefix(surfaceKind: EmbeddedCdpSiteSurfaceKind) {
    return `${surfaceKind}:`;
  }

  function isValidSiteSurfaceRegistration(input: EmbeddedCdpSiteSurfaceRegistration) {
    return Boolean(
      input &&
      typeof input.registrationId === "string" &&
      input.registrationId.trim() &&
      typeof input.surfaceId === "string" &&
      input.surfaceId.startsWith(expectedSiteSurfaceIdPrefix(input.surfaceKind)) &&
      (input.surfaceKind === "website" || input.surfaceKind === "webapp") &&
      typeof input.label === "string" &&
      typeof input.url === "string" &&
      typeof input.currentUrl === "string" &&
      typeof input.title === "string" &&
      Number.isSafeInteger(input.webContentsId) &&
      input.webContentsId > 0 &&
      typeof input.active === "boolean"
    );
  }

  function registerSiteSurface(input: EmbeddedCdpSiteSurfaceRegistration, ownerWebContentsId: number) {
    if (!isValidSiteSurfaceRegistration(input) || !Number.isSafeInteger(ownerWebContentsId)) {
      return false;
    }
    registeredSiteSurfaces.set(input.surfaceId, {
      ...input,
      registrationId: input.registrationId.trim(),
      surfaceId: input.surfaceId.trim(),
      label: input.label.trim(),
      url: input.url.trim(),
      currentUrl: input.currentUrl.trim(),
      title: input.title.trim(),
      ownerWebContentsId
    });
    return true;
  }

  function unregisterSiteSurface(input: EmbeddedCdpSiteSurfaceRemoval, ownerWebContentsId: number) {
    const surfaceId = typeof input?.surfaceId === "string" ? input.surfaceId.trim() : "";
    const registrationId = typeof input?.registrationId === "string" ? input.registrationId.trim() : "";
    const current = registeredSiteSurfaces.get(surfaceId);
    if (
      !current ||
      current.registrationId !== registrationId ||
      current.ownerWebContentsId !== ownerWebContentsId
    ) {
      return false;
    }
    registeredSiteSurfaces.delete(surfaceId);
    return true;
  }

  function unregisterSiteSurfacesForOwner(ownerWebContentsId: number) {
    for (const [surfaceId, surface] of registeredSiteSurfaces) {
      if (surface.ownerWebContentsId === ownerWebContentsId) {
        registeredSiteSurfaces.delete(surfaceId);
      }
    }
  }

  function resolveRegisteredSiteSurface(surfaceId: string) {
    const registered = registeredSiteSurfaces.get(surfaceId);
    if (!registered) {
      return null;
    }
    const contents = options.webContents.fromId(registered.webContentsId);
    if (!contents || contents.isDestroyed() || contents.getType() !== "webview") {
      registeredSiteSurfaces.delete(surfaceId);
      return null;
    }
    return { registered, contents };
  }

  function findRegisteredSiteWebContents(surfaceId: string) {
    return resolveRegisteredSiteSurface(surfaceId)?.contents ?? null;
  }

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
      webContentsId: contents?.id,
      surfaceKind: "browser",
      open: Boolean(contents)
    };
  }

  function listBrowserSurfaces(): BrowserSurface[] {
    const builtinContents = findWebContentsForSurfaceUrl(BUILTIN_BROWSER_DEFAULT_URL);
    return [
      builtinBrowserSurface(builtinContents),
      ...options.listWebEntries().items.map((item) => {
        const resolved = resolveRegisteredSiteSurface(item.entryKey);
        const contents = resolved?.contents ?? null;
        return {
          id: item.entryKey,
          label: item.label,
          url: item.url,
          copilotAgentKey: item.copilotAgentKey,
          active: Boolean(resolved?.registered.active) &&
            currentPageSnapshotMatchesSurface(item.entryKey, contents),
          currentUrl: contents?.getURL(),
          title: contents?.getTitle(),
          webContentsId: contents?.id,
          surfaceKind: item.kind,
          open: Boolean(contents)
        };
      })
    ];
  }

  return {
    currentPageSnapshotMatchesSurface,
    findWebContentsForSurfaceUrl,
    findRegisteredSiteWebContents,
    builtinBrowserSurface,
    listBrowserSurfaces,
    registerSiteSurface,
    unregisterSiteSurface,
    unregisterSiteSurfacesForOwner,
    webEntryMatchesSurfaceTarget
  };
}

export type BrowserSurfaceRegistry = ReturnType<typeof createBrowserSurfaceRegistry>;
