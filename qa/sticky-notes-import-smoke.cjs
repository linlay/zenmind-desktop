// Run after build:main:types:
// electron qa/sticky-notes-import-smoke.cjs /absolute/path/to/sticky-notes.zip
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPluginTestRuntime } = require('../test/helpers/plugin-lifecycle.cjs');
const { getDesktopWebappDataRoot } = require('../dist-electron/main/infrastructure/filesystem/user-paths');
const archive = path.resolve(process.argv[2] || '');
if (!fs.statSync(archive).isFile()) throw new Error('Supply the sticky-notes plugin ZIP');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zenmind-notes-import-smoke-'));
app.setPath('userData', path.join(root, 'electron-profile'));
app.on('window-all-closed', () => {});
const runtime = createPluginTestRuntime(root);
const webappId = 'webapp-4abf37ad067b5336';
let win;
const watchdog = setTimeout(() => finish(1, new Error('Smoke test timed out')), 60000);
async function waitFor(expression) {
  for (let i = 0; i < 150; i++) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`UI condition timed out: ${expression}`);
}
async function openNotes() {
  const started = await runtime.services.startService(runtime.app, 'sticky-notes');
  assert.equal(started.ok, true, started.message);
  // Enabling a resource plugin registers its WebApp; opening the WebApp starts its runtime.
  const opened = await runtime.webs.webappRuntime.start(runtime.app, webappId);
  assert.equal(opened.ok, true, opened.message);
  const state = runtime.webs.webappRuntime.getStatus(runtime.app, webappId);
  assert.equal(state.status, 'running');
  assert.ok(state.pid, 'real managed backend process must be running');
  win = new BrowserWindow({ show: false, width: 800, height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadURL(state.webUrl);
  await waitFor('document.getElementById("new")?.disabled === false');
}
async function main() {
  const imported = await runtime.plugins.installFromArchive(runtime.app, archive);
  assert.equal(imported.ok, true, imported.message);
  assert.equal((await runtime.services.getServiceState(runtime.app, 'sticky-notes')).status, 'stopped');
  await openNotes();
  await win.webContents.executeJavaScript(`
    document.getElementById('new').click();
    for (const [id, text] of [['note-title', '真实导入回归'], ['note-body', '经过 ZIP 导入、初始化、启动和 Gateway 保存的便签']]) {
      const input = document.getElementById(id); input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  `, true);
  await waitFor('document.getElementById("status").textContent.includes("已保存到本机")');
  const dataPath = path.join(getDesktopWebappDataRoot(runtime.app, webappId), 'state.json');
  const saved = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  assert.equal(saved.value.notes[0].title, '真实导入回归');
  win.destroy();
  assert.equal((await runtime.services.stopService(runtime.app, 'sticky-notes')).ok, true);
  assert.equal((await runtime.plugins.installFromArchive(runtime.app, archive)).ok, true);
  await openNotes();
  assert.equal(await win.webContents.executeJavaScript('document.getElementById("note-title").value'), '真实导入回归');
  assert.deepEqual(JSON.parse(fs.readFileSync(dataPath, 'utf8')), saved);
  win.destroy();
  const removed = await runtime.plugins.uninstall(runtime.app, 'sticky-notes');
  assert.equal(removed.ok, true, removed.message);
  assert.equal(runtime.webs.webappManager.listInstalled(runtime.app).length, 0);
  console.log('PASS actual sticky-notes ZIP: import, initialize, managed backend, gateway UI, autosave, stop, reimport, restore, uninstall');
}
async function finish(code, error) {
  clearTimeout(watchdog);
  if (error) console.error(error);
  if (win && !win.isDestroyed()) win.destroy();
  try { await runtime.webs.webappRuntime.stopAll(runtime.app); }
  finally {
    fs.rmSync(root, { recursive: true, force: true });
    app.exit(code);
  }
}
app.whenReady().then(main).then(() => finish(0), error => finish(1, error));
