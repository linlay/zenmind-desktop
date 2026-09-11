import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type {
  ServiceId,
  ServiceLogStreamEvent,
  StartupRestoreMode,
  StartupEnvImportRequest
} from "../../../../shared/contracts";
import type { ServiceDefinition } from "../../../support/manifest/manifest-utils";
import { requireServicesIntegrationPorts, type ServicesIntegrationPorts } from "../integration-ports";
import {
  getInitializationStatePath,
  getInstallDir,
  getServiceLayout,
  type ServiceLayout
} from "./layout";
import {
  serviceInstallNeedsRefresh
} from "./install-refresh";
import {
  readInitializationState
} from "./state-files";
import {
  computeAssetSignature,
  ensureBundleAssetHealthy,
  readBuiltinAssetSignature
} from "./bundle-assets";
import {
  resolvePreferredAgentPlatformRuntimeRoot
} from "./runtime-paths";
import {
  isHostManagedAgentWebclientService
} from "../agent-webclient-host";
import {
  getConfiguredServiceLifecycleArgs,
  type ServiceLifecycleCommandKind
} from "../lifecycle-args";
import {
  type DesktopServiceConfigResetContext
} from "./desktop-config-upgrade";



export const startedThisSession = new Set<ServiceId>();

export const inFlightBuiltinInstalls = new Map<string, Promise<string>>();

export const backgroundStartupPreparationTasks = new Set<Promise<void>>();

export const integrationPorts = (ports: ServicesIntegrationPorts | undefined) =>
  requireServicesIntegrationPorts(ports);

export type ServiceLogStreamCallback = (event: ServiceLogStreamEvent) => void;

export type StartupPreparationProgressPhase =
  | "pending"
  | "installing"
  | "initializing"
  | "starting"
  | "succeeded"
  | "failed"
  | "skipped";

export type StartupPreparationResult = {
  mode: StartupRestoreMode;
  started: ServiceId[];
  failures: string[];
  preparedChanged: boolean;
  inputRequired?: {
    request: StartupEnvImportRequest;
    message: string;
  };
};

export type StartupPreparationOptions = {
  integrationPorts?: ServicesIntegrationPorts;
  desktopVersion?: string;
  desktopVersionUpgradeEnvZipPath?: string;
  isFirstDesktopInstall?: boolean;
  onModeResolved?: (mode: StartupRestoreMode) => void;
  onStarting?: (serviceId: ServiceId) => void;
  onProgress?: (serviceId: ServiceId, phase: StartupPreparationProgressPhase, message: string) => void;
  applyDesktopConfiguration?: (
    app: App,
    defaultsValue: unknown,
    backupDir: string,
    platform: NodeJS.Platform
  ) => void;
};

export type ServiceStateReadMode = "strict" | "responsive" | "bridge";

export type ServiceStateReadOptions = {
  integrationPorts?: ServicesIntegrationPorts;
  mode?: ServiceStateReadMode;
  cacheContainerEngineProbe?: boolean;
};

export type ServiceVerificationOptions = {
  integrationPorts?: ServicesIntegrationPorts;
  stateReadOptions?: ServiceStateReadOptions;
  skipManagedPortProbe?: boolean;
};

export const SHUTDOWN_SERVICE_STOP_TIMEOUT_MS = 2_500;

export const WINDOWS_SHUTDOWN_SERVICE_STOP_TIMEOUT_MS = 1_000;

export const DEFAULT_DEPENDENCY_RUNNING_VERIFICATION_TIMEOUT_MS = 30_000;

export function ensureDir(targetPath: string) {
  fs.mkdirSync(targetPath, { recursive: true });
}

export function isDirectoryAssetPath(assetPath: string) {
  return fs.existsSync(assetPath) && fs.statSync(assetPath).isDirectory();
}

export function copyDirectoryAssetToTempRoot(assetPath: string, tempRoot: string) {
  const targetRoot = path.join(tempRoot, path.basename(assetPath));
  fs.cpSync(assetPath, targetRoot, { recursive: true, force: true });
  return targetRoot;
}

export function prepareServiceExecutionLayout(_service: ServiceDefinition, layout: ServiceLayout) {
  ensureDir(layout.configDir);
  ensureDir(layout.dataDir);
  ensureDir(layout.stateDir);
  ensureDir(layout.logDir);
}

export function isAssetNewerThanInstall(
  assetPath: string,
  layoutOrInstallDir: ServiceLayout | string,
  app?: App,
  service?: ServiceDefinition
) {
  try {
    const initStatePath = getInitializationStatePath(layoutOrInstallDir);
    if (!fs.existsSync(initStatePath)) {
      return true;
    }
    const initializationState = readInitializationState(layoutOrInstallDir);
    if (initializationState?.assetSignature) {
      const assetSignature = app && service
        ? readBuiltinAssetSignature(app, service) ?? computeAssetSignature(assetPath)
        : computeAssetSignature(assetPath);
      return initializationState.assetSignature !== assetSignature;
    }
    const assetMtime = fs.statSync(assetPath).mtimeMs;
    return assetMtime > fs.statSync(initStatePath).mtimeMs;
  } catch {
    return true;
  }
}

