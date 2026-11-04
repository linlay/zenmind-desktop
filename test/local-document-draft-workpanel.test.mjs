import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { loadBrandConfig, resolveBrandId, runtimeBrandPayload } from "../scripts/lib/brand-config.mjs";

const require = createRequire(import.meta.url);
const built = await build({
  stdin: { resolveDir: process.cwd(), loader: "ts", contents: `
    export * from './src/shared/work-panel';
    export * from './src/shared/local-document';
    export { CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL } from './src/shared/chat-work-panel';
  ` }, bundle: true, platform: "node", format: "cjs", write: false,
  define: { __DESKTOP_APP_BRAND__: JSON.stringify(runtimeBrandPayload(loadBrandConfig(process.cwd(), resolveBrandId()))) },
});
const module = { exports: {} };
new Function("module", "exports", "require", built.outputFiles[0].text)(module, module.exports, require);
const { EMPTY_WORK_PANEL_STATE, reduceWorkPanelCommand, isDraftWorkPanelDescriptor, localDocumentOwnerKey, CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL } = module.exports;

function draft(index = 1, newChat = "1791600000001") {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return { documentId: id, fileName: `文件${index}.html`, kind: "html", agentKey: "main", ownerChatId: "", newChat,
    url: `${CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL}://${id}/${encodeURIComponent(`文件${index}.html`)}`, partition: `local-document-${id}`, version: 0 };
}
const open = (state, document, owner = localDocumentOwnerKey(document)) => reduceWorkPanelCommand(state,
  { type: "openItem", ownerChatId: owner, descriptor: { kind: "native", surfaceKey: "local-document", context: document } });
const canonical = ({ newChat, ...document }, ownerChatId = "real-chat") => ({ ...document, ownerChatId });

test("draft native file tabs accept only an empty backend owner plus the exact 13-digit nonce", () => {
  const document = draft(); const key = localDocumentOwnerKey(document);
  const opened = open(EMPTY_WORK_PANEL_STATE, document);
  assert.equal(opened.ok, true); assert.equal(opened.state.ownerChatId, key);
  assert.equal(opened.item.descriptor.context.ownerChatId, "");
  for (const patch of [
    { newChat: undefined }, { newChat: "" }, { newChat: "123" }, { newChat: "0791600000001" },
    { ownerChatId: "real-chat" }, { ownerChatId: key }, { ownerChatId: "real-chat", newChat: undefined },
  ]) assert.equal(open(EMPTY_WORK_PANEL_STATE, { ...document, ...patch }, key).ok, false, JSON.stringify(patch));
  assert.equal(open(EMPTY_WORK_PANEL_STATE, document, localDocumentOwnerKey(draft(2, "1791600000002"))).ok, false);
  assert.equal(open(EMPTY_WORK_PANEL_STATE, canonical(document), key).ok, false);
});

const safeDescriptors = [
  { kind: "web", url: "https://example.test/" },
  { kind: "webclient", module: "skill", route: "/skill-viewer/example", context: { id: "example" } },
  { kind: "webclient", module: "file", route: "/file-viewer", context: { agentKey: "main", path: "notes.md" } },
  { kind: "webclient", module: "reference", route: "/resource/main?chatId=upload-chat&file=report.docx", context: { agentKey: "main", chatId: "upload-chat", referenceId: "ref-1", relativePath: "report.docx" } },
];
const nativeHtml = (sourceKind = "workspace-file") => ({ kind: "native", surfaceKey: "document-html", context: {
  handleId: "html-handle", sourceKind, stableIdentity: "html:main:index.html",
  displayUrl: sourceKind === "workspace-file" ? "@workspace/index.html" : "@chat/index.html",
  fileName: "index.html", mimeType: "text/html", sizeBytes: 1, revision: "r1", localOriginal: true,
} });

