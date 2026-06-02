import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const JSZip = require("jszip");
const {
  homeZenmindEnvExists,
  importEnvZipToZenmind,
  resolveDesktopVersion,
  resolveHomeZenmindRoot,
  shouldRequireEnvZipImport
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
  const homeZenmindRoot = path.join(root, "home", ".zenmind");

  try {
    fs.mkdirSync(path.join(homeZenmindRoot, ".desktop", "profiles", "electron"), { recursive: true });

    assert.equal(homeZenmindEnvExists(app, "darwin"), false);
    assert.equal(
      shouldRequireEnvZipImport({
        platform: "darwin",
        homeZenmindEnvExistedAtStartup: homeZenmindEnvExists(app, "darwin")
      }),
      true
    );
    assert.equal(
      shouldRequireEnvZipImport({
        platform: "win32",
        homeZenmindEnvExistedAtStartup: false
      }),
      true
    );

    fs.mkdirSync(path.join(homeZenmindRoot, "registries"), { recursive: true });
    assert.equal(homeZenmindEnvExists(app, "darwin"), true);
    assert.equal(
      shouldRequireEnvZipImport({
        platform: "linux",
        homeZenmindEnvExistedAtStartup: false
      }),
      false
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("importEnvZipToZenmind strips env wrapper and only copies missing files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bootstrap-import-"));
  const app = createApp(root);
  const homeZenmindRoot = path.join(root, "home", ".zenmind");
  const zipPath = path.join(root, "env.zip");
  const existingAgentPath = path.join(homeZenmindRoot, "agents", "demo", "agent.yml");
  const registryPath = path.join(homeZenmindRoot, "registries", "providers", "demo.yml");
  const markerPath = path.join(homeZenmindRoot, ".desktop", "state", "desktop", "env-bootstrap.json");

  try {
    fs.mkdirSync(path.dirname(existingAgentPath), { recursive: true });
    fs.writeFileSync(existingAgentPath, "name: keep\n", "utf8");
    await writeZip(zipPath, {
      ".zenmind/VERSION": `v${DESKTOP_VERSION}\n`,
      ".zenmind/agents/demo/agent.yml": "name: overwrite\n",
      ".zenmind/registries/providers/demo.yml": "name: provider\n",
      "__MACOSX/._agent.yml": "ignored",
      ".zenmind/.DS_Store": "ignored"
    });

    const result = await importEnvZipToZenmind(app, zipPath, "darwin", DESKTOP_VERSION);

    assert.equal(result.targetRoot, homeZenmindRoot);
    assert.equal(result.copiedFiles, 2);
    assert.equal(result.skippedFiles, 1);
    assert.equal(fs.readFileSync(existingAgentPath, "utf8"), "name: keep\n");
    assert.equal(fs.readFileSync(path.join(homeZenmindRoot, "VERSION"), "utf8"), `v${DESKTOP_VERSION}\n`);
    assert.equal(fs.readFileSync(registryPath, "utf8"), "name: provider\n");
    assert.equal(fs.existsSync(path.join(homeZenmindRoot, ".zenmind")), false);
    assert.equal(fs.existsSync(markerPath), true);
    assert.equal(homeZenmindEnvExists(app, "darwin"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("importEnvZipToZenmind strips timestamped zenmind-env wrapper", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bootstrap-timestamp-"));
  const app = createApp(root);
  const homeZenmindRoot = path.join(root, "home", ".zenmind");
  const zipPath = path.join(root, "env.zip");
  const providerPath = path.join(homeZenmindRoot, "registries", "providers", "demo.yml");
  const panPath = path.join(homeZenmindRoot, "pan", ".gitkeep");

  try {
    await writeZip(zipPath, {
      "zenmind-env-20260516-220857/VERSION": DESKTOP_VERSION,
      "zenmind-env-20260516-220857/registries/providers/demo.yml": "name: provider\n",
      "zenmind-env-20260516-220857/pan/.gitkeep": ""
    });

    const result = await importEnvZipToZenmind(app, zipPath, "darwin", `v${DESKTOP_VERSION}`);

    assert.equal(result.targetRoot, homeZenmindRoot);
    assert.equal(fs.readFileSync(providerPath, "utf8"), "name: provider\n");
    assert.equal(fs.existsSync(panPath), true);
    assert.equal(fs.existsSync(path.join(homeZenmindRoot, "zenmind-env-20260516-220857")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("importEnvZipToZenmind accepts env VERSION without v prefix", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bootstrap-version-prefix-"));
  const app = createApp(root);
  const zipPath = path.join(root, "env.zip");
  const agentPath = path.join(root, "home", ".zenmind", "agents", "demo", "agent.yml");

  try {
    await writeZip(zipPath, {
      "env/VERSION": DESKTOP_VERSION,
      "env/agents/demo/agent.yml": "name: demo\n"
    });

    await importEnvZipToZenmind(app, zipPath, "darwin", `v${DESKTOP_VERSION}`);

    assert.equal(fs.readFileSync(agentPath, "utf8"), "name: demo\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("importEnvZipToZenmind rejects env.zip without VERSION", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bootstrap-missing-version-"));
  const app = createApp(root);
  const zipPath = path.join(root, "env.zip");

  try {
    await writeZip(zipPath, {
      ".zenmind/agents/demo/agent.yml": "name: demo\n"
    });

    await assert.rejects(
      () => importEnvZipToZenmind(app, zipPath, "darwin", DESKTOP_VERSION),
      /缺少 VERSION 文件/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("importEnvZipToZenmind rejects mismatched env VERSION", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-env-bootstrap-version-mismatch-"));
  const app = createApp(root);
  const zipPath = path.join(root, "env.zip");

  try {
    await writeZip(zipPath, {
      ".zenmind/VERSION": "v9.9.9\n",
      ".zenmind/agents/demo/agent.yml": "name: demo\n"
    });

    await assert.rejects(
      () => importEnvZipToZenmind(app, zipPath, "darwin", DESKTOP_VERSION),
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

  assert.equal(resolveHomeZenmindRoot(app, "win32"), String.raw`C:\Users\alice\.zenmind`);
});
