const { app, BrowserWindow, nativeTheme } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const output = process.env.WEBCLIENT_APPEARANCE_QA_DIR;
app.setPath('userData', path.join(output, 'profile'));
app.setPath('sessionData', path.join(output, 'session'));
app.on('web-contents-created', (_event, contents) => {
  contents.on('preload-error', (_event, filename, error) => console.error('preload error:', filename, error));
  contents.on('console-message', (_event, level, message) => { if (level >= 2) console.error('renderer:', message); });
});
const guestHtml = `<!doctype html><html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#edf0f3}input{margin:40px;padding:12px;background:var(--control-input-bg)}
button{padding:12px;background:var(--accent);color:var(--accent-on)}
</style><body><input aria-label="draft" value="keep this draft"><button>Primary</button><script>
window.instance = crypto.randomUUID();
window.appearanceEvents = [];
const apply = snapshot => {
  window.appearance = snapshot;
  window.appearanceEvents.push(snapshot);
  if (snapshot) {
    document.documentElement.dataset.theme = snapshot.resolvedTheme;
    Object.entries(snapshot.tokens).forEach(([key,value]) => document.documentElement.style.setProperty(key,value));
  }
  document.documentElement.style.background = document.body.style.background = snapshot?.background.mode === 'host' ? 'transparent' : 'var(--bg-base, #edf0f3)';
};
window.startAppearance = async () => {
  window.stopAppearance = window.__AGENT_WEBCLIENT_APPEARANCE__.subscribe(apply);
  apply(await window.__AGENT_WEBCLIENT_APPEARANCE__.getSnapshot());
};
</script></body></html>`;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/guest') { response.setHeader('Content-Type', 'text/html'); response.end(guestHtml); return; }
  const filename = path.resolve(output, pathname === '/' ? 'host.html' : pathname.slice(1));
  if (!filename.startsWith(output + path.sep) || !fs.existsSync(filename)) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', types[path.extname(filename)] || 'application/octet-stream');
  response.end(fs.readFileSync(filename));
});
let win;
const js = code => win.webContents.executeJavaScript(code);
const guest = code => js('document.querySelector("webview").executeJavaScript(' + JSON.stringify(code) + ')');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async check => { for (let n = 0; n < 200; n++) { try { if (await check()) return; } catch {} await delay(20); } throw new Error('Timed out waiting for appearance'); };
const pixel = async () => {
  await delay(100);
  const bitmap = (await win.webContents.capturePage({ x: 1000, y: 400, width: 1, height: 1 })).toBitmap();
  return [bitmap[2], bitmap[1], bitmap[0]];
};

