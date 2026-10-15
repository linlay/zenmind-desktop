import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(relative, require = () => { throw new Error('Unexpected runtime dependency'); }, globals = {}) {
  const module = { exports: {} };
  const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(output, { module, exports: module.exports, require, Error, Date, URL, console, ...globals });
  return module.exports;
}
const flow = load('../src/renderer/pages/functional-market/connectorFlow.ts');
const presentation = load('../src/renderer/pages/functional-market/connectorPresentation.ts', () => flow);
const { connectorPresentation } = presentation;
const connection = (status, extra = {}) => ({
  connectorId: 'example.office', configured: true, readiness: 'ready',
  authentication: { connectorId: 'example.office', status, sessionId: '', expiresAt: '' },
  capabilities: { canConnect: true, canDisconnect: true, canCheck: true, authMode: 'token', hasCli: true, hasMcp: false }, ...extra,
});

test('saved credentials and delegated login remain usable without claiming a verified account', () => {
  for (const [status, label] of [['configured', 'market.connector.flow.configured'], ['delegated', 'market.connector.flow.state.delegated']]) {
    const value = connection(status);
    const presentation = connectorPresentation(value, true);
    assert.equal(presentation.labelKey, label);
    assert.equal(presentation.tone, 'pending');
    assert.equal(flow.connectorIsUsable(value), true);
  }
  assert.equal(connectorPresentation(connection('authorized'), true).tone, 'ready');
  assert.equal(connectorPresentation(connection('authorized'), true).labelKey, 'market.connector.flow.state.verified');
  const noAuth = connection('no_auth', { configured: false, configurationRequired: false, readiness: 'no_auth', capabilities: { authMode: 'none', hasCli: false } });
  assert.equal(connectorPresentation(noAuth, true).labelKey, 'market.connector.flow.state.no_auth');
  assert.equal(connectorPresentation(noAuth, true).tone, 'ready');
});

test('explicit authentication rejection overrides stale invocation readiness without discarding configuration', () => {
  const value = connection('unauthorized');
  assert.equal(flow.connectorIsUsable(value), false);
  assert.equal(connectorPresentation(value, true).labelKey, 'market.connector.flow.state.authorization_required');
  assert.equal(connectorPresentation(value, true).tone, 'pending');
  assert.equal(value.configured, true);
  const missingConfiguration = connection('unauthorized', { configured: false, readiness: 'configuration_required' });
  assert.equal(connectorPresentation(missingConfiguration, true).labelKey, 'market.connector.flow.state.configuration_required');
});

test('execution failures and unreadable local state never claim signed out or retain the old successful indicator', () => {
  const failed = connection('failed');
  assert.equal(flow.connectorIsUsable(failed), false);
  assert.equal(connectorPresentation(failed, true).labelKey, 'market.connector.flow.state.unavailable');
  assert.equal(connectorPresentation(connection('authorized', { readiness: 'unavailable' }), true).tone, 'unavailable');
  const stale = connectorPresentation(connection('authorized'), true, { stateUnavailable: true });
  assert.equal(stale.labelKey, 'market.connector.flow.stateUnavailable');
  assert.equal(stale.tone, 'unavailable');
});

