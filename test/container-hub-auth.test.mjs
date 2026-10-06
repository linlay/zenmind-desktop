import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
const nodeRequire = createRequire(import.meta.url);
function loadUnit(file, mocks = {}) {
  const module = { exports: {} };
  const require = id => id in mocks ? mocks[id] : id.startsWith('node:') ? nodeRequire(id) : {};
  new Function('require', 'module', 'exports', fs.readFileSync(path.resolve('dist-electron/main', file), 'utf8'))(require, module, module.exports);
  return module.exports;
}

for (const value of [{ type: 'none' }, { type: 'bearer', token: 'synthetic-token' }, {}, { type: 'bearer' }, { type: 'unknown' }, 'invalid-json', 'missing-capability']) {
  test(`Hub market consumes only the authentication capability: ${JSON.stringify(value)}`, async () => {
    const { __sandboxImageMarketInternals: { resolveContainerHubConfig } } = loadUnit('modules/marketplace/sandbox-image-market.js', {
      '../services': { getResponsiveServiceState: async () => ({ status: 'running', healthMeta: { webUrl: 'http://localhost:8080' } }) },
      '../../infrastructure/filesystem/env-file': { readEnvFile: () => assert.fail('market must not read Hub env') },
      './common': { asObject: value => value && typeof value === 'object' ? value : {}, asString: value => typeof value === 'string' ? value : '', normalizeContainerHubBaseUrl: value => value }
    });
    const config = await resolveContainerHubConfig({}, { services: { resolveDesktopCapability: async (_app, id) => {
      assert.equal(id, 'containerHub.authentication');
      if (value === 'missing-capability') throw new Error('old bundle');
      return { providerServiceId: 'agent-container-hub', text: typeof value === 'string' ? value : JSON.stringify(value) };
    } } });
    if (value.type === 'none') assert.deepEqual(config, { baseURL: 'http://localhost:8080', authToken: undefined });
    else if (value.token) assert.equal(config.authToken, value.token);
    else assert.equal(config, null, 'invalid or missing capability must not downgrade to anonymous');
  });
}

for (const loadServiceEnv of [false, undefined]) {
  test(`capability honors service-owned config without changing legacy defaults (${loadServiceEnv})`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-capability-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const provider = { id: 'containerHub.authentication', command: ['scripts/desktop-auth.sh', '--config-dir', '{{provider.configDir}}'], loadServiceEnv };
    const service = { id: 'agent-container-hub', desktop: { capabilities: { provides: [provider] } }, web: { portEnvKey: 'PORT', defaultPort: 8080 } };
    let reads = 0;
    const { resolveDesktopCapability } = loadUnit('modules/services/manager/capabilities.js', {
      '../service-registry': { getAllServices: () => [service] },
      '../../../infrastructure/filesystem/env-file': { readEnvFile: () => { reads++; if (loadServiceEnv === false) assert.fail('must not read service .env'); return new Map([['AUTH_TOKEN', 'legacy-token']]); } },
      './layout': { getServiceLayout: () => ({ programDir: root, configDir: path.join(root, 'config'), dataDir: root, stateDir: root, logDir: root, envPath: path.join(root, '.env') }) },
      '../../../support/logging/startup-checkpoints': { runStartupCheckpoint: (_id, _op, _stage, fn) => fn() },
      './command-runner': { runExecFile: async (command, args, cwd, options) => {
        assert.equal(command, './scripts/desktop-auth.sh');
        assert.deepEqual(args, ['--config-dir', path.join(root, 'config')]);
        assert.equal(cwd, root);
        assert.equal(options.env.AUTH_TOKEN, loadServiceEnv === false ? undefined : 'legacy-token');
        return { stdout: '{"type":"none"}\n', stderr: '' };
      } }
    });
    assert.equal((await resolveDesktopCapability({ getPath: () => root }, provider.id, {
      ports: { getDesktopDeviceId: () => 'device', getDesktopDeviceInfo: () => ({ deviceName: 'test' }) }
    })).text, '{"type":"none"}');
    assert.equal(loadServiceEnv === false ? reads === 0 : reads > 0, true);
  });
}

test('capability manifest preserves the config-loading opt-out', () => {
  const { resolveCapabilityProvider } = nodeRequire('../dist-electron/main/support/manifest/manifest-capabilities.js');
  assert.equal(resolveCapabilityProvider({ id: 'containerHub.authentication', loadServiceEnv: false }).loadServiceEnv, false);
  assert.equal(resolveCapabilityProvider({ id: 'legacy' }).loadServiceEnv, undefined);
});

test('assistant settings IPC consumes only Desktop preferences', async () => {
  const { registerAssistantIpcHandlers } = loadUnit('modules/assistant/ipc.js');
  const handlers = new Map();
  const settings = { chatDefaultAgentKey: 'chosen-agent', desktopCopilotPages: { chat: { enabled: true } } };
  registerAssistantIpcHandlers({ handle: (name, fn) => handlers.set(name, fn) }, {
    app: { once() {} }, conversationShare: {},
    getAssistantSettings: () => settings,
    get getAgentPlatformMinimaxSettingsPublic() { assert.fail('must not read Platform settings'); }
  });
  assert.equal(await handlers.get('assistant.getSettings')(), settings);
});
