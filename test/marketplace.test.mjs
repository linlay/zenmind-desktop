import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const JSZip = require("jszip");
const { load: loadYaml } = require("js-yaml");
const {
  buildSandboxImage,
  DEFAULT_MARKETPLACE_CATALOG_URL,
  deleteSandboxImage,
  exportSandboxImageToPath,
  getMarketSettings,
  importSkillFromCommand,
  importSandboxImageFromPath,
  installMarketItem,
  listMarketItems,
  refreshMarketCatalog,
  saveMarketSettings,
  toggleMarketFavorite,
  uninstallMarketItem,
  __testInternals
} = require("../dist-electron/main/marketplace.js");
const { webappManager } = require("../dist-electron/main/webs/webapps/manager.js");
const installWebsiteAppArchiveFromPath = (app, archivePath, options) =>
  webappManager.installArchive(app, archivePath, options);
const { getPluginInstallDir, installPluginFromArchive } = require("../dist-electron/main/plugin-loader.js");
const { getSkillInstallDir, installSkillFromPath } = require("../dist-electron/main/skill-installer.js");
const { readDesktopPetStoredState } = require("../dist-electron/main/assistant/pet/desktop-pet.js");
const { readWebappItems } = require("../dist-electron/main/webs/webapps/store.js");
const { configureAgentMarketPlatformCaller } = require("../dist-electron/main/marketplace/agent-market.js");
const { getSoftwarePackageInstallDir } = require("../dist-electron/main/marketplace/software-package-market.js");
const { resolveRuntimeRoot } = require("../dist-electron/main/env-bootstrap.js");
const {
  getDesktopConfigRoot,
  getDesktopPetsDataRoot,
  getDesktopWebappsDataRoot,
  getMarketplaceCacheRoot
} = require("../dist-electron/main/user-paths.js");
const { __testInternals: registryInternals } = require("../dist-electron/main/services/service-registry.js");

test("platform candidates keep fallbacks within the current CPU architecture", () => {
  const candidates = __testInternals.platformCandidates;
  assert.deepEqual(candidates("darwin", "arm64"), ["darwin-arm64", "universal"]);
  assert.deepEqual(candidates("darwin", "x64"), ["darwin-x64", "darwin-amd64", "universal"]);
  assert.deepEqual(candidates("win32", "arm64"), ["windows-arm64", "universal"]);
  assert.deepEqual(candidates("win32", "x64"), ["windows-amd64", "windows-x64", "universal"]);
  assert.deepEqual(candidates("win32", "ia32"), ["windows-x86", "windows-ia32", "universal"]);
  assert.deepEqual(candidates("linux", "x64"), ["linux-amd64", "linux-x64", "universal"]);
  assert.equal(candidates("darwin", "x64").includes("darwin-arm64"), false);
  assert.equal(candidates("win32", "arm64").includes("windows-amd64"), false);
});

function createApp(root) {
  return {
    isPackaged: false,
    getVersion() {
      return "0.3.40";
    },
    getPath(name) {
      if (name === "userData") return path.join(root, "user-data");
      if (name === "home") return path.join(root, "home");
      if (name === "desktop") return path.join(root, "home", "Desktop");
      if (name === "temp") return path.join(root, "temp");
      throw new Error(`unexpected getPath(${name})`);
    }
  };
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function webappId(key) {
  return `webapp-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function writeZipArchive(root, archivePath, entryName) {
  if (process.platform === "win32") {
    execFileSync("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Compress-Archive -LiteralPath '${path.join(root, entryName).replace(/'/g, "''")}' -DestinationPath '${archivePath.replace(/'/g, "''")}' -Force`
    ]);
    return;
  }
  execFileSync("zip", ["-qr", archivePath, entryName], { cwd: root });
}

