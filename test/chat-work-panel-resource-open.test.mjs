import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  resolveChatWorkPanelLocalResourcePath,
} = require("../dist-electron/shared/chat-work-panel-tab-context-menu.js");
const {
  normalizeChatWorkPanelOpenLocalResourceRequest,
  openChatWorkPanelResourceInDefaultApp,
} = await import("../dist-electron/main/chat-work-panel-resource-open.js");

test("Resource Viewer route yields only a chat-scoped artifact/reference path", () => {
  assert.equal(resolveChatWorkPanelLocalResourcePath({
    ownerChatId: "chat-72",
    profile: "artifact",
    route: "/resource-viewer/agent-72?chatId=chat-72&file=artifacts%2Frun-1%2Freport.docx",
  }), "artifacts/run-1/report.docx");
  assert.equal(resolveChatWorkPanelLocalResourcePath({
    ownerChatId: "chat-72",
    profile: "reference",
    route: "/resource-viewer/agent-72?chatId=chat-72&file=references%2Fsource.pdf",
  }), "references/source.pdf");
  assert.equal(resolveChatWorkPanelLocalResourcePath({
    ownerChatId: "chat-72",
    profile: "artifact",
    route: "/resource-viewer/agent-72?chatId=chat-72&file=artifacts%2Fmszrt6gl%2F%25E5%25B7%25A5%25E4%25BC%259A%25E6%25B4%25BB%25E5%258A%25A8%25E7%2594%25B3%25E8%25AF%25B7%25E8%25A1%25A8_%25E6%259C%2580%25E7%25BB%2588.docx",
  }), "artifacts/mszrt6gl/工会活动申请表_最终.docx");

  for (const route of [
    "/resource-viewer/agent-72?chatId=other-chat&file=artifacts%2Freport.docx",
    "/resource-viewer/agent-72?chatId=chat-72&file=artifacts%2F..%2Freport.docx",
    "/resource-viewer/agent-72?chatId=chat-72&file=%2Fetc%2Fhosts",
    "/resource-viewer/agent-72?chatId=chat-72&file=references%2Fsource.pdf",
  ]) {
    assert.equal(resolveChatWorkPanelLocalResourcePath({
      ownerChatId: "chat-72",
      profile: "artifact",
      route,
    }), "");
  }
});

test("local resource request normalization rejects injected and escaping paths", () => {
  const valid = {
    ownerChatId: "chat-72",
    relativePath: "artifacts/run-1/report.docx",
    profile: "artifact",
  };
  assert.deepEqual(normalizeChatWorkPanelOpenLocalResourceRequest(valid), valid);
  assert.equal(normalizeChatWorkPanelOpenLocalResourceRequest({ ...valid, extra: true }), null);
  assert.equal(normalizeChatWorkPanelOpenLocalResourceRequest({ ...valid, ownerChatId: "../chat-72" }), null);
  assert.equal(normalizeChatWorkPanelOpenLocalResourceRequest({ ...valid, relativePath: "artifacts/../report.docx" }), null);
  assert.equal(normalizeChatWorkPanelOpenLocalResourceRequest({ ...valid, relativePath: "references/report.docx" }), null);
});

for (const scenario of [
  {
    name: "macOS",
    platform: "darwin",
    runtimeRoot: "/Users/test/.runtime",
    expectedChatRoot: "/Users/test/.runtime/chats/chat-72",
    expectedPath: "/Users/test/.runtime/chats/chat-72/artifacts/run-1/report.docx",
  },
  {
    name: "Windows",
    platform: "win32",
    runtimeRoot: "D:\\Runtime",
    expectedChatRoot: "D:\\Runtime\\chats\\chat-72",
    expectedPath: "D:\\Runtime\\chats\\chat-72\\artifacts\\run-1\\report.docx",
  },
]) {
  test(`opens the existing ${scenario.name} chat artifact directly without downloading`, async () => {
    const openedPaths = [];
    const result = await openChatWorkPanelResourceInDefaultApp({
      ownerChatId: "chat-72",
      relativePath: "artifacts/run-1/report.docx",
      profile: "artifact",
    }, {
      app: {},
      platform: scenario.platform,
      resolveRuntimeRoot: () => scenario.runtimeRoot,
      existsSync: (targetPath) => targetPath === scenario.expectedChatRoot || targetPath === scenario.expectedPath,
      realpathSync: (targetPath) => targetPath,
      statSync: () => ({ isFile: () => true }),
      openPath: async (targetPath) => {
        openedPaths.push(targetPath);
        return "";
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.path, scenario.expectedPath);
    assert.deepEqual(openedPaths, [scenario.expectedPath]);
  });
}

test("realpath validation rejects a chat artifact symlink escaping the chat directory", async () => {
  const result = await openChatWorkPanelResourceInDefaultApp({
    ownerChatId: "chat-72",
    relativePath: "artifacts/run-1/report.docx",
    profile: "artifact",
  }, {
    app: {},
    platform: "darwin",
    resolveRuntimeRoot: () => "/runtime",
    existsSync: () => true,
    realpathSync: (targetPath) => targetPath.endsWith("report.docx")
      ? "/outside/report.docx"
      : targetPath,
    statSync: () => ({ isFile: () => true }),
    openPath: async () => "",
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "path_outside_chat");
});

test("Windows rejects drive or alternate-stream syntax inside an artifact path", async () => {
  const result = await openChatWorkPanelResourceInDefaultApp({
    ownerChatId: "chat-72",
    relativePath: "artifacts/run-1/report.docx:payload",
    profile: "artifact",
  }, {
    app: {},
    platform: "win32",
    resolveRuntimeRoot: () => "D:\\Runtime",
    openPath: async () => "",
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_request");
});