test("draft grouping never becomes a WebClient Chat route or another WorkPanel capability", () => {
  const opened = open(EMPTY_WORK_PANEL_STATE, draft());
  const ownerChatId = opened.state.ownerChatId;
  for (const descriptor of [
    { kind: "webclient", module: "overview", route: `/overview/${ownerChatId}`, context: { chatId: ownerChatId, agentKey: "main" } },
    ...["overview", "debug", "btw", "source", "project", "file-diff", "artifact", "reference", "view", "planning", "agent", "copilot"].map(module =>
      ({ kind: "webclient", module, route: "/viewer", context: { agentKey: "main" } })),
    ...[ownerChatId, "real-chat"].map(chatId => ({ ...safeDescriptors[2], context: { ...safeDescriptors[2].context, chatId } })),
    ...["runId", "artifactId", "referenceId", "planningId", "publishId", "sourceId", "btwId", "instanceId"].map(key =>
      ({ ...safeDescriptors[2], context: { ...safeDescriptors[2].context, [key]: "chat-dependent" } })),
    { ...safeDescriptors[1], context: { id: "example", chatId: ownerChatId } },
    { kind: "webapp-ref", webappId: "app", title: "App" },
    nativeHtml(), nativeHtml("artifact"), nativeHtml("reference"),
    { kind: "local-file", handleId: "other", fileName: "other.md", previewKind: "text" },
    { kind: "native", surfaceKey: "resource-image", context: {} },
  ]) {
    assert.equal(isDraftWorkPanelDescriptor(descriptor), false, JSON.stringify(descriptor));
    const denied = reduceWorkPanelCommand(opened.nextState, { type: "openItem", ownerChatId, descriptor });
    assert.equal(denied.ok, false); assert.equal(denied.nextState, opened.nextState);
  }
  const hidden = reduceWorkPanelCommand(opened.nextState, { type: "hideWorkspace", ownerChatId });
  const shown = reduceWorkPanelCommand(hidden.nextState, { type: "showWorkspace", ownerChatId });
  assert.equal(shown.state.items.length, 1); assert.equal(shown.state.items[0].descriptor.kind, "native");
});

test("adopt atomically preserves file parents and merges a canonical Overview without closing native tabs", () => {
  const first = draft(1); const second = draft(2);
  const one = open(EMPTY_WORK_PANEL_STATE, first); const two = open(one.nextState, second);
  const overview = reduceWorkPanelCommand(two.nextState, { type: "openItem", ownerChatId: "real-chat",
    descriptor: { kind: "webclient", module: "overview", route: "/overview/real-chat", context: { chatId: "real-chat", agentKey: "main" } } });
  const adopted = reduceWorkPanelCommand(overview.nextState, { type: "adoptLocalDocumentWorkspace", ownerChatId: "real-chat",
    draftOwnerKey: two.state.ownerChatId, documents: [canonical(first), canonical(second)] });
  assert.equal(adopted.ok, true); assert.equal(adopted.nextState.workspaces.length, 1);
  assert.equal(adopted.workspaceId, two.workspaceId); assert.equal(adopted.state.activeItemId, two.state.activeItemId);
  assert.equal(adopted.state.items[0], overview.item);
  const files = adopted.state.items.filter(item => item.descriptor.kind === "native");
  assert.deepEqual(files.map(item => item.itemId), two.state.items.map(item => item.itemId));
  assert.deepEqual(files.map(item => item.createdAt), two.state.items.map(item => item.createdAt));
  assert.deepEqual(files.map(item => item.descriptor.context.partition), two.state.items.map(item => item.descriptor.context.partition));
  assert.ok(files.every(item => item.descriptor.context.ownerChatId === "real-chat" && !Object.hasOwn(item.descriptor.context, "newChat")));
  assert.deepEqual(adopted.nextState.visibleOwnerChatIds, ["real-chat"]);
  const repeated = reduceWorkPanelCommand(adopted.nextState, { type: "adoptLocalDocumentWorkspace", ownerChatId: "real-chat",
    draftOwnerKey: two.state.ownerChatId, documents: [canonical(first), canonical(second)] });
  assert.equal(repeated.nextState, adopted.nextState);
});

test("adopt preserves a hidden draft and refuses partial or changed preview identities atomically", () => {
  const first = draft(1); const second = draft(2);
  const two = open(open(EMPTY_WORK_PANEL_STATE, first).nextState, second);
  const hidden = reduceWorkPanelCommand(two.nextState, { type: "hideWorkspace", ownerChatId: two.state.ownerChatId });
  for (const documents of [
    [canonical(first)],
    [canonical(first), canonical(second, "another-chat")],
    [canonical(first), { ...canonical(second), partition: draft(9).partition, url: draft(9).url }],
    [canonical(first), { ...canonical(second), newChat: second.newChat }],
  ]) {
    const denied = reduceWorkPanelCommand(hidden.nextState, { type: "adoptLocalDocumentWorkspace", ownerChatId: "real-chat",
      draftOwnerKey: two.state.ownerChatId, documents });
    assert.equal(denied.ok, false); assert.equal(denied.nextState, hidden.nextState);
  }
  const adopted = reduceWorkPanelCommand(hidden.nextState, { type: "adoptLocalDocumentWorkspace", ownerChatId: "real-chat",
    draftOwnerKey: two.state.ownerChatId, documents: [canonical(first), canonical(second)] });
  assert.deepEqual(adopted.nextState.visibleOwnerChatIds, []); assert.equal(adopted.state.activeItemId, two.state.activeItemId);
});