function writePluginArchive(root, options = {}) {
  const pluginId = options.id ?? "cloud-plugin";
  const fixtureRoot = path.join(root, `fixture-${pluginId}`);
  const bundleRoot = path.join(fixtureRoot, pluginId);
  const archivePath = path.join(root, `${pluginId}.zip`);
  fs.mkdirSync(path.join(bundleRoot, "run"), { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, ".env.example"), "PORT=9300\n", "utf8");
  fs.writeFileSync(
    path.join(bundleRoot, "manifest.json"),
    `${JSON.stringify({
      pluginApiVersion: options.pluginApiVersion ?? 1,
      id: pluginId,
      name: "Cloud Plugin",
      ...(options.kind ? { kind: options.kind } : {}),
      version: "1.0.0",
      description: "Cloud plugin",
      service: {
        ui: "none",
        web: { healthPath: "", portEnvKey: "PORT", defaultPort: 9300 }
      },
      lifecycle: { start: "start.sh", stop: "stop.sh" },
      ...(options.platform ? { platform: options.platform } : {}),
      runtime: {
        pidRelativePath: "run/cloud-plugin.pid",
        logRelativePath: "run/cloud-plugin.log",
        requiredPaths: options.requiredPaths ?? ["manifest.json", "start.sh", "stop.sh", ".env.example", "run"]
      }
    }, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(path.join(bundleRoot, "start.sh"), "#!/usr/bin/env bash\necho start\n", "utf8");
  fs.writeFileSync(path.join(bundleRoot, "stop.sh"), "#!/usr/bin/env bash\necho stop\n", "utf8");
  writeZipArchive(fixtureRoot, archivePath, pluginId);
  return archivePath;
}

function writeSkillArchive(root, options = {}) {
  const skillId = options.id ?? "cloud-skill";
  const fixtureRoot = path.join(root, `fixture-${skillId}`);
  const skillRoot = path.join(fixtureRoot, skillId);
  const archivePath = path.join(root, `${skillId}.zip`);
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, "SKILL.md"), "# Cloud Skill\n", "utf8");
  fs.writeFileSync(
    path.join(skillRoot, "skill.json"),
    `${JSON.stringify({
      id: skillId,
      name: "Cloud Skill",
      version: "1.0.0",
      description: "Cloud skill",
      tags: ["cloud"]
    }, null, 2)}\n`,
    "utf8"
  );
  writeZipArchive(fixtureRoot, archivePath, skillId);
  return archivePath;
}

function writeAgentArchive(root, options = {}) {
  const packageName = options.packageName ?? "desktopassistant";
  const agentKey = options.agentKey ?? "desktopAssistant";
  const fixtureRoot = path.join(root, `fixture-agent-${packageName}`);
  const agentRoot = path.join(fixtureRoot, packageName);
  const archivePath = path.join(root, `${packageName}.zip`);
  fs.mkdirSync(agentRoot, { recursive: true });
  fs.writeFileSync(path.join(agentRoot, "agent.yml"), `key: ${agentKey}\nname: Desktop Assistant\n`, "utf8");
  fs.writeFileSync(path.join(agentRoot, "SOUL.md"), "# Soul\n", "utf8");
  fs.writeFileSync(path.join(agentRoot, "AGENTS.md"), "# Instructions\n", "utf8");
  writeZipArchive(fixtureRoot, archivePath, packageName);
  return archivePath;
}

function writeRootSkillArchive(root, options = {}) {
  const skillId = options.id ?? "root-skill";
  const fixtureRoot = path.join(root, `fixture-${skillId}`);
  const archivePath = path.join(root, `${skillId}.zip`);
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, "SKILL.md"), `# ${skillId}\n\nRoot skill.\n`, "utf8");
  writeZipArchive(fixtureRoot, archivePath, "SKILL.md");
  return archivePath;
}

async function writePetArchive(root, options = {}) {
  const petId = options.id ?? "cloud-pet";
  const archivePath = path.join(root, `${petId}.zip`);
  const zip = new JSZip();
  const states = {
    idle: { path: "idle.webp", frameCount: 4, durationMs: 6000, loop: true },
    jumping: { path: "jumping.webp", frameCount: 4, durationMs: 1000, loop: false },
    "moving-left": {
      path: "moving-left.webp",
      frameCount: 8,
      durationMs: 900,
      loop: true,
      mirror: true
    },
    dragging: { path: "dragging.webp", frameCount: 4, durationMs: 900, loop: true },
    done: { path: "done.webp", frameCount: 6, durationMs: 1200, loop: false, holdMs: 2500 },
    failed: { path: "failed.webp", frameCount: 4, durationMs: 1000, loop: false, holdMs: 3000 },
    running: { path: "running.webp", frameCount: 8, durationMs: 1600, loop: true },
    awaiting: { path: "awaiting.webp", frameCount: 4, durationMs: 1200, loop: true },
    review: { path: "review.webp", frameCount: 4, durationMs: 1400, loop: true }
  };
  zip.file(
    `${petId}/pet.json`,
    `${JSON.stringify({
      id: petId,
      displayName: options.displayName ?? "Cloud Pet",
      version: options.version ?? "1.0.0",
      description: "Cloud desktop pet",
      preview: "idle.webp",
      states
    }, null, 2)}\n`,
  );
  for (const asset of [
    "idle.webp",
    "jumping.webp",
    "moving-left.webp",
    "dragging.webp",
    "done.webp",
    "failed.webp",
    "running.webp",
    "awaiting.webp",
    "review.webp"
  ]) {
    zip.file(`${petId}/${asset}`, "fake webp");
  }
  fs.writeFileSync(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
  return archivePath;
}

async function writeWebappArchive(root, options = {}) {
  const key = options.key ?? "cloud-webapp";
  const id = options.id ?? webappId(key);
  const archivePath = path.join(root, `${id}.zip`);
  const zip = new JSZip();
  zip.file(
    `${id}/webapp.json`,
    `${JSON.stringify({
      schemaVersion: 2,
      id,
      key,
      label: options.label ?? "Cloud WebApp",
      version: options.version ?? "1.0.0",
      target: "any",
      appConfig: {},
      frontend: {
        root: "frontend",
        index: "index.html",
        routeConfig: { backendPrefixes: [] }
      },
      desktopBridge: { version: 1 }
    }, null, 2)}\n`
  );
  zip.file(`${id}/frontend/index.html`, "<!doctype html><div id=\"app\">cloud webapp</div>");
  fs.writeFileSync(archivePath, await zip.generateAsync({ type: "nodebuffer" }));
  return archivePath;
}

async function writeSoftwarePackageArchive(root, options = {}) {
  const packageId = options.id ?? "python-test";
  const archivePath = path.join(root, `${packageId}.zip`);
  const zip = new JSZip();
  zip.file(`${packageId}/bin/python`, options.content ?? "python executable\n", {
    unixPermissions: 0o100755
  });
  zip.file(`${packageId}/README.txt`, "test software package\n");
  fs.writeFileSync(archivePath, await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" }));
  return archivePath;
}

function writeFakeContainerEngine(binDir, name, script) {
  fs.mkdirSync(binDir, { recursive: true });
  if (process.platform === "win32") {
    const runnerName = `fake-${name}-engine.cjs`;
    const runnerPath = path.join(binDir, runnerName);
    const enginePath = path.join(binDir, `${name}.cmd`);
    fs.writeFileSync(
      runnerPath,
      `const fs = require("node:fs");
const script = ${JSON.stringify(script)};
const args = process.argv.slice(2);

function decodePrintf(value) {
  return value.replace(/\\\\t/g, "\\t").replace(/\\\\n/g, "\\n");
}

function appendLogIfNeeded() {
  const match = />>\\s+"([^"]+)"/u.exec(script);
  if (match) {
    fs.appendFileSync(match[1], args.join(" ") + "\\n", "utf8");
  }
}

function imageCommandBlock(command) {
  const marker = 'if [ "$1" = "image" ] && [ "$2" = "' + command + '" ]; then';
  const start = script.indexOf(marker);
  if (start < 0) {
    return "";
  }
  const rest = script.slice(start + marker.length);
  const end = rest.indexOf("\\nfi");
  return end >= 0 ? rest.slice(0, end) : rest;
}

async function main() {
  appendLogIfNeeded();
  if (/^#!\\/bin\\/sh\\s+set -eu\\s+exit 1\\s*$/u.test(script.trim())) {
    process.exit(1);
  }
  if (args[0] === "version") {
    const match = /if \\[ "\\$1" = "version" \\]; then\\s+exit ([0-9]+)/u.exec(script);
    process.exit(match ? Number(match[1]) : 2);
  }
  if (args[0] === "image" && args[1] === "ls") {
    const match = /printf '([^']*)'/u.exec(imageCommandBlock("ls"));
    if (match) {
      process.stdout.write(decodePrintf(match[1]));
      process.exit(0);
    }
  }
  if (args[0] === "image" && args[1] === "load") {
    const block = imageCommandBlock("load");
    if (/Loading layer 1\\/2/u.test(block)) {
      process.stderr.write("Loading layer 1/2\\n");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const match = /Loaded image: ([^\\\\']+)/u.exec(block);
    if (match) {
      process.stdout.write("Loaded image: " + match[1] + "\\n");
      process.exit(0);
    }
  }
  if (args[0] === "image" && args[1] === "rm") {
    const match = /Untagged: ([^\\\\']+)/u.exec(imageCommandBlock("rm"));
    if (match) {
      process.stdout.write("Untagged: " + match[1] + "\\n");
      process.exit(0);
    }
  }
  if (args[0] === "image" && args[1] === "save") {
    if (/fake image archive/u.test(imageCommandBlock("save"))) {
      fs.writeFileSync(args[3], "fake image archive", "utf8");
      process.exit(0);
    }
  }
  process.stderr.write("unexpected " + ${JSON.stringify(name)} + " command: " + args.join(" ") + "\\n");
  process.exit(2);
}

main().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error) + "\\n");
  process.exit(1);
});
`,
      "utf8"
    );
    fs.writeFileSync(enginePath, `@echo off\r\n"${process.execPath}" "%~dp0${runnerName}" %*\r\n`, "utf8");
    return enginePath;
  }
  const enginePath = path.join(binDir, name);
  fs.writeFileSync(enginePath, script, "utf8");
  fs.chmodSync(enginePath, 0o755);
  return enginePath;
}

function writeFakePackageManager(binDir, name, logPath) {
  fs.mkdirSync(binDir, { recursive: true });
  const runnerPath = path.join(binDir, "fake-package-manager.cjs");
  if (!fs.existsSync(runnerPath)) {
    fs.writeFileSync(
      runnerPath,
      `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, args.join(" ") + "\\n", "utf8");
if (args.some((arg) => /(?:docx|pdf|pptx|xlsx)-manipulation/.test(arg))) {
  process.exit(7);
}
let skillId = "";
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--skill") {
    skillId = args[index + 1] || "";
    break;
  }
  if (arg.startsWith("--skill=")) {
    skillId = arg.slice("--skill=".length);
    break;
  }
}
if (!skillId) {
  process.exit(8);
}
const home = process.env.USERPROFILE || process.env.HOME;
const target = path.join(home, ".codex", "skills", skillId);
fs.mkdirSync(target, { recursive: true });
fs.writeFileSync(path.join(target, "SKILL.md"), "# " + skillId + "\\n", "utf8");
fs.writeFileSync(path.join(target, "skill.json"), JSON.stringify({
  id: skillId,
  name: skillId.toUpperCase(),
  version: "1.0.0",
  description: "Fake downloaded skill",
  tags: ["cloud"]
}) + "\\n", "utf8");
`,
      "utf8"
    );
  }

  const executablePath = path.join(binDir, process.platform === "win32" ? `${name}.cmd` : name);
  const script = process.platform === "win32"
    ? `@echo off\r\nnode "%~dp0fake-package-manager.cjs" %*\r\n`
    : `#!/bin/sh\nexec node "$(dirname "$0")/fake-package-manager.cjs" "$@"\n`;
  fs.writeFileSync(executablePath, script, "utf8");
  fs.chmodSync(executablePath, 0o755);
  return executablePath;
}

async function withPathPrefix(prefix, fn) {
  const previousPath = process.env.PATH;
  const previousContainerEnginePaths = process.env.DESKTOP_CONTAINER_ENGINE_PATHS;
  process.env.PATH = `${prefix}${path.delimiter}${previousPath ?? ""}`;
  process.env.DESKTOP_CONTAINER_ENGINE_PATHS = prefix;
  try {
    return await fn();
  } finally {
    process.env.PATH = previousPath;
    if (previousContainerEnginePaths === undefined) {
      delete process.env.DESKTOP_CONTAINER_ENGINE_PATHS;
    } else {
      process.env.DESKTOP_CONTAINER_ENGINE_PATHS = previousContainerEnginePaths;
    }
  }
}

async function withEnvPatch(patch, fn) {
  const previous = new Map();
  for (const key of Object.keys(patch)) {
    previous.set(key, process.env[key]);
    const value = patch[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function withFixtureServer(files, fn) {
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const requestPath = requestUrl.pathname;
    const file = files.get(`${requestPath}${requestUrl.search}`) ?? files.get(requestPath);
    if (!file) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    if (typeof file === "function") {
      file(req, res, requestUrl);
      return;
    }
    if (typeof file === "string") {
      res.setHeader("content-type", "application/json");
      res.end(file);
      return;
    }
    res.end(file);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("DEFAULT_MARKETPLACE_CATALOG_URL is empty until env config provides a market API", () => {
  assert.equal(DEFAULT_MARKETPLACE_CATALOG_URL, "");
});

test("normalizeCatalog keeps all public market types including software packages", () => {
  const catalog = __testInternals.normalizeCatalog({
    schemaVersion: 1,
    items: [
      {
        id: "agent-demo",
        type: "agent",
        name: "Agent Demo",
        version: "1.0.0",
        assets: {
          universal: {
            url: "https://example.com/agent.zip",
            sizeBytes: 1,
            archiveType: "agent"
          }
        }
      },
      {
        id: "cli-demo",
        type: "cli-tool",
        name: "CLI Demo",
        version: "1.0.0",
        assets: {
          universal: {
            url: "https://example.com/cli.zip",
            sizeBytes: 1,
            archiveType: "cli"
          }
        }
      },
      {
        id: "webapp-demo",
        type: "website-app",
        name: "WebApp Demo",
        version: "1.0.0",
        assets: {
          universal: {
            url: "https://example.com/webapp.zip",
            sizeBytes: 1,
            archiveType: "website-app"
          }
        }
      },
      {
        id: "python-demo",
        type: "software-package",
        name: "Python Demo",
        version: "3.14.6",
        assets: {
          universal: {
            url: "https://example.com/python.zip",
            sizeBytes: 1,
            archiveType: "zip"
          }
        }
      },
      {
        id: "search-mcp",
        type: "mcp",
        name: "Search MCP",
        version: "1.0.0",
        assets: {
          universal: {
            url: "https://example.com/search.mcp.json",
            sizeBytes: 1,
            archiveType: "json"
          }
        }
      }
    ]
  });

  assert.deepEqual(catalog.items.map((item) => [item.id, item.type]), [
    ["agent-demo", "agent"],
    ["cli-demo", "cli"],
    ["webapp-demo", "website-app"],
    ["python-demo", "software-package"],
    ["search-mcp", "mcp"]
  ]);
});

test("installMarketItem writes and removes MCP YAML through the runtime registry directory", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-mcp-install-"));
  const app = createApp(root);
  fs.mkdirSync(path.join(root, "temp"), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await withFixtureServer(new Map([
    ["/api/v1/auth/me", JSON.stringify({ user: { id: "market-user" } })],
    ["/api/v1/desktop/catalog", JSON.stringify({
      schemaVersion: 1,
      items: [{
        id: "remote-search",
        type: "mcp",
        name: "Remote Search",
        version: "1.0.0",
        description: "Search tools",
        tags: ["search"],
        assets: {}
      }]
    })],
    ["/api/v1/mcps/remote-search/download", JSON.stringify({
      market: {
        id: "remote-search",
        name: "Remote Search",
        version: "1.0.0",
        tools: ["search"]
      },
      mcpServers: {
        "remote-search": {
          type: "streamable-http",
          url: "https://mcp.example.test/mcp"
        }
      }
    })]
  ]), async (baseUrl) => {
    const options = {
      apiBaseUrl: `${baseUrl}/api/v1`,
      marketEnabled: true,
      issueMarketAccessToken: () => "market-access-token"
    };
    const listed = await listMarketItems(app, { ...options, sections: ["mcps"] });
    assert.equal(listed.items.find((item) => item.id === "remote-search")?.type, "mcp");

    const installed = await installMarketItem(app, "remote-search", options);
    assert.equal(installed.ok, true);
    assert.equal(installed.type, "mcp");
    assert.equal(installed.installPath, "registries/mcp-servers/remote-search.yml");
    const registryFile = path.join(resolveRuntimeRoot(app), "registries", "mcp-servers", "remote-search.yml");
    const registryContent = fs.readFileSync(registryFile, "utf8");
    const registry = loadYaml(registryContent);
    assert.equal(registry.serverKey, "remote-search");
    assert.equal(registry.transport, "streamable-http");
    assert.equal(registry.baseUrl, "https://mcp.example.test");
    assert.equal(registry.endpointPath, "/mcp");
    assert.equal(Object.hasOwn(registry, "tools"), false);

    const removed = await uninstallMarketItem(app, "remote-search", options);
    assert.equal(removed.ok, true);
    assert.equal(fs.existsSync(registryFile), false);
    assert.equal(__testInternals.readInstalledRecords(app).some((item) => item.type === "mcp"), false);

    const manualContent = "serverKey: manual\ntransport: streamable-http\nbaseUrl: https://manual.example.test\n";
    fs.writeFileSync(registryFile, manualContent, "utf8");
    await assert.rejects(
      () => installMarketItem(app, "remote-search", options),
      (error) => error instanceof Error && /MCP/u.test(error.message)
    );
    assert.equal(fs.readFileSync(registryFile, "utf8"), manualContent);
  });
});

test("normalizeCatalog keeps server assets for display while selectAsset only chooses installable assets", () => {
  const legacyAsset = {
    url: "https://example.test/archive.tar.gz",
    sizeBytes: 1,
    archiveType: "tar.gz"
  };
  const catalog = __testInternals.normalizeCatalog({
    schemaVersion: 1,
    items: [
      { id: "plugin-tar", type: "plugin", name: "Plugin", version: "1.0.0", assets: { universal: legacyAsset } },
      { id: "skill-tar", type: "skill", name: "Skill", version: "1.0.0", assets: { universal: legacyAsset } },
      { id: "pet-tar", type: "pet", name: "Pet", version: "1.0.0", assets: { universal: legacyAsset } },
      { id: "cli-tar", type: "cli", name: "CLI", version: "1.0.0", assets: { universal: legacyAsset } },
      { id: "webapp-tar", type: "website-app", name: "WebApp", version: "1.0.0", assets: { universal: legacyAsset } },
      {
        id: "webapp-zip",
        type: "website-app",
        name: "WebApp Zip",
        version: "1.0.0",
        assets: {
          universal: {
            url: "https://example.test/webapp.zip",
            sizeBytes: 1,
            archiveType: "website-app"
          }
        }
      },
      {
        id: "template-tar",
        type: "sandbox-image",
        sandboxKind: "environment-template",
        name: "Template",
        version: "1.0.0",
        assets: { universal: legacyAsset }
      },
      {
        id: "container-tar",
        type: "sandbox-image",
        sandboxKind: "container-image",
        name: "Container",
        version: "1.0.0",
        assets: { universal: legacyAsset }
      }
    ]
  });
  const byId = new Map(catalog.items.map((item) => [item.id, item]));

  for (const id of ["plugin-tar", "skill-tar", "pet-tar", "cli-tar", "webapp-tar", "template-tar"]) {
    assert.equal(byId.get(id)?.assets.universal?.archiveType, "tar.gz");
    assert.equal(__testInternals.selectAsset(byId.get(id)), null);
  }
  assert.equal(byId.get("container-tar")?.assets.universal?.archiveType, "tar.gz");
  assert.equal(__testInternals.selectAsset(byId.get("container-tar"))?.asset.archiveType, "tar.gz");
  assert.equal(__testInternals.selectAsset(byId.get("webapp-zip"))?.asset.archiveType, "website-app");
});

test("installPluginFromArchive rejects non-zip plugin packages", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-plugin-tar-reject-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await assert.rejects(
    () => installPluginFromArchive(app, path.join(root, "plugin.tar.gz")),
    /插件包仅支持 \.zip 格式。/
  );
});

test("installPluginFromArchive validates plugin API, platform, and declared bundle paths", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-plugin-contract-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const unsupportedApi = writePluginArchive(root, {
    id: "unsupported-api-plugin",
    pluginApiVersion: 2
  });
  await assert.rejects(
    () => installPluginFromArchive(app, unsupportedApi),
    /pluginApiVersion 2/u
  );

  const incompatibleOs = process.platform === "win32" ? "darwin" : "windows";
  const incompatiblePlatform = writePluginArchive(root, {
    id: "incompatible-platform-plugin",
    platform: { os: incompatibleOs, arch: process.arch === "x64" ? "amd64" : process.arch }
  });
  await assert.rejects(
    () => installPluginFromArchive(app, incompatiblePlatform),
    /目标平台|targets/u
  );

  const missingRuntime = writePluginArchive(root, {
    id: "missing-runtime-plugin",
    requiredPaths: ["manifest.json", "bin/missing"]
  });
  await assert.rejects(
    () => installPluginFromArchive(app, missingRuntime),
    /bin\/missing/u
  );
});

test("installSkillFromPath rejects non-zip skill archives but accepts SKILL.md", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-skill-local-format-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const unrelatedSkillMarketFile = path.join(root, "home", ".cutej", "skills-market", "keep.txt");
  fs.mkdirSync(path.dirname(unrelatedSkillMarketFile), { recursive: true });
  fs.writeFileSync(unrelatedSkillMarketFile, "keep\n", "utf8");

  for (const extension of [".tar.gz", ".tgz", ".skill"]) {
    const archivePath = path.join(root, `local-skill${extension}`);
    fs.writeFileSync(archivePath, "not a supported local skill package\n", "utf8");
    await assert.rejects(
      () => installSkillFromPath(app, archivePath),
      /Skill 包仅支持 \.zip 或 SKILL\.md 文件。/
    );
  }

  const skillFilePath = path.join(root, "Local Skill.md");
  fs.writeFileSync(skillFilePath, "# Local Skill\n", "utf8");
  const result = await installSkillFromPath(app, skillFilePath);

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(getSkillInstallDir(app, "local-skill"), "SKILL.md")), true);
  assert.equal(fs.readFileSync(unrelatedSkillMarketFile, "utf8"), "keep\n");
});

test("refreshMarketCatalog combines catalog plugins with catalog skills", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-list-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const catalog = JSON.stringify({
    schemaVersion: 1,
    items: [
      {
        id: "remote-skill",
        type: "skill",
        name: "Remote Skill",
        version: "1.0.0",
        description: "Remote skill",
        tags: ["remote"],
        assets: {
          universal: {
            url: "https://assets.example.test/remote-skill.zip",
            sha256: "",
            sizeBytes: 0,
            archiveType: "zip"
          }
        }
      },
      {
        id: "remote-plugin",
        type: "plugin",
        name: "Remote Plugin",
        version: "1.0.0",
        description: "Remote plugin",
        tags: [],
        assets: {}
      }
    ]
  });
  const files = new Map([["/marketplace/index.json", catalog]]);
  await withFixtureServer(files, async (catalogBaseUrl) => {
    const catalogUrl = `${catalogBaseUrl}/marketplace/index.json`;
    const refreshed = await refreshMarketCatalog(app, { catalogUrl, sections: ["plugins", "skills"] });
    const listed = await listMarketItems(app, { catalogUrl, sections: ["plugins", "skills"] });

    assert.equal(refreshed.ok, true);
    assert.equal(listed.ok, true);
    assert.equal(listed.items.find((item) => item.id === "remote-skill")?.type, "skill");
    assert.equal(listed.items.find((item) => item.id === "remote-skill")?.state, "not-installed");
    assert.equal(listed.items.find((item) => item.id === "remote-plugin")?.type, "plugin");
    assert.equal(fs.existsSync(path.join(getMarketplaceCacheRoot(app), "catalog-cache.json")), false);
  });
});

test("listMarketItems reads skill entries from the catalog", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-pages-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = await listMarketItems(app, {
    catalog: {
      schemaVersion: 1,
      items: [
        {
          id: "first-skill",
          type: "skill",
          name: "First Skill",
          version: "1.0.0",
          description: "First",
          tags: [],
          assets: {}
        },
        {
          id: "second-skill",
          type: "skill",
          name: "Second Skill",
          version: "1.0.0",
          description: "Second",
          tags: [],
          assets: {}
        }
      ]
    },
    sections: ["skills"]
  });

  assert.equal(result.items.filter((item) => item.type === "skill").length, 2);
  assert.ok(result.items.some((item) => item.id === "first-skill"));
  assert.ok(result.items.some((item) => item.id === "second-skill"));
});

