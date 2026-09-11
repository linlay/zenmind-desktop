import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  buildCoderProjectAgentCreateRequest,
  buildProjectAgentCreateRequest
} = require("../dist-electron/main/modules/assistant/coder-project.js");
const {
  registerAssistantIpcHandlers
} = require("../dist-electron/main/modules/assistant/ipc.js");
const {
  __testInternals: deprecatedCompatibilityInternals,
  setDeprecatedCompatibilityDesktopVersion
} = require("../dist-electron/main/support/logging/deprecated-compatibility.js");

function registerProjectHandlers({
  assistantBridge = {},
  assistantNavigationStatusClient,
  callAgentPlatform,
} = {}) {
  const handlers = new Map();
  const calls = [];
  const ipcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    }
  };

  registerAssistantIpcHandlers(ipcMain, {
    assistantBridge,
    conversationShare: {
      exportChatHtml() {}, create() {}, list() {}, revoke() {},
    },
    assistantNavigationStatusClient: assistantNavigationStatusClient ?? {
      scheduleRefresh(delay) {
        calls.push({ path: "scheduleRefresh", delay });
      }
    },
    desktopActionRendererRequests: new Map(),
    getCurrentPageSnapshot: null,
    setCurrentPageSnapshot: null,
    reportRendererDiagnostic: null,
    desktopActionOptions: {},
    app: {
      once(event, listener) {
        if (event === "will-quit") queueMicrotask(() => void listener());
      }
    },
    mainWindow: null,
    shell: null,
    showFileDialog: null,
    callAgentPlatform: callAgentPlatform
      ? async (_app, endpoint, options) => {
          calls.push({ path: endpoint, options });
          return callAgentPlatform(endpoint, options);
        }
      : async (_app, endpoint, options) => {
          calls.push({ path: endpoint, options });
          if (endpoint === "/api/admin/agents/create") {
            return {
              key: "created-agent",
              definition: options.body.definition
            };
          }
          throw new Error(`unexpected endpoint ${endpoint}`);
        },
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
    platform: "darwin"
  });

  return { calls, handlers };
}

test("buildProjectAgentCreateRequest builds a minimal CODER project create request", () => {
  const request = buildProjectAgentCreateRequest("coder", "/Users/demo/Project/agent-coder");

  assert.deepEqual(request, {
    definition: {
      mode: "CODER",
      runtimeConfig: {
        workspaceRoot: "/Users/demo/Project/agent-coder"
      }
    }
  });
  assert.equal(JSON.stringify(request).includes("coderBackend"), false);
  assert.equal(Object.hasOwn(request.definition, "name"), false);
  assert.equal(Object.hasOwn(request.definition, "icon"), false);
  assert.equal(Object.hasOwn(request.definition, "workspace"), false);
  assert.equal(Object.hasOwn(request.definition, "visibility"), false);
});

test("buildProjectAgentCreateRequest includes ACP only for CODER projects", () => {
  const request = buildProjectAgentCreateRequest("coder", "/Users/demo/Project/acp-coder", {
    acpProxyId: "codex"
  });

  assert.deepEqual(request, {
    definition: {
      mode: "CODER",
      runtimeConfig: {
        workspaceRoot: "/Users/demo/Project/acp-coder",
        acpProxyId: "codex"
      }
    }
  });
  assert.equal(JSON.stringify(request).includes("coderBackend"), false);
});

test("buildProjectAgentCreateRequest builds a minimal KBASE project create request", () => {
  const request = buildProjectAgentCreateRequest("kbase", "/Users/demo/Knowledge/my-project", {
    acpProxyId: "codex"
  });

  assert.deepEqual(request, {
    definition: {
      mode: "KBASE",
      runtimeConfig: {
        workspaceRoot: "/Users/demo/Knowledge/my-project"
      }
    }
  });
  assert.equal(Object.hasOwn(request.definition, "name"), false);
  assert.equal(Object.hasOwn(request.definition, "icon"), false);
  assert.equal(Object.hasOwn(request.definition, "workspace"), false);
  assert.equal(Object.hasOwn(request.definition, "kbaseConfig"), false);
  assert.equal(JSON.stringify(request).includes("openai"), false);
});

test("legacy buildCoderProjectAgentCreateRequest delegates to the minimal CODER request", () => {
  const request = buildCoderProjectAgentCreateRequest("/Users/demo/Project/agent-coder", {
    acpProxyId: "claude"
  });

  assert.deepEqual(request, {
    definition: {
      mode: "CODER",
      runtimeConfig: {
        workspaceRoot: "/Users/demo/Project/agent-coder",
        acpProxyId: "claude"
      }
    }
  });
});

