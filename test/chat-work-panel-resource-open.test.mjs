import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  resolveChatWorkPanelLocalResourcePath,
  resolveChatWorkPanelLocalResourceProfile,
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
} = await import("../dist-electron/main/modules/work-panel/resource-open.js");

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

test("root uploads retain Reference identity across the bridge and Viewer route", () => {
  const identity = { chatId: "chat-72", profile: "reference", relativePath: "申请表.docx" };
  assert.deepEqual(normalizeAgentWebclientCurrentResourceIdentity(identity), identity);
  assert.deepEqual(normalizeChatWorkPanelOpenLocalResourceRequest({
    ownerChatId: identity.chatId, profile: identity.profile, relativePath: identity.relativePath,
  }), { ownerChatId: "chat-72", profile: "reference", relativePath: "申请表.docx" });
  assert.equal(resolveChatWorkPanelLocalResourcePath({
    ownerChatId: "chat-72", profile: "reference",
    route: `/resource-viewer/agent?chatId=chat-72&file=${encodeURIComponent(encodeURIComponent("申请表.docx"))}`,
  }), "申请表.docx");
  for (const relativePath of ["../secret", "%252e%252e", "uploads/file.txt", "artifacts/run/file.txt"]) {
    assert.equal(normalizeAgentWebclientCurrentResourceIdentity({ ...identity, relativePath }), null);
    assert.equal(normalizeChatWorkPanelOpenLocalResourceRequest({ ownerChatId: "chat-72", profile: "reference", relativePath }), null);
  }
});

for (const platform of ["darwin", "win32"]) {
  test(`root Reference opens and rejects symlink escapes on ${platform}`, async () => {
    const windows = platform === "win32";
    const runtimeRoot = windows ? "D:\\Runtime" : "/runtime";
    const root = windows ? "D:\\Runtime\\chats\\chat-72" : "/runtime/chats/chat-72";
    const file = `${root}${windows ? "\\" : "/"}申请表.docx`;
    const opened = [];
    const dependencies = {
      app: {}, platform, resolveRuntimeRoot: () => runtimeRoot,
      existsSync: (value) => value === root || value === file,
      realpathSync: (value) => value, statSync: () => ({ isFile: () => true }),
      openPath: async (value) => { opened.push(value); return ""; },
    };
    const request = { ownerChatId: "chat-72", profile: "reference", relativePath: "申请表.docx" };
    assert.equal((await openChatWorkPanelResourceInDefaultApp(request, dependencies)).ok, true);
    assert.deepEqual(opened, [file]);
    const escaped = await openChatWorkPanelResourceInDefaultApp(request, { ...dependencies,
      realpathSync: (value) => value === file ? (windows ? "D:\\secret.docx" : "/secret.docx") : value,
    });
    assert.equal(escaped.code, "path_outside_chat");
    assert.equal(opened.length, 1);
  });
}

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

test("current Resource Viewer @chat routes resolve the previewed artifact", () => {
  assert.equal(resolveChatWorkPanelLocalResourcePath({
    ownerChatId: "chat-72",
    profile: "artifact",
    route: "/resource-viewer/cutej?lang=zh-CN&chatId=chat-72&file=%40chat%2Fartifacts%2Fmvykcs0c%2F%E6%9C%AB%E4%BD%8D.md&sourceKind=artifact&resourceId=artifact-72&relativePath=artifacts%2Fmvykcs0c%2F%E6%9C%AB%E4%BD%8D.md&hostTheme=light",
  }), "artifacts/mvykcs0c/末位.md");
});

test("@chat routes preserve literal Unicode, spaces, URL delimiters and percent filenames", () => {
  for (const [profile, directory] of [
    ["artifact", "artifacts/run-1/"],
    ["reference", "references/"],
    ["reference", ""],
  ]) {
    for (const filename of ["末位.md", "申请 表.docx", "notes#draft?.md", "100%.txt", "%20%23%3F.md", "%E6%9C%AB.md"]) {
      const relativePath = `${directory}${filename}`;
      const query = new URLSearchParams({ chatId: "chat-72", file: `@chat/${relativePath}` });
      assert.equal(resolveChatWorkPanelLocalResourcePath({
        ownerChatId: "chat-72", profile, route: `/resource-viewer/agent?${query}`,
      }), relativePath, `${profile}: ${filename}`);
    }
  }
});