export function needsBundledAssetRefresh(app: App, service: ServiceDefinition) {
  if (service.kind !== "builtin") {
    return false;
  }

  const installDir = getInstallDir(app, service);
  const layout = getServiceLayout(app, service);
  let assetPath: string;
  try {
    assetPath = ensureBundleAssetHealthy(app, service);
  } catch {
    return false;
  }

  if (!fs.existsSync(installDir)) {
    return true;
  }

  try {
    if (serviceInstallNeedsRefresh(service, installDir)) {
      return true;
    }
    return isAssetNewerThanInstall(assetPath, layout, app, service);
  } catch {
    return false;
  }
}

export const CORE_SERVICE_IDS = new Set<ServiceId>([
  "agent-container-hub",
  "agent-platform",
  "agent-webclient",
  "identity-center"
]);

export type ServiceCommandKind = ServiceLifecycleCommandKind;

export function isHostManagedService(service: ServiceDefinition) {
  return isHostManagedAgentWebclientService(service);
}

export function getDesktopManagedCommandPort(service: ServiceDefinition) {
  return service.web.defaultPort;
}

export function getDesktopManagedContainerHubBindAddr(service: ServiceDefinition) {
  return `127.0.0.1:${getDesktopManagedCommandPort(service)}`;
}

export function normalizeHttpUrlArgument(value: string) {
  try {
    const parsed = new URL(value);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host) {
      return parsed.toString().replace(/\/$/u, "");
    }
  } catch {
    // Return null below so callers get a lifecycle-specific error message.
  }
  return null;
}

export function resolveAgentWebclientHostBaseUrl(app: App) {
  const args = getConfiguredServiceLifecycleArgs(app, "agent-webclient", "start");
  let baseUrl = "";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--base-url": {
        const value = args[index + 1];
        if (!value) {
          throw new Error("agent-webclient host start argument --base-url requires a value.");
        }
        const normalized = normalizeHttpUrlArgument(value);
        if (!normalized) {
          throw new Error(`agent-webclient host start argument --base-url must be an http(s) URL: ${value}`);
        }
        baseUrl = normalized;
        index += 1;
        break;
      }
      default:
        throw new Error(`unsupported agent-webclient host start argument: ${arg}`);
    }
  }

  if (!baseUrl) {
    throw new Error("agent-webclient host start requires lifecycleArgs.start --base-url.");
  }

  return baseUrl;
}

export function resolveAgentWebclientHostStartOverrides(
  app: App,
  ports?: ServicesIntegrationPorts
) {
  const baseUrl = resolveAgentWebclientHostBaseUrl(app);
  const overrides = new Map<string, string>([
    ["BASE_URL", baseUrl],
    ["DESKTOP_APP", "true"]
  ]);
  const assetOrigin = integrationPorts(ports).resolveConversationAssetOrigin(app);
  if (assetOrigin.ok) {
    overrides.set("CONVERSATION_EXPORT_ASSET_ORIGIN", assetOrigin.origin);
  }
  return overrides;
}

export function appendAgentPlatformDesktopDeployArgs(
  command: string[],
  app: App,
  layout: ServiceLayout,
  containerHubBaseUrl: string,
  publicKeySourceFile: string
) {
  return [
    ...command,
    "--output-dir", layout.configDir,
    "--ap-runtime-dir", resolvePreferredAgentPlatformRuntimeRoot(app),
    "--container-hub-base-url", containerHubBaseUrl,
    "--public-key-source-file", publicKeySourceFile
  ];
}

export function appendAgentContainerHubDesktopDeployArgs(
  command: string[],
  layout: ServiceLayout
) {
  return [
    ...command,
    "--output-dir", layout.configDir
  ];
}

export function appendIdentityCenterDesktopDeployArgs(command: string[], layout: ServiceLayout) {
  return [
    ...command,
    "--output-dir", layout.configDir
  ];
}

export function appendAgentWebclientDesktopDeployArgs(
  command: string[],
  layout: ServiceLayout
) {
  return [
    ...command,
    "--output-dir", layout.configDir
  ];
}

export function appendDesktopConfigResetDeployArgs(
  command: string[],
  context: DesktopServiceConfigResetContext | undefined
) {
  if (!context || context.desktopConfigReset === false) {
    return command;
  }
  return [
    ...command,
    "--desktop-config-reset",
    "--desktop-config-backup-dir", context.backupDir,
    "--desktop-version-from", context.fromVersion,
    "--desktop-version-to", context.toVersion
  ];
}

export function appendAgentPlatformRuntimeResourceDeployArgs(
  command: string[],
  service: ServiceDefinition,
  context: DesktopServiceConfigResetContext | undefined,
  desktopDeviceId: string
) {
  if (!context?.runtimeResourceSource) {
    return command;
  }
  if (service.desktop.runtimeResources !== "v1") {
    throw new Error(
      "agent-platform bundle does not declare desktop.runtimeResources=v1; install a current Platform bundle before Desktop env upgrade."
    );
  }
  const normalizedDeviceId = desktopDeviceId.trim();
  if (!normalizedDeviceId) {
    throw new Error("agent-platform runtime resource migration requires a Desktop device id.");
  }
  return [
    ...command,
    ...(context.desktopConfigReset === false
      ? [
          "--desktop-version-from", context.fromVersion,
          "--desktop-version-to", context.toVersion
        ]
      : []),
    "--runtime-resource-source", context.runtimeResourceSource,
    ...(context.runtimeResourcePreviousSource
      ? ["--runtime-resource-previous-source", context.runtimeResourcePreviousSource]
      : []),
    "--runtime-resource-mode", context.runtimeResourceMode ?? "version-change",
    "--desktop-device-id", normalizedDeviceId
  ];
}
