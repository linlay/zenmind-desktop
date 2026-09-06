import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  WorkPanelResourceImageRegistry,
} = await import("../dist-electron/main/modules/work-panel/resource-images.js");
const {
  resolveRuntimeRootPath,
} = await import("../dist-electron/main/infrastructure/filesystem/runtime-root.js");

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function sender(id = 42) {
  return {
    id,
    isDestroyed: () => false,
    send() {},
    once() {},
  };
}

function configureRegistry(registry, homePath, overrides = {}) {
  registry.configure({
    app: { getPath: (name) => name === "home" ? homePath : homePath, once() {} },
    assistantBridge: {
      completeImage: async () => assert.fail("invalid AI input must not reach Zenmi"),
      stopRun: async () => ({ ok: true }),
    },
    getMainWindow: () => null,
    showFileDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true }),
    commitResource: async () => assert.fail("invalid commit must not reach Platform"),
    ...overrides,
  });
}

test("native resource image claims are chat-bound, one-time, signature checked, and opaque", async () => {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-native-image-home-"));
  const runtimeRoot = resolveRuntimeRootPath({ homePath, platform: process.platform });
  const artifactRoot = path.join(runtimeRoot, "chats", "chat-1", "artifacts", "run-1");
  fs.mkdirSync(artifactRoot, { recursive: true });
  fs.writeFileSync(path.join(artifactRoot, "image.png"), PNG_1X1);
  fs.writeFileSync(path.join(artifactRoot, "not-image.png"), "not a png");
  fs.writeFileSync(path.join(artifactRoot, "notes.txt"), "notes");
  const registry = new WorkPanelResourceImageRegistry();
  configureRegistry(registry, homePath);
  const webContents = sender();
  try {
    const prepared = await registry.prepareClaim({
      ownerChatId: "chat-1",
      rendererWebContentsId: webContents.id,
      profile: "artifact",
      agentKey: "agent-1",
      chatId: "chat-1",
      resourceId: "artifact-1",
      relativePath: "artifacts/run-1/image.png",
      title: "Image",
    });
    assert.equal(prepared.ok, true);
    assert.equal((await registry.claim({
      claimId: prepared.claimId,
      ownerChatId: "chat-forged",
      rendererGeneration: "renderer-1",
    }, webContents)).ok, false);

    const claimed = await registry.claim({
      claimId: prepared.claimId,
      ownerChatId: "chat-1",
      rendererGeneration: "renderer-1",
    }, webContents);
    assert.equal(claimed.ok, true);
    assert.equal(claimed.resource.fileName, "image.png");
    assert.equal(claimed.resource.mimeType, "image/png");
    assert.equal(claimed.resource.profile, "artifact");
    assert.equal("filePath" in claimed.resource, false);
    assert.equal((await registry.claim({
      claimId: prepared.claimId,
      ownerChatId: "chat-1",
      rendererGeneration: "renderer-1",
    }, webContents)).ok, false);

    const read = await registry.read({
      ownerChatId: "chat-1",
      rendererGeneration: "renderer-1",
      handleId: claimed.resource.handleId,
    }, webContents);
    assert.equal(read.ok, true);
    assert.deepEqual(Buffer.from(read.data), PNG_1X1);

    const signatureMismatch = await registry.prepareClaim({
      ownerChatId: "chat-1",
      rendererWebContentsId: webContents.id,
      profile: "artifact",
      agentKey: "agent-1",
      chatId: "chat-1",
      resourceId: "artifact-bad",
      relativePath: "artifacts/run-1/not-image.png",
    });
    assert.equal(signatureMismatch.ok, false);
    assert.equal(signatureMismatch.code, "unsupported_native_type");

    const unsupported = await registry.prepareClaim({
      ownerChatId: "chat-1",
      rendererWebContentsId: webContents.id,
      profile: "artifact",
      agentKey: "agent-1",
      chatId: "chat-1",
      resourceId: "artifact-notes",
      relativePath: "artifacts/run-1/notes.txt",
    });
    assert.equal(unsupported.ok, false);
    assert.equal(unsupported.code, "unsupported_native_type");

    assert.deepEqual(registry.release({
      ownerChatId: "chat-1",
      rendererGeneration: "renderer-1",
      handleIds: [claimed.resource.handleId],
    }, webContents), { ok: true });
    assert.equal((await registry.read({
      ownerChatId: "chat-1",
      rendererGeneration: "renderer-1",
      handleId: claimed.resource.handleId,
    }, webContents)).ok, false);
  } finally {
    registry.dispose();
    fs.rmSync(homePath, { recursive: true, force: true });
  }
});

