import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const JSZip = require("jszip");
const { APP_BRAND } = require("../dist-electron/shared/brand.js");

const {
  readWebsiteItems,
  writeWebsiteItems
} = require("../dist-electron/main/webs/websites/store.js");
const {
  readWebappItemFromDir,
  readWebappItems
} = require("../dist-electron/main/webs/webapps/store.js");
const {
  listWebappItems,
  removeWebappItem,
  updateWebappItem
} = require("../dist-electron/main/webs/webapps/actions.js");
const {
  readWebItems
} = require("../dist-electron/main/webs/store.js");
const {
  applyWebOrder,
  readWebOrderKeys,
  writeWebOrderKeys
} = require("../dist-electron/main/webs/order-store.js");
const {
  WebappRuntime,
  webappRuntime
} = require("../dist-electron/main/webs/webapps/runtime.js");
const {
  __actionTokenTestInternals,
  authorizeWebappActionToken,
  issueWebappActionToken,
  revokeWebappActionToken
} = require("../dist-electron/main/webs/webapps/action-tokens.js");
const {
  activateWebappInstall,
  commitWebappInstall,
  recoverWebappInstallTransactions,
  rollbackWebappInstall
} = require("../dist-electron/main/webs/webapps/install-transaction.js");
const {
  __launcherTestInternals,
  resetWebappRuntimeProbeCaches
} = require("../dist-electron/main/webs/webapps/launchers.js");
const {
  writeWebappRuntimeSettings
} = require("../dist-electron/main/webs/webapps/runtime-settings.js");
const {
  createDesktopMobileWebappCatalog
} = require("../dist-electron/main/webs/webapps/mobile-catalog.js");
const {
  __testInternals: webappPublisherInternals,
  getWebappPublishInfo
} = require("../dist-electron/main/webs/webapps/publisher.js");
const {
  registerWebIpcHandlers
} = require("../dist-electron/main/ipc/web-handlers.js");
const {
  __testInternals: webappTemplateInstallerInternals,
  installBundledWebappTemplates
} = require("../dist-electron/main/webs/webapps/template-installer.js");
const {
  readInstalledRecords,
  upsertInstalledRecord
} = require("../dist-electron/main/marketplace/common.js");
const {
  registerPlugin,
  __testInternals: registryInternals
} = require("../dist-electron/main/services/service-registry.js");
const {
  createResourceDirectoryWatcher
} = require("../dist-electron/main/resource-directory-watcher.js");
const {
  getDesktopPetsDataRoot,
  getPluginsRoot,
  getServiceStateRoot
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

function webappManifestPath(homePath, id) {
  return path.join(webappsRoot(homePath), id, "webapp.json");
}

function createIpcMain() {
  const handlers = new Map();
  return {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    invoke(channel, ...args) {
      const handler = handlers.get(channel);
      if (!handler) {
        throw new Error(`missing ipc handler: ${channel}`);
      }
      return handler({}, ...args);
    }
  };
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
  fs.writeFileSync(path.join(appDir, "frontend", "index.html"), "<!doctype html><div id=\"app\">demo</div>", "utf8");
  if (!options.frontendOnly) {
    fs.mkdirSync(path.join(appDir, "backend"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "backend", "server.mjs"), `
import { createHash } from "node:crypto";
import http from "node:http";
const host = process.env.HOST || "127.0.0.1";
const port = Number.parseInt(process.env.PORT || "0", 10);
const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!doctype html><div>backend proxy page</div>");
    return;
  }
  if (req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache"
    });
    res.write("data: first\\n\\n");
    setTimeout(() => res.end("data: second\\n\\n"), 10);
    return;
  }
  if (req.url === "/api/demo") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      webappId: process.env.WEBAPP_ID,
      root: process.env.WEBAPP_ROOT,
      stateDir: process.env.WEBAPP_STATE_DIR,
      logDir: process.env.WEBAPP_LOG_DIR,
      dataDir: process.env.WEBAPP_DATA_DIR,
      desktopActionBridgeUrl: process.env.DESKTOP_ACTION_BRIDGE_URL,
      desktopActionBridgeToken: process.env.DESKTOP_ACTION_BRIDGE_TOKEN || ""
    }));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false }));
});
server.on("upgrade", (req, socket) => {
  if (req.url !== "/api/socket" || !req.headers["sec-websocket-key"]) {
    socket.end("HTTP/1.1 404 Not Found\\r\\nConnection: close\\r\\n\\r\\n");
    return;
  }
  const accept = createHash("sha1")
    .update(String(req.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Accept: " + accept,
    "",
    ""
  ].join("\\r\\n"));
  const payload = Buffer.from("gateway-websocket", "utf8");
  socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
});
server.listen(port, host);
`, "utf8");
  }
  const schemaVersion = options.schemaVersion ?? 1;
  writeJson(path.join(appDir, "webapp.json"), {
    schemaVersion,
    id,
    kind: "webapp",
    ...(schemaVersion === 4 ? {
      version: options.version ?? "1.0.0",
      target: options.target ?? "universal"
    } : {}),
    label: options.label ?? "Local Demo",
    ...(options.openMode ? { openMode: options.openMode } : {}),
    agentKey: options.agentKey,
    frontend: {
      ...(schemaVersion === 4 ? { mode: "static" } : {}),
      root: options.frontendRoot ?? "frontend",
      index: options.frontendIndex ?? "index.html",
      spa: true,
      apiPrefix: "/api"
    },
    ...(!options.frontendOnly ? { backend: {
      ...(schemaVersion === 4
        ? { launcher: "node" }
        : { runtime: options.runtime ?? "node" }),
      entry: options.entry ?? "backend/server.mjs",
      args: [],
      env: {},
      port: 0,
      ...(schemaVersion === 4
        ? { health: { type: "http", path: "/api/health", timeoutMs: 10_000 } }
        : { healthPath: "/api/health" })
    } } : {}),
    createdAt: options.createdAt ?? "2026-01-02T00:00:00.000Z",
    updatedAt: options.updatedAt ?? "2026-01-02T00:00:00.000Z"
  });
  return appDir;
}

function writeV4BackendWebapp(root, id, launcher, options = {}) {
  const appDir = path.join(root, id);
  fs.mkdirSync(appDir, { recursive: true });
  let backend;
  if (launcher === "container") {
    backend = {
      launcher,
      management: "external",
      engine: options.engine ?? "auto",
      containerName: `${id}-container`,
      image: `${id}:1.0.0`,
      containerPort: 8080,
      health: { type: "http", path: "/health", timeoutMs: 10_000 }
    };
  } else {
    const extension = launcher === "java"
      ? ".jar"
      : launcher === "native" && process.platform === "win32"
        ? ".exe"
        : "";
    const entry = `backend/server${extension}`;
    fs.mkdirSync(path.join(appDir, "backend"), { recursive: true });
    fs.writeFileSync(path.join(appDir, entry), launcher === "java" ? "jar-placeholder" : "binary-placeholder", "utf8");
    backend = {
      launcher,
      entry,
      args: [],
      env: {},
      port: 0,
      health: { type: "tcp", timeoutMs: 10_000 },
      ...(launcher === "java" ? { jvmArgs: ["-Xmx256m"] } : {})
    };
  }
  writeJson(path.join(appDir, "webapp.json"), {
    schemaVersion: 4,
    id,
    kind: "webapp",
    version: "1.0.0",
    target: "universal",
    label: id,
    frontend: { mode: "proxy" },
    backend
  });
  return appDir;
}

function writeFakeJava(root, major) {
  const executable = path.join(root, `java-${major}`);
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, [
    "#!/bin/sh",
    `printf '    java.specification.version = ${major}\\n' >&2`,
    `printf '    java.version = ${major}.0.1\\n' >&2`,
    `printf '    java.home = /fake/java-${major}\\n' >&2`,
    ""
  ].join("\n"), "utf8");
  fs.chmodSync(executable, 0o755);
  return executable;
}