test('macOS and Windows window return reads only a local snapshot and removes focus listeners on exit', async () => {
  for (const platform of ['darwin', 'win32']) {
    const slots = [], effects = [], windowEvents = new Map(), documentEvents = new Map();
    let cursor = 0, collectEffects = true, state = connection('authorized'), reads = 0, checks = 0;
    const react = {
      useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
      useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
      useCallback(fn) { return fn; },
      useEffect(fn) { if (collectEffects) effects.push(fn); },
    };
    const api = {
      market: { getConnectorConnections: async () => { reads++; return [state]; }, checkConnectorConnection: async () => { checks++; return state; } },
      connectorAuthBrowser: { onClosed: () => () => {} },
    };
    const window = { electronAPI: api, setInterval: () => 1, setTimeout: () => 2, clearTimeout() {},
      addEventListener: (name, handler) => windowEvents.set(name, handler), removeEventListener: name => windowEvents.delete(name) };
    const document = { visibilityState: 'visible', addEventListener: (name, handler) => documentEvents.set(name, handler), removeEventListener: name => documentEvents.delete(name) };
    const hook = load('../src/renderer/pages/functional-market/useMarketConnectorFlow.ts', name => name === 'react' ? react : flow,
      { window, document, AbortController, clearInterval() {} });
    const render = () => { cursor = 0; const result = hook.useMarketConnectorFlow(); collectEffects = false; return result; };
    render();
    const cleanup = effects.map(effect => effect()).filter(Boolean);
    await new Promise(setImmediate);
    const item = { id: 'example.office' };
    assert.equal(render().getConnection(item).authentication.status, 'authorized', platform);
    state = connection('unauthorized', { readiness: 'authorization_required' });
    windowEvents.get('focus')();
    await new Promise(setImmediate);
    assert.equal(render().getConnection(item).authentication.status, 'unauthorized', platform);
    assert.equal(reads, 2, platform);
    assert.equal(checks, 0, 'window focus must not invoke a third-party authentication check');
    document.visibilityState = 'hidden';
    windowEvents.get('focus')(); await Promise.resolve();
    assert.equal(reads, 2, 'hidden pages must not refresh from a focus event');
    cleanup.forEach(close => close());
    assert.equal(windowEvents.size, 0, platform);
    assert.equal(documentEvents.size, 0, platform);
  }
});

function credentialUpdateSetup() {
  const slots = [], calls = [], chats = [];
  let cursor = 0, storedAccount = 'existing-account';
  const state = () => connection('authorized', { capabilities: { authMode: 'token', hasCli: false, hasMcp: false } });
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useCallback(fn) { return fn; }, useEffect() {},
  };
  const schema = { fields: [{ key: 'USERNAME', label: 'Username', type: 'text', required: true, defaultValue: 'public-default' },
    { key: 'PASSWORD', label: 'Password', type: 'password', required: true }] };
  const api = {
    market: {
      getConnectorConnections: async () => { calls.push('snapshot'); return [state()]; },
      getConnectorConnection: async () => state(),
      getConnectorTokenSchema: async () => { calls.push('schema'); return schema; },
      saveConnectorCredentials: async input => { calls.push('save'); storedAccount = input.credentials.USERNAME; return state(); },
      setConnectorAgent: async () => { throw new Error('credential updates must not mount an Agent'); },
      disconnectConnector: async () => { throw new Error('credential updates must not disconnect'); },
      install: async () => { throw new Error('credential updates must not install'); },
    },
    assistant: { getSettings: async () => { throw new Error('credential updates must not select an Agent'); } },
    connectorAuthBrowser: {},
  };
  const window = { electronAPI: api, setTimeout: () => 1, clearTimeout() {} };
  const hook = load('../src/renderer/pages/functional-market/useMarketConnectorFlow.ts', name => name === 'react' ? react : flow,
    { window, AbortController });
  return { calls, chats, api, item: { id: 'example.office', name: 'Office', connectorInstalled: true },
    account: () => storedAccount,
    render() { cursor = 0; return hook.useMarketConnectorFlow(undefined, (...args) => chats.push(args)); },
  };
}

test('a configured token connector opens an empty credential form and saves without unbinding or opening chat', async () => {
  const s = credentialUpdateSetup(); await s.render().refresh();
  await s.render().beginCredentialUpdate(s.item);
  const opened = s.render();
  assert.equal(opened.flow.phase, 'credentials');
  assert.equal(opened.flow.mountAgent, false); assert.equal(opened.flow.openChat, false);
  assert.equal(opened.flow.schema.fields[0].defaultValue, undefined);
  assert.equal(s.account(), 'existing-account');
  await opened.submitCredentials({ USERNAME: 'replacement-account', PASSWORD: 'fixture-password' });
  await new Promise(setImmediate);
  assert.equal(s.account(), 'replacement-account');
  assert.equal(s.render().flow, null); assert.equal(s.render().busy, false);
  assert.equal(s.calls.filter(call => call === 'save').length, 1);
  assert.ok(s.calls.filter(call => call === 'snapshot').length >= 2, 'a successful save refreshes local state');
  assert.deepEqual(s.chats, []);
});

