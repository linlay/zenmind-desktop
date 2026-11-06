import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeManifest } = require('../dist-electron/main/support/manifest/manifest-utils');

function manifest() {
  return {
    pluginApiVersion: 2, id: 'engine-fixture', name: 'Engine fixture', version: '0.1.0', description: 'ACP fixture',
    platform: { os: process.platform === 'win32' ? 'windows' : process.platform, arch: process.arch === 'x64' ? 'amd64' : process.arch },
    desktop: { bundleTopLevelDir: 'engine-fixture' }, requires: { platformAgentEngineApi: 2, webclientAgentEngineApi: 1 },
    resources: { agentEngines: [{ id: 'engine', name: 'Engine', protocol: 'acp', transport: 'stdio',
      launch: { runtime: 'node', entry: 'dist/index.mjs', args: ['--fixed', ' keep spaces '] },
      adapter: { package: '@fixture/adapter', version: '1.0.0', acpSdkVersion: '2.0.2' },
      dependencies: [{ id: 'node', version: process.versions.node, delivery: 'host-managed' }]
    }] }
  };
}

test('existing Manifest normalizer accepts API v2 engines as resource plugins and preserves fixed argv', () => {
  const input = manifest();
  input.resources.agentEngines[0].authentication = {terminalMethods: [], agentMethods: ['browser-login']};
  const result = normalizeManifest(input, { defaultKind: 'plugin' });
  assert.equal(result.serviceMode, 'resource');
  assert.deepEqual(result.resources.agentEngines, input.resources.agentEngines);
  assert.deepEqual(result.requires, input.requires);
  assert.deepEqual(result.startCommand, []);
});

