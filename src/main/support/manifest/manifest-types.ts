import {
  type Manifest,
  type ServiceId,
  type ServiceKind,
  type ServiceMode,
  type ManifestFrontend,
  type FrontendMode,
  type ManifestScripts,
  type ManifestConfigFile,
  type ManifestRuntime,
  type ManifestWeb,
  type ManifestDesktop,
  type ManifestEnvBinding,
  type ManifestDesktopAction,
  type ManifestDesktopCapabilities,
  type ManifestDesktopCapabilityProvider,
  type ManifestDesktopCapabilityRequirement,
  type ManifestPluginHooks,
  type ManifestPluginBridge,
  type ManifestPluginResources,
  type ManifestPluginSettings,
  type ManifestPluginSettingField,
  type ManifestPluginSettingsUi
} from "../../../shared/contracts";

export interface ServiceImportTarget {
  key: string;
  label: string;
  relativePath: string;
  required: boolean;
}

export interface ServiceDefinition extends Manifest {
  id: ServiceId;
  kind: ServiceKind;
  description: string;
  pluginApiVersion: number;
  serviceMode: ServiceMode;
  frontend: ManifestFrontend & { mode: FrontendMode };
  frontendMode: FrontendMode;
  scripts: ManifestScripts;
  configFiles: ManifestConfigFile[];
  runtime: ManifestRuntime & {
    pidRelativePath: string;
    logRelativePath: string;
    errorLogRelativePath: string;
    requiredPaths: string[];
  };
  web: ManifestWeb;
  prerequisites: string[];
  desktop: ManifestDesktop & {
    bundleTopLevelDir: string;
    envBindings: ManifestEnvBinding[];
    actions: ManifestDesktopAction[];
    capabilities: ManifestDesktopCapabilities & {
      provides: ManifestDesktopCapabilityProvider[];
      requires: ManifestDesktopCapabilityRequirement[];
    };
  };
  hooks: ManifestPluginHooks & {
    subscribe: string[];
  };
  bridge: ManifestPluginBridge & {
    requests: string[];
  };
  resources: ManifestPluginResources & {
    webapps: NonNullable<ManifestPluginResources["webapps"]>;
    agents: NonNullable<ManifestPluginResources["agents"]>;
    automations: NonNullable<ManifestPluginResources["automations"]>;
  };
  settings: ManifestPluginSettings & {
    schemaVersion: number;
    fields: ManifestPluginSettingField[];
    ui: ManifestPluginSettingsUi;
  };
  assetFileName: string;
  bundleTopLevelDir: string;
  startCommand: string[];
  stopCommand: string[];
  deployCommand: string[] | null;
  importTargets: ServiceImportTarget[];
}

export interface NormalizeManifestOptions {
  defaultKind?: ServiceKind;
  desktop?: Partial<ManifestDesktop>;
  coreServiceDefaultPorts?: Record<string, number>;
}
