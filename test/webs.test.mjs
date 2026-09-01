import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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
  getWebappUserConfigPath,
  readWebappUserConfigState,
  readWebappItemFromDir,
  readWebappItems,
  writeWebappUserConfigValues,
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
  WebappInstallError,
  WebappInstallPolicyError
} = require("../dist-electron/main/marketplace/website-app-market.js");
const {
  WEBAPP_BRIDGE_MODULE_SOURCE
} = require("../dist-electron/main/webs/webapps/bridge-module.js");
const {
  clearWebappImageUploadsForTest,
  consumeWebappImageUpload,
  normalizeWebappImageUploadFile,
  registerWebappImageUpload,
  WEBAPP_IMAGE_INPUT_MAX_BYTES
} = require("../dist-electron/main/webs/webapps/image-upload-registry.js");
const {
  createWebappImportDiagnostic
} = require("../dist-electron/main/ipc/web-handlers.js");

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

function webappId(key) {
  return `webapp-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function manifest(key, overrides = {}) {
  return {
    schemaVersion: 2,
    id: overrides.id ?? webappId(key),
    key: overrides.key ?? key,
    label: overrides.label ?? "Local Demo",
    version: overrides.version ?? "1.0.0",
    target: overrides.target ?? "any",
    appConfig: overrides.appConfig ?? {},
    ...(Object.hasOwn(overrides, "userConfig") ? { userConfig: overrides.userConfig } : {}),
    frontend: overrides.frontend ?? {
      root: "frontend",
      index: "index.html",
      routeConfig: {
        backendPrefixes: overrides.backend ? ["/api"] : [],
        navigationFallback: "index.html"
      }
    },
    ...(Object.hasOwn(overrides, "backend") ? { backend: overrides.backend } : {}),
    ...(Object.hasOwn(overrides, "copilot") ? { copilot: overrides.copilot } : {}),
    desktopBridge: overrides.desktopBridge ?? { version: 1 }
  };
}

function backendServerSource(options = {}) {
  if (options.exitImmediately) return "process.exit(1);\n";
  return `
import http from "node:http";
import fs from "node:fs";
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
      hasBridgeToken: Boolean(process.env.DESKTOP_ACTION_BRIDGE_TOKEN),
      userConfigPath: process.env.WEBAPP_USER_CONFIG_PATH,
      userConfig: JSON.parse(fs.readFileSync(process.env.WEBAPP_USER_CONFIG_PATH, "utf8"))
    }));
    return;
  }
  response.writeHead(404);
  response.end();
});
server.listen(port, host);
`;
}

test("WebApp image upload registry validates signatures, limits bytes, and binds one-time handles to an app", () => {
  clearWebappImageUploadsForTest();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  assert.throws(() => normalizeWebappImageUploadFile({ name: "fake.png", mimeType: "image/png", bytes: Buffer.from("not an image") }), /PNG, JPEG, or WebP/u);
  assert.throws(() => normalizeWebappImageUploadFile({ name: "mask.jpg", mimeType: "image/jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff, 1]) }, { mask: true }), /mask must be PNG/u);
  assert.throws(() => normalizeWebappImageUploadFile({ name: "large.png", mimeType: "image/png", bytes: Buffer.alloc(WEBAPP_IMAGE_INPUT_MAX_BYTES + 1) }), /exceeds/u);
  const upload = registerWebappImageUpload({
    webappId: "webapp-a",
    source: normalizeWebappImageUploadFile({ name: "source.png", mimeType: "image/png", bytes: png })
  });
  assert.equal(consumeWebappImageUpload("webapp-b", upload.uploadId), null);
  assert.equal(consumeWebappImageUpload("webapp-a", upload.uploadId)?.source?.bytes.equals(png), true);
  assert.equal(consumeWebappImageUpload("webapp-a", upload.uploadId), null);
  clearWebappImageUploadsForTest();
});

function nodeBackend(overrides = {}) {
  return {
    command: { type: "electron-node", entry: "backend/server.mjs" },
    args: [],
    env: {},
    health: { type: "http", path: "/health", startupTimeoutMs: 2_000 },
    shutdownTimeoutMs: 1_000,
    ...overrides
  };
}

function writeWebapp(root, key, options = {}) {
  const id = options.id ?? webappId(key);
  const appDir = path.join(root, id);
  fs.mkdirSync(path.join(appDir, "frontend"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "frontend", "index.html"), "<!doctype html><title>WebApp v2</title>", "utf8");
  const appManifest = manifest(key, { ...options, id });
  if (appManifest.backend?.command.type === "electron-node") {
    fs.mkdirSync(path.join(appDir, "backend"), { recursive: true });
    fs.writeFileSync(
      path.join(appDir, appManifest.backend.command.entry),
      options.backendSource ?? backendServerSource(),
      "utf8"
    );
  }
  if (appManifest.backend?.command.type === "executable") {
    const executable = path.join(appDir, appManifest.backend.command.entry);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, options.backendSource ?? "binary", "utf8");
    fs.chmodSync(executable, 0o755);
  }
  writeJson(path.join(appDir, "webapp.json"), appManifest);
  return appDir;
}

function readUrl(target, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(target, { headers }, (response) => {
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

async function writeArchive(root, key, options = {}) {
  const id = options.id ?? webappId(key);
  const packageRoot = path.join(root, `source-${key}-${options.version ?? "1.0.0"}-${Math.random()}`);
  const appDir = writeWebapp(packageRoot, key, { ...options, id });
  if (options.frontendContent) {
    fs.writeFileSync(path.join(appDir, "frontend", "index.html"), options.frontendContent, "utf8");
  }
  for (const [relativePath, content] of Object.entries(options.extraFiles ?? {})) {
    const absolutePath = path.join(appDir, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, "utf8");
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

test("manifest v2 preserves appConfig and enables Desktop Bridge v1 without capability declarations", () => {
  const parsed = parseWebappManifest(manifest("meeting-notes", {
    appConfig: {
      outputLanguage: "zh-CN",
      sections: ["摘要", "行动项"],
      format: { markdown: true, density: 2 }
    },
    userConfig: {
      fields: [
        {
          name: "agentKey",
          type: "select",
          source: "desktop.agents",
          label: "智能体",
          required: true,
          default: "summary-agent"
        },
        {
          name: "prompt",
          type: "textarea",
          label: "处理要求",
          default: "只输出摘要和行动项。"
        }
      ]
    },
    desktopBridge: {
      version: 1
    }
  }));
  assert.equal(parsed.schemaVersion, 2);
  assert.deepEqual(parsed.appConfig.sections, ["摘要", "行动项"]);
  assert.equal(parsed.userConfig.fields[0].source, "desktop.agents");
  assert.deepEqual(parsed.desktopBridge, { version: 1 });
});

test("manifest v2 defaults Desktop Bridge v1 and rejects legacy capability arrays", () => {
  const withoutBridge = manifest("bridge-default");
  delete withoutBridge.desktopBridge;
  assert.deepEqual(parseWebappManifest(withoutBridge).desktopBridge, { version: 1 });

  const legacy = manifest("bridge-legacy", {
    desktopBridge: {
      version: 1,
      capabilities: ["assistant.chat", "native.clipboard.write"]
    }
  });
  assert.throws(() => parseWebappManifest(legacy));
});

test("manifest v2 validates fixed Copilot agent and forced skill configuration", () => {
  const parsed = parseWebappManifest(manifest("poster-studio", {
    copilot: {
      agentKey: "webOperator",
      mustUseSkills: ["poster-studio"]
    }
  }));
  assert.deepEqual(parsed.copilot, {
    agentKey: "webOperator",
    mustUseSkills: ["poster-studio"]
  });

  assert.throws(() => parseWebappManifest(manifest("poster-conflict", {
    copilot: { agentKey: "webOperator", mustUseSkills: ["poster-studio"] },
    userConfig: {
      fields: [{
        name: "agentKey",
        type: "select",
        source: "desktop.agents",
        label: "智能体"
      }]
    }
  })));
  assert.throws(() => parseWebappManifest(manifest("poster-duplicate", {
    copilot: {
      agentKey: "webOperator",
      mustUseSkills: ["poster-studio", "poster-studio"]
    }
  })));
  assert.throws(() => parseWebappManifest(manifest("poster-invalid-skill", {
    copilot: {
      agentKey: "webOperator",
      mustUseSkills: ["../poster-studio"]
    }
  })));
});

test("WebApp SDK hides internal endpoints and separates chat from binary image upload", async (t) => {
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
    if (url === "/__desktop/assistant/image/uploads") {
      assert.equal(options.body instanceof FormData, true);
      assert.equal(options.body.get("source") instanceof Blob, true);
      assert.equal(options.body.get("mask") instanceof Blob, true);
      return {
        ok: true,
        json: async () => ({ ok: true, uploadId: "webimg-1" })
      };
    }
    const request = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        ok: true,
        action: request.action,
        result: request.action === "desktop.assistant.image"
          ? { agentKey: "zenmi", images: [{ dataBase64: "AA==", mimeType: "image/png", sizeBytes: 1 }] }
          : { text: "摘要", agentKey: "summary-agent", chatId: "chat", runId: "run" }
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
  const imageResult = await desktop.assistant.image({
    requestId: "image-request-1",
    operation: "inpaint",
    source: new Blob(["source"], { type: "image/png" }),
    mask: new Blob(["mask"], { type: "image/png" })
  });
  assert.equal(imageResult.agentKey, "zenmi");
  assert.equal(calls[2].url, "/__desktop/assistant/image/uploads");
  assert.deepEqual(JSON.parse(calls[3].options.body), {
    action: "desktop.assistant.image",
    args: { requestId: "image-request-1", operation: "inpaint", uploadId: "webimg-1" }
  });
});

test("backend command is explicit and Desktop supplies safe defaults around it", () => {
  const parsed = parseWebappManifest(manifest("default-node", {
    backend: {
      command: { type: "electron-node", entry: "backend/server.mjs" },
      health: { type: "http", path: "/health" }
    }
  }));
  assert.deepEqual(parsed.backend.command, {
    type: "electron-node",
    entry: "backend/server.mjs"
  });
  assert.deepEqual(parsed.backend.args, []);
  assert.deepEqual(parsed.backend.env, {});
  assert.equal(parsed.backend.health.startupTimeoutMs, 10_000);
});

test("manifest v2 rejects legacy fields, capability declarations, unknown fields, and invalid ids", () => {
  for (const value of [
    { ...manifest("legacy"), schemaVersion: 1 },
    { ...manifest("legacy"), kind: "webapp" },
    { ...manifest("legacy"), assistantAgentKey: "agent" },
    { ...manifest("legacy"), openMode: "workspace" },
    { ...manifest("legacy"), frontend: { root: "frontend", index: "index.html", spa: true } },
    { ...manifest("legacy"), desktopBridge: { version: 1, capabilities: ["assistant.chat"] } },
    { ...manifest("legacy"), desktopBridge: { version: 1, capabilities: { "assistant.chat": {} } } },
    { ...manifest("legacy"), desktopBridge: { version: 1, capabilities: { "native.future": {} } } },
    { ...manifest("valid-key"), id: "Invalid Id" }
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
  const validId = webappId("valid-app");
  const validDir = writeWebapp(root, "valid-app");
  assert.equal(readWebappItemFromDir(validDir, validId).id, validId);
  assert.throws(() => readWebappItemFromDir(validDir, webappId("different-app")), /mismatch/u);
  assert.throws(() => readWebappItemFromDir(validDir, ` ${validId} `), /invalid/u);
  assert.throws(() => readWebappItemFromDir(validDir, "Needs-Normalizing"), /invalid/u);
  const canonical = writeCanonicalWebappManifest(validDir, validId);
  assert.equal(canonical.schemaVersion, 2);
});

test("local display preferences do not mutate webapp.json", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-preferences-v1-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const preferenceId = webappId("preference-app");
  writeWebapp(webappsRoot(homePath), "preference-app");
  const manifestPath = path.join(getWebappDir(app, preferenceId), "webapp.json");
  const before = fs.readFileSync(manifestPath, "utf8");
  const updated = updateWebappItem(app, preferenceId, {
    label: "Local Label",
    openMode: "dialog"
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.item.label, "Local Label");
  assert.equal(updated.item.openMode, "dialog");
  assert.equal(fs.readFileSync(manifestPath, "utf8"), before);
  const removed = await removeWebappItem(app, preferenceId);
  assert.equal(removed.ok, true);
  assert.equal(fs.existsSync(getWebappDir(app, preferenceId)), false);
});

test("runtime settings store only per-WebApp runtime executable bindings", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-system-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = createApp(path.join(root, "home"));
  const executable = path.join(root, "runtime", "java");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, "#!/bin/sh\n", "utf8");
  fs.chmodSync(executable, 0o755);
  const javaAppId = webappId("java-app");
  const settings = writeWebappRuntimeSettings(app, {
    runtimeExecutables: { [`${javaAppId}:java`]: executable }
  });
  assert.deepEqual(settings, {
    schemaVersion: 1,
    runtimeExecutables: { [`${javaAppId}:java`]: executable }
  });
  assert.deepEqual(readWebappRuntimeSettings(app), settings);
});

test("userConfig keeps field definitions in the package and actual values in Desktop data", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-webapp-user-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = createApp(path.join(root, "home"));
  const id = webappId("configurable-app");
  writeWebapp(webappsRoot(app.getPath("home")), "configurable-app", {
    userConfig: {
      fields: [
        {
          name: "agentKey",
          type: "select",
          source: "desktop.agents",
          label: "智能体",
          required: true,
          default: "test-agent"
        },
        {
          name: "prompt",
          type: "textarea",
          label: "提示词",
          default: "请处理以下内容"
        }
      ]
    }
  });
  assert.deepEqual(readWebappUserConfigState(app, id), {
    values: { agentKey: "test-agent", prompt: "请处理以下内容" },
    issues: []
  });
  const saved = writeWebappUserConfigValues(app, id, {
    agentKey: "desktopTextGenerator",
    prompt: "只返回结果"
  });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.values, {
    agentKey: "desktopTextGenerator",
    prompt: "只返回结果"
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(getWebappUserConfigPath(app, id), "utf8")), {
    agentKey: "desktopTextGenerator",
    prompt: "只返回结果"
  });
  const invalid = writeWebappUserConfigValues(app, id, {
    agentKey: "test-agent",
    prompt: "有效",
    apiToken: "must-not-be-stored"
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.issues[0].field, "apiToken");
});

test("public Bridge policy enables every page capability and keeps backend tokens scoped to assistant.chat", () => {
  const item = {
    id: webappId("capability-app"),
    schemaVersion: 2,
    desktopBridge: {
      version: 1
    }
  };
  assert.deepEqual(getWebappAllowedActions(item, "backendActionToken"), ["desktop.assistant.chat"]);
  assert.equal(isWebappActionAllowed(item, "localPageGateway", "desktop.native.clipboard.writeText"), true);
  assert.equal(isWebappActionAllowed(item, "backendActionToken", "desktop.native.clipboard.writeText"), false);
  const token = issueWebappActionToken(item, "backendActionToken");
  assert.deepEqual(authorizeWebappActionToken(token, "desktop.assistant.chat"), {
    ok: true,
    webappId: webappId("capability-app"),
    scope: "backendActionToken"
  });
  assert.equal(authorizeWebappActionToken(token, "desktop.native.clipboard.writeText").ok, false);
  revokeWebappActionToken(token);
  assert.equal(authorizeWebappActionToken(token, "desktop.assistant.chat").ok, false);
});

test("runtime hosts frontend, exposes read-only configs, and follows typed routeConfig", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-runtime-v1-"));
  const homePath = path.join(root, "home");
  const app = createApp(homePath);
  const runtime = new WebappRuntime();
  t.after(async () => {
    await runtime.stopAll(app);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const runtimeId = webappId("runtime-app");
  writeWebapp(webappsRoot(homePath), "runtime-app", {
    appConfig: { theme: "compact", nested: { enabled: true } },
    backend: nodeBackend(),
    desktopBridge: {
      version: 1
    }
  });
  updateWebappItem(app, runtimeId, { label: "Local display label" });
  const started = await runtime.start(app, runtimeId);
  assert.equal(started.ok, true);
  const rootPage = await readUrl(started.state.webUrl);
  assert.equal(rootPage.status, 200);
  assert.match(rootPage.body, /WebApp v2/u);
  const config = await readUrl(new URL("__desktop/app-config.json", started.state.webUrl));
  assert.deepEqual(JSON.parse(config.body), {
    id: runtimeId,
    label: "Local Demo",
    version: "1.0.0",
    appConfig: { theme: "compact", nested: { enabled: true } }
  }, "gateway config must come from webapp.json, not mutable local preferences");
  const context = JSON.parse((await readUrl(new URL("api/context", started.state.webUrl))).body);
  assert.equal(context.id, runtimeId);
  assert.equal(context.manifestPath, path.join(getWebappDir(app, runtimeId), "webapp.json"));
  assert.equal(context.hasBridgeToken, true);
  const backendRoot = await readUrl(new URL("health", started.state.webUrl));
  assert.equal(backendRoot.status, 404, "non-proxy paths must not reach the backend");
  const deepRoute = await readUrl(new URL("workspace/notes", started.state.webUrl), { Accept: "text/html" });
  assert.equal(deepRoute.status, 200);
  assert.match(deepRoute.body, /WebApp v2/u, "HTML navigation may use the declared fallback");
  const missingAsset = await readUrl(new URL("missing.js", started.state.webUrl), { Accept: "*/*" });
  assert.equal(missingAsset.status, 404, "missing assets must not fall back to HTML");
  const stopped = await runtime.stop(app, runtimeId);
  assert.equal(stopped.ok, true);
});

test("frontend-only WebApps run without a backend or backend token", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-static-v1-"));
  const app = createApp(path.join(root, "home"));
  const staticId = webappId("static-app");
  const runtime = new WebappRuntime();
  t.after(async () => {
    await runtime.stopAll(app);
    fs.rmSync(root, { recursive: true, force: true });
  });
  writeWebapp(webappsRoot(app.getPath("home")), "static-app", { appConfig: { local: true } });
  const started = await runtime.start(app, staticId);
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
  const installId = webappId("install-app");
  await assert.rejects(
    installWebsiteAppArchiveFromPath(app, firstArchive, { expectedId: ` ${installId} ` }),
    (error) => error instanceof WebappInstallPolicyError && error.code === "invalid_id"
  );
  const installed = await installWebsiteAppArchiveFromPath(app, firstArchive, { expectedId: installId });
  assert.equal(installed.ok, true);
  const idempotent = await installWebsiteAppArchiveFromPath(app, firstArchive, { expectedId: installId });
  assert.equal(idempotent.ok, true);

  const conflictArchive = await writeArchive(root, "install-app", {
    version: "1.0.0",
    frontendContent: "<!doctype html><title>different</title>"
  });
  await assert.rejects(
    installWebsiteAppArchiveFromPath(app, conflictArchive, { expectedId: installId }),
    (error) => error instanceof WebappInstallPolicyError && error.code === "version_content_conflict"
  );

  const downgradeArchive = await writeArchive(root, "install-app", { version: "0.9.0" });
  await assert.rejects(
    installWebsiteAppArchiveFromPath(app, downgradeArchive, { expectedId: installId }),
    (error) => error instanceof WebappInstallPolicyError && error.code === "downgrade_not_allowed"
  );

  const upgradeArchive = await writeArchive(root, "install-app", { version: "1.1.0" });
  assert.equal((await installWebsiteAppArchiveFromPath(app, upgradeArchive, { expectedId: installId })).ok, true);
  assert.equal(readWebappItems(app).find((item) => item.id === installId).version, "1.1.0");

  const parallelArchive = await writeArchive(root, "parallel-app", { version: "1.0.0" });
  const parallelId = webappId("parallel-app");
  assert.equal((await installWebsiteAppArchiveFromPath(app, parallelArchive, { expectedId: parallelId })).ok, true);
  assert.deepEqual(readWebappItems(app).map((item) => item.id).sort(), [installId, parallelId].sort());
});

test("Tooling and Desktop installer share path and native artifact policy", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-webapp-package-policy-"));
  const app = createApp(path.join(root, "home"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const projectRoot = writeWebapp(root, "tooling-policy-app");
  fs.mkdirSync(path.join(projectRoot, ".mypy_cache"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, ".mypy_cache", "cache.bin"), "cache", "utf8");
  const tooling = spawnSync(process.execPath, [
    path.join(process.cwd(), "scripts", "run-webapp-tooling.mjs"),
    "package",
    "validate",
    "--project",
    projectRoot
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(tooling.status, 1);
  assert.equal(JSON.parse(tooling.stdout).code, "disallowed_path");

  const archive = await writeArchive(root, "installer-policy-app", {
    extraFiles: { "dist-cache/cache.bin": "cache" }
  });
  await assert.rejects(
    installWebsiteAppArchiveFromPath(app, archive),
    (error) => error instanceof WebappInstallError &&
      error.stage === "archive" &&
      error.code === "disallowed_path"
  );

  const nativeProjectRoot = writeWebapp(root, "tooling-native-app");
  fs.writeFileSync(path.join(nativeProjectRoot, "addon.node"), "not-native", "utf8");
  const nativeTooling = spawnSync(process.execPath, [
    path.join(process.cwd(), "scripts", "run-webapp-tooling.mjs"),
    "package",
    "validate",
    "--project",
    nativeProjectRoot
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(nativeTooling.status, 1);
  assert.equal(JSON.parse(nativeTooling.stdout).code, "native_artifact_forbidden");

  const nativeArchive = await writeArchive(root, "installer-native-app", {
    extraFiles: { "addon.node": "not-native" }
  });
  await assert.rejects(
    installWebsiteAppArchiveFromPath(app, nativeArchive),
    (error) => error instanceof WebappInstallError &&
      error.stage === "package" &&
      error.code === "native_artifact_forbidden"
  );
});

test("WebApp Tooling preserves the project package without adding a Market manifest", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-webapp-market-package-"));
  const projectRoot = writeWebapp(root, "market-package-app", { version: "1.2.3" });
  const outputPath = path.join(root, "market-package.zip");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const tooling = spawnSync(process.execPath, [
    path.join(process.cwd(), "scripts", "run-webapp-tooling.mjs"),
    "package",
    "build",
    "--project",
    projectRoot,
    "--output",
    outputPath
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(tooling.status, 0, tooling.stderr || tooling.stdout);
  const result = JSON.parse(tooling.stdout);
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  assert.ok(zip.file(`${result.id}/webapp.json`));
  assert.equal(zip.file(`${result.id}/website.json`), null);
  assert.equal(fs.existsSync(path.join(projectRoot, "website.json")), false);
});

test("WebApp import diagnostics use structured errors instead of localized message text", () => {
  const structured = createWebappImportDiagnostic(new WebappInstallError(
    "archive",
    "unsafe_path",
    "启动进程 Java manifest ZIP",
    { path: "../unsafe" }
  ));
  assert.equal(structured.stage, "archive");
  assert.equal(structured.code, "unsafe_path");
  assert.deepEqual(structured.details, { path: "../unsafe" });

  const unknown = createWebappImportDiagnostic(new Error("ZIP manifest Java 启动进程"));
  assert.equal(unknown.stage, "install");
  assert.equal(unknown.code, "install_failed");
});

test("failed startup validation rolls an upgrade back to the old package", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-webapp-rollback-v1-"));
  const app = createApp(path.join(root, "home"));
  const rollbackId = webappId("rollback-app");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = await writeArchive(root, "rollback-app", { version: "1.0.0" });
  await installWebsiteAppArchiveFromPath(app, original, { expectedId: rollbackId });
  const broken = await writeArchive(root, "rollback-app", {
    version: "2.0.0",
    backend: nodeBackend({ health: { type: "http", path: "/health", startupTimeoutMs: 1_000 } }),
    backendSource: backendServerSource({ exitImmediately: true })
  });
  await assert.rejects(
    installWebsiteAppArchiveFromPath(app, broken, { expectedId: rollbackId }),
    (error) => error instanceof Error && error.message.length > 0
  );
  assert.equal(readWebappItems(app).find((item) => item.id === rollbackId).version, "1.0.0");
  const restoredState = new WebappRuntime().getStatus(app, rollbackId);
  assert.equal(restoredState.version, "1.0.0");
  assert.equal(restoredState.status, "stopped");

  const rejectedNew = await writeArchive(root, "rejected-new-app", {
    backend: nodeBackend({ health: { type: "http", path: "/health", startupTimeoutMs: 1_000 } }),
    backendSource: backendServerSource({ exitImmediately: true })
  });
  const rejectedNewId = webappId("rejected-new-app");
  await assert.rejects(
    installWebsiteAppArchiveFromPath(app, rejectedNew, { expectedId: rejectedNewId })
  );
  assert.equal(fs.existsSync(path.join(webappsRoot(app.getPath("home")), rejectedNewId)), false);
  assert.equal(
    fs.existsSync(path.join(desktopRoot(app.getPath("home")), "data", "webs", "webapp-data", rejectedNewId)),
    false
  );
  assert.equal(
    fs.existsSync(path.join(desktopRoot(app.getPath("home")), "state", "webs", "webapps", rejectedNewId)),
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
