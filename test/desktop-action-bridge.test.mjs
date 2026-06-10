import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const projectRoot = process.cwd();
const require = createRequire(import.meta.url);
const {
  handleDesktopActionRequest,
  handleDesktopCdpRequest,
  __testInternals
} = require("../dist-electron/main/desktop-action-bridge.js");
const { DESKTOP_ACTION_DEFINITIONS } = require("../dist-electron/shared/desktop-actions.js");
const { staticSiteHostManager } = require("../dist-electron/main/static-site-host-manager.js");

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function createBridgeOptions(overrides = {}) {
  return {
    app: {},
    assistantBridge: {},
    getMainWindow: () => null,
    getCurrentPageSnapshot: () => null,
    navigate: () => {},
    openLogViewer: async () => ({ ok: true }),
    callRendererAction: async () => ({ ok: false }),
    executeCdpCommand: async () => ({
      targetId: "zenmind-test",
      surfaceId: "surface-test",
      result: { value: 42 }
    }),
    ...overrides
  };
}

test("Desktop action catalog exposes embedded web actions but not page actions", () => {
  const names = DESKTOP_ACTION_DEFINITIONS.map((definition) => definition.name);
  assert.equal(names.some((name) => name.startsWith("desktop.page.")), false);
  assert.ok(names.includes("desktop.embeddedWeb.listSurfaces"));
  assert.ok(names.includes("desktop.embeddedWeb.navigate"));
  assert.ok(names.includes("desktop.embeddedWeb.interactElement"));
  assert.ok(names.includes("desktop.controlCenter.listServices"));
  assert.ok(names.includes("desktop.staticServer.list"));
  assert.ok(names.includes("desktop.staticServer.start"));
  assert.ok(names.includes("desktop.staticServer.stop"));
  assert.ok(names.includes("desktop.staticServer.restart"));
  assert.ok(names.includes("desktop.agents.deleteAgent"));
});

test("Desktop Action Bridge uses current agent-platform agent CRUD API paths", () => {
  const source = fs.readFileSync(path.join(projectRoot, "src", "main", "desktop-action-bridge.ts"), "utf8");

  assert.match(source, /"\/api\/agent\/create"/);
  assert.match(source, /"\/api\/agent\/update"/);
  assert.match(source, /"\/api\/agent\/delete"/);
  assert.doesNotMatch(source, /\/api\/agent-create/);
  assert.doesNotMatch(source, /\/api\/agent-update/);
  assert.doesNotMatch(source, /\/api\/agent-delete/);
});

test("agent-platform fetch retries once with a refreshed token after unauthorized", async () => {
  const calls = [];
  const issuedReasons = [];

  const result = await __testInternals.fetchAgentPlatformWithAuth("http://127.0.0.1:7078", "/api/automations", {
    method: "POST",
    body: { search: "daily" },
    issueToken: async (reason) => {
      issuedReasons.push(reason);
      return { ok: true, token: `${reason}-token` };
    },
    fetchImpl: async (url, init) => {
      calls.push({
        url,
        authorization: init.headers.Authorization,
        body: init.body
      });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ code: 0, data: { items: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });

  assert.deepEqual(result, { items: [] });
  assert.deepEqual(issuedReasons, ["missing", "unauthorized"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].authorization, "Bearer missing-token");
  assert.equal(calls[1].authorization, "Bearer unauthorized-token");
  assert.equal(calls[0].body, JSON.stringify({ search: "daily" }));
  assert.equal(calls[1].body, JSON.stringify({ search: "daily" }));
});

test("agent-platform fetch stops after one unauthorized retry", async () => {
  let fetchCount = 0;

  await assert.rejects(
    () => __testInternals.fetchAgentPlatformWithAuth("http://127.0.0.1:7078", "/api/automations", {
      method: "POST",
      body: {},
      issueToken: async (reason) => ({ ok: true, token: `${reason}-token` }),
      fetchImpl: async () => {
        fetchCount += 1;
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        });
      }
    }),
    /agent-platform 鉴权失败，请重启智能体平台后重试。/
  );

  assert.equal(fetchCount, 2);
});

test("agent-platform fetch does not refresh token for non-auth failures", async () => {
  const issuedReasons = [];

  await assert.rejects(
    () => __testInternals.fetchAgentPlatformWithAuth("http://127.0.0.1:7078", "/api/automations", {
      method: "POST",
      body: {},
      issueToken: async (reason) => {
        issuedReasons.push(reason);
        return { ok: true, token: `${reason}-token` };
      },
      fetchImpl: async () => new Response("service unavailable", { status: 503 })
    }),
    /service unavailable/
  );

  assert.deepEqual(issuedReasons, ["missing"]);
});

