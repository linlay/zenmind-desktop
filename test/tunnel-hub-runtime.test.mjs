import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { APP_BRAND } = require("../dist-electron/shared/brand.js");

const {
  configureTunnelHubRegistrationController
} = require("../dist-electron/main/tunnel-hub-registration.js");
const {
  TunnelHubRuntime
} = require("../dist-electron/main/tunnel-hub-runtime.js");
const {
  TunnelClientEndpoint
} = require("../dist-electron/main/tunnel-client-endpoint.js");
const {
  readTunnelHubSettings,
  saveTunnelHubSettings
} = require("../dist-electron/main/tunnel-hub-settings.js");

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const FRAME_OPEN = 1;
const FRAME_DATA = 2;
const FRAME_CLOSE = 3;

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

function desktopRoot(homePath) {
  return path.join(homePath, APP_BRAND.paths.runtimeRootDirName, APP_BRAND.paths.desktopDataSubdir);
}

function writeSsoSiteToken(homePath, token = "runtime-site-token") {
  const secretsRoot = path.join(desktopRoot(homePath), "secrets");
  fs.mkdirSync(secretsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(secretsRoot, "sso-site-token.json"),
    JSON.stringify({ accessToken: token }),
    "utf8"
  );
}

function createDesktopWsServerOptions(app, overrides = {}) {
  return {
    app,
    desktopActionOptions: {},
    assistantBridge: {
      listAgents: async () => [],
      startRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "started" })
    },
    getTaskBoardRuntime: () => null,
    logger: { log() {}, warn() {}, error() {} },
    ...overrides
  };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function websocketAccept(key) {
  return crypto.createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
}

function encodeServerWsFrame(opcode, payload) {
  let header;
  if (payload.byteLength < 126) {
    header = Buffer.from([0x80 | opcode, payload.byteLength]);
  } else if (payload.byteLength <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.byteLength, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.byteLength), 2);
  }
  return Buffer.concat([header, payload]);
}

function parseClientWsFrames(buffer) {
  const frames = [];
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
    frames.push({ opcode, payload });
    offset += frameLength;
  }
  return { frames, rest: buffer.subarray(offset) };
}

function encodeTunnelFrame(type, streamId, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(13);
  header[0] = type;
  header.writeBigUInt64BE(BigInt(streamId), 1);
  header.writeUInt32BE(payload.byteLength, 9);
  return Buffer.concat([header, payload]);
}

function parseTunnelFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 13 <= buffer.byteLength) {
    const type = buffer[offset];
    const streamId = Number(buffer.readBigUInt64BE(offset + 1));
    const payloadLength = buffer.readUInt32BE(offset + 9);
    if (offset + 13 + payloadLength > buffer.byteLength) {
      break;
    }
    frames.push({
      type,
      streamId,
      payload: payloadLength > 0 ? buffer.subarray(offset + 13, offset + 13 + payloadLength) : Buffer.alloc(0)
    });
    offset += 13 + payloadLength;
  }
  return { frames, rest: buffer.subarray(offset) };
}

function encodeTunnelJson(value) {
  const data = Buffer.from(JSON.stringify(value), "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(data.byteLength, 0);
  return Buffer.concat([prefix, data]);
}

function encodeTunnelWsFrame(type, payload) {
  const header = Buffer.alloc(9);
  header[0] = type;
  header.writeBigUInt64BE(BigInt(payload.byteLength), 1);
  return Buffer.concat([header, payload]);
}

function createStreamReader() {
  let buffer = Buffer.alloc(0);
  let closed = false;
  const waiters = [];
  const closeWaiters = [];

  function flush() {
    for (const waiter of [...waiters]) {
      if (buffer.byteLength < waiter.size) {
        continue;
      }
      waiters.splice(waiters.indexOf(waiter), 1);
      const data = buffer.subarray(0, waiter.size);
      buffer = buffer.subarray(waiter.size);
      clearTimeout(waiter.timer);
      waiter.resolve(data);
    }
    if (closed) {
      if (closeWaiters.length > 0) {
        const data = buffer;
        buffer = Buffer.alloc(0);
        for (const waiter of closeWaiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.resolve(data);
        }
      }
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("stream closed before enough data was received"));
      }
    }
  }

  async function readBytes(size) {
    if (buffer.byteLength >= size) {
      const data = buffer.subarray(0, size);
      buffer = buffer.subarray(size);
      return data;
    }
    if (closed) {
      throw new Error("stream closed before enough data was received");
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        size,
        resolve,
        timer: setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error("stream bytes timed out"));
        }, 2000)
      };
      waiters.push(waiter);
    });
  }

  return {
    append(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      flush();
    },
    close() {
      closed = true;
      flush();
    },
    async readJson() {
      const prefix = await readBytes(4);
      return JSON.parse((await readBytes(prefix.readUInt32BE(0))).toString("utf8"));
    },
    async readRaw(size) {
      return readBytes(size);
    },
    async readUntilClosed() {
      if (closed) {
        const data = buffer;
        buffer = Buffer.alloc(0);
        return data;
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve,
          timer: setTimeout(() => {
            closeWaiters.splice(closeWaiters.indexOf(waiter), 1);
            reject(new Error("stream close timed out"));
          }, 2000)
        };
        closeWaiters.push(waiter);
      });
    },
    async readWsFrame() {
      const header = await readBytes(9);
      const payload = await readBytes(Number(header.readBigUInt64BE(1)));
      return { type: header[0], payload };
    },
    async readWsJson() {
      const header = await readBytes(9);
      const payload = await readBytes(Number(header.readBigUInt64BE(1)));
      return JSON.parse(payload.toString("utf8"));
    }
  };
}

