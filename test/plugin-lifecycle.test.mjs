import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const { createPluginTestRuntime } = require('./helpers/plugin-lifecycle.cjs');
const { installPluginFromArchive, getPluginInstallDir } = require('../dist-electron/main/modules/plugins/loader');
const { createPluginLifecycle } = require('../dist-electron/main/modules/plugins/lifecycle');
const { initializeService: unboundInitialize } = require('../dist-electron/main/modules/services');
const { __testInternals: registry } = require('../dist-electron/main/modules/services/service-registry');
const { installMarketItem, uninstallMarketItem } = require('../dist-electron/main/modules/marketplace/runtime');
const { readInstalledRecords } = require('../dist-electron/main/modules/marketplace/common');
const { getDesktopWebappDataRoot, getDesktopWebappStateRoot } = require('../dist-electron/main/infrastructure/filesystem/user-paths');
const pluginId = 'notes-fixture';
const webappId = 'webapp-4abf37ad067b5336';

async function fixture(t, overrides) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenmind-plugin-lifecycle-'));
  registry.clearServices();
  const runtime = createPluginTestRuntime(root, overrides);
  t.after(async () => {
    await runtime.webs.webappRuntime.stopAll(runtime.app);
    registry.clearServices();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const zip = new JSZip();
  zip.file(`${pluginId}/manifest.json`, JSON.stringify({
    pluginApiVersion: 1, id: pluginId, name: 'Notes fixture', version: 'v0.2.0',
    runtime: { requiredPaths: ['manifest.json', 'webapp/webapp.json', 'webapp/frontend/index.html'] },
    resources: { webapps: [{ id: webappId, source: 'webapp' }] },
    desktop: { bundleTopLevelDir: pluginId }
  }));
  zip.file(`${pluginId}/webapp/webapp.json`, JSON.stringify({
    schemaVersion: 2, id: webappId, key: pluginId, label: 'Notes fixture', version: '0.2.0', target: 'any',
    frontend: { root: 'frontend', index: 'index.html', routeConfig: { backendPrefixes: [] } },
    desktopBridge: { version: 1 }
  }));
  zip.file(`${pluginId}/webapp/frontend/index.html`, '<!doctype html><title>Notes fixture</title>');
  const archive = path.join(root, 'notes.zip');
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  fs.writeFileSync(archive, bytes);
  return { ...runtime, archive, bytes };
}

test('ZIP import initializes, starts, preserves notes through stop/reimport, and uninstalls through bound lifecycles', async t => {
  const { app, archive, services, webs, plugins } = await fixture(t);
  const imported = await plugins.installFromArchive(app, archive);
  assert.equal(imported.ok, true, imported.message);
  assert.equal((await services.getServiceState(app, pluginId)).status, 'stopped');
  assert.equal(webs.webappManager.listInstalled(app).length, 0);
  const started = await services.startService(app, pluginId);
  assert.equal(started.ok, true, started.message);
  assert.equal(webs.webappManager.listInstalled(app)[0]?.id, webappId);
  const data = path.join(getDesktopWebappDataRoot(app, webappId), 'state.json');
  fs.mkdirSync(path.dirname(data), { recursive: true });
  fs.writeFileSync(data, '{"notes":["keep my note"]}');
  assert.equal((await services.stopService(app, pluginId)).ok, true);
  assert.equal(webs.webappManager.listInstalled(app).length, 0);
  assert.match(fs.readFileSync(data, 'utf8'), /keep my note/);
  assert.equal((await plugins.installFromArchive(app, archive)).ok, true);
  assert.equal((await services.startService(app, pluginId)).ok, true);
  // Reimport an enabled resource plugin: initialization must use the same WebApp manager.
  const upgraded = await plugins.installFromArchive(app, archive);
  assert.equal(upgraded.ok, true, upgraded.message);
  assert.equal((await services.getServiceState(app, pluginId)).status, 'running');
  assert.match(fs.readFileSync(data, 'utf8'), /keep my note/);
  const removed = await plugins.uninstall(app, pluginId);
  assert.equal(removed.ok, true, removed.message);
  assert.equal(fs.existsSync(getPluginInstallDir(app, pluginId, 'v0.2.0')), false);
  assert.equal(webs.webappManager.listInstalled(app).length, 0);
});

test('uninstall after stop still refuses cleanup when publication is active or its state is missing', async t => {
  const { app, archive, services, plugins } = await fixture(t);
  await plugins.installFromArchive(app, archive);
  assert.equal((await services.startService(app, pluginId)).ok, true);
  assert.equal((await services.stopService(app, pluginId)).ok, true);
  const statePath = path.join(getDesktopWebappStateRoot(app, webappId), 'publish.json');
  const state = fs.readFileSync(statePath, 'utf8');
  fs.writeFileSync(statePath, JSON.stringify({ ...JSON.parse(state), active: true, status: 'published' }));
  await assert.rejects(() => plugins.uninstall(app, pluginId));
  assert.equal(fs.existsSync(getPluginInstallDir(app, pluginId)), true);
  fs.rmSync(statePath);
  await assert.rejects(() => plugins.uninstall(app, pluginId));
  assert.equal(fs.existsSync(getPluginInstallDir(app, pluginId)), true);
  fs.writeFileSync(statePath, state);
  assert.equal((await plugins.uninstall(app, pluginId)).ok, true);
});

test('a plugin left in the reported failed initialization state recovers without deleting notes', async t => {
  const { app, archive, services, plugins } = await fixture(t);
  const failed = await installPluginFromArchive(app, archive, unboundInitialize);
  assert.equal(failed.ok, false);
  assert.match(failed.message, /Services integration ports must be supplied/);
  const data = path.join(getDesktopWebappDataRoot(app, webappId), 'state.json');
  fs.mkdirSync(path.dirname(data), { recursive: true });
  fs.writeFileSync(data, 'existing notes');
  const recovered = await services.initializeService(app, pluginId);
  assert.equal(recovered.ok, true, recovered.message);
  assert.equal((await plugins.installFromArchive(app, archive)).ok, true);
  assert.equal(fs.readFileSync(data, 'utf8'), 'existing notes');
});

test('missing initialization dependency rejects before replacing an existing plugin', async t => {
  const { app, archive, plugins } = await fixture(t);
  assert.equal((await plugins.installFromArchive(app, archive)).ok, true);
  const marker = path.join(getPluginInstallDir(app, pluginId), 'keep.txt');
  fs.writeFileSync(marker, 'existing installation');
  await assert.rejects(() => installPluginFromArchive(app, archive), /composition root/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'existing installation');
});

test('failed stop prevents uninstall from deleting the plugin and its resources', async t => {
  const { app, archive, services, webs, plugins } = await fixture(t);
  await plugins.installFromArchive(app, archive);
  assert.equal((await services.startService(app, pluginId)).ok, true);
  const blocked = createPluginLifecycle({
    ...services, stopService: async () => ({ ok: false, message: 'Stop failed' })
  }, webs.webappManager);
  assert.deepEqual(await blocked.uninstall(app, pluginId), { ok: false, message: 'Stop failed' });
  assert.equal(fs.existsSync(getPluginInstallDir(app, pluginId)), true);
  assert.equal(webs.webappManager.listInstalled(app)[0]?.id, webappId);
  assert.equal((await plugins.uninstall(app, pluginId)).ok, true);
});

test('market install/uninstall share the bound lifecycle and failed initialization does not record an install', async t => {
  let fail = true;
  const resources = require('../dist-electron/main/modules/plugins/resources');
  const { app, bytes, services, webs, plugins } = await fixture(t, {
    initializePluginResourceState(...args) {
      if (fail) throw new Error('Fixture initialization failure');
      return resources.initializePluginResourceState(...args);
    }
  });
  const options = {
    plugins, webs,
    catalog: { schemaVersion: 1, items: [{
      id: pluginId, type: 'plugin', name: 'Notes fixture', version: 'v0.2.0', tags: [],
      assets: { universal: {
        url: 'https://fixtures.invalid/notes.zip', archiveType: 'zip', sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex')
      } }
    }] },
    fetchImpl: async () => new Response(bytes, { status: 200 })
  };
  const failed = await installMarketItem(app, pluginId, options);
  assert.equal(failed.ok, false);
  assert.match(failed.message, /Fixture initialization failure/);
  assert.deepEqual(readInstalledRecords(app), []);
  fail = false;
  const installed = await installMarketItem(app, pluginId, options);
  assert.equal(installed.ok, true, installed.message);
  assert.equal(readInstalledRecords(app).find(record => record.id === pluginId)?.source, 'cloud');
  assert.equal((await services.startService(app, pluginId)).ok, true);
  const removed = await uninstallMarketItem(app, pluginId, options);
  assert.equal(removed.ok, true, removed.message);
  assert.equal(readInstalledRecords(app).some(record => record.id === pluginId), false);
  assert.equal(webs.webappManager.listInstalled(app).length, 0);
});
