import type { App } from "electron";
import type { ServiceId } from "../../../shared/contracts";
import type { ServicesIntegrationPorts } from "./integration-ports";
import * as manager from "./manager";
import { resolveDesktopCapability } from "./manager/capabilities";

export function createServicesFacade(ports: ServicesIntegrationPorts) {
  return {
    resolveDesktopCapability: (
      app: App,
      capabilityId: string,
      options: Omit<Parameters<typeof resolveDesktopCapability>[2], "ports"> = {}
    ) => resolveDesktopCapability(app, capabilityId, { ...options, ports }),
    listServices: (app: App) => manager.listServices(app, ports),
    getServiceState: (
      app: App,
      serviceId: ServiceId,
      options: Parameters<typeof manager.getServiceState>[2] = {}
    ) => manager.getServiceState(app, serviceId, { ...options, integrationPorts: ports }),
    getResponsiveServiceState: (app: App, serviceId: ServiceId) =>
      manager.getResponsiveServiceState(app, serviceId, ports),
    installBuiltinService: (
      app: App,
      serviceId: ServiceId,
      options: Parameters<typeof manager.installBuiltinService>[2] = {}
    ) => manager.installBuiltinService(app, serviceId, { ...options, integrationPorts: ports }),
    initializeService: (app: App, serviceId: ServiceId) =>
      manager.initializeService(app, serviceId, ports),
    startService: (app: App, serviceId: ServiceId) => manager.startService(app, serviceId, ports),
    stopService: (app: App, serviceId: ServiceId) => manager.stopService(app, serviceId, ports),
    restartService: (app: App, serviceId: ServiceId) => manager.restartService(app, serviceId, ports),
    readServiceConfig: (app: App, serviceId: ServiceId, key: string) =>
      manager.readServiceConfig(app, serviceId, key),
    writeServiceConfig: (
      app: App,
      serviceId: ServiceId,
      key: string,
      content: string
    ) => manager.writeServiceConfig(app, serviceId, key, content, ports),
    importServiceFile: (
      app: App,
      serviceId: ServiceId,
      targetKey: string,
      sourcePath: string
    ) => manager.importServiceFile(app, serviceId, targetKey, sourcePath, ports),
    getServiceLogsMeta: (app: App, serviceId: ServiceId) =>
      manager.getServiceLogsMeta(app, serviceId, ports),
    readServiceLog: (
      app: App,
      serviceId: ServiceId,
      target: Parameters<typeof manager.readServiceLog>[2],
      options: Parameters<typeof manager.readServiceLog>[3] = {}
    ) => manager.readServiceLog(app, serviceId, target, options, ports),
    watchServiceLog: (
      app: App,
      subscriptionId: string,
      serviceId: ServiceId,
      target: Parameters<typeof manager.watchServiceLog>[3],
      options: Parameters<typeof manager.watchServiceLog>[4],
      onEvent: Parameters<typeof manager.watchServiceLog>[5]
    ) => manager.watchServiceLog(app, subscriptionId, serviceId, target, options, onEvent, ports),
    runStartupPreparation: (
      app: App,
      options: Parameters<typeof manager.runStartupPreparation>[1] = {}
    ) => manager.runStartupPreparation(app, { ...options, integrationPorts: ports }),
    restoreRunningServices: (
      app: App,
      options: Parameters<typeof manager.restoreRunningServices>[1] = {}
    ) => manager.restoreRunningServices(app, { ...options, integrationPorts: ports }),
    stopRunningServicesForShutdown: (
      app: App,
      options: Parameters<typeof manager.stopRunningServicesForShutdown>[1] = {}
    ) => manager.stopRunningServicesForShutdown(app, { ...options, integrationPorts: ports }),
    __testInternals: {
      ...manager.__testInternals,
      resolveAgentWebclientHostStartOverrides: (app: App) =>
        manager.__testInternals.resolveAgentWebclientHostStartOverrides(app, ports),
      getResourcePluginServiceIdsToRestore: (app: App) =>
        manager.__testInternals.getResourcePluginServiceIdsToRestore(app, ports),
      buildDesktopManagedDeployCommand: (
        app: Parameters<typeof manager.__testInternals.buildDesktopManagedDeployCommand>[0],
        service: Parameters<typeof manager.__testInternals.buildDesktopManagedDeployCommand>[1],
        command: Parameters<typeof manager.__testInternals.buildDesktopManagedDeployCommand>[2],
        layout: Parameters<typeof manager.__testInternals.buildDesktopManagedDeployCommand>[3],
        desktopConfigReset?: Parameters<typeof manager.__testInternals.buildDesktopManagedDeployCommand>[4]
      ) => manager.__testInternals.buildDesktopManagedDeployCommand(
        app,
        service,
        command,
        layout,
        desktopConfigReset,
        ports
      ),
      ensurePreStartRequirements: (
        app: Parameters<typeof manager.__testInternals.ensurePreStartRequirements>[0],
        service: Parameters<typeof manager.__testInternals.ensurePreStartRequirements>[1]
      ) => manager.__testInternals.ensurePreStartRequirements(app, service, ports),
      resolveAgentPlatformDeployPublicKeySourceFile: (app: App) =>
        manager.__testInternals.resolveAgentPlatformDeployPublicKeySourceFile(app, ports),
      buildDesktopServiceCommandEnv: (
        app: Parameters<typeof manager.__testInternals.buildDesktopServiceCommandEnv>[0],
        serviceOrLayout: Parameters<typeof manager.__testInternals.buildDesktopServiceCommandEnv>[1],
        layoutOrOverrides: Parameters<typeof manager.__testInternals.buildDesktopServiceCommandEnv>[2],
        overrides?: Parameters<typeof manager.__testInternals.buildDesktopServiceCommandEnv>[3]
      ) => manager.__testInternals.buildDesktopServiceCommandEnv(
        app,
        serviceOrLayout,
        layoutOrOverrides,
        overrides,
        ports
      )
    }
  };
}

export type ServicesFacade = ReturnType<typeof createServicesFacade>;
