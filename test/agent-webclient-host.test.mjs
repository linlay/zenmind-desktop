import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  startAgentWebclientHost,
  stopAgentWebclientHost
} = require("../dist-electron/main/services/agent-webclient-host.js");

function getAvailableLocalPort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!port) {
          reject(new Error("Failed to allocate a local test port."));
          return;
        }
        resolve(port);
      });
    });
  });
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-webclient-host-"));
  const programDir = path.join(root, "program");
  const configDir = path.join(root, "config");
  const dataDir = path.join(root, "data");
  const stateDir = path.join(root, "state");
  const logDir = path.join(root, "logs");
  const distDir = path.join(programDir, "frontend", "dist");
  fs.mkdirSync(path.join(distDir, "assets"), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, "index.html"), "<!doctype html><div id=\"root\">agent</div>\n", "utf8");
  fs.writeFileSync(path.join(distDir, "assets", "app.js"), "globalThis.agentApp = true;\n", "utf8");
  return {
    root,
    service: {
      id: "agent-webclient",
      frontend: {
        mode: "standalone",
        entry: "/",
        hostManaged: true
      }
    },
    layout: {
      programDir,
      configDir,
      dataDir,
      stateDir,
      logDir,
      envPath: path.join(configDir, ".env")
    }
  };
}

function listenHttp(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        server,
        url: `http://127.0.0.1:${port}`
      });
    });
  });
}

function listenRawUpgrade(handler) {
  const server = net.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        server,
        url: `http://127.0.0.1:${port}`
      });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function readBody(response) {
  return response.text();
}

