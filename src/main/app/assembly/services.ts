import {
  clearAccessTokenProviderKeys,
  ensureProviderRegisterApiKey, getProviderRegisterMode
} from "../../modules/agent-platform";
import { resolveConversationAssetOrigin } from "../../modules/conversation-share";
import {
  getDesktopDeviceId,
  getDesktopDeviceInfo, getDesktopSsoAccessToken, isDesktopSsoCredentialRuntimeReady, issueAgentAccessToken
} from "../../modules/identity";
import {
  emitPluginBridgeHook,
  getPluginBridgeEnv,
  getPluginSettingsEnv,
  initializePluginResourceState,
  readPluginResourceDesiredStatus,
  stopPluginResources,
  syncPluginResources
} from "../../modules/plugins";
import {
  type ServicesFacade,
  type ServicesIntegrationPorts
} from "../../modules/services";
import {
  type WebsFacade
} from "../../modules/webs";
import { createStartupRestoreController } from "../lifecycle/startup-restore";
export interface AssembleServicesIntegrationDependencies {
  readonly issueAgentAccessToken: (
    app: Parameters<typeof issueAgentAccessToken>[0],
    reason: Parameters<typeof issueAgentAccessToken>[1]
  ) => ReturnType<typeof issueAgentAccessToken>;
  readonly servicesFacade: Pick<ServicesFacade, "getResponsiveServiceState" | "stopService">;
  readonly refreshDesktopSsoIdentityToken: (force?: boolean) => Promise<string>;
  readonly startupRestoreController: Pick<ReturnType<typeof createStartupRestoreController>, "setAuthenticationRequired">;
  readonly websFacade: Pick<WebsFacade, "webappManager">;
}

export function assembleServicesIntegration(
  dependencies: AssembleServicesIntegrationDependencies
): ServicesIntegrationPorts {
  let appliedProviderToken: string | null = null;
  return {
    issueAgentAccessToken: dependencies.issueAgentAccessToken,
    getDesktopDeviceId,
    getDesktopDeviceInfo,
    ensureProviderRegisterApiKey: async (targetApp, preparation) => {
      const accessMode = getProviderRegisterMode(targetApp) === "access-token";
      const token = isDesktopSsoCredentialRuntimeReady() ? getDesktopSsoAccessToken() : null;
      if (accessMode && (preparation || !token || appliedProviderToken !== token)) {
        // Never reuse a surviving process with a previous account's loaded provider credentials.
        appliedProviderToken = null;
        for (const id of ["agent-webclient", "agent-platform"] as const) {
          const state = await dependencies.servicesFacade.getResponsiveServiceState(targetApp, id);
          if (state.installed) {
            const stopped = await dependencies.servicesFacade.stopService(targetApp, id);
            if (!stopped.ok) throw new Error(stopped.message);
          }
        }
        if (!preparation) clearAccessTokenProviderKeys(targetApp);
      }
      const result = await ensureProviderRegisterApiKey(targetApp, {
        getDesktopDeviceId, preparation,
        getAccessToken: () => isDesktopSsoCredentialRuntimeReady() ? getDesktopSsoAccessToken() : null,
        refreshAccessToken: () => dependencies.refreshDesktopSsoIdentityToken(true),
        onLoginRequired: () => dependencies.startupRestoreController.setAuthenticationRequired(true)
      });
      if (accessMode && !preparation) {
        appliedProviderToken = getDesktopSsoAccessToken();
        dependencies.startupRestoreController.setAuthenticationRequired(false);
      }
      return result;
    },
    resolveConversationAssetOrigin,
    emitPluginBridgeHook,
    getPluginBridgeEnv,
    getPluginSettingsEnv,
    initializePluginResourceState,
    readPluginResourceDesiredStatus,
    stopPluginResources: (targetApp, service) =>
      stopPluginResources(targetApp, service, dependencies.websFacade.webappManager),
    syncPluginResources: (targetApp, service, installDir) =>
      syncPluginResources(
        targetApp,
        service,
        installDir,
        dependencies.websFacade.webappManager
      )
  };
}

