import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const compiled = (relative) => require(process.env.LOCAL_DOCUMENT_TEST_BUILD_ROOT
  ? path.join(process.env.LOCAL_DOCUMENT_TEST_BUILD_ROOT, relative)
  : `../dist-electron/${relative}`);
const { EMPTY_WORK_PANEL_STATE, reduceWorkPanelCommand } = compiled("shared/work-panel.js");
const { CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL } = compiled("shared/chat-work-panel.js");
const { isRegisteredWorkPanelNativeSurface } = compiled("shared/work-panel-native-registry.js");
const { AGENT_WEBCLIENT_BRIDGE_VERSION } = compiled("shared/contracts/agent-webclient-bridge.js");
const { createWorkpanelInvoke } = compiled("main/modules/agent-platform/frame-port/workpanel-invoke.js");

const documentId = "40f0cf13-4dc6-4e8f-b0fc-d564796cd091";
const previewId = "a1cfbb92-9ab7-46f3-a5eb-9346bc5c80cd";
const otherPreviewId = "ae3869ae-c7ad-4c34-a7e0-256a346a462a";
const ownerChatId = "editing-chat";
const previewUrl = (id, name = "说明 % #.md") => `${CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL}://${id}/${encodeURIComponent(name)}`;
function document(overrides = {}) {
  return {
    documentId, fileName: "说明 % #.md", kind: "markdown",
    url: previewUrl(previewId), partition: `local-document-${previewId}`,
    ownerChatId, agentKey: "xiaojun", version: 0,
    ...overrides,
  };
}
function descriptor(context = document(), overrides = {}) {
  return { kind: "native", surfaceKey: "local-document", context, ...overrides };
}
function open(context = document(), state = EMPTY_WORK_PANEL_STATE, owner = ownerChatId, overrides = {}) {
  return reduceWorkPanelCommand(state, { type: "openItem", ownerChatId: owner, descriptor: descriptor(context, overrides) });
}

test("trusted Main local-document DTOs become closable native tabs using their document identity and filename", () => {
  assert.equal(isRegisteredWorkPanelNativeSurface("local-document"), true);
  for (const [kind, fileName] of [["markdown", "说明.MARKDOWN"], ["html", "原件.HTML"], ["html", "页面.htm"]]) {
    const context = document({ kind, fileName, url: previewUrl(previewId, fileName) });
    const result = open(context, EMPTY_WORK_PANEL_STATE, ownerChatId, { title: "unrelated title" });
    assert.equal(result.ok, true);
    assert.equal(result.item.stableKey, `local-document:${documentId}`);
    assert.equal(result.item.title, fileName);
    assert.equal(result.item.descriptor.title, fileName);
    assert.deepEqual(result.item.descriptor.context, context);
    assert.equal(result.item.closable, true);
    assert.equal(result.item.pinned, false);
    assert.equal(result.state.ownerChatId, ownerChatId);
  }
});

test("same-document version changes and renewed previews update the existing WorkPanel tab", () => {
  const first = open();
  const changed = document({ version: 3, url: previewUrl(otherPreviewId), partition: `local-document-${otherPreviewId}` });
  const updated = open(changed, first.nextState);
  assert.equal(updated.ok, true);
  assert.equal(updated.state.items.length, 1);
  assert.equal(updated.item.itemId, first.item.itemId);
  assert.equal(updated.item.createdAt, first.item.createdAt);
  assert.equal(updated.item.stableKey, first.item.stableKey);
  assert.deepEqual(updated.item.descriptor.context, changed);
  assert.equal(first.item.descriptor.context.version, 0, "reducer does not mutate the earlier snapshot");
});

test("a local document cannot be inserted into another Chat workspace", () => {
  const first = open();
  const other = open(document(), first.nextState, "other-chat");
  assert.equal(other.ok, false);
  assert.equal(other.error.code, "capability_denied");
  assert.equal(other.nextState, first.nextState);
  assert.equal(other.nextState.workspaces.length, 1);
});

test("native local documents accept only the exact bounded Main DTO fields", () => {
  const valid = document();
  for (const missing of Object.keys(valid)) {
    const context = { ...valid }; delete context[missing];
    assert.equal(open(context).ok, false, `missing ${missing}`);
  }
  for (const key of ["filePath", "absolutePath", "relativePath", "token", "preload", "source", "rendererGeneration"]) {
    assert.equal(open({ ...valid, [key]: "/private/untrusted" }).ok, false, `extra ${key}`);
  }
  for (const patch of [
    { documentId: "/private/original.md" }, { documentId: "not-a-uuid" },
    { fileName: "/private/original.md" }, { fileName: "nested/original.md" },
    { fileName: "C:\\private\\original.md" }, { fileName: "\\\\server\\private\\original.md" },
    { fileName: "bad\0.md" }, { fileName: "x".repeat(513) + ".md" },
    { fileName: "report.txt" }, { kind: "html" }, { kind: "text" },
    { ownerChatId: "/private/chat" }, { ownerChatId: "editing-chat\nforged" },
    { agentKey: "https://user:secret@example.test/" }, { agentKey: "" },
    { version: -1 }, { version: 1.5 }, { version: NaN }, { version: Infinity },
    { version: Number.MAX_SAFE_INTEGER + 1 }, { version: "1" },
  ]) assert.equal(open({ ...valid, ...patch }).ok, false, JSON.stringify(patch));
  assert.equal(open(valid, EMPTY_WORK_PANEL_STATE, ownerChatId, { url: "file:///private/original.md" }).ok, false);
});