test("Desktop Action Bridge uses responsive service reads for agent-platform read paths", () => {
  const source = fs.readFileSync(path.join(projectRoot, "src", "main", "desktop-action-bridge.ts"), "utf8");

  assert.match(source, /getResponsiveServiceState/);
  assert.match(source, /await getResponsiveServiceState\(app, "agent-platform"\)/);
  assert.doesNotMatch(source, /const state = await getServiceState\(app, "agent-platform"\)/);
});

test("Desktop Action Bridge rejects page actions", async () => {
  const response = await handleDesktopActionRequest(createBridgeOptions(), {
    action: "desktop.page.readCurrent",
    args: {}
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "unknown_action");
});

test("Desktop Action Bridge forwards embedded web actions to renderer providers", async () => {
  let got;
  const response = await handleDesktopActionRequest(createBridgeOptions({
    callRendererAction: async (request) => {
      got = request;
      return {
        requestId: request.requestId,
        action: request.action,
        ok: true,
        result: { surfaces: [{ id: "browser", label: "Browser" }] }
      };
    }
  }), {
    requestId: "embedded-web-test",
    action: "desktop.embeddedWeb.listSurfaces",
    args: { surfaceId: "browser" }
  });

  assert.equal(response.ok, true);
  assert.equal(response.action, "desktop.embeddedWeb.listSurfaces");
  assert.deepEqual(response.result, { surfaces: [{ id: "browser", label: "Browser" }] });
  assert.deepEqual(got, {
    requestId: "embedded-web-test",
    action: "desktop.embeddedWeb.listSurfaces",
    args: { surfaceId: "browser" },
    source: undefined
  });
});

test("Desktop Action Bridge dispatches static server actions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-static-action-"));
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><h1>Bridge</h1>\n", "utf8");
  const port = await getFreePort();

  try {
    const started = await handleDesktopActionRequest(createBridgeOptions(), {
      action: "desktop.staticServer.start",
      permissionMode: "full_access",
      args: {
        rootDir: root,
        siteId: "bridge-preview",
        port
      }
    });
    assert.equal(started.ok, true);
    assert.equal(started.result.siteId, "bridge-preview");
    assert.equal(started.result.port, port);
    assert.equal(started.result.webUrl, `http://127.0.0.1:${port}/`);

    const page = await fetch(started.result.webUrl);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Bridge/u);

    const listed = await handleDesktopActionRequest(createBridgeOptions(), {
      action: "desktop.staticServer.list",
      args: {}
    });
    assert.equal(listed.ok, true);
    assert.equal(listed.result.some((site) => site.siteId === "bridge-preview" && site.running), true);

    const stopped = await handleDesktopActionRequest(createBridgeOptions(), {
      action: "desktop.staticServer.stop",
      permissionMode: "full_access",
      args: { siteId: "bridge-preview" }
    });
    assert.equal(stopped.ok, true);
    assert.equal(stopped.result.running, false);
  } finally {
    await staticSiteHostManager.stopAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Desktop CDP Bridge executes CDP calls", async () => {
  let got;
  const response = await handleDesktopCdpRequest(createBridgeOptions({
    executeCdpCommand: async (request) => {
      got = request;
      return {
        targetId: "zenmind-target",
        surfaceId: "surface-a",
        result: { type: "number", value: 42 }
      };
    }
  }), {
    method: "Runtime.evaluate",
    params: { expression: "6 * 7" },
    targetId: "zenmind-target",
    sessionId: "ignored-by-http-bridge",
    surfaceId: "surface-a"
  });

  assert.equal(response.ok, true);
  assert.equal(response.method, "Runtime.evaluate");
  assert.equal(response.targetId, "zenmind-target");
  assert.equal(response.surfaceId, "surface-a");
  assert.deepEqual(response.result, { type: "number", value: 42 });
  assert.deepEqual(got, {
    method: "Runtime.evaluate",
    params: { expression: "6 * 7" },
    targetId: "zenmind-target",
    surfaceId: "surface-a"
  });
});

test("Desktop CDP Bridge requires method", async () => {
  const response = await handleDesktopCdpRequest(createBridgeOptions(), {
    params: { expression: "document.title" }
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "invalid_args");
});
