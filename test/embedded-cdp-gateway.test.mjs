import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { EmbeddedCdpGateway } = require("../dist-electron/main/embedded-cdp-gateway.js");

class FakeDebugger extends EventEmitter {
  attached = false;
  attachVersion = "";
  detached = false;
  sent = [];

  isAttached() {
    return this.attached;
  }

  attach(version) {
    this.attached = true;
    this.attachVersion = version;
  }

  detach() {
    this.detached = true;
    this.attached = false;
  }

  async sendCommand(method, params) {
    this.sent.push({ method, params });
    return {
      method,
      params
    };
  }
}

function createFakeWebContents(debuggerRef, id = 42) {
  return {
    id,
    debugger: debuggerRef,
    isDestroyed: () => false,
    getType: () => "webview",
    getURL: () => "https://example.test/app",
    getTitle: () => "Example App",
    focus: () => {}
  };
}

async function createStartedGateway(options) {
  const gateway = new EmbeddedCdpGateway({
    host: "127.0.0.1",
    port: 0,
    version: "ZenMind/Test Electron/Test",
    ...options
  });
  const server = gateway.start();
  if (!server.listening) {
    await once(server, "listening");
  }
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  return {
    gateway,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

function waitForWebSocketOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
}

function waitForWebSocketMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      try {
        resolve(JSON.parse(String(event.data)));
      } catch (error) {
        reject(error);
      }
    }, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
}

function closeWebSocket(socket) {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    socket.addEventListener("close", resolve, { once: true });
    socket.close();
  });
}

test("EmbeddedCdpGateway lists only registered embedded targets with navigation metadata", async () => {
  const surfaces = [
    {
      id: "surface-a",
      label: "Alpha",
      url: "https://alpha.test/",
      kind: "webview",
      active: true,
      title: "Alpha App",
      webContentsId: 101,
      agentKey: "agent-alpha",
      surfaceRoute: "/agents"
    },
    {
      id: "surface-b",
      label: "Beta",
      url: "https://beta.test/",
      kind: "webview",
      active: false,
      webContentsId: 102,
      agentKey: "agent-beta"
    }
  ];
  const { gateway, baseUrl } = await createStartedGateway({
    getSurfaces: () => surfaces,
    resolveWebContents: () => null
  });

  try {
    const response = await fetch(`${baseUrl}/json/list`);
    assert.equal(response.status, 200);
    const targets = await response.json();
    assert.equal(targets.length, 2);
    assert.deepEqual(targets.map((target) => target.surfaceId), ["surface-a", "surface-b"]);
    assert.deepEqual(targets.map((target) => target.agentKey), ["agent-alpha", "agent-beta"]);
    assert.equal(Object.hasOwn(targets[0], "webContentsId"), false);
    assert.equal(targets[0].surfaceRoute, "/agents");
    assert.equal(Object.hasOwn(targets[0], "navigationRoute"), false);
    assert.equal(Object.hasOwn(targets[0], "navigationLabel"), false);
    assert.equal(Object.hasOwn(targets[0], "surfaceLabel"), false);
    assert.equal(Object.hasOwn(targets[0], "zenmind"), false);
    assert.match(targets[0].webSocketDebuggerUrl, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/page\/zenmind-/u);
  } finally {
    await gateway.stop();
  }
});

