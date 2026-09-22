import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createBrowserWebclientHost } = require("../dist-electron/main/modules/services/browser-webclient-host.js");
const { ensureBrowserWebclient, stopBrowserWebclient, getBrowserWebclientState } = require("../dist-electron/main/modules/services/browser-webclient-runtime.js");
const { registerBrowserWebclientIpc } = require("../dist-electron/main/modules/services/browser-webclient-ipc.js");
const { hosts } = require("../dist-electron/main/modules/services/webclient-host-runtime.js");

const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
function request(url, options = {}, body = "") {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, res => {
      let text = ""; res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject); req.end(body);
  });
}
function token(sub = "user-1") { return `header.${Buffer.from(JSON.stringify({ iss: "local-identity", sub, exp: Math.floor(Date.now()/1000) + 3600 })).toString("base64url")}.signature`; }
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-webclient-"));
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><title>WebClient fixture</title>");
  const seen = [];
  const upstreamSockets = new Set();
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}');
  });
  upstream.on("connection", socket => { upstreamSockets.add(socket); socket.on("close", () => upstreamSockets.delete(socket)); });
  upstream.on("upgrade", (req, socket) => {
    seen.push({ url: req.url, headers: req.headers });
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${req.headers["sec-websocket-protocol"]}\r\n\r\n`);
    socket.on("data", data => socket.write(data));
  });
  const port = await listen(upstream);
  let subject = "user-1";
  const record = {
    frontendDist: root, indexFile: path.join(root, "index.html"), frontendSpa: true,
    layout: { envPath: path.join(root, ".env") }, env: new Map(), envOverrides: new Map([["BASE_URL", `http://127.0.0.1:${port}`], ["DESKTOP_APP", "true"]]),
    hosting: { runtimeConfigPath: "/runtime-config.js", runtimeConfigEnvKeys: ["DESKTOP_APP", "BASE_URL"], spaRoutePrefixes: [], proxyRoutes: [{ path: "/api", targetEnv: "BASE_URL" }] },
    issueAccessToken: async () => ({ ok: true, token: token(subject) })
  };
  t.after(async () => { await stopBrowserWebclient(); for (const socket of upstreamSockets) socket.destroy(); await new Promise(resolve => upstream.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  return { record, seen, setSubject: value => { subject = value; } };
}
async function authorize(host, previousCookie = "") {
  const launch = new URL(await host.launchUrl());
  const page = await request(launch);
  assert.equal(page.status, 200);
  assert.ok(!page.text.includes("signature"));
  assert.ok(page.text.includes("history.replaceState"));
  const response = await request(`${host.url}/__desktop/session`, { method: "POST", headers: { Origin: host.url, Cookie: previousCookie } }, launch.hash.slice(1));
  assert.equal(response.status, 204);
  const cookie = response.headers["set-cookie"][0];
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  return { cookie: cookie.split(";")[0], ticket: launch.hash.slice(1) };
}

test("browser host isolates standalone configuration, requires a launch session, and injects auth", async t => {
  const { record, seen, setSubject } = await fixture(t);
  const host = await createBrowserWebclientHost(record, 0); t.after(() => host.stop());
  assert.equal((await request(host.url)).status, 401);
  assert.equal((await request(`${host.url}/api/agents`)).status, 401);
  assert.equal((await request(`${host.url}/__desktop/session`, { method: "POST" }, "bad")).status, 403);
  const { cookie, ticket } = await authorize(host);
  assert.equal((await request(`${host.url}/__desktop/session`, { method: "POST", headers: { Origin: host.url } }, ticket)).status, 401);
  const headers = { Cookie: cookie };
  const config = await request(`${host.url}/runtime-config.js`, { headers });
  assert.match(config.text, /"DESKTOP_APP":"false"/);
  assert.match(config.text, /"BACKEND_MODE":"platform"/);
  assert.equal(record.envOverrides.get("DESKTOP_APP"), "true");
  assert.equal((await request(host.url, { headers })).status, 200);
  assert.equal((await request(`${host.url}/api/agents`, { headers: { ...headers, Authorization: "Bearer supplied-by-page" } })).status, 200);
  assert.equal(seen.at(-1).headers.authorization, `Bearer ${token()}`);
  assert.equal(seen.at(-1).headers.cookie, undefined);
  assert.equal((await request(`${host.url}/api/agents`, { headers: { ...headers, Origin: "http://127.0.0.1:9999" } })).status, 403);
  assert.equal((await request(host.url, { headers: { ...headers, Host: "evil.example" } })).status, 403);
  assert.equal((await request(`${host.url}/api/desktop/test`, { headers })).status, 403);
  setSubject("user-2");
  assert.equal((await request(`${host.url}/api/agents`, { headers })).status, 401);
});

test("occupied preferred port falls back without stopping its owner", async t => {
  const { record } = await fixture(t);
  const occupied = http.createServer((req, res) => res.end("original"));
  const port = await listen(occupied); t.after(() => new Promise(resolve => occupied.close(resolve)));
  const host = await createBrowserWebclientHost(record, port); t.after(() => host.stop());
  assert.notEqual(new URL(host.url).port, String(port));
  assert.equal((await request(`http://127.0.0.1:${port}`)).text, "original");
});

test("WebSocket proxy keeps bearer credentials private and rejects cross-origin upgrades", async t => {
  const { record, seen } = await fixture(t);
  const host = await createBrowserWebclientHost(record, 0); t.after(() => host.stop());
  const { cookie } = await authorize(host);
  const headers = { Origin: host.url, Cookie: cookie, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" };
  const { socket, response } = await new Promise((resolve, reject) => {
    const req = http.request(`${host.url}/ws?source=desktop-main&deviceId=spoofed`, { headers });
    req.on("upgrade", (response, socket) => resolve({ response, socket })); req.on("error", reject); req.end();
  });
  assert.equal(response.headers["sec-websocket-protocol"], undefined);
  assert.ok(!JSON.stringify(response.headers).includes("signature"));
  assert.equal(seen.at(-1).headers["sec-websocket-protocol"], `bearer.${token()}`);
  assert.equal(seen.at(-1).url, "/ws?source=webclient");
  const echoed = new Promise(resolve => socket.once("data", chunk => resolve(chunk.toString())));
  socket.write("frame-payload"); assert.equal(await echoed, "frame-payload");
  assert.equal((await request(`${host.url}/ws`, { headers: { ...headers, Origin: "https://evil.example" } })).status, 401);
  const closed = new Promise(resolve => socket.once("close", resolve));
  await host.stop(); await closed;
  assert.equal(socket.destroyed, true);
});

test("runtime reuses its listener and trusted IPC opens the OS browser on macOS and Windows", async t => {
  const { record } = await fixture(t);
  hosts.set("agent-webclient", record); t.after(() => hosts.delete("agent-webclient"));
  for (const platform of ["darwin", "win32"]) {
    const handlers = new Map(); const opened = [];
    const contents = { mainFrame: {}, isDestroyed: () => false };
    let ready = true;
    registerBrowserWebclientIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
      app: {}, platform, getMainWindow: () => ({ webContents: contents }),
      openBrowserExternal: async url => { opened.push(url); }, getServiceState: async () => ({ status: ready ? "running" : "stopped" }), runServiceMutation: task => task()
    });
    const event = { sender: contents, senderFrame: contents.mainFrame };
    assert.equal((await handlers.get("services.openBrowserWebclient")({ sender: {}, senderFrame: {} })).ok, false);
    ready = false;
    assert.equal((await handlers.get("services.openBrowserWebclient")(event)).ok, false);
    ready = true;
    assert.equal((await handlers.get("services.openBrowserWebclient")(event)).ok, false);
    assert.equal((await handlers.get("services.startBrowserWebclient")({ sender: {}, senderFrame: {} })).ok, false);
    ready = false;
    assert.equal((await handlers.get("services.startBrowserWebclient")(event)).ok, false);
    ready = true;
    const started = await handlers.get("services.startBrowserWebclient")(event);
    assert.equal(started.ok, true);
    assert.equal(started.running, true);
    assert.equal(opened.length, 0);
    assert.equal((await handlers.get("services.startBrowserWebclient")(event)).url, started.url);
    const first = await handlers.get("services.openBrowserWebclient")(event);
    const second = await handlers.get("services.openBrowserWebclient")(event);
    assert.equal(first.ok, true); assert.equal(second.url, first.url); assert.equal(opened.length, 2);
    assert.equal(new URL(opened[0]).origin, first.url);
    assert.ok(!JSON.stringify(first).includes(new URL(opened[0]).hash.slice(1)));
    assert.equal(await ensureBrowserWebclient(record), await ensureBrowserWebclient(record));
    assert.equal((await handlers.get("services.stopBrowserWebclient")(event)).running, false);
    assert.equal(getBrowserWebclientState().url, "");
  }
});


test("repeated launches renew the same browser session and expired tickets cannot authenticate", async t => {
  const { record } = await fixture(t);
  const host = await createBrowserWebclientHost(record, 0); t.after(() => host.stop());
  let { cookie } = await authorize(host);
  const initialCookie = cookie;
  for (let index = 0; index < 20; index++) {
    ({ cookie } = await authorize(host, cookie));
    assert.equal(cookie, initialCookie);
  }
  const launch = new URL(await host.launchUrl());
  const now = Date.now;
  try {
    Date.now = () => now() + 61_000;
    assert.equal((await request(`${host.url}/__desktop/session`, { method: "POST", headers: { Origin: host.url } }, launch.hash.slice(1))).status, 401);
    Date.now = () => now() + 3_601_000;
    assert.equal((await request(`${host.url}/api/agents`, { headers: { Cookie: cookie } })).status, 401);
  } finally { Date.now = now; }
});

test("stopping during listener startup prevents a late running instance", async t => {
  const { record } = await fixture(t);
  const starting = ensureBrowserWebclient(record);
  const rejected = assert.rejects(starting, /cancelled/);
  await stopBrowserWebclient();
  await rejected;
  assert.equal(getBrowserWebclientState().running, false);
});
