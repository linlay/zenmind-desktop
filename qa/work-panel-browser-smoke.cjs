// Isolated real-Electron integration check. No Desktop services or user profile.
const { app, BrowserWindow, webContents, nativeTheme } = require('electron');
const { registerWorkPanelWebDialogIpc } = require('../dist-electron/main/modules/work-panel/web-dialog.js');
const { createBrowserSurfaceRegistry } = require('../dist-electron/main/modules/web-surfaces/browser-surface-registry.js');
const { createSurfaceIdentity, createChatChildSurfaceIdentity } = require('../dist-electron/shared/surface-identity.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'work-panel-browser-'));
app.setPath('userData', path.join(output, 'profile'));
app.setPath('sessionData', path.join(output, 'session'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 200; i++) { if (await check()) return; await delay(30); } throw new Error('Timed out'); }
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>${req.url === '/one' ? 'Research workspace' : 'Reference material'}</title><style>body{font:18px system-ui;padding:60px;background:#f3f6fa;color:#1b2b43}a{color:#356bcc}input{padding:10px}</style><h1>${req.url === '/one' ? 'Research workspace' : 'Reference material'}</h1><p>Each page belongs to the same agent and conversation.</p><a id="popup" href="/popup" target="_blank">Open reference in a new tab</a><p><input placeholder="Page draft"></p>`);
});
app.on('window-all-closed', () => {});
(async () => {
  await app.whenReady();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const owner = new BrowserWindow({ show: false, webPreferences: { webviewTag: true, contextIsolation: true, sandbox: true } });
  await owner.loadURL('data:text/html,' + encodeURIComponent(`<webview id="root" src="${base}/agent/research?chatId=chat-qa"></webview><webview id="site" src="${base}/one"></webview>`));
  let source, root;
  await until(async () => { try { const ids = await owner.webContents.executeJavaScript('[...document.querySelectorAll("webview")].map(v=>v.getWebContentsId())'); root = webContents.fromId(ids[0]); source = webContents.fromId(ids[1]); return source?.getURL() === base + '/one'; } catch { return false; } });
  const registry = createBrowserSurfaceRegistry({ webContents, listWebEntries: () => ({ items: [] }), getCurrentPageSnapshot: () => null });
  const tab = (guest, id) => ({ tabId: id, webContentsId: guest.id, currentUrl: guest.getURL(), title: 'Page', canGoBack: false, canGoForward: false, isLoading: false });
  const rootIdentity = createSurfaceIdentity('main-chat', '', { ownerChatId: 'chat-qa' });
  assert.equal(registry.registerSurface({ ...rootIdentity, registrationId: 'root', surfaceKind: 'service', surfaceType: 'agent-chat', serviceId: 'agent-webclient', pageRoute: '/agent/research', pageRouteIdentity: '/agent/research?chatId=chat-qa', label: 'Chat', url: base + '/agent/research?chatId=chat-qa', active: true, tabs: [tab(root, 'root')], activeTabId: 'root' }, owner.webContents.id), true);
  const key = 'web:' + base + '/one';
  const identity = createChatChildSurfaceIdentity('workpanel-web', key, 'chat-qa');
  assert.equal(registry.registerSurface({ ...identity, surfaceIdentityKey: key, registrationId: 'source', surfaceKind: 'chat-work-panel', surfaceType: 'chat-work-panel', label: 'Research workspace', url: base + '/one', active: false, tabs: [tab(source, 'one')], activeTabId: 'one' }, owner.webContents.id), true);
  const sent = [];
  owner.webContents.send = (...args) => sent.push(args);
  let handler;
  registerWorkPanelWebDialogIpc({ handle: (_channel, fn) => { handler = fn; } }, () => owner, registry);
  const call = input => handler({ sender: owner.webContents, senderFrame: owner.webContents.mainFrame }, input);
  const first = await call({ action: 'prepare', sourceGuestId: source.id, agentLabel: 'Research Agent (research)', chatLabel: 'Website comparison' });
  assert.equal(first.ok, true);
  assert.equal((await call({ action: 'open', transferId: first.transferId })).ok, true);
  const dialog = BrowserWindow.getAllWindows().find(win => win !== owner);
  const js = code => dialog.webContents.executeJavaScript(code);
  const checkTitlebar = () => js(`(() => {
    const bar=document.querySelector('.window-titlebar'), title=document.querySelector('.window-title'), restore=bar.querySelector('a');
    const rect=bar.getBoundingClientRect(), button=restore.getBoundingClientRect();
    return { top:rect.top, height:rect.height, navTop:document.querySelector('nav').getBoundingClientRect().top,
      titleRight:title.getBoundingClientRect().right, buttonLeft:button.left, buttonRight:button.right, width:innerWidth,
      drag:getComputedStyle(bar).webkitAppRegion, buttonDrag:getComputedStyle(restore).webkitAppRegion };
  })()`);
  const normalBar = await checkTitlebar();
  assert.equal(normalBar.top, 0, 'ownership is in the system titlebar area');
  assert.equal(normalBar.navTop, normalBar.height, 'tabs immediately follow the single titlebar');
  assert.equal(normalBar.drag, 'drag');
  assert.equal(normalBar.buttonDrag, 'no-drag');
  dialog.setSize(480, 400);
  await delay(100);
  const narrowBar = await checkTitlebar();
  assert.ok(narrowBar.titleRight <= narrowBar.buttonLeft && narrowBar.buttonRight <= narrowBar.width, 'restore stays visible at minimum window width');
  dialog.setSize(1180, 780);

  await until(async () => (await js('document.querySelector("webview").getURL()')) === base + '/one');
  const second = await call({ action: 'prepareSibling', transferId: first.transferId, itemId: 'two', stableKey: 'web:' + base + '/two', url: base + '/two', title: 'Reference material' });
  assert.equal(second.ok, true);
  assert.equal((await call({ action: 'open', transferId: second.transferId })).ok, true);
  assert.equal(BrowserWindow.getAllWindows().length, 2, 'one dialog per conversation');
  assert.equal(await js('document.querySelectorAll(".tab").length'), 2);
  await until(async () => await js('document.querySelectorAll("webview")[1].getURL()') === base + '/two');
  // Browser tab selection preserves guest and in-page drafts.
  const firstGuest = webContents.fromId(await js('document.querySelector("webview").getWebContentsId()'));
  await firstGuest.executeJavaScript('document.querySelector("input").value="retained draft"');
  await js('document.querySelector(".title").click()');
  await until(async () => await js('document.querySelector(".tab").getAttribute("aria-selected")') === 'true');
  assert.equal(await firstGuest.executeJavaScript('document.querySelector("input").value'), 'retained draft');
  // Real target=_blank must reach the original Chat, even after its root is removed.
  registry.unregisterSurface({ surfaceId: rootIdentity.surfaceId, registrationId: 'root' }, owner.webContents.id);
  await firstGuest.executeJavaScript('document.querySelector("#popup").click()', true);
  await until(() => sent.some(([name]) => name === 'chatWorkPanel.webDialogOpenRequested'));
  const popup = sent.find(([name]) => name === 'chatWorkPanel.webDialogOpenRequested')[1];
  assert.equal(popup.transferId, first.transferId);
  assert.equal(popup.url, base + '/popup');
  const third = await call({ action: 'prepareSibling', transferId: popup.transferId, itemId: 'three', stableKey: 'web:' + popup.url, url: popup.url, title: 'Popup reference' });
  assert.equal(third.ok, true);
  assert.equal((await call({ action: 'open', transferId: third.transferId })).ok, true);
  await until(async () => await js('document.querySelectorAll("webview")[2].getURL()') === base + '/popup');
  // Address field navigates the selected page; '+' asks reducer for a new item.
  await js(`document.getElementById('address').value=${JSON.stringify(base + '/latest?q=1#hash')};document.querySelector('form').requestSubmit()`);
  await until(async () => await js('document.querySelectorAll("webview")[2].getURL()') === base + '/latest?q=1#hash');
  await js(`document.getElementById('new').click();document.getElementById('address').value=${JSON.stringify(base + '/manual')};document.querySelector('form').requestSubmit()`);
  await until(() => sent.some(([name, input]) => name === 'chatWorkPanel.webDialogOpenRequested' && input.url === base + '/manual'));
  assert.equal(await firstGuest.executeJavaScript('typeof window.electronAPI'), 'undefined');
  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme;
    await delay(150);
    fs.writeFileSync(path.join(output, theme + '.png'), (await dialog.webContents.capturePage()).toPNG());
  }
  dialog.close();
  assert.equal(dialog.isDestroyed(), false);
  assert.equal(sent.at(-1)[0], 'chatWorkPanel.webDialogRestoreRequested');
  const result = await call({ action: 'restore', transferId: first.transferId });
  assert.equal(result.restoredItems.length, 3);
  assert.equal(result.restoredItems.at(-1).url, base + '/latest?q=1#hash');
  assert.equal(dialog.isDestroyed(), true);
  owner.destroy();
  console.log('WorkPanel browser Electron smoke passed. Screenshots: ' + output);
  server.close(); app.exit(0);
})().catch(error => { console.error(error); server.close(); app.exit(1); });