test("assistant.createProject creates a KBASE project without updating generated defaults", async () => {
  const { calls, handlers } = registerProjectHandlers();
  const handler = handlers.get("assistant.createProject");
  assert.equal(typeof handler, "function");

  const result = await handler(null, {
    projectType: "kbase",
    workspaceDir: "/Users/demo/Knowledge/my-project"
  });

  assert.equal(result.ok, true);
  assert.equal(result.agentKey, "created-agent");
  assert.equal(calls[0].path, "/api/admin/agents/create");
  assert.deepEqual(calls[0].options.body, {
    definition: {
      mode: "KBASE",
      runtimeConfig: {
        workspaceRoot: "/Users/demo/Knowledge/my-project"
      }
    }
  });
  assert.deepEqual(calls[1], { path: "scheduleRefresh", delay: 0 });
  assert.equal(calls.some((call) => call.path === "/api/admin/agents/update"), false);
});

test("assistant.createProject creates a CODER ACP project with the simplified payload", async () => {
  const { calls, handlers } = registerProjectHandlers();
  const handler = handlers.get("assistant.createProject");
  assert.equal(typeof handler, "function");

  const result = await handler(null, {
    projectType: "coder",
    workspaceDir: "/Users/demo/Project/acp-coder",
    acpProxyId: "codex"
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].path, "/api/admin/agents/create");
  assert.deepEqual(calls[0].options.body, {
    definition: {
      mode: "CODER",
      runtimeConfig: {
        workspaceRoot: "/Users/demo/Project/acp-coder",
        acpProxyId: "codex"
      }
    }
  });
  assert.deepEqual(calls[1], { path: "scheduleRefresh", delay: 0 });
  assert.equal(calls.some((call) => call.path === "/api/admin/agents/update"), false);
});