function writeFakeDocker(root) {
  const executable = path.join(root, "docker");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(executable, [
    "#!/bin/sh",
    "if [ \"$1\" = \"info\" ]; then exit 0; fi",
    "if [ \"$1\" = \"image\" ] && [ \"$2\" = \"inspect\" ]; then printf 'sha256:expected-image\\n'; exit 0; fi",
    "if [ \"$1\" = \"container\" ] && [ \"$2\" = \"inspect\" ]; then",
    "  host_ip=\"${FAKE_DOCKER_HOST_IP:-127.0.0.1}\"",
    "  printf '[{\"State\":{\"Running\":true},\"Image\":\"sha256:expected-image\",\"NetworkSettings\":{\"Ports\":{\"8080/tcp\":[{\"HostIp\":\"%s\",\"HostPort\":\"49123\"}]}}}]\\n' \"$host_ip\"",
    "  exit 0",
    "fi",
    "exit 1",
    ""
  ].join("\n"), "utf8");
  fs.chmodSync(executable, 0o755);
  return executable;
}

async function writeWebappArchive(root, options = {}) {
  const webappId = options.id ?? "local-webapp";
  const archivePath = path.join(root, `${webappId}.zip`);
  const zip = new JSZip();
  zip.file(
    `${webappId}/webapp.json`,
    `${JSON.stringify({
      schemaVersion: 1,
      id: webappId,
      kind: "webapp",
      label: options.label ?? "Local WebApp",
      frontend: {
        root: "frontend",
        index: "index.html",
        spa: true,
        apiPrefix: "/api"
      },
      backend: {
        runtime: "node",
        entry: "backend/server.mjs",
        args: [],
        env: {},
        port: 0,
        healthPath: "/api/health"
      },
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z"
    }, null, 2)}\n`
  );
  zip.file(`${webappId}/frontend/index.html`, "<!doctype html><div id=\"app\">local webapp</div>");
  zip.file(`${webappId}/backend/server.mjs`, "console.log('local webapp')\n");
  fs.writeFileSync(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
  return archivePath;
}

function registerPluginWebappOwner(app, pluginId, webappId, name = "Owner Plugin") {
  registerPlugin({
    pluginApiVersion: 1,
    id: pluginId,
    name,
    version: "v1",
    description: "webapp owner",
    lifecycle: {
      start: "start.sh",
      stop: "stop.sh"
    },
    runtime: {
      requiredPaths: ["manifest.json"]
    },
    resources: {
      webapps: [{
        id: webappId,
        source: "webapps/demo"
      }]
    }
  });
  writeJson(path.join(getServiceStateRoot(app, pluginId, "plugin"), "plugin-resources.json"), {
    webapps: {
      [webappId]: {
        updatedAt: "2026-01-02T00:00:00.000Z"
      }
    }
  });
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

function postUrl(target, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        statusCode: res.statusCode,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

function readWebSocketMessage(target) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("WebSocket message timed out"));
    }, 3_000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      const value = typeof event.data === "string" ? event.data : String(event.data);
      socket.close();
      resolve(value);
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket proxy failed"));
    }, { once: true });
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
  assert.equal(websiteManifest.schemaVersion, 2);
});

test("web stores prefer copilotAgentKey and keep agentKey as a read-only legacy alias", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webs-copilot-key-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);

  writeWebsite(websitesRoot(homePath), "legacy-site", { agentKey: "legacy-site-agent" });
  const canonicalWebsitePath = path.join(websitesRoot(homePath), "canonical-site", "website.json");
  writeJson(canonicalWebsitePath, {
    schemaVersion: 2,
    id: "canonical-site",
    kind: "website",
    label: "Canonical",
    url: "https://canonical.example.com/",
    copilotAgentKey: "canonical-site-agent",
    agentKey: "ignored-site-agent"
  });
  writeWebapp(webappsRoot(homePath), "legacy-app", { agentKey: "legacy-app-agent" });
  const canonicalWebappPath = webappManifestPath(homePath, "legacy-app");
  const canonicalWebapp = JSON.parse(fs.readFileSync(canonicalWebappPath, "utf8"));
  writeJson(canonicalWebappPath, {
    ...canonicalWebapp,
    copilotAgentKey: "canonical-app-agent",
    agentKey: "ignored-app-agent"
  });

  const websites = Object.fromEntries(readWebsiteItems(app).map((item) => [item.id, item]));
  const webapps = Object.fromEntries(readWebappItems(app).map((item) => [item.id, item]));
  assert.equal(websites["legacy-site"].copilotAgentKey, "legacy-site-agent");
  assert.equal(websites["canonical-site"].copilotAgentKey, "canonical-site-agent");
  assert.equal("agentKey" in websites["legacy-site"], false);
  assert.equal(webapps["legacy-app"].copilotAgentKey, "canonical-app-agent");
  assert.equal("agentKey" in webapps["legacy-app"], false);
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

