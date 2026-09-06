import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const {
  WorkPanelDocumentHtmlRegistry,
} = await import("../dist-electron/main/modules/work-panel/document-html.js");
const require = createRequire(import.meta.url);
const {
  EMPTY_WORK_PANEL_STATE,
  reduceWorkPanelCommand,
} = require("../dist-electron/shared/work-panel.js");

function sender(id = 72) {
  return {
    id,
    isDestroyed: () => false,
    send() {},
    once() {},
  };
}

function configureRegistry(registry, homePath, overrides = {}) {
  registry.configure({
    app: { getPath: () => homePath, once() {} },
    getMainWindow: () => null,
    commitDocument: async () => assert.fail("invalid commit must not reach Platform"),
    ...overrides,
  });
}

test("native HTML workspace claims are opaque, sender-bound, editable, and revision-checked", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-native-html-workspace-"));
  const filePath = path.join(root, "site", "index.html");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  fs.writeFileSync(path.join(root, "assets", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(root, "site", "style.css"), "body{background:url('../assets/logo.png')}");
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
  fs.writeFileSync(outside, "must-not-be-inlined");
  const escapedLink = path.join(root, "escaped.txt");
  try { fs.symlinkSync(outside, escapedLink); } catch { /* symlinks may be unavailable */ }
  fs.writeFileSync(
    filePath,
    "<!doctype html><link rel='stylesheet' href='style.css'><h1>Original</h1>" +
      "<img src='../assets/logo.png'><img src='../escaped.txt'>",
  );
  const commits = [];
  const registry = new WorkPanelDocumentHtmlRegistry();
  configureRegistry(registry, root, {
    commitDocument: async (payload) => {
      commits.push(payload);
      fs.writeFileSync(filePath, payload.payload.text);
      const info = fs.statSync(filePath);
      return { revision: `${info.size}:${Math.trunc(info.mtimeMs)}` };
    },
  });
  const webContents = sender();
  try {
    const prepared = await registry.prepareClaim({
      ownerChatId: "chat-html",
      rendererWebContentsId: webContents.id,
      source: { kind: "workspace-file", agentKey: "agent-html", path: "site/index.html" },
      workspaceFilePath: filePath,
    });
    assert.equal(prepared.ok, true);
    assert.equal((await registry.claim({
      claimId: prepared.claimId,
      ownerChatId: "chat-forged",
      rendererGeneration: "renderer-html",
    }, webContents)).ok, false);
    const claimed = await registry.claim({
      claimId: prepared.claimId,
      ownerChatId: "chat-html",
      rendererGeneration: "renderer-html",
    }, webContents);
    assert.equal(claimed.ok, true);
    assert.equal(claimed.document.stableIdentity, "file:agent-html:site/index.html");
    assert.equal(claimed.document.displayUrl, "workspace:///site/index.html");
    assert.equal(claimed.document.localOriginal, true);
    assert.equal("filePath" in claimed.document, false);
    const opened = reduceWorkPanelCommand(EMPTY_WORK_PANEL_STATE, {
      type: "openItem",
      ownerChatId: "chat-html",
      descriptor: {
        kind: "native",
        surfaceKey: "document-html",
        context: { ...claimed.document },
      },
    });
    assert.equal(opened.ok, true);
    assert.equal(opened.item.descriptor.context.displayUrl, claimed.document.displayUrl);

    const requestIdentity = {
      ownerChatId: "chat-html",
      rendererGeneration: "renderer-html",
      handleId: claimed.document.handleId,
    };
    const read = registry.read(requestIdentity, webContents);
    assert.equal(read.ok, true);
    assert.match(read.text, /Original/u);
    assert.equal(read.revision, claimed.document.revision);
    const preview = await registry.preview({ ...requestIdentity, text: read.text }, webContents);
    assert.equal(preview.ok, true);
    assert.match(preview.text, /data:image\/png;base64,/u);
    assert.match(preview.text, /data:text\/css;charset=utf-8;base64,/u);
    assert.doesNotMatch(preview.text, /must-not-be-inlined/u);
    assert.match(preview.text, /src='\.\.\/escaped\.txt'/u);

    const stale = await registry.commit({
      ...requestIdentity,
      mode: "overwrite",
      expectedRevision: "stale",
      text: "<!doctype html><h1>Stale</h1>",
    }, webContents);
    assert.equal(stale.ok, false);
    assert.equal(stale.conflict, true);
    assert.equal(commits.length, 0);

    const saved = await registry.commit({
      ...requestIdentity,
      mode: "overwrite",
      expectedRevision: read.revision,
      text: "<!doctype html><h1>Edited</h1>",
    }, webContents);
    assert.equal(saved.ok, true);
    assert.equal(saved.created, false);
    assert.equal(commits.length, 1);
    assert.equal(commits[0].source.kind, "workspace-file");
    assert.match(fs.readFileSync(filePath, "utf8"), /Edited/u);
  } finally {
    registry.dispose();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.join(path.dirname(root), `${path.basename(root)}-outside.txt`), { force: true });
  }
});

