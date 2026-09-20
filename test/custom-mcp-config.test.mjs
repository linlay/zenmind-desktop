import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import JSZip from 'jszip';

function fixture() {
  const state = { records: [], items: [], content: '', imports: [], fail: false };
  const module = { exports: {} };
  const source = fs.readFileSync(new URL('../src/main/modules/marketplace/custom-mcp-config.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  vm.runInNewContext(compiled, { module, exports: module.exports, URL, Buffer, require: name => {
    if (name === 'jszip') return JSZip;
    if (name === './common') return { asObject, readInstalledRecords: () => state.records };
    if (name === './connector-market') return {
      callConnectorPlatform: async target => target.includes('/detail?') ? { content: state.content } : { connectors: state.items },
      importConnectorBytes: async (bytes, overwrite, expected) => {
        if (state.fail) throw Error('Platform rejected package');
        const zip = await JSZip.loadAsync(bytes);
        const manifest = JSON.parse(await zip.file('connector.json').async('string'));
        state.content = await zip.file('mcp.json').async('string');
        state.imports.push({ overwrite, expected, manifest });
        state.items = [manifest];
      }
    };
    throw Error(name);
  }});
  return { ...module.exports, state };
}
const sample = JSON.stringify({ mcpServers: { docs: { url: 'https://example.test/mcp' }, local: { command: 'node', args: ['server.js'] } } });
test('normalizes standard HTTP and stdio configurations', () => {
  const api = fixture();
  const parsed = JSON.parse(api.normalizeCustomMcpConfig(sample));
  assert.equal(parsed.mcpServers.docs.type, 'streamableHttp');
  assert.equal(parsed.mcpServers.local.type, 'stdio');
  assert.equal(JSON.parse(api.normalizeCustomMcpConfig('{"mcpServers":{"a":{"type":"http","url":"https://example.test/mcp"}}}')).mcpServers.a.type, 'streamableHttp');
});
test('rejects duplicate keys including escaped spellings before import', () => {
  const api = fixture();
  for (const value of ['{"mcpServers":{},"mcpServers":{}}', '{"mcpServers":{"a":{"command":"node","comm\\u0061nd":"other"}}}']) assert.throws(() => api.normalizeCustomMcpConfig(value), /duplicate/);
});
test('rejects invalid shape, missing command and unsafe credential locations', () => {
  const api = fixture();
  for (const entry of [{command:'node',args:['server.js','--token','secret']},{command:''},{url:'file:///tmp/a'},{url:'https://u:p@example.test/mcp'},{url:'https://example.test/mcp?token=x'},{command:'node',env:{API_KEY:'secret'}},{command:'node',env:{API_KEY:'${API_KEY}'}},{url:'https://example.test/mcp',headers:{Authorization:'Bearer secret'}}]) assert.throws(() => api.normalizeCustomMcpConfig(JSON.stringify({mcpServers:{a:entry}})));
  assert.throws(() => api.normalizeCustomMcpConfig('{"mcpServers":{}}'), /at least one/);
});
test('new config is read as empty, and only dedicated package is imported and read back', async () => {
  const api = fixture();
  assert.deepEqual(JSON.parse((await api.getCustomMcpConfig({})).content), { mcpServers: {} });
  const saved = await api.saveCustomMcpConfig({}, {content:sample});
  assert.equal(saved.path, 'desktop-custom-mcp/mcp.json');
  assert.equal(api.state.imports[0].overwrite, false);
  assert.equal(api.state.imports[0].expected.id, 'desktop-custom-mcp');
  await api.saveCustomMcpConfig({}, {content:sample});
  assert.equal(api.state.imports[1].overwrite, true);
});
test('market installations and colliding custom IDs cannot be overwritten', async () => {
  const api = fixture();
  api.state.records = [{id:'market-item',resourceKey:'desktop-custom-mcp'}];
  await assert.rejects(api.saveCustomMcpConfig({}, {content:sample}), /market installation/);
  api.state.records = []; api.state.items = [{id:'desktop-custom-mcp',name:'Someone else'}];
  await assert.rejects(api.saveCustomMcpConfig({}, {content:sample}), /another connector/);
  assert.equal(api.state.imports.length,0);
});
test('Platform rejection preserves prior canonical configuration with no local write', async () => {
  const api = fixture();
  await api.saveCustomMcpConfig({}, {content:sample});
  const prior = api.state.content;
  api.state.fail = true;
  await assert.rejects(api.saveCustomMcpConfig({}, {content:'{"mcpServers":{"other":{"command":"python"}}}'}), /Platform rejected/);
  assert.equal((await api.getCustomMcpConfig({})).content,prior);
});