test("schema v4 normalizes static, Node, native, Java, and external container packages", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapps-v4-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const packageRoot = webappsRoot(homePath);

  writeWebapp(packageRoot, "v4-static", {
    schemaVersion: 4,
    version: "2.1.0",
    openMode: "dialog",
    frontendOnly: true
  });
  const nodeDir = writeWebapp(packageRoot, "v4-node", { schemaVersion: 4 });
  const nodeManifest = JSON.parse(fs.readFileSync(path.join(nodeDir, "webapp.json"), "utf8"));
  writeJson(path.join(nodeDir, "webapp.json"), {
    ...nodeManifest,
    frontend: { mode: "proxy" }
  });
  writeV4BackendWebapp(packageRoot, "v4-native", "native");
  writeV4BackendWebapp(packageRoot, "v4-java", "java");
  writeV4BackendWebapp(packageRoot, "v4-container", "container");

  const items = Object.fromEntries(readWebappItems(app).map((item) => [item.id, item]));
  assert.equal(items["v4-static"].schemaVersion, 4);
  assert.equal(items["v4-static"].version, "2.1.0");
  assert.equal(items["v4-static"].target, "universal");
  assert.equal(items["v4-static"].openMode, "dialog");
  assert.equal(items["v4-static"].frontend.mode, "static");
  assert.equal(items["v4-static"].backend, undefined);
  assert.equal(items["v4-node"].openMode, "workspace");
  assert.equal(items["v4-node"].frontend.mode, "proxy");
  assert.equal(items["v4-node"].backend.launcher, "node");
  assert.equal(items["v4-native"].backend.launcher, "native");
  assert.equal(items["v4-java"].backend.launcher, "java");
  assert.deepEqual(items["v4-java"].backend.jvmArgs, ["-Xmx256m"]);
  assert.equal(items["v4-container"].backend.launcher, "container");
  assert.equal(items["v4-container"].backend.management, "external");

  const updated = updateWebappItem(app, "v4-java", { label: "Java Updated" });
  assert.equal(updated.ok, true);
  const updatedManifest = JSON.parse(fs.readFileSync(webappManifestPath(homePath, "v4-java"), "utf8"));
  assert.equal(updatedManifest.schemaVersion, 4);
  assert.equal(updatedManifest.backend.launcher, "java");
  assert.deepEqual(updatedManifest.backend.jvmArgs, ["-Xmx256m"]);
});

test("schema v4 rejects incompatible targets and invalid launcher combinations", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapps-v4-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "packages");

  const targetDir = writeWebapp(packageRoot, "bad-target", { schemaVersion: 4, frontendOnly: true });
  const targetManifest = JSON.parse(fs.readFileSync(path.join(targetDir, "webapp.json"), "utf8"));
  writeJson(path.join(targetDir, "webapp.json"), {
    ...targetManifest,
    target: process.platform === "darwin" ? "windows-x64" : "darwin-x64"
  });
  assert.throws(
    () => readWebappItemFromDir(targetDir),
    /not compatible/u
  );

  const containerDir = writeV4BackendWebapp(packageRoot, "bad-container", "container");
  const containerManifest = JSON.parse(fs.readFileSync(path.join(containerDir, "webapp.json"), "utf8"));
  writeJson(path.join(containerDir, "webapp.json"), {
    ...containerManifest,
    backend: {
      ...containerManifest.backend,
      env: { SHOULD_NOT_EXIST: "1" }
    }
  });
  assert.throws(
    () => readWebappItemFromDir(containerDir),
    /not allowed for an external container/u
  );

  const proxyDir = writeWebapp(packageRoot, "bad-proxy", { schemaVersion: 4, frontendOnly: true });
  const proxyManifest = JSON.parse(fs.readFileSync(path.join(proxyDir, "webapp.json"), "utf8"));
  writeJson(path.join(proxyDir, "webapp.json"), {
    ...proxyManifest,
    frontend: { mode: "proxy" }
  });
  assert.throws(
    () => readWebappItemFromDir(proxyDir),
    /requires a backend/u
  );

  const javaDir = writeV4BackendWebapp(packageRoot, "bad-java-args", "java");
  const javaManifest = JSON.parse(fs.readFileSync(path.join(javaDir, "webapp.json"), "utf8"));
  writeJson(path.join(javaDir, "webapp.json"), {
    ...javaManifest,
    backend: {
      ...javaManifest.backend,
      jvmArgs: ["-jar", "backend/other.jar"]
    }
  });
  assert.throws(
    () => readWebappItemFromDir(javaDir),
    /JVM options only/u
  );
});

test("webapp items include source management metadata", (t) => {
  registryInternals.clearServices();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapps-metadata-"));
  t.after(() => {
    registryInternals.clearServices();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const homePath = path.join(root, "home");
  const app = createApp(homePath);

  const localDir = writeWebapp(webappsRoot(homePath), "local-demo", { label: "Local Demo" });
  const marketDir = writeWebapp(webappsRoot(homePath), "market-demo", { label: "Market Demo" });
  const pluginDir = writeWebapp(webappsRoot(homePath), "plugin-demo", { label: "Plugin Demo" });
  const bundledDir = writeWebapp(webappsRoot(homePath), "demo-node-html", { label: "Bundled Demo" });

  upsertInstalledRecord(app, {
    id: "market-demo",
    type: "website-app",
    version: "1.0.0",
    source: "cloud",
    installPath: marketDir,
    installedAt: "2026-01-02T00:00:00.000Z"
  });
  registerPluginWebappOwner(app, "owner-plugin", "plugin-demo", "Owner Plugin");

  const items = listWebappItems(app).items;
  const byId = Object.fromEntries(items.map((item) => [item.id, item]));

  assert.equal(byId["local-demo"].sourceKind, "local");
  assert.equal(byId["local-demo"].sourceLabel, "Local");
  assert.equal(byId["local-demo"].installPath, localDir);
  assert.equal(byId["local-demo"].removable, true);

  assert.equal(byId["market-demo"].sourceKind, "market");
  assert.equal(byId["market-demo"].sourceLabel, "Market");
  assert.equal(byId["market-demo"].installPath, marketDir);
  assert.equal(byId["market-demo"].removable, true);

  assert.equal(byId["plugin-demo"].sourceKind, "plugin");
  assert.equal(byId["plugin-demo"].sourceLabel, "Owner Plugin");
  assert.equal(byId["plugin-demo"].sourceOwnerId, "owner-plugin");
  assert.equal(byId["plugin-demo"].installPath, pluginDir);
  assert.equal(byId["plugin-demo"].removable, false);

  assert.equal(byId["demo-node-html"].sourceKind, "bundled");
  assert.equal(byId["demo-node-html"].sourceLabel, "Bundled demo");
  assert.equal(byId["demo-node-html"].installPath, bundledDir);
  assert.equal(byId["demo-node-html"].removable, false);
});

test("webapps update writes canonical Copilot preferences and preserves manifest runtime fields", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapps-update-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);

  writeWebapp(webappsRoot(homePath), "prefs-demo", { label: "Before", agentKey: "old-agent" });
  const before = JSON.parse(fs.readFileSync(webappManifestPath(homePath, "prefs-demo"), "utf8"));

  const result = updateWebappItem(app, "prefs-demo", {
    label: "After",
    copilotAgentKey: "desktopAssistant",
    openMode: "dialog"
  });
  assert.equal(result.ok, true);
  assert.equal(result.item.label, "After");
  assert.equal(result.item.copilotAgentKey, "desktopAssistant");
  assert.equal(result.item.openMode, "dialog");
  assert.equal("agentKey" in result.item, false);

  const after = JSON.parse(fs.readFileSync(webappManifestPath(homePath, "prefs-demo"), "utf8"));
  assert.equal(after.label, "After");
  assert.equal(after.schemaVersion, 3);
  assert.equal(after.copilotAgentKey, "desktopAssistant");
  assert.equal(after.openMode, "dialog");
  assert.equal(Object.hasOwn(after, "agentKey"), false);
  assert.notEqual(after.updatedAt, before.updatedAt);
  assert.deepEqual(after.frontend, before.frontend);
  assert.deepEqual(after.backend, before.backend);

  const cleared = updateWebappItem(app, "prefs-demo", { copilotAgentKey: "" });
  assert.equal(cleared.ok, true);
  const clearedManifest = JSON.parse(fs.readFileSync(webappManifestPath(homePath, "prefs-demo"), "utf8"));
  assert.equal(Object.hasOwn(clearedManifest, "agentKey"), false);
  assert.equal(Object.hasOwn(clearedManifest, "copilotAgentKey"), false);
  assert.deepEqual(clearedManifest.frontend, before.frontend);
  assert.deepEqual(clearedManifest.backend, before.backend);
});