function createFakeRelay(runScenario) {
  const streamId = 2;
  const streamReader = createStreamReader();
  let socket = null;
  let wsBuffer = Buffer.alloc(0);
  let tunnelBuffer = Buffer.alloc(0);
  let authorization = "";
  let tunnelOpenRequest = null;
  let upgradedResolve;
  const upgraded = new Promise((resolve) => {
    upgradedResolve = resolve;
  });
  let tunnelOpenedResolve;
  const tunnelOpened = new Promise((resolve) => {
    tunnelOpenedResolve = resolve;
  });

  function sendWsBinary(payload) {
    socket.write(encodeServerWsFrame(0x2, payload));
  }

  function sendWsText(value) {
    socket.write(encodeServerWsFrame(0x1, Buffer.from(JSON.stringify(value), "utf8")));
  }

  function sendTunnelFrame(type, id, payload = Buffer.alloc(0)) {
    sendWsBinary(encodeTunnelFrame(type, id, payload));
  }

  function sendStreamData(payload) {
    sendTunnelFrame(FRAME_DATA, streamId, payload);
  }

  const server = http.createServer();
  server.on("upgrade", (req, nextSocket) => {
    socket = nextSocket;
    authorization = String(req.headers.authorization ?? "");
    const key = String(req.headers["sec-websocket-key"] ?? "");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
      "",
      ""
    ].join("\r\n"));
    socket.on("data", (chunk) => {
      wsBuffer = Buffer.concat([wsBuffer, chunk]);
      const wsFrames = parseClientWsFrames(wsBuffer);
      wsBuffer = wsFrames.rest;
      for (const frame of wsFrames.frames) {
        if (frame.opcode === 0x1) {
          tunnelOpenRequest = JSON.parse(frame.payload.toString("utf8"));
          sendWsText({
            v: 1,
            ns: "d",
            frame: "response",
            type: "tunnel.open",
            id: tunnelOpenRequest.id,
            code: 0,
            msg: "success",
            data: {
              sessionId: "session_test",
              multiplex: "yamux"
            }
          });
          tunnelOpenedResolve();
          continue;
        }
        if (frame.opcode !== 0x2) {
          continue;
        }
        tunnelBuffer = Buffer.concat([tunnelBuffer, frame.payload]);
        const tunnelFrames = parseTunnelFrames(tunnelBuffer);
        tunnelBuffer = tunnelFrames.rest;
        for (const tunnelFrame of tunnelFrames.frames) {
          if (tunnelFrame.type === FRAME_DATA && tunnelFrame.streamId === streamId) {
            streamReader.append(tunnelFrame.payload);
          }
          if (tunnelFrame.type === FRAME_CLOSE && tunnelFrame.streamId === streamId) {
            streamReader.close();
          }
        }
      }
    });
    upgradedResolve();
  });

  return {
    server,
    get authorization() {
      return authorization;
    },
    get tunnelOpenRequest() {
      return tunnelOpenRequest;
    },
    async start() {
      await upgraded;
      await tunnelOpened;
      sendTunnelFrame(FRAME_OPEN, streamId);
      return runScenario({
        streamReader,
        sendStreamData,
        sendTunnelFrame,
        streamId
      });
    },
    close() {
      socket?.destroy();
    }
  };
}