function openRawUpgrade(port, requestPath, headers = []) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const chunks = [];
    socket.once("connect", () => {
      socket.write([
        `GET ${requestPath} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
        "",
        ""
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("latin1");
      if (/\r\n\r\n/u.test(text)) {
        socket.destroy();
        resolve(text);
      }
    });
    socket.once("error", reject);
    socket.setTimeout(1500, () => {
      socket.destroy(new Error("raw upgrade timeout"));
    });
  });
}

test("agent webclient host serves frontend, runtime config, and HTTP proxies", async () => {
  const fixture = createFixture();
  const port = await getAvailableLocalPort();
  let queryAcceptEncoding = "not-called";
  let attachAcceptEncoding = "not-called";
  const api = await listenHttp((req, res) => {
    if (req.url === "/api/query") {
      queryAcceptEncoding = String(req.headers["accept-encoding"] ?? "");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("data: ok\n\n");
      return;
    }
    if (req.url === "/api/attach") {
      attachAcceptEncoding = String(req.headers["accept-encoding"] ?? "");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("data: attach\n\n");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`api:${req.url}`);
  });

  try {
    fs.writeFileSync(
      fixture.layout.envPath,
      [
        `PORT=${port}`,
        "DESKTOP_APP=true",
        "DEBUG_PANEL_ENABLED=true",
        `BASE_URL=${api.url}`,
        ""
      ].join("\n"),
      "utf8"
    );
    await startAgentWebclientHost({
      service: fixture.service,
      layout: fixture.layout,
      env: new Map([
        ["BASE_URL", api.url],
        ["PORT", String(port)]
      ]),
      port
    });

    assert.match(await readBody(await fetch(`http://127.0.0.1:${port}/`)), /id="root"/);
    assert.match(await readBody(await fetch(`http://127.0.0.1:${port}/assets/app.js`)), /agentApp/);
    assert.match(await readBody(await fetch(`http://127.0.0.1:${port}/agents/demo`)), /id="root"/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/missing.png`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/%2e%2e/package.json`)).status, 404);

    const runtimeConfig = await readBody(await fetch(`http://127.0.0.1:${port}/runtime-config.js`));
    assert.match(runtimeConfig, /DEBUG_PANEL_ENABLED/);
    assert.match(runtimeConfig, /VOICE_ENABLED":"false"/);

    assert.equal(await readBody(await fetch(`http://127.0.0.1:${port}/api/ping`)), "api:/api/ping");
    const voiceResponse = await fetch(`http://127.0.0.1:${port}/api/voice/ping`);
    assert.equal(voiceResponse.status, 404);
    assert.deepEqual(await voiceResponse.json(), { error: "voice disabled" });
    const voiceUpgrade = await openRawUpgrade(port, "/api/voice/ws");
    assert.match(voiceUpgrade, /^HTTP\/1\.1 404 Not Found/);
    assert.match(voiceUpgrade, /"voice disabled"/);

    const queryResponse = await fetch(`http://127.0.0.1:${port}/api/query`);
    assert.equal(queryResponse.headers.get("x-accel-buffering"), "no");
    assert.equal(queryResponse.headers.get("cache-control"), "no-cache, no-transform");
    assert.equal(await queryResponse.text(), "data: ok\n\n");
    assert.equal(queryAcceptEncoding, "");
    const attachResponse = await fetch(`http://127.0.0.1:${port}/api/attach`);
    assert.equal(attachResponse.headers.get("x-accel-buffering"), "no");
    assert.equal(attachResponse.headers.get("cache-control"), "no-cache, no-transform");
    assert.equal(await attachResponse.text(), "data: attach\n\n");
    assert.equal(attachAcceptEncoding, "");
  } finally {
    await stopAgentWebclientHost();
    await closeServer(api.server);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("agent webclient host uses manifest desktop hosting routes", async () => {
  const fixture = createFixture();
  const port = await getAvailableLocalPort();
  fixture.service.frontend.spa = true;
  fixture.service.desktop = {
    hosting: {
      runtimeConfig: {
        path: "/desktop-runtime.js",
        envKeys: ["CUSTOM_FLAG"]
      },
      spaRoutes: ["/custom/"],
      proxyRoutes: [
        {
          match: "prefix",
          path: "/platform",
          targetEnv: "BASE_URL",
          websocket: true,
          ssePaths: ["/platform/stream"],
          disableProxyBuffering: true,
          stripRequestHeaders: ["sec-websocket-extensions"]
        }
      ]
    }
  };
  let streamAcceptEncoding = "not-called";
  const api = await listenHttp((req, res) => {
    if (req.url === "/platform/stream") {
      streamAcceptEncoding = String(req.headers["accept-encoding"] ?? "");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("data: platform\n\n");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`platform:${req.url}`);
  });

  try {
    fs.writeFileSync(
      fixture.layout.envPath,
      [
        `PORT=${port}`,
        "DESKTOP_APP=true",
        "CUSTOM_FLAG=enabled",
        `BASE_URL=${api.url}`,
        ""
      ].join("\n"),
      "utf8"
    );
    await startAgentWebclientHost({
      service: fixture.service,
      layout: fixture.layout,
      env: new Map([
        ["BASE_URL", api.url],
        ["PORT", String(port)]
      ]),
      port
    });

    assert.equal((await fetch(`http://127.0.0.1:${port}/runtime-config.js`)).status, 404);
    assert.match(await readBody(await fetch(`http://127.0.0.1:${port}/desktop-runtime.js`)), /CUSTOM_FLAG":"enabled"/);
    assert.match(await readBody(await fetch(`http://127.0.0.1:${port}/custom/page`)), /id="root"/);
    assert.equal(await readBody(await fetch(`http://127.0.0.1:${port}/platform/ping`)), "platform:/platform/ping");
    const streamResponse = await fetch(`http://127.0.0.1:${port}/platform/stream`);
    assert.equal(streamResponse.headers.get("x-accel-buffering"), "no");
    assert.equal(await streamResponse.text(), "data: platform\n\n");
    assert.equal(streamAcceptEncoding, "");
  } finally {
    await stopAgentWebclientHost();
    await closeServer(api.server);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("agent webclient host proxies configured voice routes", async () => {
  const fixture = createFixture();
  const port = await getAvailableLocalPort();
  const api = await listenHttp((_req, res) => {
    res.end("api");
  });
  const voice = await listenHttp((req, res) => {
    res.end(`voice:${req.url}`);
  });

  try {
    fs.writeFileSync(fixture.layout.envPath, `PORT=${port}\nDESKTOP_APP=true\nBASE_URL=${api.url}\nVOICE_BASE_URL=${voice.url}\n`, "utf8");
    await startAgentWebclientHost({
      service: fixture.service,
      layout: fixture.layout,
      env: new Map([
        ["BASE_URL", api.url],
        ["VOICE_BASE_URL", voice.url]
      ]),
      port
    });

    assert.equal(await readBody(await fetch(`http://127.0.0.1:${port}/api/voice/ping`)), "voice:/api/voice/ping");
    const runtimeConfig = await readBody(await fetch(`http://127.0.0.1:${port}/runtime-config.js`));
    assert.match(runtimeConfig, /VOICE_ENABLED":"true"/);
  } finally {
    await stopAgentWebclientHost();
    await closeServer(api.server);
    await closeServer(voice.server);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("agent webclient host gates /ws and strips websocket extensions upstream", async () => {
  const fixture = createFixture();
  const port = await getAvailableLocalPort();
  const upstreamRequests = [];
  const upstream = await listenRawUpgrade((socket) => {
    socket.once("data", (chunk) => {
      upstreamRequests.push(chunk.toString("latin1"));
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
    });
  });

  try {
    fs.writeFileSync(fixture.layout.envPath, `PORT=${port}\nDESKTOP_APP=true\nBASE_URL=${upstream.url}\n`, "utf8");
    await startAgentWebclientHost({
      service: fixture.service,
      layout: fixture.layout,
      env: new Map([["BASE_URL", upstream.url]]),
      port
    });

    const blocked = await openRawUpgrade(port, "/ws");
    assert.match(blocked, /^HTTP\/1\.1 401 Unauthorized/);
    assert.equal(upstreamRequests.length, 0);

    const forwarded = await openRawUpgrade(port, "/ws?token=abc", [
      "Sec-WebSocket-Extensions: permessage-deflate",
      "Sec-WebSocket-Protocol: bearer.demo"
    ]);
    assert.match(forwarded, /^HTTP\/1\.1 401 Unauthorized/);
    assert.equal(upstreamRequests.length, 1);
    assert.doesNotMatch(upstreamRequests[0], /sec-websocket-extensions/iu);
    assert.match(upstreamRequests[0], /Sec-WebSocket-Protocol: bearer\.demo/u);
    assert.match(upstreamRequests[0], /GET \/ws\?token=abc HTTP\/1\.1/u);
  } finally {
    await stopAgentWebclientHost();
    await closeServer(upstream.server);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("agent webclient host issues missing /ws access tokens without replacing supplied tokens", async () => {
  const fixture = createFixture();
  const port = await getAvailableLocalPort();
  const issuedReasons = [];
  const upstreamRequests = [];
  const upstream = await listenRawUpgrade((socket) => {
    socket.once("data", (chunk) => {
      upstreamRequests.push(chunk.toString("latin1"));
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
    });
  });

  try {
    fs.writeFileSync(fixture.layout.envPath, `PORT=${port}\nDESKTOP_APP=true\nBASE_URL=${upstream.url}\n`, "utf8");
    await startAgentWebclientHost({
      service: fixture.service,
      layout: fixture.layout,
      env: new Map([["BASE_URL", upstream.url]]),
      port,
      issueAccessToken: async (reason) => {
        issuedReasons.push(reason);
        return { ok: true, token: "desktop-token", message: "" };
      }
    });

    const forwardedMissingToken = await openRawUpgrade(port, "/ws", [
      "Sec-WebSocket-Extensions: permessage-deflate"
    ]);
    assert.match(forwardedMissingToken, /^HTTP\/1\.1 401 Unauthorized/);
    assert.deepEqual(issuedReasons, ["missing"]);
    assert.equal(upstreamRequests.length, 1);
    assert.match(upstreamRequests[0], /GET \/ws\?token=desktop-token HTTP\/1\.1/u);
    assert.doesNotMatch(upstreamRequests[0], /sec-websocket-extensions/iu);

    const forwardedSuppliedToken = await openRawUpgrade(port, "/ws?token=abc");
    assert.match(forwardedSuppliedToken, /^HTTP\/1\.1 401 Unauthorized/);
    assert.deepEqual(issuedReasons, ["missing"]);
    assert.equal(upstreamRequests.length, 2);
    assert.match(upstreamRequests[1], /GET \/ws\?token=abc HTTP\/1\.1/u);
  } finally {
    await stopAgentWebclientHost();
    await closeServer(upstream.server);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("agent webclient host keeps upgraded connections as raw tunnels", async () => {
  const fixture = createFixture();
  const port = await getAvailableLocalPort();
  let upstreamSawClientBytes = false;
  const upstream = await listenRawUpgrade((socket) => {
    let handshakeComplete = false;
    socket.on("data", (chunk) => {
      const text = chunk.toString("latin1");
      if (!handshakeComplete) {
        handshakeComplete = true;
        socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
        return;
      }
      if (text.includes("client-bytes")) {
        upstreamSawClientBytes = true;
        socket.write("server-bytes");
      }
    });
  });

  try {
    fs.writeFileSync(fixture.layout.envPath, `PORT=${port}\nDESKTOP_APP=true\nBASE_URL=${upstream.url}\n`, "utf8");
    await startAgentWebclientHost({
      service: fixture.service,
      layout: fixture.layout,
      env: new Map([["BASE_URL", upstream.url]]),
      port
    });

    const response = await new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1");
      let received = "";
      socket.once("connect", () => {
        socket.write([
          "GET /ws?token=abc HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "",
          ""
        ].join("\r\n"));
      });
      socket.on("data", (chunk) => {
        received += chunk.toString("latin1");
        if (received.includes("\r\n\r\n") && !received.includes("server-bytes")) {
          socket.write("client-bytes");
        }
        if (received.includes("server-bytes")) {
          socket.destroy();
          resolve(received);
        }
      });
      socket.once("error", reject);
      socket.setTimeout(1500, () => {
        socket.destroy(new Error("raw tunnel timeout"));
      });
    });

    assert.match(response, /^HTTP\/1\.1 101 Switching Protocols/);
    assert.match(response, /server-bytes/);
    assert.equal(upstreamSawClientBytes, true);
  } finally {
    await stopAgentWebclientHost();
    await closeServer(upstream.server);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