(async () => {
  await app.whenReady();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  win = new BrowserWindow({ show: false, width: 1280, height: 900, useContentSize: true,
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadURL(base);
  await until(() => guest('!!window.instance && !!window.__AGENT_WEBCLIENT_APPEARANCE__'));
  assert.equal(await js('window.deliveries.filter(item => item.message?.snapshot).length'), 0, 'an old guest does not negotiate merely because preload exists');
  assert.equal(await guest('Object.isFrozen(window.__AGENT_WEBCLIENT_APPEARANCE__)'), true);
  const identity = await guest('window.instance');
  const guestId = await js('document.querySelector("webview").getWebContentsId()');
  const guestUrl = await guest('location.href');
  await js('document.querySelector(".app-content").style.visibility = "hidden"');
  const wallpaper = await pixel();
  await js('document.querySelector(".app-content").style.visibility = ""');
  await guest('startAppearance()');
  await until(() => guest('window.appearance?.background.mode === "host"'));
  const oldEnvelope = await js('window.deliveries.filter(item => item.message?.snapshot).at(-1)');
  for (const platform of ['mac', 'windows']) {
    for (const mode of ['light', 'dark']) {
      nativeTheme.themeSource = mode;
      await js(`configure(${JSON.stringify(platform)}, ${JSON.stringify(mode)})`);
      await until(() => guest(`window.appearance?.resolvedTheme === ${JSON.stringify(mode)}`));
      assert.deepEqual(await pixel(), wallpaper, platform + '/' + mode + ' uses the single host wallpaper');
      assert.equal(await guest('getComputedStyle(document.querySelector("button")).backgroundColor'), mode === 'light' ? 'rgb(33, 120, 84)' : 'rgb(130, 202, 162)');
      assert.match(await guest('window.appearance.tokens["--control-hover-bg"]'), /^rgba\(/);
      assert.equal(await js('window.routeBootstrapTheme'), 'light', 'URL theme does not change during appearance updates');
      assert.equal(await guest('location.href'), guestUrl);
    }
  }
  assert.equal(await guest('window.instance'), identity);
  assert.equal(await guest('document.querySelector("input").value'), 'keep this draft');
  assert.equal(await js('document.querySelector("webview").getWebContentsId()'), guestId);
  fs.writeFileSync(path.join(output, 'main-chat-dark.png'), (await win.webContents.capturePage()).toPNG());
  await js('configure("mac", "dark", false)');
  await until(() => guest('window.appearance?.background.mode === "opaque"'));
  assert.notDeepEqual(await pixel(), wallpaper, 'no wallpaper gives an opaque reading surface');
  await js('disposeHost()');
  await until(() => guest('window.appearance === null'));
  await js('installHost(); configure("mac", "light", true)');
  await until(() => guest('window.appearance?.background.mode === "host"'));
  assert.equal(await guest('window.instance'), identity, 'renderer relay replacement recovers the existing guest');
  await js('document.querySelector("webview").reload()');
  await until(() => guest('window.instance !== ' + JSON.stringify(identity)));
  await guest('startAppearance()');
  await until(() => guest('window.appearance?.resolvedTheme === "light"'));
  await js('document.querySelector("webview").send(' + JSON.stringify(oldEnvelope.channel) + ',' + JSON.stringify({ ...oldEnvelope.message, snapshot: { ...oldEnvelope.message.snapshot, revision: 999999, resolvedTheme: 'dark' } }) + ')');
  await delay(100);
  assert.equal(await guest('window.appearance.resolvedTheme'), 'light', 'previous-document envelope cannot corrupt the new preload');
  if (process.env.WEBCLIENT_APPEARANCE_DEMO_URL) {
    const demo = new URL(process.env.WEBCLIENT_APPEARANCE_DEMO_URL);
    assert.ok(['127.0.0.1', 'localhost'].includes(demo.hostname), 'live QA is restricted to a local isolated demo');
    await js('document.querySelector(".desktop-background-image").src = "/lake.png"');
    await js('window.useRealSkin = true; configure("mac", "light", true); navigateDemo(' + JSON.stringify(demo.href) + ')');
    await until(() => guest('!!window.__appearanceQA?.state && document.documentElement.dataset.pageBackground === "host"'));
    const demoIdentity = await guest('window.__appearanceQA.state.identity');
    const demoId = await js('document.querySelector("webview").getWebContentsId()');
    await guest(`Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(document.querySelector('textarea'), 'Desktop 联调草稿必须保留');
      document.querySelector('textarea').dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[role="switch"]').click();
      [...document.querySelectorAll('button')].find(button => button.textContent.replaceAll(' ', '').trim() === '批准').click();
      document.querySelector('[data-testid="messages"]').scrollTop = 180;`);
    await until(() => guest('window.__appearanceQA.state.draft === "Desktop 联调草稿必须保留" && window.__appearanceQA.state.chunks > 0 && window.__appearanceQA.state.approved'));
    const scroll = await guest('document.querySelector("[data-testid=messages]").scrollTop');
    for (const platform of ['mac', 'windows']) {
      for (const mode of ['light', 'dark']) {
        await js(`configure(${JSON.stringify(platform)}, ${JSON.stringify(mode)}, true)`);
        await until(() => guest(`document.documentElement.dataset.theme === ${JSON.stringify(mode)}`));
        assert.equal(await guest('getComputedStyle(document.body).backgroundColor'), 'rgba(0, 0, 0, 0)');
        assert.equal(await guest('getComputedStyle(document.documentElement).backgroundColor'), 'rgba(0, 0, 0, 0)');
        const state = await guest('window.__appearanceQA.state');
        assert.equal(state.identity, demoIdentity);
        assert.equal(state.draft, 'Desktop 联调草稿必须保留');
        assert.equal(state.approved, true);
        assert.ok(state.chunks > 0);
        assert.equal(await guest('document.querySelector("[data-testid=messages]").scrollTop'), scroll);
        assert.equal(await guest('document.querySelector("[data-testid=attachment]").textContent'), 'reference.png · 演示附件');
        assert.equal(await js('document.querySelector("webview").getWebContentsId()'), demoId);
        await delay(150);
        fs.writeFileSync(path.join(output, 'webclient-' + platform + '-' + mode + '.png'), (await win.webContents.capturePage()).toPNG());
      }
    }
    await guest(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '审批弹窗').click()`);
    await until(() => guest('!!document.querySelector(".ant-modal-body input")'));
    await guest(`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(document.querySelector('.ant-modal-body input'), '浮层输入保持'); document.querySelector('.ant-modal-body input').dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.ant-modal-body input').focus()`);
    await js('configure("mac", "light", true)');
    await until(() => guest('document.documentElement.dataset.theme === "light"'));
    assert.equal(await guest('document.querySelector(".ant-modal-body input").value'), '浮层输入保持');
    assert.equal(await guest('document.activeElement === document.querySelector(".ant-modal-body input")'), true);
    fs.writeFileSync(path.join(output, 'webclient-modal-light.png'), (await win.webContents.capturePage()).toPNG());
    await js('disposeHost()');
    await until(() => guest('document.documentElement.dataset.pageBackground === "host-fallback"'));
    assert.notEqual(await guest('getComputedStyle(document.documentElement).backgroundColor'), 'rgba(0, 0, 0, 0)');
    await js('installHost()');
    await until(() => guest('document.documentElement.dataset.pageBackground === "host"'));
    for (const surface of ['copilot', 'panel']) {
      demo.searchParams.set('surface', surface);
      await js('configure("mac", "dark", true, false); navigateDemo(' + JSON.stringify(demo.href) + ')');
      await until(() => guest('location.href === ' + JSON.stringify(demo.href) + ' && !!window.__appearanceQA?.state && document.documentElement.dataset.theme === "dark" && document.documentElement.dataset.pageBackground === "host-fallback"'));
      assert.notEqual(await guest('getComputedStyle(document.documentElement).backgroundColor'), 'rgba(0, 0, 0, 0)');
      fs.writeFileSync(path.join(output, 'webclient-' + surface + '-dark.png'), (await win.webContents.capturePage()).toPNG());
    }
    console.log('PASS: actual WebClient AppearanceProvider, Composer, message/approval/Ant surfaces, dark/light, live stream, scroll/draft/attachment/approval/focus preservation and Copilot/WorkPanel opaque fallback');
  }
  console.log('PASS: real contextBridge/preload, consume-only negotiation, macOS/Windows CSS, host wallpaper pixels, live tokens, no URL/reload/guest change, fallback and document isolation');
})().catch(async error => {
  console.error(error); process.exitCode = 1;
  if (win && !win.isDestroyed()) fs.writeFileSync(path.join(output, 'failed.png'), (await win.webContents.capturePage()).toPNG());
}).finally(() => {
  if (win && !win.isDestroyed()) win.destroy();
  server.close();
  app.exit(process.exitCode || 0);
});
