import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
const compiledRoot = process.env.LOCAL_DOCUMENT_TEST_BUILD_ROOT ?? fileURLToPath(new URL("../dist-electron", import.meta.url));
const compiled = (relative) => import(pathToFileURL(path.join(compiledRoot, relative)).href);
const { LocalDocumentWorkspaceController } = await compiled("main/modules/work-panel/local-document-workspace.js");
const { LOCAL_DOCUMENT_CHANNELS: channels, localDocumentOwnerKey } = await compiled("shared/local-document.js");
const { LOCAL_MARKDOWN_MAX_BYTES } = await compiled("main/modules/work-panel/local-document-worker-contract.js");
const editingRoute = "/agent/xiaojun?chatId=editing-chat";
const activeFileRequest = document => ({
  documentId: document.documentId, chatId: document.ownerChatId, agentKey: document.agentKey,
});

function event() {
  return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((finish, fail) => { resolve = finish; reject = fail; });
  return { promise, resolve, reject };
}

function mainContents(id = 100) {
  return Object.assign(new EventEmitter(), {
    id, mainFrame: {}, destroyed: false, messages: [],
    isDestroyed() { return this.destroyed; },
    send(channel, payload) { this.messages.push({ channel, payload }); },
    destroy() { this.destroyed = true; this.emit("destroyed"); },
  });
}

function previewSession(partition) {
  const state = { partition, unhandled: 0, cleared: 0, cacheCleared: 0, connectionsClosed: 0 };
  const session = Object.assign(new EventEmitter(), {
    protocol: {
      handle(_scheme, handler) { state.request = handler; },
      unhandle() { state.unhandled += 1; },
    },
    webRequest: { onBeforeRequest(handler) { state.beforeRequest = handler; } },
    setPermissionRequestHandler(handler) { state.permissionRequest = handler; },
    setPermissionCheckHandler(handler) { state.permissionCheck = handler; },
    setDevicePermissionHandler(handler) { state.devicePermission = handler; },
    async clearStorageData() { state.cleared += 1; },
    async clearCache() { state.cacheCleared += 1; },
    async closeAllConnections() { state.connectionsClosed += 1; },
  });
  return { session, state, request: (url, method = "GET") => state.request({ url, method }) };
}

function guest(session, owner, id = 200) {
  return Object.assign(new EventEmitter(), {
    id, session, hostWebContents: owner, destroyed: false, closes: [], reloads: 0,
    isDestroyed() { return this.destroyed; },
    getType() { return "webview"; },
    setWindowOpenHandler(handler) { this.windowOpen = handler; },
    close(options) { this.closes.push(options); this.destroyed = true; this.emit("destroyed"); },
    reload() { this.reloads += 1; },
  });
}

