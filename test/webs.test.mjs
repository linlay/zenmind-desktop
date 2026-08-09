import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const JSZip = require("jszip");
const { APP_BRAND } = require("../dist-electron/shared/brand.js");
const {
  parseWebappManifest,
  WEBAPP_APP_CONFIG_MAX_BYTES,
  WEBAPP_MANIFEST_MAX_BYTES
} = require("../dist-electron/shared/webapp-manifest.js");
const {
  getWebappDir,
  readWebappItemFromDir,
  readWebappItems,
  writeCanonicalWebappManifest
} = require("../dist-electron/main/webs/webapps/store.js");
const {
  removeWebappItem,
  updateWebappItem
} = require("../dist-electron/main/webs/webapps/actions.js");
const { WebappRuntime } = require("../dist-electron/main/webs/webapps/runtime.js");
const {
  authorizeWebappActionToken,
  issueWebappActionToken,
  revokeWebappActionToken
} = require("../dist-electron/main/webs/webapps/action-tokens.js");
const {
  getWebappAllowedActions,
  isWebappActionAllowed
} = require("../dist-electron/main/webs/webapps/capability-policy.js");
const {
  readWebappRuntimeSettings,
  writeWebappRuntimeSettings
} = require("../dist-electron/main/webs/webapps/runtime-settings.js");
const {
  activateWebappInstall,
  commitWebappInstall,
  recoverWebappInstallTransactions,
  rollbackWebappInstall
} = require("../dist-electron/main/webs/webapps/install-transaction.js");
const {
  installWebsiteAppArchiveFromPath,
  WebappInstallPolicyError
} = require("../dist-electron/main/marketplace/website-app-market.js");
const {
  WEBAPP_BRIDGE_MODULE_SOURCE
} = require("../dist-electron/main/webs/webapps/bridge-module.js");

function createApp(homePath) {
  return {
    getPath(name) {
      if (name === "home") return homePath;
      if (name === "appData") return path.join(homePath, "app-data");
      if (name === "temp") return path.join(homePath, "tmp");
      if (name === "desktop") return path.join(homePath, "Desktop");
      assert.fail(`unexpected app.getPath(${name})`);
    },
    getAppPath() {
      return process.cwd();
    }
  };
}

function desktopRoot(homePath) {
  return path.join(homePath, APP_BRAND.paths.runtimeRootDirName, APP_BRAND.paths.desktopDataSubdir);
}

function webappsRoot(homePath) {
  return path.join(desktopRoot(homePath), "data", "webs", "webapps");
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function manifest(id, overrides = {}) {
  return {
    schemaVersion: 1,
    id,
    label: overrides.label ?? "Local Demo",
    version: overrides.version ?? "1.0.0",
    target: overrides.target ?? "universal",
    openMode: overrides.openMode ?? "workspace",
    appConfig: overrides.appConfig ?? {},
    frontend: overrides.frontend ?? {
      root: "frontend",
      index: "index.html",
      spa: true,
      apiPrefix: "/api"
    },
    ...(Object.hasOwn(overrides, "backend") ? { backend: overrides.backend } : {}),
    desktopBridge: overrides.desktopBridge ?? { version: 1, capabilities: {} }
  };
}

function backendServerSource(options = {}) {
  if (options.exitImmediately) return "process.exit(1);\n";
  return `
import http from "node:http";
const host = process.env.HOST;
const port = Number.parseInt(process.env.PORT, 10);
const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (request.url === "/api/context") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: process.env.WEBAPP_ID,
      manifestPath: process.env.WEBAPP_MANIFEST_PATH,
      dataDir: process.env.WEBAPP_DATA_DIR,
      stateDir: process.env.WEBAPP_STATE_DIR,
      logDir: process.env.WEBAPP_LOG_DIR,
      bridgeUrl: process.env.DESKTOP_ACTION_BRIDGE_URL,
      hasBridgeToken: Boolean(process.env.DESKTOP_ACTION_BRIDGE_TOKEN)
    }));
    return;
  }
  response.writeHead(404);
  response.end();
});
server.listen(port, host);
`;
}

function nodeBackend(overrides = {}) {
  return {
    command: { type: "electron-node", script: "backend/server.mjs" },
    args: [],
    env: {},
    health: { type: "http", path: "/health", timeoutMs: 2_000 },
    shutdownTimeoutMs: 1_000,
    ...overrides
  };
}

function writeWebapp(root, id, options = {}) {
  const appDir = path.join(root, id);
  fs.mkdirSync(path.join(appDir, "frontend"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "frontend", "index.html"), "<!doctype html><title>WebApp v1</title>", "utf8");
  const appManifest = manifest(id, options);
  if (appManifest.backend?.command.type === "electron-node") {
    fs.mkdirSync(path.join(appDir, "backend"), { recursive: true });
    fs.writeFileSync(
      path.join(appDir, appManifest.backend.command.script),
      options.backendSource ?? backendServerSource(),
      "utf8"
    );
  }
  if (appManifest.backend?.command.type === "bundled") {
    const executable = path.join(appDir, appManifest.backend.command.executable);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, options.backendSource ?? "binary", "utf8");
    fs.chmodSync(executable, 0o755);
  }
  writeJson(path.join(appDir, "webapp.json"), appManifest);
  return appDir;
}

