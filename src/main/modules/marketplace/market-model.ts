import type { MarketCatalogItem, MarketItemType, MarketListOptions, MarketItem } from "../../../shared/contracts";
import type { PluginLifecycle } from "../plugins";
import type { WebsFacade } from "../webs";
import type { App } from "electron";
import { t } from "../../support/i18n/main-i18n";

export const DEFAULT_MARKET_API_BASE_URL = "";

export const DEFAULT_MARKETPLACE_CATALOG_URL = "";

export const MARKET_API_VERSION_PATH = "/api/v1";

export const MARKET_AUTH_ME_PATH = "/auth/me";

export const MARKET_DESKTOP_CATALOG_PATH = "/desktop/catalog";

export const MAX_MARKET_DOWNLOAD_BYTES = 512 * 1024 * 1024;

export type Catalog = {
  schemaVersion: number;
  generatedAt?: string;
  items: MarketCatalogItem[];
};

export type InstalledRecord = {
  id: string;
  type: MarketItemType;
  version: string;
  platform?: string;
  source: "cloud" | "local";
  assetUrl?: string;
  sha256?: string;
  installPath?: string;
  resourceKey?: string;
  skillPackage?: boolean;
  installedAt: string;
};

export type MarketplaceOptions = MarketListOptions & {
  plugins?: PluginLifecycle;
  catalogSnapshot?: unknown;
  catalogUrl?: string;
  catalog?: Catalog;
  apiBaseUrl?: string;
  marketEnabled?: boolean;
  containerHubBaseUrl?: string;
  containerHubAuthToken?: string;
  fetchImpl?: typeof fetch;
  issueMarketAccessToken?: MarketAccessTokenIssuer;
  /** Main-process identity snapshot; null keeps browsing anonymous. Never supplied by renderer IPC. */
  readMarketViewer?: () => string | null;
  createContainerHubClient?: (config: {
    baseURL: string;
    authToken?: string;
    timeoutMs?: number;
    defaultEnvironmentName?: string;
  }) => any;
  webs?: Pick<
    WebsFacade,
    | "disposeWebappInstallation"
    | "webappRuntime"
    | "webappWindowManager"
  >;
};

export type MarketAccessTokenReason = "missing" | "unauthorized";

export type MarketAccessTokenIssuer = (
  app: App,
  reason: MarketAccessTokenReason
) => Promise<string> | string;

export type InstallableMarketType = MarketItemType;

export type MarketSectionResult = {
  items: MarketItem[];
  offline: boolean;
  message: string;
  sourceUrl?: string;
};

export type MarketplaceCatalogResult = {
  catalog: Catalog;
  offline: boolean;
  message: string;
  sourceUrl: string;
};

export class MarketCatalogItemNotFoundError extends Error {
  readonly code = "market_catalog_item_not_found";
  readonly itemId: string;

  constructor(itemId: string) {
    super(t("market.main.catalogItemNotFound", { itemId }));
    this.name = "MarketCatalogItemNotFoundError";
    this.itemId = itemId;
  }
}