test("webapps remove deletes removable installs and rejects managed sources", async (t) => {
  registryInternals.clearServices();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapps-remove-"));
  t.after(async () => {
    registryInternals.clearServices();
    await webappRuntime.stopAll(createApp(path.join(root, "home")));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const homePath = path.join(root, "home");
  const app = createApp(homePath);

  const localDir = writeWebapp(webappsRoot(homePath), "local-remove", { label: "Local Remove" });
  const localDataDir = path.join(desktopRoot(homePath), "data", "webs", "webapp-data", "local-remove");
  const localStateDir = path.join(desktopRoot(homePath), "state", "webs", "webapps", "local-remove");
  const localLogDir = path.join(desktopRoot(homePath), "logs", "webs", "webapps", "local-remove");
  for (const directory of [localDataDir, localStateDir, localLogDir]) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "marker.txt"), "remove-me", "utf8");
  }
  const marketDir = writeWebapp(webappsRoot(homePath), "market-remove", { label: "Market Remove" });
  const pluginDir = writeWebapp(webappsRoot(homePath), "plugin-managed", { label: "Plugin Managed" });
  const bundledDir = writeWebapp(webappsRoot(homePath), "demo-node-html", { label: "Bundled Demo" });
  upsertInstalledRecord(app, {
    id: "market-remove",
    type: "website-app",
    version: "1.0.0",
    source: "cloud",
    installPath: marketDir,
    installedAt: "2026-01-02T00:00:00.000Z"
  });
  registerPluginWebappOwner(app, "managed-plugin", "plugin-managed", "Managed Plugin");

  const localResult = await removeWebappItem(app, "local-remove");
  assert.equal(localResult.ok, true);
  assert.equal(fs.existsSync(localDir), false);
  assert.equal(fs.existsSync(localDataDir), false);
  assert.equal(fs.existsSync(localStateDir), false);
  assert.equal(fs.existsSync(localLogDir), false);

  const marketResult = await removeWebappItem(app, "market-remove");
  assert.equal(marketResult.ok, true);
  assert.equal(fs.existsSync(marketDir), false);
  assert.equal(readInstalledRecords(app).some((record) => record.id === "market-remove" && record.type === "website-app"), false);

  const pluginResult = await removeWebappItem(app, "plugin-managed");
  assert.equal(pluginResult.ok, false);
  assert.equal(fs.existsSync(pluginDir), true);

  const bundledResult = await removeWebappItem(app, "demo-node-html");
  assert.equal(bundledResult.ok, false);
  assert.equal(fs.existsSync(bundledDir), true);
});

test("removing a published WebApp disables its Tunnel route before deleting files", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-remove-published-"));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const installDir = writeWebapp(webappsRoot(homePath), "published-remove", { frontendOnly: true });
  writeJson(path.join(desktopRoot(homePath), "config", "desktop", "tunnel-hub.json"), {
    enabled: true,
    relayUrl: "wss://relay.example.test/tunnel",
    deviceId: "mac-mini-office",
    reconnectSeconds: 3
  });
  writeJson(path.join(desktopRoot(homePath), "secrets", "sso-site-token.json"), {
    accessToken: "publisher-site-secret"
  });
  writeJson(path.join(desktopRoot(homePath), "state", "webs", "webapps", "published-remove", "publish.json"), {
    id: "published-remove",
    provider: "tunnel",
    status: "published",
    name: "published-remove",
    routeId: "route-published-remove",
    publicHost: "published-remove.m.example.test",
    url: "https://published-remove.m.example.test/",
    targetUrl: "http://127.0.0.1:43123/",
    active: true,
    message: "published",
    updatedAt: "2026-07-17T00:00:00.000Z"
  });
  const requests = [];
  let shouldFail = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    if (shouldFail) {
      return new Response("route unavailable", { status: 503 });
    }
    return new Response(JSON.stringify({
      name: "published-remove",
      publicHost: "published-remove.m.example.test",
      publicUrl: "https://published-remove.m.example.test/",
      targetUrl: "http://127.0.0.1:43123/",
      routeId: "route-published-remove",
      active: false
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const blocked = await removeWebappItem(app, "published-remove");
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /Stop Tunnel publishing/u);
  assert.equal(fs.existsSync(installDir), true);

  shouldFail = false;
  const removed = await removeWebappItem(app, "published-remove");
  assert.equal(removed.ok, true);
  assert.equal(fs.existsSync(installDir), false);
  assert.equal(requests.at(-1).body.active, false);
});

test("webapp ipc import installs local archive and returns refreshed web entries", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-ipc-import-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const archivePath = await writeWebappArchive(root, {
    id: "reg-report-excelx-webapp",
    label: "监管报表与 Excel 工具"
  });
  writeWebsite(websitesRoot(homePath), "docs");
  const changes = [];

  const ipcMain = createIpcMain();
  registerWebIpcHandlers(ipcMain, {
    app,
    showFileDialog: async (options) => {
      assert.equal(options.properties.includes("openFile"), true);
      assert.equal(options.filters.some((filter) => filter.extensions.includes("zip")), true);
      return { canceled: false, filePaths: [archivePath] };
    },
    showSaveDialog: async () => assert.fail("save dialog should not be opened"),
    getDataRoot: () => desktopRoot(homePath),
    emitWebappChanged: (reason, webappId) => changes.push({ reason, webappId })
  });

  const result = await ipcMain.invoke("webs.webapps.import");

  assert.equal(result.ok, true);
  assert.equal(result.item?.id, "reg-report-excelx-webapp");
  assert.deepEqual(changes, [{ reason: "installed", webappId: "reg-report-excelx-webapp" }]);
  assert.equal(result.item?.entryKey, "webapp:reg-report-excelx-webapp");
  assert.equal(result.path, archivePath);
  assert.equal(fs.existsSync(webappManifestPath(homePath, "reg-report-excelx-webapp")), true);
  assert.deepEqual(result.items.map((item) => item.entryKey), [
    "website:docs",
    "webapp:reg-report-excelx-webapp"
  ]);
});