test("remote native image handles retain the Platform revision instead of the cache mtime", async () => {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-native-image-remote-"));
  const registry = new WorkPanelResourceImageRegistry();
  const commits = [];
  configureRegistry(registry, homePath, {
    fetchRemoteResource: async () => ({
      bytes: PNG_1X1,
      mimeType: "image/png",
      revision: "68:1777777777000",
    }),
    commitResource: async (payload) => {
      commits.push(payload);
      return {
        artifactId: "artifact-remote",
        resourceId: "artifact-remote",
        relativePath: "artifacts/run-remote/image.png",
        revision: "68:1777777778000",
      };
    },
  });
  const webContents = sender(44);
  try {
    const prepared = await registry.prepareClaim({
      ownerChatId: "chat-remote",
      rendererWebContentsId: webContents.id,
      profile: "artifact",
      agentKey: "agent-remote",
      chatId: "chat-remote",
      resourceId: "artifact-remote",
      relativePath: "artifacts/run-remote/image.png",
    });
    assert.equal(prepared.ok, true);
    const claimed = await registry.claim({
      claimId: prepared.claimId,
      ownerChatId: "chat-remote",
      rendererGeneration: "renderer-remote",
    }, webContents);
    assert.equal(claimed.ok, true);
    assert.equal(claimed.resource.localOriginal, false);
    assert.equal(claimed.resource.revision, "68:1777777777000");
    const read = await registry.read({
      ownerChatId: "chat-remote",
      rendererGeneration: "renderer-remote",
      handleId: claimed.resource.handleId,
    }, webContents);
    assert.equal(read.ok, true);
    assert.equal(read.revision, "68:1777777777000");
    const committed = await registry.commit({
      ownerChatId: "chat-remote",
      rendererGeneration: "renderer-remote",
      handleId: claimed.resource.handleId,
      mode: "overwrite",
      expectedRevision: "68:1777777777000",
      mimeType: "image/png",
      dataBase64: PNG_1X1.toString("base64"),
      hasTransparency: false,
    }, webContents);
    assert.equal(committed.ok, true);
    assert.equal(committed.resource.revision, "68:1777777778000");
    assert.equal(commits[0].expectedRevision, "68:1777777777000");
  } finally {
    registry.dispose();
    fs.rmSync(homePath, { recursive: true, force: true });
  }
});

test("native image AI and Reference overwrite fail before privileged execution", async () => {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-native-reference-home-"));
  const runtimeRoot = resolveRuntimeRootPath({ homePath, platform: process.platform });
  const referenceRoot = path.join(runtimeRoot, "chats", "chat-2", "references");
  fs.mkdirSync(referenceRoot, { recursive: true });
  fs.writeFileSync(path.join(referenceRoot, "image.png"), PNG_1X1);
  const registry = new WorkPanelResourceImageRegistry();
  configureRegistry(registry, homePath);
  const webContents = sender(43);
  try {
    const prepared = await registry.prepareClaim({
      ownerChatId: "chat-2",
      rendererWebContentsId: webContents.id,
      profile: "reference",
      agentKey: "agent-2",
      chatId: "chat-2",
      resourceId: "reference-2",
      relativePath: "references/image.png",
    });
    const claimed = await registry.claim({
      claimId: prepared.claimId,
      ownerChatId: "chat-2",
      rendererGeneration: "renderer-2",
    }, webContents);
    const base = {
      ownerChatId: "chat-2",
      rendererGeneration: "renderer-2",
      handleId: claimed.resource.handleId,
    };
    const ai = await registry.runAi({
      ...base,
      requestId: "request-1234",
      expectedRevision: claimed.resource.revision,
      operation: "removeObject",
      sourceMimeType: "image/png",
      sourceDataBase64: PNG_1X1.toString("base64"),
      width: 1,
      height: 1,
      preserveComposition: true,
      edgeMode: "soft",
    }, webContents);
    assert.equal(ai.ok, false);
    assert.match(ai.message, /regional AI edit requires a PNG white edit mask/u);

    const commit = await registry.commit({
      ...base,
      mode: "overwrite",
      expectedRevision: claimed.resource.revision,
      mimeType: "image/png",
      dataBase64: PNG_1X1.toString("base64"),
      hasTransparency: false,
    }, webContents);
    assert.equal(commit.ok, false);
    assert.match(commit.message, /References can only create a new Artifact/u);
  } finally {
    registry.dispose();
    fs.rmSync(homePath, { recursive: true, force: true });
  }
});

