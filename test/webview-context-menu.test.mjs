import test from "node:test";
import assert from "node:assert/strict";

const {
  buildWebviewContextMenuPolicy,
  isDesktopTabUrl,
  isExternalApplicationUrl,
  isSafeMediaDownloadUrl
} = await import("../dist-electron/main/webview-context-menu-policy.js");
const {
  getWebviewContextMenuAccelerator,
  validateWebviewContextMenuSemanticResponse
} = await import("../dist-electron/main/webview-context-menu-controller.js");
const {
  createBrowserSurfaceRegistry
} = await import("../dist-electron/main/browser-surface-registry.js");
const {
  createSurfaceIdentity
} = await import("../dist-electron/shared/surface-identity.js");

function context(patch = {}) {
  return {
    surfaceType: "service",
    trustedAgentWebclient: false,
    isEditable: false,
    editFlags: {
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: false,
      canPaste: false,
      canSelectAll: false
    },
    selectionText: "",
    linkURL: "",
    mediaURL: "",
    mediaType: "none",
    hasImageContents: false,
    pageURL: "http://127.0.0.1:7788/ui/",
    canGoBack: false,
    canGoForward: false,
    semanticTarget: null,
    ...patch
  };
}

function ids(value) {
  return buildWebviewContextMenuPolicy(value).map((item) => item.id);
}

test("editable menu only includes Electron-enabled edit commands", () => {
  assert.deepEqual(ids(context({
    isEditable: true,
    editFlags: {
      canUndo: true,
      canRedo: false,
      canCut: true,
      canCopy: true,
      canPaste: false,
      canSelectAll: true
    }
  })), ["edit.undo", "edit.cut", "edit.copy", "edit.select-all"]);
});

test("selection suppresses message and code copy semantics", () => {
  assert.deepEqual(ids(context({
    selectionText: "selected",
    semanticTarget: {
      version: 1,
      targetId: "message:1",
      kind: "message",
      capabilities: ["content.copy"]
    }
  })), ["selection.copy"]);
});

test("agent webclient message, code, workspace and resource targets use fixed actions", () => {
  assert.deepEqual(ids(context({
    trustedAgentWebclient: true,
    semanticTarget: {
      version: 1,
      targetId: "message:1",
      kind: "message",
      capabilities: ["content.copy"]
    }
  })), ["content.copy"]);
  assert.deepEqual(ids(context({
    trustedAgentWebclient: true,
    semanticTarget: {
      version: 1,
      targetId: "code:1",
      kind: "code",
      capabilities: ["code.copy"]
    }
  })), ["code.copy"]);
  assert.deepEqual(ids(context({
    trustedAgentWebclient: true,
    semanticTarget: {
      version: 1,
      targetId: "workspace:1",
      kind: "workspace-file",
      capabilities: ["workspace.preview", "workspace.copy-path"]
    }
  })), ["workspace.preview", "workspace.copy-path"]);
  assert.deepEqual(ids(context({
    trustedAgentWebclient: true,
    semanticTarget: {
      version: 1,
      targetId: "resource:1",
      kind: "chat-resource",
      capabilities: ["resource.preview", "resource.download"]
    }
  })), ["resource.preview", "resource.download"]);
});

test("link policy separates browser, trusted webclient and generic service surfaces", () => {
  const linkURL = "https://example.test/docs";
  assert.deepEqual(ids(context({ surfaceType: "browser", linkURL })), [
    "link.open-current",
    "link.open-desktop-tab",
    "link.open-external",
    "link.copy"
  ]);
  assert.deepEqual(ids(context({ surfaceType: "chat-work-panel", linkURL })), [
    "link.open-current",
    "link.open-desktop-tab",
    "link.open-external",
    "link.copy"
  ]);
  assert.deepEqual(ids(context({
    trustedAgentWebclient: true,
    linkURL,
    semanticTarget: {
      version: 1,
      targetId: "link:1",
      kind: "web-link",
      url: linkURL,
      capabilities: ["link.preview"]
    }
  })), [
    "link.open-current",
    "link.open-desktop-tab",
    "link.open-external",
    "link.copy"
  ]);
  assert.deepEqual(ids(context({ linkURL })), [
    "link.open-desktop-tab",
    "link.open-external",
    "link.copy"
  ]);
});