test("remote native HTML keeps the Platform revision and Reference only creates an Artifact", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-native-html-reference-"));
  const calls = [];
  const registry = new WorkPanelDocumentHtmlRegistry();
  configureRegistry(registry, root, {
    fetchRemoteResource: async ({ relativePath }) => ({
      bytes: Buffer.from(relativePath.startsWith("artifacts/")
        ? "<!doctype html><p>new artifact</p>"
        : "<!doctype html><p>Reference</p>"),
      mimeType: "text/html",
      revision: relativePath.startsWith("artifacts/") ? "platform-revision-2" : "platform-revision-1",
    }),
    commitDocument: async (payload) => {
      calls.push(payload);
      return {
        artifactId: "artifact-edited",
        resourceId: "artifact-edited",
        relativePath: "artifacts/document-edit/source-edited.html",
        revision: "platform-revision-2",
      };
    },
  });
  const webContents = sender(73);
  try {
    const prepared = await registry.prepareClaim({
      ownerChatId: "chat-reference",
      rendererWebContentsId: webContents.id,
      source: {
        kind: "reference",
        agentKey: "agent-reference",
        chatId: "chat-reference",
        resourceId: "reference-html",
        relativePath: "references/source.html",
      },
    });
    assert.equal(prepared.ok, true);
    const claimed = await registry.claim({
      claimId: prepared.claimId,
      ownerChatId: "chat-reference",
      rendererGeneration: "renderer-reference",
    }, webContents);
    assert.equal(claimed.ok, true);
    assert.equal(claimed.document.revision, "platform-revision-1");
    assert.equal(claimed.document.displayUrl, "reference:///references/source.html");
    const identity = {
      ownerChatId: "chat-reference",
      rendererGeneration: "renderer-reference",
      handleId: claimed.document.handleId,
    };
    const read = registry.read(identity, webContents);
    assert.equal(read.ok, true);
    assert.equal(read.revision, "platform-revision-1");

    const overwrite = await registry.commit({
      ...identity,
      mode: "overwrite",
      expectedRevision: read.revision,
      text: "<p>overwrite</p>",
    }, webContents);
    assert.equal(overwrite.ok, false);
    assert.match(overwrite.message, /new Artifact/u);
    assert.equal(calls.length, 0);

    const created = await registry.commit({
      ...identity,
      mode: "new-artifact",
      expectedRevision: read.revision,
      text: "<p>new artifact</p>",
    }, webContents);
    assert.equal(created.ok, true);
    assert.equal(created.created, true);
    assert.equal(created.document.sourceKind, "artifact");
    assert.equal(created.document.revision, "platform-revision-2");
    assert.equal(created.document.stableIdentity, "artifact:agent-reference:chat-reference:artifact-edited:artifacts/document-edit/source-edited.html");
    assert.notEqual(created.document.handleId, claimed.document.handleId);
    const createdRead = registry.read({ ...identity, handleId: created.document.handleId }, webContents);
    assert.equal(createdRead.ok, true);
    assert.match(createdRead.text, /new artifact/u);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mode, "new-artifact");
  } finally {
    registry.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
