import test from "node:test";
import assert from "node:assert/strict";

const { registerAgentPlatformIpcHandlers, __testInternals } =
  await import("../dist-electron/main/ipc/agent-platform-handlers.js");

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

test("agentPlatform.request forwards allowed GET requests with query params", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const calls = [];

  registerAgentPlatformIpcHandlers(ipc, {
    app: { name: "app" },
    callAgentPlatform: async (app, path, options) => {
      calls.push({ app, path, options });
      return [{ key: "agent-a" }];
    }
  });

  const result = await handlers["agentPlatform.request"]({}, {
    path: "/api/agents",
    method: "GET",
    query: { scope: "all", includeChats: 1, empty: "" }
  });

  assert.deepEqual(result, { ok: true, data: [{ key: "agent-a" }] });
  assert.deepEqual(calls, [{
    app: { name: "app" },
    path: "/api/agents?scope=all&includeChats=1",
    options: { method: "GET" }
  }]);
});

test("agentPlatform.request forwards allowed POST request bodies", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  const calls = [];

  registerAgentPlatformIpcHandlers(ipc, {
    app: {},
    callAgentPlatform: async (_app, path, options) => {
      calls.push({ path, options });
      return { id: "automation-a" };
    }
  });

  const result = await handlers["agentPlatform.request"]({}, {
    path: "/api/automation/create",
    method: "POST",
    body: { name: "Daily" }
  });

  assert.deepEqual(result, { ok: true, data: { id: "automation-a" } });
  assert.deepEqual(calls, [{
    path: "/api/automation/create",
    options: { method: "POST", body: { name: "Daily" } }
  }]);
});

test("agentPlatform.request rejects unsupported paths before calling platform", async () => {
  const { ipc, handlers } = makeMockIpcMain();
  let called = false;

  registerAgentPlatformIpcHandlers(ipc, {
    app: {},
    callAgentPlatform: async () => {
      called = true;
      return null;
    }
  });

  const result = await handlers["agentPlatform.request"]({}, {
    path: "/api/query",
    method: "POST",
    body: { message: "not for this native page" }
  });

  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.message, "agent-platform endpoint is not allowed: POST /api/query");
});

test("agentPlatform.request converts platform errors to ok false", async () => {
  const { ipc, handlers } = makeMockIpcMain();

  registerAgentPlatformIpcHandlers(ipc, {
    app: {},
    callAgentPlatform: async () => {
      throw new Error("agent-platform is not running");
    }
  });

  const result = await handlers["agentPlatform.request"]({}, {
    path: "/api/agents",
    method: "GET"
  });

  assert.deepEqual(result, {
    ok: false,
    message: "agent-platform is not running"
  });
});

test("normalizeAgentPlatformRequest blocks non-api and absolute URLs", () => {
  assert.throws(
    () => __testInternals.normalizeAgentPlatformRequest({ path: "https://example.com/api/agents" }),
    /agent-platform path must start with \/api\//
  );
  assert.throws(
    () => __testInternals.normalizeAgentPlatformRequest({ path: "/monitor" }),
    /agent-platform path must start with \/api\//
  );
});
