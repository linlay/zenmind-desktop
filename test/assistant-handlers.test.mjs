import test from "node:test";
import assert from "node:assert/strict";

const { registerAssistantIpcHandlers } = await import("../dist-electron/main/ipc/assistant-handlers.js");

// ---------------------------------------------------------------------------
// Helper: build a mock ipcMain that collects registered handlers
// ---------------------------------------------------------------------------
function makeMockIpcMain() {
  const handlers = {};
  return {
    ipc: {
      handle(channel, callback) {
        handlers[channel] = callback;
      }
    },
    handlers
  };
}

// ---------------------------------------------------------------------------
// 1. currentPage — pure state handlers (tracer bullet)
// ---------------------------------------------------------------------------
test("currentPage.publishSnapshot stores snapshot and currentPage.getSnapshot returns it", async () => {
  const { ipc, handlers } = makeMockIpcMain();

  registerAssistantIpcHandlers(ipc, {
    assistantBridge: null,
    assistantNavigationStatusClient: null,
    desktopActionRendererRequests: new Map(),
    desktopActionOptions: {},
    app: null,
    mainWindow: null,
    shell: null,
    showFileDialog: null,
    callAgentPlatform: null,
    handleDesktopActionRequest: null,
    DESKTOP_ACTION_DEFINITIONS: [],
    emitAssistantAttachmentProgress: null,
    getAssistantSettings: null,
    saveAssistantSettings: null,
    getAgentPlatformMinimaxSettingsPublic: null,
    resolveAssistantAttachmentPath: null,
    createAssistantAttachmentFromPastedImage: null,
    cancelAssistantAttachmentTask: null,
    createAssistantAttachmentsFromFiles: null,
    captureAssistantScreenshot: null,
    platform: "linux"
  });

  assert.ok(handlers["currentPage.publishSnapshot"], "Should register currentPage.publishSnapshot");
  assert.ok(handlers["currentPage.getSnapshot"], "Should register currentPage.getSnapshot");

  // Initially null
  const initial = await handlers["currentPage.getSnapshot"]({});
  assert.equal(initial, null);

  // Publish a snapshot
  const snapshot = { url: "https://example.com", title: "Example" };
  const publishResult = await handlers["currentPage.publishSnapshot"]({}, snapshot);
  assert.deepEqual(publishResult, { ok: true });

  // Should now return the stored snapshot
  const stored = await handlers["currentPage.getSnapshot"]({});
  assert.deepEqual(stored, snapshot);

  // Publish a new snapshot overwrites the old one
  const snapshot2 = { url: "https://other.com", title: "Other" };
  await handlers["currentPage.publishSnapshot"]({}, snapshot2);
  const stored2 = await handlers["currentPage.getSnapshot"]({});
  assert.deepEqual(stored2, snapshot2);
});

// ---------------------------------------------------------------------------
// 2. assistant.getSettings — delegates to bridge or settings store
// ---------------------------------------------------------------------------
test("assistant.getSettings returns minimax public settings when available", async () => {
  const { ipc, handlers } = makeMockIpcMain();

  const minimaxSettings = { provider: "minimax", model: "abab6.5s" };
  const fallbackSettings = { provider: "default", model: "gpt-4o" };

  registerAssistantIpcHandlers(ipc, {
    assistantBridge: null,
    assistantNavigationStatusClient: null,
    desktopActionRendererRequests: new Map(),
    desktopActionOptions: {},
    app: {},
    mainWindow: null,
    shell: null,
    showFileDialog: null,
    callAgentPlatform: null,
    handleDesktopActionRequest: null,
    DESKTOP_ACTION_DEFINITIONS: [],
    emitAssistantAttachmentProgress: null,
    getAssistantSettings: () => fallbackSettings,
    saveAssistantSettings: null,
    getAgentPlatformMinimaxSettingsPublic: () => minimaxSettings,
    resolveAssistantAttachmentPath: null,
    createAssistantAttachmentFromPastedImage: null,
    cancelAssistantAttachmentTask: null,
    createAssistantAttachmentsFromFiles: null,
    captureAssistantScreenshot: null,
    platform: "linux"
  });

  const result = await handlers["assistant.getSettings"]({});
  assert.deepEqual(result, minimaxSettings);
});

