import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { normalizeManifest } = require("../dist-electron/main/manifest-utils.js");
const {
  startAgentWebclientHost,
  stopAgentWebclientHost,
} = require("../dist-electron/main/services/agent-webclient-host.js");

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

test("Frame Port host injects and refreshes /api auth while blocking HTTP Run bypasses", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webclient-host-v2-"));
  const frontendDist = path.join(root, "frontend", "dist");
  fs.mkdirSync(frontendDist, { recursive: true });
  fs.writeFileSync(path.join(frontendDist, "index.html"), "<!doctype html><title>fixture</title>");
  const upstreamRequests = [];
  const upstream = http.createServer((req, res) => {
    upstreamRequests.push({ url: req.url, authorization: req.headers.authorization || "" });
    if (req.headers.authorization !== "Bearer fresh-token") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const probe = http.createServer();
  const hostPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  const tokenReasons = [];
  const service = normalizeManifest({
    id: "agent-webclient",
    version: "2.0.0",
    lifecycle: { start: "start.sh", stop: "stop.sh" },
    frontend: { mode: "standalone", hostManaged: true, dist: "frontend/dist", index: "index.html" },
    desktop: { hosting: { proxyRoutes: [{
      match: "prefix",
      path: "/api",
      targetEnv: "BASE_URL",
      http: true,
      websocket: false,
      auth: "agent-platform-access-token",
    }] } },
  }, { defaultKind: "builtin" });
  t.after(async () => {
    await stopAgentWebclientHost();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  await startAgentWebclientHost({
    service,
    layout: { programDir: root, envPath: path.join(root, ".env") },
    env: new Map([["BASE_URL", `http://127.0.0.1:${upstreamPort}`]]),
    port: hostPort,
    logger: { log() {}, warn() {}, error() {} },
    issueAccessToken: async (reason) => {
      tokenReasons.push(reason);
      return { ok: true, token: reason === "unauthorized" ? "fresh-token" : "stale-token", message: "" };
    },
  });

  const baseUrl = `http://127.0.0.1:${hostPort}`;
  const response = await fetch(`${baseUrl}/api/agent?agentKey=demo`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(tokenReasons, ["missing", "unauthorized"]);
  assert.deepEqual(upstreamRequests.map((item) => item.authorization), [
    "Bearer stale-token",
    "Bearer fresh-token",
  ]);

  for (const route of [
    "/ws", "/ws/", "/api/query", "/api/query/", "/api/%71uery", "/api/attach", "/api/submit",
    "/api/interrupt", "/api/steer", "/api/access-level",
  ]) {
    const blocked = await fetch(`${baseUrl}${route}`, { method: route === "/ws" ? "GET" : "POST" });
    assert.equal(blocked.status, 404, route);
    assert.equal((await blocked.json()).error, "desktop_realtime_bridge_required");
  }
  assert.equal(upstreamRequests.length, 2);
});