function readUrl(target) {
  return new Promise((resolve, reject) => {
    http.get(target, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
        contentType: String(response.headers["content-type"] ?? "")
      }));
    }).on("error", reject);
  });
}

async function writeArchive(root, id, options = {}) {
  const packageRoot = path.join(root, `source-${id}-${options.version ?? "1.0.0"}-${Math.random()}`);
  const appDir = writeWebapp(packageRoot, id, options);
  if (options.frontendContent) {
    fs.writeFileSync(path.join(appDir, "frontend", "index.html"), options.frontendContent, "utf8");
  }
  const zip = new JSZip();
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(packageRoot, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) visit(absolute);
      if (entry.isFile()) zip.file(relative, fs.readFileSync(absolute));
    }
  };
  visit(packageRoot);
  const archivePath = path.join(root, `${id}-${options.version ?? "1.0.0"}-${Math.random()}.zip`);
  fs.writeFileSync(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
  return archivePath;
}

test("manifest v1 preserves arbitrary business appConfig and one typed assistant route", () => {
  const parsed = parseWebappManifest(manifest("meeting-notes", {
    appConfig: {
      outputLanguage: "zh-CN",
      sections: ["摘要", "行动项"],
      format: { markdown: true, density: 2 }
    },
    desktopBridge: {
      version: 1,
      capabilities: {
        "assistant.chat": {
          agentKey: "summary-agent",
          instruction: "只输出摘要和行动项。"
        },
        "native.dialog.directories": {}
      }
    }
  }));
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(parsed.appConfig.sections, ["摘要", "行动项"]);
  assert.equal(parsed.desktopBridge.capabilities["assistant.chat"].agentKey, "summary-agent");
});

test("WebApp SDK hides the internal config endpoint and sends only the chat message", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === "/__desktop/app-config.json") {
      return {
        ok: true,
        json: async () => ({
          id: "sdk-app",
          label: "SDK App",
          version: "1.0.0",
          appConfig: { features: { summarize: { prompt: "输出摘要" } } }
        })
      };
    }
    const request = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        ok: true,
        action: request.action,
        result: { text: "摘要", agentKey: "summary-agent", chatId: "chat", runId: "run" }
      })
    };
  };
  const sourceUrl = `data:text/javascript;base64,${Buffer.from(WEBAPP_BRIDGE_MODULE_SOURCE).toString("base64")}#${Date.now()}`;
  const { desktop } = await import(sourceUrl);

  assert.deepEqual(await desktop.app.getConfig(), {
    features: { summarize: { prompt: "输出摘要" } }
  });
  assert.deepEqual(await desktop.assistant.chat("会议原文"), {
    text: "摘要",
    agentKey: "summary-agent",
    chatId: "chat",
    runId: "run"
  });
  assert.equal(calls[0].url, "/__desktop/app-config.json");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    action: "desktop.assistant.chat",
    args: { message: "会议原文" }
  });
});

test("backend technology defaults to Desktop's bundled Electron Node runtime", () => {
  const parsed = parseWebappManifest(manifest("default-node", {
    backend: {
      health: { type: "http", path: "/health" }
    }
  }));
  assert.deepEqual(parsed.backend.command, {
    type: "electron-node",
    script: "backend/server.mjs"
  });
});