test("Tunnel Hub runtime requires SSO even when a relay token exists", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-tunnel-runtime-sso-required-"));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeSsoSiteToken(homePath);
  assert.equal(saveTunnelHubSettings(app, {
    enabled: true,
    relayUrl: "wss://relay.example.test/tunnel",
    deviceId: "mac-mini-office"
  }).ok, true);
  const secretsRoot = path.join(desktopRoot(homePath), "secrets");
  fs.writeFileSync(path.join(secretsRoot, "tunnel-hub-token"), "cached-relay-token\n", "utf8");
  fs.writeFileSync(path.join(secretsRoot, "tunnel-hub-registration-token"), "legacy-registration-secret\n", "utf8");
  fs.rmSync(path.join(secretsRoot, "sso-site-token.json"), { force: true });

  const connectCalls = [];
  const runtime = new TunnelHubRuntime({
    app,
    desktopWsServerOptions: {
      app,
      desktopActionOptions: {},
      assistantBridge: {
        listAgents: async () => [],
        startRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "started" })
      },
      getTaskBoardRuntime: () => null
    },
    createTunnelClient(input) {
      connectCalls.push(input);
      return {
        async connect() {},
        close() {},
        on() {}
      };
    },
    logger: { log() {}, warn() {}, error() {} }
  });

  const result = await runtime.start();
  assert.equal(result.ok, false);
  assert.match(result.message, /Sign in/u);
  assert.equal(connectCalls.length, 0);
  assert.equal(readTunnelHubSettings(app).enabled, false);
  assert.equal(fs.existsSync(path.join(secretsRoot, "tunnel-hub-registration-token")), false);
});

test("Tunnel Hub runtime registers desktop broker before connecting integrated tunnel", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-tunnel-runtime-"));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const registrations = [];
  const connectCalls = [];
  const relay = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      registrations.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        deviceId: "mac-mini-office",
        publicHost: "mac-mini-office.relay.example.test",
        publicUrl: "https://mac-mini-office.relay.example.test",
        webSocketUrl: "wss://mac-mini-office.relay.example.test/ws",
        relayUrl: `ws://127.0.0.1:${relay.address().port}/tunnel`,
        agentToken: "returned-runtime-token"
      }));
    });
  });
  const relayAddress = await listen(relay);
  t.after(async () => {
    await closeServer(relay);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const relayUrl = `ws://127.0.0.1:${relayAddress.port}/tunnel`;
  writeSsoSiteToken(homePath, "runtime-registration-secret");
  assert.equal(saveTunnelHubSettings(app, {
    enabled: true,
    relayUrl,
    deviceId: "mac-mini-office"
  }).ok, true);

  configureTunnelHubRegistrationController({
    logger: { log() {}, warn() {}, error() {} }
  });

  const runtime = new TunnelHubRuntime({
    app,
    desktopWsServerOptions: {
      app,
      desktopActionOptions: {},
      assistantBridge: {
        listAgents: async () => [],
        startRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "started" })
      },
      getTaskBoardRuntime: () => null
    },
    createTunnelClient(input) {
      connectCalls.push(input);
      return {
        async connect() {},
        close() {},
        on() {}
      };
    },
    logger: { log() {}, warn() {}, error() {} }
  });

  const result = await runtime.start();
  assert.equal(result.ok, true);
  assert.equal(result.status.phase, "connected");
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].method, "POST");
  assert.equal(registrations[0].url, "/api/desktop/devices/register");
  assert.equal(registrations[0].authorization, "Bearer runtime-registration-secret");
  assert.equal(connectCalls.length, 1);
  assert.equal(connectCalls[0].relayUrl, relayUrl);
  assert.equal(connectCalls[0].relayToken, "returned-runtime-token");
  assert.equal(connectCalls[0].deviceId, "mac-mini-office");
  assert.equal(typeof connectCalls[0].desktopWsServerOptions.verifyToken, "undefined");
  assert.equal(readTunnelHubSettings(app).webSocketUrl, "wss://mac-mini-office.relay.example.test/ws");
  await runtime.stop();
});