test("catalog skills remain visible as cloud updates when the same skill was imported locally", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-skill-cloud-local-"));
  const app = createApp(root);
  const installPath = getSkillInstallDir(app, "office-xlsx");
  fs.mkdirSync(installPath, { recursive: true });
  fs.writeFileSync(path.join(installPath, "SKILL.md"), "# Office XLSX\n", "utf8");
  fs.writeFileSync(path.join(installPath, "skill.json"), `${JSON.stringify({
    id: "office-xlsx",
    name: "Local Office XLSX",
    version: "0.0.0"
  })}\n`, "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = await listMarketItems(app, {
    sections: ["skills"],
    catalog: {
      schemaVersion: 1,
      items: [{
        id: "office-xlsx",
        type: "skill",
        name: "Office Excel 技能包",
        version: "0.0.1",
        description: "Cloud version",
        tags: ["office"],
        assets: {
          universal: {
            url: "https://market.example.test/office-xlsx.zip",
            sizeBytes: 1,
            archiveType: "zip"
          }
        }
      }]
    }
  });
  const item = result.items.find((entry) => entry.type === "skill" && entry.id === "office-xlsx");

  assert.equal(item?.name, "Office Excel 技能包");
  assert.equal(item?.version, "0.0.1");
  assert.equal(item?.installedVersion, "0.0.0");
  assert.equal(item?.state, "update-available");
  assert.equal(item?.source, "local");
  assert.equal(item?.marketplaceAvailable, true);
});

test("semantic version comparison marks only valid newer releases as updates", () => {
  const compareVersions = __testInternals.compareVersions;

  assert.equal(compareVersions("1.2.0", "1.1.9"), 1);
  assert.equal(compareVersions("1.0.0-beta.11", "1.0.0-beta.2"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("1.0.0+build.2", "1.0.0+build.1"), 0);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0-01", "1.0.0"), 0);
});

test("listMarketItems reports an offline market when no market API is configured", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-command-only-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = await listMarketItems(app, { sections: ["skills"] });

  assert.equal(result.ok, true);
  assert.equal(result.offline, true);
  assert.equal(result.sourceUrl, "");
  assert.equal(result.items.length, 0);
});

test("listMarketItems reports marketplace status for selected catalog sections", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-section-status-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await withFixtureServer(new Map([
    ["/marketplace/index.json", (_req, res) => {
      res.statusCode = 403;
      res.end("forbidden");
    }]
  ]), async (baseUrl) => {
    const result = await listMarketItems(app, {
      catalogUrl: `${baseUrl}/marketplace/index.json`,
      sections: ["plugins", "skills"]
    });

    assert.equal(result.offline, true);
    assert.equal(result.pluginOffline, true);
    assert.match(result.pluginMessage, /403/);
    assert.equal(result.skillOffline, true);
    assert.match(result.skillMessage, /403/);
    assert.equal(result.items.some((item) => item.type === "skill"), false);
  });
});

test("listMarketItems can load plugin and skill sections without sandbox probing", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-section-filter-"));
  const app = createApp(root);
  const isolatedPath = path.join(root, "empty-path");
  const missingProgramFiles = path.join(root, "missing-program-files");
  const missingLocalAppData = path.join(root, "missing-local-app-data");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(isolatedPath, { recursive: true });

  await withEnvPatch({
    PATH: isolatedPath,
    ProgramFiles: missingProgramFiles,
    LOCALAPPDATA: missingLocalAppData,
    DESKTOP_CONTAINER_ENGINE_PATHS: isolatedPath
  }, async () => {
    const catalog = {
      schemaVersion: 1,
      items: [
        {
          id: "visible-plugin",
          type: "plugin",
          name: "Visible Plugin",
          version: "1.0.0",
          description: "Visible",
          tags: [],
          assets: {}
        },
        {
          id: "visible-skill",
          type: "skill",
          name: "Visible Skill",
          version: "1.0.0",
          description: "Visible",
          tags: [],
          assets: {}
        }
      ]
    };

    const pluginOnly = await listMarketItems(app, {
      catalog,
      sections: ["plugins"]
    });
    assert.equal(pluginOnly.ok, true);
    assert.equal(pluginOnly.sandboxOffline, false);
    assert.equal(pluginOnly.sandboxMessage, "");
    assert.deepEqual(pluginOnly.items.map((item) => item.type), ["plugin"]);
    assert.equal(pluginOnly.items[0]?.id, "visible-plugin");

    const skillOnly = await listMarketItems(app, {
      catalog,
      sections: ["skills"]
    });
    assert.equal(skillOnly.ok, true);
    assert.equal(skillOnly.sandboxOffline, false);
    assert.equal(skillOnly.sandboxMessage, "");
    assert.deepEqual(skillOnly.items.map((item) => item.type), ["skill"]);
    assert.equal(skillOnly.items[0]?.id, "visible-skill");
  });
});

test("listMarketItems resolves sandbox images when Docker is outside the inherited Desktop PATH", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-sandbox-desktop-path-"));
  const app = createApp(root);
  const inheritedPathDir = path.join(root, "desktop-path");
  const enginePathDir = path.join(root, "docker-app-bin");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(inheritedPathDir, { recursive: true });
  writeFakeContainerEngine(enginePathDir, "docker", `#!/bin/sh
set -eu
if [ "$1" = "version" ]; then
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "ls" ]; then
  printf 'sha256:desktop123\\tdaily-office\\tlatest\\t3.06GB\\t2026-05-22 10:00:00 +0800 CST\\n'
  exit 0
fi
echo "unexpected docker command: $*" >&2
exit 2
`);

  await withEnvPatch({
    PATH: inheritedPathDir,
    DESKTOP_CONTAINER_ENGINE_PATHS: enginePathDir
  }, async () => {
    const result = await listMarketItems(app, {
      catalog: { schemaVersion: 1, items: [] },
      sections: ["sandboxImages"]
    });
    const image = result.items.find((item) =>
      item.type === "sandbox-image" && item.id === "daily-office:latest"
    );

    assert.equal(result.sandboxOffline, false);
    assert.equal(result.sandboxMessage, "");
    assert.equal(image?.containerEngine, "docker");
    assert.equal(image?.imageRef, "daily-office:latest");
    assert.equal(image?.imageSize, "3.06GB");
  });
});

