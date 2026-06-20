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
  startDesktopRemoteWsServer,
  stopDesktopRemoteWsServer
} = require("../dist-electron/main/desktop-ws-server.js");
const {
  configureTunnelHubRemoteWsController
} = require("../dist-electron/main/tunnel-hub-remote-ws.js");
const {
  TunnelHubRuntime
} = require("../dist-electron/main/tunnel-hub-runtime.js");
const {
  TunnelHubTunnelClient
} = require("../dist-electron/main/tunnel-hub-tunnel-client.js");
const {
  readTunnelHubSettings,
  saveTunnelHubSettings
} = require("../dist-electron/main/tunnel-hub-settings.js");

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const TYPE_DATA = 0;
const TYPE_WINDOW_UPDATE = 1;
const FLAG_SYN = 0x1;
const INITIAL_WINDOW = 256 * 1024;

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

function encodeYamuxFrame(type, flags, streamId, length, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(12);
  header[0] = 0;
  header[1] = type;
  header.writeUInt16BE(flags, 2);
  header.writeUInt32BE(streamId, 4);
  header.writeUInt32BE(length, 8);
  return Buffer.concat([header, payload]);
}

function parseYamuxFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 12 <= buffer.byteLength) {
    const type = buffer[offset + 1];
    const flags = buffer.readUInt16BE(offset + 2);
    const streamId = buffer.readUInt32BE(offset + 4);
    const length = buffer.readUInt32BE(offset + 8);
    const payloadLength = type === TYPE_DATA ? length : 0;
    if (offset + 12 + payloadLength > buffer.byteLength) {
      break;
    }
    frames.push({
      type,
      flags,
      streamId,
      length,
      payload: payloadLength > 0 ? buffer.subarray(offset + 12, offset + 12 + payloadLength) : Buffer.alloc(0)
    });
    offset += 12 + payloadLength;
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
  const waiters = [];

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
  }

  async function readBytes(size) {
    if (buffer.byteLength >= size) {
      const data = buffer.subarray(0, size);
      buffer = buffer.subarray(size);
      return data;
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
    async readJson() {
      const prefix = await readBytes(4);
      return JSON.parse((await readBytes(prefix.readUInt32BE(0))).toString("utf8"));
    },
    async readWsJson() {
      const header = await readBytes(9);
      const payload = await readBytes(Number(header.readBigUInt64BE(1)));
      return JSON.parse(payload.toString("utf8"));
    }
  };
}

