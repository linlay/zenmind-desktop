import type { BrowserWindow } from "electron";
import {
  app
} from "electron";
import {
  PRODUCT_NAME
} from "../../../shared/brand";
import type {
  DesktopAppInfo
} from "../../../shared/contracts";
import { readDesktopProfileFromRoot } from "../../infrastructure/filesystem/profile-store";
import {
  resolveRuntimeRoot,
  shouldPromptEnvRootConflict,
  type EnvRootConflictDecision
} from "../../infrastructure/filesystem/runtime-environment";
import {
  ensureDataRoot,
  getDesktopConfigRoot
} from "../../infrastructure/filesystem/user-paths";
import { type AssistantBridgeRuntime } from "../../modules/assistant";
import { EnterpriseChatRuntime, readEnterpriseImSettings } from "../../modules/enterprise-chat";
import {
  isDesktopSsoCredentialRuntimeReady
} from "../../modules/identity";
import { isDesktopPetSupportedPlatform, type DesktopPetRuntime } from "../../modules/pet";
import { loadInstalledPlugins, type PluginBridgeRuntime } from "../../modules/plugins";
import {
  createServicesRuntime,
  loadBuiltinServices,
  type ServicesFacade
} from "../../modules/services";
import { type AppShellRuntime } from "../../modules/shell";
import {
  startTunnelHubRuntimeIfEnabled
} from "../../modules/tunnel";
import { recoverWebappInstallTransactions } from "../../modules/webs";
import { initializeMainI18n, setMainLocale, t } from "../../support/i18n/main-i18n";
import { safeConsoleError } from "../../support/logging/safe-console";
import {
  applyDesktopInitBootstrap,
  applyDesktopInitVersionUpgrade
} from "../bootstrap/desktop-init";
import { createStartupEnvironmentRuntime } from "../bootstrap/startup-environment";
import { cleanupProgramDataForVersion } from "../lifecycle/program-data-cleanup";
import { createStartupPipeline } from "../lifecycle/startup";
import {
  type StartupPhase
} from "../lifecycle/startup-phases";
import { createStartupRestoreController } from "../lifecycle/startup-restore";
import { createMainAppState } from "../state";
export interface AssembleStartupRestoreDependencies {
  readonly getMainWindow: () => BrowserWindow | null;
}

export function assembleStartupRestore(dependencies: AssembleStartupRestoreDependencies) {
  return createStartupRestoreController({
    onChange: (state) => {
      const mainWindow = dependencies.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) {
        return;
      }
      mainWindow.webContents.send("services.startupRestoreState", state);
    }
  });
}

export interface AssembleStartupEnvironmentDependencies {
  readonly startupPlatform: NodeJS.Platform;
  readonly envZipConflictNeedsDecision: ReturnType<typeof shouldPromptEnvRootConflict>;
  readonly requireEnvZipImportAtStartup: boolean;
  readonly runtimeRootAtProcessStart: ReturnType<typeof resolveRuntimeRoot>;
  readonly oldRootDecisionRef: { current: EnvRootConflictDecision | undefined };
  readonly startupRestoreController: ReturnType<typeof createStartupRestoreController>;
  readonly appShellRuntime: Pick<AppShellRuntime, "showMessageBox">;
}

export function assembleStartupEnvironment(dependencies: AssembleStartupEnvironmentDependencies) {
  return createStartupEnvironmentRuntime({
    app,
    platform: dependencies.startupPlatform,
    productName: PRODUCT_NAME,
    envZipConflictNeedsDecision: dependencies.envZipConflictNeedsDecision,
    requireEnvZipImportAtStartup: dependencies.requireEnvZipImportAtStartup,
    runtimeRootAtProcessStart: dependencies.runtimeRootAtProcessStart,
    oldRootDecisionRef: dependencies.oldRootDecisionRef,
    startupRestoreController: dependencies.startupRestoreController,
    showMessageBox: (options) => dependencies.appShellRuntime.showMessageBox(options),
    t
  });
}

