import type { BrowserWindow } from "electron";
import {
  app,
  net,
  protocol,
  session
} from "electron";
import type {
  DesktopAppInfo
} from "../../../shared/contracts";
import {
  RealtimeBroker
} from "../../modules/agent-platform";
import {
  type AssistantBridgeRuntime
} from "../../modules/assistant";
import { createConversationShareFacade } from "../../modules/conversation-share";
import {
  callAgentPlatform
} from "../../modules/desktop-actions";
import { createDesktopSsoController, issueAgentAccessToken, registerDesktopSsoAvatarProtocol, type DesktopSsoRestoreResult } from "../../modules/identity";
import { registerDesktopPetAssetProtocol } from "../../modules/pet";
import { configurePluginResources, type PluginBridgeRuntime } from "../../modules/plugins";
import { type AppShellRuntime } from "../../modules/shell";
import { registerDesktopUpdates } from "../../modules/updates";
import {
  createWebSurfaceRuntime,
  registerWebsiteFaviconProtocol
} from "../../modules/webs";
import { createLogsRuntime } from "../../support/logging/runtime";
import { createStartupEnvironmentRuntime } from "../bootstrap/startup-environment";
import { cleanupProgramDataForVersion } from "../lifecycle/program-data-cleanup";
import { createShutdownCleanupRunner } from "../lifecycle/shutdown";
import { createStartupPipeline } from "../lifecycle/startup";
import {
  isStartupPhaseAtLeast,
  type StartupPhase
} from "../lifecycle/startup-phases";
import { createStartupRestoreController } from "../lifecycle/startup-restore";
import { startPerformanceDiagnostics } from "../performance-diagnostics";
import { createMainAppState } from "../state";
import { configureSystemIdentity } from "../system-identity";
export interface HandleAppReadyDependencies {
  readonly setStartupPhase: (phase: StartupPhase) => void;
  readonly systemIdentityRuntime: Pick<ReturnType<typeof configureSystemIdentity>, "ensureDockIdentity">;
  readonly startupEnvironmentRuntime: Pick<ReturnType<typeof createStartupEnvironmentRuntime>, "handleStartupEnvRootConflict" | "prepareStartupRuntimeEnvironment" | "getDefaultEnvImportRequiredMessage">;
  startupEnvImportFailureMessage: string | null;
  readonly startupRestoreController: Pick<ReturnType<typeof createStartupRestoreController>, "setEnvImportRequired">;
  readonly initializeUserDataRootsAndSettings: () => ReturnType<typeof cleanupProgramDataForVersion>;
  readonly startupPlatform: NodeJS.Platform;
  readonly logsRuntime: Pick<ReturnType<typeof createLogsRuntime>, "installConsoleTee" | "flush">;
  readonly webSurfaceRuntime: Pick<ReturnType<typeof createWebSurfaceRuntime>, "browserSurfaceRegistry">;
  readonly desktopSsoController: Pick<ReturnType<typeof createDesktopSsoController>, "restoreDesktopSsoSession">;
  readonly applyDesktopSsoRestoreResult: (result: DesktopSsoRestoreResult) => void;
  readonly pluginBridgeRuntime: Pick<PluginBridgeRuntime, "configure" | "emitBeforeQuit">;
  readonly issueAgentAccessToken: (
    app: Parameters<typeof issueAgentAccessToken>[0],
    reason: Parameters<typeof issueAgentAccessToken>[1]
  ) => ReturnType<typeof issueAgentAccessToken>;
  readonly assistantBridgeRuntime: Pick<AssistantBridgeRuntime, "start" | "assistantBridge">;
  readonly getMainWindow: () => BrowserWindow | null;
  readonly desktopAppInfo: DesktopAppInfo;
  readonly configureAppMediaPermissions: AppShellRuntime["configureAppMediaPermissions"];
  readonly registerFocusedWebviewDevToolsShortcut: () => void;
  readonly createWindow: AppShellRuntime["createWindow"];
  readonly appState: Pick<ReturnType<typeof createMainAppState>, "isHandlingQuit" | "startupPhase" | "shutdownMode" | "shutdownCleanupPromise" | "shutdownCleanupComplete" | "shutdownReport">;
  readonly realtimeBroker: Pick<InstanceType<typeof RealtimeBroker>, "beginShutdown">;
  readonly runShutdownCleanup: ReturnType<typeof createShutdownCleanupRunner>;
  readonly beginAppQuitWithoutConfirmation: () => void;
  readonly startResourceDirectoryWatcher: () => void;
  readonly startupPipeline: Pick<ReturnType<typeof createStartupPipeline>, "run">;
  readonly registerIpc: (conversationShareFacade: ReturnType<typeof createConversationShareFacade>, getUpdatesRuntime: () => ReturnType<typeof registerDesktopUpdates> | undefined) => void;
}

