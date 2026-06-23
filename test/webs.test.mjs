import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { APP_BRAND } = require("../dist-electron/shared/brand.js");

const {
  readWebsiteItems,
  writeWebsiteItems
} = require("../dist-electron/main/webs/websites/store.js");
const {
  readWebappItems
} = require("../dist-electron/main/webs/webapps/store.js");
const {
  readWebItems
} = require("../dist-electron/main/webs/store.js");
const {
  applyWebOrder,
  readWebOrderKeys,
  writeWebOrderKeys
} = require("../dist-electron/main/webs/order-store.js");
const {
  webappRuntime
} = require("../dist-electron/main/webs/webapps/runtime.js");
const {
  __testInternals: webappTemplateInstallerInternals,
  installBundledWebappTemplates
} = require("../dist-electron/main/webs/webapps/template-installer.js");
const {
  createResourceDirectoryWatcher
} = require("../dist-electron/main/resource-directory-watcher.js");
const {
  getDesktopPetsDataRoot,
  getPluginsRoot
} = require("../dist-electron/main/user-paths.js");

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
  return path.join(homePath, APP_BRAND.paths.runtimeRootDirName, APP_BRAND.paths.desktopDataSubdir);
}

function websitesRoot(homePath) {
  return path.join(desktopRoot(homePath), "data", "webs", "websites");
}