test("assistant.getSettings falls back to default settings when minimax returns null", async () => {
  const { ipc, handlers } = makeMockIpcMain();

  const fallbackSettings = { provider: "default", model: "gpt-4o" };

  registerAssistantIpcHandlers(ipc, {
    assistantBridge: null,
    assistantNavigationStatusClient: null,
    desktopActionRendererRequests: new Map(),
    desktopActionOptions: {},
    app: {},
    mainWindow: null,
    shell: null,
    showFileDialog: null,
    callAgentPlatform: null,
    handleDesktopActionRequest: null,
    DESKTOP_ACTION_DEFINITIONS: [],
    emitAssistantAttachmentProgress: null,
    getAssistantSettings: () => fallbackSettings,
    saveAssistantSettings: null,
    getAgentPlatformMinimaxSettingsPublic: () => null,
    resolveAssistantAttachmentPath: null,
    createAssistantAttachmentFromPastedImage: null,
    cancelAssistantAttachmentTask: null,
    createAssistantAttachmentsFromFiles: null,
    captureAssistantScreenshot: null,
    platform: "linux"
  });

  const result = await handlers["assistant.getSettings"]({});
  assert.deepEqual(result, fallbackSettings);
});

// ---------------------------------------------------------------------------
// 3. assistant.listAgents — returns [] on error
// ---------------------------------------------------------------------------
test("assistant.listAgents returns agent list on success", async () => {
  const { ipc, handlers } = makeMockIpcMain();

  const agentList = [{ key: "agent-1" }, { key: "agent-2" }];
  const mockBridge = {
    async listAgents() { return agentList; }
  };

  registerAssistantIpcHandlers(ipc, {
    assistantBridge: mockBridge,
    assistantNavigationStatusClient: null,
    desktopActionRendererRequests: new Map(),
    desktopActionOptions: {},
    app: {},
    mainWindow: null,
    shell: null,
    showFileDialog: null,
    callAgentPlatform: null,
    handleDesktopActionRequest: null,
    DESKTOP_ACTION_DEFINITIONS: [],
    emitAssistantAttachmentProgress: null,
    getAssistantSettings: null,
    saveAssistantSettings: null,
    getAgentPlatformMinimaxSettingsPublic: () => null,
    resolveAssistantAttachmentPath: null,
    createAssistantAttachmentFromPastedImage: null,
    cancelAssistantAttachmentTask: null,
    createAssistantAttachmentsFromFiles: null,
    captureAssistantScreenshot: null,
    platform: "linux"
  });

  const result = await handlers["assistant.listAgents"]({});
  assert.deepEqual(result, agentList);
});

test("assistant.listAgents returns empty array when bridge throws", async () => {
  const { ipc, handlers } = makeMockIpcMain();

  const mockBridge = {
    async listAgents() { throw new Error("network error"); }
  };

  registerAssistantIpcHandlers(ipc, {
    assistantBridge: mockBridge,
    assistantNavigationStatusClient: null,
    desktopActionRendererRequests: new Map(),
    desktopActionOptions: {},
    app: {},
    mainWindow: null,
    shell: null,
    showFileDialog: null,
    callAgentPlatform: null,
    handleDesktopActionRequest: null,
    DESKTOP_ACTION_DEFINITIONS: [],
    emitAssistantAttachmentProgress: null,
    getAssistantSettings: null,
    saveAssistantSettings: null,
    getAgentPlatformMinimaxSettingsPublic: () => null,
    resolveAssistantAttachmentPath: null,
    createAssistantAttachmentFromPastedImage: null,
    cancelAssistantAttachmentTask: null,
    createAssistantAttachmentsFromFiles: null,
    captureAssistantScreenshot: null,
    platform: "linux"
  });

  const result = await handlers["assistant.listAgents"]({});
  assert.deepEqual(result, []);
});

// ---------------------------------------------------------------------------
// 4. assistant.listNavigationAgents — cache hit / miss / error
// ---------------------------------------------------------------------------
test("assistant.listNavigationAgents returns cached snapshot when available", async () => {
  const { ipc, handlers } = makeMockIpcMain();

  const cachedResult = { ok: true, items: [{ key: "nav-agent" }], updatedAt: "2024-01-01" };
  const mockNavClient = {
    getSnapshot() { return cachedResult; },
    async refreshNow() { throw new Error("should not call refreshNow"); }
  };

  registerAssistantIpcHandlers(ipc, {
    assistantBridge: { async listNavigationAgents() { throw new Error("should not call bridge"); } },
    assistantNavigationStatusClient: mockNavClient,
    desktopActionRendererRequests: new Map(),
    desktopActionOptions: {},
    app: {},
    mainWindow: null,
    shell: null,
    showFileDialog: null,
    callAgentPlatform: null,
    handleDesktopActionRequest: null,
    DESKTOP_ACTION_DEFINITIONS: [],
    emitAssistantAttachmentProgress: null,
    getAssistantSettings: null,
    saveAssistantSettings: null,
    getAgentPlatformMinimaxSettingsPublic: () => null,
    resolveAssistantAttachmentPath: null,
    createAssistantAttachmentFromPastedImage: null,
    cancelAssistantAttachmentTask: null,
    createAssistantAttachmentsFromFiles: null,
    captureAssistantScreenshot: null,
    platform: "linux"
  });

  const result = await handlers["assistant.listNavigationAgents"]({});
  assert.deepEqual(result, cachedResult);
});