test("EmbeddedCdpGateway relays standard CDP commands to webContents.debugger", async () => {
  const fakeDebugger = new FakeDebugger();
  const fakeContents = createFakeWebContents(fakeDebugger);
  const surface = {
    id: "surface-debug",
    label: "Debug Surface",
    url: "https://example.test/app",
    kind: "webview",
    active: true,
    title: "Debug Surface",
    webContentsId: fakeContents.id,
    agentKey: "debug-agent"
  };
  const { gateway, baseUrl } = await createStartedGateway({
    getSurfaces: () => [surface],
    resolveWebContents: () => fakeContents
  });

  let socket;
  try {
    const targets = await (await fetch(`${baseUrl}/json/list`)).json();
    socket = new WebSocket(targets[0].webSocketDebuggerUrl);
    await waitForWebSocketOpen(socket);

    const commands = [
      { id: 1, method: "Runtime.evaluate", params: { expression: "document.title" } },
      { id: 2, method: "Page.navigate", params: { url: "https://example.test/next" } },
      { id: 3, method: "Page.captureScreenshot", params: { format: "png" } },
      { id: 4, method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 12, y: 18 } }
    ];
    for (const command of commands) {
      socket.send(JSON.stringify(command));
      const response = await waitForWebSocketMessage(socket);
      assert.equal(response.id, command.id);
      assert.deepEqual(response.result, {
        method: command.method,
        params: command.params
      });
    }

    assert.equal(fakeDebugger.attachVersion, "1.3");
    assert.deepEqual(fakeDebugger.sent.map((entry) => entry.method), commands.map((command) => command.method));

    fakeDebugger.emit("message", {}, "Runtime.consoleAPICalled", { type: "log" });
    const event = await waitForWebSocketMessage(socket);
    assert.equal(event.method, "Runtime.consoleAPICalled");
    assert.deepEqual(event.params, { type: "log" });
  } finally {
    if (socket) {
      await closeWebSocket(socket);
    }
    await gateway.stop();
  }

  assert.equal(fakeDebugger.detached, true);
});

test("EmbeddedCdpGateway executes direct CDP calls by active surface", async () => {
  const fakeDebugger = new FakeDebugger();
  const fakeContents = createFakeWebContents(fakeDebugger);
  const surface = {
    id: "surface-active",
    label: "Active Surface",
    url: "https://example.test/app",
    kind: "webview",
    active: true,
    title: "Active Surface",
    webContentsId: fakeContents.id
  };
  const { gateway } = await createStartedGateway({
    getSurfaces: () => [surface],
    resolveWebContents: () => fakeContents
  });

  try {
    const response = await gateway.executeCommand({
      method: "Runtime.evaluate",
      params: { expression: "6 * 7" }
    });
    assert.equal(response.surfaceId, "surface-active");
    assert.deepEqual(response.result, {
      method: "Runtime.evaluate",
      params: { expression: "6 * 7" }
    });
    assert.equal(fakeDebugger.attachVersion, "1.3");
    assert.equal(fakeDebugger.detached, true);
  } finally {
    await gateway.stop();
  }
});

test("EmbeddedCdpGateway handles Target.getTargets with Desktop navigation metadata", async () => {
  const fakeDebugger = new FakeDebugger();
  const fakeContents = createFakeWebContents(fakeDebugger);
  const surfaces = [
    {
      id: "agent-webclient",
      label: "智能助理",
      url: "http://127.0.0.1:7080/agents",
      kind: "webview",
      active: true,
      title: "AGENT Webclient",
      webContentsId: fakeContents.id,
      surfaceRoute: "/agents"
    },
    {
      id: "auth-service",
      label: "认证服务",
      url: "http://127.0.0.1:7080/auth",
      kind: "webview",
      active: false,
      title: "Auth"
    }
  ];
  const { gateway } = await createStartedGateway({
    getSurfaces: () => surfaces,
    resolveWebContents: () => fakeContents
  });

  try {
    const response = await gateway.executeCommand({ method: "Target.getTargets" });
    assert.equal(response.surfaceId, "agent-webclient");
    assert.deepEqual(fakeDebugger.sent, []);
    assert.equal(response.result.targetInfos.length, 2);
    assert.equal(response.result.targetInfos[0].title, "AGENT Webclient");
    assert.equal(response.result.targetInfos[0].url, "http://127.0.0.1:7080/agents");
    assert.equal(response.result.targetInfos[0].surfaceRoute, "/agents");
    assert.equal(Object.hasOwn(response.result.targetInfos[0], "navigationRoute"), false);
    assert.equal(Object.hasOwn(response.result.targetInfos[0], "navigationLabel"), false);
    assert.equal(Object.hasOwn(response.result.targetInfos[0], "surfaceLabel"), false);
    assert.equal(Object.hasOwn(response.result.targetInfos[0], "zenmind"), false);
  } finally {
    await gateway.stop();
  }
});