test("Tunnel Client endpoint forwards ns=d stream to Desktop protocol through function-level session", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-tunnel-protocol-"));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const fakeRelay = createFakeRelay(async ({ streamReader, sendStreamData }) => {
    sendStreamData(encodeTunnelJson({
      v: 1,
      ns: "d",
      frame: "request",
      type: "desktop.websocket.open",
      id: "open-desktop-1",
      payload: {
        authToken: "test-token",
        source: "test-relay",
        clientDeviceId: "browser-1"
      }
    }));
    const open = await streamReader.readJson();
    assert.equal(open.ns, "d");
    assert.equal(open.frame, "response");
    assert.equal(open.type, "desktop.websocket.open");
    assert.equal(open.id, "open-desktop-1");
    assert.equal(open.code, 0);
    assert.equal(open.data.statusCode, 101);
    await streamReader.readWsJson();
    sendStreamData(encodeTunnelWsFrame(1, Buffer.from(JSON.stringify({
      ns: "d",
      frame: "request",
      type: "session.hello",
      id: "hello-through-tunnel",
      payload: {}
    }), "utf8")));
    let desktopResponse = null;
    for (;;) {
      const frame = await streamReader.readWsJson();
      if (frame.id === "hello-through-tunnel") {
        desktopResponse = frame;
        break;
      }
    }
    sendStreamData(encodeTunnelWsFrame(1, Buffer.from(JSON.stringify({
      ns: "wa",
      frame: "request",
      type: "session.hello",
      id: "wa-hello-through-tunnel",
      payload: {}
    }), "utf8")));
    for (;;) {
      const frame = await streamReader.readWsJson();
      if (frame.id === "wa-hello-through-tunnel") {
        return { desktopResponse, webappResponse: frame };
      }
    }
  });
  const relayAddress = await listen(fakeRelay.server);
  const client = new TunnelClientEndpoint({
    relayUrl: `ws://127.0.0.1:${relayAddress.port}/tunnel`,
    relayToken: "relay-token",
    deviceId: "mac-mini-office",
    desktopWsServerOptions: {
      app,
      desktopActionOptions: {},
      assistantBridge: {
        listAgents: async () => [],
        startRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "started" })
      },
      getTaskBoardRuntime: () => null,
      verifyToken: async (token) => {
        assert.equal(token, "test-token");
        return {
          subject: "app",
          deviceId: "device-1",
          expiresAt: Date.now() + 600_000,
          scope: "app"
        };
      },
      logger: { log() {}, warn() {}, error() {} }
    },
    logger: { log() {}, warn() {}, error() {} }
  });
  t.after(async () => {
    client.close();
    fakeRelay.close();
    await closeServer(fakeRelay.server);
    fs.rmSync(root, { recursive: true, force: true });
  });

  await client.connect();
  const { desktopResponse, webappResponse } = await fakeRelay.start();
  assert.equal(fakeRelay.authorization, "");
  assert.equal(fakeRelay.tunnelOpenRequest.ns, "d");
  assert.equal(fakeRelay.tunnelOpenRequest.frame, "request");
  assert.equal(fakeRelay.tunnelOpenRequest.type, "tunnel.open");
  assert.equal(fakeRelay.tunnelOpenRequest.payload.agentToken, "relay-token");
  assert.equal(fakeRelay.tunnelOpenRequest.payload.deviceId, "mac-mini-office");
  assert.equal(fakeRelay.tunnelOpenRequest.payload.client, "zenmind-desktop");
  assert.deepEqual(fakeRelay.tunnelOpenRequest.payload.capabilities, [
    "desktop.websocket",
    "webapp.http",
    "webapp.websocket"
  ]);
  assert.equal(desktopResponse.ns, "d");
  assert.equal(desktopResponse.frame, "response");
  assert.equal(desktopResponse.type, "session.hello");
  assert.equal(desktopResponse.id, "hello-through-tunnel");
  assert.equal(desktopResponse.code, 0);
  assert.notEqual(desktopResponse.msg, "unknown type: session.hello");
  assert.equal(webappResponse.ns, "wa");
  assert.equal(webappResponse.frame, "response");
  assert.equal(webappResponse.type, "session.hello");
  assert.equal(webappResponse.id, "wa-hello-through-tunnel");
  assert.equal(webappResponse.code, 0);
});

test("Tunnel Client endpoint rejects desktop.websocket.open without payload authToken", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-tunnel-protocol-auth-"));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const fakeRelay = createFakeRelay(async ({ streamReader, sendStreamData }) => {
    sendStreamData(encodeTunnelJson({
      v: 1,
      ns: "d",
      frame: "request",
      type: "desktop.websocket.open",
      id: "open-missing-token",
      authToken: "legacy-top-level-token",
      payload: {
        source: "test-relay"
      }
    }));
    return streamReader.readJson();
  });
  const relayAddress = await listen(fakeRelay.server);
  const client = new TunnelClientEndpoint({
    relayUrl: `ws://127.0.0.1:${relayAddress.port}/tunnel`,
    relayToken: "relay-token",
    deviceId: "mac-mini-office",
    desktopWsServerOptions: createDesktopWsServerOptions(app, {
      verifyToken: async () => {
        throw new Error("top-level authToken must not be used");
      }
    }),
    logger: { log() {}, warn() {}, error() {} }
  });
  t.after(async () => {
    client.close();
    fakeRelay.close();
    await closeServer(fakeRelay.server);
    fs.rmSync(root, { recursive: true, force: true });
  });

  await client.connect();
  const response = await fakeRelay.start();
  assert.equal(response.v, 1);
  assert.equal(response.ns, "d");
  assert.equal(response.frame, "error");
  assert.equal(response.type, "desktop.websocket.open");
  assert.equal(response.id, "open-missing-token");
  assert.equal(response.code, 401);
  assert.equal(response.msg, "authToken is required");
});

