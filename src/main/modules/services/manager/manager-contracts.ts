import { type ServicesIntegrationPorts, requireServicesIntegrationPorts } from "../integration-ports";
import {
  type ServiceLogStreamEvent,
  type StartupRestoreMode,
  type ServiceId,
  type StartupEnvImportRequest,
  type ServiceState
} from "../../../../shared/contracts";
import { type App } from "electron";
import { type ServiceLifecycleCommandKind } from "../lifecycle-args";

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

export const CORE_SERVICE_IDS = new Set<ServiceId>([
  "agent-container-hub",
  "agent-platform",
  "agent-webclient",
  "identity-center"
]);

export type ServiceCommandKind = ServiceLifecycleCommandKind;

export type InstallBuiltinServiceOptions = {
  integrationPorts?: ServicesIntegrationPorts;
  force?: boolean;
  archivePath?: string;
  source?: string;
  skipInitialize?: boolean;
};

export type RunServiceCommandOptions = {
  integrationPorts?: ServicesIntegrationPorts;
  refreshBuiltinAsset?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  commandKind?: ServiceCommandKind;
  stateReadOptions?: ServiceStateReadOptions;
};

export type StartServiceOptions = {
  integrationPorts?: ServicesIntegrationPorts;
  skipPreStartRequirements?: boolean;
  skipBuiltinAssetRefresh?: boolean;
  stateReadOptions?: ServiceStateReadOptions;
  commandStateReadOptions?: ServiceStateReadOptions;
  verificationOptions?: ServiceVerificationOptions;
};

export type StartupPipelineOptions = {
  integrationPorts?: ServicesIntegrationPorts;
  onStarting?: (serviceId: ServiceId) => void;
  onProgress?: (serviceId: ServiceId, phase: StartupPreparationProgressPhase, message: string) => void;
};

export type StartupServiceResult = {
  serviceId: ServiceId;
  ok: boolean;
  message: string;
  running: boolean;
};

export type StartupPreparationServiceResult = {
  serviceId: ServiceId;
  ok: boolean;
  message: string;
  changed: boolean;
  service?: ServiceState;
};