test("draft previews accept only safe descriptors and never inject a backend Chat", () => {
  const ownerChatId = localDocumentOwnerKey({ ...draft(), agentKey: "agent:中文" });
  let state = EMPTY_WORK_PANEL_STATE;
  for (const descriptor of safeDescriptors) {
    assert.equal(isDraftWorkPanelDescriptor(descriptor), true);
    const opened = reduceWorkPanelCommand(state, { type: "openItem", ownerChatId, descriptor });
    assert.equal(opened.ok, true);
    assert.deepEqual(opened.item.descriptor.context, descriptor.context);
    if (descriptor.kind === "web") assert.equal(opened.item.descriptor.url, descriptor.url);
    state = opened.nextState;
    assert.equal(reduceWorkPanelCommand(state, { type: "openItem", ownerChatId: "file-draft:bad:123", descriptor }).ok, false);
  }
  assert.equal(isDraftWorkPanelDescriptor({ kind: "native", surfaceKey: "local-document", context: draft() }), true);
  const web = state.workspaces[0].items[0];
  const denied = reduceWorkPanelCommand(state, { type: "startReview", ownerChatId, itemId: web.itemId,
    kind: "html", source: { sourceKind: "web", url: web.descriptor.url, fileName: "Web", revision: web.descriptor.url } });
  assert.equal(denied.ok, false); assert.equal(denied.nextState, state);
  assert.deepEqual(state.review, EMPTY_WORK_PANEL_STATE.review);
});

test("native HTML claims cannot enter or migrate from drafts, including workspace files", () => {
  for (const sourceKind of ["workspace-file", "artifact", "reference"]) {
    const descriptor = nativeHtml(sourceKind);
    const canonicalPanel = reduceWorkPanelCommand(EMPTY_WORK_PANEL_STATE, { type: "openItem", ownerChatId: "real-chat", descriptor });
    assert.equal(canonicalPanel.ok, true, "fixture is a valid canonical native HTML descriptor");
    const ownerChatId = localDocumentOwnerKey(draft());
    const state = { ...canonicalPanel.nextState, workspaces: [{ ...canonicalPanel.state, ownerChatId }] };
    for (const type of ["adoptDraftWorkspace", "adoptLocalDocumentWorkspace"]) {
      const denied = reduceWorkPanelCommand(state, { type, draftOwnerKey: ownerChatId, ownerChatId: "real-chat", documents: [] });
      assert.equal(denied.ok, false); assert.equal(denied.nextState, state);
    }
  }
});

for (const hidden of [false, true]) for (const explicitlyOpened of [false, true]) {
  test(`safe draft adoption retains tabs and panel intent: hidden=${hidden}, explicit=${explicitlyOpened}`, () => {
    const draftOwnerKey = localDocumentOwnerKey(draft());
    let state = EMPTY_WORK_PANEL_STATE;
    for (const descriptor of safeDescriptors) {
      state = reduceWorkPanelCommand(state, { type: "openItem", ownerChatId: draftOwnerKey, descriptor, explicitlyOpened }).nextState;
    }
    if (hidden) state = reduceWorkPanelCommand(state, { type: "hideWorkspace", ownerChatId: draftOwnerKey }).nextState;
    const original = state.workspaces[0];
    for (const ownerChatId of ["", draftOwnerKey]) {
      const denied = reduceWorkPanelCommand(state, { type: "adoptDraftWorkspace", draftOwnerKey, ownerChatId });
      assert.equal(denied.ok, false); assert.equal(denied.nextState, state);
    }
    const adopted = reduceWorkPanelCommand(state, { type: "adoptDraftWorkspace", draftOwnerKey, ownerChatId: "real-chat" });
    assert.equal(adopted.ok, true);
    assert.equal(adopted.workspaceId, original.workspaceId);
    assert.equal(adopted.state.activeItemId, original.activeItemId);
    assert.deepEqual(adopted.state.items, original.items);
    adopted.state.items.forEach((item, index) => assert.equal(item, original.items[index]));
    assert.deepEqual(adopted.nextState.visibleOwnerChatIds, hidden ? [] : ["real-chat"]);
    assert.deepEqual(adopted.nextState.explicitlyOpenedOwnerChatIds, explicitlyOpened ? ["real-chat"] : []);
    assert.equal(adopted.nextState.review, state.review);
    const repeated = reduceWorkPanelCommand(adopted.nextState, { type: "adoptDraftWorkspace", draftOwnerKey, ownerChatId: "real-chat" });
    assert.equal(repeated.nextState, adopted.nextState);
  });
}