test("Tunnel Client endpoint forwards ns=ap stream through agent-platform bridge", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-tunnel-ap-"));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);

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

    send(data) {
      const frame = JSON.parse(data);
      this.sent.push(frame);
      queueMicrotask(() => {
        this.emit("message", { data: JSON.stringify({
          frame: "response",
          type: frame.type,
          id: frame.id,
          code: 0,
          msg: "success",
          data: [{ key: "demo" }]
        }) });
      });
    }

    close(code = 1000, reason = "closed") {
      this.readyState = 3;
      this.emit("close", { type: "close", code, reason });
    }
  }

  const fakeRelay = createFakeRelay(async ({ streamReader, sendStreamData }) => {
    sendStreamData(encodeTunnelJson({
      v: 1,
      ns: "d",
      frame: "request",
      type: "desktop.websocket.open",
      id: "open-ap-1",
      payload: {
        authToken: "test-token",
        source: "test-relay"
      }
    }));
    const open = await streamReader.readJson();
    assert.equal(open.frame, "response");
    assert.equal(open.type, "desktop.websocket.open");
    await streamReader.readWsJson();
    sendStreamData(encodeTunnelWsFrame(1, Buffer.from(JSON.stringify({
      ns: "ap",
      frame: "request",
      type: "/api/agents",
      id: "ap-agents-through-tunnel",
      payload: { includeChats: 1 }
    }), "utf8")));
    for (;;) {
      const frame = await streamReader.readWsJson();
      if (frame.id === "ap-agents-through-tunnel") {
        return frame;
      }
    }
  });
  const relayAddress = await listen(fakeRelay.server);
  const client = new TunnelClientEndpoint({
    relayUrl: `ws://127.0.0.1:${relayAddress.port}/tunnel`,
    relayToken: "relay-token",
    deviceId: "mac-mini-office",
    desktopWsServerOptions: createDesktopWsServerOptions(app, {
      agentPlatformBridge: {
        WebSocketConstructor: FakeAgentPlatformWebSocket,
        getServiceState: async () => ({
          status: "running",
          message: "",
          healthMeta: { webUrl: "http://127.0.0.1:7078", port: 7078 }
        }),
        issueAccessToken: async () => ({ ok: true, token: "platform-token", message: "issued" })
      },
      verifyToken: async (token) => {
        assert.equal(token, "test-token");
        return { subject: "app", deviceId: "device-1", expiresAt: Date.now() + 600_000, scope: "app" };
      }
    }),
    logger: { log() {}, warn() {}, error() {} }
  });
  t.after(async () => {
    client.close();
    fakeRelay.close();
    await closeServer(fakeRelay.server);
    fs.rmSync(root, { recursive: true, force: true });
  });

  await client.connect();
  const response = await fakeRelay.start();
  assert.equal(response.ns, "ap");
  assert.equal(response.frame, "response");
  assert.deepEqual(response.data, [{ key: "demo" }]);
  assert.equal(FakeAgentPlatformWebSocket.sockets.length, 1);
  assert.equal(new URL(FakeAgentPlatformWebSocket.sockets[0].url).searchParams.get("token"), "platform-token");
});