test("legacy resource URLs retain their additional filename encoding layer", () => {
  for (const profile of ["artifact", "reference"]) {
    const directory = profile === "artifact" ? "artifacts/run-1/" : "references/";
    const filename = "申请 表 100% #?.docx";
    const query = new URLSearchParams({
      chatId: "chat-72", file: `${directory}${encodeURIComponent(filename)}`,
    });
    assert.equal(resolveChatWorkPanelLocalResourcePath({
      ownerChatId: "chat-72", profile, route: `/resource-viewer/agent?${query}`,
    }), `${directory}${filename}`);
  }
});

test("@chat resource routes keep owner, profile and local path boundaries", () => {
  const routeFor = (file, chatId = "chat-72") => `/resource-viewer/agent?${new URLSearchParams({
    chatId, file, relativePath: "artifacts/run-1/allowed.md", sourceKind: "artifact",
  })}`;
  for (const file of [
    "@chatty/artifacts/run-1/report.md",
    "@chat//artifacts/run-1/report.md",
    "@chat/../other-chat/artifacts/report.md",
    "@chat/artifacts/run-1/../../../secret.md",
    "@chat/references/source.md",
    "@chat/C:/private.md",
    "@chat/artifacts/run-1/../secret.md",
    "@chat/artifacts/run-1/folder\\report.md",
    "@chat/artifacts/run-1/invalid\u0000.md",
    "%40chat%2Fartifacts%2Frun-1%2Freport.md",
  ]) {
    assert.equal(resolveChatWorkPanelLocalResourcePath({
      ownerChatId: "chat-72", profile: "artifact", route: routeFor(file),
    }), "", file);
  }
  assert.equal(resolveChatWorkPanelLocalResourcePath({
    ownerChatId: "chat-72", profile: "artifact",
    route: routeFor("@chat/artifacts/run-1/report.md", "other-chat"),
  }), "");
  assert.equal(resolveChatWorkPanelLocalResourcePath({
    ownerChatId: "chat-72", profile: "reference",
    route: routeFor("@chat/artifacts/run-1/report.md"),
  }), "");
  for (const encodedPath of ["%2e%2e", "%252e%252e", "folder%2freport.md", "folder%5creport.md"]) {
    const relativePath = resolveChatWorkPanelLocalResourcePath({
      ownerChatId: "chat-72", profile: "artifact",
      route: routeFor(`@chat/artifacts/${encodedPath}`),
    });
    assert.equal(normalizeChatWorkPanelOpenLocalResourceRequest({
      ownerChatId: "chat-72", profile: "artifact", relativePath,
    }), null, encodedPath);
  }
});

