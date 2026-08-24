import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  createDesktopWsProtocolSession,
  emitDesktopWsPush,
  hasTunnelDesktopWsSubscriber,
  startDesktopWsServer,
  stopDesktopWsServer
} = require("../dist-electron/main/desktop-ws-server.js");
const {
  DESKTOP_WS_HOST,
  DESKTOP_WS_LAN_BIND_HOST
} = require("../dist-electron/shared/desktop-ws.js");
const { RealtimeBroker } = require("../dist-electron/main/realtime/realtime-broker.js");

function createApp(homePath) {
  return {
    getPath(name) {
      if (name === "home") {
        return homePath;
      }
      if (name === "appData") {
        return path.join(homePath, "app-data");
      }
      assert.fail(`unexpected app.getPath(${name})`);
    },
    getAppPath() {
      return process.cwd();
    },
    getVersion() {
      return "0.0.0-test";
    }
  };
}

function encodeClientFrame(value) {
  const payload = Buffer.from(value, "utf8");
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.byteLength < 126) {
    header = Buffer.from([0x81, 0x80 | payload.byteLength]);
  } else if (payload.byteLength <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.byteLength, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.byteLength), 2);
  }
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.byteLength; index += 1) {
    masked[index] ^= mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function parseServerFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 2 <= buffer.byteLength) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let payloadLength = second & 0x7f;
    let headerLength = 2;
    if (payloadLength === 126) {
      if (offset + 4 > buffer.byteLength) break;
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (offset + 10 > buffer.byteLength) break;
      payloadLength = Number(buffer.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }
    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + payloadLength;
    if (offset + frameLength > buffer.byteLength) break;
    let payload = buffer.subarray(offset + headerLength + maskLength, offset + frameLength);
    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      payload = Buffer.from(payload);
      for (let index = 0; index < payload.byteLength; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }
    if (opcode === 0x1) {
      messages.push(JSON.parse(payload.toString("utf8")));
    }
    offset += frameLength;
  }
  return { messages, rest: buffer.subarray(offset) };
}

function connectRawWebSocket(wsUrl, protocol) {
  const url = new URL(wsUrl);
  const socket = net.connect({ host: url.hostname, port: Number(url.port) });
  const key = crypto.randomBytes(16).toString("base64");
  const messages = [];
  const waiters = new Set();
  let buffer = Buffer.alloc(0);
  let upgraded = false;

  function flushWaiters() {
    for (const waiter of [...waiters]) {
      const matchIndex = messages.findIndex(waiter.predicate);
      if (matchIndex === -1) {
        continue;
      }
      const [message] = messages.splice(matchIndex, 1);
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(message);
    }
  }

  function acceptData(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const headerText = buffer.subarray(0, headerEnd).toString("utf8");
      assert.match(headerText, /^HTTP\/1\.1 101 /u);
      assert.match(headerText, new RegExp(`Sec-WebSocket-Protocol: ${protocol}`, "iu"));
      buffer = buffer.subarray(headerEnd + 4);
      upgraded = true;
    }
    const parsed = parseServerFrames(buffer);
    buffer = parsed.rest;
    messages.push(...parsed.messages);
    flushWaiters();
  }

  socket.on("data", acceptData);

  const upgrade = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket upgrade timed out")), 1000);
    socket.once("connect", () => {
      socket.write([
        `GET ${url.pathname}${url.search} HTTP/1.1`,
        `Host: ${url.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Protocol: ${protocol}`,
        "\r\n"
      ].join("\r\n"));
    });
    const check = setInterval(() => {
      if (!upgraded) {
        return;
      }
      clearInterval(check);
      clearTimeout(timer);
      resolve();
    }, 5);
    socket.once("error", (error) => {
      clearInterval(check);
      clearTimeout(timer);
      reject(error);
    });
  });

  return {
    socket,
    async open() {
      await upgrade;
      return this;
    },
    send(frame) {
      socket.write(encodeClientFrame(JSON.stringify(frame)));
    },
    waitFor(predicate) {
      const matchIndex = messages.findIndex(predicate);
      if (matchIndex !== -1) {
        const [message] = messages.splice(matchIndex, 1);
        return Promise.resolve(message);
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error("websocket message timed out"));
          }, 1000)
        };
        waiters.add(waiter);
      });
    },
    drain() {
      return messages.splice(0, messages.length);
    },
    close() {
      socket.end();
    }
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