test("Tunnel Client endpoint proxies ns=wa HTTP streams with v1 public upstream metadata and raw body", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-tunnel-wa-http-"));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  let captured = null;
  const responseBody = Buffer.from("chunk-a:chunk-b");
  const local = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      captured = {
        method: req.method,
        url: req.url,
        host: req.headers.host,
        forwardedHost: req.headers["x-forwarded-host"],
        body: Buffer.concat(chunks).toString("utf8")
      };
      res.writeHead(201, {
        "Content-Type": "text/plain",
        "X-Local-Reply": "yes",
        "Content-Length": String(responseBody.byteLength)
      });
      res.end(responseBody);
    });
  });
  const localAddress = await listen(local);
  const requestBody = Buffer.from("hello world");
  const fakeRelay = createFakeRelay(async ({ streamReader, sendStreamData }) => {
    sendStreamData(encodeTunnelJson({
      v: 1,
      ns: "wa",
      frame: "request",
      type: "http.request",
      id: "req_http",
      payload: {
        public: {
          method: "POST",
          path: "/api/foo?x=1",
          host: "demo.wa.zenmind.cc",
          headers: { "content-type": "text/plain" }
        },
        upstream: {
          scheme: "http",
          host: "127.0.0.1",
          port: localAddress.port,
          basePath: "/app"
        },
        route: {
          id: "route_http",
          name: "demo",
          publicHost: "demo.wa.zenmind.cc"
        },
        bodyLength: requestBody.byteLength
      }
    }));
    sendStreamData(requestBody);
    const head = await streamReader.readJson();
    const body = await streamReader.readRaw(head.data.bodyLength);
    return { head, body: body.toString("utf8") };
  });
  const relayAddress = await listen(fakeRelay.server);
  const client = new TunnelClientEndpoint({
    relayUrl: `ws://127.0.0.1:${relayAddress.port}/tunnel`,
    relayToken: "relay-token",
    deviceId: "mac-mini-office",
    desktopWsServerOptions: createDesktopWsServerOptions(app),
    logger: { log() {}, warn() {}, error() {} }
  });
  t.after(async () => {
    client.close();
    fakeRelay.close();
    await closeServer(fakeRelay.server);
    await closeServer(local);
    fs.rmSync(root, { recursive: true, force: true });
  });

  await client.connect();
  const response = await fakeRelay.start();
  assert.equal(response.head.v, 1);
  assert.equal(response.head.ns, "wa");
  assert.equal(response.head.frame, "response");
  assert.equal(response.head.type, "http.request");
  assert.equal(response.head.id, "req_http");
  assert.equal(response.head.code, 0);
  assert.equal(response.head.msg, "success");
  assert.equal(response.head.data.statusCode, 201);
  assert.equal(response.head.data.headers["x-local-reply"], "yes");
  assert.equal(response.head.data.bodyLength, responseBody.byteLength);
  assert.equal(response.body, "chunk-a:chunk-b");
  assert.deepEqual(captured, {
    method: "POST",
    url: "/app/api/foo?x=1",
    host: "demo.wa.zenmind.cc",
    forwardedHost: "demo.wa.zenmind.cc",
    body: "hello world"
  });
});

test("Tunnel Client endpoint streams ns=wa HTTP responses with unknown body length", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-tunnel-wa-http-stream-"));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const local = http.createServer((_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream"
    });
    res.write("event: one\n\n");
    res.end("event: two\n\n");
  });
  const localAddress = await listen(local);
  const fakeRelay = createFakeRelay(async ({ streamReader, sendStreamData }) => {
    sendStreamData(encodeTunnelJson({
      v: 1,
      ns: "wa",
      frame: "request",
      type: "http.request",
      id: "req_stream",
      payload: {
        public: {
          method: "GET",
          path: "/events",
          host: "events.wa.zenmind.cc",
          headers: {}
        },
        upstream: {
          scheme: "http",
          host: "localhost",
          port: localAddress.port,
          basePath: ""
        },
        bodyLength: 0
      }
    }));
    const head = await streamReader.readJson();
    const body = await streamReader.readUntilClosed();
    return { head, body: body.toString("utf8") };
  });
  const relayAddress = await listen(fakeRelay.server);
  const client = new TunnelClientEndpoint({
    relayUrl: `ws://127.0.0.1:${relayAddress.port}/tunnel`,
    relayToken: "relay-token",
    deviceId: "mac-mini-office",
    desktopWsServerOptions: createDesktopWsServerOptions(app),
    logger: { log() {}, warn() {}, error() {} }
  });
  t.after(async () => {
    client.close();
    fakeRelay.close();
    await closeServer(fakeRelay.server);
    await closeServer(local);
    fs.rmSync(root, { recursive: true, force: true });
  });

  await client.connect();
  const response = await fakeRelay.start();
  assert.equal(response.head.frame, "response");
  assert.equal(response.head.type, "http.request");
  assert.equal(response.head.id, "req_stream");
  assert.equal(response.head.code, 0);
  assert.equal(response.head.data.statusCode, 200);
  assert.equal(response.head.data.bodyLength, -1);
  assert.equal(response.body, "event: one\n\nevent: two\n\n");
});

