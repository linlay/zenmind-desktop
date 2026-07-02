import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  buildCoderProjectAgentCreateRequest,
  buildProjectAgentCreateRequest
} = require("../dist-electron/main/assistant/core/coder-project.js");
const {
  registerAssistantIpcHandlers
} = require("../dist-electron/main/ipc/assistant-handlers.js");

function registerProjectHandlers() {
  const handlers = new Map();
  const calls = [];
  const ipcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    }
  };

  registerAssistantIpcHandlers(ipcMain, {
    assistantBridge: {},
    assistantNavigationStatusClient: {
      scheduleRefresh(delay) {
        calls.push({ path: "scheduleRefresh", delay });
      }
    },
    desktopActionRendererRequests: new Map(),
    getCurrentPageSnapshot: null,
    setCurrentPageSnapshot: null,
    reportRendererDiagnostic: null,
    desktopActionOptions: {},
    app: {},
    mainWindow: null,
    shell: null,
    showFileDialog: null,
    async callAgentPlatform(_app, endpoint, options) {
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
  const { calls, handlers } = registerProjectHandlers();
  const handler = handlers.get("assistant.createCoderProject");
  assert.equal(typeof handler, "function");

  const result = await handler(null, {
    name: "ignored-name",
    workspaceDir: "/Users/demo/Project/legacy-coder",
    acpProxyId: "claude"
  });

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
});