test("webapp IPC delegates floating-window opens to the main-process window manager", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-window-ipc-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeWebapp(webappsRoot(homePath), "floating-notes", {
    schemaVersion: 4,
    frontendOnly: true,
    openMode: "dialog"
  });
  const calls = [];
  const ipcMain = createIpcMain();
  registerWebIpcHandlers(ipcMain, {
    app,
    showFileDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true, filePath: "" }),
    getDataRoot: () => desktopRoot(homePath),
    openWebappWindow: async (targetApp, id, sender) => {
      calls.push({ targetApp, id, sender });
      const item = readWebappItems(targetApp).find((candidate) => candidate.id === id) ?? null;
      return {
        ok: true,
        item,
        state: null,
        message: "opened"
      };
    }
  });

  const result = await ipcMain.invoke("webs.webapps.openWindow", "floating-notes");

  assert.equal(result.ok, true);
  assert.equal(result.item?.id, "floating-notes");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].targetApp, app);
  assert.equal(calls[0].id, "floating-notes");
  assert.equal(calls[0].sender, undefined);
});

test("webapp IPC exposes prerequisite checks and persistent runtime settings", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-runtime-settings-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeWebapp(webappsRoot(homePath), "static-settings", {
    schemaVersion: 4,
    frontendOnly: true
  });
  const ipcMain = createIpcMain();
  registerWebIpcHandlers(ipcMain, {
    app,
    showFileDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true, filePath: "" }),
    getDataRoot: () => desktopRoot(homePath)
  });

  const initial = await ipcMain.invoke("webs.webapps.getRuntimeSettings");
  assert.equal(initial.ok, true);
  assert.deepEqual(initial.settings, {
    schemaVersion: 1,
    javaExecutable: "",
    containerEngine: "auto"
  });

  const javaExecutable = path.join(root, "runtime", "bin", process.platform === "win32" ? "java.exe" : "java");
  const saved = await ipcMain.invoke("webs.webapps.saveRuntimeSettings", {
    javaExecutable: ` ${javaExecutable} `,
    containerEngine: "podman"
  });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.settings, {
    schemaVersion: 1,
    javaExecutable,
    containerEngine: "podman"
  });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(desktopRoot(homePath), "config", "webs", "runtime.json"), "utf8")),
    saved.settings
  );

  const prerequisites = await ipcMain.invoke("webs.webapps.checkPrerequisites", "static-settings");
  assert.equal(prerequisites.ok, true);
  assert.equal(prerequisites.launcher, "none");
  assert.equal(prerequisites.ownership, null);
});

