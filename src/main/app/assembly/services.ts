import { ensureProviderRegisterApiKey } from "../../modules/agent-platform";
import { resolveConversationAssetOrigin } from "../../modules/conversation-share";
import {
  getDesktopDeviceId,
  getDesktopDeviceInfo, issueAgentAccessToken
} from "../../modules/identity";
import {
  createAgentEngineSync,
  emitPluginBridgeHook,
  getPluginBridgeEnv,
  getPluginSettingsEnv,
  initializePluginResourceState,
  readPluginResourceDesiredStatus,
  stopPluginResources,
  syncPluginResources
} from "../../modules/plugins";
import {
  getResponsiveServiceState,
  type ServicesIntegrationPorts
} from "../../modules/services";
import {
  type WebsFacade
} from "../../modules/webs";
export interface AssembleServicesIntegrationDependencies {
  readonly onEngineChanged?: () => void;
  readonly issueAgentAccessToken: (
    app: Parameters<typeof issueAgentAccessToken>[0],
    reason: Parameters<typeof issueAgentAccessToken>[1]
  ) => ReturnType<typeof issueAgentAccessToken>;
  readonly websFacade: Pick<WebsFacade, "webappManager">;
}

export function assembleServicesIntegration(
  dependencies: AssembleServicesIntegrationDependencies
): ServicesIntegrationPorts {
  const getBaseUrl = async (app: Parameters<typeof getDesktopDeviceId>[0]) => {
    const state = await getResponsiveServiceState(app, "agent-platform");
    if (state.status !== "running" || !state.healthMeta.port) throw new Error("engine_sync_unavailable");
    return `http://127.0.0.1:${state.healthMeta.port}`;
  };
  const agentEngines = (targetApp: Parameters<typeof getDesktopDeviceId>[0]) => createAgentEngineSync(targetApp, {
    getHostId: getDesktopDeviceId,
    getBaseUrl,
    onChanged: dependencies.onEngineChanged,
    getDirectory: async app => {
      const base = await getBaseUrl(app);
      const token = await dependencies.issueAgentAccessToken(app, "missing");
      if (!token.ok || !token.token) throw new Error("engine_directory_unavailable");
      const response = await fetch(`${base}/api/agent-engines`, {
        headers: { Authorization: `Bearer ${token.token}` },
        redirect: "error", signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) throw new Error("engine_directory_unavailable");
      const payload = await response.json();
      if (payload.code !== 200) throw new Error("engine_directory_unavailable");
      return payload.data;
    }
  });
  return {
    agentEngines,
    readAgentEngineState: (app, id) => agentEngines(app).status(id),
    issueAgentAccessToken: dependencies.issueAgentAccessToken,
    getDesktopDeviceId,
    getDesktopDeviceInfo,
    // Grant only: login-identity providers read the SSO token file inside Platform.
    ensureProviderRegisterApiKey: (targetApp, preparation) =>
      ensureProviderRegisterApiKey(targetApp, { getDesktopDeviceId, preparation }),
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