export interface AssembleStartupPipelineDependencies {
  readonly desktopAppInfo: Pick<DesktopAppInfo, "version">;
  readonly isFirstDesktopInstall: boolean;
  readonly startupEnvImportFailureMessage: string | null;
  readonly startupRestoreController: ReturnType<typeof createStartupRestoreController>;
  readonly notifyCoreServicesChanged: () => void;
  readonly runNonCoreStartupTask: (label: string, task: () => void) => void;
  readonly createAppTray: AppShellRuntime["createAppTray"];
  readonly startNonCoreDesktopRuntime: () => void;
  readonly setStartupPhase: (phase: StartupPhase) => void;
  readonly servicesRuntime: Pick<ReturnType<typeof createServicesRuntime>, "runServiceMutation">;
  readonly servicesFacade: Pick<ServicesFacade, "runStartupPreparation">;
}

export function assembleStartupPipeline(dependencies: AssembleStartupPipelineDependencies) {
  return createStartupPipeline({
    app,
    desktopVersion: dependencies.desktopAppInfo.version,
    isFirstDesktopInstall: dependencies.isFirstDesktopInstall,
    getEnvImportFailureMessage: () => dependencies.startupEnvImportFailureMessage,
    startupRestoreController: dependencies.startupRestoreController,
    loadBuiltinServices,
    loadInstalledPlugins,
    notifyCoreServicesChanged: dependencies.notifyCoreServicesChanged,
    startShellRuntime: () => dependencies.runNonCoreStartupTask("app tray", () => dependencies.createAppTray()),
    startNonCoreRuntime: dependencies.startNonCoreDesktopRuntime,
    setStartupPhase: dependencies.setStartupPhase,
    runServiceMutation: dependencies.servicesRuntime.runServiceMutation,
    runStartupPreparation: (targetApp, callbacks) => dependencies.servicesFacade.runStartupPreparation(targetApp, {
      ...callbacks,
      applyDesktopConfiguration: applyDesktopInitVersionUpgrade
    }),
    t,
    onError: safeConsoleError
  });
}

export interface SetStartupPhaseDependencies {
  readonly appState: Pick<ReturnType<typeof createMainAppState>, "startupPhase">;
}

export function setStartupPhase(dependencies: SetStartupPhaseDependencies, phase: StartupPhase) {
  if (dependencies.appState.startupPhase === phase) {
    return;
  }
  dependencies.appState.startupPhase = phase;
  console.info(`[main] startup phase: ${phase}`);
}

export interface InitializeUserDataRootsAndSettingsDependencies {
  readonly startupPlatform: NodeJS.Platform;
  readonly isFirstDesktopInstall: boolean;
  readonly desktopAppInfo: Pick<DesktopAppInfo, "version">;
  readonly petRuntime: Pick<DesktopPetRuntime, "initializeState">;
}

export function initializeUserDataRootsAndSettings(dependencies: InitializeUserDataRootsAndSettingsDependencies) {
  ensureDataRoot(app);
  applyDesktopInitBootstrap(app, dependencies.startupPlatform);
  const initialLocaleSettings = initializeMainI18n(app, { isFirstInstall: dependencies.isFirstDesktopInstall });
  if (dependencies.isFirstDesktopInstall) {
    setMainLocale(app, initialLocaleSettings.locale);
  }
  const programDataCleanup = cleanupProgramDataForVersion(app, dependencies.desktopAppInfo.version);
  dependencies.petRuntime.initializeState(dependencies.isFirstDesktopInstall);
  return programDataCleanup;
}

