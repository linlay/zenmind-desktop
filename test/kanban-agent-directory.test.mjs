import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { listAgents } = require('../dist-electron/main/modules/kanban/command-delivery.js');
const { AgentDirectory } = require('../dist-electron/main/modules/agent-platform/agent-directory.js');
const { resolveRuntimeRoot } = require('../dist-electron/main/infrastructure/filesystem/runtime-env-paths.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-agents-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: name => path.join(root, name) };
  const disk = path.join(resolveRuntimeRoot(app), 'agents');
  const write = (folder, key) => {
    fs.mkdirSync(path.join(disk, folder), { recursive: true });
    fs.writeFileSync(path.join(disk, folder, 'agent.yml'), `key: ${key}\nname: disk-${key}\n`);
  };
  write('same', 'same'); write('disk-only', 'disk-only');
  write('.desktop-plugin-agent-stage', 'staged'); write('backup', 'original');
  return { options: { app, assistantBridge: { listAgents: async () => [] }, listLocalAgents: () => [{ agentKey: 'same', displayName: 'cached' }] } };
}
test('Kanban uses only the successful Platform catalog, including an empty catalog', async t => {
  const deps = fixture(t);
  deps.options.listLocalAgents = () => assert.fail('online catalog must not read cache');
  deps.options.assistantBridge.listAgents = async () => [{ agentKey: 'same', displayName: 'current', role: 'live', icon: 'icon', unreadCount: 2 }];
  assert.deepEqual(await listAgents(deps), [{ agentKey: 'same', displayName: 'current', role: 'live', icon: 'icon', unreadCount: 2 }]);
  deps.options.assistantBridge.listAgents = async () => [];
  assert.deepEqual(await listAgents(deps), []);
});
test('Kanban error fallback prefers cache and hides staging and mismatched source folders', async t => {
  const deps = fixture(t);
  deps.options.assistantBridge.listAgents = async () => { throw new Error('offline'); };
  const result = await listAgents(deps);
  assert.deepEqual(result.map(agent => agent.agentKey), ['same', 'disk-only']);
  assert.equal(result[0].displayName, 'cached');
  deps.options.assistantBridge.listAgents = async () => [];
  assert.deepEqual(await listAgents(deps), []);
});
test('AgentDirectory distinguishes offline and invalid responses from a valid empty catalog', async () => {
  const client = { getJson: async () => [] };
  const directory = new AgentDirectory(client, { toDesktopPetAgentOptions: value => value });
  assert.deepEqual(await directory.listAgents(), []);
  client.getJson = async () => { throw new Error('offline'); };
  await assert.rejects(directory.listAgents(), /offline/);
  client.getJson = async () => ({ items: [] });
  await assert.rejects(directory.listAgents(), /Invalid Platform/);
});
