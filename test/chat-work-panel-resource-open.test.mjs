import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  resolveChatWorkPanelLocalResourcePath,
  shouldShowChatWorkPanelLocalResourceActions,
} = require("../dist-electron/shared/chat-work-panel-tab-context-menu.js");
const {
  AGENT_WEBCLIENT_CURRENT_RESOURCE_ACTION_REQUEST_TYPE,
  AGENT_WEBCLIENT_CURRENT_RESOURCE_ACTION_RESPONSE_TYPE,
  isServiceWebviewBridgeRequestType,
  isServiceWebviewBridgeResponseType,
  normalizeAgentWebclientCurrentResourceIdentity,
} = require("../dist-electron/shared/service-webview-bridge.js");
const {
  normalizeChatWorkPanelOpenLocalResourceRequest,
  openChatWorkPanelResourceInDefaultApp,
  revealChatWorkPanelResourceInFileManager,
} = await import("../dist-electron/main/chat-work-panel-resource-open.js");

test("current resource actions use the allowlisted Service WebView bridge without absolute paths", () => {
  assert.equal(
    AGENT_WEBCLIENT_CURRENT_RESOURCE_ACTION_REQUEST_TYPE,
    "desktop:agent-webclient:current-resource:action",
  );
  assert.equal(
    AGENT_WEBCLIENT_CURRENT_RESOURCE_ACTION_RESPONSE_TYPE,
    "desktop:agent-webclient:current-resource:action:response",
  );
  assert.equal(
    isServiceWebviewBridgeRequestType(AGENT_WEBCLIENT_CURRENT_RESOURCE_ACTION_REQUEST_TYPE),
    true,
  );
  assert.equal(
    isServiceWebviewBridgeResponseType(AGENT_WEBCLIENT_CURRENT_RESOURCE_ACTION_RESPONSE_TYPE),
    true,
  );
});

test("current resource bridge accepts only chat-scoped Artifact/Reference identities", () => {
  assert.deepEqual(normalizeAgentWebclientCurrentResourceIdentity({
    chatId: "chat-72",
    profile: "artifact",
    relativePath: "artifacts/run-1/report.docx",
  }), {
    chatId: "chat-72",
    profile: "artifact",
    relativePath: "artifacts/run-1/report.docx",
  });
  for (const request of [
    { chatId: "../chat-72", profile: "artifact", relativePath: "artifacts/run-1/report.docx" },
    { chatId: "chat-72", profile: "artifact", relativePath: "artifacts/../report.docx" },
    { chatId: "chat-72", profile: "artifact", relativePath: "artifacts/%252e%252e/report.docx" },
    { chatId: "chat-72", profile: "artifact", relativePath: "references/report.docx" },
  ]) {
    assert.equal(normalizeAgentWebclientCurrentResourceIdentity(request), null);
  }
});

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