test("Tunnel Client endpoint proxies ns=wa websocket text and binary frames", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-tunnel-wa-ws-"));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  let capturedHost = "";
  const local = http.createServer();
  const localSockets = new Set();
  local.on("upgrade", (req, socket) => {
    localSockets.add(socket);
    socket.on("close", () => localSockets.delete(socket));
    capturedHost = String(req.headers.host ?? "");
    const key = String(req.headers["sec-websocket-key"] ?? "");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
      "",
      ""
    ].join("\r\n"));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = parseClientWsFrames(buffer);
      buffer = parsed.rest;
      for (const frame of parsed.frames) {
        if (frame.opcode === 0x1) {
          socket.write(encodeServerWsFrame(0x1, Buffer.from(`echo:${frame.payload.toString("utf8")}`)));
        }
        if (frame.opcode === 0x2) {
          socket.write(encodeServerWsFrame(0x2, Buffer.concat([Buffer.from([9]), frame.payload])));
        }
      }
    });
  });
  const localAddress = await listen(local);
  const fakeRelay = createFakeRelay(async ({ streamReader, sendStreamData }) => {
    sendStreamData(encodeTunnelJson({
      v: 1,
      ns: "wa",
      frame: "request",
      type: "websocket.connect",
      id: "req_ws",
      payload: {
        public: {
          method: "GET",
          path: "/socket?room=1",
          host: "socket.wa.zenmind.cc",
          headers: {}
        },
        upstream: {
          scheme: "ws",
          host: "127.0.0.1",
          port: localAddress.port,
          basePath: ""
        },
        route: {
          id: "route_ws",
          name: "socket",
          publicHost: "socket.wa.zenmind.cc"
        }
      }
    }));
    const upgrade = await streamReader.readJson();
    assert.equal(upgrade.v, 1);
    assert.equal(upgrade.ns, "wa");
    assert.equal(upgrade.frame, "response");
    assert.equal(upgrade.type, "websocket.connect");
    assert.equal(upgrade.id, "req_ws");
    assert.equal(upgrade.code, 0);
    assert.equal(upgrade.data.statusCode, 101);
    sendStreamData(encodeTunnelWsFrame(1, Buffer.from("hello")));
    const text = await streamReader.readWsFrame();
    sendStreamData(encodeTunnelWsFrame(2, Buffer.from([1, 2, 3])));
    const binary = await streamReader.readWsFrame();
    return { text, binary };
  });
  const relayAddress = await listen(fakeRelay.server);
  const client = new TunnelClientEndpoint({
    relayUrl: `ws://127.0.0.1:${relayAddress.port}/tunnel`,
    relayToken: "relay-token",
    deviceId: "mac-mini-office",
    desktopWsServerOptions: createDesktopWsServerOptions(app),
    logger: { log() {}, warn() {}, error() {} }
  });
  t.after(async () => {
    client.close();
    fakeRelay.close();
    for (const socket of localSockets) {
      socket.destroy();
    }
    await closeServer(fakeRelay.server);
    await closeServer(local);
    fs.rmSync(root, { recursive: true, force: true });
  });

  await client.connect();
  const response = await fakeRelay.start();
  assert.equal(capturedHost, "socket.wa.zenmind.cc");
  assert.equal(response.text.type, 1);
  assert.equal(response.text.payload.toString("utf8"), "echo:hello");
  assert.equal(response.binary.type, 2);
  assert.deepEqual([...response.binary.payload], [9, 1, 2, 3]);
});

test("Tunnel Client endpoint rejects invalid ns=wa envelope", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-tunnel-wa-invalid-"));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const fakeRelay = createFakeRelay(async ({ streamReader, sendStreamData }) => {
    sendStreamData(encodeTunnelJson({
      ns: "wa",
      kind: "http",
      nsPort: 0,
      nsProtocol: "http",
      method: "GET",
      path: "/"
    }));
    return streamReader.readJson();
  });
  const relayAddress = await listen(fakeRelay.server);
  const client = new TunnelClientEndpoint({
    relayUrl: `ws://127.0.0.1:${relayAddress.port}/tunnel`,
    relayToken: "relay-token",
    deviceId: "mac-mini-office",
    desktopWsServerOptions: createDesktopWsServerOptions(app),
    logger: { log() {}, warn() {}, error() {} }
  });
  t.after(async () => {
    client.close();
    fakeRelay.close();
    await closeServer(fakeRelay.server);
    fs.rmSync(root, { recursive: true, force: true });
  });

  await client.connect();
  const response = await fakeRelay.start();
  assert.equal(response.v, 1);
  assert.equal(response.ns, "wa");
  assert.equal(response.frame, "error");
  assert.equal(response.type, "error");
  assert.equal(response.code, 400);
  assert.match(response.msg, /v=1/u);
});

