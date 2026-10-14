import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const module = { exports: {} };
const source = fs.readFileSync(new URL('../src/main/modules/desktop-actions/platform-http.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
vm.runInNewContext(output, { module, exports: module.exports, Error, URL, ArrayBuffer, Uint8Array,
  require: () => ({ getMainLocale: () => 'zh-CN', t: key => key }),
});
const { fetchAgentPlatformWithAuth } = module.exports;

test('a connector authentication code reaches IPC without renewing the Desktop app token', async () => {
  for (const [status, code] of [[403, 'connector_authentication_denied'], [401, 'connector_auth_required']]) {
    const reasons = [], requests = [];
    await assert.rejects(fetchAgentPlatformWithAuth('http://127.0.0.1:17078', '/api/admin/connectors/auth', {
      method: 'PUT', body: { credentials: { API_KEY: 'fixture-only' } },
      issueToken: async reason => { reasons.push(reason); return { ok: true, token: 'fixture-app-token' }; },
      fetchImpl: async (_url, request) => { requests.push(request.method); return new Response(JSON.stringify({ code: -1, msg: 'safe service message', data: { code } }), { status }); },
    }), error => error.message === code && error.platformCode === code && error.status === status);
    assert.deepEqual(reasons, ['missing']);
    assert.deepEqual(requests, ['PUT']);
  }
});

test('ordinary Desktop authentication still refreshes once and connector words in prose do not override it', async () => {
  const reasons = [];
  await assert.rejects(fetchAgentPlatformWithAuth('http://127.0.0.1:17078', '/api/connectors/check', {
    issueToken: async reason => { reasons.push(reason); return { ok: true, token: 'fixture-app-token' }; },
    fetchImpl: async () => new Response(JSON.stringify({ code: -1, msg: 'connector_auth_required', data: { code: 'unauthorized' } }), { status: 401 }),
  }), /desktopAction\.agentPlatformAuthFailed/);
  assert.deepEqual(reasons, ['missing', 'unauthorized']);
});

test('permission and temporary errors keep their original category without becoming credential rejection', async () => {
  for (const [status, code] of [[403, 'permission_denied'], [503, 'connector_execution_failed']]) {
    const reasons = [];
    await assert.rejects(fetchAgentPlatformWithAuth('http://127.0.0.1:17078', '/api/connectors/check', {
      issueToken: async reason => { reasons.push(reason); return { ok: true, token: 'fixture-app-token' }; },
      fetchImpl: async () => new Response(JSON.stringify({ code: -1, msg: 'connector_authentication_denied', data: { code } }), { status }),
    }), error => error.status === status && error.platformCode === -1 && JSON.parse(error.message).data.code === code);
    assert.deepEqual(reasons, ['missing']);
  }
});
