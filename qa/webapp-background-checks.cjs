const { app, BrowserWindow, nativeTheme } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const output = process.env.WEBAPP_QA_DIR;
app.setPath('userData', path.join(output, 'profile'));
app.setPath('sessionData', path.join(output, 'session'));
const guestHtml = '<!doctype html><html><meta charset="utf-8"><body style="margin:0"><input aria-label="draft" value="keep this draft"><script>window.instance=crypto.randomUUID()</script></body></html>';
const contentTypes = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/guest') { response.setHeader('Content-Type', 'text/html'); response.end(guestHtml); return; }
  if (pathname === '/api/weather') { response.writeHead(503, { 'Content-Type': 'application/json' }); response.end('{}'); return; }
  const workbench = pathname.startsWith('/workbench/');
  const root = workbench ? process.env.WEBAPP_PREVIEW_ROOT : output;
  const relative = workbench ? pathname.slice('/workbench/'.length) || 'index.html' : pathname === '/' ? 'host.html' : pathname.slice(1);
  const filename = root && path.resolve(root, relative);
  if (!filename || !filename.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(filename)) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', contentTypes[path.extname(filename)] || 'application/octet-stream');
  response.end(fs.readFileSync(filename));
});
let win;
const js = (code) => win.webContents.executeJavaScript(code);
const guest = (code) => js('document.querySelector("webview").executeJavaScript(' + JSON.stringify(code) + ')');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check) => { for (let n = 0; n < 150; n++) { try { if (await check()) return; } catch {} await delay(20); } throw new Error('Timed out waiting for WebView'); };
const style = (selector, prop = 'backgroundColor') => js('getComputedStyle(document.querySelector(' + JSON.stringify(selector) + '))[' + JSON.stringify(prop) + ']');
const pixel = async () => {
  // Wait for a new compositor frame; styles and guest paint cross process boundaries.
  await delay(100);
  const bitmap = (await win.webContents.capturePage({ x: 1000, y: 400, width: 1, height: 1 })).toBitmap();
  return [bitmap[2], bitmap[1], bitmap[0]];
};
const save = async (name) => fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());

(async () => {
  await app.whenReady();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  win = new BrowserWindow({ show: false, width: 1280, height: 900, useContentSize: true, webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadURL(base);
  await until(() => guest('!!window.instance'));
  const identity = await guest('window.instance');
  const guestId = await js('document.querySelector("webview").getWebContentsId()');
  await js('document.querySelector(".app-content").style.visibility = "hidden"');
  const wallpaperPixel = await pixel();
  await js('document.querySelector(".app-content").style.visibility = ""');
  let solidPixel;
  for (const platform of ['mac', 'windows']) {
    for (const mode of ['light', 'dark']) {
      nativeTheme.themeSource = mode;
      for (const presentation of ['main', 'workpanel', 'fullscreen']) {
        await js(`configure(${JSON.stringify(platform)}, ${JSON.stringify(mode)}, ${JSON.stringify(presentation)})`);
        assert.equal(await style('.app-content'), 'rgba(0, 0, 0, 0)');
        assert.equal(await style('.app-content', 'backdropFilter'), 'none');
        assert.equal(await style(presentation === 'main' ? '.app-main' : '.chat-work-panel'), 'rgba(0, 0, 0, 0)');
        assert.equal(await style('.desktop-background', 'visibility'), 'visible');
        await guest('document.body.style.background = ""');
        assert.deepEqual(await pixel(), wallpaperPixel, `${platform}/${mode}/${presentation}: transparent guest reveals the same wallpaper pixel`);
        await guest('document.body.style.background = "#916131"');
        assert.equal(await guest('getComputedStyle(document.body).backgroundColor'), 'rgb(145, 97, 49)');
        solidPixel ??= await pixel();
        assert.notDeepEqual(solidPixel, wallpaperPixel);
        assert.deepEqual(await pixel(), solidPixel, 'Guest solid background wins');
        await guest('document.body.style.background = "url(/wallpaper.svg) center / cover"');
        assert.notEqual(await guest('getComputedStyle(document.body).backgroundImage'), 'none', 'Guest image stays intact');
        await guest('document.body.style.background = ""');
      }
    }
  }
  assert.equal(await guest('window.instance'), identity);
  assert.equal(await guest('document.querySelector("input").value'), 'keep this draft');
  assert.equal(await js('document.querySelector("webview").getWebContentsId()'), guestId);
  await js('configure("mac", "dark", "main", "website")');
  assert.notEqual(await style('.app-content'), 'rgba(0, 0, 0, 0)', 'Website host keeps its original surface');
  await js('configure("mac", "dark", "main"); delete document.documentElement.dataset.desktopBackground');
  assert.notEqual(await style('.app-content'), 'rgba(0, 0, 0, 0)', 'No wallpaper restores original host surface');
  await js('document.documentElement.dataset.desktopBackground = "image"; configure("mac", "dark", "main")');
  await save('transparent-webapp');
  if (process.env.WEBAPP_PREVIEW_ROOT) {
    fs.copyFileSync(path.join(process.env.WEBAPP_QA_REPO, 'qa/assets/alpine-lake.png'), path.join(output, 'lake.png'));
    await js('document.querySelector(".desktop-background-image").src = "/lake.png"');
    await js('document.querySelector("webview").src = ' + JSON.stringify(base + '/workbench/'));
    await until(() => guest('!!document.querySelector(".dashboard")'));
    assert.equal(await guest('document.documentElement.dataset.workbenchSurface'), 'desktop');
    assert.equal(await guest('getComputedStyle(document.body).backgroundColor'), 'rgba(0, 0, 0, 0)');
    for (const mode of ['light', 'dark']) {
      nativeTheme.themeSource = mode;
      await js(`configure("mac", ${JSON.stringify(mode)}, "main")`);
      await until(() => guest(`document.documentElement.classList.contains('dark') === ${mode === 'dark'}`));
      assert.match(await guest('getComputedStyle(document.querySelector(".panel")).backgroundColor'), /^rgba\(/);
      await until(() => guest('getComputedStyle(document.querySelector(".quick-action")).backgroundColor === getComputedStyle(document.querySelector(".panel")).backgroundColor'));
      await save('workbench-' + mode);
    }
    await guest('Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === "添加").click()');
    await until(() => guest('!!document.querySelector(".workbench-dialog")'));
    assert.equal(await guest('getComputedStyle(document.querySelector(".workbench-dialog")).backgroundColor'), 'rgb(33, 58, 44)');
    await save('workbench-dialog');
    const standalone = new BrowserWindow({ show: false, width: 1280, height: 900 });
    const browserAgent = standalone.webContents.getUserAgent().replace(/\sElectron\/[^\s]+/g, '');
    await standalone.loadURL(base + '/workbench/', { userAgent: browserAgent });
    await until(() => standalone.webContents.executeJavaScript('!!document.querySelector(".dashboard")'));
    assert.equal(await standalone.webContents.executeJavaScript('document.documentElement.hasAttribute("data-workbench-surface")'), false);
    assert.equal(await standalone.webContents.executeJavaScript('getComputedStyle(document.body).backgroundColor'), 'rgb(245, 247, 248)');
    standalone.destroy();
  }
  console.log('PASS: macOS/Windows CSS, light/dark, workspace/WorkPanel/fullscreen, guest-owned backgrounds, guest identity, default and Website fallback' + (process.env.WEBAPP_PREVIEW_ROOT ? ', workbench light/dark/dialog/browser' : ''));
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (win && !win.isDestroyed()) win.destroy();
  server.close();
  app.exit(process.exitCode || 0);
});