test("mixed drafts wait for trusted local document promotion and retain safe items unchanged", () => {
  const document = draft();
  const opened = open(EMPTY_WORK_PANEL_STATE, document);
  let state = opened.nextState;
  for (const descriptor of safeDescriptors) {
    state = reduceWorkPanelCommand(state, { type: "openItem", ownerChatId: opened.state.ownerChatId, descriptor }).nextState;
  }
  const denied = reduceWorkPanelCommand(state, { type: "adoptDraftWorkspace", draftOwnerKey: opened.state.ownerChatId, ownerChatId: "real-chat" });
  assert.equal(denied.ok, false); assert.equal(denied.nextState, state);
  const overview = reduceWorkPanelCommand(state, { type: "openItem", ownerChatId: "real-chat", explicitlyOpened: true,
    descriptor: { kind: "webclient", module: "overview", route: "/overview/real-chat", context: { chatId: "real-chat", agentKey: "main" } } });
  const adopted = reduceWorkPanelCommand(overview.nextState, { type: "adoptLocalDocumentWorkspace", draftOwnerKey: opened.state.ownerChatId,
    ownerChatId: "real-chat", documents: [canonical(document)] });
  assert.equal(adopted.ok, true);
  assert.equal(adopted.workspaceId, opened.workspaceId);
  assert.equal(adopted.state.activeItemId, state.workspaces[0].activeItemId);
  assert.equal(adopted.state.items[0], overview.item);
  state.workspaces[0].items.slice(1).forEach((item, index) => assert.equal(adopted.state.items[index + 2], item));
  assert.deepEqual(adopted.nextState.explicitlyOpenedOwnerChatIds, ["real-chat"]);
});

for (const draftExplicit of [false, true]) for (const canonicalExplicit of [false, true]) {
  test(`canonical file promotion retains panel opening intent: draft=${draftExplicit}, Chat=${canonicalExplicit}`, () => {
    const document = draft();
    const opened = open(EMPTY_WORK_PANEL_STATE, document);
    const restored = reduceWorkPanelCommand(opened.nextState, {
      type: "showWorkspace", ownerChatId: opened.state.ownerChatId, explicitlyOpened: draftExplicit,
    });
    const overview = (state, ownerChatId, explicitlyOpened) => reduceWorkPanelCommand(state, {
      type: "openItem", ownerChatId, explicitlyOpened,
      descriptor: { kind: "webclient", module: "overview", route: `/overview/${ownerChatId}`,
        context: { chatId: ownerChatId, agentKey: "main" } },
    });
    const canonicalPanel = overview(restored.nextState, "real-chat", canonicalExplicit);
    const unrelated = overview(canonicalPanel.nextState, "other-chat", true);
    const adopted = reduceWorkPanelCommand(unrelated.nextState, {
      type: "adoptLocalDocumentWorkspace", ownerChatId: "real-chat", draftOwnerKey: opened.state.ownerChatId,
      documents: [canonical(document)],
    });
    assert.equal(adopted.ok, true);
    assert.deepEqual(adopted.nextState.explicitlyOpenedOwnerChatIds,
      draftExplicit || canonicalExplicit ? ["other-chat", "real-chat"] : ["other-chat"]);
    const closed = reduceWorkPanelCommand(adopted.nextState, {
      type: "closeItem", ownerChatId: "real-chat", itemId: opened.item.itemId, closeImplicitWorkspace: true,
    });
    const remaining = closed.nextState.workspaces.find(workspace => workspace.ownerChatId === "real-chat");
    assert.equal(Boolean(remaining), draftExplicit || canonicalExplicit);
    if (remaining) assert.deepEqual(remaining.items, [canonicalPanel.item]);
    assert.ok(closed.nextState.workspaces.some(workspace => workspace.ownerChatId === "other-chat"));
  });
}