function fixture(t, {
  cold = false, draft = false, platform = "darwin", renderMarkdown, showFileDialog, guardGuest,
  getEditingChat, isEditingChatActive, isEditingChatRequested, waitForEditingChatRequested,
  settleRequestedRoute = true, watchFile, unwatchFile,
} = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "local-file-workspace-")));
  const owner = mainContents();
  const sessions = new Map();
  const handlers = new Map();
  const shown = [];
  const revealed = [];
  const dialogs = [];
  const prepareCalls = [];
  const watches = [];
  const unwatches = [];
  let preparedChat = { agentKey: "xiaojun", chatId: "editing-chat" };
  let nextDraft = 0;
  let activeChat = preparedChat;
  let requestedChat = activeChat;
  let window = cold ? null : { isDestroyed: () => false, webContents: owner };
  const controller = new LocalDocumentWorkspaceController({
    platform, getMainWindow: () => window, showMainWindow: (route) => {
      shown.push(route);
      if (settleRequestedRoute && route) {
        const url = new URL(route, "http://desktop.local");
        requestedChat = { agentKey: decodeURIComponent(url.pathname.slice("/agent/".length)), chatId: url.searchParams.get("chatId") || "",
          ...(url.searchParams.has("newChat") ? { newChat: url.searchParams.get("newChat") } : {}) };
      }
    },
    getEditingChat: async () => { prepareCalls.push(true); return getEditingChat ? getEditingChat() :
      draft ? { agentKey: "xiaojun", chatId: "", newChat: String(1700000000000 + ++nextDraft) } : preparedChat; },
    isEditingChatActive: (chatId, agentKey, newChat) => isEditingChatActive ? isEditingChatActive(chatId, agentKey, newChat) :
      activeChat?.chatId === chatId && activeChat?.agentKey === agentKey && activeChat?.newChat === newChat &&
      requestedChat?.chatId === chatId && requestedChat?.agentKey === agentKey && requestedChat?.newChat === newChat,
    isEditingChatRequested: (chatId, agentKey, newChat) => isEditingChatRequested ? isEditingChatRequested(chatId, agentKey, newChat) :
      requestedChat?.chatId === chatId && requestedChat?.agentKey === agentKey && requestedChat?.newChat === newChat,
    waitForEditingChatRequested: (chatId, agentKey, newChat) => waitForEditingChatRequested
      ? waitForEditingChatRequested(chatId, agentKey, newChat)
      : Promise.resolve(requestedChat?.chatId === chatId && requestedChat?.agentKey === agentKey && requestedChat?.newChat === newChat),
    showFileDialog: async (options, ownerWindow) => {
      dialogs.push({ options, ownerWindow });
      return showFileDialog ? showFileDialog(options, ownerWindow) : { canceled: true, filePaths: [] };
    },
  }, {
    guardGuest: guardGuest ?? (() => ({ ready: Promise.resolve(), dispose() {} })),
    createSession(partition) {
      const created = previewSession(partition);
      sessions.set(partition, created);
      return created.session;
    },
    async fetchFile(url, method) {
      return new Response(method === "HEAD" ? null : await fs.promises.readFile(fileURLToPath(url)), {
        headers: { "Content-Type": url.endsWith(".css") ? "text/css" : "text/html", "X-Original-File": "true" },
      });
    },
    renderMarkdown: renderMarkdown ?? (async (bytes) => `<h1>${bytes.toString("utf8").replace(/^# /u, "")}</h1>`),
    revealFile: (filePath) => revealed.push(filePath),
    watchFile(filePath, options, listener) {
      watches.push({ filePath, options, listener });
      (watchFile ?? fs.watchFile)(filePath, options, listener);
    },
    unwatchFile(filePath, listener) {
      unwatches.push({ filePath, listener });
      (unwatchFile ?? fs.unwatchFile)(filePath, listener);
    },
  });
  controller.registerIpc({
    handle(channel, handler) { assert.equal(handlers.has(channel), false); handlers.set(channel, handler); },
    removeHandler(channel) { handlers.delete(channel); },
  });
  const invoke = (channel, value, ipcEvent = { sender: window?.webContents, senderFrame: window?.webContents.mainFrame }) =>
    Promise.resolve().then(() => handlers.get(channel)(ipcEvent, value));
  const file = (name, content = "<!doctype html><h1>中文页面</h1>") => {
    const target = path.join(root, name);
    fs.writeFileSync(target, content);
    return target;
  };
  t.after(() => { controller.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { controller, sessions, handlers, owner, shown, revealed, dialogs, prepareCalls, watches, unwatches, root, file, invoke,
    bind: (document, rendererGeneration = "renderer-1") => invoke(channels.bind, {
      documentId: document.documentId, ownerChatId: document.ownerChatId, rendererGeneration,
      ...(document.newChat === undefined ? {} : { newChat: document.newChat }),
    }),
    setActiveChat(chat) { activeChat = chat; requestedChat = chat; },
    setRequestedChat(chat) { requestedChat = chat; },
    setPreparedChat(chat) { preparedChat = chat; },
    state: () => invoke(channels.getState),
    setWindow(contents) { window = contents ? { isDestroyed: () => false, webContents: contents } : null; },
  };
}

function promoteDraft(fixture, input) {
  fixture.controller.beginDraftChatPromotion(input);
  return fixture.controller.promoteDraftChat(input);
}

test("opening files creates only an ownerless local preview group with no server Chat identity", async t => {
  const f = fixture(t, { draft: true });
  const original = f.file("preview.html");
  const markdown = f.file("preview.md", "# preview");
  const originalRead = fs.promises.readFile;
  fs.promises.readFile = async () => { throw Error("opening must not read a file body for model context"); };
  try { await Promise.all([f.controller.open(original), f.controller.open(markdown)]); }
  finally { fs.promises.readFile = originalRead; }
  const state = await f.state();
  assert.equal(state.documents.length, 2);
  assert.equal(f.prepareCalls.length, 1, "one local target serves the batch");
  assert.ok(state.documents.every(document => document.ownerChatId === "" && document.newChat === "1700000000001"));
  assert.equal(new Set(state.documents.map(localDocumentOwnerKey)).size, 1);
  assert.equal(localDocumentOwnerKey(state.documents[0]), "file-draft:xiaojun:1700000000001");
  assert.ok(f.shown.every(route => route === "/agent/xiaojun?newChat=1700000000001"));
  assert.equal(f.sessions.size, 2);
  assert.equal(new Set(state.documents.map(document => document.partition)).size, 2);
  assert.equal(JSON.stringify(state).includes(f.root), false);
  assert.equal([...f.handlers.keys()].some(channel => /promote|presentation/iu.test(channel)), false);
});

test("draft previews bind from the trusted top Main requested route without an Agent guest or Platform", async t => {
  const f = fixture(t, { draft: true, isEditingChatActive: () => false });
  await f.controller.open(f.file("offline-preview.html"));
  const document = (await f.state()).documents[0];
  assert.equal((await f.bind(document)).ok, true);
  for (const change of [
    { newChat: "1700000000002" }, { ownerChatId: "forged-server-chat" }, { newChat: undefined },
  ]) assert.equal((await f.invoke(channels.bind, { ...document, rendererGeneration: "renderer-1", ...change })).ok, false);
  const foreign = mainContents(101);
  assert.equal((await f.invoke(channels.bind, { ...document, rendererGeneration: "renderer-1" }, {sender: foreign, senderFrame: foreign.mainFrame})).ok, false);
  assert.equal((await f.invoke(channels.bind, { ...document, rendererGeneration: "renderer-1" }, {sender: f.owner, senderFrame: {}})).ok, false);
  f.setRequestedChat({ agentKey: "xiaojun", chatId: "", newChat: "1700000000002" });
  assert.equal((await f.bind(document)).ok, false);
  await assert.rejects(f.controller.resolveActiveFile(activeFileRequest(document)), "draft paths never enter model tools");
});

test("opening the same original again activates its existing draft tab without another target or session", async t => {
  const f = fixture(t, { draft: true });
  const original = f.file("same-draft.html");
  const alias = path.join(f.root, "same-draft-alias.html");
  fs.symlinkSync(original, alias);
  await f.controller.open(original);
  const first = await f.state();
  await f.controller.open(alias);
  const repeated = await f.state();
  assert.deepEqual(repeated.documents, first.documents);
  assert.equal(repeated.activeDocumentId, first.activeDocumentId);
  assert.equal(repeated.openRevision, first.openRevision + 1);
  assert.equal(f.prepareCalls.length, 1);
  assert.equal(f.sessions.size, 1);
  assert.equal(f.watches.length, 1);
});

test("promoting the first normal query preserves the whole preview group and waits separately for canonical presentation", async t => {
  const f = fixture(t, { draft: true });
  const original = f.file("first-query.html");
  await f.controller.open(original);
  await f.controller.open(f.file("first-query.md", "# second"));
  const before = await f.state();
  const guests = [];
  for (const document of before.documents) {
    await f.bind(document);
    const contents = guest(f.sessions.get(document.partition).session, f.owner, 200 + guests.length);
    assert.equal(f.controller.configureGuest(contents), true);
    guests.push(contents);
  }
  f.setRequestedChat({ agentKey: "xiaojun", chatId: "real-chat-from-query" });
  assert.equal(promoteDraft(f, {ownerWebContentsId: f.owner.id, agentKey: "xiaojun", newChat: before.documents[0].newChat, chatId: "real-chat-from-query"}), true);
  const promoted = await f.state();
  assert.equal(promoted.revision, before.revision + 1);
  assert.equal(promoted.openRevision, before.openRevision);
  assert.ok(promoted.documents.every(document => document.ownerChatId === "real-chat-from-query" && !Object.hasOwn(document, "newChat")));
  for (let index = 0; index < before.documents.length; index++) {
    for (const field of ["documentId", "url", "partition", "version"]) assert.equal(promoted.documents[index][field], before.documents[index][field]);
    assert.equal(guests[index].destroyed, false);
  }
  assert.equal(f.sessions.size, 2);
  assert.equal(f.watches.length, 2);
  assert.equal(f.shown.length, 2, "promotion sends no navigation");
  await assert.rejects(f.controller.resolveActiveFile(activeFileRequest(promoted.documents[0])), "canonical owner alone is not presentation readiness");
  let settled = false;
  const presentation = f.controller.waitForChatPresentation({chatId: "real-chat-from-query", agentKey: "xiaojun"}).then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal((await f.bind(before.documents[0])).ok, false, "the old draft binding cannot acknowledge canonical presentation");
  f.setActiveChat({ agentKey: "xiaojun", chatId: "real-chat-from-query" });
  await f.bind(promoted.documents[0]);
  await Promise.resolve();
  assert.equal(settled, false, "all promoted tabs must be adopted before the first WorkPanel state read");
  await f.bind(promoted.documents[1]);
  await presentation;
  assert.equal((await f.controller.resolveActiveFile(activeFileRequest(promoted.documents[0]))).path, original);
  assert.equal(f.sessions.size, 2);
});

test("a file already opening during the first query follows the promoted owner instead of creating another draft", async t => {
  const f = fixture(t, {draft: true});
  await f.controller.open(f.file("before-query.html"));
  const first = (await f.state()).documents[0];
  await f.bind(first);
  const incoming = f.file("during-query.md", "# incoming");
  const originalStat = fs.promises.stat;
  let validations = 0;
  fs.promises.stat = async (...args) => {
    const stat = await originalStat(...args);
    if (args[0] === incoming && ++validations === 2) {
      f.setRequestedChat({agentKey: "xiaojun", chatId: "query-created-chat"});
      assert.equal(promoteDraft(f, {ownerWebContentsId: f.owner.id, agentKey: "xiaojun", newChat: first.newChat, chatId: "query-created-chat"}), true);
    }
    return stat;
  };
  try { await f.controller.open(incoming); }
  finally { fs.promises.stat = originalStat; }
  const documents = (await f.state()).documents;
  assert.equal(f.prepareCalls.length, 1);
  assert.ok(documents.every(document => document.ownerChatId === "query-created-chat" && !Object.hasOwn(document, "newChat")));
  f.setActiveChat({agentKey: "xiaojun", chatId: "query-created-chat"});
  let settled = false;
  const presentation = f.controller.waitForChatPresentation({chatId: "query-created-chat", agentKey: "xiaojun"}).then(() => {settled = true;});
  await f.bind(documents[0]);
  await Promise.resolve();
  assert.equal(settled, false, "the new tab participates in the same presentation handoff");
  await f.bind(documents[1]);
  await presentation;
});

for (const invalidation of ["owner", "same-id-owner", "agent", "nonce", "route", "frame", "reload", "close", "dispose"]) {
  test(`a stale canonical ACK cannot promote an unrelated draft group: ${invalidation}`, async t => {
    const f = fixture(t, { draft: true });
    await f.controller.open(f.file("stale-ack.html"));
    const document = (await f.state()).documents[0];
    await f.bind(document);
    const input = {ownerWebContentsId: f.owner.id, agentKey: "xiaojun", newChat: document.newChat, chatId: "canonical-from-query"};
    f.setRequestedChat({agentKey: "xiaojun", chatId: input.chatId});
    if (invalidation === "owner") input.ownerWebContentsId = 999;
    if (invalidation === "same-id-owner") f.setWindow(mainContents(f.owner.id));
    if (invalidation === "agent") input.agentKey = "another-agent";
    if (invalidation === "nonce") input.newChat = "1700000000002";
    if (invalidation === "route") f.setRequestedChat({agentKey: "xiaojun", chatId: "ordinary-chat"});
    if (invalidation === "frame") f.owner.mainFrame = {};
    if (invalidation === "reload") f.owner.emit("did-start-navigation", {isMainFrame: true, isSameDocument: false});
    if (invalidation === "close") await f.invoke(channels.close, document.documentId);
    if (invalidation === "dispose") f.controller.dispose();
    if (["owner", "same-id-owner", "route", "frame", "reload"].includes(invalidation)) {
      assert.throws(() => promoteDraft(f, input), error => !error.message.includes(f.root));
    } else assert.equal(promoteDraft(f, input), false);
    if (!["same-id-owner", "close", "dispose"].includes(invalidation)) {
      assert.equal((await f.state()).documents[0].ownerChatId, "");
      assert.equal((await f.state()).documents[0].newChat, document.newChat);
    }
  });
}

for (const invalidation of ["close", "reload", "dispose"]) {
  test(`pending canonical presentation rejects immediately on ${invalidation}`, async t => {
    const f = fixture(t, {draft: true});
    await f.controller.open(f.file("presentation-pending.html"));
    const document = (await f.state()).documents[0];
    await f.bind(document);
    f.setRequestedChat({agentKey: "xiaojun", chatId: "canonical-pending"});
    assert.equal(promoteDraft(f, {ownerWebContentsId: f.owner.id, agentKey: "xiaojun", newChat: document.newChat, chatId: "canonical-pending"}), true);
    const presentation = f.controller.waitForChatPresentation({chatId: "canonical-pending", agentKey: "xiaojun"});
    const rejected = assert.rejects(presentation, error => !error.message.includes(f.root));
    if (invalidation === "close") await f.invoke(channels.close, document.documentId);
    if (invalidation === "reload") f.owner.emit("did-start-navigation", {isMainFrame: true, isSameDocument: false});
    if (invalidation === "dispose") f.controller.dispose();
    await rejected;
  });
}

test("canonical presentation has a bounded failure and unrelated canonical Chats never wait", async t => {
  const f = fixture(t, {draft: true});
  await f.controller.open(f.file("presentation-timeout.html"));
  const document = (await f.state()).documents[0];
  await f.bind(document);
  f.setRequestedChat({agentKey: "xiaojun", chatId: "canonical-timeout"});
  assert.equal(promoteDraft(f, {ownerWebContentsId: f.owner.id, agentKey: "xiaojun", newChat: document.newChat, chatId: "canonical-timeout"}), true);
  await f.controller.waitForChatPresentation({chatId: "unrelated-chat", agentKey: "xiaojun"});
  await assert.rejects(f.controller.waitForChatPresentation({chatId: "canonical-timeout", agentKey: "xiaojun"}), error => !error.message.includes(f.root));
});

test("a first WorkPanel read before the guard ACK waits through owner promotion and canonical binding", async t => {
  const f = fixture(t, {draft: true});
  await f.controller.open(f.file("before-ack.html"));
  await f.controller.open(f.file("before-ack.md", "# two"));
  const before = await f.state();
  for (const document of before.documents) await f.bind(document);
  const input = {ownerWebContentsId: f.owner.id, agentKey: "xiaojun", newChat: before.documents[0].newChat, chatId: "first-query-before-ack"};
  assert.equal(f.controller.beginDraftChatPromotion(input), true);
  assert.deepEqual(await f.state(), before, "begin changes no public descriptor or owner");
  let resolved = false;
  const presentation = f.controller.waitForChatPresentation({chatId: input.chatId, agentKey: input.agentKey}).then(() => {resolved = true;});
  await Promise.resolve();
  assert.equal(resolved, false, "the server-owned ID is associated even while the host still shows its draft route");
  await assert.rejects(f.controller.resolveActiveFile({...activeFileRequest(before.documents[0]), chatId: input.chatId}));
  f.setRequestedChat({agentKey: input.agentKey, chatId: input.chatId});
  assert.equal(f.controller.promoteDraftChat(input), true);
  assert.equal(f.controller.cancelDraftChatPromotion(input), false, "a successful helper finally block cannot cancel presentation readiness");
  await Promise.resolve();
  assert.equal(resolved, false);
  f.setActiveChat({agentKey: input.agentKey, chatId: input.chatId});
  for (const document of (await f.state()).documents) await f.bind(document);
  await presentation;
  assert.equal((await f.controller.resolveActiveFile({...activeFileRequest((await f.state()).documents[0])})).fileName, "before-ack.html");
});

test("ordinary no-file queries are noops and a draft cannot be associated with a different canonical ID", async t => {
  const f = fixture(t, {draft: true});
  const absent = {ownerWebContentsId: f.owner.id, agentKey: "xiaojun", newChat: "1700000000001", chatId: "ordinary-query"};
  assert.equal(f.controller.beginDraftChatPromotion(absent), false);
  assert.equal(f.controller.promoteDraftChat(absent), false);
  assert.equal(f.controller.cancelDraftChatPromotion(absent), false);
  await f.controller.waitForChatPresentation({chatId: absent.chatId, agentKey: absent.agentKey});
  await f.controller.open(f.file("pending-one-id.html"));
  const document = (await f.state()).documents[0];
  await f.bind(document);
  const input = {...absent, newChat: document.newChat, chatId: "one-canonical-id"};
  assert.equal(f.controller.beginDraftChatPromotion(input), true);
  assert.equal(f.controller.beginDraftChatPromotion(input), true, "the same trusted request is idempotent");
  assert.throws(() => f.controller.beginDraftChatPromotion({...input, chatId: "other-canonical-id"}));
  f.controller.cancelDraftChatPromotion(input);
});

test("a failed canonical handoff cancels its wait and a later ACK cannot silently promote the preserved draft", async t => {
  const f = fixture(t, {draft: true});
  await f.controller.open(f.file("cancelled-handoff.html"));
  const before = await f.state();
  await f.bind(before.documents[0]);
  const input = {ownerWebContentsId: f.owner.id, agentKey: "xiaojun", newChat: before.documents[0].newChat, chatId: "cancelled-canonical-id"};
  assert.equal(f.controller.beginDraftChatPromotion(input), true);
  const rejected = assert.rejects(f.controller.waitForChatPresentation({chatId: input.chatId, agentKey: input.agentKey}), error => !error.message.includes(f.root));
  assert.equal(f.controller.cancelDraftChatPromotion(input), true);
  await rejected;
  f.setRequestedChat({agentKey: input.agentKey, chatId: input.chatId});
  assert.throws(() => f.controller.promoteDraftChat(input));
  assert.deepEqual(await f.state(), before);
  assert.equal(f.sessions.size, 1);
  assert.equal(f.unwatches.length, 0);
});

for (const invalidation of ["close", "reload", "dispose"]) {
  test(`pre-ACK presentation wait is cancelled on ${invalidation}`, async t => {
    const f = fixture(t, {draft: true});
    await f.controller.open(f.file("pre-ack-invalidated.html"));
    const document = (await f.state()).documents[0];
    await f.bind(document);
    const input = {ownerWebContentsId: f.owner.id, agentKey: "xiaojun", newChat: document.newChat, chatId: "pre-ack-pending"};
    assert.equal(f.controller.beginDraftChatPromotion(input), true);
    const rejected = assert.rejects(f.controller.waitForChatPresentation({chatId: input.chatId, agentKey: input.agentKey}));
    if (invalidation === "close") await f.invoke(channels.close, document.documentId);
    if (invalidation === "reload") f.owner.emit("did-start-navigation", {isMainFrame: true, isSameDocument: false});
    if (invalidation === "dispose") f.controller.dispose();
    await rejected;
    if (invalidation === "reload") {
      f.setRequestedChat({agentKey: input.agentKey, chatId: input.chatId});
      assert.throws(() => f.controller.promoteDraftChat(input));
    }
  });
}

test("closing one pending group cannot reject another group's first WorkPanel read", async t => {
  const f = fixture(t, {draft: true});
  await f.controller.open(f.file("pending-group-one.html"));
  const first = (await f.state()).documents[0];
  await f.bind(first);
  const firstInput = {ownerWebContentsId: f.owner.id, agentKey: first.agentKey, newChat: first.newChat, chatId: "group-one-chat"};
  f.controller.beginDraftChatPromotion(firstInput);
  f.setActiveChat({agentKey: "xiaojun", chatId: "ordinary-chat"});
  await f.controller.open(f.file("pending-group-two.html"));
  const second = (await f.state()).documents[1];
  await f.bind(second);
  const secondInput = {ownerWebContentsId: f.owner.id, agentKey: second.agentKey, newChat: second.newChat, chatId: "group-two-chat"};
  f.controller.beginDraftChatPromotion(secondInput);
  const rejectedFirst = assert.rejects(f.controller.waitForChatPresentation({chatId: firstInput.chatId, agentKey: firstInput.agentKey}));
  let secondResolved = false;
  const waitingSecond = f.controller.waitForChatPresentation({chatId: secondInput.chatId, agentKey: secondInput.agentKey}).then(() => {secondResolved = true;});
  await f.invoke(channels.close, first.documentId);
  await rejectedFirst;
  await Promise.resolve();
  assert.equal(secondResolved, false);
  f.setRequestedChat({agentKey: secondInput.agentKey, chatId: secondInput.chatId});
  assert.equal(f.controller.promoteDraftChat(secondInput), true);
  f.setActiveChat({agentKey: secondInput.agentKey, chatId: secondInput.chatId});
  await f.bind((await f.state()).documents[0]);
  await waitingSecond;
});

test("a pre-ACK timeout clears its association and refuses an unpaired late commit", async t => {
  const f = fixture(t, {draft: true});
  await f.controller.open(f.file("pre-ack-timeout.html"));
  const document = (await f.state()).documents[0];
  await f.bind(document);
  const input = {ownerWebContentsId: f.owner.id, agentKey: document.agentKey, newChat: document.newChat, chatId: "pre-ack-timeout-chat"};
  f.controller.beginDraftChatPromotion(input);
  await assert.rejects(f.controller.waitForChatPresentation({chatId: input.chatId, agentKey: input.agentKey}));
  f.setRequestedChat({agentKey: input.agentKey, chatId: input.chatId});
  assert.throws(() => f.controller.promoteDraftChat(input));
  assert.equal((await f.state()).documents[0].ownerChatId, "");
});

test("cold OS opens survive first renderer navigation and retain the prepared editing Chat", async (t) => {
  const f = fixture(t, { cold: true });
  await Promise.all([f.controller.open(f.file("资料 文件.MD", "# 中文")), f.controller.open(f.file("互动页面.HTML"))]);
  assert.deepEqual(f.shown, [editingRoute, editingRoute]);
  assert.equal(f.sessions.size, 2);
  assert.equal(f.prepareCalls.length, 1, "different cold selections share the prepared file Chat");
  assert.equal(f.owner.messages.length, 0);
  await assert.rejects(f.state(), /access denied/u);
  f.setWindow(f.owner);
  f.owner.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  const snapshot = await f.state();
  assert.equal(snapshot.documents.length, 2);
  assert.equal(snapshot.revision, 2);
  assert.equal(snapshot.documents.at(-1).documentId, snapshot.activeDocumentId);
  assert.deepEqual(new Set(snapshot.documents.map((item) => item.kind)), new Set(["markdown", "html"]));
  assert.equal(JSON.stringify(snapshot).includes(f.root), false);
  for (const item of snapshot.documents) {
    assert.deepEqual(Object.keys(item).sort(), ["agentKey", "documentId", "fileName", "kind", "ownerChatId", "partition", "url", "version"]);
    assert.match(item.partition, /^local-document-/u);
    assert.equal(item.partition.startsWith("persist:"), false);
  }
});

test("the same original in different file conversations keeps isolated previews while activation preserves guests", async (t) => {
  let nextChat = 0;
  const f = fixture(t, { getEditingChat: async () => ({ agentKey: "xiaojun", chatId: `chat-${++nextChat}` }) });
  const original = f.file("报告.html");
  const alias = path.join(f.root, "链接.html");
  fs.symlinkSync(original, alias);
  await f.controller.open(original);
  f.setActiveChat({agentKey: "xiaojun", chatId: "ordinary-before-alias"});
  await f.controller.open(alias);
  f.setActiveChat({agentKey: "xiaojun", chatId: "ordinary-before-repeat"});
  await f.controller.open(original);
  const initial = (await f.state()).documents;
  const [first, second] = initial;
  assert.equal(f.sessions.size, 3);
  assert.equal(f.prepareCalls.length, 3);
  for (const key of ["documentId", "ownerChatId", "partition", "url"]) assert.equal(new Set(initial.map(document => document[key])).size, 3, key);
  assert.ok(f.watches.every(watch => watch.filePath === original));
  f.setActiveChat({ agentKey: first.agentKey, chatId: first.ownerChatId });
  await f.bind(first);
  const firstGuest = guest(f.sessions.get(first.partition).session, f.owner);
  assert.equal(f.controller.canAttach(first.url, first.partition, f.owner.id), true);
  assert.equal(f.controller.configureGuest(firstGuest), true);
  f.setActiveChat({ agentKey: second.agentKey, chatId: second.ownerChatId });
  await f.bind(second);
  const secondGuest = guest(f.sessions.get(second.partition).session, f.owner, 201);
  assert.equal(f.controller.configureGuest(secondGuest), true);
  f.setActiveChat({agentKey: "xiaojun", chatId: "ordinary-before-fourth"});
  await f.controller.open(alias);
  assert.equal((await f.state()).activeDocumentId, (await f.state()).documents[3].documentId);
  assert.deepEqual((await f.state()).documents[0], first);
  await f.invoke(channels.activate, second.documentId);
  assert.equal((await f.state()).activeDocumentId, second.documentId);
  assert.equal(f.shown.at(-1), `/agent/xiaojun?chatId=${second.ownerChatId}`);
  assert.equal(firstGuest.destroyed || secondGuest.destroyed, false);
  assert.equal(f.sessions.size, 4);
  assert.equal(f.prepareCalls.length, 4, "activate does not prepare a new Chat");
  const changed = f.owner.messages.filter((message) => message.channel === channels.changed).map((message) => message.payload);
  assert.ok(changed.every((state, index) => index === 0 || state.revision > changed[index - 1].revision));
  assert.deepEqual(changed.at(-1), await f.state());
});

test("workspace IPC rejects other WebContents, same-id forgeries and subframes", async (t) => {
  const f = fixture(t);
  await f.controller.open(f.file("private.html"));
  const document = (await f.state()).documents[0];
  const other = mainContents(101);
  for (const request of [
    { sender: other, senderFrame: other.mainFrame },
    { sender: mainContents(f.owner.id), senderFrame: f.owner.mainFrame },
    { sender: f.owner, senderFrame: {} },
    { sender: f.owner, senderFrame: null },
  ]) {
    await assert.rejects(f.invoke(channels.getState, undefined, request), /access denied/u);
    for (const channel of [channels.activate, channels.close, channels.reveal]) {
      assert.deepEqual(await f.invoke(channel, document.documentId, request), { ok: false });
    }
    assert.deepEqual(await f.invoke(channels.select, undefined, request), { ok: false });
  }
  for (const input of [null, {}, [], { documentId: document.documentId }, "forged"]) {
    for (const channel of [channels.activate, channels.close, channels.reveal]) {
      assert.deepEqual(await f.invoke(channel, input), { ok: false });
    }
  }
  assert.equal((await f.state()).documents.length, 1);
  assert.equal(f.revealed.length, 0);
  assert.equal(f.dialogs.length, 0);
});

test("only the main owner's exact opaque URL and isolated session can attach a guest", async (t) => {
  const f = fixture(t);
  await f.controller.open(f.file("安全.html"));
  const document = (await f.state()).documents[0];
  const preview = f.sessions.get(document.partition);
  for (const [url, partition, ownerId] of [
    [document.url, document.partition, 999],
    [document.url, "persist:desktop-sso", f.owner.id],
    [document.url + "?arbitrary=1", document.partition, f.owner.id],
    [new URL("other.html", document.url).href, document.partition, f.owner.id],
    ["https://example.test", document.partition, f.owner.id],
  ]) assert.equal(f.controller.canAttach(url, partition, ownerId), false);
  assert.equal(f.controller.canAttach(document.url, document.partition, f.owner.id), false, "unbound documents cannot attach");
  await f.bind(document);
  assert.equal(f.controller.canAttach(`${document.url}#section`, document.partition, f.owner.id), true);
  const unowned = guest(previewSession("other").session, f.owner);
  assert.equal(f.controller.configureGuest(unowned), false);
  const wrongOwner = guest(preview.session, mainContents(999));
  assert.equal(f.controller.configureGuest(wrongOwner), true);
  assert.deepEqual(wrongOwner.closes, [{ waitForBeforeUnload: false }]);
  const wrongType = guest(preview.session, f.owner, 202);
  wrongType.getType = () => "window";
  assert.equal(f.controller.configureGuest(wrongType), true);
  assert.equal(wrongType.destroyed, true);
  const valid = guest(preview.session, f.owner);
  assert.equal(f.controller.configureGuest(valid), true);
  assert.deepEqual(valid.windowOpen({ url: "https://example.test" }), { action: "deny" });
  assert.equal(f.controller.canAttach(document.url, document.partition, f.owner.id), false);
  const duplicate = guest(preview.session, f.owner, 203);
  assert.equal(f.controller.configureGuest(duplicate), true);
  assert.equal(duplicate.destroyed, true);
  for (const name of ["will-navigate", "will-redirect"]) {
    for (const [url, blocked] of [[document.url, false], [`${document.url}#section`, false], ["https://example.test", true]]) {
      const input = event(); valid.emit(name, input, url); assert.equal(input.defaultPrevented, blocked);
    }
  }
  for (const name of ["will-attach-webview", "will-prevent-unload"]) {
    const input = event(); valid.emit(name, input); assert.equal(input.defaultPrevented, true);
  }
});

test("HTML bytes wait for network protection and replacement guests need their own ready barrier", async t => {
  const guards = [];
  const f = fixture(t, { guardGuest: () => {
    const ready = deferred(); guards.push(ready);
    return { ready: ready.promise, dispose() {} };
  } });
  const original = f.file("guarded.html", "<h1>Local preview</h1>");
  await f.controller.open(original);
  const document = (await f.state()).documents[0];
  const preview = f.sessions.get(document.partition);
  await f.bind(document);
  const firstGuest = guest(preview.session, f.owner);
  f.controller.configureGuest(firstGuest);
  let delivered = false;
  const pending = preview.request(document.url).then(response => { delivered = true; return response; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(delivered, false);
  guards[0].resolve();
  assert.equal(await (await pending).text(), fs.readFileSync(original, "utf8"));
  firstGuest.close({ waitForBeforeUnload: false });
  f.controller.configureGuest(guest(preview.session, f.owner, 201));
  delivered = false;
  const replacement = preview.request(document.url).then(response => { delivered = true; return response; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(delivered, false, "the old guest's protection does not authorize a new guest");
  guards[1].resolve();
  assert.equal((await replacement).status, 200);
});

for (const failure of ["guard", "close"]) {
  test(`HTML waiting for protection is not delivered after ${failure}`, async t => {
    const ready = deferred();
    const f = fixture(t, { guardGuest: () => ({ ready: ready.promise, dispose() {} }) });
    await f.controller.open(f.file("guarded.html", "private original bytes"));
    const document = (await f.state()).documents[0];
    const preview = f.sessions.get(document.partition);
    await f.bind(document);
    f.controller.configureGuest(guest(preview.session, f.owner));
    const pending = preview.request(document.url);
    if (failure === "guard") ready.reject(Error("protection unavailable"));
    else await f.invoke(channels.close, document.documentId);
    const response = await pending;
    assert.equal(response.ok, false);
    assert.doesNotMatch(await response.text(), /private original bytes/u);
  });
}

test("preview protocols keep HTML and local assets intact while denying network, escaping paths and permissions", async (t) => {
  const f = fixture(t);
  const filePath = f.file("目录 空格%# 页面.html", '<!doctype html><meta http-equiv="Content-Security-Policy" content="script-src \'self\'"><h1>页面</h1>');
  f.file("style.css", "body { color: green; }");
  await f.controller.open(filePath);
  const document = (await f.state()).documents[0];
  const preview = f.sessions.get(document.partition);
  await f.bind(document);
  f.controller.configureGuest(guest(preview.session, f.owner));
  const response = await preview.request(document.url);
  assert.equal(await response.text(), fs.readFileSync(filePath, "utf8"));
  assert.equal(response.headers.get("x-original-file"), "true");
  assert.match(response.headers.get("content-security-policy"), /connect-src/);
  assert.equal(response.headers.get("x-dns-prefetch-control"), "off");
  const css = await preview.request(new URL("style.css", document.url).href);
  assert.equal(css.headers.get("content-type"), "text/css");
  assert.equal(await css.text(), "body { color: green; }");
  assert.equal(await (await preview.request(document.url, "HEAD")).text(), "");
  assert.equal((await preview.request(document.url, "POST")).status, 403);
  const outside = path.join(path.dirname(f.root), `${path.basename(f.root)}-secret`);
  fs.writeFileSync(outside, "private");
  t.after(() => fs.rmSync(outside, { force: true }));
  fs.symlinkSync(outside, path.join(f.root, "escape.css"));
  for (const url of [new URL("escape.css", document.url).href,
    new URL("%2e%2e%2fprivate", document.url).href,
    document.url.replace(new URL(document.url).hostname, "other")]) {
    assert.equal((await preview.request(url)).status, 404);
  }
  assert.equal((await preview.request(document.url.replace("://", "://username@"))).status, 403);
  for (const [url, resourceType, cancel] of [
    [document.url, "mainFrame", false], [`${document.url}#part`, "mainFrame", false],
    [new URL("style.css", document.url).href, "stylesheet", false],
    ["data:image/png;base64,AA==", "image", false], ["data:text/html,bypass", "mainFrame", true],
    ["https://example.test/beacon", "xhr", true], ["http://example.test", "script", true],
    ["wss://example.test", "webSocket", true], ["file:///etc/passwd", "image", true],
  ]) preview.state.beforeRequest({ url, resourceType }, (result) => assert.equal(result.cancel, cancel, url));
  assert.equal(preview.state.permissionCheck(), false);
  assert.equal(preview.state.devicePermission(), false);
  preview.state.permissionRequest(null, "camera", (allowed) => assert.equal(allowed, false));
  const download = event(); preview.session.emit("will-download", download); assert.equal(download.defaultPrevented, true);
});

test("Markdown refresh cancels the previous parse and closing cancels pending work then revokes the session", async (t) => {
  const parses = [];
  const f = fixture(t, { renderMarkdown: (bytes, fileName, signal) => new Promise((resolve, reject) => {
    parses.push({ bytes, fileName, signal, resolve });
    signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
  }) });
  await f.controller.open(f.file("中文.md", "# 中文正文"));
  const document = (await f.state()).documents[0];
  const preview = f.sessions.get(document.partition);
  const waitForParses = async (count) => {
    for (let attempt = 0; attempt < 200 && parses.length < count; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(parses.length, count);
  };
  const first = preview.request(document.url); await waitForParses(1);
  const second = preview.request(document.url); await waitForParses(2);
  assert.equal(parses[0].signal.aborted, true);
  assert.equal((await first).status, 410);
  assert.equal(parses[1].bytes.toString("utf8"), "# 中文正文");
  assert.equal(parses[1].fileName, "中文.md");
  parses[1].resolve("<h1>中文正文</h1>");
  const rendered = await second;
  assert.equal(rendered.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(rendered.headers.get("content-security-policy"), /default-src 'none'/u);
  assert.equal(await rendered.text(), "<h1>中文正文</h1>");
  const third = preview.request(document.url); await waitForParses(3);
  assert.deepEqual(await f.invoke(channels.close, document.documentId), { ok: true });
  assert.equal(parses[2].signal.aborted, true);
  assert.equal((await third).status, 410);
  assert.equal((await preview.request(document.url)).status, 403);
  assert.equal(preview.state.unhandled, 1);
  assert.equal(preview.state.cleared, 1);
  assert.equal(preview.state.cacheCleared, 1);
  assert.equal(preview.state.connectionsClosed, 1);
  assert.equal((await f.state()).documents.length, 0);
  assert.equal((await f.state()).activeDocumentId, null);
});

test("closing the active tab selects its neighbour and forces only that guest closed", async (t) => {
  const f = fixture(t);
  for (const name of ["a.html", "b.html", "c.html"]) await f.controller.open(f.file(name));
  const [first, middle, last] = (await f.state()).documents;
  await f.bind(middle);
  const middleGuest = guest(f.sessions.get(middle.partition).session, f.owner);
  assert.equal(f.controller.configureGuest(middleGuest), true);
  await f.invoke(channels.activate, middle.documentId);
  assert.deepEqual(await f.invoke(channels.close, middle.documentId), { ok: true });
  assert.deepEqual(middleGuest.closes, [{ waitForBeforeUnload: false }]);
  assert.equal((await f.state()).activeDocumentId, last.documentId);
  assert.equal(f.sessions.get(first.partition).state.unhandled, 0);
  assert.equal(f.sessions.get(last.partition).state.unhandled, 0);
  await f.invoke(channels.close, last.documentId);
  assert.equal((await f.state()).activeDocumentId, first.documentId);
  assert.deepEqual(await f.invoke(channels.close, middle.documentId), { ok: false });
});

test("top-level renderer reload rotates preview authority while same-document and subframe navigation keep guests alive", async (t) => {
  const f = fixture(t);
  await f.controller.open(f.file("retained.html"));
  const original = (await f.state()).documents[0];
  const preview = f.sessions.get(original.partition);
  await f.bind(original);
  const originalGuest = guest(preview.session, f.owner);
  assert.equal(f.controller.configureGuest(originalGuest), true);
  f.owner.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
  f.owner.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
  assert.deepEqual((await f.state()).documents[0], original);
  assert.equal(originalGuest.destroyed, false);
  f.owner.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  const refreshed = (await f.state()).documents[0];
  assert.equal(refreshed.documentId, original.documentId);
  assert.notEqual(refreshed.partition, original.partition);
  assert.notEqual(refreshed.url, original.url);
  assert.equal(originalGuest.destroyed, true);
  assert.equal(preview.state.unhandled, 1);
  assert.equal(f.controller.canAttach(original.url, original.partition, f.owner.id), false);
  assert.equal(f.controller.canAttach(refreshed.url, refreshed.partition, f.owner.id), false, "reload clears the previous binding");
  await f.bind(refreshed, "renderer-2");
  assert.equal(f.controller.canAttach(refreshed.url, refreshed.partition, f.owner.id), true);
  f.owner.destroy();
  assert.equal(f.sessions.get(refreshed.partition).state.unhandled, 1);
  f.setWindow(mainContents(102));
  assert.deepEqual((await f.state()).documents, []);
});

for (const platform of ["darwin", "win32"]) test(`${platform} local document shortcuts target the actual guest and reveal stays in Main`, async (t) => {
  const f = fixture(t, { platform });
  const filePath = f.file("visible.html");
  await f.controller.open(filePath);
  const document = (await f.state()).documents[0];
  await f.bind(document);
  const contents = guest(f.sessions.get(document.partition).session, f.owner);
  assert.equal(f.controller.configureGuest(contents), true);
  const modifier = platform === "darwin" ? { meta: true, control: false } : { meta: false, control: true };
  const wrongModifier = platform === "darwin" ? { meta: false, control: true } : { meta: true, control: false };
  const rejected = event(); contents.emit("before-input-event", rejected, { type: "keyDown", key: "w", ...wrongModifier });
  assert.equal(rejected.defaultPrevented, false);
  const close = event(); contents.emit("before-input-event", close, { type: "keyDown", key: "w", ...modifier });
  assert.equal(close.defaultPrevented, true);
  assert.deepEqual(f.owner.messages.at(-1), { channel: "app.closeShortcut", payload: { guestId: contents.id } });
  const zoom = event(); contents.emit("before-input-event", zoom, { type: "keyDown", key: "+", shift: true, ...modifier });
  assert.equal(zoom.defaultPrevented, true);
  assert.deepEqual(f.owner.messages.at(-1), { channel: "app.workPanelBrowserShortcut", payload: { guestId: contents.id, command: "zoom-in" } });
  const reload = event(); contents.emit("before-input-event", reload, { type: "keyDown", key: "r", ...modifier });
  assert.equal(reload.defaultPrevented, true);
  assert.equal(contents.reloads, 1);
  assert.deepEqual(await f.invoke(channels.reveal, document.documentId), { ok: true });
  assert.deepEqual(f.revealed, [filePath]);
  fs.unlinkSync(filePath);
  assert.equal((await f.invoke(channels.reveal, document.documentId)).ok, false);
  assert.equal(f.revealed.length, 1);
});

test("failed files never create tabs and disposing during async open does not resurrect a session", async (t) => {
  const f = fixture(t);
  const large = f.file("large.md", "");
  fs.truncateSync(large, LOCAL_MARKDOWN_MAX_BYTES + 1);
  const directory = path.join(f.root, "directory.md"); fs.mkdirSync(directory);
  for (const invalid of [f.file("unsupported.txt"), path.join(f.root, "missing.md"), directory, large]) {
    await assert.rejects(f.controller.open(invalid));
  }
  assert.deepEqual((await f.state()).documents, []);
  assert.equal(f.sessions.size, 0);
  assert.equal(f.prepareCalls.length, 0, "invalid paths never prepare a Chat");
  const pending = f.controller.open(f.file("pending.html"));
  f.controller.dispose();
  await pending;
  assert.equal(f.sessions.size, 0);
  assert.equal(f.shown.length, 0);
  assert.equal(f.handlers.size, 0);
});

for (const platform of ["darwin", "win32"]) test(`${platform} native picker limits selectable extensions and cancellation leaves existing tabs intact`, async (t) => {
  const f = fixture(t, { platform });
  await f.controller.open(f.file("already-open.html"));
  const previous = await f.state();
  const result = await f.invoke(channels.select);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(await f.state(), previous);
  assert.equal(f.dialogs.length, 1);
  assert.equal(f.dialogs[0].ownerWindow.webContents, f.owner);
  assert.deepEqual(f.dialogs[0].options.properties, ["openFile", "multiSelections"]);
  assert.deepEqual(f.dialogs[0].options.filters, [{ name: "Markdown / HTML", extensions: ["md", "markdown", "html", "htm"] }]);
  assert.equal(typeof f.dialogs[0].options.title, "string");
  assert.equal(f.dialogs[0].options.title.length > 0, true);
});

test("picker opens native-selected paths through the same validation and continues after individual failures", async (t) => {
  const selected = [];
  let nextChat = 0;
  const f = fixture(t, {
    showFileDialog: async () => ({ canceled: false, filePaths: selected }),
    getEditingChat: async () => ({ agentKey: "xiaojun", chatId: `picker-chat-${++nextChat}` }),
  });
  const html = f.file("可读页面.htm");
  const markdown = f.file("说明文档.MARKDOWN", "# 有效 Markdown");
  selected.push(f.file("不支持.txt"), html, path.join(f.root, "已删除.md"), markdown, html);
  const result = await f.invoke(channels.select, { filePaths: [f.file("renderer-cannot-select.html")] });
  assert.equal(result.ok, false);
  assert.equal(typeof result.message, "string");
  assert.equal(result.message.includes(f.root), false);
  const state = await f.state();
  assert.deepEqual(state.documents.map((document) => document.fileName), ["可读页面.htm", "说明文档.MARKDOWN"]);
  assert.equal(state.activeDocumentId, state.documents[0].documentId);
  assert.equal(f.sessions.size, 2);
  assert.deepEqual(f.shown, [1, 1, 1].map(index => `/agent/xiaojun?chatId=picker-chat-${index}`));
  assert.equal(f.prepareCalls.length, 1, "repeated selections activate the existing file tab");
  assert.deepEqual(state.documents.map(document => document.ownerChatId), ["picker-chat-1", "picker-chat-1"]);
});

test("a failed local target after leaving the file conversation preserves earlier files and continues with later files", async t => {
  const selected = [];
  let nextChat = 0;
  const f = fixture(t, {
    showFileDialog: async () => ({ canceled: false, filePaths: selected }),
    getEditingChat: async () => {
      const index = ++nextChat;
      if (index === 2) throw new Error("private upstream error");
      return { agentKey: "xiaojun", chatId: `picker-chat-${index}` };
    },
  });
  const first = f.file("first.html");
  selected.push(first, first, f.file("last.html"));
  const originalStat = fs.promises.stat;
  let validations = 0;
  fs.promises.stat = async (...args) => {
    const stat = await originalStat(...args);
    if (args[0] === first && ++validations === 3) f.setActiveChat({agentKey: "xiaojun", chatId: "ordinary-chat"});
    return stat;
  };
  let result;
  try { result = await f.invoke(channels.select); }
  finally { fs.promises.stat = originalStat; }
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.message, /private upstream/u);
  const state = await f.state();
  assert.deepEqual(state.documents.map(document => document.fileName), ["first.html", "last.html"]);
  assert.deepEqual(state.documents.map(document => document.ownerChatId), ["picker-chat-1", "picker-chat-3"]);
  assert.equal(f.prepareCalls.length, 3);
  assert.equal(f.sessions.size, 2);
});

test("picker cancellation ignores supplied paths and picker failures return a controlled error", async (t) => {
  const selected = [];
  let fail = false;
  const f = fixture(t, { showFileDialog: async () => {
    if (fail) throw new Error("native failure /private/sensitive/path");
    return { canceled: true, filePaths: selected };
  } });
  selected.push(f.file("cancelled.html"));
  assert.deepEqual(await f.invoke(channels.select), { ok: true });
  assert.equal((await f.state()).documents.length, 0);
  fail = true;
  const result = await f.invoke(channels.select);
  assert.equal(result.ok, false);
  assert.equal(typeof result.message, "string");
  assert.equal(result.message.includes("/private"), false);
  assert.equal(f.sessions.size, 0);
  assert.equal(f.prepareCalls.length, 0, "cancelled pickers never prepare a Chat");
});

for (const invalidation of ["reload", "crash", "frame", "owner", "destroy", "dispose"]) {
  test(`a picker response arriving after renderer ${invalidation} cannot create a file tab`, async (t) => {
    const picker = deferred();
    const started = deferred();
    const f = fixture(t, { showFileDialog: async () => { started.resolve(); return picker.promise; } });
    const filePath = f.file("late.html");
    const selection = f.invoke(channels.select);
    await started.promise;
    if (invalidation === "reload") f.owner.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    if (invalidation === "crash") f.owner.emit("render-process-gone", {});
    if (invalidation === "frame") f.owner.mainFrame = {};
    if (invalidation === "owner") f.setWindow(mainContents(101));
    if (invalidation === "destroy") f.owner.destroy();
    if (invalidation === "dispose") f.controller.dispose();
    picker.resolve({ canceled: false, filePaths: [filePath] });
    assert.deepEqual(await selection, { ok: false });
    assert.equal(f.sessions.size, 0);
    assert.equal(f.shown.length, 0);
    if (invalidation !== "dispose") {
      if (invalidation === "destroy") f.setWindow(mainContents(102));
      assert.deepEqual((await f.state()).documents, []);
    }
  });
}

test("picker authority is rechecked after asynchronous file validation, before committing a new tab", async (t) => {
  const reachedStat = deferred();
  const releaseStat = deferred();
  let selectedPath;
  const f = fixture(t, { showFileDialog: async () => ({ canceled: false, filePaths: [selectedPath] }) });
  selectedPath = f.file("opening.html");
  const originalStat = fs.promises.stat;
  fs.promises.stat = async (...args) => {
    if (args[0] === selectedPath) { reachedStat.resolve(); await releaseStat.promise; }
    return originalStat(...args);
  };
  try {
    const selection = f.invoke(channels.select);
    await reachedStat.promise;
    f.owner.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    releaseStat.resolve();
    assert.deepEqual(await selection, { ok: false });
    assert.equal(f.sessions.size, 0);
    assert.equal(f.shown.length, 0);
    assert.deepEqual((await f.state()).documents, []);
  } finally { fs.promises.stat = originalStat; releaseStat.resolve(); }
});

async function waitUntil(check, description, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out: ${description}`);
}

test("concurrent files share one target and the repeated original activates its existing tab", async t => {
  const preparations = [];
  const f = fixture(t, { getEditingChat: () => {
    const preparation = deferred();
    preparations.push(preparation);
    return preparation.promise;
  } });
  const first = f.file("one.md", "# one");
  const second = f.file("two.html");
  const opening = Promise.all([f.controller.open(first), f.controller.open(second), f.controller.open(first)]);
  await waitUntil(() => preparations.length === 1, "the first authenticated Chat preparation");
  assert.equal(f.sessions.size, 0);
  assert.equal(f.prepareCalls.length, 1);
  preparations[0].resolve({ agentKey: "小君", chatId: "prepared Chat 1" });
  await opening;
  assert.equal(f.prepareCalls.length, 1);
  const state = await f.state();
  assert.equal(state.documents.length, 2);
  assert.ok(state.documents.every(item => item.agentKey === "小君" && item.version === 0));
  assert.deepEqual(state.documents.map(item => item.ownerChatId), ["prepared Chat 1", "prepared Chat 1"]);
  assert.equal(new Set(state.documents.map(item => item.partition)).size, 2);
  assert.deepEqual(f.shown, [1, 1, 1].map(index => `/agent/%E5%B0%8F%E5%90%9B?chatId=prepared+Chat+${index}`));
});

test("immediate concurrent different-file opens create one file Chat and preserve every independent preview", async t => {
  let nextChat = 0;
  const f = fixture(t, { getEditingChat: async () => ({ agentKey: "xiaojun", chatId: `immediate-${++nextChat}` }) });
  await Promise.all(Array.from({ length: 4 }, (_, index) => f.controller.open(f.file(`${index}.html`))));
  assert.equal(f.prepareCalls.length, 1);
  assert.equal((await f.state()).documents.length, 4);
  assert.equal(new Set((await f.state()).documents.map(document => document.ownerChatId)).size, 1);
});

test("a different original appends to the current trusted file Chat without replacing its existing document", async t => {
  let nextChat = 0;
  const f = fixture(t, { getEditingChat: async () => ({ agentKey: "xiaojun", chatId: `file-chat-${++nextChat}` }) });
  await f.controller.open(f.file("first.html"));
  const first = (await f.state()).documents[0];
  f.setActiveChat({ chatId: first.ownerChatId, agentKey: first.agentKey });
  await f.bind(first);
  await f.controller.open(f.file("second.md", "# second"));
  const documents = (await f.state()).documents;
  assert.equal(f.prepareCalls.length, 1);
  assert.deepEqual(documents[0], first);
  assert.equal(documents[1].ownerChatId, first.ownerChatId);
  assert.notEqual(documents[1].documentId, first.documentId);
  assert.notEqual(documents[1].partition, first.partition);
  assert.equal((await f.state()).activeDocumentId, documents[1].documentId);
  assert.equal(JSON.stringify(await f.state()).includes(f.root), false);
});

test("queued startup files wait for the real Main requested route before reusing an unbound file Chat", async t => {
  const reachedNavigation = deferred();
  const settleNavigation = deferred();
  let waits = 0;
  let nextChat = 0;
  const f = fixture(t, {
    settleRequestedRoute: false, isEditingChatActive: () => false,
    getEditingChat: async () => ({ agentKey: "xiaojun", chatId: `startup-${++nextChat}` }),
    waitForEditingChatRequested: async (chatId, agentKey) => {
      if (++waits === 1) { reachedNavigation.resolve(); await settleNavigation.promise; }
      f.setRequestedChat({ chatId, agentKey });
      return true;
    },
  });
  f.setRequestedChat(null);
  const opening = Promise.all([f.controller.open(f.file("startup-one.html")), f.controller.open(f.file("startup-two.md", "# two"))]);
  try {
    await reachedNavigation.promise;
    assert.equal(f.prepareCalls.length, 1);
    assert.equal((await f.state()).documents.length, 1, "the second selection waits for Main navigation");
    settleNavigation.resolve();
    await opening;
    const documents = (await f.state()).documents;
    assert.equal(documents.length, 2);
    assert.deepEqual(documents.map(document => document.ownerChatId), ["startup-1", "startup-1"]);
    assert.equal(f.prepareCalls.length, 1);
    assert.equal((await f.bind(documents[1])).ok, false, "requested-route proof does not bypass canonical binding");
  } finally { settleNavigation.resolve(); }
});

test("an unsettled requested route never authorizes reuse from the previous prepare result", async t => {
  let nextChat = 0;
  const f = fixture(t, {
    settleRequestedRoute: false, isEditingChatActive: () => false,
    getEditingChat: async () => ({ agentKey: "xiaojun", chatId: `unsettled-${++nextChat}` }),
    waitForEditingChatRequested: async () => false,
  });
  f.setRequestedChat(null);
  await Promise.all([f.controller.open(f.file("unsettled-one.html")), f.controller.open(f.file("unsettled-two.html"))]);
  assert.equal(f.prepareCalls.length, 2);
  assert.deepEqual((await f.state()).documents.map(document => document.ownerChatId), ["unsettled-1", "unsettled-2"]);
});

test("ordinary Chats and other agents do not receive a previously prepared file Chat's new documents", async t => {
  let nextChat = 0;
  const f = fixture(t, { getEditingChat: async () => ({ agentKey: "xiaojun", chatId: `isolated-${++nextChat}` }) });
  await f.controller.open(f.file("original-file-chat.html"));
  const first = (await f.state()).documents[0];
  f.setActiveChat({ agentKey: "xiaojun", chatId: "ordinary-chat" });
  await f.controller.open(f.file("from-ordinary-chat.html"));
  f.setActiveChat({ agentKey: "another-agent", chatId: first.ownerChatId });
  await f.controller.open(f.file("from-other-agent.md", "# another"));
  assert.equal(f.prepareCalls.length, 3);
  assert.deepEqual((await f.state()).documents.map(document => document.ownerChatId), ["isolated-1", "isolated-2", "isolated-3"]);
});

test("closing the last file removes that file Chat from reuse even when its Main route stays visible", async t => {
  let nextChat = 0;
  const f = fixture(t, { getEditingChat: async () => ({ agentKey: "xiaojun", chatId: `closed-${++nextChat}` }) });
  await f.controller.open(f.file("closed-first.html"));
  const first = (await f.state()).documents[0];
  f.setActiveChat({ agentKey: first.agentKey, chatId: first.ownerChatId });
  await f.invoke(channels.close, first.documentId);
  await f.controller.open(f.file("after-last-file.md", "# new owner"));
  assert.equal(f.prepareCalls.length, 2);
  assert.equal((await f.state()).documents[0].ownerChatId, "closed-2");
});

test("returning to an older trusted file Chat appends there independently of the last global open", async t => {
  let nextChat = 0;
  const f = fixture(t, { getEditingChat: async () => ({ agentKey: "xiaojun", chatId: `existing-${++nextChat}` }) });
  await f.controller.open(f.file("older.html"));
  const first = (await f.state()).documents[0];
  f.setActiveChat({ agentKey: "xiaojun", chatId: "ordinary-chat" });
  await f.controller.open(f.file("newer.html"));
  f.setActiveChat({ agentKey: first.agentKey, chatId: first.ownerChatId });
  await f.controller.open(f.file("append-to-older.md", "# append"));
  assert.equal(f.prepareCalls.length, 2);
  assert.deepEqual((await f.state()).documents.map(document => document.ownerChatId), ["existing-1", "existing-2", "existing-1"]);
});

test("a requested fresh file Chat takes precedence over the previous still-registered active Chat", async t => {
  let nextChat = 0;
  let staleActive = false;
  const f = fixture(t, {
    getEditingChat: async () => ({ agentKey: "xiaojun", chatId: `requested-${++nextChat}` }),
    isEditingChatActive: chatId => staleActive && chatId === "requested-1",
  });
  const original = f.file("repeated-original.html");
  await f.controller.open(original);
  const first = (await f.state()).documents[0];
  f.setActiveChat({ agentKey: first.agentKey, chatId: first.ownerChatId });
  f.setRequestedChat({agentKey: "xiaojun", chatId: "ordinary-chat"});
  await f.controller.open(f.file("newly-requested.html"));
  staleActive = true;
  await f.controller.open(f.file("after-fresh-request.html"));
  assert.equal(f.prepareCalls.length, 2);
  assert.deepEqual((await f.state()).documents.map(document => document.ownerChatId), ["requested-1", "requested-2", "requested-2"]);
});

for (const invalidation of ["ordinary-chat", "agent", "close"]) {
  test(`a reusable file Chat is rechecked after filesystem validation: ${invalidation}`, async t => {
    let nextChat = 0;
    const f = fixture(t, { getEditingChat: async () => ({ agentKey: "xiaojun", chatId: `revalidated-${++nextChat}` }) });
    await f.controller.open(f.file("existing-original.html"));
    const first = (await f.state()).documents[0];
    f.setActiveChat({ agentKey: first.agentKey, chatId: first.ownerChatId });
    const incoming = f.file("incoming.html");
    const originalStat = fs.promises.stat;
    let validations = 0;
    fs.promises.stat = async (...args) => {
      const stat = await originalStat(...args);
      if (args[0] === incoming && ++validations === 2) {
        if (invalidation === "ordinary-chat") f.setActiveChat({ agentKey: "xiaojun", chatId: "ordinary-chat" });
        if (invalidation === "agent") f.setActiveChat({ agentKey: "another-agent", chatId: first.ownerChatId });
        if (invalidation === "close") await f.invoke(channels.close, first.documentId);
      }
      return stat;
    };
    try {
      await f.controller.open(incoming);
      assert.equal(f.prepareCalls.length, 2);
      assert.equal((await f.state()).documents.at(-1).ownerChatId, "revalidated-2");
    } finally { fs.promises.stat = originalStat; }
  });
}

test("a renderer reload cancels already-queued opens without preparing another Chat", async t => {
  const preparing = deferred();
  const reachedPreparation = deferred();
  const f = fixture(t, { getEditingChat: () => { reachedPreparation.resolve(); return preparing.promise; } });
  await f.state();
  const opening = Promise.all([f.controller.open(f.file("queued-one.html")), f.controller.open(f.file("queued-two.html"))]);
  await reachedPreparation.promise;
  f.owner.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  preparing.resolve({ agentKey: "xiaojun", chatId: "cancelled-file-chat" });
  await opening;
  assert.equal(f.prepareCalls.length, 1);
  assert.equal((await f.state()).documents.length, 0);
  assert.equal(f.sessions.size, 0);
});

test("the same original appends to a different current file conversation and its earlier preview keeps its owner", async t => {
  const f = fixture(t);
  const original = f.file("original.html");
  await f.controller.open(original);
  const first = (await f.state()).documents[0];
  const otherChat = { agentKey: "xiaojun", chatId: "another-chat" };
  f.setPreparedChat(otherChat);
  f.setActiveChat(otherChat);
  await f.controller.open(f.file("other.html"));
  const alias = path.join(f.root, "alias.html");
  fs.symlinkSync(original, alias);
  await f.controller.open(alias);
  assert.equal(f.prepareCalls.length, 2);
  assert.equal((await f.state()).documents[0].ownerChatId, first.ownerChatId);
  const reopened = (await f.state()).documents[2];
  assert.equal(reopened.ownerChatId, otherChat.chatId);
  assert.notEqual(reopened.documentId, first.documentId);
  assert.notEqual(reopened.partition, first.partition);
  assert.equal((await f.state()).activeDocumentId, reopened.documentId);
  assert.equal(f.shown.at(-1), "/agent/xiaojun?chatId=another-chat");
  await f.invoke(channels.activate, first.documentId);
  assert.equal((await f.state()).activeDocumentId, first.documentId);
  assert.equal(f.shown.at(-1), editingRoute);
  assert.equal(f.prepareCalls.length, 2);
});

test("Chat-bound documents reject cross-Chat bindings while existing background guests survive", async t => {
  const f = fixture(t);
  await f.controller.open(f.file("owned.html"));
  const document = (await f.state()).documents[0];
  assert.deepEqual(await f.invoke(channels.bind, { documentId: document.documentId, ownerChatId: "other-chat", rendererGeneration: "renderer-1" }), { ok: false });
  for (const generation of ["", "  ", null, 1, "x".repeat(513)]) {
    assert.deepEqual(await f.bind(document, generation), { ok: false });
  }
  assert.deepEqual(await f.bind(document), { ok: true, document });
  const contents = guest(f.sessions.get(document.partition).session, f.owner);
  assert.equal(f.controller.configureGuest(contents), true);
  f.setActiveChat({ agentKey: "xiaojun", chatId: "other-chat" });
  assert.deepEqual(await f.bind(document, "other-renderer"), { ok: false });
  assert.equal(f.controller.canAttach(document.url, document.partition, f.owner.id), false);
  assert.equal(f.controller.configureGuest(contents), true);
  assert.equal(contents.destroyed, false);
  f.setActiveChat({ agentKey: document.agentKey, chatId: document.ownerChatId });
  assert.deepEqual(await f.bind(document), { ok: true, document });
});

test("local previews no longer expose the retired path-prompt IPC", t => {
  const f = fixture(t);
  assert.equal(Object.hasOwn(channels, "editingContext"), false);
  assert.equal(f.handlers.has("localDocuments.editingContext"), false);
});

test("only the trusted main frame can bind files", async t => {
  const f = fixture(t);
  await f.controller.open(f.file("private.md", "# private"));
  const document = (await f.state()).documents[0];
  await f.bind(document);
  const other = mainContents(101);
  for (const ipcEvent of [
    { sender: other, senderFrame: other.mainFrame },
    { sender: mainContents(f.owner.id), senderFrame: f.owner.mainFrame },
    { sender: f.owner, senderFrame: {} },
  ]) {
    assert.deepEqual(await f.invoke(channels.bind, { ...document, rendererGeneration: "forged" }, ipcEvent), { ok: false });
  }
});

test("exact-file watchers publish version changes and survive reload, then unregister their own listener on close", async t => {
  const f = fixture(t, { watchFile() {}, unwatchFile() {} });
  const filePath = f.file("watched.html");
  await f.controller.open(filePath);
  let document = (await f.state()).documents[0];
  assert.equal(f.watches.length, 1);
  const watch = f.watches[0];
  assert.equal(watch.filePath, filePath);
  assert.deepEqual(watch.options, { interval: 750, persistent: false });
  const baseline = fs.statSync(filePath);
  const stat = changes => ({ ...baseline, isFile: () => true, ...changes });
  watch.listener(baseline, baseline);
  assert.equal((await f.state()).documents[0].version, 0);
  watch.listener(stat({ mtimeMs: baseline.mtimeMs + 1 }), baseline);
  assert.equal((await f.state()).documents[0].version, 1);
  watch.listener(stat({ ino: baseline.ino + 1 }), baseline);
  assert.equal((await f.state()).documents[0].version, 2);
  watch.listener(stat({ nlink: 0, size: 0, ino: 0, isFile: () => false }), baseline);
  assert.equal((await f.state()).documents[0].version, 3);
  watch.listener(baseline, baseline);
  assert.equal((await f.state()).documents[0].version, 4);
  await f.bind(document);
  f.owner.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  document = (await f.state()).documents[0];
  assert.equal(document.version, 4);
  assert.equal(f.watches.length, 1);
  assert.equal(f.unwatches.length, 0);
  await f.invoke(channels.close, document.documentId);
  assert.deepEqual(f.unwatches, [{ filePath, listener: watch.listener }]);
  const previousRevision = (await f.state()).revision;
  watch.listener(stat({ size: 999 }), baseline);
  assert.equal((await f.state()).revision, previousRevision, "a queued callback cannot revive a closed file");
});

test("real single-file polling detects atomic replacement, deletion and recreation", async t => {
  const f = fixture(t);
  const filePath = f.file("atomic.html", "before");
  await f.controller.open(filePath);
  const original = (await f.state()).documents[0];
  const version = async () => (await f.state()).documents[0].version;
  const replacement = f.file("replacement.tmp", "after atomic save");
  fs.renameSync(replacement, filePath);
  await waitUntil(async () => await version() > original.version, "atomic replacement");
  const replacedVersion = await version();
  fs.unlinkSync(filePath);
  await waitUntil(async () => await version() > replacedVersion, "file deletion");
  const deletedVersion = await version();
  fs.writeFileSync(filePath, "recreated");
  await waitUntil(async () => await version() > deletedVersion, "file recreation");
  f.controller.dispose();
  assert.equal(f.unwatches.length, 1);
  assert.equal(f.unwatches[0].listener, f.watches[0].listener);
});

for (const invalidation of ["reload", "crash", "frame", "owner", "destroy", "dispose"]) {
  test(`a prepared Chat arriving after renderer ${invalidation} cannot resurrect an open`, async t => {
    const preparation = deferred();
    const started = deferred();
    const f = fixture(t, { getEditingChat: async () => { started.resolve(); return preparation.promise; } });
    await f.state();
    const opening = f.controller.open(f.file("late-chat.html"));
    await started.promise;
    if (invalidation === "reload") f.owner.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    if (invalidation === "crash") f.owner.emit("render-process-gone", {});
    if (invalidation === "frame") f.owner.mainFrame = {};
    if (invalidation === "owner") f.setWindow(mainContents(101));
    if (invalidation === "destroy") f.owner.destroy();
    if (invalidation === "dispose") f.controller.dispose();
    preparation.resolve({ agentKey: "xiaojun", chatId: "late-chat" });
    await opening;
    assert.equal(f.sessions.size, 0);
    assert.equal(f.watches.length, 0);
    assert.equal(f.shown.length, 0);
  });
}

test("failed Chat preparation creates no preview and a later open can retry", async t => {
  let failing = true;
  const f = fixture(t, { getEditingChat: async () => {
    if (failing) throw new Error("upstream private detail");
    return { agentKey: "xiaojun", chatId: "editing-chat" };
  } });
  const filePath = f.file("retry.html");
  await assert.rejects(f.controller.open(filePath), error => !error.message.includes("private detail"));
  assert.equal(f.sessions.size, 0);
  failing = false;
  await f.controller.open(filePath);
  assert.equal(f.prepareCalls.length, 2);
  assert.equal((await f.state()).documents.length, 1);
});

test("opening the same file again activates its retained document without creating another target", async t => {
  const f = fixture(t, { watchFile() {}, unwatchFile() {} });
  assert.equal((await f.state()).openRevision, 0);
  const filePath = f.file("intent.html");
  await f.controller.open(filePath);
  const first = await f.state();
  assert.equal(first.openRevision, 1);
  assert.equal(first.revision, 1);
  const document = first.documents[0];
  await f.controller.open(filePath);
  const repeated = await f.state();
  assert.equal(repeated.openRevision, 2);
  assert.equal(repeated.revision, 2);
  assert.equal(repeated.activeDocumentId, document.documentId);
  assert.equal(repeated.documents.length, 1);
  assert.deepEqual(repeated.documents[0], document);
  assert.equal(f.prepareCalls.length, 1);
  await f.invoke(channels.activate, document.documentId);
  assert.equal(f.prepareCalls.length, 1);
  assert.equal((await f.state()).openRevision, 3);
  assert.equal((await f.state()).revision, 3);
  await f.bind(document);
  assert.equal((await f.state()).revision, 3, "binding does not invent an open intent");
  const baseline = fs.statSync(filePath);
  f.watches[0].listener({ ...baseline, mtimeMs: baseline.mtimeMs + 1, isFile: () => true }, baseline);
  const changed = await f.state();
  assert.equal(changed.openRevision, 3);
  assert.equal(changed.revision, 4);
  assert.equal(changed.documents[0].version, 1);
  f.owner.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  const reloaded = await f.state();
  assert.equal(reloaded.openRevision, 3);
  assert.equal(reloaded.revision, 5);
  assert.equal(reloaded.documents[0].version, 1);
  await f.bind(reloaded.documents[0], "renderer-2");
  assert.equal((await f.state()).openRevision, 3);
  assert.equal((await f.state()).revision, 5);
  await f.invoke(channels.close, document.documentId);
  assert.equal((await f.state()).openRevision, 3);
});

test("a background file watcher updates its version without changing the active file or opening intent", async t => {
  const f = fixture(t, { watchFile() {}, unwatchFile() {} });
  const backgroundFile = f.file("background.html");
  await f.controller.open(backgroundFile);
  await f.controller.open(f.file("foreground.html"));
  const previous = await f.state();
  const baseline = fs.statSync(backgroundFile);
  f.watches[0].listener({ ...baseline, size: baseline.size + 1, isFile: () => true }, baseline);
  const updated = await f.state();
  assert.equal(updated.openRevision, previous.openRevision);
  assert.equal(updated.activeDocumentId, previous.activeDocumentId);
  assert.equal(updated.revision, previous.revision + 1);
  assert.equal(updated.documents[0].version, previous.documents[0].version + 1);
  await f.controller.open(backgroundFile);
  assert.equal((await f.state()).openRevision, previous.openRevision + 1);
  assert.equal((await f.state()).activeDocumentId, (await f.state()).documents[0].documentId);
  assert.equal((await f.state()).documents.length, 2);
  assert.deepEqual((await f.state()).documents[0], updated.documents[0]);
});

test("closing one same-source document releases only its session and watcher while the other keeps observing the original", async t => {
  let nextChat = 0;
  const f = fixture(t, {
    getEditingChat: async () => ({ agentKey: "xiaojun", chatId: `same-source-${++nextChat}` }),
    watchFile() {}, unwatchFile() {},
  });
  const filePath = f.file("shared-original.html", "Original content");
  await f.controller.open(filePath);
  f.setActiveChat({agentKey: "xiaojun", chatId: "ordinary-before-other-preview"});
  await f.controller.open(filePath);
  const [first, second] = (await f.state()).documents;
  assert.notEqual(first.ownerChatId, second.ownerChatId);
  assert.equal(f.watches.length, 2);
  assert.ok(f.watches.every(watch => watch.filePath === filePath));
  await f.invoke(channels.close, first.documentId);
  assert.deepEqual(f.unwatches, [{ filePath, listener: f.watches[0].listener }]);
  assert.equal(f.sessions.get(first.partition).state.unhandled, 1);
  assert.equal(f.sessions.get(second.partition).state.unhandled, 0);
  const baseline = fs.statSync(filePath);
  const changed = { ...baseline, size: baseline.size + 1, isFile: () => true };
  f.watches[0].listener(changed, baseline);
  f.watches[1].listener(changed, baseline);
  const state = await f.state();
  assert.equal(state.documents.length, 1);
  assert.equal(state.documents[0].documentId, second.documentId);
  assert.equal(state.documents[0].version, 1);
  assert.equal(fs.readFileSync(filePath, "utf8"), "Original content");
  assert.deepEqual(fs.readdirSync(f.root), ["shared-original.html"], "independent Chats never create file copies");
});

test("a valid binding permits a new background guest while rebinding still requires the active Chat", async t => {
  const f = fixture(t);
  await f.controller.open(f.file("background-mounted.html"));
  const document = (await f.state()).documents[0];
  await f.bind(document);
  f.setActiveChat({ agentKey: "xiaojun", chatId: "another-chat" });
  assert.equal(f.controller.canAttach(document.url, document.partition, f.owner.id), true);
  assert.equal((await f.bind(document, "renderer-2")).ok, false);
  const contents = guest(f.sessions.get(document.partition).session, f.owner);
  assert.equal(f.controller.configureGuest(contents), true);
  assert.equal(contents.destroyed, false);
  contents.close({ waitForBeforeUnload: false });
  assert.equal(f.controller.canAttach(document.url, document.partition, f.owner.id), true, "a background remount retains the valid binding");
  f.owner.mainFrame = {};
  assert.equal(f.controller.canAttach(document.url, document.partition, f.owner.id), false, "a replaced frame cannot reuse the binding");
  const staleContents = guest(f.sessions.get(document.partition).session, f.owner, 201);
  assert.equal(f.controller.configureGuest(staleContents), true);
  assert.equal(staleContents.destroyed, true);
});

test("active-file lookup returns exact selected metadata without reading bodies or exposing paths through IPC", async t => {
  const f = fixture(t);
  const original = f.file('页面 "原件".HTML', "PRIVATE_HTML_BODY");
  const markdown = f.file("中文 说明.md", "# PRIVATE_MARKDOWN_BODY");
  const alias = path.join(f.root, "链接页面.HTML");
  fs.symlinkSync(original, alias);
  await f.controller.open(alias);
  await f.controller.open(markdown);
  const documents = (await f.state()).documents;
  for (const document of documents) await f.bind(document);
  const previousMessages = f.owner.messages.length;
  const originalReadFile = fs.promises.readFile;
  const originalOpen = fs.promises.open;
  fs.promises.readFile = async () => { throw new Error("active-file lookup must not read file bodies"); };
  fs.promises.open = async () => { throw new Error("active-file lookup must not open file contents"); };
  const originalRealpath = fs.promises.realpath;
  const lookedUpPaths = [];
  fs.promises.realpath = async (...args) => { lookedUpPaths.push(args[0]); return originalRealpath(...args); };
  const resolved = [];
  try {
    resolved.push(await f.controller.resolveActiveFile(activeFileRequest(documents[0]), async () => true));
    assert.deepEqual(lookedUpPaths, [original, original], "only the selected document is validated, even when another file was opened last");
    resolved.push(await f.controller.resolveActiveFile(activeFileRequest(documents[1]), async () => true));
  } finally {
    fs.promises.readFile = originalReadFile; fs.promises.open = originalOpen; fs.promises.realpath = originalRealpath;
  }
  assert.deepEqual(resolved, documents.map((document, index) => ({
    fileName: document.fileName, kind: document.kind,
    path: index === 0 ? original : markdown,
    mimeType: index === 0 ? "text/html" : "text/markdown",
    sizeBytes: fs.statSync(index === 0 ? original : markdown).size,
  })));
  assert.doesNotMatch(JSON.stringify(resolved), /PRIVATE_HTML_BODY|PRIVATE_MARKDOWN_BODY/u);
  assert.ok(resolved.every(file => !Object.hasOwn(file, "url") && !Object.hasOwn(file, "text") && !Object.hasOwn(file, "documentId")));
  assert.equal(f.owner.messages.length, previousMessages);
  assert.equal(JSON.stringify(await f.state()).includes(f.root), false);
  assert.equal([...f.handlers.keys()].some(channel => /resolveActiveFile/iu.test(channel)), false);
  assert.deepEqual(fs.readdirSync(f.root).sort(), [path.basename(alias), path.basename(original), path.basename(markdown)].sort());
});

test("active-file lookup requires an exact bound document and trusted matching Chat and agent", async t => {
  const f = fixture(t);
  await f.controller.open(f.file("owned.md", "# document"));
  const document = (await f.state()).documents[0];
  const request = activeFileRequest(document);
  for (const invalid of [
    { ...request, chatId: "another-chat" }, { ...request, agentKey: "another-agent" },
    { ...request, chatId: "" }, { ...request, agentKey: "" },
    { ...request, documentId: "" }, { ...request, documentId: "unknown-document" },
  ]) await assert.rejects(f.controller.resolveActiveFile(invalid), error => !error.message.includes(f.root));
  await assert.rejects(f.controller.resolveActiveFile(request), "unbound files must not become model context");
  await f.bind(document);
  assert.equal((await f.controller.resolveActiveFile(request)).fileName, document.fileName);
  f.setActiveChat({ agentKey: "xiaojun", chatId: "another-chat" });
  assert.equal((await f.controller.resolveActiveFile(request)).fileName, document.fileName,
    "a trusted Run can still resolve its own Chat's bound document in the background");
  f.setActiveChat({ chatId: document.ownerChatId, agentKey: document.agentKey });
  f.owner.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  await assert.rejects(f.controller.resolveActiveFile(request), "renderer reload revokes the previous binding");
  await f.bind((await f.state()).documents[0], "renderer-2");
  assert.equal((await f.controller.resolveActiveFile(request)).fileName, document.fileName);
});

test("same original opened in different Chats is resolved only through the exact owner binding", async t => {
  let nextChat = 0;
  const f = fixture(t, { getEditingChat: async () => ({ agentKey: "xiaojun", chatId: `owner-${++nextChat}` }) });
  const original = f.file("shared.html", "unchanged");
  await f.controller.open(original);
  f.setActiveChat({agentKey: "xiaojun", chatId: "ordinary-before-other-preview"});
  await f.controller.open(original);
  for (const document of (await f.state()).documents) {
    const request = activeFileRequest(document);
    f.setActiveChat(request);
    await f.bind(document);
    assert.equal((await f.controller.resolveActiveFile(request)).path, original);
    const anotherOwner = (await f.state()).documents.find(item => item.documentId !== document.documentId);
    await assert.rejects(f.controller.resolveActiveFile({ ...request, chatId: anotherOwner.ownerChatId }));
  }
});

test("closing an explicitly selected document cannot fall back to another file in the same Chat", async t => {
  const f = fixture(t);
  await f.controller.open(f.file("closed-before-query.html"));
  const document = (await f.state()).documents[0];
  await f.bind(document);
  await f.controller.open(f.file("remaining.html"));
  const remaining = (await f.state()).documents[1];
  await f.bind(remaining);
  await f.invoke(channels.close, document.documentId);
  await assert.rejects(f.controller.resolveActiveFile(activeFileRequest(document)));
  assert.equal((await f.controller.resolveActiveFile(activeFileRequest(remaining))).fileName, remaining.fileName);
});

for (const invalidation of ["reload", "crash", "frame", "owner", "binding", "close", "destroy", "dispose"]) {
  test(`active-file lookup fails closed if authority changes during filesystem validation: ${invalidation}`, async t => {
    const reachedStat = deferred();
    const releaseStat = deferred();
    const f = fixture(t);
    const original = f.file("pending-reference.html");
    await f.controller.open(original);
    const document = (await f.state()).documents[0];
    await f.bind(document);
    const originalStat = fs.promises.stat;
    fs.promises.stat = async (...args) => {
      if (args[0] === original) { reachedStat.resolve(); await releaseStat.promise; }
      return originalStat(...args);
    };
    try {
      const lookup = f.controller.resolveActiveFile(activeFileRequest(document));
      const rejected = assert.rejects(lookup, error => !error.message.includes(f.root));
      await reachedStat.promise;
      if (invalidation === "reload") f.owner.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      if (invalidation === "crash") f.owner.emit("render-process-gone", {});
      if (invalidation === "frame") f.owner.mainFrame = {};
      if (invalidation === "owner") f.setWindow(mainContents(101));
      if (invalidation === "binding") await f.bind(document, "renderer-2");
      if (invalidation === "close") await f.invoke(channels.close, document.documentId);
      if (invalidation === "destroy") f.owner.destroy();
      if (invalidation === "dispose") f.controller.dispose();
      releaseStat.resolve();
      await rejected;
    } finally { fs.promises.stat = originalStat; releaseStat.resolve(); }
  });
}

test("changing the globally visible Chat during validation preserves only the original Run Chat's selection", async t => {
  const f = fixture(t);
  const original = f.file("background-run.html");
  await f.controller.open(original);
  const document = (await f.state()).documents[0];
  await f.bind(document);
  const originalStat = fs.promises.stat;
  fs.promises.stat = async (...args) => {
    const stat = await originalStat(...args);
    f.setActiveChat({ agentKey: "xiaojun", chatId: "another-chat" });
    return stat;
  };
  let selectionChecks = 0;
  try {
    const file = await f.controller.resolveActiveFile(activeFileRequest(document), async () => { selectionChecks += 1; return true; });
    assert.equal(file.path, original);
    assert.equal(selectionChecks, 1);
  } finally { fs.promises.stat = originalStat; }
});

for (const invalidation of ["reload", "crash", "frame", "owner", "binding", "close", "destroy", "dispose"]) {
  test(`active-file lookup rechecks authority after the selection callback: ${invalidation}`, async t => {
    const f = fixture(t);
    await f.controller.open(f.file("callback-pending.html"));
    const document = (await f.state()).documents[0];
    await f.bind(document);
    const reachedSelection = deferred();
    const releaseSelection = deferred();
    const lookup = f.controller.resolveActiveFile(activeFileRequest(document), async () => {
      reachedSelection.resolve(); await releaseSelection.promise; return true;
    });
    const rejected = assert.rejects(lookup, error => !error.message.includes(f.root));
    try {
      await reachedSelection.promise;
      if (invalidation === "reload") f.owner.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      if (invalidation === "crash") f.owner.emit("render-process-gone", {});
      if (invalidation === "frame") f.owner.mainFrame = {};
      if (invalidation === "owner") f.setWindow(mainContents(101));
      if (invalidation === "binding") await f.bind(document, "renderer-2");
      if (invalidation === "close") await f.invoke(channels.close, document.documentId);
      if (invalidation === "destroy") f.owner.destroy();
      if (invalidation === "dispose") f.controller.dispose();
      releaseSelection.resolve();
      await rejected;
    } finally { releaseSelection.resolve(); }
  });
}

test("a changed active tab or failed selection check rejects the captured file without trying another document", async t => {
  const f = fixture(t);
  await f.controller.open(f.file("first.html"));
  await f.controller.open(f.file("second.html"));
  const [first, second] = (await f.state()).documents;
  await f.bind(first); await f.bind(second);
  for (const check of [async () => false, async () => { throw new Error(`selection failure: ${f.root}`); }]) {
    await assert.rejects(f.controller.resolveActiveFile(activeFileRequest(first), check), error => !error.message.includes(f.root));
  }
  assert.equal((await f.controller.resolveActiveFile(activeFileRequest(second), async () => true)).fileName, second.fileName);
});

for (const replacement of ["missing", "symlink", "directory"]) {
  test(`active-file lookup rejects a selected path that becomes ${replacement} after stat`, async t => {
    const f = fixture(t);
    const original = f.file("replaced.html");
    const other = f.file("other.html");
    await f.controller.open(original);
    const document = (await f.state()).documents[0];
    await f.bind(document);
    const originalStat = fs.promises.stat;
    fs.promises.stat = async (...args) => {
      const stat = await originalStat(...args);
      if (args[0] === original) {
        fs.unlinkSync(original);
        if (replacement === "symlink") fs.symlinkSync(other, original);
        if (replacement === "directory") fs.mkdirSync(original);
      }
      return stat;
    };
    try {
      await assert.rejects(f.controller.resolveActiveFile(activeFileRequest(document)), error => !error.message.includes(f.root));
    } finally { fs.promises.stat = originalStat; }
  });
}

test("active-file lookup uses current stat after an ordinary atomic save without requiring a stale preview revision", async t => {
  const f = fixture(t, { watchFile() {}, unwatchFile() {} });
  const original = f.file("latest.md", "# old");
  await f.controller.open(original);
  const document = (await f.state()).documents[0];
  await f.bind(document);
  const replacement = f.file("save.tmp", "# Latest content with a different size");
  fs.renameSync(replacement, original);
  assert.equal((await f.state()).documents[0].version, 0, "watch notification has not fired yet");
  const file = await f.controller.resolveActiveFile(activeFileRequest(document));
  assert.equal(file.path, original);
  assert.equal(file.sizeBytes, fs.statSync(original).size);
});

test("active-file lookup rejects an inode replacement between filesystem checks", async t => {
  const f = fixture(t, { watchFile() {}, unwatchFile() {} });
  const original = f.file("replaced-during-lookup.html");
  await f.controller.open(original);
  const document = (await f.state()).documents[0];
  await f.bind(document);
  const replacement = f.file("replacement.tmp", "a different original file");
  const originalStat = fs.promises.stat;
  let replaced = false;
  fs.promises.stat = async (...args) => {
    const stat = await originalStat(...args);
    if (args[0] === original && !replaced) { replaced = true; fs.renameSync(replacement, original); }
    return stat;
  };
  let selectionChecks = 0;
  try {
    await assert.rejects(f.controller.resolveActiveFile(activeFileRequest(document), async () => { selectionChecks += 1; return true; }));
    assert.equal(selectionChecks, 0, "a stale file identity must fail before rechecking the tab");
  } finally { fs.promises.stat = originalStat; }
});

for (const platform of ["darwin", "win32"]) {
  test(`active-file lookup applies the explicit ${platform} path-case policy`, async t => {
    const f = fixture(t, { platform });
    const original = f.file("MixedCase.html");
    await f.controller.open(original);
    const document = (await f.state()).documents[0];
    await f.bind(document);
    const canonicalWithChangedCase = original.toUpperCase();
    const originalRealpath = fs.promises.realpath;
    const originalStat = fs.promises.stat;
    fs.promises.realpath = async (...args) => args[0] === original ? canonicalWithChangedCase : originalRealpath(...args);
    fs.promises.stat = async (...args) => originalStat(args[0] === canonicalWithChangedCase ? original : args[0], ...args.slice(1));
    try {
      const lookup = f.controller.resolveActiveFile(activeFileRequest(document));
      if (platform === "win32") assert.equal((await lookup).path, canonicalWithChangedCase);
      else await assert.rejects(lookup);
    } finally { fs.promises.realpath = originalRealpath; fs.promises.stat = originalStat; }
  });
}
