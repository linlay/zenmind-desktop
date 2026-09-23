// Run with Electron after npm run build:main:types. Uses a temporary profile.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { transitionWindowFullScreen } = require('../dist-electron/main/modules/shell/ipc.js');
const { configureMainWindowLifecycleEvents } = require('../dist-electron/main/modules/shell/main-window-events.js');

const output = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-fullscreen-qa-'));
app.setPath('userData', path.join(output, 'profile'));
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
let win;
(async () => {
  assert.equal(process.platform, 'win32', 'This smoke test requires native Windows');
  await app.whenReady();
  buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/styles.css')],
    outfile: path.join(output, 'shell.css'), bundle: true });
  fs.writeFileSync(path.join(output, 'preload.cjs'), `
    require('electron').ipcRenderer.on('desktopShell.windowStateChanged', (_, state) => {
      document.querySelector('.app-shell').classList.toggle('is-window-fullscreen', state.isFullScreen);
      document.querySelector('.app-system-bar').style.display = state.isFullScreen ? 'none' : '';
    });
  `);
  fs.writeFileSync(path.join(output, 'host.html'), `<!doctype html><html lang="zh-CN" data-theme="light">
    <meta charset="utf-8"><link rel="stylesheet" href="shell.css">
    <style>html,body{height:100%;margin:0}.app-content{flex:1}.app-main{padding:16px}
    .chat-work-panel-body{padding:12px}.status{float:right}</style>
    <div class="app-shell is-windows-platform has-chat-work-panel" style="--chat-work-panel-width:480px">
      <div class="app-system-bar"><div class="app-system-bar-drag-region"><span class="app-system-bar-product-name">Windows 全屏回归</span></div><div class="app-system-bar-window-controls">
        <button class="app-system-bar-control">—</button><button class="app-system-bar-control">□</button><button class="app-system-bar-control is-close">×</button></div></div>
      <div class="app-content"><main class="app-main">主聊天区域</main>
        <div class="work-panel-host"><aside class="chat-work-panel is-visible has-panel-toggle">
          <div class="chat-work-panel-tabs">概览 ＋</div><div class="chat-work-panel-body">
          <span class="status">已完成 · 3分59秒</span>运行信息<hr>文件修改<br>dashboard.html</div>
        </aside></div>
      </div><div class="app-window-controls-layer"><div class="main-chat-header-actions">
        <button class="main-chat-header-action">◧</button></div></div>
    </div></html>`);
  win = new BrowserWindow({ width: 1180, height: 760, show: false, titleBarStyle: 'hidden',
    webPreferences: { preload: path.join(output, 'preload.cjs'), contextIsolation: true } });
  await win.loadFile(path.join(output, 'host.html'));
  const messages = [];
  const send = win.webContents.send.bind(win.webContents);
  win.webContents.send = (channel, payload) => {
    if (channel === 'desktopShell.windowStateChanged') messages.push(payload);
    send(channel, payload);
  };
  configureMainWindowLifecycleEvents(win, {
    platform: 'win32', lifecycle: { applyAppearance() {}, hideForClose() {}, cancelPendingClose() {} },
    isDevToolsShortcut: () => false, isHandlingQuit: () => true, requestAppQuit() {}, clearWindow() {}
  });
  win.showInactive();
  for (const maximized of [false, true]) {
    if (maximized) win.maximize();
    for (const enabled of [true, false, true, false]) {
      const result = await transitionWindowFullScreen(win, enabled, { platform: 'win32' });
      await delay(100);
      assert.deepEqual(result, { ok: true, isFullScreen: enabled });
      assert.equal(messages.at(-1).isFullScreen, enabled, 'Renderer receives current native state');
      await win.webContents.executeJavaScript(`
        document.querySelector('.app-shell').classList.toggle('is-work-panel-fullscreen', ${enabled});
        document.querySelector('.work-panel-host').classList.toggle('is-fullscreen', ${enabled});
      `);
      const bounds = await win.webContents.executeJavaScript(`(() => {
        const rect = s => { const r = document.querySelector(s).getBoundingClientRect(); return {top:r.top,bottom:r.bottom}; };
        return {button:rect('.main-chat-header-actions'), tabs:rect('.chat-work-panel-tabs'),
          body:rect('.chat-work-panel-body'), bar:getComputedStyle(document.querySelector('.app-system-bar')).display};
      })()`);
      assert.ok(bounds.button.top >= bounds.tabs.top, JSON.stringify(bounds));
      assert.ok(bounds.button.bottom <= bounds.tabs.bottom, JSON.stringify(bounds));
      assert.ok(bounds.button.bottom <= bounds.body.top, 'Panel button must not overlap overview');
      assert.equal(bounds.bar === 'none', enabled, 'Window controls recover after fullscreen');
      console.log(JSON.stringify({ maximized, enabled, bounds }));
      await delay(100);
      fs.writeFileSync(path.join(output, `${maximized ? 'maximized' : 'normal'}-${enabled ? 'fullscreen' : 'restored'}.png`),
        (await win.webContents.capturePage()).toPNG());
    }
  }
  console.log(`PASS: native transitions, renderer state and layout. Screenshots: ${output}`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  win?.destroy(); app.quit();
});