function createFakeRelay({ targetUrl }) {
  const streamId = 2;
  const streamReader = createStreamReader();
  let socket = null;
  let wsBuffer = Buffer.alloc(0);
  let yamuxBuffer = Buffer.alloc(0);
  let authorization = "";
  let upgradedResolve;
  const upgraded = new Promise((resolve) => {
    upgradedResolve = resolve;
  });

  function sendWsBinary(payload) {
    socket.write(encodeServerWsFrame(0x2, payload));
  }

  function sendYamux(type, flags, id, length, payload = Buffer.alloc(0)) {
    sendWsBinary(encodeYamuxFrame(type, flags, id, length, payload));
  }

  function sendStreamData(payload) {
    sendYamux(TYPE_DATA, 0, streamId, payload.byteLength, payload);
  }

  async function runScenario() {
    sendYamux(TYPE_WINDOW_UPDATE, FLAG_SYN, streamId, INITIAL_WINDOW);
    sendStreamData(encodeTunnelJson({
      kind: "websocket",
      requestId: "req-remote-ws",
      method: "GET",
      path: "/ws?token=test-token",
      host: "mac-mini-office.relay.example.test",
      target: targetUrl,
      header: {}
    }));
    const upgrade = await streamReader.readJson();
    assert.equal(upgrade.ok, true);
    assert.equal(upgrade.statusCode, 101);
    sendStreamData(encodeTunnelWsFrame(1, Buffer.from(JSON.stringify({
      ns: "d",
      frame: "request",
      type: "session.hello",
      id: "hello-through-tunnel",
      payload: {}
    }), "utf8")));
    for (;;) {
      const frame = await streamReader.readWsJson();
      if (frame.id === "hello-through-tunnel") {
        return frame;
      }
    }
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
        if (frame.opcode !== 0x2) {
          continue;
        }
        yamuxBuffer = Buffer.concat([yamuxBuffer, frame.payload]);
        const yamuxFrames = parseYamuxFrames(yamuxBuffer);
        yamuxBuffer = yamuxFrames.rest;
        for (const yamuxFrame of yamuxFrames.frames) {
          if (yamuxFrame.type === TYPE_DATA && yamuxFrame.streamId === streamId) {
            streamReader.append(yamuxFrame.payload);
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
    async start() {
      await upgraded;
      return runScenario();
    },
    close() {
      socket?.destroy();
    }
  };
}

test("Tunnel Hub runtime registers 7083 target before connecting integrated tunnel", async (t) => {
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
        targetUrl: "http://127.0.0.1:7083",
        relayToken: "returned-runtime-token"
      }));
    });
  });
  const relayAddress = await listen(relay);
  t.after(async () => {
    await stopDesktopRemoteWsServer();
    await closeServer(relay);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const relayUrl = `ws://127.0.0.1:${relayAddress.port}/tunnel`;
  assert.equal(saveTunnelHubSettings(app, {
    enabled: true,
    relayUrl,
    deviceId: "mac-mini-office",
    registrationToken: "registration-secret"
  }).ok, true);

  configureTunnelHubRemoteWsController({
    desktopWsServerOptions: {
      app,
      desktopActionOptions: {},
      assistantBridge: {
        listAgents: async () => [],
        startRun: async () => ({ ok: true, runId: "run-1", chatId: "chat-1", message: "started" })
      },
      getTaskBoardRuntime: () => null,
      verifyToken: async () => ({ subject: "app", deviceId: "device-1", expiresAt: Date.now() + 600_000, scope: "app" }),
      logger: { log() {}, warn() {}, error() {} }
    },
    startRemoteWsServer: async () => ({
      running: true,
      host: "127.0.0.1",
      port: 7083,
      path: "/ws",
      url: "ws://127.0.0.1:7083/ws",
      webSocketUrl: "ws://127.0.0.1:7083/ws"
    }),
    getRemoteWsServerRuntimeState: () => ({
      running: true,
      host: "127.0.0.1",
      port: 7083,
      path: "/ws",
      url: "ws://127.0.0.1:7083/ws"
    }),
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
  assert.equal(registrations[0].authorization, "Bearer registration-secret");
  assert.equal(registrations[0].body.targetUrl, "http://127.0.0.1:7083");
  assert.notEqual(registrations[0].body.targetUrl, "http://127.0.0.1:7082");
  assert.equal(connectCalls.length, 1);
  assert.equal(connectCalls[0].relayUrl, relayUrl);
  assert.equal(connectCalls[0].relayToken, "returned-runtime-token");
  assert.equal(readTunnelHubSettings(app).webSocketUrl, "wss://mac-mini-office.relay.example.test/ws");
  await runtime.stop();
});

test("Tunnel Hub integrated tunnel forwards remote ws stream to Desktop 7083 protocol", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-tunnel-protocol-"));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const remote = await startDesktopRemoteWsServer({
    app,
    host: "127.0.0.1",
    port: 0,
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
  });
  const fakeRelay = createFakeRelay({ targetUrl: `http://127.0.0.1:${remote.port}` });
  const relayAddress = await listen(fakeRelay.server);
  const client = new TunnelHubTunnelClient({
    relayUrl: `ws://127.0.0.1:${relayAddress.port}/tunnel`,
    relayToken: "relay-token",
    logger: { log() {}, warn() {}, error() {} }
  });
  t.after(async () => {
    client.close();
    fakeRelay.close();
    await stopDesktopRemoteWsServer();
    await closeServer(fakeRelay.server);
    fs.rmSync(root, { recursive: true, force: true });
  });

  await client.connect();
  const response = await fakeRelay.start();
  assert.equal(fakeRelay.authorization, "Bearer relay-token");
  assert.equal(response.ns, "d");
  assert.equal(response.frame, "response");
  assert.equal(response.type, "session.hello");
  assert.equal(response.id, "hello-through-tunnel");
  assert.equal(response.code, 0);
  assert.notEqual(response.msg, "unknown type: session.hello");
});