test("file actions correct only generic artifact descriptors for existing Reference paths", () => {
  const chromeDownload = "chrome-download-8ca640016a93003d4253272a-browser-review-report.txt";
  const genericId = "resource:80:1abc";
  const chatFileId = `chat-file:${"a".repeat(32)}`;
  const routeFor = (file, source = {}) => `/resource-viewer/cutej?${new URLSearchParams({
    chatId: "chat-72", file, ...source,
  })}`;
  for (const scenario of [
    { file: `@chat/${chromeDownload}`, resourceId: genericId, expected: "reference" },
    { file: `@chat/${chromeDownload}`, resourceId: chatFileId, expected: "reference" },
    { file: `@CHAT/${chromeDownload}`, resourceId: genericId, expected: "reference" },
    { file: "@chat/references/申请 表 50%.txt", resourceId: genericId, expected: "reference" },
    { file: "@chat/artifacts/run-1/notes.md", resourceId: genericId, expected: "artifact" },
    { file: encodeURIComponent("申请 表 50%.txt"), resourceId: chatFileId, expected: "reference" },
    { file: "@chat/artifacts/run-1/a%20b.md", resourceId: "artifact-72", expected: "artifact",
      source: { sourceKind: "artifact", resourceId: "artifact-72", relativePath: "artifacts/run-1/a%20b.md" } },
    { profile: "reference", file: "@chat/references/source.txt", resourceId: "reference-72", expected: "reference",
      source: { sourceKind: "reference", resourceId: "reference-72", relativePath: "references/source.txt" } },
    { profile: "reference", file: `@chat/${chromeDownload}`, resourceId: "reference-72", expected: "reference",
      source: { sourceKind: "reference", resourceId: "reference-72", relativePath: chromeDownload } },
    { file: "@chat/artifacts/run-1/notes.md", resourceId: "unknown-typed-id", expected: "artifact" },
    { file: `@chat/${chromeDownload}`, resourceId: "artifact-72", expected: null },
    { file: `@chat/${chromeDownload}`, resourceId: "resource:filename", expected: null },
    { file: `@chat/${chromeDownload}`, resourceId: "resource:0:hash", expected: null },
    { file: `@chat/${chromeDownload}`, resourceId: "chat-file:unknown", expected: null },
    { file: `@chat/${chromeDownload}`, expected: null },
    { file: `@chat/${chromeDownload}`, resourceId: genericId, source: { sourceKind: "artifact" }, expected: null },
    { file: `@chat/${chromeDownload}`, resourceId: genericId, source: { sourceKind: "reference" }, expected: null },
    { file: `@chat/${chromeDownload}`, resourceId: genericId, source: { resourceId: genericId }, expected: null },
    { file: `@chat/${chromeDownload}`, resourceId: genericId, source: { relativePath: chromeDownload }, expected: null },
    { file: "@chat/artifacts/run-1/notes.md", resourceId: genericId, source: { sourceKind: "reference" }, expected: null },
    { file: "@chat/artifacts/run-1/notes.md", resourceId: "artifact-72", source: { resourceId: "another-artifact" }, expected: null },
    { file: "@chat/artifacts/run-1/notes.md", resourceId: "artifact-72", source: { relativePath: "artifacts/run-1/other.md" }, expected: null },
    { file: "@chat/artifacts/run-1/a%20b.md", resourceId: "artifact-72", source: { relativePath: "artifacts/run-1/a b.md" }, expected: null },
    { profile: "reference", file: "@chat/artifacts/run-1/notes.md", resourceId: "reference-72", expected: null },
    { file: "@chat/nested/report.txt", resourceId: genericId, expected: null },
    { file: "@chat/../another-chat/report.txt", resourceId: genericId, expected: null },
    { file: "/etc/hosts", resourceId: genericId, expected: null },
    { file: "https://example.com/report.txt", resourceId: genericId, expected: null },
  ]) {
    assert.equal(resolveChatWorkPanelLocalResourceProfile({
      ownerChatId: "chat-72", profile: scenario.profile || "artifact", resourceId: scenario.resourceId,
      route: routeFor(scenario.file, scenario.source),
    }), scenario.expected, JSON.stringify(scenario));
  }

  for (const suffix of ["&chatId=another-chat", "&file=artifacts%2Frun-1%2Fother.md", "&sourceKind=artifact&sourceKind=reference"]) {
    assert.equal(resolveChatWorkPanelLocalResourceProfile({
      ownerChatId: "chat-72", profile: "artifact", resourceId: genericId,
      route: `${routeFor(`@chat/${chromeDownload}`)}${suffix}`,
    }), null, suffix);
  }
  assert.equal(resolveChatWorkPanelLocalResourceProfile({
    ownerChatId: "another-chat", profile: "artifact", resourceId: genericId,
    route: routeFor(`@chat/${chromeDownload}`),
  }), null);
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

  test(`current @chat artifact route reaches the ${scenario.name} file manager with the exact local path`, async () => {
    const relativePath = "artifacts/mvykcs0c/末位.md";
    const query = new URLSearchParams({ chatId: "chat-72", file: `@chat/${relativePath}` });
    const resolvedPath = resolveChatWorkPanelLocalResourcePath({
      ownerChatId: "chat-72", profile: "artifact", route: `/resource-viewer/cutej?${query}`,
    });
    assert.equal(resolvedPath, relativePath);
    const expectedPath = scenario.platform === "win32"
      ? `${scenario.expectedChatRoot}\\${relativePath.replace(/\//gu, "\\")}`
      : `${scenario.expectedChatRoot}/${relativePath}`;
    const revealedPaths = [];
    const result = await revealChatWorkPanelResourceInFileManager({
      ownerChatId: "chat-72", profile: "artifact", relativePath: resolvedPath,
    }, {
      app: {}, platform: scenario.platform, resolveRuntimeRoot: () => scenario.runtimeRoot,
      existsSync: (value) => value === scenario.expectedChatRoot || value === expectedPath,
      realpathSync: (value) => value, statSync: () => ({ isFile: () => true }),
      showItemInFolder: (value) => revealedPaths.push(value),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(revealedPaths, [expectedPath]);
  });

  test(`generic Chat previews reveal and open the exact ${scenario.name} file with the validated profile`, async () => {
    for (const [relativePath, expectedProfile] of [
      ["chrome-download-8ca640016a93003d4253272a-browser-review-report.txt", "reference"],
      ["references/申请 表 50%.txt", "reference"],
      ["artifacts/run-1/a%20b.md", "artifact"],
    ]) {
      const query = new URLSearchParams({ chatId: "chat-72", file: `@chat/${relativePath}` });
      const route = `/resource-viewer/cutej?${query}`;
      const profile = resolveChatWorkPanelLocalResourceProfile({
        ownerChatId: "chat-72", profile: "artifact", resourceId: "resource:80:1abc", route,
      });
      assert.equal(profile, expectedProfile);
      const resolvedPath = resolveChatWorkPanelLocalResourcePath({ ownerChatId: "chat-72", profile, route });
      assert.equal(resolvedPath, relativePath);
      const expectedPath = scenario.platform === "win32"
        ? `${scenario.expectedChatRoot}\\${relativePath.replace(/\//gu, "\\")}`
        : `${scenario.expectedChatRoot}/${relativePath}`;
      const calls = [];
      const dependencies = {
        app: {}, platform: scenario.platform, resolveRuntimeRoot: () => scenario.runtimeRoot,
        existsSync: (value) => value === scenario.expectedChatRoot || value === expectedPath,
        realpathSync: (value) => value, statSync: () => ({ isFile: () => true }),
        showItemInFolder: (value) => calls.push(["reveal", value]),
        openPath: async (value) => { calls.push(["open", value]); return ""; },
      };
      const request = { ownerChatId: "chat-72", profile, relativePath: resolvedPath };
      assert.equal((await revealChatWorkPanelResourceInFileManager(request, dependencies)).ok, true);
      assert.equal((await openChatWorkPanelResourceInDefaultApp(request, dependencies)).ok, true);
      assert.deepEqual(calls, [["reveal", expectedPath], ["open", expectedPath]]);
    }
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

test("current @chat MP4 routes resolve their literal published path for Finder and Explorer", async () => {
  const ownerChatId = "chat-video";
  for (const platform of ["darwin", "win32"]) {
    const runtimeRoot = platform === "darwin" ? "/Users/test/.cutej" : "C:\\Users\\test\\.cutej";
    for (const filename of ["期货公司标准解读_连续配音版_修订版.mp4", "100%完整 #1.mp4", "%E4%B8%AD.mp4"]) {
      const relativePath = `artifacts/run-video/${filename}`;
      const route = `/resource-viewer/cutej?${new URLSearchParams({ chatId: ownerChatId, file: `@chat/${relativePath}` })}`;
      assert.equal(resolveChatWorkPanelLocalResourcePath({ ownerChatId, profile: "artifact", route }), relativePath);
      const revealed = [];
      const path = await import("node:path");
      const pathApi = platform === "darwin" ? path.posix : path.win32;
      const filePath = pathApi.join(runtimeRoot, "chats", ownerChatId, ...relativePath.split("/"));
      const result = await revealChatWorkPanelResourceInFileManager({ ownerChatId, profile: "artifact", relativePath }, {
        app: {}, platform, resolveRuntimeRoot: () => runtimeRoot,
        existsSync: () => true, realpathSync: target => target, statSync: () => ({ isFile: () => true }),
        showItemInFolder: target => revealed.push(target),
      });
      assert.equal(result.ok, true);
      assert.deepEqual(revealed, [filePath]);
      assert.equal(resolveChatWorkPanelLocalResourcePath({ ownerChatId: "other-chat", profile: "artifact", route }), "");
      assert.equal(resolveChatWorkPanelLocalResourcePath({ ownerChatId, profile: "reference", route }), "");
    }
  }
  for (const relativePath of ["artifacts/../secret.mp4", "artifacts/%252e%252e/secret.mp4", "artifacts/%2fetc/secret.mp4"]) {
    const route = `/resource-viewer/cutej?${new URLSearchParams({ chatId: ownerChatId, file: `@chat/${relativePath}` })}`;
    const resolved = resolveChatWorkPanelLocalResourcePath({ ownerChatId, profile: "artifact", route });
    assert.equal(normalizeChatWorkPanelOpenLocalResourceRequest({ ownerChatId, profile: "artifact", relativePath: resolved }), null);
  }
});
