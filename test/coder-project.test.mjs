import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  buildCoderProjectAgentCreateRequest,
  normalizeCoderProjectName,
  workspaceNameFromPath
} = require("../dist-electron/main/assistant/core/coder-project.js");
const {
  registerAssistantIpcHandlers
} = require("../dist-electron/main/ipc/assistant-handlers.js");

test("workspaceNameFromPath derives a project name from the selected directory", () => {
  assert.equal(workspaceNameFromPath("/Users/jialin/Desktop/proxy-acp-claudecode"), "proxy-acp-claudecode");
});

test("buildCoderProjectAgentCreateRequest pins a valid default CODER model key", () => {
  const request = buildCoderProjectAgentCreateRequest("/Users/jialin/Desktop/proxy-acp-claudecode");

  assert.equal(request.definition.modelConfig.modelKey, "th-deepseek-v4-pro");
  assert.notEqual(request.definition.modelConfig.modelKey, "deepseek-v4-pro");
});

test("buildCoderProjectAgentCreateRequest keeps an edited project name", () => {
  const request = buildCoderProjectAgentCreateRequest("/Users/jialin/Desktop/pan-webclient", {
    name: "agent-webclient1"
  });

  assert.equal(request.definition.name, "agent-webclient1");
  assert.equal(request.definition.runtimeConfig.workspaceRoot, "/Users/jialin/Desktop/pan-webclient");
});

test("normalizeCoderProjectName maps legacy pan webclient names to agent webclient names", () => {
  assert.equal(normalizeCoderProjectName("pan-webclient"), "agent-webclient");
  assert.equal(normalizeCoderProjectName("pan-webclient1"), "agent-webclient1");
  assert.equal(normalizeCoderProjectName("agent-platform"), "agent-platform");
});

test("assistant.createCoderProject writes the edited project name back after platform creation", async () => {
  const handlers = new Map();
  const ipcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    }
  };
  const calls = [];
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
          key: "coder-test",
          definition: {
            key: "coder-test",
            name: "pan-webclient",
            mode: "CODER",
            runtimeConfig: {
              workspaceRoot: "/Users/jialin/Desktop/pan-webclient"
            }
          }
        };
      }
      if (endpoint === "/api/admin/agents/update") {
        return {
          key: "coder-test",
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

  const handler = handlers.get("assistant.createCoderProject");
  assert.equal(typeof handler, "function");

  const result = await handler(null, {
    name: "pan-webclient1",
    workspaceDir: "/Users/jialin/Desktop/pan-webclient"
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].path, "/api/admin/agents/create");
  assert.equal(calls[0].options.body.definition.name, "agent-webclient1");
  assert.equal(calls[1].path, "/api/admin/agents/update");
  assert.equal(calls[1].options.body.key, "coder-test");
  assert.equal(calls[1].options.body.definition.name, "agent-webclient1");
  assert.equal(calls[1].options.body.definition.runtimeConfig.workspaceRoot, "/Users/jialin/Desktop/pan-webclient");
  assert.deepEqual(calls[2], { path: "scheduleRefresh", delay: 0 });
});