test("Java prerequisites block Java 17 and accept Java 21 from the configured executable", {
  skip: process.platform === "win32"
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-java-prerequisites-"));
  t.after(() => {
    resetWebappRuntimeProbeCaches();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeV4BackendWebapp(webappsRoot(homePath), "java-runtime", "java");

  const java17 = writeFakeJava(path.join(root, "fake-java"), 17);
  writeWebappRuntimeSettings(app, {
    javaExecutable: java17,
    containerEngine: "auto"
  });
  resetWebappRuntimeProbeCaches();
  const blocked = webappRuntime.checkPrerequisites(app, "java-runtime");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.launcher, "java");
  assert.equal(blocked.runtimeVersion, "17.0.1");
  assert.equal(blocked.externalId, java17);
  assert.equal(blocked.issues[0]?.code, "java_version_unsupported");

  const java21 = writeFakeJava(path.join(root, "fake-java"), 21);
  writeWebappRuntimeSettings(app, {
    javaExecutable: java21,
    containerEngine: "auto"
  });
  resetWebappRuntimeProbeCaches();
  const ready = webappRuntime.checkPrerequisites(app, "java-runtime");
  assert.equal(ready.ok, true);
  assert.equal(ready.runtimeVersion, "21.0.1");
  assert.equal(ready.externalId, java21);
});

test("external container prerequisites attach to a pre-running loopback container and reject public bindings", {
  skip: process.platform === "win32"
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-container-prerequisites-"));
  const previousEnginePaths = process.env.DESKTOP_CONTAINER_ENGINE_PATHS;
  const previousHostIp = process.env.FAKE_DOCKER_HOST_IP;
  t.after(() => {
    if (previousEnginePaths === undefined) {
      delete process.env.DESKTOP_CONTAINER_ENGINE_PATHS;
    } else {
      process.env.DESKTOP_CONTAINER_ENGINE_PATHS = previousEnginePaths;
    }
    if (previousHostIp === undefined) {
      delete process.env.FAKE_DOCKER_HOST_IP;
    } else {
      process.env.FAKE_DOCKER_HOST_IP = previousHostIp;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeV4BackendWebapp(webappsRoot(homePath), "container-runtime", "container", { engine: "docker" });
  const item = readWebappItems(app).find((candidate) => candidate.id === "container-runtime");
  assert.equal(item?.backend?.launcher, "container");
  const fakeBin = path.join(root, "fake-bin");
  writeFakeDocker(fakeBin);
  process.env.DESKTOP_CONTAINER_ENGINE_PATHS = fakeBin;
  process.env.FAKE_DOCKER_HOST_IP = "127.0.0.1";

  const ready = __launcherTestInternals.inspectExternalContainer(app, item.backend);
  assert.equal(ready.ok, true);
  assert.equal(ready.ownership, "external");
  assert.equal(ready.backendUrl, "http://127.0.0.1:49123");
  assert.equal(ready.externalId, "container-runtime-container");

  process.env.FAKE_DOCKER_HOST_IP = "::1";
  const ipv6Ready = __launcherTestInternals.inspectExternalContainer(app, item.backend);
  assert.equal(ipv6Ready.ok, true);
  assert.equal(ipv6Ready.backendUrl, "http://[::1]:49123");

  process.env.FAKE_DOCKER_HOST_IP = "0.0.0.0";
  const exposed = __launcherTestInternals.inspectExternalContainer(app, item.backend);
  assert.equal(exposed.ok, false);
  assert.equal(exposed.issues[0]?.code, "container_port_exposed");
});

test("WebApp install transactions rollback, commit, and recover without version directories", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-transaction-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const installPath = path.join(webappsRoot(homePath), "transaction-demo");
  const stagingRoot = path.join(desktopRoot(homePath), "data", "webs", ".staging");
  fs.mkdirSync(installPath, { recursive: true });
  fs.writeFileSync(path.join(installPath, "marker.txt"), "old", "utf8");

  const rollbackStaging = path.join(stagingRoot, "transaction-demo-rollback");
  fs.mkdirSync(rollbackStaging, { recursive: true });
  fs.writeFileSync(path.join(rollbackStaging, "marker.txt"), "new-rollback", "utf8");
  const rollbackTransaction = activateWebappInstall({
    app,
    id: "transaction-demo",
    installPath,
    stagingPath: rollbackStaging
  });
  assert.equal(fs.readFileSync(path.join(installPath, "marker.txt"), "utf8"), "new-rollback");
  assert.equal(fs.existsSync(rollbackTransaction.backupPath), true);
  rollbackWebappInstall(app, rollbackTransaction);
  assert.equal(fs.readFileSync(path.join(installPath, "marker.txt"), "utf8"), "old");
  assert.equal(fs.existsSync(rollbackTransaction.backupPath), false);

  const commitStaging = path.join(stagingRoot, "transaction-demo-commit");
  fs.mkdirSync(commitStaging, { recursive: true });
  fs.writeFileSync(path.join(commitStaging, "marker.txt"), "new-commit", "utf8");
  const commitTransaction = activateWebappInstall({
    app,
    id: "transaction-demo",
    installPath,
    stagingPath: commitStaging
  });
  commitWebappInstall(app, commitTransaction);
  assert.equal(fs.readFileSync(path.join(installPath, "marker.txt"), "utf8"), "new-commit");
  assert.equal(fs.existsSync(commitTransaction.backupPath), false);

  const recoveryStaging = path.join(stagingRoot, "transaction-demo-recovery");
  fs.mkdirSync(recoveryStaging, { recursive: true });
  fs.writeFileSync(path.join(recoveryStaging, "marker.txt"), "interrupted-new", "utf8");
  const recoveryTransaction = activateWebappInstall({
    app,
    id: "transaction-demo",
    installPath,
    stagingPath: recoveryStaging
  });
  fs.rmSync(installPath, { recursive: true, force: true });
  assert.deepEqual(recoverWebappInstallTransactions(app), ["transaction-demo"]);
  assert.equal(fs.readFileSync(path.join(installPath, "marker.txt"), "utf8"), "new-commit");
  assert.equal(fs.existsSync(recoveryTransaction.backupPath), false);
  assert.equal(fs.existsSync(path.join(installPath, "versions")), false);
});

test("webapp publisher reports Tunnel readiness without exposing the SSO site token", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-publisher-info-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeWebapp(webappsRoot(homePath), "publish-demo");
  writeJson(path.join(desktopRoot(homePath), "config", "desktop", "tunnel-hub.json"), {
    enabled: true,
    relayUrl: "wss://relay.example.test/tunnel",
    deviceId: "mac-mini-office",
    reconnectSeconds: 3
  });
  writeJson(path.join(desktopRoot(homePath), "secrets", "sso-site-token.json"), {
    accessToken: "publisher-site-secret"
  });

  const result = await getWebappPublishInfo(app, "publish-demo");

  assert.equal(result.ok, true);
  assert.equal(result.info.provider, "tunnel");
  assert.equal(result.info.configured, true);
  assert.equal(result.info.signedIn, true);
  assert.equal(result.info.tunnelEnabled, true);
  assert.equal(result.info.tunnelConnected, false);
  assert.equal(result.info.deviceId, "mac-mini-office");
  assert.doesNotMatch(JSON.stringify(result), /publisher-site-secret/u);
});

test("one-click WebApp publishing enables a configured Tunnel Hub", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-publisher-enable-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeJson(path.join(desktopRoot(homePath), "config", "desktop", "tunnel-hub.json"), {
    enabled: false,
    relayUrl: "wss://relay.example.test/tunnel",
    deviceId: "mac-mini-office",
    reconnectSeconds: 3
  });
  writeJson(path.join(desktopRoot(homePath), "secrets", "sso-site-token.json"), {
    accessToken: "publisher-site-secret"
  });

  const settings = webappPublisherInternals.enableTunnelForPublish(app);

  assert.equal(settings.enabled, true);
  assert.equal(settings.relayUrl, "wss://relay.example.test/tunnel");
  const stored = JSON.parse(fs.readFileSync(
    path.join(desktopRoot(homePath), "config", "desktop", "tunnel-hub.json"),
    "utf8"
  ));
  assert.equal(stored.enabled, true);
});

test("one-click WebApp publishing enables the brand Tunnel without manual relay settings", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-publisher-default-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeJson(path.join(desktopRoot(homePath), "secrets", "sso-site-token.json"), {
    accessToken: "publisher-site-secret"
  });

  const settings = webappPublisherInternals.enableTunnelForPublish(app);

  assert.equal(settings.enabled, true);
  assert.equal(settings.relayUrl, APP_BRAND.endpoints.tunnelHubRelayUrl);
});

