import type { App } from "electron";

export type StartupPipelineOptions = {
  app: App;
  getEnvImportFailureMessage: () => string | null;
  startupRestoreController: any;
  loadBuiltinServices: (app: App) => void;
  loadInstalledPlugins: (app: App) => void;
  notifyServicesChanged: () => void;
  startTunnelHubRuntimeIfEnabled: () => Promise<unknown>;
  runServiceMutation: <T>(task: () => Promise<T>) => Promise<T>;
  runStartupPreparation: (app: App, callbacks: {
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
      const startupEnvImportFailureMessage = options.getEnvImportFailureMessage();
      if (startupEnvImportFailureMessage !== null) {
        options.startupRestoreController.setEnvImportRequired(startupEnvImportFailureMessage);
        options.notifyServicesChanged();
        return;
      }
      options.loadBuiltinServices(options.app);
      options.loadInstalledPlugins(options.app);
      options.notifyServicesChanged();
      void options.startTunnelHubRuntimeIfEnabled().catch((error) => {
        options.onError("failed to start Desktop Tunnel Hub", {
          error: error instanceof Error ? error.message : String(error)
        });
      });

      void options.runServiceMutation(() => options.runStartupPreparation(options.app, {
        onModeResolved: (mode) => {
          options.startupRestoreController.beginSession(mode);
        },
        onStarting: (serviceId) => {
          options.startupRestoreController.updateService(serviceId, "starting", options.t("startup.phase.starting"));
        },
        onProgress: (serviceId, phase, message) => {
          options.startupRestoreController.updateService(serviceId, phase, message);
          options.notifyServicesChanged();
        }
      }))
        .then((result) => {
          options.startupRestoreController.finishSession(result.mode, result.failures);
          options.notifyServicesChanged();
          if (result.failures.length > 0) {
            console.error("failed to prepare startup services", result.failures);
          }
        })
        .catch((error) => {
          options.startupRestoreController.failCurrentSession(error instanceof Error ? error.message : String(error));
          console.error("failed to prepare startup services", error);
        });
    } catch (error) {
      console.error("Failed in startup pipeline", error);
    }
  }

  return { run };
}
