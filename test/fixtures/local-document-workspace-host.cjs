const { BrowserWindow, ipcMain, webContents } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { LocalDocumentWorkspaceController } = require("../../src/main/modules/work-panel/local-document-workspace.ts");
const { createLocalDocumentEditingChat } = require("../../src/main/app/assembly/local-documents.ts");
const { prepareWebviewAttachPreferences } = require("../../src/main/modules/shell/webview-attach-policy.ts");
const { LOCAL_DOCUMENT_CHANNELS, localDocumentOwnerKey } = require("../../src/shared/local-document.ts");

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let count = 0; count < 200; count++) {
    if (await check()) return;
    await pause(50);
  }
  throw Error(`Timed out: ${label}`);
}

// Exercise the production controller, protocol, attach policy and real guests
// through a small trusted shell without starting unrelated business services.
async function createWorkspaceHost(root, dependencies = {}) {
  const preload = path.join(root, "workspace-preload.cjs");
  fs.writeFileSync(preload, `
const { contextBridge, ipcRenderer } = require("electron");
const channels = ${JSON.stringify(LOCAL_DOCUMENT_CHANNELS)};
contextBridge.exposeInMainWorld("workspace", {
  getState: () => ipcRenderer.invoke(channels.getState),
  bind: request => ipcRenderer.invoke(channels.bind, request),
  activate: id => ipcRenderer.invoke(channels.activate, id),
  close: id => ipcRenderer.invoke(channels.close, id),
  reveal: id => ipcRenderer.invoke(channels.reveal, id),
  onChanged: listener => ipcRenderer.on(channels.changed, (_event, state) => listener(state)),
  onClose: listener => ipcRenderer.on("app.closeShortcut", (_event, payload) => listener(payload)),
  onBrowserShortcut: listener => ipcRenderer.on("app.workPanelBrowserShortcut", (_event, payload) => listener(payload)),
});
`);
  const hostFile = path.join(root, "workspace.html");
  fs.writeFileSync(hostFile, `<!doctype html><meta charset="utf-8">
<title>Local document workspace QA</title>
<style>
html,body{margin:0;height:100%;font:14px system-ui}#workspace{height:100%;display:flex;flex-direction:column}
#workspace[hidden]{display:none}nav{display:flex;gap:8px;padding:8px;background:#eff2f6}
button[aria-selected=true]{background:#dbeafe}#panels{position:relative;flex:1;min-height:0}
webview{position:absolute;inset:0;width:100%;height:100%;display:flex}webview[hidden]{display:none}
</style><section id="workspace"><nav id="tabs"></nav><div id="panels"></div></section>
<script>
const views = new Map();
let currentState = { revision: -1, openRevision: 0, documents: [], activeDocumentId: null };
async function render(state) {
  if (state.revision < currentState.revision) return;
  currentState = state;
  const ids = new Set(state.documents.map(item => item.documentId));
  for (const [id, entry] of views) {
    const item = state.documents.find(item => item.documentId === id);
    if (!ids.has(id) || item.url !== entry.url) { entry.view.remove(); views.delete(id); }
  }
  document.querySelector('#tabs').replaceChildren();
  for (const item of state.documents) {
    let entry = views.get(item.documentId);
    const ownerKey = item.ownerChatId || 'file-draft:' + encodeURIComponent(item.agentKey) + ':' + item.newChat;
    if (!entry || entry.ownerKey !== ownerKey) {
      const binding = await window.workspace.bind({
        documentId: item.documentId, ownerChatId: item.ownerChatId,
        ...(item.newChat ? {newChat: item.newChat} : {}), rendererGeneration: 'fixture-generation',
      });
      if (!binding.ok) continue;
      if (entry) entry.ownerKey = ownerKey;
    }
    if (!entry) {
      const view = document.createElement('webview');
      view.setAttribute('partition', item.partition);
      view.setAttribute('webpreferences', 'sandbox=yes,contextIsolation=yes');
      view.setAttribute('src', item.url);
      view.dataset.documentId = item.documentId;
      view.addEventListener('dom-ready', () => { view.dataset.ready = 'true'; });
      document.querySelector('#panels').append(view);
      entry = { view, url: item.url, version: item.version, ownerKey };
      views.set(item.documentId, entry);
    } else if (entry.version !== item.version) {
      entry.version = item.version;
      entry.view.reload();
    }
    entry.view.hidden = item.documentId !== state.activeDocumentId;
    const tab = document.createElement('button');
    tab.textContent = item.fileName;
    tab.setAttribute('aria-selected', String(item.documentId === state.activeDocumentId));
    tab.onclick = () => window.workspace.activate(item.documentId);
    document.querySelector('#tabs').append(tab);
  }
}
let rendering = Promise.resolve();
const scheduleRender = state => { rendering = rendering.then(() => render(state)); };
window.workspace.onChanged(scheduleRender);
window.workspace.onClose(({guestId}) => {
  for (const [id, {view}] of views) if (view.getWebContentsId() === guestId) void window.workspace.close(id);
});
window.workspace.onBrowserShortcut(payload => { window.lastBrowserShortcut = payload; });
window.workspace.getState().then(scheduleRender);
window.workspaceSnapshot = () => ({ ...currentState,
  visible: !document.querySelector('#workspace').hidden,
  guests: [...views].map(([id, {view}]) => ({
    documentId: id, hidden: view.hidden, ready: view.dataset.ready === 'true',
    guestId: (() => { try { return view.getWebContentsId(); } catch { return null; } })(),
  })),
});
window.setWorkspaceVisible = visible => { document.querySelector('#workspace').hidden = !visible; };
</script>`);
  const window = new BrowserWindow({
    title: "Local document workspace QA", width: 1100, height: 780, show: false,
    webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: true, backgroundThrottling: false },
  });
  const routes = [];
  const blockedAttachments = [];
  const draftTargets = [];
  const promotedChats = [];
  const originalPaths = new Map();
  let mainSurface;
  const surfaceFor = chatId => ({
    surfaceId: "main-chat", serviceId: "agent-webclient", surfaceRole: "main-chat", surfaceLevel: "root", active: true,
    ownerChatId: chatId, url: `https://fixture.test/agent/xiaojun?chatId=${encodeURIComponent(chatId)}`,
  });
  const navigate = route => {
    routes.push(route);
    const parsed = new URL(route, "https://fixture.test");
    const chatId = parsed.searchParams.get("chatId");
    mainSurface = promotedChats.some(chat => chat.chatId === chatId) ? surfaceFor(chatId) : undefined;
    void window.webContents.executeJavaScript(`location.hash = ${JSON.stringify(route)}; undefined`).catch(() => {});
  };
  const editing = createLocalDocumentEditingChat({
    getAgentKey: () => "xiaojun", getMainChatSurface: () => mainSurface,
    getDesktopRoute: () => window.isDestroyed() ? "" : window.webContents.getURL(), delay: pause,
  });
  const controller = new LocalDocumentWorkspaceController({
    getMainWindow: () => window,
    showMainWindow: navigate,
    ...editing,
    getEditingChat: async () => {
      const target = await editing.getEditingChat();
      assert.equal(target.chatId, "");
      assert.match(target.newChat, /^[1-9]\d{12}$/u);
      if (!draftTargets.some(previous => previous.newChat === target.newChat)) draftTargets.push(target);
      return target;
    },
    showFileDialog: async () => ({ canceled: true, filePaths: [] }),
  }, dependencies);
  controller.registerIpc(ipcMain);
  window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const result = prepareWebviewAttachPreferences({
      webPreferences, params,
      servicePreloadPath: path.join(root, "service-webview.js"),
      servicePreloadUrl: pathToFileURL(path.join(root, "service-webview.js")).href,
      isSafeServiceUrl: () => false,
      isLocalDocumentPreview: (url, partition) => controller.canAttach(url, partition, window.webContents.id),
    });
    if (!result.ok) { blockedAttachments.push(result); event.preventDefault(); }
  });
  window.webContents.on("did-attach-webview", (_event, guest) => {
    if (!controller.configureGuest(guest)) throw Error("Unexpected test guest");
  });
  await window.loadFile(hostFile);
  const snapshot = () => window.webContents.executeJavaScript("window.workspaceSnapshot()");
  await until(async () => (await snapshot()).revision >= 0, "trusted shell snapshot");
  const guestFor = async documentId => {
    let contents;
    await until(async () => {
      const state = await snapshot();
      const guest = state.guests.find(item => item.documentId === documentId);
      contents = guest?.guestId && webContents.fromId(guest.guestId);
      return contents && !contents.isDestroyed() && guest.ready && !contents.isLoading();
    }, `document guest: ${documentId}`);
    return contents;
  };
  const invoke = (method, id) => window.webContents.executeJavaScript(`window.workspace.${method}(${JSON.stringify(id)})`);
  const activateDocument = async documentId => {
    const result = await invoke("activate", documentId);
    if (!result.ok) throw Error(`Cannot activate test document ${documentId}`);
    return guestFor(documentId);
  };
  let inputQueue = Promise.resolve();
  const openFile = filePath => {
    const opening = inputQueue.then(async () => {
      await controller.open(filePath);
      const state = await invoke("getState");
      const document = state.documents.find(item => item.documentId === state.activeDocumentId);
      if (!document) throw Error("An opened file has no retained document");
      const original = fs.realpathSync(filePath);
      if (originalPaths.has(document.documentId)) assert.equal(originalPaths.get(document.documentId), original);
      originalPaths.set(document.documentId, original);
      assert.equal(JSON.stringify(document).includes(original), false, "opaque DTO does not expose the original path");
      return document;
    });
    inputQueue = opening.catch(() => {});
    return opening;
  };
  const startFileGroup = async () => {
    const nonce = String(Math.max(Date.now(), ...draftTargets.map(target => Number(target.newChat) + 1)));
    navigate(`/agent/xiaojun?newChat=${nonce}`);
    assert.equal(await editing.waitForEditingChatRequested("", "xiaojun", nonce), true);
    return nonce;
  };
  const promoteFileGroup = async (chatId = `query-created-chat-${promotedChats.length + 1}`) => {
    const before = await invoke("getState");
    const selected = before.documents.find(item => item.documentId === before.activeDocumentId);
    assert.equal(selected.ownerChatId, "");
    const newChat = selected.newChat;
    assert.equal(controller.beginDraftChatPromotion({ownerWebContentsId: window.webContents.id, agentKey: "xiaojun", newChat, chatId}), true);
    navigate(`/agent/xiaojun?chatId=${chatId}`);
    assert.equal(await editing.waitForEditingChatRequested(chatId, "xiaojun"), true);
    assert.equal(controller.promoteDraftChat({ownerWebContentsId: window.webContents.id, agentKey: "xiaojun", newChat, chatId}), true);
    promotedChats.push({chatId, newChat});
    mainSurface = surfaceFor(chatId);
    await controller.waitForChatPresentation({chatId, agentKey: "xiaojun"});
    const after = await invoke("getState");
    for (const old of before.documents.filter(item => item.newChat === newChat)) {
      const promoted = after.documents.find(item => item.documentId === old.documentId);
      assert.equal(promoted.ownerChatId, chatId);
      assert.equal(Object.hasOwn(promoted, "newChat"), false);
      for (const field of ["documentId", "url", "partition", "version"]) assert.equal(promoted[field], old[field]);
    }
    return chatId;
  };
  return { window, controller, snapshot, guestFor, activateDocument, invoke, routes, blockedAttachments, draftTargets, promotedChats,
    openFile, startFileGroup, promoteFileGroup, sourcePathFor: document => originalPaths.get(document.documentId),
    ownerKeyFor: localDocumentOwnerKey,
    dispose() { controller.dispose(); if (!window.isDestroyed()) window.destroy(); },
  };
}

module.exports = { createWorkspaceHost, until, pause };