function webappsRoot(homePath) {
  return path.join(desktopRoot(homePath), "data", "webs", "webapps");
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeWebsite(root, id, options = {}) {
  writeJson(path.join(root, id, "website.json"), {
    schemaVersion: 1,
    id,
    kind: "website",
    label: options.label ?? "Docs",
    url: options.url ?? `https://${id}.example.com/`,
    agentKey: options.agentKey,
    createdAt: options.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: options.updatedAt ?? "2026-01-01T00:00:00.000Z"
  });
}

function writeWebapp(root, id, options = {}) {
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
    res.end(JSON.stringify({
      ok: true,
      webappId: process.env.WEBAPP_ID,
      root: process.env.WEBAPP_ROOT,
      stateDir: process.env.WEBAPP_STATE_DIR,
      logDir: process.env.WEBAPP_LOG_DIR
    }));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false }));
});
server.listen(port, host);
`, "utf8");
  writeJson(path.join(appDir, "webapp.json"), {
    schemaVersion: 1,
    id,
    kind: "webapp",
    label: options.label ?? "Local Demo",
    frontend: {
      root: options.frontendRoot ?? "frontend",
      index: options.frontendIndex ?? "index.html",
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
    },
    createdAt: options.createdAt ?? "2026-01-02T00:00:00.000Z",
    updatedAt: options.updatedAt ?? "2026-01-02T00:00:00.000Z"
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

function createFakeWatchHarness() {
  const watchers = [];
  const timers = [];
  const fsImpl = {
    existsSync: fs.existsSync,
    mkdirSync: fs.mkdirSync,
    readdirSync: fs.readdirSync,
    statSync: fs.statSync,
    watch(targetPath, _options, listener) {
      const watcher = {
        targetPath,
        listener,
        closed: false,
        close() {
          watcher.closed = true;
        }
      };
      watchers.push(watcher);
      return watcher;
    }
  };

  function setTimeoutImpl(callback, ms) {
    const timer = {
      callback,
      ms,
      cleared: false
    };
    timers.push(timer);
    return timer;
  }

  function clearTimeoutImpl(timer) {
    timer.cleared = true;
  }

  function emit(targetPath, eventType = "rename", filename = "resource") {
    for (const watcher of watchers) {
      if (!watcher.closed && watcher.targetPath === targetPath) {
        watcher.listener(eventType, filename);
      }
    }
  }

  function flushTimers() {
    const pending = timers.splice(0);
    for (const timer of pending) {
      if (!timer.cleared) {
        timer.callback();
      }
    }
  }

  function activePaths() {
    return watchers
      .filter((watcher) => !watcher.closed)
      .map((watcher) => watcher.targetPath)
      .sort();
  }

  return {
    fsImpl,
    setTimeoutImpl,
    clearTimeoutImpl,
    emit,
    flushTimers,
    activePaths
  };
}

test("web stores read canonical website and webapp manifests", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webs-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);

  writeWebsite(websitesRoot(homePath), "docs", { createdAt: "2026-01-01T00:00:00.000Z" });
  writeWebapp(webappsRoot(homePath), "local-demo", { createdAt: "2026-01-02T00:00:00.000Z" });

  const websites = readWebsiteItems(app);
  const webapps = readWebappItems(app);
  const all = readWebItems(app);

  assert.deepEqual(websites.map((item) => [item.kind, item.entryKey]), [["website", "website:docs"]]);
  assert.deepEqual(webapps.map((item) => [item.kind, item.entryKey]), [["webapp", "webapp:local-demo"]]);
  assert.deepEqual(all.map((item) => item.entryKey), ["website:docs", "webapp:local-demo"]);

  writeWebsiteItems(app, [
    {
      id: "docs",
      entryKey: "website:docs",
      kind: "website",
      label: "Docs 2",
      url: "https://docs2.example.com/",
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
  ]);

  assert.equal(fs.existsSync(path.join(webappsRoot(homePath), "local-demo", "webapp.json")), true);
  const websiteManifest = JSON.parse(fs.readFileSync(path.join(websitesRoot(homePath), "docs", "website.json"), "utf8"));
  assert.equal(websiteManifest.kind, "website");
});

test("webapp store rejects unsafe manifests", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapps-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  t.after(() => {
    console.warn = originalWarn;
  });

  writeWebapp(webappsRoot(homePath), "bad-runtime", { runtime: "python" });
  writeWebapp(webappsRoot(homePath), "bad-entry", { entry: "../server.mjs" });
  writeWebapp(webappsRoot(homePath), "bad-frontend", { frontendRoot: "../frontend" });

  const items = readWebappItems(app);
  assert.equal(items.some((item) => item.id === "bad-runtime"), false);
  assert.equal(items.some((item) => item.id === "bad-entry"), false);
  assert.equal(items.some((item) => item.id === "bad-frontend"), false);
  assert.equal(warnings.length, 3);
});

test("resource directory watcher debounces and refreshes web, pet, and plugin domains", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-resource-watcher-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const petRoot = getDesktopPetsDataRoot(app);
  const pluginRoot = getPluginsRoot(app);
  const pluginVersionRoot = path.join(pluginRoot, "alpha-plugin", "1.0.0");
  fs.mkdirSync(path.join(websitesRoot(homePath), "docs"), { recursive: true });
  fs.mkdirSync(webappsRoot(homePath), { recursive: true });
  fs.mkdirSync(path.join(desktopRoot(homePath), "config", "webs"), { recursive: true });
  fs.mkdirSync(path.join(petRoot, "pony"), { recursive: true });
  fs.mkdirSync(pluginVersionRoot, { recursive: true });

  const harness = createFakeWatchHarness();
  const changes = [];
  const watcher = createResourceDirectoryWatcher({
    app,
    platform: "darwin",
    debounceMs: 50,
    fsImpl: harness.fsImpl,
    setTimeoutImpl: harness.setTimeoutImpl,
    clearTimeoutImpl: harness.clearTimeoutImpl,
    onWebsChanged: () => changes.push("webs"),
    onPetsChanged: () => changes.push("pets"),
    onPluginsChanged: () => changes.push("plugins")
  });
  watcher.start();

  assert.ok(harness.activePaths().includes(websitesRoot(homePath)));
  assert.ok(harness.activePaths().includes(path.join(websitesRoot(homePath), "docs")));
  assert.ok(harness.activePaths().includes(petRoot));
  assert.ok(harness.activePaths().includes(path.join(petRoot, "pony")));
  assert.ok(harness.activePaths().includes(pluginRoot));
  assert.ok(harness.activePaths().includes(path.join(pluginRoot, "alpha-plugin")));
  assert.ok(harness.activePaths().includes(pluginVersionRoot));

  harness.emit(websitesRoot(homePath));
  harness.emit(websitesRoot(homePath), "change", "website.json");
  harness.flushTimers();
  assert.deepEqual(changes, ["webs"]);

  fs.mkdirSync(path.join(petRoot, "desk-cat"), { recursive: true });
  harness.emit(petRoot);
  harness.flushTimers();
  assert.deepEqual(changes, ["webs", "pets"]);
  assert.ok(harness.activePaths().includes(path.join(petRoot, "desk-cat")));

  const nextPluginVersionRoot = path.join(pluginRoot, "beta-plugin", "2.0.0");
  fs.mkdirSync(nextPluginVersionRoot, { recursive: true });
  harness.emit(pluginRoot);
  harness.flushTimers();
  assert.deepEqual(changes, ["webs", "pets", "plugins"]);
  assert.ok(harness.activePaths().includes(path.join(pluginRoot, "beta-plugin")));
  assert.ok(harness.activePaths().includes(nextPluginVersionRoot));

  watcher.stop();
  assert.deepEqual(harness.activePaths(), []);
});

test("web order stores entryKey values and sorts mixed website and webapp entries", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webs-order-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);

  const keys = writeWebOrderKeys(app, ["webapp:second", "website:first", "custom:legacy"]);
  assert.deepEqual(keys, ["webapp:second", "website:first", "website:legacy"]);
  assert.deepEqual(readWebOrderKeys(app), ["webapp:second", "website:first", "website:legacy"]);

  const ordered = applyWebOrder(app, [
    { id: "first", entryKey: "website:first", kind: "website", label: "First", url: "https://first.example.com/", createdAt: 1, updatedAt: 1 },
    { id: "second", entryKey: "webapp:second", kind: "webapp", label: "Second", frontend: {}, backend: {}, createdAt: 2, updatedAt: 2 }
  ]);
  assert.deepEqual(ordered.map((item) => item.entryKey), ["webapp:second", "website:first"]);
});

test("webapp runtime starts frontend, proxies api, writes logs, and stops", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-runtime-"));
  t.after(async () => {
    await webappRuntime.stopAll(createApp(path.join(root, "home")));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeWebapp(webappsRoot(homePath), "runtime-demo");

  const result = await webappRuntime.start(app, "runtime-demo");
  assert.equal(result.ok, true);
  assert.equal(result.state?.kind, "webapp");
  assert.equal(result.state?.entryKey, "webapp:runtime-demo");
  assert.equal(result.state?.status, "running");
  assert.match(result.state?.webUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+\//);

  const page = await readUrl(result.state.webUrl);
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /demo/);

  const api = await readUrl(new URL("/api/demo", result.state.webUrl).toString());
  assert.equal(api.statusCode, 200);
  const body = JSON.parse(api.body);
  assert.equal(body.webappId, "runtime-demo");
  assert.match(body.stateDir, /state[\\/]webs[\\/]webapps[\\/]runtime-demo/u);
  assert.match(body.logDir, /logs[\\/]webs[\\/]webapps[\\/]runtime-demo/u);

  const logResult = webappRuntime.readLog(app, "runtime-demo", "main");
  assert.equal(logResult.ok, true);
  assert.equal(logResult.exists, true);

  const stopResult = await webappRuntime.stop(app, "runtime-demo");
  assert.equal(stopResult.ok, true);
  assert.equal(stopResult.state?.status, "stopped");
});

test("bundled webapp template installer is gated by demo manifest and refreshes demo on macOS and Windows branches", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-template-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const resourcesRoot = path.join(root, "resources");
  const app = createApp(homePath, path.join(root, "app"));

  const absent = installBundledWebappTemplates(app, { resourcesRoot, platform: "darwin" });
  assert.equal(absent.ok, true);
  assert.equal(absent.installed, false);
  assert.equal(fs.existsSync(path.join(webappsRoot(homePath), "demo-node-html", "webapp.json")), false);

  const sourceDir = path.join(resourcesRoot, "demo", "webapp-templates", "demo-node-html");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "webapp.json"), "{}\n", "utf8");
  fs.writeFileSync(path.join(sourceDir, "marker.txt"), "packaged", "utf8");
  writeJson(path.join(resourcesRoot, "demo", "manifest.json"), {
    schemaVersion: 1,
    bundled: true,
    webappTemplates: ["demo-node-html"]
  });

  assert.deepEqual(
    webappTemplateInstallerInternals.listTemplateRootCandidates(app, resourcesRoot, "darwin"),
    [path.join(resourcesRoot, "demo", "webapp-templates")]
  );
  assert.deepEqual(
    webappTemplateInstallerInternals.listTemplateRootCandidates(app, resourcesRoot, "win32"),
    [path.join(resourcesRoot, "demo", "webapp-templates")]
  );

  const first = installBundledWebappTemplates(app, { resourcesRoot, platform: "darwin" });
  assert.equal(first.ok, true);
  assert.equal(first.installed, true);
  assert.equal(fs.existsSync(path.join(webappsRoot(homePath), "demo-node-html", "webapp.json")), true);

  fs.writeFileSync(path.join(webappsRoot(homePath), "demo-node-html", "marker.txt"), "user", "utf8");
  fs.writeFileSync(path.join(webappsRoot(homePath), "demo-node-html", "stale.txt"), "stale", "utf8");
  const second = installBundledWebappTemplates(app, { resourcesRoot, platform: "win32" });
  assert.equal(second.installed, true);
  assert.equal(fs.readFileSync(path.join(webappsRoot(homePath), "demo-node-html", "marker.txt"), "utf8"), "packaged");
  assert.equal(fs.existsSync(path.join(webappsRoot(homePath), "demo-node-html", "stale.txt")), false);
});
