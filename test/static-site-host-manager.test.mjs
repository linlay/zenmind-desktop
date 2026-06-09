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
  StaticSiteHostManager,
  __testInternals
} = require("../dist-electron/main/static-site-host-manager.js");

function createStaticRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-static-host-"));
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><h1>Home</h1>\n", "utf8");
  fs.writeFileSync(path.join(root, "app.js"), "console.log('asset');\n", "utf8");
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1\n", "utf8");
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", "index.html"), "<!doctype html><p>Sub</p>\n", "utf8");
  fs.mkdirSync(path.join(root, "empty"));
  return root;
}

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

async function rawHttpRequest(port, requestPath, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: requestPath,
      method
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

test("StaticSiteHostManager starts, lists, stops, and restarts a static site", async () => {
  const root = createStaticRoot();
  const manager = new StaticSiteHostManager();
  const port = await getFreePort();

  try {
    const started = await manager.start({ rootDir: root, siteId: "preview", port });
    assert.equal(started.siteId, "preview");
    assert.equal(started.running, true);
    assert.equal(started.port, port);
    assert.equal(started.webUrl, `http://127.0.0.1:${port}/`);

    assert.equal(manager.list().length, 1);
    assert.equal(manager.list()[0].running, true);

    const stopped = await manager.stop("preview");
    assert.equal(stopped.running, false);
    assert.equal(stopped.port, null);
    assert.equal(stopped.webUrl, "");
    assert.equal(manager.list()[0].rootDir, started.rootDir);

    const restarted = await manager.restart("preview");
    assert.equal(restarted.running, true);
    assert.equal(restarted.port, port);
  } finally {
    await manager.stopAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("StaticSiteHostManager reports explicit port conflicts as port_in_use", async () => {
  const root = createStaticRoot();
  const manager = new StaticSiteHostManager();
  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  const address = blocker.address();
  const port = typeof address === "object" && address ? address.port : 0;

  try {
    await assert.rejects(
      () => manager.start({ rootDir: root, siteId: "blocked", port }),
      (error) => {
        assert.equal(error.code, "port_in_use");
        assert.match(error.message, /already in use/u);
        return true;
      }
    );
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    await manager.stopAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("StaticSiteHostManager auto-port selection starts at the configured lower bound", async () => {
  const root = createStaticRoot();
  const port = await getFreePort();
  const manager = new StaticSiteHostManager({ autoPortStart: port, autoPortEnd: port });

  try {
    assert.equal(__testInternals.DEFAULT_AUTO_PORT_START, 8000);
    const started = await manager.start({ rootDir: root, siteId: "auto-port" });
    assert.equal(started.port, port);
  } finally {
    await manager.stopAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("StaticSiteHostManager serves files, SPA fallbacks, HEAD, missing files, and 405s", async () => {
  const root = createStaticRoot();
  const manager = new StaticSiteHostManager();
  const port = await getFreePort();

  try {
    const started = await manager.start({ rootDir: root, siteId: "http-rules", port });
    const home = await fetch(started.webUrl);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Home/u);
    assert.equal(home.headers.get("cache-control"), "no-store");

    const asset = await fetch(new URL("/app.js", started.webUrl));
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") || "", /text\/javascript/u);
    assert.match(await asset.text(), /asset/u);

    const head = await fetch(new URL("/app.js", started.webUrl), { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");

    const subIndex = await fetch(new URL("/sub/", started.webUrl));
    assert.equal(subIndex.status, 200);
    assert.match(await subIndex.text(), /Sub/u);

    const noDirectoryListing = await fetch(new URL("/empty/", started.webUrl));
    assert.equal(noDirectoryListing.status, 404);

    const spaFallback = await fetch(new URL("/dashboard/settings", started.webUrl));
    assert.equal(spaFallback.status, 200);
    assert.match(await spaFallback.text(), /Home/u);

    const missingAsset = await fetch(new URL("/missing.js", started.webUrl));
    assert.equal(missingAsset.status, 404);

    const methodNotAllowed = await fetch(started.webUrl, { method: "POST" });
    assert.equal(methodNotAllowed.status, 405);
    assert.equal(methodNotAllowed.headers.get("allow"), "GET, HEAD");
  } finally {
    await manager.stopAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("StaticSiteHostManager blocks hidden files and path traversal", async () => {
  const root = createStaticRoot();
  const manager = new StaticSiteHostManager();
  const port = await getFreePort();

  try {
    await manager.start({ rootDir: root, siteId: "blocked-paths", port });

    const hidden = await rawHttpRequest(port, "/.env");
    assert.equal(hidden.status, 404);
    assert.doesNotMatch(hidden.body, /SECRET/u);

    const traversal = await rawHttpRequest(port, "/%2e%2e/package.json");
    assert.equal(traversal.status, 404);
  } finally {
    await manager.stopAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Static site path containment handles POSIX and Windows path rules explicitly", () => {
  assert.equal(__testInternals.isPathInsideRoot("/tmp/site", "/tmp/site/index.html", "darwin"), true);
  assert.equal(__testInternals.isPathInsideRoot("/tmp/site", "/tmp/site-other/index.html", "darwin"), false);

  assert.equal(
    __testInternals.isPathInsideRoot("C:\\Users\\Lin\\site", "C:\\Users\\Lin\\site\\index.html", "win32"),
    true
  );
  assert.equal(
    __testInternals.isPathInsideRoot("C:\\Users\\Lin\\site", "C:\\Users\\Lin\\site-other\\index.html", "win32"),
    false
  );
});