test("Tunnel Client endpoint rejects non-loopback ns=wa upstream hosts", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-tunnel-wa-host-invalid-"));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const fakeRelay = createFakeRelay(async ({ streamReader, sendStreamData }) => {
    sendStreamData(encodeTunnelJson({
      v: 1,
      ns: "wa",
      frame: "request",
      type: "http.request",
      id: "req_bad_host",
      payload: {
        public: {
          method: "GET",
          path: "/",
          host: "bad.wa.zenmind.cc",
          headers: {}
        },
        upstream: {
          scheme: "http",
          host: "example.com",
          port: 80,
          basePath: ""
        },
        bodyLength: 0
      }
    }));
    return streamReader.readJson();
  });
  const relayAddress = await listen(fakeRelay.server);
  const client = new TunnelClientEndpoint({
    relayUrl: `ws://127.0.0.1:${relayAddress.port}/tunnel`,
    relayToken: "relay-token",
    deviceId: "mac-mini-office",
    desktopWsServerOptions: createDesktopWsServerOptions(app),
    logger: { log() {}, warn() {}, error() {} }
  });
  t.after(async () => {
    client.close();
    fakeRelay.close();
    await closeServer(fakeRelay.server);
    fs.rmSync(root, { recursive: true, force: true });
  });

  await client.connect();
  const response = await fakeRelay.start();
  assert.equal(response.v, 1);
  assert.equal(response.ns, "wa");
  assert.equal(response.frame, "error");
  assert.equal(response.type, "http.request");
  assert.equal(response.id, "req_bad_host");
  assert.equal(response.code, 400);
  assert.match(response.msg, /loopback/u);
});

test("Tunnel Client endpoint rejects malformed ns=wa v1 metadata", async () => {
  const cases = [
    {
      name: "unknown-type",
      envelope: {
        v: 1,
        ns: "wa",
        frame: "request",
        type: "http",
        id: "req_unknown_type",
        payload: {
          public: { method: "GET", path: "/", host: "bad.wa.zenmind.cc", headers: {} },
          upstream: { scheme: "http", host: "127.0.0.1", port: 5173, basePath: "" },
          bodyLength: 0
        }
      },
      error: /unknown webapp stream type/u
    },
    {
      name: "invalid-body-length",
      envelope: {
        v: 1,
        ns: "wa",
        frame: "request",
        type: "http.request",
        id: "req_bad_body",
        payload: {
          public: { method: "POST", path: "/", host: "bad.wa.zenmind.cc", headers: {} },
          upstream: { scheme: "http", host: "127.0.0.1", port: 5173, basePath: "" },
          bodyLength: -1
        }
      },
      error: /bodyLength/u
    },
    {
      name: "invalid-port",
      envelope: {
        v: 1,
        ns: "wa",
        frame: "request",
        type: "http.request",
        id: "req_bad_port",
        payload: {
          public: { method: "GET", path: "/", host: "bad.wa.zenmind.cc", headers: {} },
          upstream: { scheme: "http", host: "127.0.0.1", port: 0, basePath: "" },
          bodyLength: 0
        }
      },
      error: /upstream\.port/u
    },
    {
      name: "http-scheme-mismatch",
      envelope: {
        v: 1,
        ns: "wa",
        frame: "request",
        type: "http.request",
        id: "req_http_scheme",
        payload: {
          public: { method: "GET", path: "/", host: "bad.wa.zenmind.cc", headers: {} },
          upstream: { scheme: "ws", host: "127.0.0.1", port: 5173, basePath: "" },
          bodyLength: 0
        }
      },
      error: /http or https/u
    },
    {
      name: "websocket-scheme-mismatch",
      envelope: {
        v: 1,
        ns: "wa",
        frame: "request",
        type: "websocket.connect",
        id: "req_ws_scheme",
        payload: {
          public: { method: "GET", path: "/", host: "bad.wa.zenmind.cc", headers: {} },
          upstream: { scheme: "http", host: "127.0.0.1", port: 5173, basePath: "" }
        }
      },
      error: /ws or wss/u
    }
  ];

  for (const testCase of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `zenmind-tunnel-wa-${testCase.name}-`));
    const homePath = path.join(root, "home");
    const app = createApp(homePath);
    const fakeRelay = createFakeRelay(async ({ streamReader, sendStreamData }) => {
      sendStreamData(encodeTunnelJson(testCase.envelope));
      return streamReader.readJson();
    });
    const relayAddress = await listen(fakeRelay.server);
    const client = new TunnelClientEndpoint({
      relayUrl: `ws://127.0.0.1:${relayAddress.port}/tunnel`,
      relayToken: "relay-token",
      deviceId: "mac-mini-office",
      desktopWsServerOptions: createDesktopWsServerOptions(app),
      logger: { log() {}, warn() {}, error() {} }
    });
    try {
      await client.connect();
      const response = await fakeRelay.start();
      assert.equal(response.v, 1);
      assert.equal(response.ns, "wa");
      assert.equal(response.frame, "error");
      assert.equal(response.type, testCase.envelope.type);
      assert.equal(response.code, 400);
      assert.match(response.msg, testCase.error);
    } finally {
      client.close();
      fakeRelay.close();
      await closeServer(fakeRelay.server);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