test("preview descriptors reject external origins, credentials, paths, traversal and mismatched partitions", () => {
  const root = `${CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL}://${previewId}`;
  for (const url of [
    "file:///private/original.md", "https://example.test/original.md", "javascript:alert(1)",
    `other-local-file://${previewId}/original.md`,
    `${CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL}://user:secret@${previewId}/original.md`,
    `${root}:3000/original.md`, `${root}/original.md?token=secret`, `${root}/original.md#part`,
    `${root}//private/original.md`, `${root}/directory/original.md`, `${root}/%2Fprivate%2Foriginal.md`,
    `${root}/%2e%2e`, `${root}/%2e%2e%2foriginal.md`, `${root}/%00.md`, `${root}/%zz.md`,
    `${root}/C%3A%5Cprivate%5Coriginal.md`, previewUrl(otherPreviewId),
    `${root}/unencoded space.md`, "",
  ]) assert.equal(open(document({ url })).ok, false, url);
  for (const partition of ["persist:desktop-sso", `persist:local-document-${previewId}`, "local-document-not-a-uuid", `local-document-${otherPreviewId}`, ""]) {
    assert.equal(open(document({ partition })).ok, false, partition);
  }
});

test("selected symlink names and encoded Chinese, spaces and control characters remain path-free metadata", () => {
  const context = document({
    fileName: " 别名 %\n说明.MD",
    url: previewUrl(previewId, "原件 % #\n源码.txt"),
  });
  const result = open(context);
  assert.equal(result.ok, true);
  assert.equal(result.item.title, context.fileName);
  assert.deepEqual(result.item.descriptor.context, context);
  assert.equal(decodeURIComponent(new URL(result.item.descriptor.context.url).pathname), "/原件 % #\n源码.txt");
});

test("public WorkPanel bridges reject even a valid native local-document descriptor from trusted WebClient guests", async () => {
  for (const [surfaceType, surfaceRole, surfaceLevel] of [
    ["agent-chat", "main-chat", "root"],
    ["agent-copilot", "copilot-dock", "root"],
    ["agent-overview", "overview", "child"],
    ["agent-management", "file", "child"],
  ]) {
    const currentUrl = "http://127.0.0.1:7079/agent/xiaojun?chatId=editing-chat";
    const target = { surfaceType, surfaceRole, surfaceLevel, serviceId: "agent-webclient", webContentsId: 7, ownerChatId, currentUrl };
    const sender = { id: 7, isDestroyed: () => false, getType: () => "webview", getURL: () => currentUrl };
    const dispatched = [];
    const { handleWorkPanelInvoke } = createWorkpanelInvoke({ options: {
      browserSurfaces: { resolveWebviewSurfaceTarget: id => id === sender.id ? target : undefined },
      isTrustedAgentWebclientSession: () => true,
      normalizeWorkPanelOpenLocalResourceRequest: () => null,
      openResource: async () => { throw Error("unexpected native resource open"); },
      openDocument: async () => { throw Error("unexpected native document open"); },
      dispatchWorkPanel: async command => { dispatched.push(command); return { ok: true, workspaceId: "workspace" }; },
    } });
    const native = await handleWorkPanelInvoke({ sender }, {
      method: "openItem", input: { version: AGENT_WEBCLIENT_BRIDGE_VERSION, descriptor: descriptor() },
    });
    assert.equal(native.ok, false, surfaceType);
    assert.equal(native.error.code, "capability_denied", surfaceType);
    assert.equal(dispatched.length, 0, surfaceType);
    const web = await handleWorkPanelInvoke({ sender }, {
      method: "openItem", input: { version: AGENT_WEBCLIENT_BRIDGE_VERSION, descriptor: { kind: "web", url: "https://example.test/" } },
    });
    assert.equal(web.ok, true, "the fixture represents an authorized WorkPanel caller");
    assert.equal(dispatched.length, 1);
  }
});

const readRenderer = (name) => fs.readFileSync(path.join(process.cwd(), "src/renderer/work-panel", name), "utf8");