test("assistant.listNavigationAgents returns error shape on failure", async () => {
  const { ipc, handlers } = makeMockIpcMain();

  const mockNavClient = {
    getSnapshot() { return null; },
    async refreshNow() { throw new Error("server down"); }
  };

  registerAssistantIpcHandlers(ipc, {
    assistantBridge: { async listNavigationAgents() { throw new Error("fallback also failed"); } },
    assistantNavigationStatusClient: mockNavClient,
    desktopActionRendererRequests: new Map(),
    desktopActionOptions: {},
    app: {},
    mainWindow: null,
    shell: null,
    showFileDialog: null,
    callAgentPlatform: null,
    handleDesktopActionRequest: null,
    DESKTOP_ACTION_DEFINITIONS: [],
    emitAssistantAttachmentProgress: null,
    getAssistantSettings: null,
    saveAssistantSettings: null,
    getAgentPlatformMinimaxSettingsPublic: () => null,
    resolveAssistantAttachmentPath: null,
    createAssistantAttachmentFromPastedImage: null,
    cancelAssistantAttachmentTask: null,
    createAssistantAttachmentsFromFiles: null,
    captureAssistantScreenshot: null,
    platform: "linux"
  });

  const result = await handlers["assistant.listNavigationAgents"]({});
  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.items));
  assert.equal(result.items.length, 0);
  assert.ok(result.message.includes("server down"));
});

// ---------------------------------------------------------------------------
// 5. desktopActions.respond — resolves / rejects pending requests
// ---------------------------------------------------------------------------
test("desktopActions.respond resolves a pending renderer request", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const pendingRequests = new Map();

  registerAssistantIpcHandlers(ipc, {
    assistantBridge: null,
    assistantNavigationStatusClient: null,
    desktopActionRendererRequests: pendingRequests,
    desktopActionOptions: {},
    app: null,
    mainWindow: null,
    shell: null,
    showFileDialog: null,
    callAgentPlatform: null,
    handleDesktopActionRequest: null,
    DESKTOP_ACTION_DEFINITIONS: [],
    emitAssistantAttachmentProgress: null,
    getAssistantSettings: null,
    saveAssistantSettings: null,
    getAgentPlatformMinimaxSettingsPublic: null,
    resolveAssistantAttachmentPath: null,
    createAssistantAttachmentFromPastedImage: null,
    cancelAssistantAttachmentTask: null,
    createAssistantAttachmentsFromFiles: null,
    captureAssistantScreenshot: null,
    platform: "linux"
  });

  // Simulate a pending renderer request
  let resolvedValue = null;
  pendingRequests.set("req-abc", {
    resolve(val) { resolvedValue = val; },
    timeout: null
  });

  const response = { requestId: "req-abc", action: "click", ok: true };
  const result = await handlers["desktopActions.respond"]({}, response);

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(resolvedValue, response);
  assert.equal(pendingRequests.has("req-abc"), false, "Pending request should be removed");
});

test("desktopActions.respond returns ok:false when requestId missing", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const pendingRequests = new Map();

  registerAssistantIpcHandlers(ipc, {
    assistantBridge: null,
    assistantNavigationStatusClient: null,
    desktopActionRendererRequests: pendingRequests,
    desktopActionOptions: {},
    app: null,
    mainWindow: null,
    shell: null,
    showFileDialog: null,
    callAgentPlatform: null,
    handleDesktopActionRequest: null,
    DESKTOP_ACTION_DEFINITIONS: [],
    emitAssistantAttachmentProgress: null,
    getAssistantSettings: null,
    saveAssistantSettings: null,
    getAgentPlatformMinimaxSettingsPublic: null,
    resolveAssistantAttachmentPath: null,
    createAssistantAttachmentFromPastedImage: null,
    cancelAssistantAttachmentTask: null,
    createAssistantAttachmentsFromFiles: null,
    captureAssistantScreenshot: null,
    platform: "linux"
  });

  const result = await handlers["desktopActions.respond"]({}, { ok: true });
  assert.deepEqual(result, { ok: false });
});