test("listMarketItems maps Container Hub environments into sandbox image market items", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-sandbox-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await withFixtureServer(new Map([
    ["/api/environments", JSON.stringify([
      {
        name: "daily-office",
        description: "Office automation sandbox",
        image_repository: "registry.example.com/agent-container-hub/daily-office",
        image_tag: "2026.05",
        image_ref: "registry.example.com/agent-container-hub/daily-office:2026.05",
        available: true,
        enabled: true,
        available_build_targets: ["image", "smoke"],
        last_build: {
          id: "build-1",
          environment_name: "daily-office",
          image_ref: "registry.example.com/agent-container-hub/daily-office:2026.05",
          target: "image",
          status: "succeeded"
        }
      }
    ])]
  ]), async (baseUrl) => {
    const result = await listMarketItems(app, {
      catalog: { schemaVersion: 1, items: [] },
      containerHubBaseUrl: baseUrl,
      sections: ["sandboxImages"]
    });
    const image = result.items.find((item) => item.type === "sandbox-image" && item.id === "daily-office");

    assert.equal(result.sandboxOffline, false);
    assert.equal(image?.name, "daily-office");
    assert.equal(image?.state, "installed");
    assert.equal(image?.imageRef, "registry.example.com/agent-container-hub/daily-office:2026.05");
    assert.equal(image?.buildStatus, "succeeded");
    assert.equal(image?.buildTargetCount, 2);
  });
});

test("listMarketItems hides unavailable Container Hub environments from sandbox image market items", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-sandbox-missing-envs-"));
  const app = createApp(root);
  const binDir = path.join(root, "bin");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeFakeContainerEngine(binDir, "docker", `#!/bin/sh
set -eu
exit 1
`);
  writeFakeContainerEngine(binDir, "podman", `#!/bin/sh
set -eu
exit 1
`);

  await withPathPrefix(binDir, async () => {
    await withFixtureServer(new Map([
      ["/api/environments", JSON.stringify([
        {
          name: "daily-office",
          description: "Office automation sandbox",
          image_repository: "daily-office",
          image_tag: "latest",
          image_ref: "daily-office:latest",
          available: false,
          enabled: true,
          available_build_targets: ["image"],
          last_build: null
        },
        {
          name: "toolbox",
          description: "Toolbox sandbox",
          image_repository: "toolbox",
          image_tag: "latest",
          image_ref: "toolbox:latest",
          available: false,
          enabled: true,
          available_build_targets: ["image"],
          last_build: null
        }
      ])]
    ]), async (baseUrl) => {
      const result = await listMarketItems(app, {
        catalog: { schemaVersion: 1, items: [] },
        containerHubBaseUrl: baseUrl,
        sections: ["sandboxImages"]
      });

      assert.equal(result.sandboxOffline, false);
      assert.equal(result.items.some((item) => item.type === "sandbox-image" && item.id === "daily-office"), false);
      assert.equal(result.items.some((item) => item.type === "sandbox-image" && item.id === "toolbox"), false);
    });
  });
});

test("listMarketItems lists local sandbox images from the container engine", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-sandbox-images-"));
  const app = createApp(root);
  const binDir = path.join(root, "bin");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeFakeContainerEngine(binDir, "docker", `#!/bin/sh
set -eu
if [ "$1" = "version" ]; then
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "ls" ]; then
  printf 'sha256:abc123\\tagent-container-hub\\tv0.2.0-linux-arm64\\t512MB\\t2026-05-01 12:00:00 +0800 CST\\n'
  exit 0
fi
echo "unexpected docker command: $*" >&2
exit 2
`);

  await withPathPrefix(binDir, async () => {
    const result = await listMarketItems(app, {
      catalog: { schemaVersion: 1, items: [] },
      sections: ["sandboxImages"]
    });
    const image = result.items.find((item) =>
      item.type === "sandbox-image" && item.id === "agent-container-hub:v0.2.0-linux-arm64"
    );

    assert.equal(result.sandboxOffline, false);
    assert.equal(image?.name, "agent-container-hub");
    assert.equal(image?.version, "v0.2.0-linux-arm64");
    assert.equal(image?.state, "installed");
    assert.equal(image?.source, "local");
    assert.equal(image?.imageRef, "agent-container-hub:v0.2.0-linux-arm64");
    assert.equal(image?.imageId, "sha256:abc123");
    assert.equal(image?.containerEngine, "docker");
  });
});

test("listMarketItems falls back to podman when docker is unreachable", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-sandbox-podman-"));
  const app = createApp(root);
  const binDir = path.join(root, "bin");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeFakeContainerEngine(binDir, "docker", `#!/bin/sh
set -eu
if [ "$1" = "version" ]; then
  exit 1
fi
echo "unexpected docker command: $*" >&2
exit 2
`);
  writeFakeContainerEngine(binDir, "podman", `#!/bin/sh
set -eu
if [ "$1" = "version" ]; then
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "ls" ]; then
  printf 'sha256:pod123\\tdaily-office\\t2026.05\\t1.2GB\\t2026-05-02 12:00:00 +0800 CST\\n'
  exit 0
fi
echo "unexpected podman command: $*" >&2
exit 2
`);

  await withPathPrefix(binDir, async () => {
    const result = await listMarketItems(app, {
      catalog: { schemaVersion: 1, items: [] },
      sections: ["sandboxImages"]
    });
    const image = result.items.find((item) =>
      item.type === "sandbox-image" && item.id === "daily-office:2026.05"
    );

    assert.equal(result.sandboxOffline, false);
    assert.equal(image?.containerEngine, "podman");
    assert.equal(image?.imageRef, "daily-office:2026.05");
  });
});

test("buildSandboxImage starts a Container Hub environment build job", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-sandbox-build-"));
  const app = createApp(root);
  let capturedBody = "";
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await withFixtureServer(new Map([
    ["/api/environments/daily-office/build-jobs", (req, res) => {
      assert.equal(req.method, "POST");
      req.on("data", (chunk) => {
        capturedBody += chunk;
      });
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          id: "build-2",
          environment_name: "daily-office",
          image_ref: "registry.example.com/agent-container-hub/daily-office:2026.05",
          status: "building"
        }));
      });
    }]
  ]), async (baseUrl) => {
    const result = await buildSandboxImage(app, "daily-office", { containerHubBaseUrl: baseUrl });

    assert.equal(capturedBody, "{}");
    assert.equal(result.ok, true);
    assert.equal(result.type, "sandbox-image");
    assert.equal(result.state, "installing");
    assert.equal(result.buildJobId, "build-2");
    assert.equal(result.buildStatus, "building");
    assert.equal(result.imageRef, "registry.example.com/agent-container-hub/daily-office:2026.05");
  });
});

