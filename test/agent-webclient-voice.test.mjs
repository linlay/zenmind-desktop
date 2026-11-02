import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { normalizeManifest } = require("../dist-electron/main/support/manifest/manifest-utils.js");
const { startAgentWebclientHost, stopAgentWebclientHost } = require("../dist-electron/main/modules/services/agent-webclient-host.js");
const listen = server => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });
const upgrade = (url, origin) => new Promise((resolve, reject) => {
  const req = http.request(url, { headers: { Origin: origin, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" } });
  req.on("upgrade", (response, socket) => resolve({ status: response.statusCode, socket }));
  req.on("response", response => { response.resume(); resolve({ status: response.statusCode }); });
  req.on("error", error => error.code === "ECONNRESET" ? resolve({ status: 0 }) : reject(error)); req.end();
});

test("voice shares Platform auth and origin while retaining the Frame Port boundary", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webclient-voice-"));
  fs.mkdirSync(path.join(root, "frontend/dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "frontend/dist/index.html"), "<!doctype html><title>voice fixture</title>");
  const seen = [], peers = new Set();
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"code":0,"msg":"ok","data":{"enabled":true}}');
  });
  upstream.on("connection", socket => { peers.add(socket); socket.on("close", () => peers.delete(socket)); });
  upstream.on("upgrade", (req, socket) => {
    seen.push({ url: req.url, headers: req.headers });
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  const port = await listen(upstream);
  t.after(async () => { await stopAgentWebclientHost(); for (const peer of peers) peer.destroy(); await new Promise(resolve => upstream.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const service = normalizeManifest({ id: "agent-webclient", version: "2", lifecycle: { start: "start.sh", stop: "stop.sh" }, frontend: { mode: "standalone", hostManaged: true, dist: "frontend/dist" } }, { defaultKind: "builtin" });
  const probe = http.createServer(); const hostPort = await listen(probe); await new Promise(resolve => probe.close(resolve));
  const host = await startAgentWebclientHost({ service, layout: { programDir: root, envPath: path.join(root, ".env") },
    env: new Map([["BASE_URL", `http://127.0.0.1:${port}`], ["VOICE_ENABLED", "true"]]), port: hostPort,
    logger: { log() {}, warn() {}, error() {} }, issueAccessToken: async () => ({ ok: true, token: "fixture-token" }),
  });
  const origin = new URL(host.webUrl).origin;
  const config = await (await fetch(`${origin}/runtime-config.js`)).text();
  assert.match(config, /"VOICE_ENABLED":"true"/);
  assert.doesNotMatch(config, /VOICE_BASE_URL|VOICE_ASR_CLIENT_GATE/);
  assert.equal((await fetch(`${origin}/api/voice/capabilities`)).status, 200);
  assert.equal(seen.at(-1).headers.authorization, "Bearer fixture-token");
  const connected = await upgrade(`${origin}/api/voice/ws`, origin);
  assert.equal(connected.status, 101);
  assert.equal(seen.at(-1).url, "/api/voice/ws");
  assert.equal(seen.at(-1).headers.authorization, "Bearer fixture-token");
  assert.equal(seen.at(-1).headers.origin, `http://127.0.0.1:${port}`);
  connected.socket.destroy();
  const before = seen.length;
  for (const [url, from] of [["/api/voice/ws", "https://evil.example"], ["/api/voice/ws?token=legacy", origin], ["/api/voice/other", origin], ["/ws", origin]]) {
    assert.notEqual((await upgrade(`${origin}${url}`, from)).status, 101);
  }
  assert.equal(seen.length, before);
  assert.equal((await fetch(`${origin}/api/attach?runId=run`)).status, 404);
});
