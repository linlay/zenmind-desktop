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
  type ServicesIntegrationPorts
} from "../../modules/services";
import {
  type WebsFacade
} from "../../modules/webs";
import { safeConsoleError } from "../../support/logging/safe-console";
export interface AssembleServicesIntegrationDependencies {
  readonly issueAgentAccessToken: (
    app: Parameters<typeof issueAgentAccessToken>[0],
    reason: Parameters<typeof issueAgentAccessToken>[1]
  ) => ReturnType<typeof issueAgentAccessToken>;
  readonly refreshDesktopSsoIdentityToken: (force?: boolean) => Promise<string>;
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
      if (accessMode && !preparation && (!token || appliedProviderToken !== token)) {
        // Only selected Provider Keys follow SSO; local services remain available.
        appliedProviderToken = null;
        clearAccessTokenProviderKeys(targetApp);
      }
      if (accessMode && !preparation && !token) {
        return { status: "skipped", reason: "login-required" };
      }
      try {
        const result = await ensureProviderRegisterApiKey(targetApp, {
          getDesktopDeviceId, preparation,
          getAccessToken: () => isDesktopSsoCredentialRuntimeReady() ? getDesktopSsoAccessToken() : null,
          refreshAccessToken: () => dependencies.refreshDesktopSsoIdentityToken(true)
        });
        if (accessMode && !preparation) {
          appliedProviderToken = getDesktopSsoAccessToken();
        }
        return result;
      } catch (error) {
        if (!accessMode) throw error;
        // Registration failure affects this Provider, not Platform/WebClient startup.
        safeConsoleError("failed to register access-token Provider Key", { error: String(error) });
        return { status: "skipped", reason: "unavailable" };
      }
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