test('rejected replacement credentials retain the bound account and the form for a new explicit submission', async () => {
  const s = credentialUpdateSetup(); await s.render().refresh();
  s.api.market.saveConnectorCredentials = async () => { s.calls.push('save'); throw new Error('candidate verification failed; saved credentials were preserved'); };
  await s.render().beginCredentialUpdate(s.item);
  await s.render().submitCredentials({ USERNAME: 'rejected-account', PASSWORD: 'fixture-password' });
  const result = s.render();
  assert.equal(s.account(), 'existing-account');
  assert.equal(result.getConnection(s.item).configured, true);
  assert.equal(result.flow.phase, 'credentials');
  assert.equal(result.error, 'market.connector.flow.credentialCheckFailed');
  assert.equal(result.busy, false);
  assert.deepEqual(s.chats, []);
});

test('canceling a credential update preserves the account and suppresses a late schema response', async () => {
  const s = credentialUpdateSetup(); await s.render().refresh();
  let resolveSchema;
  s.api.market.getConnectorTokenSchema = () => { s.calls.push('schema'); return new Promise(resolve => { resolveSchema = resolve; }); };
  const reading = s.render().beginCredentialUpdate(s.item);
  assert.equal(s.render().busy, true);
  await s.render().beginCredentialUpdate(s.item);
  assert.equal(s.calls.filter(call => call === 'schema').length, 1, 'schema opening is single flight');
  await s.render().cancel();
  resolveSchema({ fields: [] }); await reading;
  assert.equal(s.render().flow, null); assert.equal(s.render().busy, false);
  assert.equal(s.account(), 'existing-account');
  assert.equal(s.calls.filter(call => call === 'save').length, 0);
  assert.deepEqual(s.chats, []);
});

test('credential submission uses the existing operation lock to prevent duplicate saves', async () => {
  const s = credentialUpdateSetup(); await s.render().refresh();
  let finishSave, entered;
  const started = new Promise(resolve => { entered = resolve; });
  s.api.market.saveConnectorCredentials = () => { s.calls.push('save'); entered(); return new Promise(resolve => { finishSave = resolve; }); };
  await s.render().beginCredentialUpdate(s.item);
  const saving = s.render().submitCredentials({ USERNAME: 'replacement-account', PASSWORD: 'fixture-password' });
  await started;
  await s.render().submitCredentials({ USERNAME: 'duplicate-account', PASSWORD: 'fixture-password' });
  assert.equal(s.calls.filter(call => call === 'save').length, 1);
  finishSave(connection('authorized', { capabilities: { authMode: 'token', hasCli: false, hasMcp: false } })); await saving;
  assert.equal(s.render().busy, false); assert.deepEqual(s.chats, []);
});

const pendingConnection = (extra = {}) => connection('pending_verification', { configured: false, readiness: 'configuration_required',
  authentication: { connectorId: 'example.office', status: 'pending_verification', pendingVerification: true, sessionId: '', expiresAt: '' },
  capabilities: { authMode: 'token', hasCli: true, hasMcp: false, canCheck: true }, ...extra });

test('a stored candidate overrides an older unconfigured snapshot without marking it configured', () => {
  for (const value of [pendingConnection(), pendingConnection({ readiness: 'pending_verification' }),
    connection('unauthorized', { readiness: 'authorization_required', authentication: { status: 'unauthorized', pendingVerification: true } })]) {
    assert.equal(flow.connectorAwaitingVerification(value), true);
    assert.equal(connectorPresentation(value, true).labelKey, 'market.connector.flow.state.pending_verification');
    assert.equal(flow.connectorIsUsable(value), false);
  }
  assert.equal(pendingConnection().configured, false);
  const active = connection('authorized', { authentication: { status: 'authorized', pendingVerification: true } });
  assert.equal(flow.connectorAwaitingVerification(active), false);
  assert.equal(flow.connectorIsUsable(active), true);
  assert.equal(connectorPresentation(active, true).labelKey, 'market.connector.flow.state.verified');
});

