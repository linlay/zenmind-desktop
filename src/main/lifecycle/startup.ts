import type { App } from "electron";
import type { StartupPhase } from "./startup-phases";

export type StartupPipelineOptions = {
  app: App;
  desktopVersion: string;
  isFirstDesktopInstall: boolean;
  getEnvImportFailureMessage: () => string | null;
  startupRestoreController: any;
  loadBuiltinServices: (app: App) => void;
  loadInstalledPlugins: (app: App) => void;
  notifyCoreServicesChanged: () => void;
  startShellRuntime: () => void;
  startNonCoreRuntime: () => void;
  setStartupPhase: (phase: StartupPhase) => void;
  runServiceMutation: <T>(task: () => Promise<T>) => Promise<T>;
  runStartupPreparation: (app: App, callbacks: {
    desktopVersion?: string;
    isFirstDesktopInstall?: boolean;
    onModeResolved: (mode: string) => void;
    onStarting: (serviceId: string) => void;
    onProgress: (serviceId: string, phase: any, message: string) => void;
  }) => Promise<{ mode: string; failures: any[] }>;
  t: (...args: any[]) => string;
  onError: (message: string, details: Record<string, unknown>) => void;
};

export function createStartupPipeline(options: StartupPipelineOptions) {
  async function run() {
    try {
      options.startShellRuntime();
      const startupEnvImportFailureMessage = options.getEnvImportFailureMessage();
      if (startupEnvImportFailureMessage !== null) {
        options.startupRestoreController.setEnvImportRequired(startupEnvImportFailureMessage);
        options.setStartupPhase("degraded");
        return;
      }
      options.setStartupPhase("core-services-starting");
      options.loadBuiltinServices(options.app);
      options.loadInstalledPlugins(options.app);
      options.notifyCoreServicesChanged();

      void options.runServiceMutation(() => options.runStartupPreparation(options.app, {
        desktopVersion: options.desktopVersion,
        isFirstDesktopInstall: options.isFirstDesktopInstall,
        onModeResolved: (mode) => {
          options.startupRestoreController.beginSession(mode);
        },
        onStarting: (serviceId) => {
          options.startupRestoreController.updateService(serviceId, "starting", options.t("startup.phase.starting"));
        },
        onProgress: (serviceId, phase, message) => {
          options.startupRestoreController.updateService(serviceId, phase, message);
          options.notifyCoreServicesChanged();
        }
      }))
        .then((result) => {
          options.startupRestoreController.finishSession(result.mode, result.failures);
          options.notifyCoreServicesChanged();
          if (result.failures.length > 0) {
            options.setStartupPhase("degraded");
            console.error("failed to prepare startup services", result.failures);
            return;
          }
          options.setStartupPhase("core-ready");
          options.startNonCoreRuntime();
        })
        .catch((error) => {
          options.startupRestoreController.failCurrentSession(error instanceof Error ? error.message : String(error));
          options.notifyCoreServicesChanged();
          options.setStartupPhase("degraded");
          console.error("failed to prepare startup services", error);
        });
    } catch (error) {
      options.setStartupPhase("degraded");
      console.error("Failed in startup pipeline", error);
    }
  }

  return { run };
}
