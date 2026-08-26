import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  WorkPanelLocalFileRegistry,
  classifyWorkPanelLocalFile,
  isPathInsideLocalFileRoot,
  normalizeWorkPanelLocalFileRelativePath,
  resolveWorkPanelLocalFileFromWorkspace,
  resolveLocalFileProtocolPath,
} = await import("../dist-electron/main/chat-work-panel-local-files.js");

test("WorkPanel local files classify only supported inline preview formats", () => {
  assert.equal(classifyWorkPanelLocalFile("index.HTML"), "html");
  assert.equal(classifyWorkPanelLocalFile("report.pdf"), "pdf");
  assert.equal(classifyWorkPanelLocalFile("cover.webp"), "image");
  assert.equal(classifyWorkPanelLocalFile("notes.md"), "text");
  assert.equal(classifyWorkPanelLocalFile("recording.m4a"), "audio");
  assert.equal(classifyWorkPanelLocalFile("clip.mp4"), "video");
  assert.equal(classifyWorkPanelLocalFile("archive.zip"), "unsupported");
});

test("WorkPanel local file path checks are explicit for macOS/POSIX and Windows", () => {
  assert.equal(isPathInsideLocalFileRoot("/tmp/root", "/tmp/root/a.css", "darwin"), true);
  assert.equal(isPathInsideLocalFileRoot("/tmp/root", "/tmp/secret", "darwin"), false);
  assert.equal(isPathInsideLocalFileRoot("C:\\root", "C:\\root\\a.css", "win32"), true);
  assert.equal(isPathInsideLocalFileRoot("C:\\root", "C:\\secret", "win32"), false);
  assert.equal(normalizeWorkPanelLocalFileRelativePath("artifacts/report.html"), "artifacts/report.html");
  assert.equal(normalizeWorkPanelLocalFileRelativePath("artifacts\\report.html"), "artifacts/report.html");
  for (const invalid of [
    "", "../secret.txt", "artifacts/../../secret.txt", "/tmp/report.html",
    "C:\\workspace\\report.html", "\\\\server\\share\\report.html", "file:///tmp/report.html",
  ]) {
    assert.equal(normalizeWorkPanelLocalFileRelativePath(invalid), "", invalid);
  }
});