test("manifest v1 rejects legacy schemas, aliases, unknown host fields, and invalid ids", () => {
  for (const value of [
    { ...manifest("legacy"), schemaVersion: 5 },
    { ...manifest("legacy"), kind: "webapp" },
    { ...manifest("legacy"), assistantAgentKey: "agent" },
    { ...manifest("legacy"), desktopBridge: { version: 1, capabilities: ["assistant.chat"] } },
    { ...manifest("legacy"), desktopBridge: { version: 1, capabilities: {
      "assistant.chat": { behaviors: { summarize: {} } }
    } } },
    { ...manifest("legacy"), desktopBridge: { version: 1, capabilities: { "native.future": {} } } },
    { ...manifest("Invalid Id") }
  ]) {
    assert.throws(() => parseWebappManifest(value));
  }
});

test("manifest appConfig rejects secrets, dangerous keys, and size overflow", () => {
  assert.throws(() => parseWebappManifest(manifest("secret-app", { appConfig: { api_token: "secret" } })));
  assert.throws(() => parseWebappManifest(manifest("camel-secret-app", { appConfig: { modelKey: "secret" } })));
  assert.deepEqual(
    parseWebappManifest(manifest("business-token-app", { appConfig: { tokenBudget: 2_000 } })).appConfig,
    { tokenBudget: 2_000 }
  );
  const dangerous = JSON.parse('{"constructor":{"enabled":true}}');
  assert.throws(() => parseWebappManifest(manifest("dangerous-app", { appConfig: dangerous })));
  assert.throws(() => parseWebappManifest(manifest("large-app", {
    appConfig: { value: "x".repeat(WEBAPP_APP_CONFIG_MAX_BYTES) }
  })));
  assert.ok(Buffer.byteLength(JSON.stringify(manifest("small-app"))) < WEBAPP_MANIFEST_MAX_BYTES);
});

test("store requires exact manifest id and installation directory identity", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-store-v1-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const validDir = writeWebapp(root, "valid-app");
  assert.equal(readWebappItemFromDir(validDir, "valid-app").id, "valid-app");
  assert.throws(() => readWebappItemFromDir(validDir, "different-app"), /mismatch/u);
  assert.throws(() => readWebappItemFromDir(validDir, " valid-app "), /invalid/u);
  assert.throws(() => readWebappItemFromDir(validDir, "Needs-Normalizing"), /invalid/u);
  const canonical = writeCanonicalWebappManifest(validDir, "valid-app");
  assert.equal(canonical.schemaVersion, 1);
});

test("local display preferences do not mutate webapp.json", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-preferences-v1-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  writeWebapp(webappsRoot(homePath), "preference-app");
  const manifestPath = path.join(getWebappDir(app, "preference-app"), "webapp.json");
  const before = fs.readFileSync(manifestPath, "utf8");
  const updated = updateWebappItem(app, "preference-app", {
    label: "Local Label",
    copilotAgentKey: "local-copilot",
    openMode: "dialog"
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.item.label, "Local Label");
  assert.equal(updated.item.openMode, "dialog");
  assert.equal(fs.readFileSync(manifestPath, "utf8"), before);
  const removed = await removeWebappItem(app, "preference-app");
  assert.equal(removed.ok, true);
  assert.equal(fs.existsSync(getWebappDir(app, "preference-app")), false);
});

test("runtime settings store only per-WebApp system executable bindings", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-system-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = createApp(path.join(root, "home"));
  const executable = path.join(root, "runtime", "java");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, "#!/bin/sh\n", "utf8");
  fs.chmodSync(executable, 0o755);
  const settings = writeWebappRuntimeSettings(app, {
    systemExecutables: { "java-app:java": executable }
  });
  assert.deepEqual(settings, {
    schemaVersion: 1,
    systemExecutables: { "java-app:java": executable }
  });
  assert.deepEqual(readWebappRuntimeSettings(app), settings);
});

test("capability policy issues backend tokens only for assistant.chat", () => {
  const item = {
    id: "capability-app",
    schemaVersion: 1,
    desktopBridge: {
      version: 1,
      capabilities: {
        "assistant.chat": {},
        "native.clipboard.write": {}
      }
    }
  };
  assert.deepEqual(getWebappAllowedActions(item, "backendActionToken"), ["desktop.assistant.chat"]);
  assert.equal(isWebappActionAllowed(item, "localPageGateway", "desktop.native.clipboard.writeText"), true);
  assert.equal(isWebappActionAllowed(item, "backendActionToken", "desktop.native.clipboard.writeText"), false);
  const token = issueWebappActionToken(item, "backendActionToken");
  assert.deepEqual(authorizeWebappActionToken(token, "desktop.assistant.chat"), {
    ok: true,
    webappId: "capability-app",
    scope: "backendActionToken"
  });
  assert.equal(authorizeWebappActionToken(token, "desktop.native.clipboard.writeText").ok, false);
  revokeWebappActionToken(token);
  assert.equal(authorizeWebappActionToken(token, "desktop.assistant.chat").ok, false);
});

