import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
const require = createRequire(import.meta.url);
const { createWorkpanelInvoke } = require("../dist-electron/main/modules/agent-platform/frame-port/workpanel-invoke.js");
const { documentSourceFromWebclientDescriptor } = require("../dist-electron/shared/work-panel-document-source.js");

const source = { kind: "artifact", agentKey: "agent", chatId: "chat", resourceId: "artifact-1", relativePath: "artifacts/report.pptx" };
function harness() {
  let target = {
    registrationId: "generation-1", surfaceId: "document-1", webContentsId: 12, ownerWebContentsId: 1,
    serviceId: "agent-webclient", surfaceType: "agent-management", surfaceRole: "artifact", surfaceLevel: "child",
    ownerChatId: "chat", documentSource: source, active: true, currentUrl: "http://localhost:3000/resource-viewer/agent",
  };
  let url = target.currentUrl;
  let registered = true;
  const sender = Object.assign(new EventEmitter(), { id: 12, isDestroyed: () => false, getType: () => "webview", getURL: () => url });
  const calls = [];
  const local = {
    getOptions: async (document, stillOwned) => {
      calls.push({ document, stillOwned });
      return { ok: true, applications: [{ id: "app", name: "PowerPoint", isDefault: true }] };
    },
    openCopy: async (document, applicationId, stillOwned) => {
      calls.push({ document, applicationId, stillOwned });
      return { ok: true, status: "launch-requested" };
    },
  };
  const handler = createWorkpanelInvoke({ options: {
    browserSurfaces: {
      resolveWebviewSurfaceTarget: () => registered ? target : null,
      waitForWebviewSurfaceTargetMatching: async () => { registered = true; return target; },
    },
    isTrustedAgentWebclientSession: () => true,
    documentLocalOpen: local,
  } }).handleWorkPanelInvoke;
  return {
    calls, local, sender,
    invoke: (method, input) => handler({ sender }, { method, input }),
    update: (patch) => { target = { ...target, ...patch }; },
    navigate: (next) => { url = next; },
    beforeRegistration: () => { registered = false; },
  };
}

test("local Office capability requires the host-owned current document binding", async () => {
  const h = harness();
  assert.ok((await h.invoke("getCapabilities")).capabilities.includes("workpanel.document.open-local"));
  const result = await h.invoke("getDocumentOpenOptions", { version: 6, source });
  assert.equal(result.applications[0].name, "PowerPoint");
  assert.notEqual(h.calls[0].document, source);
  for (const patch of [{ documentSource: undefined }, { surfaceRole: "file" }, { ownerChatId: "other-chat" }, { surfaceLevel: "root" }]) {
    const blocked = harness(); blocked.update(patch);
    assert.equal((await blocked.invoke("getDocumentOpenOptions", { version: 6, source })).error.code, "capability_denied");
    assert.equal(blocked.calls.length, 0);
  }
});

test("initial capability query waits for a trusted document registration before probing applications", async () => {
  const h = harness();
  h.beforeRegistration();
  const result = await h.invoke("getCapabilities");
  assert.equal(result.ok, true);
  assert.ok(result.capabilities.includes("workpanel.document.open-local"));
  assert.equal(h.calls.length, 0);
});

test("guest cannot substitute another document, Chat, path or command", async () => {
  const h = harness();
  for (const input of [
    { version: 6, source: { ...source, relativePath: "artifacts/other.pptx" } },
    { version: 6, source: { ...source, chatId: "other" } },
    { version: 6, source: { ...source, resourceId: "other" } },
    { version: 6, source, command: "/bin/sh" },
    { version: 6, source: { ...source, executable: "something" } },
  ]) assert.equal((await h.invoke("getDocumentOpenOptions", input)).error.code, "capability_denied");
  assert.equal((await h.invoke("getDocumentOpenOptions", { version: 5, source })).error.code, "version_mismatch");
  assert.equal(h.calls.length, 0);
});

test("save-dialog lifetime is bound to the exact live document and registration", async () => {
  for (const invalidate of [
    (h) => h.update({ registrationId: "generation-2" }),
    (h) => h.update({ documentSource: { ...source, relativePath: "artifacts/new.pptx" } }),
    (h) => h.update({ active: false }),
    (h) => h.update({ ownerChatId: "other" }),
    (h) => h.navigate("http://localhost:3000/resource-viewer/other"),
  ]) {
    const h = harness();
    await h.invoke("openDocumentCopy", { version: 6, source, applicationId: "app" });
    assert.equal(h.calls[0].stillOwned(), true);
    invalidate(h);
    assert.equal(h.calls[0].stillOwned(), false);
  }
});

test("duplicate clicks remain blocked throughout an asynchronous save dialog", async () => {
  const h = harness();
  let complete;
  h.local.openCopy = () => new Promise((resolve) => { complete = resolve; });
  const first = h.invoke("openDocumentCopy", { version: 6, source, applicationId: "app" });
  const second = await h.invoke("openDocumentCopy", { version: 6, source, applicationId: "app" });
  assert.equal(second.error.code, "duplicate_id");
  complete({ ok: true, status: "cancelled" });
  assert.deepEqual(await first, { ok: true, status: "cancelled" });
  h.local.openCopy = async () => ({ ok: true, status: "launch-requested" });
  assert.equal((await h.invoke("openDocumentCopy", { version: 6, source, applicationId: "app" })).ok, true);
});

test("host descriptor captures all three document sources without deriving identity from a URL", () => {
  assert.deepEqual(documentSourceFromWebclientDescriptor({ kind: "webclient", module: "file", context: { agentKey: "a", path: "C:\\项目\\报告.docx" }, route: "/anything" }),
    { kind: "workspace-file", agentKey: "a", path: "C:/项目/报告.docx" });
  assert.deepEqual(documentSourceFromWebclientDescriptor({ kind: "webclient", module: "artifact", context: { agentKey: "agent", chatId: "chat", artifactId: "artifact-1", relativePath: "artifacts/report.pptx" }, route: "/anything" }), source);
  assert.deepEqual(documentSourceFromWebclientDescriptor({ kind: "webclient", module: "reference", context: { agentKey: "a", chatId: "c", referenceId: "r", relativePath: "预算.xlsx" }, route: "/anything" }),
    { kind: "reference", agentKey: "a", chatId: "c", resourceId: "r", relativePath: "预算.xlsx" });
  assert.equal(documentSourceFromWebclientDescriptor({ kind: "webclient", module: "artifact", context: { agentKey: "a", chatId: "c", artifactId: "r" }, route: "/guessed.docx" }), undefined);
});

test("same-URL reload, navigation away and back, and renderer crashes invalidate pending opens", async () => {
  for (const event of ["did-start-navigation", "render-process-gone", "destroyed"]) {
    const h = harness();
    let complete;
    h.local.openCopy = async (_source, _app, stillOwned) => {
      await new Promise((resolve) => { complete = resolve; });
      return stillOwned() ? { ok: true, status: "launch-requested" }
        : { ok: false, error: { code: "target_unavailable", message: "invalidated" } };
    };
    const pending = h.invoke("openDocumentCopy", { version: 6, source, applicationId: "app" });
    h.sender.emit(event, {}, "http://localhost:3000/resource-viewer/agent", false, true);
    complete();
    assert.equal((await pending).error.code, "target_unavailable");
    assert.equal(h.sender.listenerCount(event), 0);
  }
});
