export type MarketItemType = "plugin" | "skill" | "sandbox-image";
export type MarketInstallState =
  | "not-installed"
  | "installed"
  | "update-available"
  | "local-imported"
  | "incompatible"
  | "installing"
  | "failed";

export interface MarketAsset {
  url: string;
  sha256?: string;
  sizeBytes: number;
  archiveType: "tar.gz" | "zip" | "skill" | "md";
  platform?: string;
}

export interface MarketCatalogItem {
  id: string;
  type: MarketItemType;
  name: string;
  version: string;
  description: string;
  tags: string[];
  minDesktopVersion?: string;
  assets: Record<string, MarketAsset>;
}

export interface MarketItem {
  id: string;
  type: MarketItemType;
  name: string;
  version: string;
  description: string;
  tags: string[];
  state: MarketInstallState;
  source: "cloud" | "local";
  installedVersion?: string;
  installPath?: string;
  serviceId?: string;
  message?: string;
  environmentName?: string;
  imageRef?: string;
  buildStatus?: string;
  buildJobId?: string;
  buildTargetCount?: number;
}

export interface MarketListResult {
  ok: boolean;
  sourceUrl: string;
  offline: boolean;
  message: string;
  items: MarketItem[];
  sandboxMessage?: string;
  sandboxOffline?: boolean;
}

export interface MarketCommandResult {
  ok: boolean;
  itemId: string;
  type: MarketItemType;
  state: MarketInstallState;
  message: string;
  serviceId?: string;
  installPath?: string;
  environmentName?: string;
  imageRef?: string;
  buildJobId?: string;
  buildStatus?: string;
  buildTarget?: string;
}

export interface MarketSettings {
  skillsApiBaseUrl: string;
}

export interface MarketSettingsInput {
  skillsApiBaseUrl: string;
}