test("importSandboxImageFromPath loads a local image archive with the container engine", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-sandbox-import-"));
  const app = createApp(root);
  const binDir = path.join(root, "bin");
  const archivePath = path.join(root, "agent-container-hub-image-v0.2.0-linux-arm64.tar.gz");
  const logPath = path.join(root, "engine.log");
  const directArchiveRoot = path.join(root, "direct-archive");
  fs.mkdirSync(directArchiveRoot, { recursive: true });
  fs.writeFileSync(path.join(directArchiveRoot, "manifest.json"), "[]\n", "utf8");
  execFileSync("tar", ["-czf", archivePath, "-C", directArchiveRoot, "manifest.json"]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeFakeContainerEngine(binDir, "docker", `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${logPath}"
if [ "$1" = "version" ]; then
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "load" ]; then
  printf 'Loaded image: agent-container-hub:v0.2.0-linux-arm64\\n'
  exit 0
fi
echo "unexpected docker command: $*" >&2
exit 2
`);

  await withPathPrefix(binDir, async () => {
    const result = await importSandboxImageFromPath(app, archivePath);

    assert.equal(result.ok, true);
    assert.equal(result.type, "sandbox-image");
    assert.equal(result.state, "installed");
    assert.equal(result.itemId, "agent-container-hub:v0.2.0-linux-arm64");
    assert.equal(result.imageRef, "agent-container-hub:v0.2.0-linux-arm64");
    assert.match(fs.readFileSync(logPath, "utf8"), new RegExp(`image load -i ${archivePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });
});

test("importSandboxImageFromPath streams progress while the container engine is still loading", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-sandbox-import-progress-"));
  const app = createApp(root);
  const binDir = path.join(root, "bin");
  const archivePath = path.join(root, "agent-container-hub-image-v0.4.0-linux-arm64.tar.gz");
  const directArchiveRoot = path.join(root, "direct-archive");
  fs.mkdirSync(directArchiveRoot, { recursive: true });
  fs.writeFileSync(path.join(directArchiveRoot, "manifest.json"), "[]\n", "utf8");
  execFileSync("tar", ["-czf", archivePath, "-C", directArchiveRoot, "manifest.json"]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeFakeContainerEngine(binDir, "docker", `#!/bin/sh
set -eu
if [ "$1" = "version" ]; then
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "load" ]; then
  printf 'Loading layer 1/2\\n' >&2
  sleep 0.1
  printf 'Loaded image: agent-container-hub:v0.4.0-linux-arm64\\n'
  exit 0
fi
echo "unexpected docker command: $*" >&2
exit 2
`);

  await withPathPrefix(binDir, async () => {
    const progressEvents = [];
    let importCompleted = false;
    let resolveEngineOutput;
    const engineOutputSeen = new Promise((resolve) => {
      resolveEngineOutput = resolve;
    });
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("timed out waiting for streaming sandbox image import progress")), 5_000);
    });

    const importPromise = importSandboxImageFromPath(app, archivePath, {
      onProgress(event) {
        progressEvents.push(event);
        if (event.stage === "output" && /Loading layer 1\/2/.test(event.message)) {
          resolveEngineOutput();
        }
      }
    }).finally(() => {
      importCompleted = true;
    });

    await Promise.race([engineOutputSeen, timeout]);
    assert.equal(importCompleted, false);

    const result = await importPromise;
    assert.equal(result.ok, true);
    assert.equal(result.imageRef, "agent-container-hub:v0.4.0-linux-arm64");
    assert.deepEqual(
      progressEvents.map((event) => event.stage),
      ["checking-engine", "archive-ready", "loading", "output", "output", "done"]
    );
  });
});

test("importSandboxImageFromPath extracts an image bundle before loading its image archive", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-sandbox-bundle-import-"));
  const app = createApp(root);
  const binDir = path.join(root, "bin");
  const bundleFixtureRoot = path.join(root, "fixture");
  const bundleRoot = path.join(bundleFixtureRoot, "agent-container-hub");
  const bundlePath = path.join(root, "agent-container-hub-image-v0.3.0-linux-arm64.tar.gz");
  const logPath = path.join(root, "engine.log");
  fs.mkdirSync(path.join(bundleRoot, "images"), { recursive: true });
  fs.writeFileSync(
    path.join(bundleRoot, "images", "agent-container-hub-image-v0.3.0-linux-arm64.tar.gz"),
    "fake bundled image archive",
    "utf8"
  );
  execFileSync("tar", ["-czf", bundlePath, "-C", bundleFixtureRoot, "agent-container-hub"]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeFakeContainerEngine(binDir, "docker", `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${logPath}"
if [ "$1" = "version" ]; then
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "load" ]; then
  printf 'Loaded image: agent-container-hub:v0.3.0-linux-arm64\\n'
  exit 0
fi
echo "unexpected docker command: $*" >&2
exit 2
`);

  await withPathPrefix(binDir, async () => {
    const result = await importSandboxImageFromPath(app, bundlePath);

    assert.equal(result.ok, true);
    assert.equal(result.imageRef, "agent-container-hub:v0.3.0-linux-arm64");
    const log = fs.readFileSync(logPath, "utf8").replace(/\\/g, "/");
    assert.match(log, /image load -i .*agent-container-hub\/images\/agent-container-hub-image-v0\.3\.0-linux-arm64\.tar\.gz/);
    assert.doesNotMatch(log, new RegExp(bundlePath.replace(/\\/g, "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

test("deleteSandboxImage removes a local image with the container engine", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-sandbox-delete-"));
  const app = createApp(root);
  const binDir = path.join(root, "bin");
  const logPath = path.join(root, "engine.log");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeFakeContainerEngine(binDir, "docker", `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${logPath}"
if [ "$1" = "version" ]; then
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "rm" ]; then
  printf 'Untagged: agent-container-hub:v0.2.0-linux-arm64\\n'
  exit 0
fi
echo "unexpected docker command: $*" >&2
exit 2
`);

  await withPathPrefix(binDir, async () => {
    const result = await deleteSandboxImage(app, "agent-container-hub:v0.2.0-linux-arm64");

    assert.equal(result.ok, true);
    assert.equal(result.type, "sandbox-image");
    assert.equal(result.state, "not-installed");
    assert.equal(result.itemId, "agent-container-hub:v0.2.0-linux-arm64");
    assert.equal(result.imageRef, "agent-container-hub:v0.2.0-linux-arm64");
    assert.match(fs.readFileSync(logPath, "utf8"), /image rm agent-container-hub:v0\.2\.0-linux-arm64/);
  });
});

test("exportSandboxImageToPath saves a local image archive with the container engine", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-sandbox-export-"));
  const app = createApp(root);
  const binDir = path.join(root, "bin");
  const exportPath = path.join(root, "agent-container-hub-v0.2.0-linux-arm64.tar");
  const logPath = path.join(root, "engine.log");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeFakeContainerEngine(binDir, "docker", `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${logPath}"
if [ "$1" = "version" ]; then
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "save" ]; then
  printf 'fake image archive' > "$4"
  exit 0
fi
echo "unexpected docker command: $*" >&2
exit 2
`);

  await withPathPrefix(binDir, async () => {
    const result = await exportSandboxImageToPath(
      app,
      "agent-container-hub:v0.2.0-linux-arm64",
      exportPath
    );

    assert.equal(result.ok, true);
    assert.equal(result.type, "sandbox-image");
    assert.equal(result.state, "installed");
    assert.equal(result.itemId, "agent-container-hub:v0.2.0-linux-arm64");
    assert.equal(result.imageRef, "agent-container-hub:v0.2.0-linux-arm64");
    assert.equal(fs.readFileSync(exportPath, "utf8"), "fake image archive");
    assert.match(
      fs.readFileSync(logPath, "utf8"),
      new RegExp(`image save -o ${exportPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} agent-container-hub:v0\\.2\\.0-linux-arm64`)
    );
  });
});

test("listMarketItems reports remote catalog failures without reading cached catalog", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-no-cache-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cachePath = path.join(getMarketplaceCacheRoot(app), "catalog-cache.json");
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, `${JSON.stringify({
    schemaVersion: 1,
    items: [
      {
        id: "cached-plugin",
        type: "plugin",
        name: "Cached Plugin",
        version: "1.0.0",
        description: "Cached plugin",
        tags: [],
        assets: {}
      }
    ]
  }, null, 2)}\n`, "utf8");

  await withFixtureServer(new Map([
    ["/marketplace/index.json", (_req, res) => {
      res.statusCode = 504;
      res.end("gateway timeout");
    }]
  ]), async (baseUrl) => {
    const result = await listMarketItems(app, {
      catalogUrl: `${baseUrl}/marketplace/index.json`,
      sections: ["plugins"]
    });
    assert.equal(result.ok, true);
    assert.equal(result.offline, true);
    assert.equal(result.items.some((item) => item.id === "cached-plugin"), false);
    assert.deepEqual(result.items.filter((item) => item.source === "cloud"), []);
    assert.match(result.message, /(?:Market is unavailable:|市场暂不可用：)market catalog request failed: 504/);
  });
});

test("listMarketItems exposes pet and cli catalog sections", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-five-types-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const catalog = {
    schemaVersion: 1,
    items: [
      {
        id: "desk-cat",
        type: "pet",
        name: "Desk Cat",
        version: "1.0.0",
        description: "A polished desktop pet.",
        tags: ["pet"],
        metadata: {
          previewUrl: "https://assets.example.test/desk-cat.png"
        },
        assets: {
          universal: {
            url: "https://assets.example.test/desk-cat.zip",
            sha256: "",
            sizeBytes: 0,
            archiveType: "zip"
          }
        }
      },
      {
        id: "zenmind-cli",
        type: "cli-tool",
        name: "ZenMind CLI",
        version: "2.0.0",
        description: "Command line companion.",
        tags: ["cli"],
        install: {
          command: "curl -fsSL https://cli.example.test/install.sh | sh"
        },
        uninstall: {
          scriptUrl: "https://cli.example.test/uninstall.sh"
        },
        assets: {}
      }
    ]
  };

  const result = await listMarketItems(app, {
    catalog,
    sections: ["pets", "cli"]
  });
  const pet = result.items.find((item) => item.id === "desk-cat");
  const cli = result.items.find((item) => item.id === "zenmind-cli");
  assert.equal(pet?.type, "pet");
  assert.equal(pet?.petPreviewUrl, "https://assets.example.test/desk-cat.png");
  assert.equal(cli?.type, "cli");
  assert.match(cli?.cliInstallCommand ?? "", /install\.sh/);
  assert.match(cli?.cliUninstallCommand ?? "", /uninstall\.sh/);
});

test("listMarketItems maps the desktop market server catalog shape into visible components", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-desktop-catalog-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const catalog = {
    schemaVersion: 1,
    generatedAt: "2026-06-15T00:00:00.000Z",
    items: [
      {
        id: "desktopassistant",
        type: "agent",
        name: "桌面助手",
        version: "1.0.0",
        description: "Desktop assistant.",
        readme: "Agent readme",
        tags: ["agent", "assistant"],
        author: "Lin Market",
        createdAt: "2026-06-13T00:00:00.000Z",
        downloadCount: 1200,
        favoriteCount: 34,
        favorited: true,
        assets: {
          universal: {
            url: "https://market.example.test/artifacts/agent/desktopassistant.tar.gz",
            sha256: "agent-sha",
            integrity: "sha512-agent",
            sizeBytes: 4387,
            archiveType: "agent",
            platform: "universal",
            role: "primary"
          }
        },
        platforms: {
          "darwin-arm64": {
            os: "darwin",
            arch: "arm64",
            description: "Apple Silicon build",
            minDesktopVersion: "0.3.0"
          },
          "windows-x64": {
            platform: "windows-x64",
            os: "windows",
            arch: "x64"
          }
        },
        dependencies: [{
          kind: "skill",
          phase: "runtime",
          required: true,
          id: "desktop-action",
          displayName: "desktop-action"
        }],
        metadata: {
          agentKey: "desktopAssistant",
          source: "zenmind-env/agents"
        },
        publishedAt: "2026-06-14T00:00:00.000Z",
        updatedAt: "2026-06-15T00:00:00.000Z"
      },
      {
        id: "dbx",
        type: "cli-tool",
        name: "dbx CLI",
        version: "1.0.0",
        description: "Database CLI.",
        tags: ["cli-tool", "dependency"],
        assets: {},
        dependencies: [],
        metadata: {
          source: "metadata-only",
          author: "Metadata CLI",
          createdAt: "2026-06-12T00:00:00.000Z",
          downloads: "2,345",
          favorites: "56"
        },
        install: {
          command: "brew install dbx"
        },
        uninstall: {
          command: "brew uninstall dbx"
        },
        detect: {
          commands: ["dbx"],
          versionCommand: "dbx version"
        }
      },
      {
        id: "dario",
        type: "pet",
        name: "Dario",
        version: "1.0.0",
        description: "Desktop pet.",
        tags: ["desktop-pet"],
        assets: {
          universal: {
            url: "https://market.example.test/artifacts/pet/dario.zip",
            sha256: "pet-sha",
            integrity: "sha512-pet",
            sizeBytes: 759705,
            archiveType: "zip",
            platform: "universal",
            role: "primary"
          }
        },
        dependencies: [],
        metadata: {
          previewUrl: "https://market.example.test/artifacts/pet/dario.png"
        }
      },
      {
        id: "activity-monitor",
        type: "plugin",
        name: "Activity Monitor",
        version: "v0.1.0",
        description: "Plugin with a tar artifact.",
        tags: ["desktop", "plugin"],
        assets: {
          "darwin-arm64": {
            url: "https://market.example.test/artifacts/plugin/activity-monitor.tar.gz",
            sha256: "plugin-sha",
            integrity: "sha512-plugin",
            sizeBytes: 2218267,
            archiveType: "tar.gz",
            platform: "darwin-arm64",
            role: "primary"
          }
        },
        dependencies: [],
        metadata: {
          pluginApiVersion: "1"
        }
      },
      {
        id: "automation",
        type: "skill",
        name: "automation",
        version: "1.0.0",
        description: "Skill with a tar artifact.",
        tags: ["automation", "skill"],
        assets: {
          universal: {
            url: "https://market.example.test/artifacts/skill/automation.tar.gz",
            sha256: "skill-sha",
            integrity: "sha512-skill",
            sizeBytes: 4591,
            archiveType: "tar.gz",
            platform: "universal",
            role: "primary"
          }
        },
        dependencies: [],
        metadata: {
          source: "zenmind-env/skills-center"
        },
        npmPackage: "@zenmind-skill/automation"
      },
      {
        id: "python-template",
        type: "sandbox-image",
        name: "Python sandbox",
        version: "1.0.0",
        description: "Sandbox template.",
        tags: ["sandbox"],
        sandboxKind: "environment-template",
        assets: {
          universal: {
            url: "https://market.example.test/artifacts/sandbox/python-template.zip",
            sizeBytes: 2048,
            archiveType: "zip",
            platform: "universal",
            role: "primary"
          }
        },
        dependencies: [{
          kind: "system-command",
          phase: "runtime",
          required: true,
          command: "docker",
          displayName: "Docker"
        }],
        metadata: {
          environmentName: "python"
        }
      },
      {
        id: "reg-report",
        type: "website-app",
        name: "监管报表连续性对比",
        version: "0.1.0",
        description: "Website app.",
        tags: ["local-app", "webapp"],
        websiteKind: "local-app",
        assets: {
          universal: {
            url: "https://market.example.test/artifacts/website-app/reg-report.zip",
            sha256: "webapp-sha",
            integrity: "sha512-webapp",
            sizeBytes: 12986,
            archiveType: "zip",
            platform: "universal",
            role: "primary"
          }
        },
        dependencies: [{
          kind: "system-runtime",
          phase: "runtime",
          required: true,
          runtime: "node"
        }],
        metadata: {
          agentKey: "desktopAssistant",
          websiteKind: "local-app"
        }
      }
    ]
  };

  const result = await listMarketItems(app, { catalog });
  const byKey = new Map(result.items.map((item) => [`${item.type}:${item.id}`, item]));

  assert.deepEqual([...new Set(result.items.map((item) => item.type))].sort(), [
    "agent",
    "cli",
    "pet",
    "plugin",
    "sandbox-image",
    "skill",
    "website-app"
  ]);
  assert.equal(byKey.get("cli:dbx")?.cliInstallCommand, "brew install dbx");
  assert.equal(byKey.get("cli:dbx")?.cliUninstallCommand, "brew uninstall dbx");
  assert.deepEqual(byKey.get("cli:dbx")?.detect?.commands, ["dbx"]);
  assert.equal(byKey.get("plugin:activity-monitor")?.assets?.["darwin-arm64"]?.archiveType, "tar.gz");
  assert.equal(byKey.get("plugin:activity-monitor")?.state, "incompatible");
  assert.equal(byKey.get("skill:automation")?.assets?.universal?.archiveType, "tar.gz");
  assert.equal(byKey.get("skill:automation")?.state, "incompatible");
  assert.equal(byKey.get("agent:desktopassistant")?.dependencies?.[0]?.id, "desktop-action");
  assert.equal(byKey.get("agent:desktopassistant")?.readme, "Agent readme");
  assert.equal(byKey.get("agent:desktopassistant")?.author, "Lin Market");
  assert.equal(byKey.get("agent:desktopassistant")?.createdAt, "2026-06-13T00:00:00.000Z");
  assert.equal(byKey.get("agent:desktopassistant")?.downloadCount, 1200);
  assert.equal(byKey.get("agent:desktopassistant")?.favoriteCount, 34);
  assert.equal(byKey.get("agent:desktopassistant")?.favorited, true);
  assert.equal(byKey.get("agent:desktopassistant")?.platforms?.["darwin-arm64"]?.os, "darwin");
  assert.equal(byKey.get("agent:desktopassistant")?.platforms?.["windows-x64"]?.arch, "x64");
  assert.equal(byKey.get("agent:desktopassistant")?.publishedAt, "2026-06-14T00:00:00.000Z");
  assert.equal(byKey.get("cli:dbx")?.author, "Metadata CLI");
  assert.equal(byKey.get("cli:dbx")?.createdAt, "2026-06-12T00:00:00.000Z");
  assert.equal(byKey.get("cli:dbx")?.downloadCount, 2345);
  assert.equal(byKey.get("cli:dbx")?.favoriteCount, 56);
  assert.equal(byKey.get("sandbox-image:python-template")?.sandboxKind, "environment-template");
  assert.equal(byKey.get("website-app:reg-report")?.websiteKind, "local-app");
  assert.equal(byKey.get("website-app:reg-report")?.dependencies?.[0]?.runtime, "node");
  assert.equal(byKey.get("skill:automation")?.npmPackage, "@zenmind-skill/automation");
});

test("listMarketItems generates cli archive commands with zip assets", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-cli-zip-command-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = await listMarketItems(app, {
    catalog: {
      schemaVersion: 1,
      items: [
        {
          id: "zip-cli",
          type: "cli",
          name: "Zip CLI",
          version: "1.0.0",
          description: "Command line companion.",
          tags: ["cli"],
          assets: {
            universal: {
              url: "https://assets.example.test/zip-cli.zip",
              sha256: "",
              sizeBytes: 0,
              archiveType: "zip"
            }
          }
        }
      ]
    },
    sections: ["cli"]
  });
  const command = result.items.find((item) => item.id === "zip-cli")?.cliInstallCommand ?? "";

  assert.match(command, /zip-cli\.zip/);
  if (process.platform === "win32") {
    assert.match(command, /tar\.exe -xf/);
  } else {
    assert.match(command, /unzip -q/);
    assert.doesNotMatch(command, /tar -xzf/);
  }
});

test("installMarketItem installs pet packages into desktop pet data", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-pet-install-"));
  const app = createApp(root);
  const archivePath = await writePetArchive(root, { id: "desk-cat", displayName: "Desk Cat" });
  const archiveBytes = fs.readFileSync(archivePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await withFixtureServer(new Map([
    ["/desk-cat.zip", archiveBytes]
  ]), async (baseUrl) => {
    const result = await installMarketItem(app, "desk-cat", {
      catalog: {
        schemaVersion: 1,
        items: [{
          id: "desk-cat",
          type: "pet",
          name: "Desk Cat",
          version: "1.0.0",
          description: "A polished desktop pet.",
          tags: ["pet"],
          assets: {
            universal: {
              url: `${baseUrl}/desk-cat.zip`,
              sha256: sha256(archivePath),
              sizeBytes: archiveBytes.length,
              archiveType: "zip"
            }
          }
        }]
      }
    });
    assert.equal(result.ok, true);
    assert.equal(result.type, "pet");
    assert.equal(fs.existsSync(path.join(getDesktopPetsDataRoot(app), "desk-cat", "pet.json")), true);
    assert.equal(readDesktopPetStoredState(app).appearanceId, "user:desk-cat");
  });
});

test("installMarketItem installs and uninstalls website app packages into desktop webapps data", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-webapp-install-"));
  const app = createApp(root);
  const id = webappId("reg-report");
  const archivePath = await writeWebappArchive(root, { id, key: "reg-report", label: "监管报表" });
  const archiveBytes = fs.readFileSync(archivePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await withFixtureServer(new Map([
    ["/reg-report.zip", archiveBytes]
  ]), async (baseUrl) => {
    const options = {
      catalog: {
        schemaVersion: 1,
        items: [{
          id,
          type: "website-app",
          name: "监管报表",
          version: "0.1.0",
          description: "Local website app.",
          tags: ["webapp"],
          websiteKind: "local-app",
          assets: {
            universal: {
              url: `${baseUrl}/reg-report.zip`,
              sha256: sha256(archivePath),
              sizeBytes: archiveBytes.length,
              archiveType: "zip"
            }
          }
        }]
      }
    };

    const result = await installMarketItem(app, id, options);
    assert.equal(result.ok, true);
    assert.equal(result.type, "website-app");
    assert.equal(result.state, "installed");
    assert.equal(fs.existsSync(path.join(getDesktopWebappsDataRoot(app), id, "webapp.json")), true);
    assert.equal(readWebappItems(app).find((item) => item.id === id)?.label, "监管报表");

    const installedList = await listMarketItems(app, options);
    assert.equal(installedList.items.find((item) => item.id === id)?.state, "installed");

    const uninstallResult = await uninstallMarketItem(app, id, options);
    assert.equal(uninstallResult.ok, true);
    assert.equal(fs.existsSync(path.join(getDesktopWebappsDataRoot(app), id)), false);

    const uninstalledList = await listMarketItems(app, options);
    assert.equal(uninstalledList.items.find((item) => item.id === id)?.state, "not-installed");
  });
});

test("installWebsiteAppArchiveFromPath installs local website app packages", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-webapp-local-"));
  const app = createApp(root);
  const id = webappId("local-report");
  const archivePath = await writeWebappArchive(root, { id, key: "local-report", label: "Local Report" });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = await installWebsiteAppArchiveFromPath(app, archivePath, {
    expectedId: id
  });

  assert.equal(result.ok, true);
  assert.equal(result.type, "website-app");
  assert.equal(result.itemId, id);
  assert.equal(fs.existsSync(path.join(getDesktopWebappsDataRoot(app), id, "webapp.json")), true);
  assert.equal(readWebappItems(app).find((item) => item.id === id)?.label, "Local Report");
});

test("installMarketItem does not execute cli installs from Desktop", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-cli-install-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = await installMarketItem(app, "zenmind-cli", {
    catalog: {
      schemaVersion: 1,
      items: [{
        id: "zenmind-cli",
        type: "cli",
        name: "ZenMind CLI",
        version: "2.0.0",
        description: "Command line companion.",
        tags: ["cli"],
        metadata: {
          macosInstallCommand: "touch should-not-run"
        },
        assets: {}
      }]
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.type, "cli");
  assert.equal(fs.existsSync(path.join(root, "should-not-run")), false);
});

test("installMarketItem installs and removes agent packages through agent-platform", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-agent-install-"));
  const app = createApp(root);
  const archivePath = writeAgentArchive(root);
  const archiveBytes = fs.readFileSync(archivePath);
  const calls = [];
  fs.mkdirSync(path.join(root, "temp"), { recursive: true });
  configureAgentMarketPlatformCaller(async (targetPath, options) => {
    calls.push({ targetPath, options });
    return { ok: true };
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await withFixtureServer(new Map([
    ["/desktopassistant.zip", archiveBytes]
  ]), async (baseUrl) => {
    const options = {
      catalog: {
        schemaVersion: 1,
        items: [{
          id: "desktopassistant",
          type: "agent",
          name: "Desktop Assistant",
          version: "1.0.0",
          description: "Desktop assistant",
          tags: ["agent"],
          metadata: { agentKey: "desktopAssistant" },
          assets: {
            universal: {
              url: `${baseUrl}/desktopassistant.zip`,
              sha256: sha256(archivePath),
              sizeBytes: archiveBytes.length,
              archiveType: "agent"
            }
          }
        }]
      }
    };

    const result = await installMarketItem(app, "desktopassistant", options);
    assert.equal(result.ok, true);
    assert.equal(result.type, "agent");
    assert.equal(calls[0]?.targetPath, "/api/admin/agents/create");
    assert.equal(calls[0]?.options?.body?.agentKey, "desktopAssistant");
    assert.equal(calls[0]?.options?.body?.definition?.key, "desktopAssistant");
    assert.equal(calls[0]?.options?.body?.soulPrompt, "# Soul\n");
    assert.equal(__testInternals.readInstalledRecords(app).find((item) => item.id === "desktopassistant")?.resourceKey, "desktopAssistant");

    const removed = await uninstallMarketItem(app, "desktopassistant", options);
    assert.equal(removed.ok, true);
    assert.equal(calls[1]?.targetPath, "/api/admin/agents/delete");
    assert.equal(calls[1]?.options?.body?.agentKey, "desktopAssistant");
  });
});

test("saved apiBaseUrl is used by list and install when market is enabled", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-settings-"));
  const app = createApp(root);
  const archivePath = writeRootSkillArchive(root, { id: "saved-skill" });
  const archiveBytes = fs.readFileSync(archivePath);
  const catalogHeaders = [];
  const resolveHeaders = [];
  const assetHeaders = [];
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(getDesktopConfigRoot(app), { recursive: true });
  fs.writeFileSync(
    path.join(getDesktopConfigRoot(app), "profile.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      general: {
        deviceName: "市场工作站",
        preventSleepWhileRunning: true,
        desktopWsServerEnabled: false
      }
    }, null, 2)}\n`,
    "utf8"
  );

  await withFixtureServer(new Map([
    ["/api/v1/auth/me", (req, res) => {
      resolveHeaders.push(req.headers);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ user: { id: "market-user" } }));
    }],
    ["/api/v1/desktop/catalog", (req, res) => {
      catalogHeaders.push(req.headers);
      const origin = `http://${req.headers.host}`;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        schemaVersion: 1,
        items: [
          {
            id: "saved-skill",
            type: "skill",
            name: "Saved Skill",
            version: "1.0.0",
            description: "Saved",
            tags: [],
            assets: {
              universal: {
                url: `${origin}/saved-skill.zip`,
                sha256: sha256(archivePath),
                sizeBytes: archiveBytes.length,
                archiveType: "zip"
              }
            }
          }
        ]
      }));
    }],
    ["/api/v1/skills/saved-skill/resolve?version=1.0.0&platform=universal", (req, res) => {
      resolveHeaders.push(req.headers);
      const origin = `http://${req.headers.host}`;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        schemaVersion: 1,
        item: {
          id: "saved-skill",
          type: "skill"
        },
        version: "1.0.0",
        platform: "universal",
        platformSpec: { platform: "universal" },
        asset: {
          url: `${origin}/saved-skill.zip`,
          sha256: sha256(archivePath),
          sizeBytes: archiveBytes.length,
          archiveType: "zip"
        }
      }));
    }],
    ["/api/v1/skills/saved-skill/download?version=1.0.0&platform=universal", (req, res) => {
      assetHeaders.push(req.headers);
      res.end(archiveBytes);
    }]
  ]), async (baseUrl) => {
    const settings = saveMarketSettings(app, { enabled: true, apiBaseUrl: `${baseUrl}/api/v1` });
    assert.equal(settings.enabled, true);
    assert.equal(settings.apiBaseUrl, `${baseUrl}/api/v1`);
    assert.equal(getMarketSettings(app).enabled, true);
    assert.equal(getMarketSettings(app).apiBaseUrl, `${baseUrl}/api/v1`);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(getDesktopConfigRoot(app), "market.json"), "utf8")).apiBaseUrl,
      `${baseUrl}/api/v1`
    );
    assert.equal(fs.existsSync(path.join(root, "home", ".zenmind", ".desktop", "config", "marketplace", "settings.json")), false);

    const listed = await listMarketItems(app, { sections: ["skills"] });
    assert.equal(listed.items.find((item) => item.id === "saved-skill")?.name, "Saved Skill");
    assert.equal(catalogHeaders[0]["x-desktop-device-name-b64"], Buffer.from("市场工作站", "utf8").toString("base64url"));
    assert.equal(typeof catalogHeaders[0]["x-desktop-device-id"], "string");
    assert.equal(typeof catalogHeaders[0]["x-desktop-platform"], "string");

    const result = await installMarketItem(app, "saved-skill");
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(path.join(getSkillInstallDir(app, "saved-skill"), "SKILL.md")), true);
    assert.equal(resolveHeaders.length, 2);
    assert.equal(resolveHeaders.every((headers) => typeof headers["x-desktop-device-id"] === "string"), true);
    assert.equal(assetHeaders.length, 1);
    assert.equal(assetHeaders[0]["x-desktop-device-name-b64"], Buffer.from("市场工作站", "utf8").toString("base64url"));
    assert.equal(typeof assetHeaders[0]["x-desktop-device-id"], "string");
  });
});