test("desktopActions.respond returns ok:false when request not in pending map", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const pendingRequests = new Map();

  registerAssistantIpcHandlers(ipc, {
    assistantBridge: null,
    assistantNavigationStatusClient: null,
    desktopActionRendererRequests: pendingRequests,
    desktopActionOptions: {},
    app: null,
    mainWindow: null,
    shell: null,
    showFileDialog: null,
    callAgentPlatform: null,
    handleDesktopActionRequest: null,
    DESKTOP_ACTION_DEFINITIONS: [],
    emitAssistantAttachmentProgress: null,
    getAssistantSettings: null,
    saveAssistantSettings: null,
    getAgentPlatformMinimaxSettingsPublic: null,
    resolveAssistantAttachmentPath: null,
    createAssistantAttachmentFromPastedImage: null,
    cancelAssistantAttachmentTask: null,
    createAssistantAttachmentsFromFiles: null,
    captureAssistantScreenshot: null,
    platform: "linux"
  });

  const result = await handlers["desktopActions.respond"]({}, { requestId: "unknown-id", ok: true });
  assert.deepEqual(result, { ok: false });
});

// ---------------------------------------------------------------------------
// 6. desktopActions.list — returns DESKTOP_ACTION_DEFINITIONS
// ---------------------------------------------------------------------------
test("desktopActions.list returns action definitions", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const definitions = [{ name: "click" }, { name: "type" }];

  registerAssistantIpcHandlers(ipc, {
    assistantBridge: null,
    assistantNavigationStatusClient: null,
    desktopActionRendererRequests: new Map(),
    desktopActionOptions: {},
    app: null,
    mainWindow: null,
    shell: null,
    showFileDialog: null,
    callAgentPlatform: null,
    handleDesktopActionRequest: null,
    DESKTOP_ACTION_DEFINITIONS: definitions,
    emitAssistantAttachmentProgress: null,
    getAssistantSettings: null,
    saveAssistantSettings: null,
    getAgentPlatformMinimaxSettingsPublic: null,
    resolveAssistantAttachmentPath: null,
    createAssistantAttachmentFromPastedImage: null,
    cancelAssistantAttachmentTask: null,
    createAssistantAttachmentsFromFiles: null,
    captureAssistantScreenshot: null,
    platform: "linux"
  });

  const result = await handlers["desktopActions.list"]({});
  assert.deepEqual(result, { ok: true, actions: definitions });
});

// ---------------------------------------------------------------------------
// 7. desktopActions.call — delegates to handleDesktopActionRequest
// ---------------------------------------------------------------------------
test("desktopActions.call delegates to handleDesktopActionRequest", async () => {
  const { ipc, handlers } = makeMockIpcMain();

  let capturedOptions = null;
  let capturedRequest = null;

  registerAssistantIpcHandlers(ipc, {
    assistantBridge: null,
    assistantNavigationStatusClient: null,
    desktopActionRendererRequests: new Map(),
    desktopActionOptions: { foo: "bar" },
    app: null,
    mainWindow: null,
    shell: null,
    showFileDialog: null,
    callAgentPlatform: null,
    handleDesktopActionRequest: async (opts, req) => {
      capturedOptions = opts;
      capturedRequest = req;
      return { ok: true, action: req.action };
    },
    DESKTOP_ACTION_DEFINITIONS: [],
    emitAssistantAttachmentProgress: null,
    getAssistantSettings: null,
    saveAssistantSettings: null,
    getAgentPlatformMinimaxSettingsPublic: null,
    resolveAssistantAttachmentPath: null,
    createAssistantAttachmentFromPastedImage: null,
    cancelAssistantAttachmentTask: null,
    createAssistantAttachmentsFromFiles: null,
    captureAssistantScreenshot: null,
    platform: "linux"
  });

  const request = { action: "click", target: "#btn" };
  const result = await handlers["desktopActions.call"]({}, request);

  assert.deepEqual(capturedOptions, { foo: "bar" });
  assert.deepEqual(capturedRequest, request);
  assert.deepEqual(result, { ok: true, action: "click" });
});