test("runtime statically hosts frontend, exposes read-only appConfig, and proxies only apiPrefix", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-runtime-v1-"));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const runtime = new WebappRuntime();
  t.after(async () => {
    await runtime.stopAll(app);
    fs.rmSync(root, { recursive: true, force: true });
  });
  writeWebapp(webappsRoot(homePath), "runtime-app", {
    appConfig: { theme: "compact", nested: { enabled: true } },
    backend: nodeBackend(),
    desktopBridge: {
      version: 1,
      capabilities: { "assistant.chat": {} }
    }
  });
  updateWebappItem(app, "runtime-app", { label: "Local display label" });
  const started = await runtime.start(app, "runtime-app");
  assert.equal(started.ok, true);
  const rootPage = await readUrl(started.state.webUrl);
  assert.equal(rootPage.status, 200);
  assert.match(rootPage.body, /WebApp v1/u);
  const config = await readUrl(new URL("__desktop/app-config.json", started.state.webUrl));
  assert.deepEqual(JSON.parse(config.body), {
    id: "runtime-app",
    label: "Local Demo",
    version: "1.0.0",
    appConfig: { theme: "compact", nested: { enabled: true } }
  }, "gateway config must come from webapp.json, not mutable local preferences");
  const context = JSON.parse((await readUrl(new URL("api/context", started.state.webUrl))).body);
  assert.equal(context.id, "runtime-app");
  assert.equal(context.manifestPath, path.join(getWebappDir(app, "runtime-app"), "webapp.json"));
  assert.equal(context.hasBridgeToken, true);
  const backendRoot = await readUrl(new URL("health", started.state.webUrl));
  assert.equal(backendRoot.status, 200);
  assert.match(backendRoot.body, /WebApp v1/u, "non-api paths must use the static SPA fallback");
  const stopped = await runtime.stop(app, "runtime-app");
  assert.equal(stopped.ok, true);
});

test("frontend-only WebApps run without a backend or backend token", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-static-v1-"));
  const app = createApp(path.join(root, "home"));
  const runtime = new WebappRuntime();
  t.after(async () => {
    await runtime.stopAll(app);
    fs.rmSync(root, { recursive: true, force: true });
  });
  writeWebapp(webappsRoot(app.getPath("home")), "static-app", { appConfig: { local: true } });
  const started = await runtime.start(app, "static-app");
  assert.equal(started.ok, true);
  assert.equal(started.state.launcher, "none");
  assert.equal(started.state.backendPort, null);
  assert.equal((await readUrl(started.state.webUrl)).status, 200);
});