test('engine declarations reject old API, unsupported host APIs, duplicate IDs, unpinned dependencies and unsafe launch fields', () => {
  const mutations = [
    m => m.pluginApiVersion = 1,
    m => m.resources.agents = [{ key: 'unexpected', definition: {} }],
    m => m.desktop.capabilities = { provides: [{ id: 'unexpected', command: 'do-not-run' }] },
    m => m.requires.platformAgentEngineApi = 3,
    m => m.requires.platformAgentEngineApi = 1,
    m => m.resources.agentEngines.push(structuredClone(m.resources.agentEngines[0])),
    m => m.resources.agentEngines[0].dependencies[0].version = 'latest',
    m => m.resources.agentEngines[0].dependencies.push(structuredClone(m.resources.agentEngines[0].dependencies[0])),
    m => m.resources.agentEngines[0].launch.entry = '../escape.mjs',
    m => m.resources.agentEngines[0].launch.env = { TOKEN: 'untrusted' },
    m => m.resources.agentEngines[0].launch.args = ['bad\0arg'],
    m => m.resources.agentEngines[0].authentication = { terminalMethods: [{ methodId: 'login', args: [] }, { methodId: 'login', args: [] }] }
  ];
  for (const mutate of mutations) {
    const input = manifest(); mutate(input);
    assert.throws(() => normalizeManifest(input, { defaultKind: 'plugin' }), /engine|dependency|launch|authentication|API/i);
  }
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const JSZip = require('jszip');
const { createPluginTestRuntime } = require('./helpers/plugin-lifecycle.cjs');
const { createPluginLifecycle } = require('../dist-electron/main/modules/plugins/lifecycle');
const { getPluginInstallDir } = require('../dist-electron/main/modules/plugins/loader');
const registry = require('../dist-electron/main/modules/services/service-registry');
const { getDesktopRoot, getServiceStateRoot } = require('../dist-electron/main/infrastructure/filesystem/user-paths');
const { prepareEmbeddedNodeRuntime } = require('../dist-electron/main/modules/services/manager/embedded-node-runtime');

async function engineFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-install space-'));
  registry.clearServices();
  const runtime = createPluginTestRuntime(root);
  t.after(() => { registry.clearServices(); fs.rmSync(root, { recursive: true, force: true }); });
  const resources = path.join(root, 'node-resources');
  fs.mkdirSync(path.join(resources, 'npm/bin'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'npm/package.json'), JSON.stringify({ name: 'npm', version: '10.9.4' }));
  for (const cli of ['npm-cli.js', 'npx-cli.js']) fs.writeFileSync(path.join(resources, 'npm/bin', cli), '');
  const host = {
    getHostId: () => 'fixture-host',
    prepareNodeRuntime: async () => ({ ...await prepareEmbeddedNodeRuntime({
      stateRoot: path.join(root, 'node-state'), binDir: path.join(root, 'managed-bin'), resourcesRoot: resources,
      executable: process.execPath, nodeVersion: process.versions.node, platform: process.platform, arch: process.arch
    }), arch: process.arch })
  };
  const plugins = createPluginLifecycle(runtime.services, runtime.webs.webappManager, host);
  async function archive(input = manifest(), extra = {}, mutateZip) {
    const zip = new JSZip();
    const files = {
      'manifest.json': JSON.stringify(input),
      'dist/index.mjs': 'throw new Error("Adapter must never run during installation");',
      'node_modules/@fixture/adapter/package.json': JSON.stringify({ name: '@fixture/adapter', version: '1.0.0' }),
      'node_modules/@agentclientprotocol/sdk/package.json': JSON.stringify({ name: '@agentclientprotocol/sdk', version: '2.0.2' }),
      ...extra
    };
    for (const [name, data] of Object.entries(files)) zip.file(`${input.id}/${name}`, data);
    mutateZip?.(zip);
    const bytes = await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' });
    const file = path.join(root, `archive-${fs.readdirSync(root).length}.zip`); fs.writeFileSync(file, bytes);
    return file;
  }
  const deliveryRoot = path.join(getDesktopRoot(runtime.app), 'data', 'agent-engines');
  function delivery() {
    const pointer = JSON.parse(fs.readFileSync(path.join(getServiceStateRoot(runtime.app, 'engine-fixture', 'plugin'), 'agent-engine-delivery.json')));
    const directory = path.join(deliveryRoot, pointer.installationRef);
    return { directory, pointer, record: JSON.parse(fs.readFileSync(path.join(directory, 'record.json'))) };
  }
  return { ...runtime, plugins, host, archive, root, deliveryRoot, delivery };
}

test('ZIP engine installation publishes a host-owned delivery and stays stopped without executing the adapter', { skip: process.platform === 'win32' }, async t => {
  const f = await engineFixture(t);
  const archive = await f.archive();
  const result = await f.plugins.installFromArchive(f.app, archive);
  assert.equal(result.ok, true, result.message);
  const { directory, pointer, record } = f.delivery();
  assert.equal(record.ownerHostId, 'fixture-host');
  assert.equal(record.pluginId, 'engine-fixture');
  assert.equal(record.pluginVersion, '0.1.0');
  assert.match(record.artifactDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(record.artifactDigest, pointer.artifactDigest);
  assert.equal(record.source.kind, 'local-import');
  assert.equal(record.source.archiveDigest, `sha256:${createHash('sha256').update(fs.readFileSync(archive)).digest('hex')}`);
  assert.ok(fs.existsSync(path.join(directory, 'package/node_modules/@fixture/adapter/package.json')));
  assert.equal((await f.services.getServiceState(f.app, 'engine-fixture')).status, 'stopped');
  assert.deepEqual(registry.getService('engine-fixture').startCommand, []);
  await assert.rejects(() => f.services.startService(f.app, 'engine-fixture'), /engine.*sync|registry.*ready/i);
  assert.equal((await f.services.getServiceState(f.app, 'engine-fixture')).status, 'stopped');
});

test('missing or wrong runtime and declared bundled dependencies fail before an engine becomes installed', { skip: process.platform === 'win32' }, async t => {
  const f = await engineFixture(t);
  const mutations = [
    m => m.resources.agentEngines[0].dependencies[0].version = '1.0.0',
    m => m.resources.agentEngines[0].dependencies.push({ id: 'cli', version: '1.0.0', delivery: 'bundled', path: 'vendor/cli', entry: 'vendor/cli/bin/cli' }),
    m => m.resources.agentEngines[0].dependencies.push({ id: 'git-bash', version: '1.0.0', delivery: 'host-managed' })
  ];
  for (const mutate of mutations) {
    const input = manifest(); mutate(input);
    const archive = await f.archive(input);
    await assert.rejects(() => f.plugins.installFromArchive(f.app, archive), /dependency|adapter|runtime/i);
    assert.equal(fs.existsSync(getPluginInstallDir(f.app, input.id, input.version)), false);
  }
});

test('unsafe ZIP entries are rejected before changing an existing engine delivery', { skip: process.platform === 'win32' }, async t => {
  const f = await engineFixture(t);
  await f.plugins.installFromArchive(f.app, await f.archive());
  const previous = f.delivery().pointer;
  for (const mutate of [
    zip => zip.file('engine-fixture/linked', '/outside', { unixPermissions: 0o120777 }),
    zip => zip.file('../escaped', 'outside'),
    zip => zip.file('engine-fixture/file:stream', 'ads')
  ]) {
    const archive = await f.archive(manifest(), {}, mutate);
    await assert.rejects(() => f.plugins.installFromArchive(f.app, archive), /unsafe|path|link|ZIP/i);
    assert.deepEqual(f.delivery().pointer, previous);
  }
});

test('failed engine reinstall or upgrade restores the old files, state, registry and delivery, preserving user profiles', { skip: process.platform === 'win32' }, async t => {
  const f = await engineFixture(t);
  await f.plugins.installFromArchive(f.app, await f.archive());
  const before = f.delivery();
  const state = path.join(getServiceStateRoot(f.app, 'engine-fixture', 'plugin'), 'keep-state');
  fs.writeFileSync(state, 'old-state');
  const profile = path.join(f.root, 'platform/agent-engine-profiles/engine/config');
  fs.mkdirSync(path.dirname(profile), { recursive: true }); fs.writeFileSync(profile, 'keep-login');
  const failing = createPluginLifecycle({ ...f.services, initializeService: async () => ({ ok: false, message: 'Injected initialization failure' }) }, f.webs.webappManager, f.host);
  for (const version of ['0.1.0', '0.2.0']) {
    const input = manifest(); input.version = version;
    const archive = await f.archive(input, { 'dist/index.mjs': 'bad replacement' });
    const result = await failing.installFromArchive(f.app, archive);
    assert.equal(result.ok, false);
    assert.deepEqual(f.delivery().pointer, before.pointer);
    assert.equal(fs.readFileSync(state, 'utf8'), 'old-state');
    assert.equal(registry.getService('engine-fixture').version, '0.1.0');
    assert.match(fs.readFileSync(path.join(getPluginInstallDir(f.app, 'engine-fixture', '0.1.0'), 'dist/index.mjs'), 'utf8'), /never run/);
    if (version === '0.2.0') assert.equal(fs.existsSync(getPluginInstallDir(f.app, 'engine-fixture', version)), false);
    assert.equal(fs.readFileSync(profile, 'utf8'), 'keep-login');
    assert.deepEqual(fs.readdirSync(f.deliveryRoot), [before.record.installationRef]);
  }
});

test('market engine identity and digest must match the verified selected release', { skip: process.platform === 'win32' }, async t => {
  const f = await engineFixture(t);
  const archive = await f.archive();
  const digest = `sha256:${createHash('sha256').update(fs.readFileSync(archive)).digest('hex')}`;
  const source = { kind: 'market', authorizationRef: 'catalog:fixture/engine-fixture/0.1.0', pluginId: 'engine-fixture', pluginVersion: '0.1.0', archiveDigest: digest };
  for (const patch of [{ archiveDigest: `sha256:${'0'.repeat(64)}` }, { pluginVersion: '0.2.0' }, { pluginId: 'other' }]) {
    await assert.rejects(() => f.plugins.installFromArchive(f.app, archive, { ...source, ...patch }), /source|digest|identity|version/i);
    assert.equal(fs.existsSync(getPluginInstallDir(f.app, 'engine-fixture', '0.1.0')), false);
  }
  assert.equal((await f.plugins.installFromArchive(f.app, archive, source)).ok, true);
  assert.equal(f.delivery().record.source.kind, 'market');
  assert.equal(f.delivery().record.source.authorizationRef, source.authorizationRef);
});

test('engine uninstall requires confirmed revocation and removes only Desktop program/delivery copies', { skip: process.platform === 'win32' }, async t => {
  const f = await engineFixture(t);
  await f.plugins.installFromArchive(f.app, await f.archive());
  const first = f.delivery();
  const next = manifest(); next.version = '0.2.0';
  await f.plugins.installFromArchive(f.app, await f.archive(next));
  const second = f.delivery();
  const snapshot = path.join(f.root, 'platform/ru-agent-engines/leased/adapter');
  const profile = path.join(f.root, 'platform/agent-engine-profiles/profile/login');
  for (const file of [snapshot, profile]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'keep'); }
  await assert.rejects(() => f.plugins.uninstall(f.app, 'engine-fixture'), /acknowledgement/i);
  assert.ok(fs.existsSync(first.directory));
  const denied = createPluginLifecycle(f.services, f.webs.webappManager, { ...f.host, revoke: async () => ({ ok: false, message: 'no acknowledgement' }) });
  await assert.rejects(() => denied.uninstall(f.app, 'engine-fixture'), /acknowledgement|revok/i);
  assert.ok(fs.existsSync(second.directory));
  const blocked = createPluginLifecycle({ ...f.services, getServiceState: async () => ({ status: 'running' }), stopService: async () => ({ ok: false, message: 'Stop failed' }) }, f.webs.webappManager, { ...f.host, revoke: async () => ({ ok: true }) });
  assert.equal((await blocked.uninstall(f.app, 'engine-fixture')).ok, false);
  assert.ok(fs.existsSync(first.directory)); assert.ok(fs.existsSync(second.directory));
  let acknowledged;
  const approved = createPluginLifecycle(f.services, f.webs.webappManager, { ...f.host, revoke: async (_app, pluginId, refs) => {
    acknowledged = { pluginId, refs }; assert.ok(fs.existsSync(first.directory)); assert.ok(fs.existsSync(second.directory)); return { ok: true };
  } });
  assert.equal((await approved.uninstall(f.app, 'engine-fixture')).ok, true);
  assert.deepEqual(acknowledged.refs.sort(), [first.record.installationRef, second.record.installationRef].sort());
  assert.equal(fs.existsSync(first.directory), false); assert.equal(fs.existsSync(second.directory), false);
  assert.equal(fs.existsSync(getPluginInstallDir(f.app, 'engine-fixture', '0.1.0')), false);
  assert.equal(fs.existsSync(getPluginInstallDir(f.app, 'engine-fixture', '0.2.0')), false);
  for (const file of [snapshot, profile]) assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
});

test('concurrent engine upgrades commit registry and delivery in the same order', { skip: process.platform === 'win32' }, async t => {
  const f = await engineFixture(t);
  const second = manifest(); second.version = '0.2.0';
  const third = manifest(); third.version = '0.3.0';
  const archives = await Promise.all([f.archive(second), f.archive(third)]);
  const ordered = createPluginLifecycle({ ...f.services, initializeService: async (...args) => {
    const version = registry.getService('engine-fixture').version;
    const result = await f.services.initializeService(...args);
    if (version === '0.2.0') await new Promise(resolve => setTimeout(resolve, 100));
    return result;
  } }, f.webs.webappManager, f.host);
  const results = await Promise.all(archives.map(archive => ordered.installFromArchive(f.app, archive)));
  assert.ok(results.every(result => result.ok));
  assert.equal(registry.getService('engine-fixture').version, '0.3.0');
  assert.equal(f.delivery().record.pluginVersion, '0.3.0');
});

test('delivery pointer publication failure rolls back initialization and never exposes the staged version', { skip: process.platform === 'win32' }, async t => {
  const f = await engineFixture(t);
  await f.plugins.installFromArchive(f.app, await f.archive());
  const before = f.delivery();
  const input = manifest(); input.version = '0.2.0';
  const archive = await f.archive(input);
  const rename = fs.renameSync;
  fs.renameSync = (...args) => {
    if (String(args[1]).endsWith('agent-engine-delivery.json')) throw Object.assign(new Error('Injected pointer publication failure'), { code: 'EPERM' });
    return rename(...args);
  };
  try { await assert.rejects(() => f.plugins.installFromArchive(f.app, archive), /publication failure/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(f.delivery().pointer, before.pointer);
  assert.equal(registry.getService('engine-fixture').version, '0.1.0');
  assert.equal(fs.existsSync(getPluginInstallDir(f.app, 'engine-fixture', '0.2.0')), false);
  assert.deepEqual(fs.readdirSync(f.deliveryRoot), [before.record.installationRef]);
});

test('bundled CLI files are validated and included in the full delivery fingerprint', { skip: process.platform === 'win32' }, async t => {
  const f = await engineFixture(t);
  const input = manifest();
  input.resources.agentEngines[0].dependencies.push({ id: 'cli', version: '1.0.0', delivery: 'bundled', path: 'node_modules/@vendor/cli', entry: 'node_modules/@vendor/cli/bin/cli.js' });
  const files = { 'node_modules/@vendor/cli/package.json': JSON.stringify({ name: '@vendor/cli', version: '1.0.0', bin: 'bin/cli.js' }), 'node_modules/@vendor/cli/bin/cli.js': 'original CLI' };
  await f.plugins.installFromArchive(f.app, await f.archive(input, files));
  const first = f.delivery();
  files['node_modules/@vendor/cli/bin/cli.js'] = 'changed CLI';
  await f.plugins.installFromArchive(f.app, await f.archive(input, files));
  const second = f.delivery();
  assert.notEqual(first.record.artifactDigest, second.record.artifactDigest);
  assert.equal(fs.readFileSync(path.join(first.directory, 'package/node_modules/@vendor/cli/bin/cli.js'), 'utf8'), 'original CLI');
  assert.equal(fs.readFileSync(path.join(second.directory, 'package/node_modules/@vendor/cli/bin/cli.js'), 'utf8'), 'changed CLI');
});

test('restart discovers the committed engine version and ignores a newer uncommitted program directory', { skip: process.platform === 'win32' }, async t => {
  const f = await engineFixture(t);
  const input = manifest(); input.version = '0.9.0';
  await f.plugins.installFromArchive(f.app, await f.archive(input));
  input.version = '0.10.0';
  await f.plugins.installFromArchive(f.app, await f.archive(input));
  const pending = manifest(); pending.version = '0.11.0';
  const directory = getPluginInstallDir(f.app, pending.id, pending.version);
  fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(pending));
  registry.clearServices();
  require('../dist-electron/main/modules/plugins/loader').loadInstalledPlugins(f.app);
  assert.equal(registry.getService('engine-fixture').version, '0.10.0');
  assert.equal(f.delivery().record.pluginVersion, '0.10.0');
});

test('the existing market installer carries the selected release digest into the same engine lifecycle', { skip: process.platform === 'win32' }, async t => {
  const f = await engineFixture(t);
  const bytes = fs.readFileSync(await f.archive());
  const { installMarketItem } = require('../dist-electron/main/modules/marketplace/runtime');
  const result = await installMarketItem(f.app, 'engine-fixture', {
    plugins: f.plugins, services: f.services, webs: f.webs,
    catalog: { schemaVersion: 1, items: [{ id: 'engine-fixture', type: 'plugin', name: 'Engine', version: '0.1.0', tags: [], assets: { universal: {
      url: 'https://fixtures.invalid/engine.zip', archiveType: 'zip', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')
    } } }] },
    fetchImpl: async () => new Response(bytes, { status: 200 })
  });
  assert.equal(result.ok, true, result.message);
  assert.equal(f.delivery().record.source.kind, 'market');
  assert.match(f.delivery().record.source.authorizationRef, /engine-fixture@0.1.0$/);
});

test('delivery tree fingerprint matches the Platform vector including permissions and UTF-8 names', { skip: process.platform === 'win32' }, t => {
  const { agentEngineFingerprint } = require('../dist-electron/main/modules/plugins/agent-engines');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-digest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o750);
  fs.mkdirSync(path.join(root, 'bin'), { mode: 0o755 });
  fs.chmodSync(path.join(root, 'bin'), 0o755);
  for (const [name, content, mode] of [['a.txt', 'hello\n', 0o640], ['bin/run', 'node\n', 0o755], ['é.txt', '中文\n', 0o600]]) {
    fs.writeFileSync(path.join(root, name), content);
    fs.chmodSync(path.join(root, name), mode);
  }
  assert.equal(agentEngineFingerprint(root), 'sha256:6f3c0d80b57ab9657d99c62bcb6b375a1d78988710f2529a7814ee92f2a4b45e');
});

test('engine management bootstrap is private, one-use and never persisted as synchronization state', { skip: process.platform === 'win32' }, async t => {
  const { createAgentEngineSync } = require('../dist-electron/main/modules/plugins/engine-resources');
  const f = await engineFixture(t);
  const sync = createAgentEngineSync(f.app, { getHostId: () => 'fixture-host', getBaseUrl: async () => 'http://127.0.0.1:1' });
  const launch = await sync.prepareLaunch();
  assert.equal(launch.args[0], '--agent-engine-bootstrap-file');
  const file = launch.args[1];
  const bootstrap = JSON.parse(fs.readFileSync(file));
  assert.match(bootstrap.managementSecret, /^[a-f0-9]{64}$/);
  assert.equal(bootstrap.hostId, 'fixture-host');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  launch.complete(false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(sync.hasAuthority(), false);
});

async function engineManagementServer(t, sync) {
  const http = await import('node:http');
  const launch = await sync.prepareLaunch();
  const authority = JSON.parse(fs.readFileSync(launch.args[1]));
  launch.complete(true);
  const state = { epoch: 'epoch-one', revision: 0, entries: [], requests: [], offline: false, loseAck: false };
  const server = http.createServer(async (request, response) => {
    if (state.offline) { request.socket.destroy(); return; }
    assert.equal(request.headers.authorization, `ZenMindEngine ${authority.managementSecret}`);
    assert.equal(request.headers['x-zenmind-desktop-host'], 'fixture-host');
    let body = ''; for await (const chunk of request) body += chunk;
    if (request.url.endsWith('/status')) {
      response.end(JSON.stringify({ code: 200, data: { apiVersion: 1, hostId: 'fixture-host', epoch: state.epoch, ready: state.revision > 0, appliedRevision: state.revision } })); return;
    }
    assert.equal(request.headers['x-zenmind-engine-epoch'], state.epoch);
    const snapshot = JSON.parse(body); state.requests.push(snapshot);
    assert.equal(request.url, '/api/desktop/agent-engines/snapshot');
    assert.ok(snapshot.revision >= state.revision);
    state.revision = snapshot.revision; state.entries = snapshot.entries;
    if (state.loseAck) { state.loseAck = false; request.socket.destroy(); return; }
    if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
    response.end(JSON.stringify({ code: 200, data: { apiVersion: 1, appliedRevision: state.ackRevision ?? state.revision, action: 'applied', ready: true, drainingEngineIds: state.draining ?? [] } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { state, url: `http://127.0.0.1:${server.address().port}` };
}

test('installed engines synchronize complete desired state and only acknowledge matching revisions', { skip: process.platform === 'win32' }, async t => {
  const { createAgentEngineSync } = require('../dist-electron/main/modules/plugins/engine-resources');
  const f = await engineFixture(t);
  let url = '';
  const sync = createAgentEngineSync(f.app, { getHostId: () => 'fixture-host', getBaseUrl: async () => url });
  const host = await engineManagementServer(t, sync); url = host.url;
  await f.plugins.installFromArchive(f.app, await f.archive());
  await sync.reconcile();
  assert.equal(host.state.entries.length, 1);
  assert.equal(host.state.entries[0].enabled, false);
  assert.equal(sync.status('engine-fixture').syncState, 'applied');
  await sync.setEnabled('engine-fixture', true);
  assert.equal(host.state.entries[0].enabled, true);
  host.state.loseAck = true;
  await sync.setEnabled('engine-fixture', false);
  assert.equal(sync.status('engine-fixture').syncState, 'pending');
  const revision = host.state.revision;
  await sync.reconcile();
  assert.equal(host.state.revision, revision);
  assert.equal(sync.status('engine-fixture').syncState, 'applied');
  host.state.ackRevision = revision - 1;
  await sync.reconcile();
  assert.equal(sync.status('engine-fixture').syncState, 'pending', 'a stale acknowledgement never marks the current desired state applied');
  delete host.state.ackRevision;
  await sync.reconcile();
  assert.equal(sync.status('engine-fixture').syncState, 'applied');
});

test('Desktop runtime update waits for both engines and keeps admission closed until cleanup or rollback', { skip: process.platform === 'win32' }, async t => {
  const { createAgentEngineSync } = require('../dist-electron/main/modules/plugins/engine-resources');
  const f = await engineFixture(t); let url = '';
  const sync = createAgentEngineSync(f.app, { getHostId: () => 'fixture-host', getBaseUrl: async () => url });
  const host = await engineManagementServer(t, sync); url = host.url;
  const other = manifest(); other.id = 'other-engine'; other.desktop.bundleTopLevelDir = other.id;
  for (const input of [manifest(), other]) {
    await f.plugins.installFromArchive(f.app, await f.archive(input));
    await sync.setEnabled(input.id, true);
  }
  for (const draining of [['engine-fixture/engine', 'other-engine/engine'], ['other-engine/engine']]) {
    host.state.draining = draining;
    await assert.rejects(() => sync.prepareDesktopUpdate(), /updateBusy/);
    assert.ok(host.state.requests.some(snapshot => snapshot.entries.length === 2 && snapshot.entries.every(entry => !entry.enabled)));
    assert.ok(host.state.entries.every(entry => entry.enabled), 'refused update restores original intent');
  }
  host.state.draining = [];
  const resume = await sync.prepareDesktopUpdate();
  assert.ok(host.state.entries.every(entry => !entry.enabled));
  await sync.reconcile();
  assert.ok(host.state.entries.every(entry => !entry.enabled), 'reconnect cannot reopen admission during installer cleanup');
  await sync.setEnabled('other-engine', true);
  assert.ok(host.state.entries.every(entry => !entry.enabled), 'queued plugin actions cannot reopen admission either');
  assert.equal(sync.status('engine-fixture').desired, 'enabled');
  await resume();
  assert.ok(host.state.entries.every(entry => entry.enabled), 'cleanup failure can restore the same desired state');
  host.state.loseAck = true;
  await assert.rejects(() => sync.prepareDesktopUpdate(), /updateBusy/);
  assert.ok(host.state.entries.every(entry => entry.enabled), 'a lost acknowledgement is not permission to update');
  host.state.offline = true;
  await assert.rejects(() => sync.prepareDesktopUpdate(), /updateBusy/);
  assert.equal(sync.status('engine-fixture').syncState, 'pending');
  host.state.offline = false;
  await sync.reconcile();
  assert.ok(host.state.entries.every(entry => entry.enabled));
});

test('slow directory publication does not consume the idle engine drain grace period', {skip:process.platform==='win32'}, async t=>{
  const {createAgentEngineSync}=require('../dist-electron/main/modules/plugins/engine-resources');
  const f=await engineFixture(t);let url='';
  const sync=createAgentEngineSync(f.app,{getHostId:()=> 'fixture-host',getBaseUrl:async()=>url});
  const host=await engineManagementServer(t,sync);url=host.url;
  await f.plugins.installFromArchive(f.app,await f.archive());await sync.setEnabled('engine-fixture',true);
  host.state.delay=2100;let confirmations=0;
  Object.defineProperty(host.state,'draining',{get:()=>++confirmations===1?['engine-fixture/engine']:[]});
  const resume=await sync.prepareDesktopUpdate();
  assert.equal(confirmations,2,'recheck leases after the first publication acknowledgement');
  assert.equal(host.state.entries[0].enabled,false);
  host.state.delay=0;await resume();
});

test('uninstall waits for its own leases and ignores another plugin draining', { skip: process.platform === 'win32' }, async t => {
  const { createAgentEngineSync } = require('../dist-electron/main/modules/plugins/engine-resources');
  const f = await engineFixture(t); let url = '';
  const sync = createAgentEngineSync(f.app, { getHostId: () => 'fixture-host', getBaseUrl: async () => url });
  const host = await engineManagementServer(t, sync); url = host.url;
  f.host.revoke = (_app, id) => sync.revoke(id);
  await f.plugins.installFromArchive(f.app, await f.archive());
  await sync.setEnabled('engine-fixture', true);
  host.state.draining = ['engine-fixture/agent'];
  const delivery = f.delivery().directory;
  await assert.rejects(f.plugins.uninstall(f.app, 'engine-fixture'), /engine_busy/);
  assert.equal(sync.status('engine-fixture').desired, 'removed');
  assert.equal(fs.existsSync(delivery), true);
  host.state.draining = ['engine-fixture-other/agent'];
  assert.equal((await f.plugins.uninstall(f.app, 'engine-fixture')).ok, true, 'another plugin with a shared ID prefix must not block uninstall');
  assert.equal(fs.existsSync(delivery), false);
});

test('candidate protocol validation can finish beyond the directory read deadline', { skip: process.platform === 'win32' }, async t => {
  const { createAgentEngineSync } = require('../dist-electron/main/modules/plugins/engine-resources');
  const f = await engineFixture(t); let url = '';
  const sync = createAgentEngineSync(f.app, { getHostId: () => 'fixture-host', getBaseUrl: async () => url });
  const host = await engineManagementServer(t, sync); url = host.url;
  await f.plugins.installFromArchive(f.app, await f.archive());
  host.state.delay = 5500;
  await sync.setEnabled('engine-fixture', true);
  assert.equal(sync.status('engine-fixture').syncState, 'applied');
});

test('offline disable and uninstall preserve latest intent across reconnect and Desktop reconstruction', { skip: process.platform === 'win32' }, async t => {
  const { createAgentEngineSync } = require('../dist-electron/main/modules/plugins/engine-resources');
  const f = await engineFixture(t); let url = '';
  const ports = { getHostId: () => 'fixture-host', getBaseUrl: async () => url };
  const sync = createAgentEngineSync(f.app, ports);
  const host = await engineManagementServer(t, sync); url = host.url;
  await f.plugins.installFromArchive(f.app, await f.archive());
  await sync.setEnabled('engine-fixture', true);
  host.state.offline = true;
  await sync.setEnabled('engine-fixture', false);
  assert.equal(sync.status('engine-fixture').desired, 'disabled');
  const ack = await sync.revoke('engine-fixture');
  assert.equal(ack.ok, false);
  assert.equal(fs.existsSync(f.delivery().directory), true);
  assert.equal(sync.status('engine-fixture').desired, 'removed');
  host.state.offline = false;
  const restarted = createAgentEngineSync({ ...f.app }, ports);
  const nextHost = await engineManagementServer(t, restarted); url = nextHost.url;
  await restarted.reconcile();
  assert.deepEqual(nextHost.state.entries, []);
  assert.equal((await restarted.revoke('engine-fixture')).ok, true);
});

test('existing plugin install, enable, update and uninstall lifecycle synchronizes engines without starting the adapter', { skip: process.platform === 'win32' }, async t => {
  const { createAgentEngineSync } = require('../dist-electron/main/modules/plugins/engine-resources');
  const f = await engineFixture(t); let url = '';
  const sync = createAgentEngineSync(f.app, { getHostId: () => 'fixture-host', getBaseUrl: async () => url });
  const host = await engineManagementServer(t, sync); url = host.url;
  f.host.revoke = (_app, id) => sync.revoke(id);
  assert.equal((await f.plugins.installFromArchive(f.app, await f.archive())).ok, true);
  assert.equal(host.state.entries.length, 1, 'committed installation is automatically published');
  await f.services.startService(f.app, 'engine-fixture');
  assert.equal(host.state.entries[0].enabled, true);
  const updated = manifest(); updated.version = '0.2.0';
  assert.equal((await f.plugins.installFromArchive(f.app, await f.archive(updated))).ok, true);
  assert.equal(host.state.entries[0].pluginVersion, '0.2.0');
  assert.equal(host.state.entries[0].enabled, true, 'upgrade preserves enabled intent');
  host.state.offline = true;
  await assert.rejects(f.plugins.uninstall(f.app, 'engine-fixture'));
  assert.equal(sync.status('engine-fixture').desired, 'removed');
  assert.ok(fs.existsSync(f.delivery().directory));
  host.state.offline = false;
  await sync.reconcile();
  assert.deepEqual(host.state.entries, []);
  assert.equal((await f.plugins.uninstall(f.app, 'engine-fixture')).ok, true);
  assert.equal(fs.existsSync(f.deliveryRoot) && fs.readdirSync(f.deliveryRoot).length > 0, false);
  await f.plugins.installFromArchive(f.app, await f.archive());
  assert.equal(host.state.entries.length, 1);
  assert.equal(host.state.entries[0].enabled, false, 'explicit reinstallation clears the removal tombstone without silently enabling');
});

test('Platform bootstrap survives daemon command exit until readiness reconciliation, and is cleaned on failure', { skip: process.platform === 'win32' }, async t => {
  const { createAgentEngineSync } = require('../dist-electron/main/modules/plugins/engine-resources');
  const { runServiceCommand } = require('../dist-electron/main/modules/services/manager/service-command');
  const { getServiceLayout } = require('../dist-electron/main/modules/services/manager/layout');
  const f = await engineFixture(t);
  const sync = createAgentEngineSync(f.app, { getHostId: () => 'fixture-host', getBaseUrl: async () => '' });
  const service = registry.registerService({ id: 'agent-platform', name: 'Platform', version: '1.0.0', description: '',
    lifecycle: { start: ['node', 'probe.cjs'], stop: ['node', 'probe.cjs'] }, desktop: { bundleTopLevelDir: 'agent-platform', ssoIdTokenFile: 'v1' }, runtime: { requiredPaths: ['probe.cjs'] }
  }, { defaultKind: 'builtin' });
  const layout = getServiceLayout(f.app, service); fs.mkdirSync(layout.programDir, { recursive: true });
  fs.writeFileSync(path.join(layout.programDir, 'probe.cjs'), `const fs=require('node:fs');
    const i=process.argv.indexOf('--agent-engine-bootstrap-file'); if(i<0)process.exit(3);
    const file=process.argv[i+1], value=JSON.parse(fs.readFileSync(file));
    if(process.argv.includes(value.managementSecret)||Object.values(process.env).includes(value.managementSecret))process.exit(4);
    fs.writeFileSync('observed.json',JSON.stringify({file,hostId:value.hostId}));
    if(process.argv.includes('--fail'))process.exit(5);`);
  const integrationPorts = { getPluginBridgeEnv: () => ({}), getPluginSettingsEnv: () => ({}), agentEngines: () => sync };
  const opts = { refreshBuiltinAsset: false, commandKind: 'start', integrationPorts };
  await runServiceCommand(f.app, service, [process.execPath, 'probe.cjs'], 'started', opts);
  const observed = JSON.parse(fs.readFileSync(path.join(layout.programDir, 'observed.json')));
  assert.equal(observed.hostId, 'fixture-host');
  assert.equal(fs.existsSync(observed.file), true, 'daemon may consume bootstrap after its launcher exits');
  await sync.reconcile();
  assert.equal(fs.existsSync(observed.file), true, 'failed early reconciliation must not delete unread authority');
  const bootstrap = JSON.parse(fs.readFileSync(observed.file, 'utf8'));
  assert.equal(bootstrap.hostId, 'fixture-host');
  fs.rmSync(observed.file); // Platform consumes the one-use bootstrap before becoming healthy.
  await sync.reconcile();
  assert.equal(fs.existsSync(path.dirname(observed.file)), false);
  assert.equal(sync.hasAuthority(), true);
  await assert.rejects(runServiceCommand(f.app, service, [process.execPath, 'probe.cjs', '--fail'], 'started', opts));
  assert.equal(sync.hasAuthority(), false);
  assert.equal(fs.existsSync(JSON.parse(fs.readFileSync(path.join(layout.programDir, 'observed.json'))).file), false);
});

test('engine service status distinguishes pending intent and directory states without leaking management authority', { skip: process.platform === 'win32' }, async t => {
  const { createAgentEngineSync } = require('../dist-electron/main/modules/plugins/engine-resources');
  const f = await engineFixture(t); let url = '', directory;
  const sync = createAgentEngineSync(f.app, { getHostId: () => 'fixture-host', getBaseUrl: async () => url, getDirectory: async () => directory });
  const host = await engineManagementServer(t, sync); url = host.url;
  await f.plugins.installFromArchive(f.app, await f.archive());
  await sync.setEnabled('engine-fixture', true);
  directory = { apiVersion: 1, ready: true, revision: host.state.revision, catalogGeneration: 'generation-one', engines: [
    { engineId: 'engine-fixture/engine', pluginId: 'engine-fixture', pluginVersion: '0.1.0', dependencyState: 'ready', authState: 'auth_required', runtimeState: 'stopped' }
  ] };
  await sync.refreshDirectory();
  assert.equal(sync.status('engine-fixture').authState, 'auth_required');
  assert.equal(sync.status('engine-fixture').runtimeState, 'stopped');
  directory.ready = false;
  await sync.refreshDirectory();
  assert.equal(sync.status('engine-fixture').syncState, 'pending', 'a fresh, unready Platform cannot inherit a cached acknowledgement');
  directory.ready = true;
  await sync.reconcile();
  sync.disconnected();
  assert.equal(sync.status('engine-fixture').syncState, 'pending');
  assert.equal(sync.status('engine-fixture').authState, 'unknown');
  const { createPluginTestRuntime } = require('./helpers/plugin-lifecycle.cjs');
  const stateReader = createPluginTestRuntime(f.root, { readAgentEngineState: (_app, id) => sync.status(id) });
  const status = await stateReader.services.getServiceState(f.app, 'engine-fixture');
  assert.equal(status.agentEngineSync.syncState, 'pending');
  assert.match(status.message, /待同步|pending/i);
  assert.equal(JSON.stringify(status.agentEngineSync).includes('secret'), false);
  host.state.offline = true;
  const enabled = await stateReader.services.startService(f.app, 'engine-fixture');
  assert.match(enabled.message, /待同步|pending/i, 'command response must not claim the offline engine is loaded');
  assert.notEqual(enabled.service.status, 'running', 'pending enable must not count as a running plugin');
  assert.equal(enabled.ok, false, 'failed enable must remain retryable, not report success');
  const disabled = await stateReader.services.stopService(f.app, 'engine-fixture');
  assert.match(disabled.message, /待同步|pending/i);
  assert.equal(disabled.ok, false);
  assert.equal(disabled.service.agentEngineSync.desired, 'disabled', 'pending activation can still be revoked');
  host.state.offline = false;
  directory = undefined;
  const retried = await stateReader.services.startService(f.app, 'engine-fixture');
  assert.equal(retried.ok, true, retried.message);
  assert.equal(retried.service.status, 'running');
  assert.equal(retried.service.agentEngineSync.syncState, 'applied');
});

test('reconnect publishes latest queued intent to a fresh Platform and refuses a partial local inventory', { skip: process.platform === 'win32' }, async t => {
  const { createAgentEngineSync } = require('../dist-electron/main/modules/plugins/engine-resources');
  const f = await engineFixture(t); let url = '';
  const sync = createAgentEngineSync(f.app, { getHostId: () => 'fixture-host', getBaseUrl: async () => url });
  const host = await engineManagementServer(t, sync); url = host.url;
  await f.plugins.installFromArchive(f.app, await f.archive());
  host.state.offline = true;
  await Promise.all([sync.setEnabled('engine-fixture', true), sync.setEnabled('engine-fixture', false), sync.reconcile()]);
  const next = await engineManagementServer(t, sync); url = next.url;
  await sync.reconcile();
  assert.equal(next.state.entries[0].enabled, false);
  assert.equal(sync.status('engine-fixture').syncState, 'applied');
  const pointer = path.join(getServiceStateRoot(f.app, 'engine-fixture', 'plugin'), 'agent-engine-delivery.json');
  fs.rmSync(pointer);
  const requests = next.state.requests.length;
  await sync.reconcile();
  assert.equal(next.state.requests.length, requests, 'an incomplete inventory must not silently revoke other engines');
  registry.unregisterService('engine-fixture');
  await sync.reconcile();
  assert.equal(next.state.requests.length, requests, 'loader failure must not turn a previously known plugin into an implicit uninstall');
  assert.equal(sync.status('engine-fixture').syncState, 'pending');
});

test('an older directory response cannot overwrite a later notification or a disconnected state', { skip: process.platform === 'win32' }, async t => {
  const { createAgentEngineSync } = require('../dist-electron/main/modules/plugins/engine-resources');
  const f = await engineFixture(t); let url = '', block = false; const pending = [];
  const sync = createAgentEngineSync(f.app, { getHostId: () => 'fixture-host', getBaseUrl: async () => url,
    getDirectory: () => block ? new Promise(resolve => pending.push(resolve)) : Promise.resolve(undefined) });
  const host = await engineManagementServer(t, sync); url = host.url;
  await f.plugins.installFromArchive(f.app, await f.archive());
  const directory = authState => ({ apiVersion: 1, ready: true, revision: host.state.revision, catalogGeneration: 'generation', engines: [
    { pluginId: 'engine-fixture', authState, dependencyState: 'ready', runtimeState: 'stopped' }
  ] });
  block = true;
  const old = sync.refreshDirectory(), latest = sync.refreshDirectory();
  pending[1](directory('auth_required')); await latest;
  pending[0](directory('authenticated')); await old;
  assert.equal(sync.status('engine-fixture').authState, 'auth_required');
  const disconnected = sync.refreshDirectory(); sync.disconnected();
  pending[2](directory('authenticated')); await disconnected;
  assert.equal(sync.status('engine-fixture').authState, 'unknown');
});

// Opt-in acceptance uses real built archives; ordinary unit runs never call a model.
test('independent real plugin ZIPs install through Desktop and retain the complete build fingerprint', {
  skip: !process.env.ACP_PACKAGE_ROOT || process.platform !== 'darwin', timeout: 600000
}, async t => {
  const f = await engineFixture(t);
  const host = { ...f.host, prepareNodeRuntime: async () => {
    const runtime = await f.host.prepareNodeRuntime();
    const bin = path.join(getDesktopRoot(f.app), 'bin');
    fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
    const node = path.join(bin, 'node');
    fs.copyFileSync(runtime.node, node); fs.chmodSync(node, 0o700);
    return { ...runtime, node };
  } };
  const plugins = createPluginLifecycle(f.services, f.webs.webappManager, host);
  const entries = [];
  for (const name of ['codex', 'claude']) {
    const id = `zenmind-agent-${name}`;
    const directory = path.join(process.env.ACP_PACKAGE_ROOT, id, '0.1.0', 'darwin-arm64');
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'release.json')));
    const result = await plugins.installFromArchive(f.app, path.join(directory, receipt.archive));
    assert.equal(result.ok, true, result.message);
    const pointer = JSON.parse(fs.readFileSync(path.join(getServiceStateRoot(f.app, id, 'plugin'), 'agent-engine-delivery.json')));
    const record = JSON.parse(fs.readFileSync(path.join(f.deliveryRoot, pointer.installationRef, 'record.json')));
    assert.equal(record.artifactDigest, receipt.artifactDigest, 'ZIP extraction must preserve native executable modes and every byte');
    assert.equal(record.source.archiveDigest, receipt.archiveDigest);
    entries.push({ engineId: `${id}/${name}`, pluginId: id, pluginVersion: '0.1.0', installationRef: pointer.installationRef, artifactDigest: record.artifactDigest, enabled: true });
    t.diagnostic(`${name}: real ZIP installed; complete fingerprint matches; archive ${receipt.archiveDigest}`);
  }
  if (process.env.ACP_LIVE_AUTH === '1') {
    const { spawn } = await import('node:child_process');
    fs.chmodSync(f.root, 0o700);
    const bootstrap = path.join(f.root, 'bootstrap.json');
    fs.writeFileSync(bootstrap, JSON.stringify({ schemaVersion: 1, hostId: 'fixture-host', launchNonce: 'acceptance', managementSecret: 'a'.repeat(64), deliveryRoot: f.deliveryRoot }), { mode: 0o600 });
    const snapshot = path.join(f.root, 'snapshot.json');
    fs.writeFileSync(snapshot, JSON.stringify({ apiVersion: 1, revision: 1, entries }), { mode: 0o600 });
    const child = spawn('go', ['test', './internal/runtime/acp', '-run', '^TestInstalledPluginsProductQuery$', '-count=1', '-v', '-timeout=8m'], {
      cwd: path.resolve('../agent-platform'), env: { ...process.env, ACP_ACCEPTANCE_ROOT: f.root }, stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Platform product acceptance exited ${code}`)));
    });
  }
  await assert.rejects(() => plugins.uninstall(f.app, 'zenmind-agent-codex'), /revocation acknowledgement/);
  assert.ok(registry.getService('zenmind-agent-codex'), 'disconnected uninstall must preserve the installed package');
  assert.ok(registry.getService('zenmind-agent-claude'));

});

test('standalone executable ZIP installs without Node, npm metadata or an ACP JS SDK', async t => {
  const f = await engineFixture(t);
  f.host.prepareNodeRuntime = async () => { throw new Error('Executable plugins must not prepare Node'); };
  const input = manifest();
  const engine = input.resources.agentEngines[0];
  engine.launch = { runtime: 'executable', entry: process.platform === 'win32' ? 'bin/agent.exe' : 'bin/agent', args: ['acp', 'argument with spaces'] };
  delete engine.adapter;
  engine.dependencies = [{ id: 'assets', version: '1.0.0', delivery: 'bundled', path: 'assets' }];
  const archive = await f.archive(input, { 'assets/template.txt': 'template' }, zip => {
    zip.remove(`${input.id}/node_modules`);
    zip.remove(`${input.id}/dist`);
    zip.file(`${input.id}/${engine.launch.entry}`, 'not executed during install', { unixPermissions: 0o100755 });
  });
  const result = await f.plugins.installFromArchive(f.app, archive);
  assert.equal(result.ok, true, result.message);
  const { directory } = f.delivery();
  assert.equal(fs.existsSync(path.join(directory, 'package', engine.launch.entry)), true);
  assert.equal(fs.existsSync(path.join(directory, 'package', 'node_modules')), false);
});

test('Node engines need the declared runtime but do not need an npm adapter or JS SDK layout', async t => {
  const f = await engineFixture(t);
  const input = manifest();
  delete input.resources.agentEngines[0].adapter;
  const archive = await f.archive(input, {}, zip => zip.remove(`${input.id}/node_modules`));
  const result = await f.plugins.installFromArchive(f.app, archive);
  assert.equal(result.ok, true, result.message);
  assert.equal(fs.existsSync(path.join(f.delivery().directory, 'package/node_modules')), false);
});

test('executable launch rejects a non-executable entry before installing', async t => {
  const f = await engineFixture(t);
  f.host.prepareNodeRuntime = async () => { throw new Error('Unexpected Node dependency'); };
  const input = manifest();
  const engine = input.resources.agentEngines[0];
  engine.launch = {runtime: 'executable', entry: 'bin/agent.cmd', args: []};
  engine.dependencies = [];
  delete engine.adapter;
  const archive = await f.archive(input, {}, zip => {
    zip.remove(`${input.id}/node_modules`);
    zip.file(`${input.id}/${engine.launch.entry}`, 'not executable', {unixPermissions: 0o100644});
  });
  await assert.rejects(() => f.plugins.installFromArchive(f.app, archive), /executable|entry/i);
  assert.equal(fs.existsSync(getPluginInstallDir(f.app, input.id, input.version)), false);
});
