import { randomUUID } from "node:crypto";
import type { App, BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type { MarketCommandResult, MarketLinkDetail } from "../../../shared/contracts";
import { APP_BRAND } from "../../../shared/brand";
import { t } from "../../support/i18n/main-i18n";
import { isTunnelHubForbiddenHostname, isTunnelHubLoopbackHostname } from "../../infrastructure/network/tunnel-url-policy";
import { loadMarketplaceCatalog } from "./catalog-client";
import { isMarketItemType } from "./catalog-normalization";
import { assertMarketLinkViewer, readMarketViewer } from "./market-http";
import { getMarketSettings, normalizeMarketApiBaseUrl } from "./market-settings";
import type { MarketplaceOptions } from "./market-model";

export function registerMarketBusinessLinks(options: {
  app: App;
  ipc: Pick<IpcMain, "handle">;
  getMainWindow(): BrowserWindow | null;
  confirmInstall(detail: MarketLinkDetail, install: () => Promise<MarketCommandResult>): Promise<MarketCommandResult | null>;
  install(itemId: string, options: MarketplaceOptions): Promise<MarketCommandResult>;
}) {
  let generation = 0;
  let active: { id: string; detail: MarketLinkDetail; request: MarketplaceOptions; install?: () => Promise<MarketCommandResult | null>; running?: Promise<MarketCommandResult | null> } | undefined;
  function ownsRoute(urlString: string, id: string) {
    const url = new URL(urlString);
    const route = url.hash.startsWith("#/") ? new URL(url.hash.slice(1), "https://desktop.invalid") : url;
    return route.pathname === "/market" && route.searchParams.get("linkTarget") === id;
  }
  function getTarget(event: IpcMainInvokeEvent, id: unknown) {
    const contents = options.getMainWindow()?.webContents;
    if (!active || id !== active.id || !contents || event.sender !== contents || event.senderFrame !== contents.mainFrame ||
        !ownsRoute(event.senderFrame.url, active.id)) return null;
    assertMarketLinkViewer(options.app, active.request);
    return active;
  }
  options.ipc.handle("market.linkDetail", (event, id: unknown) => {
    const target = getTarget(event, id);
    return target ? { ...target.detail, install: Boolean(target.install) } : null;
  });
  options.ipc.handle("market.installLinkedItem", (event, id: unknown) => {
    const target = getTarget(event, id);
    if (!target?.install) return null;
    return target.running ??= target.install();
  });

  return async (params: ReadonlyMap<string, string>, install: boolean, navigate: (route: string) => void) => {
    const operation = ++generation;
    active = undefined;
    const source = params.get("source");
    const itemId = params.get("itemId");
    const expectedType = params.get("resourceType");
    const version = params.get("version");
    if (!source || !itemId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/u.test(itemId) || !isMarketItemType(expectedType) ||
        [...params.keys()].some(key => !["source", "itemId", "resourceType"].includes(key) && !(install && key === "version")) ||
        (version !== undefined && (!version.trim() || version !== version.trim() || /\p{Cc}/u.test(version)))) {
      throw new Error("Invalid market link parameters");
    }
    const url = new URL(source);
    if (url.protocol !== "https:" || source !== url.origin + url.pathname || /%2f|%5c/iu.test(url.pathname) || isTunnelHubLoopbackHostname(url.hostname) ||
        isTunnelHubForbiddenHostname(url.hostname)) throw new Error("Invalid market API source");
    const base = normalizeMarketApiBaseUrl(source);
    const configured = () => {
      const settings = getMarketSettings(options.app);
      return settings.enabled && base === settings.apiBaseUrl;
    };
    const official = base === APP_BRAND.marketApiBaseUrl;
    const trusted = official || configured();
    const request: MarketplaceOptions = {
      apiBaseUrl: base,
      expectedType,
      linkSource: {
        base,
        trusted,
        viewer: readMarketViewer(options.app),
        assertCurrent() {
          if (generation !== operation || (trusted && !official && !configured())) throw new Error(t("market.share.versionChanged"));
        },
      },
    };
    const result = await loadMarketplaceCatalog(options.app, request);
    if (generation !== operation) return;
    if (result.offline) throw new Error(result.message);
    const matches = result.catalog.items.filter(item => item.type === expectedType && item.id === itemId);
    if (matches.length !== 1) throw new Error(t("market.main.catalogItemNotFound", { itemId }));
    const item = matches[0];
    if (!item.version || (version !== undefined && version !== item.version)) throw new Error(t("market.share.versionChanged"));
    assertMarketLinkViewer(options.app, request);
    const detail = { source: base, id: item.id, type: item.type, version: item.version, name: item.name,
      description: item.description, author: item.author, tags: item.tags };
    const id = randomUUID();
    active = { id, detail, request, install: install ? () => options.confirmInstall(detail, () => {
      const contents = options.getMainWindow()?.webContents;
      if (!contents || !ownsRoute(contents.mainFrame.url, id)) throw new Error(t("market.share.versionChanged"));
      assertMarketLinkViewer(options.app, request);
      return options.install(itemId, { ...request, expectedVersion: item.version });
    }) : undefined };
    navigate("/market?linkTarget=" + id);
  };
}