test("desktop ws server upgrades loopback listener to LAN bind and reuses broad listener", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-ws-bind-"));
  t.after(async () => {
    await stopDesktopWsServer();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const baseOptions = {
    app: createApp(path.join(root, "home")),
    port: 0,
    desktopActionOptions: {},
    assistantBridge: {
      listAgents: async () => [],
      startRun: async () => ({
        ok: true,
        runId: "run-1",
        chatId: "chat-1",
        message: "started"
      })
    },
    getKanbanRuntime: () => null,
    verifyToken: async (token, subprotocol) => ({
      subject: "app",
      deviceId: token || "device-1",
      expiresAt: Date.now() + 600_000,
      scope: "app",
      subprotocol
    }),
    logger: {
      log() {},
      warn() {},
      error() {}
    }
  };

  const local = await startDesktopWsServer({ ...baseOptions, host: DESKTOP_WS_HOST });
  assert.equal(local.host, DESKTOP_WS_HOST);

  const lan = await startDesktopWsServer({ ...baseOptions, host: DESKTOP_WS_LAN_BIND_HOST });
  assert.equal(lan.host, DESKTOP_WS_LAN_BIND_HOST);
  assert.match(lan.webSocketUrl, /^ws:\/\/127\.0\.0\.1:\d+\/ws$/u);

  const client = await connectRawWebSocket(lan.webSocketUrl, "bearer.test-token").open();
  t.after(() => client.close());
  await client.waitFor((message) => message.ns === "d" && message.frame === "push" && message.type === "connected");

  const reused = await startDesktopWsServer({ ...baseOptions, host: DESKTOP_WS_HOST });
  assert.equal(reused.host, DESKTOP_WS_LAN_BIND_HOST);
  assert.equal(reused.port, lan.port);
});

test("desktop ws server exposes v1 request/response and push frames", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-ws-"));
  t.after(async () => {
    await stopDesktopWsServer();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const kanbanRuntime = {
    listIssues() {
      return {
        ok: true,
        message: "snapshot loaded",
        issues: [{ id: "issue-1", title: "Test issue", status: "todo" }],
        revision: 7
      };
    }
  };
  const cachedAppInfo = {
    productName: "ZenMind Cached",
    version: "v7.6.5",
    buildTime: "2026-08-20T01:02:03.000Z"
  };
  const desktopActionConfirmationCalls = [];
  const desktopActionRendererCalls = [];
  const started = await startDesktopWsServer({
    app: createApp(path.join(root, "home")),
    host: "127.0.0.1",
    port: 0,
    desktopActionOptions: {
      getKanbanRuntime: () => kanbanRuntime,
      getDesktopAppInfo: () => cachedAppInfo,
      desktopPet: {
        refreshState: async () => ({
          supported: true,
          enabled: false,
          appearanceId: "classic",
          appearanceOptions: [{
            id: "classic",
            displayName: "Classic",
            description: "Builtin pet.",
            states: { idle: { row: 0, frames: 8 } },
            signature: "must-not-leak"
          }],
          messages: [{ id: "message-secret", text: "must not leak" }],
          activeTasks: [{ id: "task-secret", title: "must not leak" }],
          updatedAt: "2026-08-20T01:02:03.000Z"
        }),
        saveSettings: async () => { throw new Error("unexpected pet set"); },
        show: async () => { throw new Error("unexpected pet show"); },
        hide: async () => { throw new Error("unexpected pet hide"); }
      },
      getMainWindow: () => ({ isDestroyed: () => false }),
      getCurrentPageSnapshot: () => null,
      confirmRendererAction: async (request) => {
        desktopActionConfirmationCalls.push(request);
        return { requestId: request.requestId, decision: "cancel" };
      },
      callRendererAction: async (request) => {
        desktopActionRendererCalls.push(request);
        return { requestId: request.requestId, action: request.action, ok: true, result: {} };
      }
    },
    assistantBridge: {
      listAgents: async () => [],
      startRun: async (request) => ({
        ok: true,
        runId: "run-1",
        chatId: request.chatId || "chat-1",
        message: "started"
      })
    },
    getKanbanRuntime: () => kanbanRuntime,
    listMobileWebapps: () => ({
      desktopDeviceId: "device-1",
      tunnelConnected: true,
      generatedAt: "2026-07-17T00:00:00.000Z",
      items: [
        {
          id: "notes",
          label: "Notes",
          order: 0,
          createdAt: 1,
          updatedAt: 2,
          runtimeStatus: "running",
          publishStatus: "published",
          available: true,
          publicUrl: "https://notes.m.example.test",
          availability: "available"
        }
      ]
    }),
    verifyToken: async (token, subprotocol) => {
      assert.equal(token, "test-token");
      assert.equal(subprotocol, "bearer.test-token");
      return {
        subject: "app",
        deviceId: "device-1",
        expiresAt: Date.now() + 600_000,
        scope: "app",
        subprotocol
      };
    },
    logger: {
      log() {},
      warn() {},
      error() {}
    }
  });

  const client = await connectRawWebSocket(started.webSocketUrl, "bearer.test-token").open();
  t.after(() => client.close());

  const connected = await client.waitFor((message) => message.frame === "push" && message.type === "connected");
  assert.equal(connected.ns, "d");
  assert.equal(typeof connected.data.sessionId, "string");

  client.send({ frame: "request", type: "session.hello", id: "hello-1", payload: {} });
  const hello = await client.waitFor((message) => message.id === "hello-1");
  assert.equal(hello.ns, "d");
  assert.equal(hello.frame, "response");
  assert.equal(hello.type, "session.hello");
  assert.equal(hello.code, 0);
  assert.equal(hello.msg, "success");
  assert.equal(hello.data.protocolVersion, 1);
  assert.equal(hello.data.namespaceField, "ns");
  assert.deepEqual(hello.data.namespaces, { d: "desktop", ap: "agent-platform", wa: "webapp" });
  assert.ok(hello.data.requestTypes.includes("action.call"));
  assert.ok(hello.data.requestTypes.includes("webapp.list"));

  client.send({ frame: "request", type: "runtime.info", id: "runtime-info-1", payload: {} });
  const runtimeInfo = await client.waitFor((message) => message.id === "runtime-info-1");
  assert.deepEqual(runtimeInfo.data, cachedAppInfo);

  client.send({ frame: "request", type: "webapp.list", id: "webapp-list-1", payload: {} });
  const webappList = await client.waitFor((message) => message.id === "webapp-list-1");
  assert.equal(webappList.frame, "response");
  assert.equal(webappList.code, 0);
  assert.equal(webappList.data.desktopDeviceId, "device-1");
  assert.equal(webappList.data.items[0].publicUrl, "https://notes.m.example.test");
  assert.equal("targetUrl" in webappList.data.items[0], false);
  assert.ok(hello.data.requestTypes.includes("issue.claim"));

  client.send({ ns: "wa", frame: "request", type: "session.hello", id: "wa-hello-1", payload: {} });
  const webappHello = await client.waitFor((message) => message.id === "wa-hello-1");
  assert.equal(webappHello.ns, "wa");
  assert.equal(webappHello.frame, "response");
  assert.equal(webappHello.type, "session.hello");
  assert.equal(webappHello.code, 0);
  assert.equal(webappHello.data.namespaces.wa, "webapp");
  assert.ok(hello.data.requestTypes.includes("web.listSurfaces"));
  assert.ok(hello.data.requestTypes.includes("website.list"));
  assert.ok(hello.data.requestTypes.includes("kanban.issue.list"));
  assert.ok(hello.data.requestTypes.includes("pet.state"));
  assert.ok(hello.data.requestTypes.includes("pet.list"));
  assert.ok(hello.data.requestTypes.includes("pet.set"));
  assert.ok(hello.data.requestTypes.includes("general.deviceName"));
  assert.ok(hello.data.requestTypes.includes("theme.get"));
  assert.ok(hello.data.requestTypes.includes("theme.set"));
  assert.ok(hello.data.requestTypes.includes("locale.get"));
  assert.ok(hello.data.requestTypes.includes("locale.set"));
  assert.ok(hello.data.requestTypes.includes("copilot.getPagePreferences"));
  assert.ok(hello.data.requestTypes.includes("copilot.setPagePreference"));
  assert.equal(hello.data.requestTypes.includes("web.list"), false);
  assert.equal(hello.data.requestTypes.includes("web.getPageContext"), false);
  assert.equal(hello.data.requestTypes.includes("web.readPageData"), false);
  assert.equal(hello.data.requestTypes.includes("web.extractStructured"), false);
  assert.equal(hello.data.requestTypes.includes("web.interactElement"), false);
  assert.equal(hello.data.requestTypes.includes("web.executeScript"), false);
  assert.equal(hello.data.requestTypes.includes("web.websites.list"), false);
  assert.ok(hello.data.requestTypes.includes("webapp.getStatus"));
  assert.ok(hello.data.requestTypes.includes("webapp.checkRuntime"));
  assert.ok(hello.data.requestTypes.includes("webapp.install"));
  assert.ok(hello.data.requestTypes.includes("webapp.uninstall"));
  assert.ok(hello.data.requestTypes.includes("webapp.getPublishStatus"));
  assert.equal(hello.data.requestTypes.includes("webapp.installAndOpen"), false);
  assert.equal(hello.data.requestTypes.includes("webapp.checkPrerequisites"), false);
  assert.equal(hello.data.requestTypes.includes("webapp.getPublishInfo"), false);
  assert.equal(hello.data.requestTypes.includes("web.webapps.getStatus"), false);
  assert.equal(hello.data.requestTypes.includes("web.webapps.status"), false);
  assert.equal(hello.data.requestTypes.includes("pet.getState"), false);
  assert.equal(hello.data.requestTypes.includes("pet.getSettings"), false);
  assert.equal(hello.data.requestTypes.includes("pet.setEnabled"), false);
  assert.equal(hello.data.requestTypes.includes("pet.listAppearances"), false);
  assert.equal(hello.data.requestTypes.includes("pet.setAppearance"), false);
  assert.ok(hello.data.requestTypes.includes("webapp.start"));
  assert.equal(hello.data.requestTypes.includes("agent.list"), false);
  assert.equal(hello.data.requestTypes.includes("automation.list"), false);
  assert.equal(hello.data.requestTypes.includes("staticServer.list"), false);
  assert.equal(hello.data.requestTypes.includes("help.search"), false);
  assert.equal(hello.data.requestTypes.some((type) => type.startsWith("page.")), false);

  client.send({ frame: "request", type: "action.list", id: "actions-1", payload: {} });
  const actionList = await client.waitFor((message) => message.id === "actions-1");
  const actionNames = actionList.data.actions.map((action) => action.action);
  assert.ok(actionNames.includes("web.listSurfaces"));
  assert.ok(actionNames.includes("web.getSurfaceState"));
  assert.equal(actionNames.includes("web.getActiveSurface"), false);
  assert.ok(actionNames.includes("site.list"));
  assert.ok(actionNames.includes("website.list"));
  assert.ok(actionNames.includes("webapp.getStatus"));
  assert.ok(actionNames.includes("webapp.install"));
  assert.ok(actionNames.includes("webapp.checkRuntime"));
  assert.ok(actionNames.includes("webapp.getPublishStatus"));
  assert.ok(actionNames.includes("webapp.uninstall"));
  assert.ok(actionNames.includes("webapp.publish"));
  assert.ok(actionNames.includes("webapp.unpublish"));
  assert.equal(actionNames.includes("webapp.installAndOpen"), false);
  assert.equal(actionNames.includes("webapp.checkPrerequisites"), false);
  assert.equal(actionNames.includes("webapp.getPublishInfo"), false);
  assert.ok(actionNames.includes("pet.state"));
  assert.ok(actionNames.includes("pet.list"));
  assert.ok(actionNames.includes("pet.set"));
  assert.ok(actionNames.includes("general.deviceName"));
  assert.ok(actionNames.includes("runtime.info"));
  assert.ok(actionNames.includes("runtime.diagnostics"));
  assert.equal(
    actionList.data.actions.find((action) => action.action === "runtime.diagnostics").confirmation,
    "sensitive-read"
  );
  client.send({
    frame: "request",
    type: "action.call",
    id: "runtime-info-action-1",
    payload: { action: "runtime.info", args: {} }
  });
  const runtimeInfoAction = await client.waitFor((message) => message.id === "runtime-info-action-1");
  assert.deepEqual(runtimeInfoAction.data.result, cachedAppInfo);
  client.send({
    frame: "request",
    type: "action.call",
    id: "pet-state-action-1",
    payload: { action: "pet.state", args: {} }
  });
  const petStateAction = await client.waitFor((message) => message.id === "pet-state-action-1");
  assert.deepEqual(petStateAction.data, {
    ok: true,
    action: "desktop.pet.state",
    result: {
      supported: true,
      enabled: false,
      appearanceId: "classic"
    }
  });
  client.send({
    frame: "request",
    type: "action.call",
    id: "workpanel-open-web-action-1",
    payload: {
      action: "workpanel.openWeb",
      args: { url: "https://example.test/editor" },
      source: { chatId: "chat-1", runId: "run-1", agentKey: "coder" }
    }
  });
  const workPanelOpenWeb = await client.waitFor((message) => message.id === "workpanel-open-web-action-1");
  assert.equal(workPanelOpenWeb.frame, "error");
  assert.equal(workPanelOpenWeb.type, "user_cancelled");
  assert.equal(workPanelOpenWeb.data.requiresConfirmation, true);
  assert.equal(desktopActionConfirmationCalls.length, 1);
  assert.equal(desktopActionRendererCalls.length, 0);
  assert.ok(actionNames.includes("theme.get"));
  assert.ok(actionNames.includes("theme.set"));
  assert.ok(actionNames.includes("locale.get"));
  assert.ok(actionNames.includes("locale.set"));
  assert.ok(actionNames.includes("copilot.getPagePreferences"));
  assert.ok(actionNames.includes("copilot.setPagePreference"));
  assert.equal(actionNames.some((action) => action.startsWith("setting.")), false);
  assert.equal(actionNames.some((action) => action.startsWith("page.")), false);
  assert.ok(actionNames.includes("help.open"));
  assert.ok(actionNames.includes("kanban.issue.list"));
  assert.ok(actionNames.includes("kanban.issue.get"));
  assert.ok(actionNames.includes("kanban.issue.create"));
  assert.ok(actionNames.includes("kanban.issue.update"));
  assert.ok(actionNames.includes("kanban.issue.delete"));
  assert.ok(actionNames.includes("kanban.issue.move"));
  assert.equal(actionNames.includes("web.list"), false);
  assert.equal(actionNames.includes("web.surfaces"), false);
  assert.equal(actionNames.includes("web.getPageContext"), false);
  assert.equal(actionNames.includes("web.readPageData"), false);
  assert.equal(actionNames.includes("web.extractStructured"), false);
  assert.equal(actionNames.includes("web.interactElement"), false);
  assert.equal(actionNames.includes("web.executeScript"), false);
  assert.equal(actionNames.includes("web.websites.list"), false);
  assert.equal(actionNames.includes("web.webapps.getStatus"), false);
  assert.equal(actionNames.includes("web.webapps.status"), false);
  assert.equal(actionNames.some((action) => action.startsWith("embeddedWeb.")), false);
  assert.ok(actionNames.includes("webapp.start"));
  assert.ok(actionNames.includes("webapp.stop"));
  assert.ok(actionNames.includes("webapp.restart"));
  assert.ok(actionNames.includes("webapp.open"));
  assert.equal(actionNames.includes("pet.getState"), false);
  assert.equal(actionNames.includes("pet.getSettings"), false);
  assert.equal(actionNames.includes("pet.setEnabled"), false);
  assert.equal(actionNames.includes("pet.listAppearances"), false);
  assert.equal(actionNames.includes("pet.setAppearance"), false);
  assert.equal(actionNames.includes("help.openTopic"), false);
  assert.equal(actionNames.includes("help.search"), false);
  assert.equal(actionNames.some((action) => action.startsWith("agent.")), false);
  assert.equal(actionNames.some((action) => action.startsWith("automation.")), false);
  assert.equal(actionNames.some((action) => action.startsWith("staticServer.")), false);
  assert.equal(actionNames.some((action) => action.startsWith("tunnelHub.")), false);
  assert.equal(actionNames.some((action) => action.startsWith("kanban.") && !action.startsWith("kanban.issue.")), false);

  client.send({
    frame: "request",
    type: "action.call",
    id: "kanban-list-action-1",
    payload: { action: "kanban.issue.list", args: {} }
  });
  const kanbanListAction = await client.waitFor((message) => message.id === "kanban-list-action-1");
  assert.equal(kanbanListAction.code, 0);
  assert.equal(kanbanListAction.data.ok, true);
  assert.equal(kanbanListAction.data.action, "desktop.kanban.listIssues");
  assert.equal(kanbanListAction.data.result.revision, 7);

  client.send({ frame: "request", type: "snapshot.get", id: "snapshot-1", payload: {} });
  const snapshot = await client.waitFor((message) => message.id === "snapshot-1");
  assert.equal(snapshot.ns, "d");
  assert.equal(snapshot.frame, "response");
  assert.equal(snapshot.type, "snapshot.get");
  assert.equal(snapshot.code, 0);
  assert.equal(snapshot.data.revision, 7);
  assert.equal(snapshot.data.issues[0].id, "issue-1");

  client.send({
    frame: "request",
    type: "event.subscribe",
    id: "sub-1",
    payload: { types: ["snapshot.updated"] }
  });
  const subscribed = await client.waitFor((message) => message.id === "sub-1");
  assert.deepEqual(subscribed.data.types, ["snapshot.updated"]);

  emitDesktopWsPush("snapshot.updated", { revision: 8 });
  const pushed = await client.waitFor((message) => message.frame === "push" && message.type === "snapshot.updated");
  assert.equal(pushed.ns, "d");
  assert.equal(pushed.data.revision, 8);

  client.send({ frame: "request", type: "issue.claim", id: "claim-1", payload: {} });
  const unsupported = await client.waitFor((message) => message.id === "claim-1");
  assert.equal(unsupported.ns, "d");
  assert.equal(unsupported.frame, "error");
  assert.equal(unsupported.type, "unsupported");
  assert.equal(unsupported.code, 501);

  client.send({ frame: "stream", id: "stream-1", streamId: "run-1", event: {}, lastSeq: 12 });
  const streamError = await client.waitFor((message) => message.id === "stream-1");
  assert.equal(streamError.ns, "d");
  assert.equal(streamError.frame, "error");
  assert.equal(streamError.type, "invalid_request");
  assert.equal(streamError.code, 400);
});

test("only authenticated live Tunnel sessions subscribed to webapp.changed count as mobile subscribers", async (t) => {
  const sent = [];
  const options = {
    app: createApp(path.join(os.tmpdir(), "zenmind-desktop-ws-tunnel-subscriber")),
    desktopActionOptions: {},
    assistantBridge: {
      listAgents: async () => [],
      startRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "started" })
    },
    getKanbanRuntime: () => null,
    verifyToken: async () => ({
      subject: "app",
      deviceId: "device-1",
      expiresAt: Date.now() + 600_000,
      scope: "app"
    }),
    logger: { log() {}, warn() {}, error() {} }
  };
  const session = await createDesktopWsProtocolSession(options, {
    authToken: "mobile-token",
    source: "react-app",
    clientDeviceId: "phone-1",
    transport: {
      sendText(text) {
        sent.push(JSON.parse(text));
      },
      close() {}
    }
  });
  t.after(() => session.close());

  assert.equal(hasTunnelDesktopWsSubscriber("webapp.changed"), false);
  session.receiveTextFrame(JSON.stringify({
    ns: "d",
    frame: "request",
    type: "event.subscribe",
    id: "subscribe-webapps",
    payload: { types: ["webapp.changed"] }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hasTunnelDesktopWsSubscriber("webapp.changed"), true);

  emitDesktopWsPush("webapp.changed", { webappId: "notes" });
  assert.ok(sent.some((message) => message.frame === "push" && message.type === "webapp.changed"));

  session.close();
  assert.equal(hasTunnelDesktopWsSubscriber("webapp.changed"), false);
});

test("desktop ws auth.refresh validates explicit tokens and issues missing tokens", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-ws-refresh-"));
  t.after(async () => {
    await stopDesktopWsServer();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const verifyCalls = [];
  const issueReasons = [];
  const started = await startDesktopWsServer({
    app: createApp(path.join(root, "home")),
    host: "127.0.0.1",
    port: 0,
    desktopActionOptions: {},
    assistantBridge: {
      listAgents: async () => [],
      startRun: async () => ({
        ok: true,
        runId: "run-1",
        chatId: "chat-1",
        message: "started"
      })
    },
    getKanbanRuntime: () => null,
    issueAccessToken: async (_app, reason) => {
      issueReasons.push(reason);
      return {
        ok: true,
        token: `${reason}-issued-token`,
        message: "issued"
      };
    },
    verifyToken: async (token, subprotocol) => {
      verifyCalls.push({ token, subprotocol });
      if (token === "invalid-token") {
        throw new Error("invalid token");
      }
      return {
        subject: "app",
        deviceId: "device-1",
        expiresAt: Date.now() + (token.endsWith("-issued-token") ? 900_000 : 600_000),
        scope: "app",
        subprotocol
      };
    },
    logger: {
      log() {},
      warn() {},
      error() {}
    }
  });

  const client = await connectRawWebSocket(started.webSocketUrl, "bearer.initial-token").open();
  t.after(() => client.close());
  await client.waitFor((message) => message.ns === "d" && message.frame === "push" && message.type === "connected");

  client.send({ frame: "request", type: "auth.refresh", id: "refresh-explicit", payload: { token: "client-token" } });
  const explicitRefresh = await client.waitFor((message) => message.id === "refresh-explicit");
  assert.equal(explicitRefresh.ns, "d");
  assert.equal(explicitRefresh.frame, "response");
  assert.equal(explicitRefresh.type, "auth.refresh");
  assert.equal(explicitRefresh.code, 0);
  assert.equal(explicitRefresh.data.token, "client-token");
  assert.equal(typeof explicitRefresh.data.expiresAt, "number");
  assert.deepEqual(issueReasons, []);

  client.send({ frame: "request", type: "auth.refresh", id: "refresh-issued", payload: {} });
  const issuedRefresh = await client.waitFor((message) => message.id === "refresh-issued");
  assert.equal(issuedRefresh.ns, "d");
  assert.equal(issuedRefresh.frame, "response");
  assert.equal(issuedRefresh.type, "auth.refresh");
  assert.equal(issuedRefresh.code, 0);
  assert.equal(issuedRefresh.data.token, "missing-issued-token");
  assert.equal(typeof issuedRefresh.data.expiresAt, "number");
  assert.deepEqual(issueReasons, ["missing"]);

  client.send({ frame: "request", type: "session.hello", id: "hello-after-refresh", payload: {} });
  const hello = await client.waitFor((message) => message.id === "hello-after-refresh");
  assert.equal(hello.data.auth.expiresAt, issuedRefresh.data.expiresAt);

  client.send({
    frame: "request",
    type: "auth.refresh",
    id: "refresh-unauthorized",
    payload: { reason: "unauthorized" }
  });
  const unauthorizedRefresh = await client.waitFor((message) => message.id === "refresh-unauthorized");
  assert.equal(unauthorizedRefresh.frame, "response");
  assert.equal(unauthorizedRefresh.code, 0);
  assert.equal(unauthorizedRefresh.data.token, "unauthorized-issued-token");
  assert.deepEqual(issueReasons, ["missing", "unauthorized"]);

  client.send({ frame: "request", type: "auth.refresh", id: "refresh-invalid", payload: { token: "invalid-token" } });
  const invalidRefresh = await client.waitFor((message) => message.id === "refresh-invalid");
  assert.equal(invalidRefresh.ns, "d");
  assert.equal(invalidRefresh.frame, "error");
  assert.equal(invalidRefresh.type, "unauthorized");
  assert.equal(invalidRefresh.code, 401);

  assert.deepEqual(verifyCalls.map((call) => call.token), [
    "initial-token",
    "client-token",
    "missing-issued-token",
    "unauthorized-issued-token",
    "invalid-token"
  ]);
  assert.ok(verifyCalls.every((call) => call.subprotocol === "bearer.initial-token"));
});

test("desktop ws auth.refresh coalesces concurrent server-issued refreshes per connection", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-ws-refresh-coalesce-"));
  t.after(async () => {
    await stopDesktopWsServer();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const issueDeferred = createDeferred();
  const verifyCalls = [];
  let issueCalls = 0;
  const started = await startDesktopWsServer({
    app: createApp(path.join(root, "home")),
    host: "127.0.0.1",
    port: 0,
    desktopActionOptions: {},
    assistantBridge: {
      listAgents: async () => [],
      startRun: async () => ({
        ok: true,
        runId: "run-1",
        chatId: "chat-1",
        message: "started"
      })
    },
    getKanbanRuntime: () => null,
    issueAccessToken: async (_app, reason) => {
      assert.equal(reason, "missing");
      issueCalls += 1;
      return issueDeferred.promise;
    },
    verifyToken: async (token, subprotocol) => {
      verifyCalls.push({ token, subprotocol });
      return {
        subject: "app",
        deviceId: "device-1",
        expiresAt: Date.now() + 600_000,
        scope: "app",
        subprotocol
      };
    },
    logger: {
      log() {},
      warn() {},
      error() {}
    }
  });

  const client = await connectRawWebSocket(started.webSocketUrl, "bearer.initial-token").open();
  t.after(() => client.close());
  await client.waitFor((message) => message.ns === "d" && message.frame === "push" && message.type === "connected");

  client.send({ frame: "request", type: "auth.refresh", id: "refresh-a", payload: {} });
  client.send({ frame: "request", type: "auth.refresh", id: "refresh-b", payload: {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(issueCalls, 1);
  issueDeferred.resolve({
    ok: true,
    token: "shared-issued-token",
    message: "issued"
  });

  const refreshA = await client.waitFor((message) => message.id === "refresh-a");
  const refreshB = await client.waitFor((message) => message.id === "refresh-b");
  assert.equal(refreshA.frame, "response");
  assert.equal(refreshB.frame, "response");
  assert.equal(refreshA.data.token, "shared-issued-token");
  assert.equal(refreshB.data.token, "shared-issued-token");
  assert.equal(verifyCalls.filter((call) => call.token === "shared-issued-token").length, 1);
});

test("desktop ws server routes agent-platform namespace frames", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-desktop-ws-ap-"));
  t.after(async () => {
    await stopDesktopWsServer();
    fs.rmSync(root, { recursive: true, force: true });
  });

  class FakeAgentPlatformWebSocket {
    static sockets = [];

    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.listeners = new Map();
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      FakeAgentPlatformWebSocket.sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open", { type: "open" });
        this.emitMessage({
          frame: "push",
          type: "connected",
          data: {
            protocolVersion: 2,
            sessionId: "platform-1",
            serverTime: 1_786_890_000_000,
            liveness: { heartbeatIntervalMs: 30_000, silenceTimeoutMs: 100_000 },
          },
        });
      });
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    emit(type, event) {
      const handler = this[`on${type}`];
      if (typeof handler === "function") {
        handler(event);
      }
      for (const listener of this.listeners.get(type) ?? []) {
        listener(event);
      }
    }

    emitMessage(frame) {
      this.emit("message", { data: JSON.stringify(frame) });
    }

    send(data) {
      const frame = JSON.parse(data);
      this.sent.push(frame);
      assert.equal("ns" in frame, false);
      queueMicrotask(() => {
        if (frame.type === "/api/agents") {
          this.emitMessage({
            frame: "push",
            type: "heartbeat",
            data: { sessionId: "platform-1", sequence: 1, timestamp: 1_786_890_030_000 },
          });
          this.emitMessage({
            frame: "response",
            type: "/api/agents",
            id: frame.id,
            code: 0,
            msg: "success",
            data: [{ key: "demo" }]
          });
          this.emitMessage({
            frame: "push",
            type: "chat.updated",
            data: { chatId: "chat-1", updatedAt: 1_771_888_000_000 }
          });
        }
        if (frame.type === "/api/query") {
          this.emitMessage({
            frame: "stream",
            id: frame.id,
            streamId: "run-1",
            event: { type: "content.delta", delta: "hi" },
            lastSeq: 12
          });
        }
      });
    }

    close(code = 1000, reason = "closed") {
      this.readyState = 3;
      this.emit("close", { type: "close", code, reason });
    }
  }

  const app = createApp(path.join(root, "home"));
  const realtimeBroker = new RealtimeBroker({
    app,
    issueAccessToken: async () => ({ ok: true, token: "platform-token", message: "issued" }),
    createWebSocket: (url) => new FakeAgentPlatformWebSocket(url),
    heartbeatTimeoutMs: 0,
  });
  t.after(() => realtimeBroker.dispose());

  const started = await startDesktopWsServer({
    app,
    host: "127.0.0.1",
    port: 0,
    desktopActionOptions: {},
    assistantBridge: {
      listAgents: async () => [],
      startRun: async () => ({
        ok: true,
        runId: "run-1",
        chatId: "chat-1",
        message: "started"
      })
    },
    getKanbanRuntime: () => null,
    agentPlatformBridge: {
      realtimeBroker,
      getServiceState: async () => ({
        status: "running",
        message: "",
        healthMeta: {
          webUrl: "http://127.0.0.1:7078",
          port: 7078
        }
      }),
      issueAccessToken: async () => ({
        ok: true,
        token: "platform-token",
        message: "issued"
      })
    },
    verifyToken: async () => ({
      subject: "app",
      deviceId: "device-1",
      expiresAt: Date.now() + 600_000,
      scope: "app"
    }),
    logger: {
      log() {},
      warn() {},
      error() {}
    }
  });

  const client = await connectRawWebSocket(started.webSocketUrl, "bearer.test-token").open();
  t.after(() => client.close());
  await client.waitFor((message) => message.ns === "d" && message.frame === "push" && message.type === "connected");

  client.send({ ns: "ap", frame: "request", type: "/api/agents", id: "ap-agents-1", payload: { includeChats: 1 } });
  const agents = await client.waitFor((message) => message.ns === "ap" && message.id === "ap-agents-1");
  assert.equal(agents.frame, "response");
  assert.equal(agents.type, "/api/agents");
  assert.deepEqual(agents.data, [{ key: "demo" }]);
  assert.equal(FakeAgentPlatformWebSocket.sockets.length, 1);
  assert.equal(new URL(FakeAgentPlatformWebSocket.sockets[0].url).searchParams.get("token"), "platform-token");
  assert.equal(FakeAgentPlatformWebSocket.sockets[0].sent[0].frame, "request");
  assert.equal(FakeAgentPlatformWebSocket.sockets[0].sent[0].type, "/api/agents");
  assert.match(FakeAgentPlatformWebSocket.sockets[0].sent[0].id, /^desktop-forward-/u);
  assert.notEqual(FakeAgentPlatformWebSocket.sockets[0].sent[0].id, "ap-agents-1");
  assert.deepEqual(FakeAgentPlatformWebSocket.sockets[0].sent[0].payload, { includeChats: 1 });

  const secondClient = await connectRawWebSocket(started.webSocketUrl, "bearer.test-token").open();
  t.after(() => secondClient.close());
  await secondClient.waitFor((message) => message.ns === "d" && message.type === "connected");
  secondClient.send({ ns: "ap", frame: "request", type: "/api/agents", id: "same-local-id", payload: {} });
  await secondClient.waitFor((message) => message.ns === "ap" && message.id === "same-local-id");
  assert.equal(FakeAgentPlatformWebSocket.sockets.length, 1);

  const platformPush = await client.waitFor((message) => message.ns === "ap" && message.frame === "push" && message.type === "chat.updated");
  assert.equal(platformPush.data.chatId, "chat-1");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(client.drain().some((message) => message.ns === "ap" && message.type === "heartbeat"), false);

  client.send({ ns: "ap", frame: "request", type: "/api/query", id: "ap-query-1", payload: { message: "hi" } });
  const stream = await client.waitFor((message) => message.ns === "ap" && message.frame === "stream" && message.id === "ap-query-1");
  assert.equal(stream.streamId, "run-1");
  assert.equal(stream.lastSeq, 12);
  assert.equal(stream.event.delta, "hi");

  client.send({ ns: "bad", frame: "request", type: "session.hello", id: "bad-ns-1", payload: {} });
  const invalidNamespace = await client.waitFor((message) => message.id === "bad-ns-1");
  assert.equal(invalidNamespace.ns, "d");
  assert.equal(invalidNamespace.frame, "error");
  assert.equal(invalidNamespace.type, "invalid_namespace");
  assert.equal(invalidNamespace.code, 400);
});
