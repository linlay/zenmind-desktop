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
  imageId?: string;
  imageSize?: string;
  imageCreatedAt?: string;
  containerEngine?: string;
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
  filePath?: string;
}

export type SandboxImageImportProgressStage =
  | "checking-engine"
  | "extracting"
  | "archive-ready"
  | "loading"
  | "output"
  | "done"
  | "failed";

export interface SandboxImageImportProgressEvent {
  taskId?: string;
  stage: SandboxImageImportProgressStage;
  message: string;
  engine?: string;
  archivePath?: string;
  imageRef?: string;
  stream?: "stdout" | "stderr";
  done?: boolean;
  ok?: boolean;
}

export interface MarketSettings {
  skillsApiBaseUrl: string;
}

export interface MarketSettingsInput {
  skillsApiBaseUrl: string;
}
