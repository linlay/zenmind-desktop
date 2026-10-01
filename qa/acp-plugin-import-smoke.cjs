// Run after build:main:types with the paths of the two freshly built plugin ZIPs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { installPluginFromArchive, getPluginInstallDir } = require('../dist-electron/main/modules/plugins/loader');
const { getService, __testInternals: registry } = require('../dist-electron/main/modules/services/service-registry');
(async () => {
  assert.equal(process.platform, 'darwin', 'macOS smoke test');
  assert.equal(process.argv.slice(2).length, 2, 'pass Claude and Codex ZIP paths');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-plugin-import-'));
  const app = { getPath: name => path.join(root, name) };
  try {
    for (const archive of process.argv.slice(2)) {
      const result = await installPluginFromArchive(app, path.resolve(archive));
      assert.equal(result.ok, true, result.message);
      const service = getService(result.serviceId);
      const dir = getPluginInstallDir(app, service.id, service.version);
      assert.ok(['claude-acp-bridge', 'codex-acp-bridge'].includes(service.id));
      assert.ok(service.bridge.requests.includes('agentPlatform.upsertAcpBridge'));
      fs.accessSync(path.join(dir, 'backend', service.id), fs.constants.X_OK);
      assert.equal(fs.existsSync(path.join(dir, '.env')), false);
      console.log(`PASS ${service.id} ${service.version}: Desktop ZIP import and executable permissions`);
    }
  } finally {
    registry.clearServices();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