test("assistant.createCoderProject remains a compatibility alias for CODER creation", async () => {
  deprecatedCompatibilityInternals.resetDesktopVersion();
  setDeprecatedCompatibilityDesktopVersion("0.3.60");
  deprecatedCompatibilityInternals.clearReportedCompatibilityUses();
  const { calls, handlers } = registerProjectHandlers();
  const handler = handlers.get("assistant.createCoderProject");
  assert.equal(typeof handler, "function");

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  let result;
  try {
    result = await handler(null, {
      name: "ignored-name",
      workspaceDir: "/Users/demo/Project/legacy-coder",
      acpProxyId: "claude"
    });
    await handler(null, {
      name: "ignored-name",
      workspaceDir: "/Users/demo/Project/legacy-coder",
      acpProxyId: "claude"
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result.ok, true);
  assert.equal(calls[0].path, "/api/admin/agents/create");
  assert.deepEqual(calls[0].options.body, {
    definition: {
      mode: "CODER",
      runtimeConfig: {
        workspaceRoot: "/Users/demo/Project/legacy-coder",
        acpProxyId: "claude"
      }
    }
  });
  assert.deepEqual(calls[1], { path: "scheduleRefresh", delay: 0 });
  assert.equal(calls.some((call) => call.path === "/api/admin/agents/update"), false);
  assert.deepEqual(warnings, [[
    "[deprecated-compatibility]",
    { id: "assistant.createCoderProject", desktopVersion: "0.3.60" }
  ]]);
  deprecatedCompatibilityInternals.resetDesktopVersion();
});

test("assistant IPC rethrows time contract violations while keeping ordinary navigation failures structured", async () => {
  const timeViolation = new Error("time_contract_violation: navigation.chats[1].updatedAt must be epoch_ms_int64");
  const { handlers } = registerProjectHandlers({
    assistantBridge: {
      async listCopilotAgents() {
        throw timeViolation;
      },
    },
    assistantNavigationStatusClient: {
      getSnapshot() {
        return { ok: false };
      },
      async refreshNow() {
        throw timeViolation;
      },
      scheduleRefresh() {},
    },
  });

  await assert.rejects(
    handlers.get("assistant.listNavigationAgents")(),
    /time_contract_violation: navigation\.chats\[1\]\.updatedAt/u,
  );
  await assert.rejects(
    handlers.get("assistant.listCopilotAgents")(),
    /time_contract_violation: navigation\.chats\[1\]\.updatedAt/u,
  );

  const ordinaryFailure = new Error("agent-platform unavailable");
  const ordinary = registerProjectHandlers({
    assistantBridge: {
      async listCopilotAgents() {
        throw ordinaryFailure;
      },
    },
    assistantNavigationStatusClient: {
      getSnapshot() {
        return { ok: false };
      },
      async refreshNow() {
        throw ordinaryFailure;
      },
      scheduleRefresh() {},
    },
  });
  const navigationResult = await ordinary.handlers.get("assistant.listNavigationAgents")();
  const copilotResult = await ordinary.handlers.get("assistant.listCopilotAgents")();
  assert.equal(navigationResult.ok, false);
  assert.equal(copilotResult.ok, false);
  assert.equal(typeof navigationResult.updatedAt, "number");
  assert.equal(typeof copilotResult.updatedAt, "number");
});

test("assistant.listNavigationAgents force refresh bypasses the cached navigation snapshot", async () => {
  const cachedResult = { ok: true, items: [{ agentKey: "cached" }] };
  const refreshedResult = { ok: true, items: [{ agentKey: "fresh" }] };
  let snapshotReads = 0;
  let refreshCalls = 0;
  const { handlers } = registerProjectHandlers({
    assistantNavigationStatusClient: {
      getSnapshot() {
        snapshotReads += 1;
        return cachedResult;
      },
      async refreshNow() {
        refreshCalls += 1;
        return refreshedResult;
      },
      scheduleRefresh() {},
    },
  });
  const handler = handlers.get("assistant.listNavigationAgents");

  assert.equal(await handler(null), cachedResult);
  assert.equal(snapshotReads, 1);
  assert.equal(refreshCalls, 0);

  assert.equal(await handler(null, { force: true }), refreshedResult);
  assert.equal(snapshotReads, 1);
  assert.equal(refreshCalls, 1);
});

test("assistant.reorderProjects writes the public valid catalog while preserving non-Project slots", async () => {
  const { calls, handlers } = registerProjectHandlers({
    async callAgentPlatform(endpoint, options) {
      if (endpoint === "/api/agents?scope=nav&mode=CODER&mode=KBASE") {
        return [{ key: "coder-a" }, { key: "coder-new" }, { key: "kbase-b" }];
      }
      if (endpoint === "/api/agents/order" && !options) {
        return {
          order: ["chat-a", "coder-a", "hidden-agent", "coder-new", "kbase-b"],
        };
      }
      if (endpoint === "/api/agents/order") {
        assert.equal(options.method, "PUT");
        assert.deepEqual(options.body, {
          order: [
            "chat-a",
            "kbase-b",
            "hidden-agent",
            "coder-a",
            "coder-new",
          ],
        });
        return {
          order: ["chat-a", "kbase-b", "hidden-agent", "coder-a", "coder-new"],
          updatedAt: 1_783_000_000_000,
        };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
  });

  const result = await handlers.get("assistant.reorderProjects")(null, {
    agentKeys: ["kbase-b", "coder-a"],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.agentKeys, ["kbase-b", "coder-a", "coder-new"]);
  assert.equal(result.updatedAt, 1_783_000_000_000);
  assert.equal(typeof result.message, "string");
  assert.ok(result.message.length > 0);
  assert.equal(
    calls.some((call) => call.path.startsWith("/api/admin/agents")),
    false,
  );
  assert.deepEqual(calls.at(-1), { path: "scheduleRefresh", delay: 0 });
});

test("assistant.reorderProjects rejects invalid requests before reading Agent Platform", async () => {
  const { calls, handlers } = registerProjectHandlers();

  const result = await handlers.get("assistant.reorderProjects")(null, {
    agentKeys: ["coder-a", "coder-a"],
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /duplicate agent keys/u);
  assert.equal(calls.length, 0);
});

test("assistant.reorderProjects maps stale and Platform failures to structured results", async () => {
  const stale = registerProjectHandlers({
    async callAgentPlatform(endpoint) {
      if (endpoint === "/api/agents?scope=nav&mode=CODER&mode=KBASE") {
        return [{ key: "coder-a" }];
      }
      if (endpoint === "/api/agents/order") {
        return { order: ["coder-a", "chat-a"] };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
  });
  const staleResult = await stale.handlers.get("assistant.reorderProjects")(null, {
    agentKeys: ["deleted-project"],
  });
  assert.equal(staleResult.ok, false);
  assert.match(staleResult.message, /no longer available: deleted-project/u);
  assert.equal(
    stale.calls.some((call) => call.path === "/api/agents/order" && call.options?.method === "PUT"),
    false,
  );

  const platformFailure = registerProjectHandlers({
    async callAgentPlatform(endpoint, options) {
      if (endpoint === "/api/agents?scope=nav&mode=CODER&mode=KBASE") {
        return [{ key: "coder-a" }];
      }
      if (endpoint === "/api/agents/order" && !options) {
        return { order: ["coder-a"] };
      }
      throw new Error("agent-platform rejected order");
    },
  });
  const platformResult = await platformFailure.handlers.get("assistant.reorderProjects")(null, {
    agentKeys: ["coder-a"],
  });
  assert.equal(platformResult.ok, false);
  assert.equal(platformResult.message, "agent-platform rejected order");
});
