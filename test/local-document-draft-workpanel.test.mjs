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
const { EMPTY_WORK_PANEL_STATE, reduceWorkPanelCommand, localDocumentOwnerKey, CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL } = module.exports;

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

test("draft grouping never becomes a WebClient Chat route or another WorkPanel capability", () => {
  const opened = open(EMPTY_WORK_PANEL_STATE, draft());
  const ownerChatId = opened.state.ownerChatId;
  for (const descriptor of [
    { kind: "web", url: "https://example.test" },
    { kind: "webclient", module: "overview", route: `/overview/${ownerChatId}`, context: { chatId: ownerChatId, agentKey: "main" } },
    { kind: "local-file", handleId: "other", fileName: "other.md", previewKind: "text" },
    { kind: "native", surfaceKey: "resource-image", context: {} },
  ]) {
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