test("local resource actions appear only for formats Resource Viewer cannot preview", () => {
  const routeFor = (filename) =>
    `/resource-viewer/agent-72?chatId=chat-72&file=${encodeURIComponent(`artifacts/run-1/${filename}`)}`;
  for (const filename of [
    "dashboard.html",
    "document.pdf",
    "photo.png",
    "notes.md",
    "data.json",
    "recording.mp3",
    "demo.mp4",
  ]) {
    assert.equal(shouldShowChatWorkPanelLocalResourceActions({
      ownerChatId: "chat-72",
      profile: "artifact",
      route: routeFor(filename),
    }), false, filename);
  }
  for (const filename of [
    "slides.pptx",
    "document.docx",
    "workbook.xlsx",
    "archive.zip",
    "unknown-resource",
  ]) {
    assert.equal(shouldShowChatWorkPanelLocalResourceActions({
      ownerChatId: "chat-72",
      profile: "artifact",
      route: routeFor(filename),
    }), true, filename);
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
  assert.equal(normalizeChatWorkPanelOpenLocalResourceRequest({ ...valid, relativePath: "artifacts/%2e%2e/report.docx" }), null);
  assert.equal(normalizeChatWorkPanelOpenLocalResourceRequest({ ...valid, relativePath: "artifacts/%252e%252e/report.docx" }), null);
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
    assert.equal("path" in result, false);
    assert.deepEqual(openedPaths, [scenario.expectedPath]);
  });

  test(`reveals the existing ${scenario.name} chat artifact in the file manager`, async () => {
    const revealedPaths = [];
    const result = await revealChatWorkPanelResourceInFileManager({
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
      showItemInFolder: (targetPath) => revealedPaths.push(targetPath),
    });

    assert.equal(result.ok, true);
    assert.equal("path" in result, false);
    assert.deepEqual(revealedPaths, [scenario.expectedPath]);
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

test("reveal does not hand an escaping chat artifact symlink to the file manager", async () => {
  const revealedPaths = [];
  const result = await revealChatWorkPanelResourceInFileManager({
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
    showItemInFolder: (targetPath) => revealedPaths.push(targetPath),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "path_outside_chat");
  assert.deepEqual(revealedPaths, []);
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

test("reference resources use the same validated local open flow", async () => {
  const openedPaths = [];
  const expectedPath = "/runtime/chats/chat-72/references/source.docx";
  const result = await openChatWorkPanelResourceInDefaultApp({
    ownerChatId: "chat-72",
    relativePath: "references/source.docx",
    profile: "reference",
  }, {
    app: {},
    platform: "darwin",
    resolveRuntimeRoot: () => "/runtime",
    existsSync: (targetPath) => targetPath === "/runtime/chats/chat-72" || targetPath === expectedPath,
    realpathSync: (targetPath) => targetPath,
    statSync: () => ({ isFile: () => true }),
    openPath: async (targetPath) => {
      openedPaths.push(targetPath);
      return "";
    },
  });

  assert.equal(result.ok, true);
  assert.equal("path" in result, false);
  assert.deepEqual(openedPaths, [expectedPath]);
});

test("missing and non-file resources fail without exposing a local path", async () => {
  const request = {
    ownerChatId: "chat-72",
    relativePath: "artifacts/run-1/report.docx",
    profile: "artifact",
  };
  const baseDependencies = {
    app: {},
    platform: "darwin",
    resolveRuntimeRoot: () => "/runtime",
    realpathSync: (targetPath) => targetPath,
    openPath: async () => "",
  };
  const missing = await openChatWorkPanelResourceInDefaultApp(request, {
    ...baseDependencies,
    existsSync: () => false,
  });
  assert.equal(missing.code, "not_found");
  assert.equal("path" in missing, false);
  assert.equal(JSON.stringify(missing).includes("/runtime"), false);

  const notFile = await openChatWorkPanelResourceInDefaultApp(request, {
    ...baseDependencies,
    existsSync: () => true,
    statSync: () => ({ isFile: () => false }),
  });
  assert.equal(notFile.code, "not_file");
  assert.equal("path" in notFile, false);
  assert.equal(JSON.stringify(notFile).includes("/runtime"), false);
});

test("shell failures are localized and do not expose their absolute path", async () => {
  const absolutePath = "/runtime/chats/chat-72/artifacts/run-1/report.docx";
  const request = {
    ownerChatId: "chat-72",
    relativePath: "artifacts/run-1/report.docx",
    profile: "artifact",
  };
  const dependencies = {
    app: {},
    platform: "darwin",
    resolveRuntimeRoot: () => "/runtime",
    existsSync: () => true,
    realpathSync: (targetPath) => targetPath,
    statSync: () => ({ isFile: () => true }),
  };
  const openResult = await openChatWorkPanelResourceInDefaultApp(request, {
    ...dependencies,
    openPath: async () => `failed to open ${absolutePath}`,
  });

  assert.equal(openResult.ok, false);
  assert.equal(openResult.code, "open_failed");
  assert.equal("path" in openResult, false);
  assert.equal(JSON.stringify(openResult).includes(absolutePath), false);

  const revealResult = await revealChatWorkPanelResourceInFileManager(request, {
    ...dependencies,
    showItemInFolder: () => {
      throw new Error(`failed to reveal ${absolutePath}`);
    },
  });
  assert.equal(revealResult.ok, false);
  assert.equal(revealResult.code, "open_failed");
  assert.equal("path" in revealResult, false);
  assert.equal(JSON.stringify(revealResult).includes(absolutePath), false);
});
