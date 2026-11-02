import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHtmlTestSession } from "./helpers/document-html-session.mjs";

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
  const previewSession = createHtmlTestSession();
  const registry = new WorkPanelDocumentHtmlRegistry(() => previewSession.session);
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
    const preview = await registry.preview(requestIdentity, webContents);
    assert.equal(preview.ok, true);
    assert.match(preview.url, /^zenmind-document-html:\/\//u);
    assert.equal(preview.revision, read.revision);
    assert.equal("text" in preview, false);
    assert.equal(await (await previewSession.request(preview.url)).text(), read.text);
    const css = await previewSession.request(new URL("style.css", preview.url).href);
    assert.equal(css.headers.get("Content-Type"), "text/css");
    assert.match(await css.text(), /url\('\.\.\/assets\/logo.png'\)/u);
    assert.equal((await previewSession.request(new URL("../assets/logo.png", preview.url).href)).status, 200);
    assert.equal((await previewSession.request(new URL("../escaped.txt", preview.url).href)).status, 404);

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
    assert.equal(claimed.document.fileName, "source.html", "remote file actions must not use the internal cache basename");
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

test("large native HTML stays complete through claim, read and preview, with separate asset limits", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-large-html-"));
  const previewSession = createHtmlTestSession();
  const registry = new WorkPanelDocumentHtmlRegistry(() => previewSession.session);
  const fileActions = [];
  const fileShell = {
    openPath: async (file) => { fileActions.push(["open-default", file]); return ""; },
    showItemInFolder: (file) => fileActions.push(["reveal", file]),
  };
  configureRegistry(registry, root, { fileShell });
  const webContents = sender();
  const end = "<p>complete-end</p>";
  try {
    for (const mib of [9, 13, 32]) {
      const filename = `${mib}.html`, filePath = path.join(root, filename);
      const html = "<!doctype html>" + " ".repeat(mib * 1024 * 1024 - 15 - end.length) + end;
      fs.writeFileSync(filePath, html);
      const prepared = await registry.prepareClaim({
        ownerChatId: "large-html", rendererWebContentsId: webContents.id,
        source: { kind: "workspace-file", agentKey: "agent", path: filename }, workspaceFilePath: filePath,
      });
      assert.equal(prepared.ok, true, `${mib} MiB must use native HTML`);
      const claimed = await registry.claim({ claimId: prepared.claimId, ownerChatId: "large-html", rendererGeneration: "large" }, webContents);
      assert.equal(claimed.ok, true);
      const identity = { handleId: claimed.document.handleId, ownerChatId: "large-html", rendererGeneration: "large" };
      const read = registry.read(identity, webContents);
      assert.equal(read.ok, true);
      assert.equal(read.text, html);
      const preview = await registry.preview(identity, webContents);
      assert.equal(preview.ok, true);
      const response = await previewSession.request(preview.url);
      assert.equal(response.status, 200, `${mib} MiB must pass the protocol limit too`);
      assert.equal(await response.text(), html);
      for (const platform of ["darwin", "win32"]) {
        configureRegistry(registry, root, { platform, fileShell });
        for (const action of ["open-default", "reveal"]) {
          assert.equal((await registry.fileAction({ ...identity, action }, webContents)).ok, true);
          assert.deepEqual(fileActions.at(-1), [action, fs.realpathSync(filePath)]);
        }
      }
      fs.writeFileSync(path.join(root, "large.png"), Buffer.alloc(12 * 1024 * 1024));
      assert.equal((await previewSession.request(new URL("large.png", preview.url).href)).status, 200);
      fs.appendFileSync(path.join(root, "large.png"), "x");
      assert.equal((await previewSession.request(new URL("large.png", preview.url).href)).status, 413);
      if (mib === 32) {
        for (const [name, size] of [["second.png", 12 * 1024 * 1024], ["third.png", 8 * 1024 * 1024], ["overflow.png", 1]]) {
          fs.writeFileSync(path.join(root, name), Buffer.alloc(size));
          assert.equal((await previewSession.request(new URL(name, preview.url).href)).status, name === "overflow.png" ? 413 : 200);
        }
      }
      registry.release({ ...identity, handleIds: [identity.handleId] }, webContents);
    }
    const filePath = path.join(root, "oversized.html");
    fs.writeFileSync(filePath, "<!doctype html>");
    fs.truncateSync(filePath, 32 * 1024 * 1024 + 1);
    const rejected = await registry.prepareClaim({
      ownerChatId: "large-html", rendererWebContentsId: webContents.id,
      source: { kind: "workspace-file", agentKey: "agent", path: "oversized.html" }, workspaceFilePath: filePath,
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, "target_unavailable", "size errors must not trigger unsupported-type fallback");
    assert.match(rejected.message, /32 MiB/u);
  } finally {
    registry.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("large remote HTML references also keep their full native preview", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-large-remote-html-"));
  const previewSession = createHtmlTestSession();
  const registry = new WorkPanelDocumentHtmlRegistry(() => previewSession.session);
  const html = "<!doctype html>" + " ".repeat(13 * 1024 * 1024) + "<p>remote-end</p>";
  configureRegistry(registry, root, { fetchRemoteResource: async () => ({ bytes: Buffer.from(html), mimeType: "text/html", revision: "remote-revision" }) });
  const webContents = sender();
  try {
    const prepared = await registry.prepareClaim({
      ownerChatId: "remote-html", rendererWebContentsId: webContents.id,
      source: { kind: "reference", agentKey: "agent", chatId: "remote-html", resourceId: "large-reference", relativePath: "references/large.html" },
    });
    assert.equal(prepared.ok, true);
    const claimed = await registry.claim({ claimId: prepared.claimId, ownerChatId: "remote-html", rendererGeneration: "large" }, webContents);
    assert.equal(claimed.ok, true);
    const preview = await registry.preview({ handleId: claimed.document.handleId, ownerChatId: "remote-html", rendererGeneration: "large" }, webContents);
    assert.equal(preview.ok, true);
    assert.equal(await (await previewSession.request(preview.url)).text(), html);
  } finally {
    registry.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
