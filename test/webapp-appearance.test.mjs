import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { desktop, createBackendClient } from '../contracts/webapp/bridge.mjs';

const require = createRequire(import.meta.url);
const { isWebappActionAllowed } = require('../dist-electron/main/modules/webs/webapps/capability-policy.js');
const { issueWebappActionToken, authorizeWebappActionToken, revokeWebappActionToken } =
  require('../dist-electron/main/modules/webs/webapps/action-tokens.js');
const { startWebappGateway } = require('../dist-electron/main/modules/webs/webapps/gateway.js');
const { startDesktopActionBridge, stopDesktopActionBridge } =
  require('../dist-electron/main/modules/desktop-actions/action-http-server.js');
const { writeDesktopActionBridgeSettingsConfig } =
  require('../dist-electron/main/modules/desktop-actions/settings.js');

const item = {
  schemaVersion: 2, id: 'webapp-0123456789abcdef', key: 'appearance-test',
  label: 'Appearance test', version: '1.0.0', target: 'any', appConfig: {},
  frontend: { root: 'frontend', index: 'index.html', routeConfig: { backendPrefixes: [] } }
};
const actions = ['desktop.theme.get', 'desktop.theme.set', 'desktop.locale.get', 'desktop.locale.set'];

test('theme and locale actions belong only to local page grants without manifest declarations', t => {
  const pageToken = issueWebappActionToken(item, 'localPageGateway');
  const backendToken = issueWebappActionToken(item, 'backendActionToken');
  t.after(() => { revokeWebappActionToken(pageToken); revokeWebappActionToken(backendToken); });
  for (const action of actions) {
    assert.equal(isWebappActionAllowed(item, 'localPageGateway', action), true, action);
    assert.equal(isWebappActionAllowed(item, 'backendActionToken', action), false, action);
    assert.equal(authorizeWebappActionToken(pageToken, action, 'localPageGateway').ok, true);
    assert.equal(authorizeWebappActionToken(backendToken, action, 'backendActionToken').ok, false);
    assert.equal(authorizeWebappActionToken(pageToken, action, 'backendActionToken').ok, false);
  }
  for (const action of ['desktop.skin.get', 'desktop.skin.set', 'desktop.runtime.diagnostics']) {
    assert.equal(isWebappActionAllowed(item, 'localPageGateway', action), false, action);
  }
  revokeWebappActionToken(pageToken);
  for (const action of actions) assert.equal(authorizeWebappActionToken(pageToken, action).ok, false);
  assert.equal(createBackendClient({ url: 'http://127.0.0.1:17070/webapps', token: 'backend' }).desktop, undefined);
});