export async function handleAppReady(dependencies: HandleAppReadyDependencies) {
  dependencies.setStartupPhase("platform-preflight");
  dependencies.systemIdentityRuntime.ensureDockIdentity();
  dependencies.setStartupPhase("runtime-env");
  const canContinueStartup = await dependencies.startupEnvironmentRuntime.handleStartupEnvRootConflict();
  if (!canContinueStartup) {
    app.exit(0);
    return;
  }
  const startupRuntimeReady = await dependencies.startupEnvironmentRuntime.prepareStartupRuntimeEnvironment();
  if (!startupRuntimeReady.ok) {
    dependencies.startupEnvImportFailureMessage =
      startupRuntimeReady.message || dependencies.startupEnvironmentRuntime.getDefaultEnvImportRequiredMessage();
    dependencies.startupRestoreController.setEnvImportRequired(dependencies.startupEnvImportFailureMessage);
  }
  dependencies.setStartupPhase("runtime-env-ready");
  const programDataCleanup = dependencies.initializeUserDataRootsAndSettings();
  // A first-install root migration must finish before protocol.handle creates
  // the default Session and opens files in the already-configured profile.
  registerDesktopPetAssetProtocol(app, protocol, net, dependencies.startupPlatform);
  registerWebsiteFaviconProtocol(app, protocol, net, dependencies.startupPlatform);
  registerDesktopSsoAvatarProtocol(app, protocol, net, session, dependencies.startupPlatform);
  dependencies.setStartupPhase("desktop-state-ready");
  dependencies.logsRuntime.installConsoleTee();
  startPerformanceDiagnostics(dependencies.webSurfaceRuntime.browserSurfaceRegistry);
  // Persist the pre-logger cleanup result without moving logging ahead of root initialization.
  if (programDataCleanup.failedPaths.length > 0) {
    console.warn("[program-data-cleanup] result", programDataCleanup);
  } else {
    console.info("[program-data-cleanup] result", programDataCleanup);
  }
  const desktopSsoRestoreResult = await dependencies.desktopSsoController.restoreDesktopSsoSession();
  dependencies.applyDesktopSsoRestoreResult(desktopSsoRestoreResult);
  dependencies.pluginBridgeRuntime.configure();
  configurePluginResources({
    callAgentPlatform: (targetApp, targetPath, requestOptions) => callAgentPlatform(targetApp, targetPath, {
      ...requestOptions,
      issueAgentAccessToken: dependencies.issueAgentAccessToken
    })
  });
  dependencies.assistantBridgeRuntime.start();
  const conversationShareFacade = createConversationShareFacade({
    app,
    snapshotProvider: dependencies.assistantBridgeRuntime.assistantBridge
  });
  conversationShareFacade.start();
  app.once("will-quit", () => {
    void conversationShareFacade.dispose();
  });
  let updatesRuntime: ReturnType<typeof registerDesktopUpdates> | undefined;
  dependencies.registerIpc(conversationShareFacade, () => updatesRuntime);
  dependencies.configureAppMediaPermissions();
  dependencies.registerFocusedWebviewDevToolsShortcut();
  dependencies.createWindow();
  updatesRuntime = registerDesktopUpdates({
    app,
    currentVersion: dependencies.desktopAppInfo.version,
    getMainWindow: dependencies.getMainWindow,
    prepareInstall: async () => {
      if (dependencies.appState.isHandlingQuit || !isStartupPhaseAtLeast(dependencies.appState.startupPhase, "core-ready")) throw new Error("updateBusy");
      dependencies.appState.isHandlingQuit = true;
      dependencies.realtimeBroker.beginShutdown();
      dependencies.appState.shutdownMode = "installer";
      const report = await dependencies.runShutdownCleanup();
      if (!report.ok) {
        dependencies.appState.isHandlingQuit = false;
        dependencies.appState.shutdownCleanupPromise = null;
        dependencies.appState.shutdownCleanupComplete = false;
        dependencies.appState.shutdownReport = null;
        throw new Error("cleanupFailed");
      }
      dependencies.pluginBridgeRuntime.emitBeforeQuit();
      await dependencies.logsRuntime.flush(500);
      return true;
    },
    quit: dependencies.beginAppQuitWithoutConfirmation
  });
  dependencies.setStartupPhase("shell-ready");
  dependencies.startResourceDirectoryWatcher();
  void dependencies.startupPipeline.run().then(() => {
    if (["core-ready", "non-core-ready"].includes(dependencies.appState.startupPhase)) void updatesRuntime?.mainReady();
  });
}