test("one-click WebApp publishing falls back from an unavailable legacy local relay", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-publisher-fallback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const settingsPath = path.join(desktopRoot(homePath), "config", "desktop", "tunnel-hub.json");
  writeJson(settingsPath, {
    enabled: true,
    relayUrl: "ws://127.0.0.1:11961/tunnel",
    deviceId: "mac-mini-office",
    publicHost: "legacy-device.m.10.0.0.5.nip.io",
    reconnectSeconds: 3
  });
  writeJson(path.join(desktopRoot(homePath), "secrets", "sso-site-token.json"), {
    accessToken: "publisher-site-secret"
  });

  await assert.rejects(
    webappPublisherInternals.ensureTunnelConnectedForPublish(app),
    /Tunnel Hub runtime is not configured/u
  );

  const stored = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(stored.relayUrl, APP_BRAND.endpoints.tunnelHubRelayUrl);
  assert.equal(stored.publicHost, "");
  assert.equal(stored.rotateRelayToken, true);
});

test("webapp publisher registers a stable loopback route with Tunnel Hub", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-publisher-route-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeWebapp(webappsRoot(homePath), "publish-demo");
  writeJson(path.join(desktopRoot(homePath), "config", "desktop", "tunnel-hub.json"), {
    enabled: true,
    relayUrl: "wss://relay.example.test/tunnel",
    deviceId: "mac-mini-office",
    publicHost: "device-code.m.zenmind.cc",
    reconnectSeconds: 3
  });
  writeJson(path.join(desktopRoot(homePath), "secrets", "sso-site-token.json"), {
    accessToken: "publisher-site-secret"
  });
  const item = readWebappItems(app)[0];
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({
      name: "publish-demo",
      publicHost: "publish-demo.mac-mini-office.example.test",
      publicUrl: "https://publish-demo.mac-mini-office.example.test",
      targetUrl: "http://127.0.0.1:43123/",
      routeId: "route-publish-demo",
      active: true
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const route = await webappPublisherInternals.registerTunnelRoute(app, item, "http://127.0.0.1:43123/#ignored", true);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://relay.example.test/api/desktop/devices/mac-mini-office/webapps/publish-demo");
  assert.equal(requests[0].init.method, "PUT");
  assert.equal(requests[0].init.headers.Authorization, "Bearer publisher-site-secret");
  assert.deepEqual(JSON.parse(requests[0].init.body), { targetUrl: "http://127.0.0.1:43123/", active: true });
  assert.equal(route.routeId, "route-publish-demo");
  assert.equal(route.url, "https://publish-demo.mac-mini-office.example.test");
  assert.equal(route.mobileUrl, "https://device-code-43123.m.zenmind.cc/");
});

test("webapp publisher limits route names and rejects non-loopback targets", () => {
  const name = webappPublisherInternals.stableWebappName(`webapp-${"x".repeat(100)}`);
  assert.equal(name.length <= 63, true);
  assert.match(name, /-[a-f0-9]{8}$/u);
  assert.equal(webappPublisherInternals.requireLoopbackTarget("http://localhost:3000/demo#ignored"), "http://localhost:3000/demo");
  assert.throws(() => webappPublisherInternals.requireLoopbackTarget("https://127.0.0.1:3000/"), /loopback HTTP/u);
  assert.throws(() => webappPublisherInternals.requireLoopbackTarget("http://example.test/"), /loopback HTTP/u);
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

test("mobile WebApp catalog uses the device m host and ignores the manual wa share route", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-mobile-webapp-catalog-"));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  t.after(async () => {
    await webappRuntime.stopAll(app);
    fs.rmSync(root, { recursive: true, force: true });
  });

  writeWebapp(webappsRoot(homePath), "first", { label: "First", frontendOnly: true });
  writeWebapp(webappsRoot(homePath), "second", { label: "Second", frontendOnly: true });
  writeWebOrderKeys(app, ["webapp:second", "webapp:first"]);
  writeJson(path.join(desktopRoot(homePath), "config", "desktop", "tunnel-hub.json"), {
    enabled: false,
    relayUrl: "wss://tunnel.example.test/tunnel",
    deviceId: "desktop-device",
    publicHost: "desktop-device.m.example.test",
    reconnectSeconds: 3
  });
  const running = await webappRuntime.start(app, "second");
  assert.equal(running.ok, true);
  writeJson(path.join(desktopRoot(homePath), "state", "webs", "webapps", "second", "publish.json"), {
    id: "second",
    provider: "tunnel",
    status: "published",
    name: "second",
    routeId: "route-second-secret",
    publicHost: "second.wa.example.test",
    url: "https://second.wa.example.test/",
    targetUrl: running.state.webUrl,
    active: true,
    message: "published",
    updatedAt: "2026-07-17T00:00:00.000Z"
  });

  const catalog = createDesktopMobileWebappCatalog(app);
  assert.deepEqual(catalog.items.map((item) => item.id), ["second", "first"]);
  assert.deepEqual(catalog.items.map((item) => item.order), [0, 1]);
  assert.equal(catalog.items[0].runtimeStatus, "running");
  assert.equal(catalog.items[0].publishStatus, "published");
  assert.equal(
    catalog.items[0].publicUrl,
    `https://desktop-device-${running.state.frontendPort}.m.example.test/`
  );
  assert.doesNotMatch(catalog.items[0].publicUrl, /\.wa\./u);
  assert.equal(catalog.items[0].availability, "desktop-offline");
  assert.equal(catalog.items[1].availability, "webapp-stopped");
  assert.equal(typeof catalog.desktopDeviceId, "string");
  const serialized = JSON.stringify(catalog);
  assert.doesNotMatch(serialized, /route-second-secret/u);
  assert.doesNotMatch(serialized, /targetUrl|frontendPort|backendPort|installPath/u);
});

