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
const {
  DEFAULT_MARKETPLACE_CATALOG_URL,
  installMarketItem,
  listMarketItems,
  refreshMarketCatalog,
  uninstallMarketItem
} = require("../dist-electron/main/marketplace.js");
const { getPluginInstallDir } = require("../dist-electron/main/plugin-loader.js");
const { getSkillInstallDir } = require("../dist-electron/main/skill-installer.js");
const { __testInternals: registryInternals } = require("../dist-electron/main/service-registry.js");

function createApp(root) {
  return {
    isPackaged: false,
    getPath(name) {
      if (name === "userData") return path.join(root, "user-data");
      if (name === "home") return path.join(root, "home");
      if (name === "desktop") return path.join(root, "home", "Desktop");
      throw new Error(`unexpected getPath(${name})`);
    }
  };
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writePluginArchive(root, options = {}) {
  const pluginId = options.id ?? "cloud-plugin";
  const fixtureRoot = path.join(root, `fixture-${pluginId}`);
  const bundleRoot = path.join(fixtureRoot, pluginId);
  const archivePath = path.join(root, `${pluginId}.tar.gz`);
  fs.mkdirSync(path.join(bundleRoot, "run"), { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, ".env.example"), "PORT=9300\n", "utf8");
  fs.writeFileSync(
    path.join(bundleRoot, "manifest.json"),
    `${JSON.stringify({
      id: pluginId,
      name: "Cloud Plugin",
      kind: options.kind ?? "plugin",
      version: "1.0.0",
      description: "Cloud plugin",
      frontend: { mode: "none" },
      scripts: { start: "start.sh", stop: "stop.sh" },
      runtime: {
        pidRelativePath: "run/cloud-plugin.pid",
        logRelativePath: "run/cloud-plugin.log",
        requiredPaths: ["manifest.json", "start.sh", "stop.sh", ".env.example", "run"]
      },
      web: { routePath: "", portEnvKey: "PORT", defaultPort: 9300 }
    }, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(path.join(bundleRoot, "start.sh"), "#!/usr/bin/env bash\necho start\n", "utf8");
  fs.writeFileSync(path.join(bundleRoot, "stop.sh"), "#!/usr/bin/env bash\necho stop\n", "utf8");
  execFileSync("tar", ["-czf", archivePath, "-C", fixtureRoot, pluginId]);
  return archivePath;
}

function writeSkillArchive(root, options = {}) {
  const skillId = options.id ?? "cloud-skill";
  const fixtureRoot = path.join(root, `fixture-${skillId}`);
  const skillRoot = path.join(fixtureRoot, skillId);
  const archivePath = path.join(root, `${skillId}.tar.gz`);
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
  execFileSync("tar", ["-czf", archivePath, "-C", fixtureRoot, skillId]);
  return archivePath;
}

async function withFixtureServer(files, fn) {
  const server = http.createServer((req, res) => {
    const requestPath = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const file = files.get(requestPath);
    if (!file) {
      res.statusCode = 404;
      res.end("not found");
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

test("DEFAULT_MARKETPLACE_CATALOG_URL points at the RustFS marketplace catalog", () => {
  assert.equal(DEFAULT_MARKETPLACE_CATALOG_URL, "http://47.100.131.144:9001/marketplace/index.json");
});

test("refreshMarketCatalog reads a remote catalog and listMarketItems returns install states", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-list-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await withFixtureServer(new Map(), async (baseUrl) => {
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
              url: `${baseUrl}/remote-skill.tar.gz`,
              sha256: "0".repeat(64),
              sizeBytes: 1,
              archiveType: "tar.gz"
            }
          }
        }
      ]
    });
    const files = new Map([["/marketplace/index.json", catalog]]);
    await withFixtureServer(files, async (catalogBaseUrl) => {
      const catalogUrl = `${catalogBaseUrl}/marketplace/index.json`;
      const refreshed = await refreshMarketCatalog(app, { catalogUrl });
      const listed = await listMarketItems(app, { catalogUrl });

      assert.equal(refreshed.ok, true);
      assert.equal(listed.ok, true);
      assert.equal(listed.items.length, 1);
      assert.equal(listed.items[0].id, "remote-skill");
      assert.equal(listed.items[0].type, "skill");
      assert.equal(listed.items[0].state, "not-installed");
    });
  });
});

test("listMarketItems falls back to cached catalog when the remote catalog is unavailable", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-cache-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const catalog = JSON.stringify({
    schemaVersion: 1,
    items: [
      {
        id: "cached-skill",
        type: "skill",
        name: "Cached Skill",
        version: "1.0.0",
        description: "Cached skill",
        tags: [],
        assets: {}
      }
    ]
  });

  await withFixtureServer(new Map([["/marketplace/index.json", catalog]]), async (baseUrl) => {
    await refreshMarketCatalog(app, { catalogUrl: `${baseUrl}/marketplace/index.json` });
  });

  const result = await listMarketItems(app, { catalogUrl: "http://127.0.0.1:1/missing.json" });
  assert.equal(result.ok, true);
  assert.equal(result.offline, true);
  assert.equal(result.items[0].id, "cached-skill");
});

test("installMarketItem downloads and installs cloud skills", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-skill-install-"));
  const app = createApp(root);
  const archivePath = writeSkillArchive(root, { id: "cloud-skill" });
  const archiveBytes = fs.readFileSync(archivePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await withFixtureServer(new Map([["/cloud-skill.tar.gz", archiveBytes]]), async (baseUrl) => {
    const catalog = {
      schemaVersion: 1,
      items: [
        {
          id: "cloud-skill",
          type: "skill",
          name: "Cloud Skill",
          version: "1.0.0",
          description: "Cloud skill",
          tags: ["cloud"],
          assets: {
            universal: {
              url: `${baseUrl}/cloud-skill.tar.gz`,
              sha256: sha256(archivePath),
              sizeBytes: archiveBytes.length,
              archiveType: "tar.gz"
            }
          }
        }
      ]
    };
    const result = await installMarketItem(app, "cloud-skill", { catalog });

    assert.equal(result.ok, true);
    assert.equal(result.type, "skill");
    assert.equal(result.state, "installed");
    assert.equal(fs.existsSync(path.join(getSkillInstallDir(app, "cloud-skill"), "SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(root, "home", ".codex", "skills")), false);
  });
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

  await withFixtureServer(new Map([["/cloud-builtin.tar.gz", archiveBytes]]), async (baseUrl) => {
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
              url: `${baseUrl}/cloud-builtin.tar.gz`,
              sha256: sha256(archivePath),
              sizeBytes: archiveBytes.length,
              archiveType: "tar.gz"
            }
          }
        }
      ]
    };

    await assert.rejects(
      () => installMarketItem(app, "cloud-builtin", { catalog }),
      /云端插件包必须声明 kind=plugin/
    );
    assert.equal(fs.existsSync(getPluginInstallDir(app, "cloud-builtin")), false);
  });
});

test("uninstallMarketItem removes skill installs and marketplace records", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-uninstall-"));
  const app = createApp(root);
  const archivePath = writeSkillArchive(root, { id: "remove-skill" });
  const archiveBytes = fs.readFileSync(archivePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await withFixtureServer(new Map([["/remove-skill.tar.gz", archiveBytes]]), async (baseUrl) => {
    const catalog = {
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
              url: `${baseUrl}/remove-skill.tar.gz`,
              sha256: sha256(archivePath),
              sizeBytes: archiveBytes.length,
              archiveType: "tar.gz"
            }
          }
        }
      ]
    };
    await installMarketItem(app, "remove-skill", { catalog });
    const result = await uninstallMarketItem(app, "remove-skill", { catalog });

    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(getSkillInstallDir(app, "remove-skill")), false);
    const listed = await listMarketItems(app, { catalog });
    assert.equal(listed.items.find((item) => item.id === "remove-skill")?.state, "not-installed");
  });
});