test("install policy supports idempotence, upgrades, conflicts, downgrades, and parallel ids", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-installer-v1-"));
  const app = createApp(path.join(root, "home"));
  t.after(async () => {
    await new WebappRuntime().stopAll(app);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const firstArchive = await writeArchive(root, "install-app", { version: "1.0.0" });
  await assert.rejects(
    installWebsiteAppArchiveFromPath(app, firstArchive, { expectedId: " install-app " }),
    (error) => error instanceof WebappInstallPolicyError && error.code === "invalid_id"
  );
  const installed = await installWebsiteAppArchiveFromPath(app, firstArchive, { expectedId: "install-app" });
  assert.equal(installed.ok, true);
  const idempotent = await installWebsiteAppArchiveFromPath(app, firstArchive, { expectedId: "install-app" });
  assert.equal(idempotent.ok, true);

  const conflictArchive = await writeArchive(root, "install-app", {
    version: "1.0.0",
    frontendContent: "<!doctype html><title>different</title>"
  });
  await assert.rejects(
    installWebsiteAppArchiveFromPath(app, conflictArchive, { expectedId: "install-app" }),
    (error) => error instanceof WebappInstallPolicyError && error.code === "version_content_conflict"
  );

  const downgradeArchive = await writeArchive(root, "install-app", { version: "0.9.0" });
  await assert.rejects(
    installWebsiteAppArchiveFromPath(app, downgradeArchive, { expectedId: "install-app" }),
    (error) => error instanceof WebappInstallPolicyError && error.code === "downgrade_not_allowed"
  );

  const upgradeArchive = await writeArchive(root, "install-app", { version: "1.1.0" });
  assert.equal((await installWebsiteAppArchiveFromPath(app, upgradeArchive, { expectedId: "install-app" })).ok, true);
  assert.equal(readWebappItems(app).find((item) => item.id === "install-app").version, "1.1.0");

  const parallelArchive = await writeArchive(root, "parallel-app", { version: "1.0.0" });
  assert.equal((await installWebsiteAppArchiveFromPath(app, parallelArchive, { expectedId: "parallel-app" })).ok, true);
  assert.deepEqual(readWebappItems(app).map((item) => item.id).sort(), ["install-app", "parallel-app"]);
});

test("failed startup validation rolls an upgrade back to the old package", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-rollback-v1-"));
  const app = createApp(path.join(root, "home"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = await writeArchive(root, "rollback-app", { version: "1.0.0" });
  await installWebsiteAppArchiveFromPath(app, original, { expectedId: "rollback-app" });
  const broken = await writeArchive(root, "rollback-app", {
    version: "2.0.0",
    backend: nodeBackend({ health: { type: "http", path: "/health", timeoutMs: 1_000 } }),
    backendSource: backendServerSource({ exitImmediately: true })
  });
  await assert.rejects(
    installWebsiteAppArchiveFromPath(app, broken, { expectedId: "rollback-app" }),
    (error) => error instanceof Error && error.message.length > 0
  );
  assert.equal(readWebappItems(app).find((item) => item.id === "rollback-app").version, "1.0.0");
  const restoredState = new WebappRuntime().getStatus(app, "rollback-app");
  assert.equal(restoredState.version, "1.0.0");
  assert.equal(restoredState.status, "stopped");

  const rejectedNew = await writeArchive(root, "rejected-new-app", {
    backend: nodeBackend({ health: { type: "http", path: "/health", timeoutMs: 1_000 } }),
    backendSource: backendServerSource({ exitImmediately: true })
  });
  await assert.rejects(
    installWebsiteAppArchiveFromPath(app, rejectedNew, { expectedId: "rejected-new-app" })
  );
  assert.equal(fs.existsSync(path.join(webappsRoot(app.getPath("home")), "rejected-new-app")), false);
  assert.equal(
    fs.existsSync(path.join(desktopRoot(app.getPath("home")), "data", "webs", "webapp-data", "rejected-new-app")),
    false
  );
  assert.equal(
    fs.existsSync(path.join(desktopRoot(app.getPath("home")), "state", "webs", "webapps", "rejected-new-app")),
    false
  );
});

test("install transaction activation can commit, rollback, and recover", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-transaction-v1-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = createApp(path.join(root, "home"));
  const installPath = path.join(webappsRoot(app.getPath("home")), "transaction-app");
  const stagingPath = path.join(desktopRoot(app.getPath("home")), "state", "webapps", "install-staging", "transaction-staging");
  fs.mkdirSync(installPath, { recursive: true });
  fs.writeFileSync(path.join(installPath, "version.txt"), "old", "utf8");
  fs.mkdirSync(stagingPath, { recursive: true });
  fs.writeFileSync(path.join(stagingPath, "version.txt"), "new", "utf8");
  const transaction = activateWebappInstall({ app, id: "transaction-app", installPath, stagingPath });
  assert.equal(fs.readFileSync(path.join(installPath, "version.txt"), "utf8"), "new");
  rollbackWebappInstall(app, transaction);
  assert.equal(fs.readFileSync(path.join(installPath, "version.txt"), "utf8"), "old");

  const staging2 = `${stagingPath}-2`;
  fs.mkdirSync(staging2, { recursive: true });
  fs.writeFileSync(path.join(staging2, "version.txt"), "committed", "utf8");
  const committed = activateWebappInstall({ app, id: "transaction-app", installPath, stagingPath: staging2 });
  commitWebappInstall(app, committed);
  assert.equal(fs.readFileSync(path.join(installPath, "version.txt"), "utf8"), "committed");
  assert.deepEqual(recoverWebappInstallTransactions(app), []);
});
