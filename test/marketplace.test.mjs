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
  buildSandboxImage,
  DEFAULT_MARKETPLACE_CATALOG_URL,
  DEFAULT_SKILLS_API_BASE_URL,
  getMarketSettings,
  installMarketItem,
  listMarketItems,
  refreshMarketCatalog,
  saveMarketSettings,
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

function writeRootSkillArchive(root, options = {}) {
  const skillId = options.id ?? "root-skill";
  const fixtureRoot = path.join(root, `fixture-${skillId}`);
  const archivePath = path.join(root, `${skillId}.tar.gz`);
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, "SKILL.md"), `# ${skillId}\n\nRoot skill.\n`, "utf8");
  execFileSync("tar", ["-czf", archivePath, "-C", fixtureRoot, "SKILL.md"]);
  return archivePath;
}

function skillsEnvelope(items, pagination = {}) {
  return JSON.stringify({
    success: true,
    data: items,
    pagination: {
      page: pagination.page ?? 1,
      limit: pagination.limit ?? items.length,
      total: pagination.total ?? items.length
    }
  });
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

test("DEFAULT_MARKETPLACE_CATALOG_URL points at the RustFS marketplace catalog", () => {
  assert.equal(DEFAULT_MARKETPLACE_CATALOG_URL, "http://47.100.131.144:9001/marketplace/index.json");
  assert.equal(DEFAULT_SKILLS_API_BASE_URL, "http://127.0.0.1:8080");
});

test("refreshMarketCatalog combines catalog plugins with Skills API skills", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-list-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await withFixtureServer(new Map([[
    "/api/v1/skills?page=1&limit=100",
    skillsEnvelope([
      {
        id: 1,
        name: "remote-skill",
        display_name: "Remote Skill",
        description: "Remote skill",
        latest_version: "1.0.0",
        tags: ["remote"],
        status: "active"
      }
    ])
  ]]), async (skillsBaseUrl) => {
    const catalog = JSON.stringify({
      schemaVersion: 1,
      items: [
        {
          id: "old-catalog-skill",
          type: "skill",
          name: "Old Catalog Skill",
          version: "1.0.0",
          description: "Should be ignored",
          tags: [],
          assets: {}
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
      const refreshed = await refreshMarketCatalog(app, { catalogUrl, skillsApiBaseUrl: skillsBaseUrl });
      const listed = await listMarketItems(app, { catalogUrl, skillsApiBaseUrl: skillsBaseUrl });

      assert.equal(refreshed.ok, true);
      assert.equal(listed.ok, true);
      assert.equal(listed.items.some((item) => item.id === "old-catalog-skill"), false);
      assert.equal(listed.items.find((item) => item.id === "remote-skill")?.type, "skill");
      assert.equal(listed.items.find((item) => item.id === "remote-skill")?.state, "not-installed");
      assert.equal(listed.items.find((item) => item.id === "remote-plugin")?.type, "plugin");
    });
  });
});

test("listMarketItems reads all Skills API pages", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-pages-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await withFixtureServer(new Map([
    ["/api/v1/skills?page=1&limit=100", skillsEnvelope([
      { name: "first-skill", display_name: "First Skill", description: "First", latest_version: "1.0.0" }
    ], { page: 1, limit: 1, total: 2 })],
    ["/api/v1/skills?page=2&limit=100", skillsEnvelope([
      { name: "second-skill", display_name: "Second Skill", description: "Second", latest_version: "1.0.0" }
    ], { page: 2, limit: 1, total: 2 })]
  ]), async (skillsBaseUrl) => {
    const result = await listMarketItems(app, {
      catalog: { schemaVersion: 1, items: [] },
      skillsApiBaseUrl: skillsBaseUrl
    });

    assert.equal(result.items.filter((item) => item.type === "skill").length, 2);
    assert.ok(result.items.some((item) => item.id === "first-skill"));
    assert.ok(result.items.some((item) => item.id === "second-skill"));
  });
});

test("listMarketItems maps Container Hub environments into sandbox image market items", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-sandbox-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await withFixtureServer(new Map([
    ["/api/v1/skills?page=1&limit=100", skillsEnvelope([])],
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
      skillsApiBaseUrl: baseUrl,
      containerHubBaseUrl: baseUrl
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

test("listMarketItems falls back to cached catalog when the remote catalog is unavailable", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-cache-"));
  const app = createApp(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const catalog = JSON.stringify({
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
  });

  await withFixtureServer(new Map([["/marketplace/index.json", catalog]]), async (baseUrl) => {
    await refreshMarketCatalog(app, {
      catalogUrl: `${baseUrl}/marketplace/index.json`,
      skillsApiBaseUrl: "http://127.0.0.1:1"
    });
  });

  const result = await listMarketItems(app, {
    catalogUrl: "http://127.0.0.1:1/missing.json",
    skillsApiBaseUrl: "http://127.0.0.1:1"
  });
  assert.equal(result.ok, true);
  assert.equal(result.offline, true);
  assert.equal(result.items[0].id, "cached-plugin");
});

test("installMarketItem downloads and installs Skills API cloud skills", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-skill-install-"));
  const app = createApp(root);
  const archivePath = writeRootSkillArchive(root, { id: "cloud-skill" });
  const archiveBytes = fs.readFileSync(archivePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await withFixtureServer(new Map([
    ["/api/v1/skills?page=1&limit=100", skillsEnvelope([
      {
        name: "cloud-skill",
        display_name: "Cloud Skill",
        description: "Cloud skill",
        latest_version: "1.0.0",
        tags: ["cloud"]
      }
    ])],
    ["/api/v1/skills/cloud-skill/download?version=1.0.0", archiveBytes]
  ]), async (skillsBaseUrl) => {
    const result = await installMarketItem(app, "cloud-skill", {
      catalog: {
        schemaVersion: 1,
        items: [
          {
            id: "catalog-plugin",
            type: "plugin",
            name: "Catalog Plugin",
            version: "1.0.0",
            description: "Catalog plugin",
            tags: [],
            assets: {}
          }
        ]
      },
      skillsApiBaseUrl: skillsBaseUrl
    });

    assert.equal(result.ok, true);
    assert.equal(result.type, "skill");
    assert.equal(result.state, "installed");
    assert.equal(fs.existsSync(path.join(getSkillInstallDir(app, "cloud-skill"), "SKILL.md")), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(getSkillInstallDir(app, "cloud-skill"), "skill.json"), "utf8")).name, "Cloud Skill");
    assert.equal(fs.existsSync(path.join(root, "home", ".codex", "skills")), false);
  });
});

test("saved skillsApiBaseUrl is used by list and install", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-market-settings-"));
  const app = createApp(root);
  const archivePath = writeRootSkillArchive(root, { id: "saved-skill" });
  const archiveBytes = fs.readFileSync(archivePath);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await withFixtureServer(new Map([
    ["/api/v1/skills?page=1&limit=100", skillsEnvelope([
      { name: "saved-skill", display_name: "Saved Skill", description: "Saved", latest_version: "1.0.0" }
    ])],
    ["/api/v1/skills/saved-skill/download?version=1.0.0", archiveBytes]
  ]), async (skillsBaseUrl) => {
    const settings = saveMarketSettings(app, { skillsApiBaseUrl: `${skillsBaseUrl}/api/v1` });
    assert.equal(settings.skillsApiBaseUrl, `${skillsBaseUrl}/api/v1`);
    assert.equal(getMarketSettings(app).skillsApiBaseUrl, `${skillsBaseUrl}/api/v1`);

    const listed = await listMarketItems(app, { catalog: { schemaVersion: 1, items: [] } });
    assert.equal(listed.items.find((item) => item.id === "saved-skill")?.name, "Saved Skill");

    const result = await installMarketItem(app, "saved-skill", { catalog: { schemaVersion: 1, items: [] } });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(path.join(getSkillInstallDir(app, "saved-skill"), "SKILL.md")), true);
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
      () => installMarketItem(app, "cloud-builtin", { catalog, skillsApiBaseUrl: "http://127.0.0.1:1" }),
      /云端插件包必须声明 kind=plugin/
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
    ["/api/v1/skills?page=1&limit=100", skillsEnvelope([
      { name: "remove-skill", display_name: "Remove Skill", description: "Remove skill", latest_version: "1.0.0" }
    ])],
    ["/api/v1/skills/remove-skill/download?version=1.0.0", archiveBytes]
  ]), async (skillsBaseUrl) => {
    const options = { catalog: { schemaVersion: 1, items: [] }, skillsApiBaseUrl: skillsBaseUrl };
    await installMarketItem(app, "remove-skill", options);
    const result = await uninstallMarketItem(app, "remove-skill", options);

    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(getSkillInstallDir(app, "remove-skill")), false);
    const listed = await listMarketItems(app, options);
    assert.equal(listed.items.find((item) => item.id === "remove-skill")?.state, "not-installed");
  });
});