test("public market catalog does not require or refresh a Desktop SSO token", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-auth-refresh-"));
  const app = createApp(root);
  const authorizationHeaders = [];
  const tokenReasons = [];
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await withFixtureServer(new Map([
    ["/api/v1/desktop/catalog", (req, res) => {
      authorizationHeaders.push(req.headers.authorization ?? "");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ schemaVersion: 1, items: [] }));
    }]
  ]), async (baseUrl) => {
    const result = await listMarketItems(app, {
      apiBaseUrl: `${baseUrl}/api/v1`,
      marketEnabled: true,
      sections: ["softwarePackages"],
      issueMarketAccessToken: (_marketApp, reason) => {
        tokenReasons.push(reason);
        return reason === "unauthorized" ? "refreshed-market-token" : "stale-market-token";
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.offline, false);
    assert.deepEqual(tokenReasons, []);
    assert.deepEqual(authorizationHeaders, [""]);
  });
});

test("installMarketItem resolves, downloads, installs and uninstalls software packages", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-software-install-"));
  const app = createApp(root);
  const archivePath = await writeSoftwarePackageArchive(root, { id: "python-test" });
  const archiveBytes = fs.readFileSync(archivePath);
  const platformKey = process.platform === "win32"
    ? `windows-${process.arch === "arm64" ? "arm64" : "amd64"}`
    : `${process.platform}-${process.arch}`;
  const requests = [];
  fs.mkdirSync(path.join(root, "temp"), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await withFixtureServer(new Map([
    ["/api/v1/auth/me", (req, res) => {
      requests.push({ path: req.url, authorization: req.headers.authorization });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ user: { id: "market-user" } }));
    }],
    ["/api/v1/desktop/catalog", (req, res) => {
      requests.push({ path: req.url, authorization: req.headers.authorization });
      const origin = `http://${req.headers.host}`;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        schemaVersion: 1,
        items: [{
          id: "python-test",
          type: "software-package",
          name: "Python Test",
          version: "3.14.6",
          description: "Portable Python fixture",
          tags: ["python"],
          assets: {
            [platformKey]: {
              url: `${origin}/ignored-direct-url.zip`,
              sha256: sha256(archivePath),
              sizeBytes: archiveBytes.length,
              archiveType: "zip"
            }
          }
        }]
      }));
    }],
    [`/api/v1/software-packages/python-test/resolve?version=3.14.6&platform=${platformKey}`, (req, res) => {
      requests.push({ path: req.url, authorization: req.headers.authorization });
      const origin = `http://${req.headers.host}`;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        schemaVersion: 1,
        item: { id: "python-test", type: "software-package" },
        version: "3.14.6",
        platform: platformKey,
        platformSpec: { platform: platformKey, minDesktopVersion: "0.3.30" },
        asset: {
          url: `${origin}/ignored-resolved-url.zip`,
          sha256: sha256(archivePath),
          sizeBytes: archiveBytes.length,
          archiveType: "zip"
        }
      }));
    }],
    [`/api/v1/software-packages/python-test/download?version=3.14.6&platform=${platformKey}`, (req, res) => {
      requests.push({ path: req.url, authorization: req.headers.authorization });
      res.end(archiveBytes);
    }]
  ]), async (baseUrl) => {
    const options = {
      apiBaseUrl: `${baseUrl}/api/v1`,
      marketEnabled: true,
      issueMarketAccessToken: () => "market-access-token"
    };
    const result = await installMarketItem(app, "python-test", options);
    const installPath = getSoftwarePackageInstallDir(app, "python-test", "3.14.6");
    assert.equal(result.ok, true);
    assert.equal(result.type, "software-package");
    assert.equal(fs.readFileSync(path.join(installPath, "bin", "python"), "utf8"), "python executable\n");
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(path.dirname(installPath), "current.json"), "utf8")),
      { version: "3.14.6", installPath }
    );
    const record = __testInternals.readInstalledRecords(app).find((item) => item.id === "python-test");
    assert.equal(record?.type, "software-package");
    assert.equal(record?.platform, platformKey);
    assert.equal(requests.length, 4);
    assert.deepEqual(requests.map((entry) => entry.path), [
      "/api/v1/desktop/catalog",
      "/api/v1/auth/me",
      `/api/v1/software-packages/python-test/resolve?version=3.14.6&platform=${platformKey}`,
      `/api/v1/software-packages/python-test/download?version=3.14.6&platform=${platformKey}`
    ]);
    assert.equal(requests[0].authorization, undefined);
    assert.equal(requests.slice(1).every((entry) => entry.authorization === "Bearer market-access-token"), true);
    assert.equal(requests.some((entry) => entry.path.includes("ignored-direct-url")), false);
    assert.equal(requests.some((entry) => entry.path.includes("ignored-resolved-url")), false);

    const removed = await uninstallMarketItem(app, "python-test", options);
    assert.equal(removed.ok, true);
    assert.equal(fs.existsSync(path.dirname(installPath)), false);
    assert.equal(__testInternals.readInstalledRecords(app).some((item) => item.id === "python-test"), false);
  });
});