test("WorkPanel resolves only regular files whose realpath stays inside the Agent workspace", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-workpanel-workspace-"));
  const workspace = path.join(tempRoot, "workspace");
  const outside = path.join(tempRoot, "outside.html");
  fs.mkdirSync(path.join(workspace, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "artifacts", "report.html"), "<!doctype html>");
  fs.writeFileSync(outside, "outside");
  try {
    const resolved = resolveWorkPanelLocalFileFromWorkspace(workspace, "artifacts/report.html");
    assert.equal(resolved.ok, true);
    assert.equal(resolved.filePath, fs.realpathSync.native(path.join(workspace, "artifacts", "report.html")));
    assert.equal(resolveWorkPanelLocalFileFromWorkspace(workspace, "artifacts").code, "file_unavailable");
    assert.equal(resolveWorkPanelLocalFileFromWorkspace(workspace, "missing.html").code, "file_unavailable");
    assert.equal(resolveWorkPanelLocalFileFromWorkspace(path.join(tempRoot, "missing"), "report.html").code, "workspace_unavailable");
    if (process.platform !== "win32") {
      fs.symlinkSync(outside, path.join(workspace, "artifacts", "linked.html"));
      assert.equal(
        resolveWorkPanelLocalFileFromWorkspace(workspace, "artifacts/linked.html").code,
        "path_outside_workspace",
      );
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("WorkPanel local HTML resources stay inside the selected directory after realpath", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-workpanel-local-"));
  const selectedRoot = path.join(tempRoot, "selected");
  const outsideRoot = path.join(tempRoot, "outside");
  fs.mkdirSync(selectedRoot);
  fs.mkdirSync(outsideRoot);
  const htmlPath = path.join(selectedRoot, "index.html");
  const cssPath = path.join(selectedRoot, "styles.css");
  const secretPath = path.join(outsideRoot, "secret.txt");
  fs.writeFileSync(htmlPath, "<!doctype html>");
  fs.writeFileSync(cssPath, "body{}");
  fs.writeFileSync(secretPath, "secret");
  const handle = {
    handleId: "opaque-handle",
    rootRealPath: fs.realpathSync.native(selectedRoot),
  };
  try {
    assert.equal(
      resolveLocalFileProtocolPath(handle, "zenmind-local-file://opaque-handle/index.html"),
      fs.realpathSync.native(htmlPath),
    );
    assert.equal(
      resolveLocalFileProtocolPath(handle, "zenmind-local-file://opaque-handle/styles.css"),
      fs.realpathSync.native(cssPath),
    );
    if (process.platform !== "win32") {
      fs.symlinkSync(secretPath, path.join(selectedRoot, "linked-secret.txt"));
      assert.equal(
        resolveLocalFileProtocolPath(handle, "zenmind-local-file://opaque-handle/linked-secret.txt"),
        "",
      );
    }
    assert.equal(
      resolveLocalFileProtocolPath(handle, "zenmind-local-file://wrong-handle/index.html"),
      "",
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function createFakeSession() {
  const state = {
    permissionRequestHandler: null,
    permissionCheckHandler: null,
    requestFilter: null,
    requestHandler: null,
    protocolHandler: null,
    unhandled: [],
    storageClears: 0,
    cacheClears: 0,
  };
  return {
    state,
    session: {
      setPermissionRequestHandler(handler) {
        state.permissionRequestHandler = handler;
      },
      setPermissionCheckHandler(handler) {
        state.permissionCheckHandler = handler;
      },
      webRequest: {
        onBeforeRequest(filter, handler) {
          state.requestFilter = filter;
          state.requestHandler = handler;
        },
      },
      protocol: {
        async handle(_scheme, handler) {
          state.protocolHandler = handler;
        },
        unhandle(scheme) {
          state.unhandled.push(scheme);
        },
      },
      async clearStorageData() {
        state.storageClears += 1;
      },
      async clearCache() {
        state.cacheClears += 1;
      },
    },
  };
}

test("WorkPanel local file claims are one-time, owner-bound, deduplicated, and network-isolated", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-workpanel-claim-"));
  const filePath = path.join(tempRoot, "report.html");
  const siblingPath = path.join(tempRoot, "sibling.html");
  fs.writeFileSync(filePath, "<!doctype html>");
  fs.writeFileSync(siblingPath, "<!doctype html><title>sibling</title>");
  const fake = createFakeSession();
  const scheduled = [];
  let sequence = 0;
  const registry = new WorkPanelLocalFileRegistry({
    randomUUID: () => `local-${++sequence}`,
    createSession: () => fake.session,
    fetchFile: async () => new Response("fixture"),
    schedule(callback, delayMs) {
      const timeout = { callback, delayMs, cleared: false, unref() {} };
      scheduled.push(timeout);
      return timeout;
    },
    clearScheduled(timeout) {
      timeout.cleared = true;
    },
  });
  const sender = { id: 42, once() {} };
  try {
    const prepared = registry.prepareClaim({
      ownerChatId: "chat-owner",
      rendererWebContentsId: sender.id,
      filePath,
    });
    assert.equal(prepared.claimId, "local-1");
    assert.equal(scheduled[0].delayMs, 30_000);
    assert.equal((await registry.claim({
      claimId: prepared.claimId,
      ownerChatId: "wrong-chat",
      rendererGeneration: "renderer-1",
    }, sender)).ok, false);

    const claimed = await registry.claim({
      claimId: prepared.claimId,
      ownerChatId: "chat-owner",
      rendererGeneration: "renderer-1",
    }, sender);
    assert.deepEqual(claimed, {
      ok: true,
      file: { handleId: "local-2", fileName: "report.html", previewKind: "html" },
      reused: false,
    });
    assert.equal(registry.isReviewableUrl(
      `zenmind-local-file://${claimed.file.handleId}/report.html`,
    ), false);
    assert.equal(scheduled[0].cleared, true);
    assert.equal((await registry.claim({
      claimId: prepared.claimId,
      ownerChatId: "chat-owner",
      rendererGeneration: "renderer-1",
    }, sender)).ok, false);

    const second = registry.prepareClaim({
      ownerChatId: "chat-owner",
      rendererWebContentsId: sender.id,
      filePath,
      workspaceRelativePath: "report.html",
    });
    const reused = await registry.claim({
      claimId: second.claimId,
      ownerChatId: "chat-owner",
      rendererGeneration: "renderer-1",
    }, sender);
    assert.equal(reused.ok, true);
    assert.equal(reused.reused, true);
    assert.equal(reused.file.handleId, claimed.file.handleId);
    assert.equal(reused.file.reviewKind, "html");
    assert.equal(reused.file.workspaceRelativePath, "report.html");
    assert.equal(registry.isReviewableUrl(
      `zenmind-local-file://${claimed.file.handleId}/report.html`,
    ), true);
    assert.equal(registry.isReviewableUrl(
      `zenmind-local-file://${claimed.file.handleId}/sibling.html`,
    ), false);

    let permissionAllowed = true;
    fake.state.permissionRequestHandler({}, "media", (allowed) => {
      permissionAllowed = allowed;
    });
    assert.equal(permissionAllowed, false);
    assert.equal(fake.state.permissionCheckHandler(), false);
    assert.deepEqual(fake.state.requestFilter.urls, [
      "http://*/*", "https://*/*", "ws://*/*", "wss://*/*", "ftp://*/*",
    ]);
    let networkDecision = null;
    fake.state.requestHandler({ url: "https://example.test/collect" }, (decision) => {
      networkDecision = decision;
    });
    assert.deepEqual(networkDecision, { cancel: true });

    assert.deepEqual(registry.release({
      ownerChatId: "chat-owner",
      rendererGeneration: "renderer-1",
      handleIds: [claimed.file.handleId],
    }, sender), { ok: true });
    assert.equal(registry.isReviewableUrl(
      `zenmind-local-file://${claimed.file.handleId}/report.html`,
    ), false);
    assert.deepEqual(fake.state.unhandled, ["zenmind-local-file"]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fake.state.storageClears, 1);
    assert.equal(fake.state.cacheClears, 1);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("WorkPanel discards an unclaimed local file claim at its deadline", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-workpanel-expired-"));
  const filePath = path.join(tempRoot, "notes.txt");
  fs.writeFileSync(filePath, "notes");
  let scheduled = null;
  const registry = new WorkPanelLocalFileRegistry({
    randomUUID: () => "claim-expiring",
    schedule(callback) {
      scheduled = { callback, unref() {} };
      return scheduled;
    },
    clearScheduled() {},
  });
  const sender = { id: 9, once() {} };
  try {
    const prepared = registry.prepareClaim({
      ownerChatId: "chat-owner",
      rendererWebContentsId: sender.id,
      filePath,
    });
    scheduled.callback();
    assert.equal((await registry.claim({
      claimId: prepared.claimId,
      ownerChatId: "chat-owner",
      rendererGeneration: "renderer-1",
    }, sender)).ok, false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
