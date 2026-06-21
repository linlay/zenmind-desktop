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
  emitDesktopWsPush,
  startDesktopWsServer,
  stopDesktopWsServer
} = require("../dist-electron/main/desktop-ws-server.js");

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
  const started = await startDesktopWsServer({
    app: createApp(path.join(root, "home")),
    host: "127.0.0.1",
    port: 0,
    desktopActionOptions: {},
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
  assert.ok(hello.data.requestTypes.includes("issue.claim"));

  client.send({ ns: "wa", frame: "request", type: "session.hello", id: "wa-hello-1", payload: {} });
  const webappHello = await client.waitFor((message) => message.id === "wa-hello-1");
  assert.equal(webappHello.ns, "wa");
  assert.equal(webappHello.frame, "response");
  assert.equal(webappHello.type, "session.hello");
  assert.equal(webappHello.code, 0);
  assert.equal(webappHello.data.namespaces.wa, "webapp");

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
          this.emitMessage({ frame: "push", type: "connected", data: { sessionId: "platform-1" } });
          this.emitMessage({ frame: "push", type: "heartbeat", data: { timestamp: 1 } });
          this.emitMessage({
            frame: "response",
            type: "/api/agents",
            id: frame.id,
            code: 0,
            msg: "success",
            data: [{ key: "demo" }]
          });
          this.emitMessage({ frame: "push", type: "chat.updated", data: { chatId: "chat-1" } });
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
    agentPlatformBridge: {
      WebSocketConstructor: FakeAgentPlatformWebSocket,
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
  assert.deepEqual(FakeAgentPlatformWebSocket.sockets[0].sent[0], {
    frame: "request",
    type: "/api/agents",
    id: "ap-agents-1",
    payload: { includeChats: 1 }
  });

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