test("market settings reject a storefront origin without the API version path", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-settings-origin-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => saveMarketSettings(app, { enabled: true, apiBaseUrl: "https://market.example.test" }),
    /(?:\/api\/v1|市场 API 地址请输入以 \/api\/v1 结尾的服务地址)/u
  );
});

test("saved apiBaseUrl without enabled true does not request the market catalog", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-settings-disabled-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let catalogRequests = 0;
  await withFixtureServer(new Map([
    ["/api/v1/desktop/catalog", (_req, res) => {
      catalogRequests += 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ schemaVersion: 1, items: [] }));
    }]
  ]), async (baseUrl) => {
    const settingsPath = path.join(getDesktopConfigRoot(app), "market.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, `${JSON.stringify({ apiBaseUrl: `${baseUrl}/api/v1` }, null, 2)}\n`, "utf8");

    const settings = getMarketSettings(app);
    assert.equal(settings.enabled, false);
    assert.equal(settings.apiBaseUrl, `${baseUrl}/api/v1`);

    const listed = await listMarketItems(app, { sections: ["skills"] });
    assert.equal(listed.offline, true);
    assert.equal(listed.items.length, 0);
    assert.equal(catalogRequests, 0);
  });
});

test("toggleMarketFavorite posts and deletes favorite state through the market API", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-favorite-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(getDesktopConfigRoot(app), { recursive: true });
  fs.writeFileSync(
    path.join(getDesktopConfigRoot(app), "profile.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      general: {
        deviceName: "Favorite Desktop",
        preventSleepWhileRunning: true,
        desktopWsServerEnabled: false
      }
    }, null, 2)}\n`,
    "utf8"
  );

  const requests = [];
  const issueCalls = [];
  const favoriteItem = {
    id: "automation",
    type: "skill",
    name: "Automation",
    version: "1.0.0",
    description: "Automation skill",
    tags: ["automation"],
    dependencies: [],
    assets: {},
    downloadCount: 8,
    favoriteCount: 0,
    favorited: false
  };

  await withFixtureServer(new Map([
    ["/api/v1/skills/automation/favorite", (req, res) => {
      requests.push({
        method: req.method,
        authorization: req.headers.authorization,
        deviceId: req.headers["x-desktop-device-id"],
        deviceName: req.headers["x-desktop-device-name-b64"]
      });
      favoriteItem.favorited = req.method === "POST";
      favoriteItem.favoriteCount = favoriteItem.favorited ? 1 : 0;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(favoriteItem));
    }]
  ]), async (baseUrl) => {
    const issueAgentAccessToken = (_app, reason) => {
      issueCalls.push(reason);
      return { ok: true, token: "market-token", message: "issued" };
    };

    const favorited = await toggleMarketFavorite(app, {
      itemId: "automation",
      type: "skill",
      favorited: false
    }, {
      apiBaseUrl: `${baseUrl}/api/v1`,
      issueAgentAccessToken
    });

    const unfavorited = await toggleMarketFavorite(app, {
      itemId: "automation",
      type: "skill",
      favorited: true
    }, {
      apiBaseUrl: `${baseUrl}/api/v1`,
      issueAgentAccessToken
    });

    assert.equal(favorited.item.favorited, true);
    assert.equal(favorited.item.favoriteCount, 1);
    assert.equal(unfavorited.item.favorited, false);
    assert.equal(unfavorited.item.favoriteCount, 0);
    assert.deepEqual(requests.map((request) => request.method), ["POST", "DELETE"]);
    assert.deepEqual(requests.map((request) => request.authorization), ["Bearer market-token", "Bearer market-token"]);
    assert.equal(requests[0].deviceName, Buffer.from("Favorite Desktop", "utf8").toString("base64url"));
    assert.equal(requests[1].deviceName, Buffer.from("Favorite Desktop", "utf8").toString("base64url"));
    assert.equal(typeof requests[0].deviceId, "string");
    assert.equal(typeof requests[1].deviceId, "string");
    assert.deepEqual(issueCalls, ["missing", "missing"]);
  });
});

test("toggleMarketFavorite refreshes the access token once after a 401", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-favorite-retry-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const requests = [];
  const issueCalls = [];
  await withFixtureServer(new Map([
    ["/api/v1/plugins/activity-monitor/favorite", (req, res) => {
      requests.push(req.headers.authorization);
      if (req.headers.authorization !== "Bearer fresh-token") {
        res.statusCode = 401;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ message: "unauthorized" }));
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "activity-monitor",
        type: "plugin",
        name: "Activity Monitor",
        version: "1.0.0",
        description: "Plugin",
        tags: [],
        dependencies: [],
        assets: {},
        favoriteCount: 4,
        favorited: true
      }));
    }]
  ]), async (baseUrl) => {
    const issueAgentAccessToken = (_app, reason) => {
      issueCalls.push(reason);
      return {
        ok: true,
        token: reason === "unauthorized" ? "fresh-token" : "stale-token",
        message: "issued"
      };
    };

    const result = await toggleMarketFavorite(app, {
      itemId: "activity-monitor",
      type: "plugin",
      favorited: false
    }, {
      apiBaseUrl: `${baseUrl}/api/v1`,
      issueAgentAccessToken
    });

    assert.equal(result.item.favorited, true);
    assert.equal(result.item.favoriteCount, 4);
    assert.deepEqual(issueCalls, ["missing", "unauthorized"]);
    assert.deepEqual(requests, ["Bearer stale-token", "Bearer fresh-token"]);
  });
});

test("toggleMarketFavorite reports missing market API configuration", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-favorite-no-api-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await assert.rejects(
    () => toggleMarketFavorite(app, {
      itemId: "automation",
      type: "skill",
      favorited: false
    }),
    /(?:Market API is not configured|市场 API 未配置)/
  );
});

test("legacy marketApiBaseUrl in desktop market settings is ignored", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-settings-legacy-field-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const settingsPath = path.join(getDesktopConfigRoot(app), "market.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify({
    enabled: true,
    marketApiBaseUrl: "https://legacy-field.example.test/api/v1"
  }, null, 2)}\n`, "utf8");

  const settings = getMarketSettings(app);
  assert.equal(settings.enabled, true);
  assert.equal(settings.apiBaseUrl, "");
});