test('revisiting stored pending credentials never prepares the CLI, requests a form or mounts an Agent', async () => {
  const calls = [], value = pendingConnection();
  const api = { getConnectorConnection: async () => { calls.push('snapshot'); return value; },
    prepareConnector: async () => { throw new Error('candidate verification does not require reinstalling'); },
    getConnectorTokenSchema: async () => { throw new Error('stored candidates must not request credentials again'); },
    saveConnectorCredentials: async () => { throw new Error('stored candidates must not be overwritten'); },
    setConnectorAgent: async () => { throw new Error('an unverified initial account must not mount'); } };
  const result = await flow.runMarketConnectorFlow({ item: { id: 'example.office' }, installed: true, connectorId: 'example.office',
    mountAgent: true, agentKey: 'cutej', signal: new AbortController().signal,
    onPhase() {}, onConnection() {}, onInstalled() {}, onTokenSchema() {}, async onSession() {} }, api);
  assert.equal(result.result, 'pending_verification');
  assert.deepEqual(calls, ['snapshot']);
});

test('a pending save retains a verification path, and check retries never resubmit credential values', async () => {
  const s = credentialUpdateSetup(); await s.render().refresh();
  await s.render().beginCredentialUpdate(s.item);
  const pending = pendingConnection({ capabilities: { authMode: 'token', hasCli: false, hasMcp: false, canCheck: true } });
  s.api.market.saveConnectorCredentials = async () => { s.calls.push('save'); return pending; };
  s.api.market.getConnectorConnection = async () => pending;
  s.api.market.getConnectorConnections = async () => [pending];
  await s.render().submitCredentials({ USERNAME: 'candidate-account', PASSWORD: 'fixture-password' });
  await new Promise(setImmediate);
  assert.equal(s.render().flow, null, 'the credential form closes after the candidate is received');
  assert.equal(s.render().notice, 'market.connector.flow.pendingVerification');
  assert.equal(flow.connectorAwaitingVerification(s.render().getConnection(s.item)), true);
  s.api.market.checkConnectorConnection = async () => { s.calls.push('check'); throw new Error('Temporary verification failure'); };
  await s.render().mutate(s.item, 'check');
  assert.equal(flow.connectorAwaitingVerification(s.render().getConnection(s.item)), true);
  s.api.market.checkConnectorConnection = async () => { s.calls.push('check'); return connection('authorized'); };
  await s.render().retry(s.item);
  assert.equal(s.render().error, '');
  assert.equal(s.render().getConnection(s.item).authentication.status, 'authorized');
  assert.equal(s.calls.filter(call => call === 'schema').length, 1);
  assert.equal(s.calls.filter(call => call === 'save').length, 1);
  assert.equal(s.calls.filter(call => call === 'check').length, 2);
  assert.deepEqual(s.chats, []);
});

function detailTree(value) {
  const calls = [];
  const jsx = (type, props = {}) => ({ type, props });
  const jsxRuntime = { jsx, jsxs: jsx, Fragment: 'Fragment' };
  const detail = load('../src/renderer/pages/functional-market/ConnectorDetailDialog.tsx', name => {
    if (name === 'react/jsx-runtime') return jsxRuntime;
    if (name === 'antd') return { Button: 'Button', Alert: 'Alert', Modal: 'Modal', Tag: 'Tag' };
    if (name === './connectorFlow') return flow;
    if (name === './connectorPresentation') return presentation;
    if (name.endsWith('/useI18n')) return { useI18n: () => ({ t: key => key }) };
    return { default: 'Placeholder', BrandMark: 'BrandMark', ConnectorIcon: 'ConnectorIcon', PRODUCT_NAME: 'CuteJ' };
  });
  const tree = detail.ConnectorDetailDialog({ item: { id: 'example.office', name: 'Office' },
    runtime: { getConnection: () => value, isInstalled: () => true, getError: () => '',
      stateError: '', busy: false, loading: false, flow: null, mutation: null,
      mutate: (_item, action) => calls.push(action), start: () => calls.push('start') },
    onClose() {}, onDisconnect() {}, onConfigure() {} });
  const nodes = [];
  const visit = node => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object' || !node.props) return;
    nodes.push(node); visit(node.props.children); visit(node.props.action);
  };
  visit(tree);
  return { nodes, calls };
}