test("media and blank-page policy do not expose unsafe URLs", () => {
  assert.deepEqual(ids(context({
    surfaceType: "browser",
    mediaType: "image",
    hasImageContents: true,
    mediaURL: "blob:http://example.test/secret"
  })), ["media.copy-image"]);
  assert.deepEqual(ids(context({
    surfaceType: "browser",
    canGoBack: true,
    canGoForward: true,
    pageURL: "https://example.test/"
  })), ["page.back", "page.forward", "page.reload", "page.copy-url"]);
  assert.deepEqual(ids(context({
    surfaceType: "chat-work-panel",
    canGoBack: true,
    canGoForward: true,
    pageURL: "https://example.test/"
  })), ["page.back", "page.forward", "page.reload", "page.copy-url"]);
  assert.deepEqual(ids(context()), ["page.reload"]);
  assert.deepEqual(ids(context({
    linkURL: "http://127.0.0.1:7788/api/resource?ticket=secret"
  })), []);
  assert.deepEqual(ids(context({
    mediaType: "image",
    hasImageContents: true,
    mediaURL: "http://127.0.0.1:7788/api/resource?ticket=secret"
  })), ["media.copy-image"]);
});

test("URL protocol allowlists reject executable and local schemes", () => {
  assert.equal(isDesktopTabUrl("https://example.test"), true);
  assert.equal(isDesktopTabUrl("mailto:test@example.test"), false);
  assert.equal(isExternalApplicationUrl("mailto:test@example.test"), true);
  assert.equal(isExternalApplicationUrl("tel:+123456"), true);
  assert.equal(isExternalApplicationUrl("javascript:alert(1)"), false);
  assert.equal(isExternalApplicationUrl("file:///tmp/secret"), false);
  assert.equal(isSafeMediaDownloadUrl("data:text/plain,secret"), false);
});

test("macOS and Windows expose explicit native edit accelerators", () => {
  assert.equal(getWebviewContextMenuAccelerator("darwin", "edit.copy"), "Command+C");
  assert.equal(getWebviewContextMenuAccelerator("darwin", "edit.redo"), "Shift+Command+Z");
  assert.equal(getWebviewContextMenuAccelerator("win32", "edit.copy"), "Ctrl+C");
  assert.equal(getWebviewContextMenuAccelerator("win32", "edit.redo"), "Ctrl+Y");
});

test("semantic response validator accepts v1 whitelist and rejects forged or oversized data", () => {
  const response = {
    version: 1,
    requestId: "request-1",
    target: {
      version: 1,
      targetId: "message:1",
      kind: "message",
      capabilities: ["content.copy"]
    }
  };
  assert.deepEqual(validateWebviewContextMenuSemanticResponse(response, "request-1"), response.target);
  assert.equal(validateWebviewContextMenuSemanticResponse({
    ...response,
    target: { ...response.target, capabilities: ["resource.download"] }
  }, "request-1"), undefined);
  assert.equal(validateWebviewContextMenuSemanticResponse({
    ...response,
    menuTitle: "Forged"
  }, "request-1"), undefined);
  assert.equal(validateWebviewContextMenuSemanticResponse({
    ...response,
    target: { ...response.target, text: "secret" }
  }, "request-1"), undefined);
  assert.equal(validateWebviewContextMenuSemanticResponse({
    ...response,
    target: { ...response.target, targetId: "x".repeat(129) }
  }, "request-1"), undefined);
});

test("surface registry reverse index follows replacement and rejects cross-surface guest reuse", () => {
  const guests = new Map([
    [41, { id: 41, getType: () => "webview", isDestroyed: () => false }],
    [42, { id: 42, getType: () => "webview", isDestroyed: () => false }]
  ]);
  const registry = createBrowserSurfaceRegistry({
    webContents: {
      getAllWebContents: () => [...guests.values()],
      fromId: (id) => guests.get(id)
    },
    listWebEntries: () => ({ items: [] }),
    getCurrentPageSnapshot: () => null
  });
  const registration = (identity, guestId, surfaceType = "agent-chat") => ({
    registrationId: "generation-1",
    ...identity,
    surfaceKind: "service",
    surfaceType,
    serviceId: "agent-webclient",
    pageRoute: "/chat",
    label: "Chat",
    url: "http://127.0.0.1:7788/",
    active: true,
    tabs: [{
      tabId: "chat",
      currentUrl: "http://127.0.0.1:7788/ui/",
      title: "Chat",
      webContentsId: guestId,
      canGoBack: false,
      canGoForward: false,
      isLoading: false
    }],
    activeTabId: "chat"
  });
  const mainChat = createSurfaceIdentity("main-chat");
  const copilotChat = createSurfaceIdentity("copilot-chat");
  assert.equal(registry.registerSurface(registration(mainChat, 41), 7), true);
  assert.equal(registry.resolveWebviewSurfaceTarget(41).registrationId, "generation-1");
  assert.equal(registry.registerSurface(registration(copilotChat, 41, "agent-copilot"), 7), false);
  assert.equal(registry.registerSurface(registration(mainChat, 42), 7), true);
  assert.equal(registry.resolveWebviewSurfaceTarget(41), null);
  assert.equal(registry.resolveWebviewSurfaceTarget(42).registrationId, "generation-1");
});