export function runNonCoreStartupTask(label: string, task: () => void) {
  try {
    task();
  }
  catch (error) {
    safeConsoleError(`failed to start non-core runtime: ${label}`, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export interface StartNonCoreDesktopRuntimeDependencies {
  nonCoreDesktopRuntimeStarted: boolean;
  readonly refreshDesktopSsoIdentityToken: (force?: boolean) => Promise<string>;
  readonly runNonCoreStartupTask: (label: string, task: () => void) => void;
  readonly petRuntime: Pick<DesktopPetRuntime, "getSettings">;
  readonly startupPlatform: NodeJS.Platform;
  readonly showDesktopPetWindow: DesktopPetRuntime["showWindow"];
  readonly refreshDesktopPetState: DesktopPetRuntime["refreshState"];
  readonly buildApplicationMenu: AppShellRuntime["buildApplicationMenu"];
  readonly pluginBridgeRuntime: Pick<PluginBridgeRuntime, "setDesktopReady">;
  readonly assistantBridgeRuntime: Pick<AssistantBridgeRuntime, "startDesktopWsServerIfEnabled">;
  readonly startSsoCredentialDependentRuntimes: () => void;
  readonly setStartupPhase: (phase: StartupPhase) => void;
  readonly notifyDesktopDecorationsChanged: () => void;
}

export function startNonCoreDesktopRuntime(dependencies: StartNonCoreDesktopRuntimeDependencies) {
  if (dependencies.nonCoreDesktopRuntimeStarted) {
    return;
  }
  dependencies.nonCoreDesktopRuntimeStarted = true;
  void dependencies.refreshDesktopSsoIdentityToken().catch((error: unknown) => {
    safeConsoleError("failed to refresh desktop sso token during startup", {
      error: error instanceof Error ? error.message : String(error)
    });
  });
  const desktopSsoRefreshTimer = setInterval(() => {
    void dependencies.refreshDesktopSsoIdentityToken().catch((error: unknown) => {
      safeConsoleError("failed to refresh desktop sso token before expiry", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }, 5 * 60000);
  desktopSsoRefreshTimer.unref();
  app.once("before-quit", () => clearInterval(desktopSsoRefreshTimer));
  dependencies.runNonCoreStartupTask("webapp install recovery", () => {
    recoverWebappInstallTransactions(app);
  });
  dependencies.runNonCoreStartupTask("desktop pet", () => {
    const desktopPetSettings = dependencies.petRuntime.getSettings();
    if (isDesktopPetSupportedPlatform(dependencies.startupPlatform) && desktopPetSettings?.enabled === true) {
      dependencies.showDesktopPetWindow();
    }
    else if (desktopPetSettings) {
      dependencies.refreshDesktopPetState();
    }
  });
  dependencies.runNonCoreStartupTask("application menu", () => dependencies.buildApplicationMenu());
  dependencies.runNonCoreStartupTask("plugin desktop bridge", () => dependencies.pluginBridgeRuntime.setDesktopReady());
  dependencies.runNonCoreStartupTask("desktop ws server", () => {
    dependencies.assistantBridgeRuntime.startDesktopWsServerIfEnabled(readDesktopProfileFromRoot(getDesktopConfigRoot(app)).general.desktopWsServerEnabled);
  });
  dependencies.startSsoCredentialDependentRuntimes();
  dependencies.setStartupPhase("non-core-ready");
  dependencies.notifyDesktopDecorationsChanged();
}

export interface StartSsoCredentialDependentRuntimesDependencies {
  readonly nonCoreDesktopRuntimeStarted: boolean;
  ssoCredentialDependentRuntimesStarted: boolean;
  readonly runNonCoreStartupTask: (label: string, task: () => void) => void;
  readonly enterpriseChatRuntime: Pick<InstanceType<typeof EnterpriseChatRuntime>, "setEnabled">;
  readonly startupPlatform: NodeJS.Platform;
}

export function startSsoCredentialDependentRuntimes(dependencies: StartSsoCredentialDependentRuntimesDependencies) {
  if (!dependencies.nonCoreDesktopRuntimeStarted || dependencies.ssoCredentialDependentRuntimesStarted ||
    !isDesktopSsoCredentialRuntimeReady()) {
    return;
  }
  dependencies.ssoCredentialDependentRuntimesStarted = true;
  dependencies.runNonCoreStartupTask("enterprise chat", () => {
    void dependencies.enterpriseChatRuntime.setEnabled(readEnterpriseImSettings(app, dependencies.startupPlatform).enabled);
  });
  void startTunnelHubRuntimeIfEnabled().catch((error) => {
    safeConsoleError("failed to start Desktop Tunnel Hub", {
      error: error instanceof Error ? error.message : String(error)
    });
  });
}

