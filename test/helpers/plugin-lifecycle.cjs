const path = require('node:path');
const { createServicesFacade } = require('../../dist-electron/main/modules/services');
const { createWebsFacade } = require('../../dist-electron/main/modules/webs');
const { createPluginLifecycle } = require('../../dist-electron/main/modules/plugins/lifecycle');
const resources = require('../../dist-electron/main/modules/plugins/resources');
const { installWebsiteAppArchiveFromPath } = require('../../dist-electron/main/modules/marketplace/website-app-market');
const { readInstalledRecords, removeInstalledRecordByResourceKey } = require('../../dist-electron/main/modules/marketplace/common');

// Match the application composition: real service/resource/WebApp lifecycles,
// with only unrelated identity, cloud and tunnel capabilities replaced.
function createPluginTestRuntime(root, overrides = {}) {
  const app = {
    isPackaged: false,
    getVersion: () => '0.4.2',
    getPath(name) {
      const paths = {
        userData: path.join(root, 'user-data'),
        appData: path.join(root, 'app-data'),
        home: path.join(root, 'home'),
        desktop: path.join(root, 'home', 'Desktop'),
        temp: path.join(root, 'temp')
      };
      if (!paths[name]) throw new Error(`Unexpected app path: ${name}`);
      return paths[name];
    }
  };
  const webs = createWebsFacade({
    getDesktopDeviceId: () => 'plugin-lifecycle-test',
    getConfiguredDesktopActionBridgePort: () => 0,
    readInstalledRecords,
    removeInstalledRecordByResourceKey,
    installWebsiteAppArchiveFromPath: (app, archive, options) =>
      installWebsiteAppArchiveFromPath(app, archive, { ...options, webs }),
    deriveTunnelHubRegistrationApiOrigin: () => '',
    getTunnelHubRuntimeStatus: () => ({ running: false }),
    startTunnelHubRuntime: async () => ({ running: false }),
    readTunnelHubRegistrationBearerToken: () => '',
    readTunnelHubSettings: () => ({}),
    saveTunnelHubSettings: (_app, settings) => settings
  });
  const services = createServicesFacade({
    issueAgentAccessToken: async () => { throw new Error('Unexpected cloud token request'); },
    getDesktopDeviceId: () => 'plugin-lifecycle-test',
    getDesktopDeviceInfo: () => ({}),
    ensureProviderRegisterApiKey: async () => {},
    resolveConversationAssetOrigin: () => '',
    emitPluginBridgeHook: () => {},
    getPluginBridgeEnv: () => ({}),
    getPluginSettingsEnv: () => ({}),
    initializePluginResourceState: resources.initializePluginResourceState,
    readPluginResourceDesiredStatus: resources.readPluginResourceDesiredStatus,
    stopPluginResources: (app, service) => resources.stopPluginResources(app, service, webs.webappManager),
    syncPluginResources: (app, service, dir) => resources.syncPluginResources(app, service, dir, webs.webappManager),
    ...overrides
  });
  return { app, webs, services, plugins: createPluginLifecycle(services, webs.webappManager) };
}

module.exports = { createPluginTestRuntime };
