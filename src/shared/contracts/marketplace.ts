export type MarketItemType = "plugin" | "skill" | "agent" | "sandbox-image" | "pet" | "cli" | "website-app";
export type MarketSection = "plugins" | "skills" | "agents" | "sandboxImages" | "pets" | "cli" | "websiteApps";
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
  archiveType:
    | "tar.gz"
    | "zip"
    | "skill"
    | "md"
    | "agent"
    | "sandbox-template"
    | "container-image"
    | "pet"
    | "cli"
    | "website-app";
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
  sandboxKind?: "environment-template" | "container-image";
  metadata?: Record<string, string>;
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
  sandboxKind?: "environment-template" | "container-image";
  metadata?: Record<string, string>;
  homepageUrl?: string;
  cliInstallCommand?: string;
  cliUninstallCommand?: string;
  cliDetailCommand?: string;
  petPreviewAssetPath?: string;
}

export interface MarketListResult {
  ok: boolean;
  sourceUrl: string;
  offline: boolean;
  message: string;
  items: MarketItem[];
  pluginMessage?: string;
  pluginOffline?: boolean;
  skillMessage?: string;
  skillOffline?: boolean;
  agentMessage?: string;
  agentOffline?: boolean;
  sandboxMessage?: string;
  sandboxOffline?: boolean;
  petMessage?: string;
  petOffline?: boolean;
  cliMessage?: string;
  cliOffline?: boolean;
  websiteAppMessage?: string;
  websiteAppOffline?: boolean;
}

export interface MarketListOptions {
  sections?: MarketSection[];
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
  sandboxKind?: "environment-template" | "container-image";
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
  marketApiBaseUrl: string;
}

export interface MarketSettingsInput {
  marketApiBaseUrl?: string;
}