test("native image regional AI forwards the canonical source, mask, and instruction", async () => {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-native-ai-region-home-"));
  const runtimeRoot = resolveRuntimeRootPath({ homePath, platform: process.platform });
  const artifactRoot = path.join(runtimeRoot, "chats", "chat-ai", "artifacts", "run-ai");
  fs.mkdirSync(artifactRoot, { recursive: true });
  fs.writeFileSync(path.join(artifactRoot, "image.png"), PNG_1X1);
  const calls = [];
  const registry = new WorkPanelResourceImageRegistry();
  configureRegistry(registry, homePath, {
    assistantBridge: {
      completeImage: async (input) => {
        calls.push(input);
        if (input.operation === "enhance") throw new Error("image bridge unavailable");
        return { ok: false, runId: "run-ai", chatId: "chat-ai", message: "expected test stop" };
      },
      stopRun: async () => ({ ok: true }),
    },
  });
  const webContents = sender(46);
  try {
    const prepared = await registry.prepareClaim({
      ownerChatId: "chat-ai",
      rendererWebContentsId: webContents.id,
      profile: "artifact",
      agentKey: "agent-ai",
      chatId: "chat-ai",
      resourceId: "artifact-ai",
      relativePath: "artifacts/run-ai/image.png",
    });
    const claimed = await registry.claim({
      claimId: prepared.claimId,
      ownerChatId: "chat-ai",
      rendererGeneration: "renderer-ai",
    }, webContents);
    const result = await registry.runAi({
      ownerChatId: "chat-ai",
      rendererGeneration: "renderer-ai",
      handleId: claimed.resource.handleId,
      requestId: "request-region",
      expectedRevision: claimed.resource.revision,
      operation: "inpaint",
      sourceMimeType: "image/png",
      sourceDataBase64: PNG_1X1.toString("base64"),
      maskDataBase64: PNG_1X1.toString("base64"),
      prompt: "Make the selected region blue",
      width: 1,
      height: 1,
      preserveComposition: true,
      edgeMode: "soft",
    }, webContents);
    assert.equal(result.ok, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].operation, "inpaint");
    assert.equal(calls[0].prompt, "Make the selected region blue");
    assert.deepEqual(calls[0].attachments.map((attachment) => attachment.id), [
      "image-studio-source",
      "image-studio-mask",
    ]);
    const thrownFailure = await registry.runAi({
      ownerChatId: "chat-ai",
      rendererGeneration: "renderer-ai",
      handleId: claimed.resource.handleId,
      requestId: "request-enhance",
      expectedRevision: claimed.resource.revision,
      operation: "enhance",
      sourceMimeType: "image/png",
      sourceDataBase64: PNG_1X1.toString("base64"),
      width: 1,
      height: 1,
      preserveComposition: true,
      edgeMode: "soft",
    }, webContents);
    assert.equal(thrownFailure.ok, false);
    assert.equal(thrownFailure.requestId, "request-enhance");
    assert.equal(thrownFailure.message, "image bridge unavailable");
    assert.equal(calls.length, 2);
  } finally {
    registry.dispose();
    fs.rmSync(homePath, { recursive: true, force: true });
  }
});
