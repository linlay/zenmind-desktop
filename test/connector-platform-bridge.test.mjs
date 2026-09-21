import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fixturePath = process.env.DESKTOP_CONNECTOR_BRIDGE_FILE;

// Start Platform's TestDesktopConnectorBridgeLocal with the same file variable.
// Both the upstream MCP server and Platform state are isolated test fixtures.
test('compiled Desktop adapters and UI flow interoperate with real Platform HTTP', { skip: !fixturePath }, async () => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const url = new URL(fixture.url);
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(fixture.ids.includes('bridge-token') && fixture.ids.includes('bridge-none'));
  const market = require('../dist-electron/main/modules/marketplace/connector-market.js');
  const state = require('../dist-electron/main/modules/marketplace/connector-state.js');
  const custom = require('../dist-electron/main/modules/marketplace/connector-custom.js');
  const ts = require('typescript');
  market.configureConnectorMarketPlatformCaller(async (target, options = {}) => {
    const response = await fetch(fixture.url + target, {
      method: options.method || 'GET',
      headers: options.rawBody ? { 'Content-Type': options.contentType } : options.body ? { 'Content-Type': 'application/json' } : {},
      body: options.rawBody || (options.body ? JSON.stringify(options.body) : undefined),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok || result.code) throw new Error(JSON.stringify(result));
    return result.data;
  });
  try {
    await fetch(fixture.url + '/fixture/reset', { method: 'POST' });
    await state.disconnectConnectorConnection('bridge-none');
    assert.equal((await state.readConnectorConnection('bridge-none')).configured, false);
    await state.startConnectorConnection('bridge-none');
    const connected = await state.readConnectorConnection('bridge-none');
    assert.equal(connected.configured, true);
    assert.equal(connected.readiness, 'ready');
    assert.equal(connected.capabilities.canCheck, true);
    assert.equal('canEnable' in connected.capabilities, false);
    await state.checkConnectorConnection('bridge-none');
    await state.disconnectConnectorConnection('bridge-none');
    assert.equal((await state.readConnectorConnection('bridge-none')).configured, false);

    assert.equal((await state.readConnectorTokenSchema('bridge-token')).fields[0].key, 'API_KEY');
    assert.equal((await state.saveConnectorCredentials({ connectorId: 'bridge-token', credentials: { API_KEY: fixture.token } })).configured, true);
    await assert.rejects(state.saveConnectorCredentials({ connectorId: 'bridge-token', credentials: { API_KEY: 'wrong-token' } }));
    assert.equal((await state.readConnectorConnection('bridge-token')).readiness, 'ready');
    // A temporary probe failure saves only the candidate. The submission must
    // retain its pending result even when the old active credentials stay ready.
    const pending = await state.saveConnectorCredentials({ connectorId: 'bridge-token', credentials: { API_KEY: 'fixture-next-token' } });
    assert.equal(pending.authentication.status, 'pending_verification');
    assert.equal(pending.authentication.pendingVerification, true);
    assert.equal((await state.readConnectorConnection('bridge-token')).readiness, 'ready');
    const before = await (await fetch(fixture.url + '/fixture/probes')).json();
    await state.readConnectorConnections();
    await state.readConnectorConnection('bridge-token');
    const after = await (await fetch(fixture.url + '/fixture/probes')).json();
    assert.equal(after.count, before.count, 'snapshot reads must not probe third parties');
    await fetch(fixture.url + '/fixture/recover', { method: 'POST' });
    assert.equal((await state.checkConnectorConnection('bridge-token')).authentication.status, 'authorized');
    assert.equal((await state.readConnectorConnection('bridge-token')).readiness, 'ready');
    await state.disconnectConnectorConnection('bridge-token');
    assert.equal((await state.readConnectorConnection('bridge-token')).configured, false);

    let session = await state.startConnectorConnection('bridge-oauth');
    for (let attempt = 0; attempt < 50 && session.status === 'preparing'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      session = (await state.readConnectorConnection('bridge-oauth')).authentication;
    }
    assert.equal(session.status, 'pending');
    assert.equal(session.authBrowser, 'embedded');
    assert.ok(session.authorizationUrl);
    await state.cancelConnectorConnection({ connectorId: 'bridge-oauth', sessionId: session.sessionId });
    assert.equal((await state.readConnectorConnection('bridge-oauth')).configured, false);

    const id = `bridge-import-${Date.now()}`;
    const imported = await custom.createCustomConnector({
      connectorJson: JSON.stringify({ id, name: 'Desktop integration fixture', version: '1.0.0', type: 'mcp', auth_mode: null }),
      mcpJson: JSON.stringify({ mcpServers: { main: { type: 'streamableHttp', url: fixture.upstream + '/mcp' } } }),
    });
    assert.equal(imported.connectorId, id);
    assert.equal((await state.readConnectorConnection(id)).configured, false);
    const output = { exports: {} };
    const source = fs.readFileSync(new URL('../src/renderer/pages/functional-market/connectorFlow.ts', import.meta.url), 'utf8');
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { module: output, exports: output.exports, URL, Date, Promise, Error, setTimeout, clearTimeout });
    const phases = [];
    const result = await output.exports.runMarketConnectorFlow({
      item: { id }, installed: true, connectorId: id, mountAgent: true, agentKey: 'mock-agent', signal: new AbortController().signal,
      onPhase: phase => phases.push(phase), onConnection() {}, onInstalled() {}, async onSession() {}, onTokenSchema() {},
    }, {
      getConnectorConnection: state.readConnectorConnection, connectConnector: state.startConnectorConnection,
      cancelConnectorConnection: state.cancelConnectorConnection, checkConnector: state.checkConnectorConnection,
      setConnectorAgent: state.setConnectorAgent, getConnectorAgent: state.readConnectorAgent,
    });
    assert.equal(result.result, 'complete');
    assert.ok(phases.includes('mounting'));
    const agent = await state.readConnectorAgent('mock-agent');
    assert.ok(agent.activeConnectorIds.includes(id));
    assert.equal(agent.reloadPending, false);
    await state.disconnectConnectorConnection(id);
    assert.equal((await state.readConnectorConnection(id)).configured, false);
  } finally {
    market.configureConnectorMarketPlatformCaller(null);
  }
});