// ---------------------------------------------------------------------------
// 8. assistant.openMemoryDirectory — always returns legacy stub response
// ---------------------------------------------------------------------------
test("assistant.openMemoryDirectory returns deprecation stub", async () => {
  const { ipc, handlers } = makeMockIpcMain();

  registerAssistantIpcHandlers(ipc, {
    assistantBridge: null,
    assistantNavigationStatusClient: null,
    desktopActionRendererRequests: new Map(),
    desktopActionOptions: {},
    app: null,
    mainWindow: null,
    shell: null,
    showFileDialog: null,
    callAgentPlatform: null,
    handleDesktopActionRequest: null,
    DESKTOP_ACTION_DEFINITIONS: [],
    emitAssistantAttachmentProgress: null,
    getAssistantSettings: null,
    saveAssistantSettings: null,
    getAgentPlatformMinimaxSettingsPublic: null,
    resolveAssistantAttachmentPath: null,
    createAssistantAttachmentFromPastedImage: null,
    cancelAssistantAttachmentTask: null,
    createAssistantAttachmentsFromFiles: null,
    captureAssistantScreenshot: null,
    platform: "linux"
  });

  const result = await handlers["assistant.openMemoryDirectory"]({});
  assert.equal(result.ok, false);
  assert.ok(typeof result.message === "string" && result.message.length > 0);
  assert.equal(result.path, "");
});

// ---------------------------------------------------------------------------
// 9. assistant.markAgentChatsRead — triggers nav status refresh on success
// ---------------------------------------------------------------------------
test("assistant.markAgentChatsRead calls scheduleRefresh on success", async () => {
  const { ipc, handlers } = makeMockIpcMain();

  let refreshScheduled = false;
  const mockBridge = {
    async markAgentChatsRead(agentKey) {
      return { ok: true, agentKey };
    }
  };
  const mockNavClient = {
    scheduleRefresh(ms) { refreshScheduled = true; }
  };

  registerAssistantIpcHandlers(ipc, {
    assistantBridge: mockBridge,
    assistantNavigationStatusClient: mockNavClient,
    desktopActionRendererRequests: new Map(),
    desktopActionOptions: {},
    app: {},
    mainWindow: null,
    shell: null,
    showFileDialog: null,
    callAgentPlatform: null,
    handleDesktopActionRequest: null,
    DESKTOP_ACTION_DEFINITIONS: [],
    emitAssistantAttachmentProgress: null,
    getAssistantSettings: null,
    saveAssistantSettings: null,
    getAgentPlatformMinimaxSettingsPublic: () => null,
    resolveAssistantAttachmentPath: null,
    createAssistantAttachmentFromPastedImage: null,
    cancelAssistantAttachmentTask: null,
    createAssistantAttachmentsFromFiles: null,
    captureAssistantScreenshot: null,
    platform: "linux"
  });

  const result = await handlers["assistant.markAgentChatsRead"]({}, "agent-key-1");
  assert.deepEqual(result, { ok: true, agentKey: "agent-key-1" });
  assert.equal(refreshScheduled, true);
});

test("assistant.markAgentChatsRead does NOT call scheduleRefresh on failure", async () => {
  const { ipc, handlers } = makeMockIpcMain();

  let refreshScheduled = false;
  const mockBridge = {
    async markAgentChatsRead() { return { ok: false }; }
  };
  const mockNavClient = {
    scheduleRefresh() { refreshScheduled = true; }
  };

  registerAssistantIpcHandlers(ipc, {
    assistantBridge: mockBridge,
    assistantNavigationStatusClient: mockNavClient,
    desktopActionRendererRequests: new Map(),
    desktopActionOptions: {},
    app: {},
    mainWindow: null,
    shell: null,
    showFileDialog: null,
    callAgentPlatform: null,
    handleDesktopActionRequest: null,
    DESKTOP_ACTION_DEFINITIONS: [],
    emitAssistantAttachmentProgress: null,
    getAssistantSettings: null,
    saveAssistantSettings: null,
    getAgentPlatformMinimaxSettingsPublic: () => null,
    resolveAssistantAttachmentPath: null,
    createAssistantAttachmentFromPastedImage: null,
    cancelAssistantAttachmentTask: null,
    createAssistantAttachmentsFromFiles: null,
    captureAssistantScreenshot: null,
    platform: "linux"
  });

  await handlers["assistant.markAgentChatsRead"]({}, "agent-key-1");
  assert.equal(refreshScheduled, false);
});
