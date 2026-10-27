import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { createRequire } from 'node:module';
import { registerBrowserTask } from './helpers/browser-use-task.mjs';

const require = createRequire(import.meta.url), root = path.resolve(import.meta.dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-download-guards-'));
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));
const file = relative => path.join(root, relative);
// Keep this security regression independent of any concurrently built dist.
await require('esbuild').build({ stdin: { contents: [
  `export { BrowserUseRuntime } from ${JSON.stringify(file('src/main/modules/browser-use/runtime.ts'))};`,
  `export { EmbeddedCdpGateway, authorizeDesktopHostCdpCommand } from ${JSON.stringify(file('src/main/modules/web-surfaces/cdp/gateway.ts'))};`,
  `export { handleDesktopCdpRequest } from ${JSON.stringify(file('src/main/modules/desktop-actions/cdp-handler.ts'))};`,
  `export { DESKTOP_CDP_PUBLIC_METHODS, DESKTOP_CDP_HOST_METHODS } from ${JSON.stringify(file('src/shared/embedded-cdp.ts'))};`,
  `export { createSiteHarness } from ${JSON.stringify(file('test/fixtures/site-cdp-harness.cjs'))};`,
  `export { createChatChildSurfaceIdentity } from ${JSON.stringify(file('src/shared/surface-identity.ts'))};`,
  `export { createWebSurfaceId } from ${JSON.stringify(file('src/shared/web-surface.ts'))};`,
  `export { acquireWorkPanelControlScope } from ${JSON.stringify(file('src/main/modules/web-surfaces/cdp/site-scope.ts'))};`,
].join('\n'), resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', outfile: path.join(directory, 'fixture.cjs'), logLevel: 'silent',
  define: { __DESKTOP_APP_BRAND__: JSON.stringify({ id: 'fixture', productName: 'Fixture', protocols: { open: { scheme: 'fixture' } }, installer: {} }) },
  plugins: [{ name: 'source-only-fixture', setup(build) {
    build.onResolve({ filter: /dist-electron\// }, args => ({ path: file('src/' + args.path.split('dist-electron/')[1].replace(/\.js$/u, '.ts')) }));
    build.onResolve({ filter: /^\.\.\/web-surfaces$/ }, args => path.normalize(args.importer).endsWith(path.join('desktop-actions', 'cdp-handler.ts'))
      ? { path: 'cdp-public-entry', namespace: 'test-entry' } : undefined);
    build.onLoad({ filter: /.*/, namespace: 'test-entry' }, () => ({ contents: [
      `export { authorizeDesktopHostCdpCommand } from ${JSON.stringify(file('src/main/modules/web-surfaces/cdp/gateway.ts'))};`,
      `export { validateDesktopCdpParams, DesktopCdpParamsError } from ${JSON.stringify(file('src/main/modules/web-surfaces/cdp/params.ts'))};`,
      `export { isDesktopCdpTimeoutError, DESKTOP_CDP_TARGET_TIMEOUT_CODE, readDesktopCdpErrorDetails } from ${JSON.stringify(file('src/main/modules/web-surfaces/cdp/debugger.ts'))};`,
    ].join('\n'), resolveDir: root }));
  } }],
});
const { BrowserUseRuntime, EmbeddedCdpGateway, authorizeDesktopHostCdpCommand, handleDesktopCdpRequest,
  DESKTOP_CDP_PUBLIC_METHODS, DESKTOP_CDP_HOST_METHODS, createSiteHarness, createChatChildSurfaceIdentity,
  createWebSurfaceId, acquireWorkPanelControlScope } = require(path.join(directory, 'fixture.cjs'));
const digest = 'a'.repeat(64);
const ack = { method: 'Surface.releaseDownload', surfaceId: 'page:owned', params: { downloadId: 'download-1', sha256: digest } };
const caller = runId => ({ chatId: 'chat-a', runId, agentKey: 'cutej' });

test('download release is host-only and public callers cannot grant it with source or trusted fields', async () => {
  assert.equal(DESKTOP_CDP_PUBLIC_METHODS.includes(ack.method), false);
  assert.equal(DESKTOP_CDP_HOST_METHODS.includes(ack.method), true);
  let dispatched = 0;
  const options = { executeCdpCommand: async () => { dispatched++; return { result: { released: true } }; } };
  for (const forged of [{}, { source: caller('run-a') }, { trustedRunSource: true }, { hostOnly: true }]) {
    const response = await handleDesktopCdpRequest(options, { ...ack, ...forged });
    assert.equal(response.error.code, 'method_not_allowed');
  }
  for (const params of [{}, { downloadId: 'download-1', sha256: 'wrong' }, { ...ack.params, extra: true }]) {
    const response = await handleDesktopCdpRequest(options, { ...ack, params }, undefined, undefined, true);
    assert.equal(response.error.code, 'invalid_params');
  }
  assert.equal(dispatched, 0);
});

test('gateway refuses forged host requests before resolving a page', async t => {
  const gateway = new EmbeddedCdpGateway({ getSurfaces() { throw new Error('Public ACK must not resolve a page'); }, resolveWebContents: () => null });
  t.after(() => gateway.stop());
  for (const forged of [{}, { source: { chatId: 'chat-a' } }, { trustedRunSource: true }, { hostOnly: true }]) {
    await assert.rejects(gateway.executeCommand({ ...ack, ...forged }), { code: 'capability_denied' });
  }
});

test('trusted ACK requires the canonical WorkPanel scope and its request marker is single-use', async t => {
  const h = createSiteHarness(), parent = h.site('ack-parent'), guest = h.guest('https://ack.example/');
  guest.session = new EventEmitter();
  const page = { ...createChatChildSurfaceIdentity('workpanel-web', 'ack-page', 'chat-a', parent.surfaceId),
    registrationId: 'ack-registration', surfaceIdentityKey: 'ack-page', surfaceKind: 'chat-work-panel',
    ownerChatId: 'chat-a', label: 'ACK', url: guest.getURL(), active: false, tabs: [h.tab(guest)], activeTabId: `tab-${guest.id}` };
  h.register(page);
  const container = h.registry.listWorkPanelContainers()[0], surfaceId = createWebSurfaceId(container.id, container.targetGeneration, container.tabs[0].tabId);
  const gateway = new EmbeddedCdpGateway({ getSurfaces: () => h.registry.listWorkPanelContainers(),
    resolveWebContents: (_surface, tab) => h.contents.get(tab.webContentsId),
    acquireWorkPanelScope: (id, chatId) => acquireWorkPanelControlScope(h.registry, id, chatId), logger: { debug() {}, warn() {} } });
  t.after(() => gateway.stop());
  const options = { executeCdpCommand: (request, scope, signal) => gateway.executeCommand(request, scope, signal) };
  const response = await handleDesktopCdpRequest(options, { ...ack, surfaceId, source: caller('run-a') }, undefined, undefined, true);
  assert.equal(response.ok, true); assert.deepEqual(response.result, { released: true });
  const foreign = await handleDesktopCdpRequest(options, { ...ack, surfaceId, source: { ...caller('run-a'), chatId: 'chat-b' } }, undefined, undefined, true);
  assert.equal(foreign.error.code, 'target_not_owned_by_chat');
  const unscoped = new EmbeddedCdpGateway({ getSurfaces: () => h.registry.listWorkPanelContainers(), resolveWebContents: () => guest });
  t.after(() => unscoped.stop());
  await assert.rejects(unscoped.executeCommand(authorizeDesktopHostCdpCommand({ ...ack, surfaceId, source: { chatId: 'chat-a' } })), { code: 'capability_denied' });
  const request = authorizeDesktopHostCdpCommand({ ...ack, surfaceId, source: { chatId: 'chat-a' } });
  assert.deepEqual((await gateway.executeCommand(request)).result, { released: true });
  await assert.rejects(gateway.executeCommand(request), { code: 'capability_denied' });
});

test('raw gateway HTTP and WebSocket cannot call the private download acknowledgement', { timeout: 5000 }, async t => {
  const h = createSiteHarness(), site = h.site('ack-public'); h.foreground(site);
  const gateway = new EmbeddedCdpGateway({ port: 0, getSurfaces: () => h.registry.listRegisteredSurfaces(), resolveWebContents: (_surface, tab) => h.contents.get(tab.webContentsId), logger: { debug() {}, warn() {} } });
  const server = gateway.start(); t.after(() => gateway.stop()); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const http = await fetch(origin + '/json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...ack, source: caller('run-a'), trustedRunSource: true }) });
  assert.equal(http.status, 404);
  const [target] = await (await fetch(origin + '/json')).json();
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/devtools/page/' + encodeURIComponent(target.id));
  t.after(() => socket.close()); await once(socket, 'open');
  const response = once(socket, 'message');
  socket.send(JSON.stringify({ id: 1, method: ack.method, params: ack.params, source: caller('run-a'), trustedRunSource: true }));
  const [message] = await response;
  assert.match(JSON.parse(message.data).error.message, /not exposed over WebSocket/);
  socket.close(); await once(socket, 'close');
});

test('Chrome ACK needs a download observed in this Run and preserves its history only for repeat ACK', async t => {
  let listed = [{ downloadId: 'download-1', fileName: 'report.csv', status: 'complete' }];
  const calls = [];
  const client = { async request(method, params, pageId) {
    calls.push({ method, params, pageId });
    if (method === 'connect') return { connected: true };
    if (method === 'list') return [{ pageId: 'p1', url: 'https://ack.example/', title: 'ACK' }];
    if (method === 'observe') return { observationId: 'fresh', elements: [] };
    if (method === 'downloads') return params.action === 'list' ? { downloads: listed } : { released: true };
    return { released: true };
  }, async disconnect() {}, kill() {} };
  const runtime = new BrowserUseRuntime({ createClient: () => client, preferences: {
    read: () => ({ defaultBackend: 'chrome', rememberChromeConnection: true, hasSavedAuthorization: true }), authorization: async () => 'SYNTHETIC_AUTHORIZATION_TOKEN',
  } });
  t.after(() => runtime.dispose()); await runtime.connect('chat-a'); await registerBrowserTask(runtime, caller('run-a'));
  const surfaceId = runtime.state('chat-a').pages[0].surfaceId;
  const call = (method, run = 'run-a', params = {}) => runtime.cdp({ method, source: caller(run), surfaceId, params }, undefined, () => { throw new Error('No browser fallback'); });
  await call('Surface.observe');
  await assert.rejects(call(ack.method, 'run-a', ack.params), { code: 'stale_observation' });
  assert.equal(calls.some(call => call.params?.action === 'release'), false);
  await call('Surface.getDownloads');
  assert.equal((await call(ack.method, 'run-a', ack.params)).result.released, true);
  listed = []; await call('Surface.getDownloads'); await call('Surface.observe');
  assert.equal((await call(ack.method, 'run-a', ack.params)).result.released, true);
  runtime.releaseRun('run-a'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.state('chat-a').workspaceOwner, undefined);
  await registerBrowserTask(runtime, caller('run-b')); await call('Surface.observe', 'run-b');
  await assert.rejects(call(ack.method, 'run-b', ack.params), { code: 'stale_observation' });
  assert.equal(calls.filter(call => call.params?.action === 'release').length, 2);
});