test("legacy marketplace settings path is ignored", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-settings-legacy-ignored-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const legacySettingsPath = path.join(root, "home", ".zenmind", ".desktop", "config", "marketplace", "settings.json");
  fs.mkdirSync(path.dirname(legacySettingsPath), { recursive: true });
  fs.writeFileSync(legacySettingsPath, `${JSON.stringify({
    enabled: true,
    apiBaseUrl: "https://legacy.example.test/api/v1"
  }, null, 2)}\n`, "utf8");

  const settings = getMarketSettings(app);
  assert.equal(settings.enabled, false);
  assert.equal(settings.apiBaseUrl, "");
});

test("market settings can enable the entry without an API address", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-settings-empty-api-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const settings = saveMarketSettings(app, { enabled: true, apiBaseUrl: "" });
  assert.equal(settings.enabled, true);
  assert.equal(settings.apiBaseUrl, "");
  assert.equal(getMarketSettings(app).enabled, true);
});

test("importSkillFromCommand runs an npm or npx download command and installs the produced skill", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-command-skill-"));
  const app = createApp(root);
  const binDir = path.join(root, "bin");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(binDir, { recursive: true });
  const npxPath = path.join(binDir, process.platform === "win32" ? "npx.cmd" : "npx");
  const script = process.platform === "win32"
    ? `@echo off
echo %USERPROFILE% | findstr /C:"skills-center" >nul || exit /b 42
set target=%USERPROFILE%\\.claude\\skills\\downloaded-skill
mkdir "%target%"
echo # Downloaded Skill>"%target%\\SKILL.md"
echo {"id":"downloaded-skill","name":"Downloaded Skill","version":"1.2.3","description":"Downloaded by command","tags":["cloud"]}>"%target%\\skill.json"
`
    : `#!/bin/sh
set -eu
case "$HOME" in
  *skills-center/.downloads/desktop-skill-download-*/home) ;;
  *) echo "unexpected HOME: $HOME" >&2; exit 42 ;;
esac
target="$HOME/.claude/skills/downloaded-skill"
mkdir -p "$target"
printf '# Downloaded Skill\\n' > "$target/SKILL.md"
printf '{"id":"downloaded-skill","name":"Downloaded Skill","version":"1.2.3","description":"Downloaded by command","tags":["cloud"]}\\n' > "$target/skill.json"
`;
  fs.writeFileSync(npxPath, script, "utf8");
  fs.chmodSync(npxPath, 0o755);

  await withPathPrefix(binDir, async () => {
    const result = await importSkillFromCommand(
      app,
      "npx -y @lobehub/market-cli skills install downloaded-skill --agent claude-code"
    );

    assert.equal(result.ok, true);
    assert.equal(result.type, "skill");
    assert.equal(result.state, "installed");
    assert.equal(result.itemId, "downloaded-skill");
    assert.equal(fs.existsSync(path.join(getSkillInstallDir(app, "downloaded-skill"), "SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(root, "home", ".claude", "skills", "downloaded-skill")), false);

    const listed = await listMarketItems(app, {
      catalog: { schemaVersion: 1, items: [] },
      sections: ["skills"]
    });
    const installed = listed.items.find((item) => item.id === "downloaded-skill");
    assert.equal(installed?.source, "cloud");
    assert.equal(installed?.state, "installed");
  });
});

test("importSkillFromCommand maps old Anthropic skill ids before running skills add", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-command-skill-alias-"));
  const app = createApp(root);
  const binDir = path.join(root, "bin");
  const logPath = path.join(root, "npx-args.log");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(binDir, { recursive: true });
  const npxPath = path.join(binDir, process.platform === "win32" ? "npx.cmd" : "npx");
  const script = process.platform === "win32"
    ? `@echo off
echo %*>"${logPath}"
set args=%*
set args=%args:"=%
echo %args% | findstr /C:"--skill docx-manipulation" >nul && exit /b 7
echo %args% | findstr /C:"--skill docx" >nul || exit /b 8
set target=%USERPROFILE%\\.codex\\skills\\docx
mkdir "%target%"
echo # DOCX>"%target%\\SKILL.md"
echo {"id":"docx","name":"DOCX","version":"1.0.0","description":"Anthropic skill","tags":["cloud"]}>"%target%\\skill.json"
`
    : `#!/bin/sh
set -eu
printf '%s\\n' "$*" > "${logPath}"
case " $* " in
  *" --skill docx-manipulation "*) exit 7 ;;
esac
case " $* " in
  *" --skill docx "*) ;;
  *) exit 8 ;;
esac
target="$HOME/.codex/skills/docx"
mkdir -p "$target"
printf '# DOCX\\n' > "$target/SKILL.md"
printf '{"id":"docx","name":"DOCX","version":"1.0.0","description":"Anthropic skill","tags":["cloud"]}\\n' > "$target/skill.json"
`;
  fs.writeFileSync(npxPath, script, "utf8");
  fs.chmodSync(npxPath, 0o755);

  await withPathPrefix(binDir, async () => {
    const result = await importSkillFromCommand(
      app,
      "npx skills add https://github.com/anthropics/skills --skill docx-manipulation"
    );

    assert.equal(result.ok, true);
    assert.equal(result.itemId, "docx");
    assert.equal(fs.existsSync(path.join(getSkillInstallDir(app, "docx"), "SKILL.md")), true);
    const log = fs.readFileSync(logPath, "utf8").replace(/"/g, "");
    assert.match(log, /--skill docx(?:\s|$)/);
    assert.doesNotMatch(log, /docx-manipulation/);
  });
});

test("importSkillFromCommand normalizes common npm and npx skills add formats", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-command-skill-formats-"));
  const app = createApp(root);
  const binDir = path.join(root, "bin");
  const logPath = path.join(root, "package-manager-args.log");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeFakePackageManager(binDir, "npm", logPath);
  writeFakePackageManager(binDir, "npx", logPath);

  const cases = [
    {
      command: "npx --yes skills@latest add https://github.com/anthropics/skills --skill=pdf-manipulation",
      expectedId: "pdf"
    },
    {
      command: "npx --package skills -- skills add git@github.com:anthropics/skills.git --skill pptx-manipulation",
      expectedId: "pptx"
    },
    {
      command: "npm exec --yes -- skills add https://github.com/anthropics/skills --skill xlsx-manipulation",
      expectedId: "xlsx"
    },
    {
      command: "npm x skills@latest -- add github:anthropics/skills --skill=docx-manipulation",
      expectedId: "docx"
    }
  ];

  await withPathPrefix(binDir, async () => {
    for (const item of cases) {
      const result = await importSkillFromCommand(app, item.command);

      assert.equal(result.ok, true);
      assert.equal(result.itemId, item.expectedId);
      assert.equal(fs.existsSync(path.join(getSkillInstallDir(app, item.expectedId), "SKILL.md")), true);
    }
  });

  const log = fs.readFileSync(logPath, "utf8");
  assert.doesNotMatch(log, /(?:docx|pdf|pptx|xlsx)-manipulation/);
  for (const expectedId of cases.map((item) => item.expectedId)) {
    assert.match(log, new RegExp(`--skill(?:=| )${expectedId}(?:\\s|$)`));
  }
});

test("importSkillFromCommand rejects non npm and npx commands", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-command-reject-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await assert.rejects(
    () => importSkillFromCommand(app, "curl https://example.test/skill.tar.gz"),
    /仅支持 npm 或 npx/
  );
});

test("installMarketItem downloads plugin archives but rejects builtin manifests", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-plugin-kind-"));
  const app = createApp(root);
  const archivePath = writePluginArchive(root, { id: "cloud-builtin", kind: "builtin" });
  const archiveBytes = fs.readFileSync(archivePath);
  registryInternals.clearServices();
  t.after(() => {
    registryInternals.clearServices();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await withFixtureServer(new Map([["/cloud-builtin.zip", archiveBytes]]), async (baseUrl) => {
    const catalog = {
      schemaVersion: 1,
      items: [
        {
          id: "cloud-builtin",
          type: "plugin",
          name: "Cloud Builtin",
          version: "1.0.0",
          description: "Should be rejected",
          tags: [],
          assets: {
            universal: {
              url: `${baseUrl}/cloud-builtin.zip`,
              sha256: sha256(archivePath),
              sizeBytes: archiveBytes.length,
              archiveType: "zip"
            }
          }
        }
      ]
    };

    await assert.rejects(
      () => installMarketItem(app, "cloud-builtin", { catalog }),
      /云端插件包必须声明为插件类型。/
    );
    assert.equal(fs.existsSync(getPluginInstallDir(app, "cloud-builtin")), false);
  });
});

test("uninstallMarketItem removes skill installs and marketplace records", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-uninstall-"));
  const app = createApp(root);
  const archivePath = writeRootSkillArchive(root, { id: "remove-skill" });
  const archiveBytes = fs.readFileSync(archivePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await withFixtureServer(new Map([
    ["/remove-skill.zip", archiveBytes]
  ]), async (baseUrl) => {
    const options = {
      catalog: {
        schemaVersion: 1,
        items: [
          {
            id: "remove-skill",
            type: "skill",
            name: "Remove Skill",
            version: "1.0.0",
            description: "Remove skill",
            tags: [],
            assets: {
              universal: {
                url: `${baseUrl}/remove-skill.zip`,
                sha256: sha256(archivePath),
                sizeBytes: archiveBytes.length,
                archiveType: "zip"
              }
            }
          }
        ]
      }
    };
    await installMarketItem(app, "remove-skill", options);
    const result = await uninstallMarketItem(app, "remove-skill", options);

    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(getSkillInstallDir(app, "remove-skill")), false);
    const listed = await listMarketItems(app, options);
    assert.equal(listed.items.find((item) => item.id === "remove-skill")?.state, "not-installed");
  });
});
