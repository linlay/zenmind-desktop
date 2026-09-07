// Isolated runtime smoke test: electron test/fixtures/site-cdp-electron.cjs
const { app, BrowserWindow, webContents, ipcMain, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { buildSync } = require('esbuild');
const { createBrowserSurfaceRegistry } = require('../../dist-electron/main/modules/web-surfaces/browser-surface-registry.js');
const { captureCopilotSiteCdpScope } = require('../../dist-electron/main/modules/web-surfaces/cdp/site-scope.js');
const { createCdpIntegration } = require('../../dist-electron/main/modules/web-surfaces/cdp/integration.js');
const { EmbeddedCdpGateway } = require('../../dist-electron/main/modules/web-surfaces/cdp/gateway.js');
const { configureAttachedWebview } = require('../../dist-electron/main/modules/shell/window-manager.part-2.js');
const { resolveWebviewOpenDisposition, shouldDownloadUrlFromWebview, resolveRegisteredWebviewPopupTarget } = require('../../dist-electron/main/modules/web-surfaces/open-tab.js');
const root = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zenmind-site-cdp-electron-'));
app.setPath('userData', path.join(temp, 'profile'));
const watchdog = setTimeout(() => { console.error('SMOKE TIMEOUT'); app.exit(1); }, 60000);
let win;
let server;
let finishing = false;
let selected = 'website:a';
const scopes = [];
const registrations = new Map();
const pending = new Map();
const waitFor = async (read, label) => {
  const end = Date.now() + 12000;
  while (Date.now() < end) { const value = read(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 30)); }
  throw new Error('Timed out: ' + label);
};
async function main() {
  const { loadBrandConfig, resolveBrandId, runtimeBrandPayload } = await import('../../scripts/lib/brand-model.mjs');
  const brand = runtimeBrandPayload(loadBrandConfig(root, resolveBrandId([], process.env)));
  buildSync({ entryPoints: [path.join(__dirname, 'site-cdp-electron-renderer.tsx')], outfile: path.join(temp, 'renderer.js'),
    bundle: true, platform: 'browser', format: 'cjs', external: ['electron'], jsx: 'automatic',
    define: { __DESKTOP_APP_BRAND__: JSON.stringify(brand), 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false' }, loader: { '.svg': 'dataurl', '.png': 'dataurl' } });
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<body style="background:#e5f7e9;font:24px sans-serif"><h1>${req.url}</h1><input id="entry"><button id="popup" onclick="window.open('/popup-${Date.now()}')">Open tab</button><div id="result">Ready</div><script>window.ticks=0;setInterval(()=>window.ticks++,100);</script></body>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const entries = ['a', 'b', 'app'].map((id) => ({ id, kind: id === 'app' ? 'webapp' : 'website', entryKey: `${id === 'app' ? 'webapp' : 'website'}:${id}`, label: id, url: origin + '/' + id }));
  const registry = createBrowserSurfaceRegistry({ webContents, listWebEntries: () => ({ items: entries }), getCurrentPageSnapshot: () => {
    const registration = [...registrations.values()].find((value) => value.surfaceIdentityKey === selected);
    const tab = registration?.tabs.find((value) => value.tabId === registration.activeTabId);
    return registration && tab ? { pageKind: 'webview', surfaceId: registration.surfaceId, webContentsId: tab.webContentsId, route: registration.pageRoute } : null;
  } });
  ipcMain.handle('smoke.register', (event, input) => {
    registrations.set(input.surfaceId, input);
    const result = registry.registerSurfaceResult(input, event.sender.id);
    if (!result.ok) console.error('REGISTER FAILED', input.surfaceKind, result);
    return result;
  });
  ipcMain.handle('smoke.unregister', (event, input) => { registrations.delete(input.surfaceId); return { ok: registry.unregisterSurface(input, event.sender.id) }; });
  ipcMain.handle('smoke.response', (_event, input) => { pending.get(input.requestId)?.(input); pending.delete(input.requestId); return { ok: true }; });
  const control = (action, surfaceId, tabId, ownerChatId, siteTarget, phase) => new Promise((resolve, reject) => {
    assert.equal(ownerChatId, undefined); assert.ok(siteTarget);
    const requestId = `smoke-${Math.random()}`;
    pending.set(requestId, (result) => result.ok ? resolve(result) : reject(new Error(JSON.stringify(result))));
    win.webContents.send('desktopActions.call', { requestId, action, args: { surfaceId, tabId, phase }, siteCdpTarget: { surfaceId, tabId, ...siteTarget } });
  });
  const integration = createCdpIntegration({ browserSurfaces: registry, getCurrentPageSnapshot: () => null, listServices: () => [], isLoopbackUrl: () => true, version: 'smoke',
    switchTab: (...args) => control('desktop.web.switchTab', ...args), closeTab: (...args) => control('desktop.web.closeTab', ...args),
    controlSiteFocus: async (surfaceId, tabId, siteTarget, phase) => {
      const response = await control('desktop.web.pageControlFocus', surfaceId, tabId, undefined, siteTarget, phase);
      if (phase !== 'capture' && response.result?.webContentsId) {
        const foreground = webContents.fromId(response.result.webContentsId);
        foreground?.focus();
      }
    } });
  const gateway = new EmbeddedCdpGateway({ getSurfaces: () => registry.listRegisteredSurfaces(), resolveWebContents: (_surface, tab) => webContents.fromId(tab.webContentsId),
    activateTarget: integration.activateTarget, closeTarget: integration.closeTarget, controlSiteFocus: integration.controlSiteFocus, logger: { debug() {}, warn: console.warn } });
  win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { nodeIntegration: true, contextIsolation: false, webviewTag: true } });
  win.on('closed', () => { if (!finishing) { console.error('Smoke window closed before completion'); app.exit(1); } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error('RENDERER', message); });
  win.webContents.on('did-attach-webview', (_event, guest) => configureAttachedWebview(guest, {
    platform: process.platform, getMainWindow: () => win, isDevToolsShortcut: () => false,
    shouldDownloadUrl: shouldDownloadUrlFromWebview, resolveOpenDisposition: resolveWebviewOpenDisposition,
    shouldOpenPopupInWorkPanelTab: (guest) => resolveRegisteredWebviewPopupTarget(registry.resolveWebviewSurfaceTarget(guest.id)) === 'work-panel',
    resolveBlobPopupTarget: (guest) => resolveRegisteredWebviewPopupTarget(registry.resolveWebviewSurfaceTarget(guest.id)),
    collectLoadDiagnostics: async () => ({}), report: console.error, openExternal: async () => { throw new Error('Unexpected external popup'); }, schedule: queueMicrotask,
  }));
  const css = fs.readFileSync(path.join(root, 'src/renderer/styles/external-webview.css'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'src/renderer/styles/app-shell.css'), 'utf8');
  fs.writeFileSync(path.join(temp, 'index.html'), `<html><head><style>${css}\nhtml,body,#root{height:100%;width:100%;margin:0}.embedded-surface-page{height:100%}</style></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`);
  await win.loadFile(path.join(temp, 'index.html'), { query: { origin } });
  // Both supported desktop platforms use real Chromium guests; macOS does not need app activation.
  if (process.platform === 'darwin') win.showInactive();
  else if (process.platform === 'win32') win.showInactive();
  const surface = (entry) => registry.listRegisteredSurfaces().find((value) => value.entryKey === entry);
  await waitFor(() => surface('website:a')?.tabs?.length && surface('website:b')?.tabs?.length, 'initial Websites');
  const select = async (key) => { selected = key; await win.webContents.executeJavaScript(`window.smoke.select(${JSON.stringify(key)})`); await waitFor(() => surface(key)?.active, 'select ' + key); };
  const capture = (key) => {
    const value = surface(key);
    const scope = captureCopilotSiteCdpScope(registry, { surfaceRole: 'copilot-dock', active: true, parentSurfaceId: value.surfaceId, surfaceIdentityKey: key, ownerWebContentsId: win.webContents.id });
    scope.activate(); scopes.push(scope); return scope;
  };
  const aScope = capture('website:a');
  const aTarget = (await gateway.executeCommand({ method: 'Target.getCurrentTarget' }, aScope)).targetId;
  await waitFor(() => aScope.readSurface().tabs.every((tab) => !tab.isLoading), 'initial A load');
  await select('website:b');
  await new Promise((resolve) => setTimeout(resolve, 500));
  await win.webContents.executeJavaScript("document.querySelector('.external-webview-page:not(.is-inactive-surface) webview').shadowRoot.querySelector('iframe').focus()");
  const foregroundGuest = webContents.fromId(surface('website:b').tabs[0].webContentsId);
  await foregroundGuest.executeJavaScript("document.querySelector('#entry').focus();document.querySelector('#entry').value='user foreground'");
  foregroundGuest.focus();
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  await win.webContents.debugger.sendCommand('Input.insertText', { text: '?' });
  assert.equal(await foregroundGuest.executeJavaScript("document.querySelector('#entry').value"), 'user foreground?');
  const windowFocused = win.isFocused();
  const focusedHostElement = await win.webContents.executeJavaScript("document.activeElement.getAttribute('src')");
  await gateway.executeCommand({ method: 'Runtime.evaluate', targetId: aTarget, params: { expression: "document.querySelector('#entry').focus()" } }, aScope);
  const inputBox = await gateway.executeCommand({ method: 'Runtime.evaluate', targetId: aTarget, params: {expression:"(()=>{const r=document.querySelector('#entry').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",returnByValue:true} }, aScope);
  for (const type of ['mousePressed','mouseReleased']) await gateway.executeCommand({method:'Input.dispatchMouseEvent',targetId:aTarget,params:{type,...inputBox.result.result.value,button:'left',clickCount:1}},aScope);
  await gateway.executeCommand({ method: 'Input.insertText', targetId: aTarget, params: { text: 'background input passed' } }, aScope);
  const input = await gateway.executeCommand({ method: 'Runtime.evaluate', targetId: aTarget, params: { expression: "document.querySelector('#entry').value", returnByValue: true } }, aScope);
  assert.equal(input.result.result.value, 'background input passed');
  assert.equal(win.isFocused(), windowFocused);
  assert.equal(await win.webContents.executeJavaScript("document.activeElement.getAttribute('src')"), focusedHostElement);
  assert.equal(await foregroundGuest.executeJavaScript("document.querySelector('#entry').value"), 'user foreground?');
  let targetId = aTarget;
  for (let count = 2; count <= 3; count++) {
    const box = await gateway.executeCommand({ method: 'Runtime.evaluate', targetId, params: { expression: "(()=>{const r=document.querySelector('#popup').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()", returnByValue: true } }, aScope);
    const point = box.result.result.value;
    for (const type of ['mousePressed', 'mouseReleased']) await gateway.executeCommand({ method: 'Input.dispatchMouseEvent', targetId, params: { type, ...point, button: 'left', clickCount: 1 } }, aScope);
    await waitFor(() => aScope.readSurface().tabs.length === count, 'background popup ' + count);
    const result = await gateway.executeCommand({ method: 'Target.getCurrentTarget' }, aScope); targetId = result.targetId;
    await waitFor(() => !aScope.readSurface().tabs.find((tab) => tab.tabId === aScope.readSurface().activeTabId)?.isLoading, 'popup load');
    assert.equal(surface('website:b').tabs.length, 1);
    assert.equal(await win.webContents.executeJavaScript("document.activeElement.getAttribute('src')"), focusedHostElement);
    assert.equal(win.isFocused(), windowFocused);
    assert.equal((await gateway.executeCommand({ method: 'Target.getCurrentTarget' })).surfaceId, surface('website:b').surfaceId);
  }
  // Native input follows the host's actual focused frame, unlike guest isFocused() on macOS.
  await win.webContents.debugger.sendCommand('Input.insertText', { text: '!' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await foregroundGuest.executeJavaScript("document.querySelector('#entry').value"), 'user foreground?!');
  win.webContents.debugger.detach();
  const screenshot = await gateway.executeCommand({ method: 'Page.captureScreenshot', targetId: aTarget, params: { format: 'png' } }, aScope);
  const png = nativeImage.createFromBuffer(Buffer.from(screenshot.result.data, 'base64'));
  assert.ok(png.getSize().width > 300 && png.getSize().height > 200);
  fs.writeFileSync(path.join(temp, 'background.png'), png.toPNG());
  const aGuest = webContents.fromId(aScope.readSurface().tabs[0].webContentsId);
  const reloaded = new Promise((resolve) => aGuest.once('did-finish-load', resolve));
  await gateway.executeCommand({ method: 'Page.reload', targetId: aTarget }, aScope);
  await reloaded;
  assert.equal((await gateway.executeCommand({ method: 'Target.getCurrentTarget' })).surfaceId, surface('website:b').surfaceId);
  win.webContents.send('webview.openTab', { target: 'desktop-browser', navigationKind: 'network', sourceGuestId: 999999, url: origin + '/unknown-popup' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(surface('website:b').tabs.length, 1); assert.equal(aScope.readSurface().tabs.length, 3);
  await gateway.executeCommand({ method: 'Page.bringToFront', targetId: aTarget }, aScope);
  assert.equal((await gateway.executeCommand({ method: 'Target.getCurrentTarget' }, aScope)).targetId, aTarget);
  await gateway.executeCommand({ method: 'Target.closeTarget', targetId }, aScope);
  assert.equal(aScope.readSurface().tabs.length, 2);
  await select('webapp:app');
  const appScope = capture('webapp:app'); const appTarget = (await gateway.executeCommand({ method: 'Target.getCurrentTarget' }, appScope)).targetId;
  await win.webContents.executeJavaScript(`window.smoke.present({scope:'workpanel',ownerChatId:'chat-fixture',itemId:'app-item'})`);
  await select('website:b');
  await waitFor(() => registrations.get(appScope.surfaceId)?.presentationScope === 'workpanel', 'WorkPanel presentation');
  assert.equal((await gateway.executeCommand({ method: 'Target.getCurrentTarget' }, appScope)).targetId, appTarget);
  const appShot = await gateway.executeCommand({ method: 'Page.captureScreenshot', targetId: appTarget, params: { format: 'png' } }, appScope);
  assert.ok(nativeImage.createFromBuffer(Buffer.from(appShot.result.data, 'base64')).getSize().width > 300);
  await gateway.executeCommand({ method: 'Runtime.evaluate', targetId: appTarget, params: { expression: "document.querySelector('#entry').focus()" } }, appScope);
  await gateway.executeCommand({ method: 'Input.insertText', targetId: appTarget, params: { text: 'background WebApp passed' } }, appScope);
  const appInput = await gateway.executeCommand({ method: 'Runtime.evaluate', targetId: appTarget, params: { expression: "document.querySelector('#entry').value" } }, appScope);
  assert.equal(appInput.result.result.value, 'background WebApp passed');
  await gateway.executeCommand({ method: 'Runtime.evaluate', targetId: appTarget, params: { expression: "window.open('/webapp-popup')" } }, appScope);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(appScope.readSurface().tabs.length, 1); assert.equal(surface('website:b').tabs.length, 1);
  await win.webContents.executeJavaScript(`window.smoke.present({scope:'main-workspace'})`);
  await waitFor(() => registrations.get(appScope.surfaceId)?.presentationScope !== 'workpanel', 'return to main workspace');
  assert.equal((await gateway.executeCommand({ method: 'Target.getCurrentTarget' }, appScope)).targetId, appTarget);
  await gateway.executeCommand({ method: 'Target.closeTarget', targetId: appTarget }, appScope);
  assert.throws(() => appScope.readSurface(), { code: 'site_control_unavailable' });
  assert.equal((await gateway.executeCommand({ method: 'Target.getCurrentTarget' })).surfaceId, surface('website:b').surfaceId);
  console.log('SITE_CDP_SMOKE_PASSED', JSON.stringify({ platform: process.platform, screenshot: path.join(temp, 'background.png'), cases: ['background input', 'coordinate popup', 'descendant popup', 'foreground keyboard isolation', 'background screenshot/reload', 'unknown opener rejection', 'switch/close tab', 'WebApp round-trip transfer/input', 'WebApp single-page popup', 'last-tab disposal'] }));
}
app.whenReady().then(main).then(() => {
  finishing = true; scopes.forEach((scope) => scope.release()); win?.destroy(); server?.close(); clearTimeout(watchdog); app.exit(0);
}).catch((error) => { finishing = true; console.error(error); scopes.forEach((scope) => scope.release()); win?.destroy(); server?.close(); clearTimeout(watchdog); app.exit(1); });