test('pending receipt is visible inside the detail modal and its primary action checks without reopening a form', () => {
  const { nodes, calls } = detailTree(pendingConnection());
  assert.ok(nodes.some(node => node.type === 'Alert' && node.props.message === 'market.connector.flow.pendingVerification'));
  const primary = nodes.find(node => node.type === 'Button' && node.props.type === 'primary');
  assert.equal(primary.props.children, 'market.connector.flow.check');
  assert.equal(primary.props.disabled, false);
  primary.props.onClick();
  assert.deepEqual(calls, ['check']);
  const unavailable = detailTree(pendingConnection({ capabilities: { authMode: 'token', canCheck: false } }));
  assert.equal(unavailable.nodes.find(node => node.type === 'Button' && node.props.type === 'primary').props.disabled, true);
});

test('an existing usable account keeps its chat action while its replacement has an explicit verification action', () => {
  const { nodes, calls } = detailTree(connection('authorized', { authentication: { status: 'authorized', pendingVerification: true } }));
  const primary = nodes.find(node => node.type === 'Button' && node.props.type === 'primary');
  assert.equal(primary.props.children, 'market.connector.flow.try');
  const alert = nodes.find(node => node.type === 'Alert' && node.props.message === 'market.connector.flow.pendingVerification');
  assert.ok(alert.props.action);
  alert.props.action.props.onClick();
  assert.deepEqual(calls, ['check']);
});

test('authentication messages are localized only from machine codes, never provider prose or arbitrary HTTP status', () => {
  for (const [code, key] of [['connector_authentication_denied', 'market.connector.flow.authenticationDenied'], ['connector_auth_required', 'market.connector.flow.credentialRejected']]) {
    assert.equal(flow.connectorAuthenticationError(new Error(code)), key);
    assert.equal(flow.connectorAuthenticationError(Object.assign(new Error('safe service message'), { platformCode: code })), key);
    assert.equal(flow.connectorAuthenticationError(new Error(`Error invoking remote method 'market.saveConnectorCredentials': Error: ${code}`)), key);
    assert.equal(flow.connectorAuthenticationError(new Error(`Error invoking remote method 'market.checkConnectorConnection': Error: ${code}`)), key);
  }
  for (const message of ['AUTHENTICATION_DENIED HTTP 403', 'service says connector_auth_required',
    '{"code":-1,"msg":"connector_authentication_denied","data":{"code":"permission_denied"}}',
    "Error invoking remote method 'market.readSkillContent': Error: connector_auth_required"]) {
    assert.equal(flow.connectorAuthenticationError(new Error(message)), undefined);
  }
});

test('credential and explicit-check failures explain denial separately while retaining the existing account', async () => {
  for (const [code, key] of [['connector_authentication_denied', 'market.connector.flow.authenticationDenied'], ['connector_auth_required', 'market.connector.flow.credentialRejected']]) {
    const s = credentialUpdateSetup(); await s.render().refresh();
    s.api.market.saveConnectorCredentials = async () => { throw new Error(`Error invoking remote method 'market.saveConnectorCredentials': Error: ${code}`); };
    await s.render().beginCredentialUpdate(s.item);
    await s.render().submitCredentials({ USERNAME: 'rejected-account', PASSWORD: 'fixture-password' });
    assert.equal(s.render().error, key);
    assert.equal(s.account(), 'existing-account');
    assert.equal(s.render().getConnection(s.item).configured, true);
    s.api.market.checkConnectorConnection = async () => { throw new Error(`Error invoking remote method 'market.checkConnectorConnection': Error: ${code}`); };
    let snapshotReads = 0;
    s.api.market.getConnectorConnection = async () => { snapshotReads++; return connection('unauthorized', { readiness: 'authorization_required' }); };
    await s.render().mutate(s.item, 'check');
    assert.equal(s.render().error, key);
    assert.equal(s.render().getConnection(s.item).configured, true);
    assert.equal(s.render().getConnection(s.item).authentication.status, 'unauthorized');
    assert.equal(snapshotReads, 1, 'a failed explicit check observes the new local state without probing again');
    assert.deepEqual(s.chats, []);
  }
});
