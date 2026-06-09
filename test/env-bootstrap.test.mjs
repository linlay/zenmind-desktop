import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const JSZip = require("jszip");
const {
  importBundledEnvZipToRuntime,
  importEnvZipToRuntime,
  resolveBundledEnvZipPath,
  resolveDesktopVersion,
  resolveRuntimeRoot,
  runtimeEnvExists,
  runtimeRootExists,
  shouldRequireEnvZipImport,
  generateBackupDirName,
  migrateOldRootToBackup,
  resetBundledRuntimeEnv,
  shouldPromptEnvRootConflict
} = require("../dist-electron/main/env-bootstrap.js");

const DESKTOP_VERSION = fs.readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim().replace(/^v/u, "");

function createApp(root) {
  const homePath = path.join(root, "home");
  return {
    getPath(name) {
      if (name === "home") {
        return homePath;
      }
      assert.fail(`unexpected app.getPath(${name})`);
    }
  };
}

async function writeZip(zipPath, entries) {
  const zip = new JSZip();
  for (const [entryPath, content] of Object.entries(entries)) {
    zip.file(entryPath, content);
  }
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer" }));
}

test("mac and Windows first launch requires env.zip when only Desktop-created state exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bootstrap-state-"));
  const app = createApp(root);
  const runtimeRoot = path.join(root, "home", ".zenmind");

  try {
    fs.mkdirSync(path.join(runtimeRoot, ".desktop", "profiles", "electron"), { recursive: true });

    assert.equal(runtimeEnvExists(app, "darwin"), false);
    assert.equal(
      shouldRequireEnvZipImport({
        platform: "darwin",
        runtimeEnvExistedAtStartup: runtimeEnvExists(app, "darwin")
      }),
      true
    );
    assert.equal(
      shouldRequireEnvZipImport({
        platform: "win32",
        runtimeEnvExistedAtStartup: false
      }),
      true
    );

    fs.mkdirSync(path.join(runtimeRoot, "registries"), { recursive: true });
    assert.equal(runtimeEnvExists(app, "darwin"), true);
    assert.equal(
      shouldRequireEnvZipImport({
        platform: "linux",
        runtimeEnvExistedAtStartup: false
      }),
      false
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("importEnvZipToRuntime strips env wrapper and only copies missing files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bootstrap-import-"));
  const app = createApp(root);
  const runtimeRoot = path.join(root, "home", ".zenmind");
  const zipPath = path.join(root, "env.zip");
  const existingAgentPath = path.join(runtimeRoot, "agents", "demo", "agent.yml");
  const registryPath = path.join(runtimeRoot, "registries", "providers", "demo.yml");
  const markerPath = path.join(runtimeRoot, ".desktop", "state", "desktop", "env-bootstrap.json");

  try {
    fs.mkdirSync(path.dirname(existingAgentPath), { recursive: true });
    fs.writeFileSync(existingAgentPath, "name: keep\n", "utf8");
    await writeZip(zipPath, {
      "env/VERSION": `v${DESKTOP_VERSION}\n`,
      "env/agents/demo/agent.yml": "name: overwrite\n",
      "env/registries/providers/demo.yml": "name: provider\n",
      "__MACOSX/._agent.yml": "ignored",
      "env/.DS_Store": "ignored"
    });

    const result = await importEnvZipToRuntime(app, zipPath, "darwin", DESKTOP_VERSION);

    assert.equal(result.targetRoot, runtimeRoot);
    assert.equal(result.copiedFiles, 2);
    assert.equal(result.skippedFiles, 1);
    assert.equal(fs.readFileSync(existingAgentPath, "utf8"), "name: keep\n");
    assert.equal(fs.readFileSync(path.join(runtimeRoot, "VERSION"), "utf8"), `v${DESKTOP_VERSION}\n`);
    assert.equal(fs.readFileSync(registryPath, "utf8"), "name: provider\n");
    assert.equal(result.overwrittenFiles, 0);
    assert.equal(fs.existsSync(path.join(runtimeRoot, "env")), false);
    assert.equal(fs.existsSync(markerPath), true);
    assert.equal(runtimeEnvExists(app, "darwin"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("importEnvZipToRuntime rejects non-standard env.zip wrappers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bootstrap-wrapper-"));
  const app = createApp(root);
  const legacyWrapperZipPath = path.join(root, "legacy-wrapper.zip");
  const bareZipPath = path.join(root, "bare.zip");
  const nestedWrapperZipPath = path.join(root, "nested-wrapper.zip");

  try {
    await writeZip(legacyWrapperZipPath, {
      "zenmind-env-20260516-220857/VERSION": DESKTOP_VERSION,
      "zenmind-env-20260516-220857/agents/demo/agent.yml": "name: demo\n"
    });
    await writeZip(bareZipPath, {
      "VERSION": DESKTOP_VERSION,
      "agents/demo/agent.yml": "name: demo\n"
    });
    await writeZip(nestedWrapperZipPath, {
      "env/env/VERSION": DESKTOP_VERSION,
      "env/env/agents/demo/agent.yml": "name: demo\n"
    });

    await assert.rejects(
      () => importEnvZipToRuntime(app, legacyWrapperZipPath, "darwin", DESKTOP_VERSION),
      /唯一顶层 env\/ 目录/
    );
    await assert.rejects(
      () => importEnvZipToRuntime(app, bareZipPath, "darwin", DESKTOP_VERSION),
      /唯一顶层 env\/ 目录/
    );
    await assert.rejects(
      () => importEnvZipToRuntime(app, nestedWrapperZipPath, "darwin", DESKTOP_VERSION),
      /只能剥离一层 env\//
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("importEnvZipToRuntime accepts env VERSION without v prefix", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bootstrap-version-prefix-"));
  const app = createApp(root);
  const zipPath = path.join(root, "env.zip");
  const agentPath = path.join(root, "home", ".zenmind", "agents", "demo", "agent.yml");

  try {
    await writeZip(zipPath, {
      "env/VERSION": DESKTOP_VERSION,
      "env/agents/demo/agent.yml": "name: demo\n"
    });

    await importEnvZipToRuntime(app, zipPath, "darwin", `v${DESKTOP_VERSION}`);

    assert.equal(fs.readFileSync(agentPath, "utf8"), "name: demo\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bundled env.zip resolves to shared env resource path and imports automatically", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bootstrap-bundled-"));
  const app = createApp(root);
  const resourcesRoot = path.join(root, "resources");
  const bundledZipPath = path.join(resourcesRoot, "env", "env.zip");
  const providerPath = path.join(root, "home", ".zenmind", "registries", "providers", "demo.yml");

  try {
    fs.mkdirSync(path.dirname(bundledZipPath), { recursive: true });
    await writeZip(bundledZipPath, {
      "env/VERSION": DESKTOP_VERSION,
      "env/registries/providers/demo.yml": "name: provider\n"
    });

    assert.equal(resolveBundledEnvZipPath(app, "darwin", resourcesRoot), bundledZipPath);
    assert.equal(resolveBundledEnvZipPath(app, "win32", resourcesRoot), bundledZipPath);
    assert.equal(resolveBundledEnvZipPath(app, "linux", resourcesRoot), null);

    const result = await importBundledEnvZipToRuntime(app, "darwin", {
      resourcesRoot,
      expectedDesktopVersion: DESKTOP_VERSION
    });

    assert.equal(result?.sourceZipPath, bundledZipPath);
    assert.equal(fs.readFileSync(providerPath, "utf8"), "name: provider\n");
    assert.equal(runtimeEnvExists(app, "darwin"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bundled env.zip import returns null when no packaged env exists", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bootstrap-bundled-missing-"));
  const app = createApp(root);

  try {
    assert.equal(
      await importBundledEnvZipToRuntime(app, "darwin", {
        resourcesRoot: path.join(root, "resources"),
        expectedDesktopVersion: DESKTOP_VERSION
      }),
      null
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("importEnvZipToRuntime preserves bootstrap suffixes and legacy YAML fields", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bootstrap-agent-seed-"));
  const app = createApp(root);
  const zipPath = path.join(root, "env.zip");
  const runtimeRoot = path.join(root, "home", ".zenmind");
  const assistantPath = path.join(runtimeRoot, "agents", "desktopAssistant.bootstrap", "agent.yml");
  const zenmiPath = path.join(runtimeRoot, "agents", "zenmi.bootstrap", "agent.yml");

  try {
    await writeZip(zipPath, {
      "env/VERSION": DESKTOP_VERSION,
      "env/agents/desktopAssistant.bootstrap/agent.yml": [
        "key: desktopAssistant",
        "name: Desktop Assistant",
        "budget:",
        "  runTimeoutMs: 1800000",
        "  maxSteps: 50",
        ""
      ].join("\n"),
      "env/agents/zenmi.bootstrap/agent.yml": [
        "key: zenmi",
        "name: Zenmi",
        "runtimeConfig:",
        "  workspaceRoot: /",
        ""
      ].join("\n")
    });

    await importEnvZipToRuntime(app, zipPath, "win32", DESKTOP_VERSION);

    assert.equal(fs.existsSync(path.join(runtimeRoot, "agents", "desktopAssistant")), false);
    assert.equal(fs.existsSync(path.join(runtimeRoot, "agents", "zenmi")), false);
    assert.equal(fs.existsSync(path.join(runtimeRoot, "agents", "desktopAssistant.bootstrap")), true);
    assert.equal(fs.existsSync(path.join(runtimeRoot, "agents", "zenmi.bootstrap")), true);

    const assistantContent = fs.readFileSync(assistantPath, "utf8");
    assert.match(assistantContent, /runTimeoutMs:\s*1800000/u);
    assert.doesNotMatch(assistantContent, /timeout:\s*1800/u);

    const zenmiContent = fs.readFileSync(zenmiPath, "utf8");
    assert.match(zenmiContent, /workspaceRoot:\s*\/\s*$/mu);
    assert.doesNotMatch(zenmiContent, /workspaceRoot:\s*['"]?@chat/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bundled env.zip skips existing seed and registry files without overwriting user data", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bootstrap-seed-refresh-"));
  const app = createApp(root);
  const platform = "darwin";
  const resourcesRoot = path.join(root, "resources");
  const bundledZipPath = path.join(resourcesRoot, "env", "env.zip");
  const runtimeRoot = resolveRuntimeRoot(app, platform);
  const bootstrapAgentPath = path.join(runtimeRoot, "agents", "bootstrap", "agent.yml");
  const providerPath = path.join(runtimeRoot, "registries", "providers", "minimax.yml");
  const modelPath = path.join(runtimeRoot, "registries", "models", "th-minimax.yml");
  const ownerPath = path.join(runtimeRoot, "owner", "profile.yml");

  try {
    fs.mkdirSync(path.dirname(bundledZipPath), { recursive: true });
    fs.mkdirSync(path.dirname(bootstrapAgentPath), { recursive: true });
    fs.mkdirSync(path.dirname(providerPath), { recursive: true });
    fs.mkdirSync(path.dirname(ownerPath), { recursive: true });
    fs.writeFileSync(bootstrapAgentPath, "modelKey: stale-openai\n", "utf8");
    fs.writeFileSync(
      providerPath,
      [
        "key: minimax",
        "baseUrl: https://old.example.com",
        "apiKey: real-user-key",
        "defaultModel: stale-model",
        ""
      ].join("\n"),
      "utf8"
    );
    fs.writeFileSync(ownerPath, "name: keep-user-owner\n", "utf8");

    await writeZip(bundledZipPath, {
      "env/VERSION": DESKTOP_VERSION,
      "env/agents/bootstrap/agent.yml": "modelKey: th-minimax-m2_7-highspeed\n",
      "env/registries/providers/minimax.yml": [
        "key: minimax",
        "baseUrl: https://api.minimaxi.com",
        "apiKey: YOUR_API_KEY",
        "defaultModel: minimax-m3",
        ""
      ].join("\n"),
      "env/registries/models/th-minimax.yml": "provider: th-minimax\n",
      "env/owner/profile.yml": "name: bundled-owner\n"
    });

    const result = await importBundledEnvZipToRuntime(app, platform, {
      resourcesRoot,
      expectedDesktopVersion: DESKTOP_VERSION
    });

    assert.equal(result?.sourceZipPath, bundledZipPath);
    assert.equal(fs.readFileSync(bootstrapAgentPath, "utf8"), "modelKey: stale-openai\n");
    assert.equal(
      fs.readFileSync(providerPath, "utf8"),
      [
        "key: minimax",
        "baseUrl: https://old.example.com",
        "apiKey: real-user-key",
        "defaultModel: stale-model",
        ""
      ].join("\n")
    );
    assert.equal(fs.readFileSync(modelPath, "utf8"), "provider: th-minimax\n");
    assert.equal(fs.readFileSync(ownerPath, "utf8"), "name: keep-user-owner\n");
    assert.equal(result?.copiedFiles, 2);
    assert.equal(result?.skippedFiles, 3);
    assert.equal(result?.overwrittenFiles, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bundled env.zip leaves owner bootstrap files in place", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bootstrap-owner-unchanged-"));
  const app = createApp(root);
  const resourcesRoot = path.join(root, "resources");
  const bundledZipPath = path.join(resourcesRoot, "env", "env.zip");
  const runtimeRoot = path.join(root, "home", ".zenmind");
  const bootstrapPath = path.join(runtimeRoot, "owner", "BOOTSTRAP.md");
  const ownerPath = path.join(runtimeRoot, "owner", "OWNER.md");

  try {
    fs.mkdirSync(path.dirname(bundledZipPath), { recursive: true });
    fs.mkdirSync(path.dirname(bootstrapPath), { recursive: true });
    fs.writeFileSync(bootstrapPath, "# Bootstrap\n\nAsk the user to create OWNER.md.\n", "utf8");
    fs.writeFileSync(ownerPath, "# Owner\n\nname: keep-user-owner\n", "utf8");

    await writeZip(bundledZipPath, {
      "env/VERSION": DESKTOP_VERSION,
      "env/owner/BOOTSTRAP.md": "# Bundled bootstrap\n"
    });

    await importBundledEnvZipToRuntime(app, "win32", {
      resourcesRoot,
      expectedDesktopVersion: DESKTOP_VERSION
    });

    assert.equal(fs.existsSync(bootstrapPath), true);
    assert.equal(fs.readFileSync(bootstrapPath, "utf8"), "# Bootstrap\n\nAsk the user to create OWNER.md.\n");
    assert.equal(fs.readFileSync(ownerPath, "utf8"), "# Owner\n\nname: keep-user-owner\n");
    assert.equal(fs.existsSync(path.join(runtimeRoot, ".desktop", "state", "desktop", "owner-bootstrap.completed.md")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resetBundledRuntimeEnv backs up macOS runtime root with timestamp and imports bundled env.zip", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bootstrap-reset-mac-"));
  const app = createApp(root);
  const resourcesRoot = path.join(root, "resources");
  const bundledZipPath = path.join(resourcesRoot, "env", "env.zip");
  const runtimeRoot = path.join(root, "home", ".zenmind");
  const oldFilePath = path.join(runtimeRoot, "agents", "old", "agent.yml");
  const newFilePath = path.join(runtimeRoot, "agents", "demo", "agent.yml");

  try {
    fs.mkdirSync(path.dirname(bundledZipPath), { recursive: true });
    fs.mkdirSync(path.dirname(oldFilePath), { recursive: true });
    fs.writeFileSync(oldFilePath, "name: old\n", "utf8");
    await writeZip(bundledZipPath, {
      "env/VERSION": `v${DESKTOP_VERSION}\n`,
      "env/agents/demo/agent.yml": "name: demo\n"
    });

    const result = await resetBundledRuntimeEnv(app, "darwin", {
      resourcesRoot,
      expectedDesktopVersion: DESKTOP_VERSION,
      nowSeconds: 1_778_899_101
    });

    assert.equal(result.targetRoot, runtimeRoot);
    assert.equal(result.backupPath, `${runtimeRoot}-1778899101`);
    assert.equal(result.sourceZipPath, bundledZipPath);
    assert.equal(fs.existsSync(path.join(result.backupPath, "agents", "old", "agent.yml")), true);
    assert.equal(fs.readFileSync(path.join(result.backupPath, "agents", "old", "agent.yml"), "utf8"), "name: old\n");
    assert.equal(fs.existsSync(oldFilePath), false);
    assert.equal(fs.readFileSync(newFilePath, "utf8"), "name: demo\n");
    assert.equal(fs.readFileSync(path.join(runtimeRoot, "VERSION"), "utf8"), `v${DESKTOP_VERSION}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resetBundledRuntimeEnv uses Windows runtime root and timestamp collision suffixes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bootstrap-reset-win-"));
  const app = createApp(root);
  const resourcesRoot = path.join(root, "resources");
  const bundledZipPath = path.join(resourcesRoot, "env", "env.zip");
  const runtimeRoot = path.join(root, "home", ".zenmind");
  const collidingBackupPath = `${runtimeRoot}-1778899102`;

  try {
    fs.mkdirSync(path.dirname(bundledZipPath), { recursive: true });
    fs.mkdirSync(path.join(runtimeRoot, "old-data"), { recursive: true });
    fs.mkdirSync(collidingBackupPath, { recursive: true });
    await writeZip(bundledZipPath, {
      "env/VERSION": DESKTOP_VERSION,
      "env/registries/providers/demo.yml": "name: provider\n"
    });

    const result = await resetBundledRuntimeEnv(app, "win32", {
      resourcesRoot,
      expectedDesktopVersion: DESKTOP_VERSION,
      nowSeconds: 1_778_899_102
    });

    assert.equal(result.targetRoot, runtimeRoot);
    assert.equal(result.backupPath, `${runtimeRoot}-1778899102-1`);
    assert.equal(fs.existsSync(collidingBackupPath), true);
    assert.equal(fs.existsSync(path.join(result.backupPath, "old-data")), true);
    assert.equal(
      fs.readFileSync(path.join(runtimeRoot, "registries", "providers", "demo.yml"), "utf8"),
      "name: provider\n"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resetBundledRuntimeEnv rejects missing bundled env.zip without moving runtime root", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bootstrap-reset-missing-"));
  const app = createApp(root);
  const resourcesRoot = path.join(root, "resources");
  const runtimeRoot = path.join(root, "home", ".zenmind");
  const oldFilePath = path.join(runtimeRoot, "agents", "old", "agent.yml");

  try {
    fs.mkdirSync(path.dirname(oldFilePath), { recursive: true });
    fs.writeFileSync(oldFilePath, "name: old\n", "utf8");

    await assert.rejects(
      () => resetBundledRuntimeEnv(app, "darwin", {
        resourcesRoot,
        expectedDesktopVersion: DESKTOP_VERSION,
        nowSeconds: 1_778_899_103
      }),
      /内置 env\.zip 不存在/
    );
    assert.equal(fs.readFileSync(oldFilePath, "utf8"), "name: old\n");
    assert.equal(fs.existsSync(`${runtimeRoot}-1778899103`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resetBundledRuntimeEnv rejects unsupported platforms", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bootstrap-reset-linux-"));
  const app = createApp(root);

  try {
    await assert.rejects(
      () => resetBundledRuntimeEnv(app, "linux", {
        resourcesRoot: path.join(root, "resources"),
        expectedDesktopVersion: DESKTOP_VERSION
      }),
      /不支持/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resetBundledRuntimeEnv keeps timestamped backup metadata when bundled import fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bootstrap-reset-failure-"));
  const app = createApp(root);
  const resourcesRoot = path.join(root, "resources");
  const bundledZipPath = path.join(resourcesRoot, "env", "env.zip");
  const runtimeRoot = path.join(root, "home", ".zenmind");
  const oldFilePath = path.join(runtimeRoot, "agents", "old", "agent.yml");

  try {
    fs.mkdirSync(path.dirname(bundledZipPath), { recursive: true });
    fs.mkdirSync(path.dirname(oldFilePath), { recursive: true });
    fs.writeFileSync(oldFilePath, "name: old\n", "utf8");
    await writeZip(bundledZipPath, {
      "env/VERSION": "v9.9.9\n",
      "env/agents/demo/agent.yml": "name: demo\n"
    });

    try {
      await resetBundledRuntimeEnv(app, "darwin", {
        resourcesRoot,
        expectedDesktopVersion: DESKTOP_VERSION,
        nowSeconds: 1_778_899_104
      });
      assert.fail("reset should reject when bundled env.zip VERSION mismatches");
    } catch (error) {
      assert.match(error instanceof Error ? error.message : String(error), /VERSION 不匹配/);
      assert.equal(error.backupPath, `${runtimeRoot}-1778899104`);
      assert.equal(error.runtimeRoot, runtimeRoot);
      assert.equal(error.sourceZipPath, bundledZipPath);
    }

    assert.equal(fs.existsSync(runtimeRoot), false);
    assert.equal(fs.readFileSync(`${runtimeRoot}-1778899104/agents/old/agent.yml`, "utf8"), "name: old\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("importEnvZipToRuntime rejects env.zip without VERSION", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bootstrap-missing-version-"));
  const app = createApp(root);
  const zipPath = path.join(root, "env.zip");

  try {
    await writeZip(zipPath, {
      "env/agents/demo/agent.yml": "name: demo\n"
    });

    await assert.rejects(
      () => importEnvZipToRuntime(app, zipPath, "darwin", DESKTOP_VERSION),
      /缺少 VERSION 文件/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("importEnvZipToRuntime rejects mismatched env VERSION", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bootstrap-version-mismatch-"));
  const app = createApp(root);
  const zipPath = path.join(root, "env.zip");

  try {
    await writeZip(zipPath, {
      "env/VERSION": "v9.9.9\n",
      "env/agents/demo/agent.yml": "name: demo\n"
    });

    await assert.rejects(
      () => importEnvZipToRuntime(app, zipPath, "darwin", DESKTOP_VERSION),
      /VERSION 不匹配/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveDesktopVersion prefers app root VERSION before workspace VERSION", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bootstrap-desktop-version-"));

  try {
    fs.writeFileSync(path.join(root, "VERSION"), "v3.4.5\n", "utf8");
    assert.equal(
      resolveDesktopVersion({
        getAppPath: () => root,
        getVersion: () => "1.2.3"
      }),
      "3.4.5"
    );
    assert.equal(
      resolveDesktopVersion({
        getAppPath: () => path.join(root, "missing"),
        getVersion: () => "v1.2.3"
      }),
      DESKTOP_VERSION
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows env.zip target root is the user .zenmind directory", () => {
  const app = {
    getPath(name) {
      if (name === "home") {
        return String.raw`C:\Users\alice`;
      }
      assert.fail(`unexpected app.getPath(${name})`);
    }
  };

  assert.equal(resolveRuntimeRoot(app, "win32"), String.raw`C:\Users\alice\.zenmind`);
});

test("Windows env.zip test fixtures keep POSIX temp homes inside the fixture", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bootstrap-win-posix-home-"));
  const app = createApp(root);

  try {
    assert.equal(resolveRuntimeRoot(app, "win32"), path.join(root, "home", ".zenmind"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("macOS env.zip target root stays in the POSIX user home", () => {
  const app = {
    getPath(name) {
      if (name === "home") {
        return "/Users/alice";
      }
      assert.fail(`unexpected app.getPath(${name})`);
    }
  };

  assert.equal(resolveRuntimeRoot(app, "darwin"), "/Users/alice/.zenmind");
});

test("macOS generateBackupDirName creates .zenmind-<timestamp> backup path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bootstrap-backup-"));
  const runtimeRoot = path.join(root, "home", ".zenmind");
  fs.mkdirSync(runtimeRoot, { recursive: true });

  try {
    const backupPath = generateBackupDirName(runtimeRoot, "darwin", 1_778_899_001);
    assert.equal(backupPath, `${runtimeRoot}-1778899001`);
    assert.equal(fs.existsSync(backupPath), false, "backup path should not already exist");
    assert.ok(fs.existsSync(runtimeRoot), "original dir should still exist");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generateBackupDirName appends -1, -2 on collision without overwriting", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bootstrap-collision-"));
  const runtimeRoot = path.join(root, "home", ".zenmind");
  fs.mkdirSync(runtimeRoot, { recursive: true });

  const backup1 = generateBackupDirName(runtimeRoot, "darwin", 1_778_899_002);
  fs.mkdirSync(backup1, { recursive: true });

  const backup2 = generateBackupDirName(runtimeRoot, "darwin", 1_778_899_002);

  try {
    assert.equal(backup2, `${runtimeRoot}-1778899002-1`);
    assert.equal(fs.existsSync(backup1), true, "backup1 should still exist");
    assert.equal(fs.existsSync(backup2), false, "backup2 should not exist yet");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows generateBackupDirName uses win32 separators", () => {
  const runtimeRoot = String.raw`C:\Users\alice\.zenmind`;
  const backupPath = generateBackupDirName(runtimeRoot, "win32", 1_778_899_003);

  assert.equal(backupPath, String.raw`C:\Users\alice\.zenmind-1778899003`);
});

test("migrateOldRootToBackup renames existing .zenmind and returns backup path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bootstrap-rename-"));
  const runtimeRoot = path.join(root, "home", ".zenmind");
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "VERSION"), "0.2.6\n", "utf8");

  try {
    const backupPath = `${runtimeRoot}-backup`;
    assert.equal(migrateOldRootToBackup("darwin", runtimeRoot, backupPath), backupPath);
    assert.equal(fs.existsSync(runtimeRoot), false, "original dir should no longer exist");
    assert.equal(fs.existsSync(backupPath), true, "backup dir should exist");
    assert.equal(fs.readFileSync(path.join(backupPath, "VERSION"), "utf8"), "0.2.6\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows migrateOldRootToBackup keeps POSIX temp fixtures inside the fixture", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bootstrap-windows-"));
  const runtimeRoot = path.join(root, "home", ".zenmind");
  fs.mkdirSync(runtimeRoot, { recursive: true });

  try {
    const backupPath = generateBackupDirName(runtimeRoot, "win32", 1_778_899_004);
    assert.equal(backupPath, `${runtimeRoot}-1778899004`);
    assert.equal(migrateOldRootToBackup("win32", runtimeRoot, backupPath), backupPath);
    assert.equal(fs.existsSync(runtimeRoot), false, "original dir should no longer exist");
    assert.equal(fs.existsSync(backupPath), true, "backup dir should exist");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("shouldPromptEnvRootConflict only prompts for first install with bundled env.zip and preexisting root", () => {
  assert.equal(
    shouldPromptEnvRootConflict({
      platform: "darwin",
      isFirstDesktopInstall: true,
      bundledEnvZipExists: true,
      runtimeRootExistedAtStartup: true
    }),
    true
  );
  assert.equal(
    shouldPromptEnvRootConflict({
      platform: "win32",
      isFirstDesktopInstall: true,
      bundledEnvZipExists: true,
      runtimeRootExistedAtStartup: true
    }),
    true
  );
  assert.equal(
    shouldPromptEnvRootConflict({
      platform: "darwin",
      isFirstDesktopInstall: false,
      bundledEnvZipExists: true,
      runtimeRootExistedAtStartup: true
    }),
    false
  );
  assert.equal(
    shouldPromptEnvRootConflict({
      platform: "darwin",
      isFirstDesktopInstall: true,
      bundledEnvZipExists: false,
      runtimeRootExistedAtStartup: true
    }),
    false
  );
  assert.equal(
    shouldPromptEnvRootConflict({
      platform: "darwin",
      isFirstDesktopInstall: true,
      bundledEnvZipExists: true,
      runtimeRootExistedAtStartup: false
    }),
    false
  );
  assert.equal(
    shouldPromptEnvRootConflict({
      platform: "linux",
      isFirstDesktopInstall: true,
      bundledEnvZipExists: true,
      runtimeRootExistedAtStartup: true
    }),
    false
  );
});

test("shouldPromptEnvRootConflict prompts even when old root already contains runtime env", () => {
  assert.equal(
    shouldPromptEnvRootConflict({
      platform: "darwin",
      isFirstDesktopInstall: true,
      bundledEnvZipExists: true,
      runtimeRootExistedAtStartup: true
    }),
    true
  );
});

test("after migration env.zip can be imported into the new empty .zenmind", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bootstrap-migrate-import-"));
  const app = createApp(root);
  const runtimeRoot = path.join(root, "home", ".zenmind");
  const zipPath = path.join(root, "env.zip");

  // Simulate old directory with content
  fs.mkdirSync(path.join(runtimeRoot, "old-data"), { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "VERSION"), "0.2.5\n", "utf8");

  const backupPath = migrateOldRootToBackup("darwin", runtimeRoot, `${runtimeRoot}-backup`);

  // Now import env.zip into clean .zenmind
  try {
    await writeZip(zipPath, {
      "env/VERSION": `v${DESKTOP_VERSION}\n`,
      "env/agents/demo/agent.yml": "name: demo\n"
    });

    const result = await importEnvZipToRuntime(app, zipPath, "darwin", DESKTOP_VERSION);

    assert.equal(result.targetRoot, runtimeRoot);
    assert.equal(fs.readFileSync(path.join(runtimeRoot, "VERSION"), "utf8"), `v${DESKTOP_VERSION}\n`);
    assert.equal(fs.readFileSync(path.join(runtimeRoot, "agents", "demo", "agent.yml"), "utf8"), "name: demo\n");
    assert.equal(fs.existsSync(backupPath), true);
    assert.equal(fs.readFileSync(path.join(backupPath, "VERSION"), "utf8"), "0.2.5\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