test("local file previews omit the host toolbar while web previews keep it", () => {
  const localDocument = readRenderer("WorkPanelLocalDocument.tsx");
  const host = readRenderer("WorkPanelHost.tsx");
  assert.match(localDocument, /showToolbar=\{false\}/u);
  assert.doesNotMatch(localDocument, /onRevealDocument|toolbarDocumentName|revealFailed/u);
  assert.match(host, /showToolbar=\{item\.descriptor\.kind === "web"\}/u);
  assert.match(host, /isLocalDocumentDraftOwnerKey\(workspace\.ownerChatId\)\s*&&\s*!\(item\.descriptor\.kind === "native"\s*&&\s*item\.descriptor\.surfaceKey === "local-document"\)/u);
});

function localFileMenuHarness(owner, item) {
  const host = readRenderer("WorkPanelHost.tsx");
  const profile = host.slice(host.indexOf("function tabContextMenuProfile("), host.indexOf("function workPanelDocumentPath("));
  const start = host.indexOf("  const handleTabContextMenu = async (");
  const handler = host.slice(start, host.indexOf("\n  useEffect(", start));
  const { transpileModule, ScriptTarget } = require("typescript");
  const script = transpileModule(profile + handler, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
  const calls = { menus: [], revealed: [], reloads: [], errors: [], actions: [] };
  const stateRef = { current: {
    workspaces: [{ ownerChatId: owner, items: [item] }],
    review: { activeItemIdsByOwnerChatId: {} },
  } };
  let failReveal = false;
  let closeDuringMenu = false;
  const reveal = async (request) => {
    calls.revealed.push(request);
    return failReveal ? { ok: false, message: "reveal failed" } : { ok: true };
  };
  const invoke = vm.runInNewContext(script + "\nhandleTabContextMenu;", {
    window: { electronAPI: {
      chatWorkPanelTabContextMenu: { popup: async (request) => {
        calls.menus.push(request);
        if (closeDuringMenu) stateRef.current.workspaces = [];
        return { actionId: calls.actions.shift() };
      } },
      localDocuments: { reveal },
      chatWorkPanel: { localFiles: { reveal } },
    } },
    stateRef,
    resourceReviewCapabilities: {},
    nativeHtmlControllers: { current: new Map() },
    rendererGenerationRef: { current: "renderer-generation" },
    fullscreenOwnerChatId: null,
    itemRuntimeKey: (chatId, itemId) => `${chatId}:${itemId}`,
    reviewSourceForItem: () => null,
    workPanelDocumentPath: () => "",
    getWorkPanelReviewSession: () => null,
    findItemWebview: (chatId, itemId) => ({ reload: () => calls.reloads.push({ chatId, itemId }) }),
    modal: { error: (error) => calls.errors.push(error) },
    t: (key) => key,
  });
  return {
    calls,
    run: (action) => {
      calls.actions.push(action);
      return invoke({ preventDefault() {}, stopPropagation() {}, clientX: 10, clientY: 20 }, owner, item);
    },
    failReveal: () => { failReveal = true; },
    closeDuringMenu: () => { closeDuringMenu = true; },
  };
}

test("local document menus refresh the selected guest and reveal by opaque identity even before the first Chat", async () => {
  for (const owner of [ownerChatId, "file-draft:xiaojun:1700000000000"]) {
    const item = { itemId: "document-tab", stableKey: `local-document:${documentId}`, closable: true, pinned: false, descriptor: descriptor() };
    const harness = localFileMenuHarness(owner, item);
    await harness.run("reload");
    await harness.run("reveal-resource");
    assert.equal(harness.calls.menus[0].profile, "local-file");
    assert.deepEqual(harness.calls.reloads, [{ chatId: owner, itemId: item.itemId }]);
    assert.deepEqual(harness.calls.revealed, [documentId], "draft grouping keys never reach the file API");
    assert.equal(harness.calls.errors.length, 0);
    harness.failReveal();
    await harness.run("reveal-resource");
    assert.equal(harness.calls.errors[0].content, "reveal failed");
    harness.closeDuringMenu();
    await harness.run("reveal-resource");
    assert.equal(harness.calls.revealed.length, 2, "a closed tab cannot trigger a late file action");
  }
});

test("workspace local-file menus retain owner and generation-bound reveal requests", async () => {
  const item = { itemId: "local-file-tab", stableKey: "local-file:opaque-handle", closable: true, pinned: false,
    descriptor: { kind: "local-file", handleId: "opaque-handle", fileName: "report.html", previewKind: "html" } };
  const harness = localFileMenuHarness(ownerChatId, item);
  await harness.run("reload");
  await harness.run("reveal-resource");
  assert.equal(harness.calls.menus[0].profile, "local-file");
  assert.equal(harness.calls.reloads.length, 1);
  assert.equal(harness.calls.revealed[0].ownerChatId, ownerChatId);
  assert.equal(harness.calls.revealed[0].rendererGeneration, "renderer-generation");
  assert.equal(harness.calls.revealed[0].handleId, "opaque-handle");
  assert.deepEqual(Object.keys(harness.calls.revealed[0]).sort(), ["handleId", "ownerChatId", "rendererGeneration"]);
});
