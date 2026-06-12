import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  readWebsiteItems,
  writeExternalWebsiteItems
} = require("../dist-electron/main/websites/website-store.js");
const {
  readWebsiteOrderKeys,
  writeWebsiteOrderKeys,
  applyWebsiteOrder
} = require("../dist-electron/main/websites/website-order-store.js");
const {
  websiteAppRuntime
} = require("../dist-electron/main/websites/website-app-runtime.js");
const {
  installBundledWebsiteTemplates
} = require("../dist-electron/main/websites/website-template-installer.js");

function createApp(homePath, appPath = process.cwd()) {
  return {
    getPath(name) {
      if (name === "home") return homePath;
      if (name === "appData") return path.join(homePath, "app-data");
      if (name === "temp") return os.tmpdir();
      if (name === "desktop") return path.join(homePath, "Desktop");
      assert.fail(`unexpected app.getPath(${name})`);
    },
    getAppPath() {
      return appPath;
    }
  };
}

function desktopRoot(homePath) {
  return path.join(homePath, ".zenmind", ".desktop");
}

function websitesRoot(homePath) {
  return path.join(desktopRoot(homePath), "data", "websites");
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeLocalApp(root, id, options = {}) {
  const appDir = path.join(root, id);
  fs.mkdirSync(path.join(appDir, "frontend"), { recursive: true });
  fs.mkdirSync(path.join(appDir, "backend"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "frontend", "index.html"), "<!doctype html><div id=\"app\">demo</div>", "utf8");
  fs.writeFileSync(path.join(appDir, "backend", "server.mjs"), `
import http from "node:http";
const host = process.env.HOST || "127.0.0.1";
const port = Number.parseInt(process.env.PORT || "0", 10);
const server = http.createServer((req, res) => {
  if (req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === "/api/demo") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, id: process.env.WEBSITE_ID, root: process.env.WEBSITE_ROOT }));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false }));
});
server.listen(port, host);
`, "utf8");
  writeJson(path.join(appDir, "website.json"), {
    schemaVersion: 2,
    id,
    kind: "local-app",
    label: options.label ?? "Local Demo",
    frontend: {
      root: "frontend",
      index: "index.html",
      spa: true,
      apiPrefix: "/api"
    },
    backend: {
      runtime: options.runtime ?? "node",
      entry: options.entry ?? "backend/server.mjs",
      args: [],
      env: {},
      port: 0,
      healthPath: "/api/health"
    }
  });
  return appDir;
}

function readUrl(target) {
  return new Promise((resolve, reject) => {
    http.get(target, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        statusCode: res.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
        contentType: String(res.headers["content-type"] ?? "")
      }));
    }).on("error", reject);
  });
}

test("website store reads external and local app manifests without deleting local apps", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-websites-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const siteRoot = websitesRoot(homePath);

  writeJson(path.join(siteRoot, "docs", "website.json"), {
    schemaVersion: 1,
    id: "docs",
    label: "Docs",
    url: "https://docs.example.com/"
  });
  writeLocalApp(siteRoot, "local-demo");

  const items = readWebsiteItems(app);
  assert.deepEqual(items.map((item) => item.kind).sort(), ["external", "local-app"]);
  assert.equal(items.find((item) => item.id === "local-demo")?.kind, "local-app");

  writeExternalWebsiteItems(app, [
    {
      id: "docs",
      kind: "external",
      label: "Docs 2",
      url: "https://docs2.example.com/",
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
  ]);

  assert.equal(fs.existsSync(path.join(siteRoot, "local-demo", "website.json")), true);
  const afterWrite = readWebsiteItems(app);
  assert.equal(afterWrite.some((item) => item.id === "local-demo" && item.kind === "local-app"), true);
});

test("website store rejects unsafe local app manifests", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-websites-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const siteRoot = websitesRoot(homePath);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  t.after(() => {
    console.warn = originalWarn;
  });

  writeLocalApp(siteRoot, "bad-runtime", { runtime: "python" });
  writeLocalApp(siteRoot, "bad-entry", { entry: "../server.mjs" });

  const items = readWebsiteItems(app);
  assert.equal(items.some((item) => item.id === "bad-runtime"), false);
  assert.equal(items.some((item) => item.id === "bad-entry"), false);
  assert.equal(warnings.length, 2);
});

test("website order stores canonical config and migrates custom keys", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-websites-order-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);

  const keys = writeWebsiteOrderKeys(app, ["custom:second", "custom:first"]);
  assert.deepEqual(keys, ["custom:second", "custom:first"]);
  assert.deepEqual(readWebsiteOrderKeys(app), ["custom:second", "custom:first"]);

  const ordered = applyWebsiteOrder(app, [
    { id: "first", kind: "external", label: "First", url: "https://first.example.com/", createdAt: 1, updatedAt: 1 },
    { id: "second", kind: "external", label: "Second", url: "https://second.example.com/", createdAt: 2, updatedAt: 2 }
  ]);
  assert.deepEqual(ordered.map((item) => item.id), ["second", "first"]);
});

test("website runtime starts frontend, proxies api, writes logs, and stops", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-websites-runtime-"));
  t.after(async () => {
    await websiteAppRuntime.stopAll(createApp(path.join(root, "home")));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeLocalApp(websitesRoot(homePath), "runtime-demo");

  const result = await websiteAppRuntime.start(app, "runtime-demo");
  assert.equal(result.ok, true);
  assert.equal(result.state?.status, "running");
  assert.match(result.state?.webUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+\//);

  const page = await readUrl(result.state.webUrl);
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /demo/);

  const api = await readUrl(new URL("/api/demo", result.state.webUrl).toString());
  assert.equal(api.statusCode, 200);
  assert.equal(JSON.parse(api.body).id, "runtime-demo");

  const logResult = websiteAppRuntime.readLog(app, "runtime-demo", "main");
  assert.equal(logResult.ok, true);
  assert.equal(logResult.exists, true);

  const stopResult = await websiteAppRuntime.stop(app, "runtime-demo");
  assert.equal(stopResult.ok, true);
  assert.equal(stopResult.state?.status, "stopped");
});

test("bundled website template installer copies demo once", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-websites-template-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appPath = path.join(root, "app");
  const homePath = path.join(root, "home");
  const sourceDir = path.join(appPath, "public", "website-templates", "demo-node-html");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "website.json"), "{}\n", "utf8");

  const app = createApp(homePath, appPath);
  const first = installBundledWebsiteTemplates(app);
  assert.equal(first.ok, true);
  assert.equal(first.installed, true);
  assert.equal(fs.existsSync(path.join(websitesRoot(homePath), "demo-node-html", "website.json")), true);

  fs.writeFileSync(path.join(websitesRoot(homePath), "demo-node-html", "marker.txt"), "user", "utf8");
  const second = installBundledWebsiteTemplates(app);
  assert.equal(second.installed, false);
  assert.equal(fs.readFileSync(path.join(websitesRoot(homePath), "demo-node-html", "marker.txt"), "utf8"), "user");
});
