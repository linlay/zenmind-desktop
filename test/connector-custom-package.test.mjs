import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const module = { exports: {} };
const source = fs.readFileSync(new URL('../src/renderer/pages/functional-market/ConnectorCustomPackage.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
vm.runInNewContext(compiled, { module, exports: module.exports, URL, Error });
const { createBasicConnectorPackage, validateConnectorPackage, createConnectorDialogScope, runConnectorDialogRequest } = module.exports;
const basic = { id: 'custom-docs', name: 'Documents', url: 'https://mcp.example.test/api', authMode: 'none' };
test('basic remote MCP produces protocol declarations with no direct execution', () => {
  const result = createBasicConnectorPackage(basic);
  assert.equal(JSON.parse(result.connectorJson).auth_mode, null);
  assert.equal(JSON.parse(result.mcpJson).mcpServers.main.type, 'streamableHttp');
  assert.equal(validateConnectorPackage(result).id, basic.id);
});
test('API key mode writes only the placeholder and a required password schema', () => {
  const result = createBasicConnectorPackage({ ...basic, authMode: 'token' });
  const manifest = JSON.parse(result.connectorJson);
  assert.equal(manifest.token_schema.fields[0].type, 'password');
  assert.equal(manifest.token_schema.fields[0].required, true);
  assert.equal(manifest.token_schema.fields[0].defaultValue, undefined);
  assert.equal(JSON.parse(result.mcpJson).mcpServers.main.headers.Authorization, 'Bearer ${API_KEY}');
});
test('literal credentials in query strings and static headers are rejected before package creation', () => {
  assert.throws(() => createBasicConnectorPackage({ ...basic, url: 'https://mcp.example.test?api_key=private' }), /customForm.secret/);
  const result = createBasicConnectorPackage(basic);
  result.mcpJson = JSON.stringify({ mcpServers: { main: { url: basic.url, headers: { Authorization: 'Bearer private' } } } });
  assert.throws(() => validateConnectorPackage(result), /customForm.secret/);
});
test('password defaults and inline environment tokens are rejected', () => {
  const result = createBasicConnectorPackage(basic);
  result.cliJson = JSON.stringify({ env: { API_KEY: 'private' } });
  assert.throws(() => validateConnectorPackage(result), /customForm.secret/);
  result.cliJson = JSON.stringify({ field: { type: 'password', defaultValue: '' } });
  assert.throws(() => validateConnectorPackage(result), /customForm.secret/);
});
test('unsupported URL protocols and invalid IDs never produce a package', () => {
  assert.throws(() => createBasicConnectorPackage({ ...basic, url: 'file:///tmp/demo' }), /customForm.invalid/);
  assert.throws(() => createBasicConnectorPackage({ ...basic, id: '../demo' }), /customForm.invalid/);
});
test('advanced JSON must be an object and parses without executing source', () => {
  assert.throws(() => validateConnectorPackage({ connectorJson: '[]' }), /customForm.invalid/);
  assert.throws(() => validateConnectorPackage({ connectorJson: 'process.exit(1)' }), /customForm.invalid/);
});

test('create completing after the custom dialog unmounts cannot save/connect in the stale UI', async () => {
  const scope = createConnectorDialogScope(); scope.setVisible(true);
  let resolve; let accepted = 0; let installFinished = false;
  const operation = runConnectorDialogRequest(scope.capture(), () => new Promise(value => { resolve = value; }), () => { accepted++; });
  scope.setVisible(false); // Route departure / unmount.
  installFinished = true; resolve({ ok: true, connectorId: 'created-on-platform' });
  await operation;
  assert.equal(installFinished, true); assert.equal(accepted, 0);
});
test('closing and reopening invalidates the previous creation without blocking the new one', async () => {
  const scope = createConnectorDialogScope(); scope.setVisible(true);
  let resolve; const accepted = [];
  const old = runConnectorDialogRequest(scope.capture(), () => new Promise(value => { resolve = value; }), value => accepted.push(value));
  scope.setVisible(false); scope.setVisible(true);
  await runConnectorDialogRequest(scope.capture(), async () => 'new', value => accepted.push(value));
  resolve('old'); await old;
  assert.deepEqual(accepted, ['new']);
});
test('stale callbacks cannot start another import or creation request', async () => {
  const scope = createConnectorDialogScope(); scope.setVisible(true);
  const stale = scope.capture(); scope.setVisible(false);
  let requests = 0;
  await runConnectorDialogRequest(stale, async () => { requests++; return {}; }, () => assert.fail('stale accept'));
  assert.equal(requests, 0);
});