test("shutdown stops a persisted Desktop-owned WebApp PID after its program record is gone", { timeout: 10_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-orphan-state-"));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const webappId = "orphan-runtime";
  const installPath = path.join(webappsRoot(homePath), webappId);
  fs.mkdirSync(installPath, { recursive: true });

  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => undefined, 1000)", installPath],
    {
      detached: true,
      stdio: "ignore"
    }
  );
  assert.equal(typeof child.pid, "number");
  const childPid = child.pid;
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const childExit = new Promise((resolve) => {
    child.once("exit", resolve);
  });
  t.after(() => {
    try {
      if (process.platform === "win32") {
        process.kill(childPid, "SIGKILL");
      } else {
        process.kill(-childPid, "SIGKILL");
      }
    } catch {
      // The shutdown cleanup already reaped the detached child.
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  writeJson(
    path.join(
      desktopRoot(homePath),
      "state",
      "webs",
      "webapps",
      webappId,
      "runtime.json"
    ),
    {
      id: webappId,
      entryKey: `webapp:${webappId}`,
      kind: "webapp",
      status: "running",
      version: "1.0.0",
      target: "universal",
      launcher: "node",
      ownership: "desktop",
      runtimeVersion: process.version,
      externalId: "",
      prerequisiteIssues: [],
      webUrl: "",
      backendUrl: "",
      frontendPort: null,
      backendPort: null,
      pid: childPid,
      message: "running",
      updatedAt: new Date().toISOString()
    }
  );
  fs.rmSync(installPath, { recursive: true, force: true });

  const orphanRuntime = new WebappRuntime();
  const results = await orphanRuntime.stopAll(app);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].state?.id, webappId);
  assert.equal(results[0].state?.status, "stopped");
  assert.equal(results[0].state?.pid, null);
  await childExit;
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
  assert.equal(body.desktopActionBridgeUrl, "http://127.0.0.1:11788");

  const events = await readUrl(new URL("/api/events", result.state.webUrl).toString());
  assert.equal(events.statusCode, 200);
  assert.match(events.contentType, /^text\/event-stream/u);
  assert.equal(events.body, "data: first\n\ndata: second\n\n");

  const socketUrl = new URL("/api/socket", result.state.webUrl);
  socketUrl.protocol = "ws:";
  assert.equal(await readWebSocketMessage(socketUrl.toString()), "gateway-websocket");

  const logResult = webappRuntime.readLog(app, "runtime-demo", "main");
  assert.equal(logResult.ok, true);
  assert.equal(logResult.exists, true);

  const stopResult = await webappRuntime.stop(app, "runtime-demo");
  assert.equal(stopResult.ok, true);
  assert.equal(stopResult.state?.status, "stopped");
});

test("schema v4 Node runtime uses scoped startup credentials and revokes them on stop", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-v4-runtime-"));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  __actionTokenTestInternals.clear();
  t.after(async () => {
    await webappRuntime.stopAll(app);
    __actionTokenTestInternals.clear();
    fs.rmSync(root, { recursive: true, force: true });
  });
  writeWebapp(webappsRoot(homePath), "runtime-v4", {
    schemaVersion: 4,
    version: "4.2.0"
  });

  const result = await webappRuntime.start(app, "runtime-v4");
  assert.equal(result.ok, true);
  assert.equal(result.state?.version, "4.2.0");
  assert.equal(result.state?.target, "universal");
  assert.equal(result.state?.launcher, "node");
  assert.equal(result.state?.ownership, "desktop");
  assert.equal(result.state?.runtimeVersion.length > 0, true);
  assert.equal(__actionTokenTestInternals.size(), 1);

  const api = await readUrl(new URL("/api/demo", result.state.webUrl).toString());
  const body = JSON.parse(api.body);
  assert.equal(body.desktopActionBridgeUrl, "http://127.0.0.1:11788/webapps");
  assert.equal(typeof body.desktopActionBridgeToken, "string");
  assert.equal(body.desktopActionBridgeToken.length >= 32, true);
  assert.match(body.dataDir, /data[\\/]webs[\\/]webapp-data[\\/]runtime-v4/u);

  const runtimeFile = fs.readFileSync(
    path.join(desktopRoot(homePath), "state", "webs", "webapps", "runtime-v4", "runtime.json"),
    "utf8"
  );
  assert.doesNotMatch(runtimeFile, new RegExp(body.desktopActionBridgeToken, "u"));

  const stopped = await webappRuntime.stop(app, "runtime-v4");
  assert.equal(stopped.ok, true);
  assert.equal(__actionTokenTestInternals.size(), 0);
});

test("schema v4 proxy frontend routes the whole site through the gateway and preserves reserved paths", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-v4-proxy-"));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  t.after(async () => {
    await webappRuntime.stopAll(app);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const appDir = writeWebapp(webappsRoot(homePath), "proxy-v4", { schemaVersion: 4 });
  const manifestPath = path.join(appDir, "webapp.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  writeJson(manifestPath, {
    ...manifest,
    frontend: { mode: "proxy" }
  });

  const started = await webappRuntime.start(app, "proxy-v4");
  assert.equal(started.ok, true);
  const page = await readUrl(started.state.webUrl);
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /backend proxy page/u);
  const reserved = await readUrl(new URL("/__desktop/not-a-route", started.state.webUrl).toString());
  assert.equal(reserved.statusCode, 404);
});

test("WebApp action tokens are scoped to the issuing app and assistant allowlist", () => {
  __actionTokenTestInternals.clear();
  const token = issueWebappActionToken("scoped-app");
  assert.deepEqual(
    authorizeWebappActionToken(token, "desktop.assistant.complete"),
    { ok: true, webappId: "scoped-app" }
  );
  assert.deepEqual(
    authorizeWebappActionToken(token, "desktop.web.webapp.remove"),
    { ok: false, webappId: "" }
  );
  revokeWebappActionToken(token);
  assert.deepEqual(
    authorizeWebappActionToken(token, "desktop.assistant.complete"),
    { ok: false, webappId: "" }
  );
});

test("webapp runtime starts a frontend-only package without a backend process", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-frontend-only-"));
  t.after(async () => {
    await webappRuntime.stopAll(createApp(path.join(root, "home")));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeWebapp(webappsRoot(homePath), "frontend-only", { frontendOnly: true });

  const [item] = readWebappItems(app);
  assert.equal(item.backend, undefined);
  const result = await webappRuntime.start(app, "frontend-only");
  assert.equal(result.ok, true);
  assert.equal(result.state?.status, "running");
  assert.equal(result.state?.backendUrl, "");
  assert.equal(result.state?.backendPort, null);
  assert.equal(result.state?.pid, null);
  const page = await readUrl(result.state.webUrl);
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /demo/u);
  const publicOriginAttempt = await postUrl(
    new URL("/__desktop/actions/call", result.state.webUrl).toString(),
    JSON.stringify({ action: "desktop.assistant.complete", args: { prompt: "hello" } }),
    { Origin: "https://public.example.test" }
  );
  assert.equal(publicOriginAttempt.statusCode, 403);
  assert.match(publicOriginAttempt.body, /local WebApp origin/u);
  const missingOriginAttempt = await postUrl(
    new URL("/__desktop/actions/call", result.state.webUrl).toString(),
    JSON.stringify({ action: "desktop.assistant.complete", args: { prompt: "hello" } })
  );
  assert.equal(missingOriginAttempt.statusCode, 403);
  assert.match(missingOriginAttempt.body, /require the local WebApp origin/u);
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
