import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { APP_BRAND } = await import("../dist-electron/shared/brand.js");
const { resolveAssistantChatStoragePaths } = await import(
  "../dist-electron/main/assistant/core/chat-storage-path.js"
);
const { revealAssistantChatInFileManager } = await import(
  "../dist-electron/main/ipc/assistant-handlers.js"
);

function makeApp(homePath) {
  return {
    getPath(name) {
      assert.equal(name, "home");
      return homePath;
    },
  };
}

test("chat storage paths use explicit macOS and Windows path rules", () => {
  const macPaths = resolveAssistantChatStoragePaths(
    makeApp("/Users/test"),
    " chat_1 ",
    "darwin",
  );
  assert.deepEqual(macPaths, {
    chatsDirectoryPath: `/Users/test/${APP_BRAND.paths.runtimeRootDirName}/chats`,
    chatDirectoryPath: `/Users/test/${APP_BRAND.paths.runtimeRootDirName}/chats/chat_1`,
    chatFilePath: `/Users/test/${APP_BRAND.paths.runtimeRootDirName}/chats/chat_1.jsonl`,
  });

  const windowsRoot = `C:\\Users\\test\\${APP_BRAND.paths.runtimeRootDirName}\\chats`;
  const windowsPaths = resolveAssistantChatStoragePaths(
    makeApp("C:\\Users\\test"),
    "chat_1",
    "win32",
  );
  assert.deepEqual(windowsPaths, {
    chatsDirectoryPath: windowsRoot,
    chatDirectoryPath: `${windowsRoot}\\chat_1`,
    chatFilePath: `${windowsRoot}\\chat_1.jsonl`,
  });
  assert.equal(resolveAssistantChatStoragePaths(makeApp("/Users/test"), "../escape", "darwin"), null);
});

test("chat information reveals the chat directory without returning its absolute path", async (t) => {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-chat-info-"));
  t.after(() => fs.rmSync(homePath, { recursive: true, force: true }));
  const chatDirectoryPath = path.join(
    homePath,
    APP_BRAND.paths.runtimeRootDirName,
    "chats",
    "chat_1",
  );
  fs.mkdirSync(chatDirectoryPath, { recursive: true });
  const revealed = [];
  const result = await revealAssistantChatInFileManager("chat_1", {
    app: makeApp(homePath),
    platform: "darwin",
    shell: {
      showItemInFolder: (targetPath) => revealed.push(targetPath),
      openPath: async () => "",
    },
  });

  assert.equal(result.ok, true);
  assert.equal("path" in result, false);
  assert.deepEqual(revealed, [chatDirectoryPath]);
});

test("chat information reveals the persisted JSONL when no chat directory exists", async (t) => {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-chat-info-"));
  t.after(() => fs.rmSync(homePath, { recursive: true, force: true }));
  const chatFilePath = path.join(
    homePath,
    APP_BRAND.paths.runtimeRootDirName,
    "chats",
    "chat_2.jsonl",
  );
  fs.mkdirSync(path.dirname(chatFilePath), { recursive: true });
  fs.writeFileSync(chatFilePath, "");
  const revealed = [];
  const result = await revealAssistantChatInFileManager("chat_2", {
    app: makeApp(homePath),
    platform: "darwin",
    shell: {
      showItemInFolder: (targetPath) => revealed.push(targetPath),
      openPath: async () => "",
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(revealed, [chatFilePath]);
});

test("chat information rejects path-like chat IDs before reaching the shell", async () => {
  let shellCallCount = 0;
  const result = await revealAssistantChatInFileManager("../escape", {
    app: makeApp("/Users/test"),
    platform: "darwin",
    shell: {
      showItemInFolder: () => {
        shellCallCount += 1;
      },
      openPath: async () => {
        shellCallCount += 1;
        return "";
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(shellCallCount, 0);
  assert.equal("path" in result, false);
});

test("chat information does not expose an absolute path through shell errors", async (t) => {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-chat-info-"));
  t.after(() => fs.rmSync(homePath, { recursive: true, force: true }));
  const chatsDirectoryPath = path.join(
    homePath,
    APP_BRAND.paths.runtimeRootDirName,
    "chats",
  );
  fs.mkdirSync(chatsDirectoryPath, { recursive: true });
  const result = await revealAssistantChatInFileManager("chat_3", {
    app: makeApp(homePath),
    platform: "darwin",
    shell: {
      showItemInFolder: () => undefined,
      openPath: async (targetPath) => `Could not open ${targetPath}`,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.message.includes(homePath), false);
  assert.equal("path" in result, false);
});
