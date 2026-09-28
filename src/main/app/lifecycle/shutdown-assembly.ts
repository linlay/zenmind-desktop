import type { BrowserWindow } from "electron";
import {
  app
} from "electron";
import {
  STORAGE_NAMESPACE
} from "../../../shared/brand";
import type { ShutdownReport } from "../../../shared/shutdown";
import {
  type ServicesFacade
} from "../../modules/services";
import { type AppShellRuntime } from "../../modules/shell";
import {
  staticSiteHostManager,
  type WebsFacade
} from "../../modules/webs";
import { createShutdownCleanupRunner } from "../lifecycle/shutdown";
import {
  parseInstallerShutdownRequest,
  writeShutdownAck
} from "../lifecycle/shutdown-ack";
import {
  createInstallerShutdownArgs
} from "../lifecycle/single-instance";
import { createMainAppState } from "../state";
export interface AssembleShutdownCleanupDependencies {
  readonly appState: Pick<ReturnType<typeof createMainAppState>, "shutdownMode" | "shutdownCleanupPromise" | "shutdownReport" | "shutdownCleanupComplete">;
  readonly getMainWindow: () => BrowserWindow | null;
  readonly websFacade: Pick<WebsFacade, "webappWindowManager" | "webappRuntime">;
  readonly servicesFacade: Pick<ServicesFacade, "stopRunningServicesForShutdown">;
}

export function assembleShutdownCleanup(dependencies: AssembleShutdownCleanupDependencies) {
  return createShutdownCleanupRunner({
    app,
    getMode: () => dependencies.appState.shutdownMode,
    getExistingPromise: () => dependencies.appState.shutdownCleanupPromise,
    setPromise: (promise) => {
      dependencies.appState.shutdownCleanupPromise = promise;
    },
    markComplete: (report) => {
      dependencies.appState.shutdownReport = report;
      dependencies.appState.shutdownCleanupComplete = true;
    },
    emitProgress: (progress) => {
      const targetWindow = dependencies.getMainWindow();
      if (!targetWindow || targetWindow.isDestroyed()) {
        return;
      }
      try {
        targetWindow.webContents.send("desktopShell.shutdownProgress", progress);
      }
      catch (error) {
        console.warn("[main] failed to render shutdown progress", error);
      }
    },
    dependencies: {
      closeWebappWindows: () => dependencies.websFacade.webappWindowManager.closeAll(),
      listOpenWebappWindowIds: () => dependencies.websFacade.webappWindowManager.openIds(),
      listInitialPortTargets: (targetApp) =>
        [
          ...staticSiteHostManager.list().flatMap((site) =>
            site.running && site.port
              ? [{ kind: "gateway" as const, id: `static-site:${site.siteId}`, port: site.port }]
              : []
          ),
          ...dependencies.websFacade.webappRuntime.listActivePorts(targetApp).map((target) => ({
            kind: "gateway" as const,
            id: `webapp:${target.id}`,
            port: target.port
          }))
        ],
      stopWebapps: (targetApp) => dependencies.websFacade.webappRuntime.stopAll(targetApp),
      stopServices: (targetApp, serviceOptions) =>
        dependencies.servicesFacade.stopRunningServicesForShutdown(targetApp, serviceOptions)
    }
  });
}

export interface BeginAppQuitWithoutConfirmationDependencies {
  readonly appState: Pick<ReturnType<typeof createMainAppState>, "isHandlingQuit">;
  readonly prepareQuitUi: AppShellRuntime["prepareQuitUi"];
}

export function beginAppQuitWithoutConfirmation(dependencies: BeginAppQuitWithoutConfirmationDependencies) {
  dependencies.appState.isHandlingQuit = true;
  dependencies.prepareQuitUi();
  app.quit();
}

export interface BeginInstallerShutdownDependencies {
  readonly INSTALLER_SHUTDOWN_ARGS: ReturnType<typeof createInstallerShutdownArgs>;
  readonly appState: Pick<ReturnType<typeof createMainAppState>, "shutdownMode" | "shutdownReport" | "shutdownAckPaths">;
  readonly writeInstallerShutdownAck: (ackPath: string, report: ShutdownReport) => void;
  readonly beginAppQuitWithoutConfirmation: () => void;
}

export function beginInstallerShutdown(dependencies: BeginInstallerShutdownDependencies, commandLine: string[]) {
  const request = parseInstallerShutdownRequest(commandLine, dependencies.INSTALLER_SHUTDOWN_ARGS, STORAGE_NAMESPACE);
  dependencies.appState.shutdownMode = "installer";
  if (request.ackPath) {
    if (dependencies.appState.shutdownReport) {
      dependencies.writeInstallerShutdownAck(request.ackPath, dependencies.appState.shutdownReport);
    }
    else {
      dependencies.appState.shutdownAckPaths.add(request.ackPath);
    }
  }
  dependencies.beginAppQuitWithoutConfirmation();
}

export function writeInstallerShutdownAck(ackPath: string, report: import("../../../shared/shutdown").ShutdownReport) {
  const status = report.ok ? "OK" : "FAILED";
  try {
    writeShutdownAck(ackPath, status, report);
  }
  catch (error) {
    console.error(`[main] failed to write shutdown acknowledgement ${ackPath}`, error);
  }
}

export interface WriteInstallerShutdownAcksDependencies {
  readonly appState: Pick<ReturnType<typeof createMainAppState>, "shutdownAckPaths">;
  readonly writeInstallerShutdownAck: (ackPath: string, report: ShutdownReport) => void;
}

export function writeInstallerShutdownAcks(dependencies: WriteInstallerShutdownAcksDependencies, report: import("../../../shared/shutdown").ShutdownReport) {
  if (dependencies.appState.shutdownAckPaths.size === 0) {
    return;
  }
  for (const ackPath of dependencies.appState.shutdownAckPaths) {
    dependencies.writeInstallerShutdownAck(ackPath, report);
  }
  dependencies.appState.shutdownAckPaths.clear();
}

