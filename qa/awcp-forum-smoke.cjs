// Read-only live smoke: pass qiuer_1024_oauth2's value on stdin, never in source or argv.
const { app, BrowserWindow, webContents, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createBrowserSurfaceRegistry } = require('../dist-electron/main/modules/web-surfaces/browser-surface-registry.js');
const { createWebEntrySurfaceIdentity } = require('../dist-electron/shared/surface-identity.js');
const { captureCopilotSiteControlScope } = require('../dist-electron/main/modules/web-surfaces/cdp/site-scope.js');
const { AwcpGuestBridge } = require('../dist-electron/main/modules/web-surfaces/awcp/guest-bridge.js');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zenmind-awcp-smoke-'));
app.setPath('userData', directory);
app.on('window-all-closed', () => {});
let win, scope, bridge;
const watchdog = setTimeout(() => finish(1, 'Live AWCP smoke timed out.'), 60000);
let finished = false;
async function finish(code, message) {
  if (finished) return; finished = true; clearTimeout(watchdog);
  console.log(message);
  bridge?.dispose(); scope?.release(); win?.destroy();
  await session.defaultSession.clearStorageData();
  fs.rmSync(directory, { recursive: true, force: true });
  app.exit(code);
}
app.whenReady().then(async () => {
  let cookie = '';
  for await (const chunk of process.stdin) cookie += chunk.toString();
  cookie = cookie.trim().replace(/\\_/g, '_');
  if (!cookie || /[\s;]/.test(cookie)) throw new Error('Provide only the login Cookie value on stdin.');
  const url = 'https://1024.qiuer.net/forum';
  await session.defaultSession.cookies.set({ url, name: 'qiuer_1024_oauth2', value: cookie, path: '/', secure: true, httpOnly: true });
  cookie = '';
  win = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false } });
  const guestReady = new Promise(resolve => win.webContents.once('did-attach-webview', (_event, guest) => guest.once('dom-ready', () => resolve(guest))));
  await win.loadURL('data:text/html,' + encodeURIComponent(`<webview src="${url}" style="width:980px;height:760px"></webview>`));
  const guest = await guestReady;
  // Allow the application's initial router/auth redirect to settle before binding a Run.
  await new Promise(resolve => setTimeout(resolve, 1500));
  console.log('Guest path:', new URL(guest.getURL()).pathname);
  const entryKey = 'website:forum-smoke';
  const identity = createWebEntrySurfaceIdentity('website', entryKey);
  const registry = createBrowserSurfaceRegistry({ webContents, listWebEntries: () => ({ items: [{ id: 'forum-smoke', entryKey, kind: 'website', label: 'Forum', url }] }),
    getCurrentPageSnapshot: () => ({ pageKind: 'webview', surfaceId: identity.surfaceId, webContentsId: guest.id, route: `/webs/${entryKey}` }) });
  const registration = { ...identity, registrationId: 'forum-smoke', surfaceIdentityKey: entryKey, surfaceKind: 'website', pageRoute: `/webs/${entryKey}`,
    label: 'Forum', url, active: true, tabs: [{ tabId: 'forum', webContentsId: guest.id, currentUrl: guest.getURL(), title: 'Forum', canGoBack: false, canGoForward: false, isLoading: false }], activeTabId: 'forum' };
  assert.equal(registry.registerSurfaceResult(registration, win.webContents.id).ok, true);
  scope = captureCopilotSiteControlScope(registry, { surfaceRole: 'copilot-dock', active: true, parentSurfaceId: identity.surfaceId, surfaceIdentityKey: entryKey, ownerWebContentsId: win.webContents.id });
  scope.activate(); bridge = new AwcpGuestBridge(registry);
  let sequence = 0;
  async function read(action, args = {}) {
    const index = await bridge.manual(`index-${++sequence}`, {}, scope);
    await bridge.manual(`section-${sequence}`, { section: action, revision: index.revision }, scope);
    const result = await bridge.invoke(`read-${sequence}`, { action, revision: index.revision, args }, scope);
    assert.equal(result.ok, true, `${action}: ${result.error?.code}`);
    console.log(JSON.stringify({ action, ok: true, count: result.result?.items?.length ?? result.result?.count ?? null }));
    return result.result;
  }
  const posts = await read('forum.posts.list');
  await read('forum.sections.list'); await read('forum.tags.list');
  await read('forum.notifications.unread-count'); await read('forum.notifications.list');
  if (posts.items[0]) {
    await read('forum.posts.get', { postId: posts.items[0].id });
    await read('forum.comments.list', { postId: posts.items[0].id });
  }
  const reload = new Promise(resolve => guest.once('dom-ready', resolve)); guest.reload(); await reload;
  await read('forum.notifications.unread-count');
  await guest.executeJavaScript("history.pushState({}, '', '/not-forum');");
  await assert.rejects(bridge.manual(`outside-${++sequence}`, {}, scope));
  registry.unregisterSurface(registration, win.webContents.id);
  await finish(0, 'Live forum AWCP smoke passed (read-only, isolated Electron WebView).');
}).catch(error => finish(1, error.message));