test('page SDK routes all four settings actions through the gateway and existing renderer provider', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-webapp-appearance-'));
  const app = { getPath: name => name === 'home' ? root : path.join(root, name) };
  const webappDir = path.join(root, 'app');
  fs.mkdirSync(path.join(webappDir, 'frontend'), { recursive: true });
  fs.writeFileSync(path.join(webappDir, 'frontend/index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(webappDir, 'webapp.json'), JSON.stringify(item));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const portProbe = http.createServer();
  portProbe.listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const rendererCalls = [];
  let theme = { themeMode: 'system', resolvedTheme: 'light' };
  let locale = { locale: 'zh-CN', source: 'default' };
  let rendererFailure = false;
  const options = {
    app,
    webs: { webappManager: { list: () => [item] } },
    getMicrophonePermission: () => 'granted',
    showNotification: () => true,
    confirmRendererAction: () => { throw new Error('Installed page settings must not request consent'); },
    callRendererAction: async request => {
      assert.deepEqual(request.source, { webappId: item.id });
      rendererCalls.push([request.action, request.args]);
      if (rendererFailure) return { ok: false, error: { code: 'save_failed', message: 'Could not save settings' } };
      if (request.action === 'desktop.theme.set') {
        theme = { themeMode: request.args.themeMode, resolvedTheme: request.args.themeMode === 'system' ? 'light' : request.args.themeMode };
      }
      if (request.action === 'desktop.locale.set') locale = { locale: request.args.locale, source: 'stored' };
      return { ok: true, result: request.action.startsWith('desktop.theme.') ? theme : locale };
    }
  };
  writeDesktopActionBridgeSettingsConfig(app, { schemaVersion: 1, port });
  const bridge = startDesktopActionBridge(options);
  t.after(() => stopDesktopActionBridge());
  if (!bridge.listening) await once(bridge, 'listening');
  const pageToken = issueWebappActionToken(item, 'localPageGateway');
  const backendToken = issueWebappActionToken(item, 'backendActionToken');
  t.after(() => { revokeWebappActionToken(pageToken); revokeWebappActionToken(backendToken); });
  const gateway = await startWebappGateway({
    app, item, webappDir, backendUrl: '', pageActionToken: pageToken,
    integrationPorts: { getConfiguredDesktopActionBridgePort: () => port }
  });
  t.after(() => gateway.close());
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (url, init) => typeof url === 'string' && url.startsWith('/__desktop/')
    ? originalFetch(new URL(url, gateway.webUrl), {
      ...init, headers: { ...init.headers, Origin: new URL(gateway.webUrl).origin }
    })
    : originalFetch(url, init);

  assert.equal(Object.isFrozen(desktop.theme), true);
  assert.equal(Object.isFrozen(desktop.locale), true);
  for (const capability of ['desktop.theme', 'desktop.locale']) {
    assert.equal(await desktop.capabilities.has(capability), true);
    const state = (await desktop.capabilities.list()).capabilities.find(entry => entry.id === capability);
    assert.deepEqual(state, { id: capability, status: 'available', declared: true, permission: 'not_required' });
  }
  assert.deepEqual(await desktop.theme.get(), theme);
  for (const themeMode of ['dark', 'light', 'system']) {
    assert.deepEqual(await desktop.theme.set({ themeMode }), theme);
    assert.deepEqual(await desktop.theme.get(), theme);
  }
  assert.deepEqual(await desktop.locale.get(), locale);
  for (const value of ['en-US', 'zh-CN']) {
    assert.deepEqual(await desktop.locale.set({ locale: value }), locale);
    assert.deepEqual(await desktop.locale.get(), locale);
  }
  assert.deepEqual(rendererCalls, [
    ['desktop.theme.get', {}], ['desktop.theme.set', { themeMode: 'dark' }], ['desktop.theme.get', {}],
    ['desktop.theme.set', { themeMode: 'light' }], ['desktop.theme.get', {}],
    ['desktop.theme.set', { themeMode: 'system' }], ['desktop.theme.get', {}],
    ['desktop.locale.get', {}], ['desktop.locale.set', { locale: 'en-US' }], ['desktop.locale.get', {}],
    ['desktop.locale.set', { locale: 'zh-CN' }], ['desktop.locale.get', {}]
  ]);
  rendererFailure = true;
  await assert.rejects(desktop.theme.set({ themeMode: 'dark' }), { code: 'save_failed', action: 'desktop.theme.set' });
  await assert.rejects(desktop.locale.set({ locale: 'en-US' }), { code: 'save_failed', action: 'desktop.locale.set' });
  assert.equal(theme.themeMode, 'system');
  assert.equal(locale.locale, 'zh-CN');
  rendererFailure = false;

  const callsBeforeDenied = rendererCalls.length;
  const call = (base, token, action, origin) => originalFetch(base, {
    method: 'POST', headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(origin ? { Origin: origin } : {})
    }, body: JSON.stringify({ action, args: { themeMode: 'dark', locale: 'en-US' } })
  });
  for (const action of actions) {
    for (const [route, token] of [
      ['/webapps/actions/call', backendToken], ['/webapps/actions/call', pageToken],
      ['/webapps/pages/actions/call', backendToken], ['/webapps/pages/actions/call', '']
    ]) {
      assert.equal((await call(`http://127.0.0.1:${port}${route}`, token, action)).status, 403);
    }
    for (const origin of [undefined, 'https://external.test']) {
      assert.equal((await call(new URL('/__desktop/actions/call', gateway.webUrl), '', action, origin)).status, 403);
    }
  }
  revokeWebappActionToken(pageToken);
  await assert.rejects(desktop.theme.set({ themeMode: 'dark' }), { code: 'forbidden' });
  await assert.rejects(desktop.locale.set({ locale: 'en-US' }), { code: 'forbidden' });
  assert.equal(rendererCalls.length, callsBeforeDenied);
});
