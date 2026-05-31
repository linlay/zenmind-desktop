import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  getSkillInstallDir,
  installSkillFromPath,
  listInstalledSkills,
  uninstallSkill
} = require("../dist-electron/main/skill-installer.js");
const {
  registerService,
  __testInternals: registryInternals
} = require("../dist-electron/main/services/service-registry.js");

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

function createSkillArchive(root, options = {}) {
  const skillId = options.id ?? "demo-skill";
  const fixtureRoot = path.join(root, `fixture-${skillId}`);
  const skillRoot = options.rootLevel ? fixtureRoot : path.join(fixtureRoot, skillId);
  const archivePath = path.join(root, `${skillId}.tar.gz`);
  fs.mkdirSync(skillRoot, { recursive: true });
  if (options.withSkillMd !== false) {
    fs.writeFileSync(path.join(skillRoot, "SKILL.md"), `# ${skillId}\n\nDemo skill.\n`, "utf8");
  }
  if (options.skillJson !== false) {
    fs.writeFileSync(
      path.join(skillRoot, "skill.json"),
      `${JSON.stringify({
        id: skillId,
        name: options.name ?? "Demo Skill",
        version: options.version ?? "1.0.0",
        description: "Demo skill description",
        tags: ["demo"]
      }, null, 2)}\n`,
      "utf8"
    );
  }
  execFileSync("tar", ["-czf", archivePath, "-C", fixtureRoot, ...(options.rootLevel ? ["SKILL.md"] : [skillId])]);
  return archivePath;
}

test("installSkillFromPath imports a single SKILL.md into the Desktop skills-market runtime", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-skill-md-"));
  const app = createApp(root);
  const sourcePath = path.join(root, "browser-helper.md");
  fs.writeFileSync(sourcePath, "# Browser Helper\n\nUse browser helpers.\n", "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = await installSkillFromPath(app, sourcePath);
  const installDir = getSkillInstallDir(app, "browser-helper");

  assert.equal(result.ok, true);
  assert.equal(result.itemId, "browser-helper");
  assert.equal(result.type, "skill");
  assert.equal(result.state, "installed");
  assert.equal(result.installPath, installDir);
  assert.equal(fs.readFileSync(path.join(installDir, "SKILL.md"), "utf8"), "# Browser Helper\n\nUse browser helpers.\n");
  assert.equal(fs.existsSync(path.join(root, "home", ".codex", "skills")), false);
});

test("getSkillInstallDir expands a configured home-relative skills market path", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-skill-market-home-"));
  const app = createApp(root);
  const configRoot = path.join(root, "user-data", "config", "services", "agent-platform");
  t.after(() => {
    registryInternals.clearServices();
    fs.rmSync(root, { recursive: true, force: true });
  });

  registerService({
    id: "agent-platform",
    kind: "builtin",
    version: "1.0.0",
    scripts: {
      start: "./start.sh",
      stop: "./stop.sh"
    }
  });
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(path.join(configRoot, ".env"), "SKILLS_MARKET_DIR=~/.zenmind/skills-market\n", "utf8");

  assert.equal(
    getSkillInstallDir(app, "demo-skill"),
    path.join(root, "home", ".zenmind", "skills-market", "demo-skill")
  );
});

test("installSkillFromPath imports an archive with SKILL.md and skill.json metadata", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-skill-archive-"));
  const app = createApp(root);
  const archivePath = createSkillArchive(root, { id: "archive-skill", name: "Archive Skill" });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = await installSkillFromPath(app, archivePath);
  const installed = listInstalledSkills(app).find((item) => item.id === "archive-skill");

  assert.equal(result.ok, true);
  assert.equal(result.itemId, "archive-skill");
  assert.equal(installed?.name, "Archive Skill");
  assert.equal(installed?.version, "1.0.0");
  assert.equal(fs.existsSync(path.join(getSkillInstallDir(app, "archive-skill"), "SKILL.md")), true);
});

test("installSkillFromPath imports a root-level SKILL.md archive with provided metadata", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-skill-root-"));
  const app = createApp(root);
  const archivePath = createSkillArchive(root, { id: "root-skill", rootLevel: true, skillJson: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = await installSkillFromPath(app, archivePath, {
    expectedId: "root-skill",
    expectedVersion: "2.0.0",
    metadata: {
      id: "root-skill",
      name: "Root Skill",
      version: "2.0.0",
      description: "Root-level archive skill",
      tags: ["root"]
    }
  });
  const installDir = getSkillInstallDir(app, "root-skill");
  const metadata = JSON.parse(fs.readFileSync(path.join(installDir, "skill.json"), "utf8"));

  assert.equal(result.ok, true);
  assert.equal(result.itemId, "root-skill");
  assert.equal(metadata.name, "Root Skill");
  assert.equal(metadata.version, "2.0.0");
  assert.deepEqual(metadata.tags, ["root"]);
  assert.equal(fs.existsSync(path.join(installDir, "SKILL.md")), true);
});

test("installSkillFromPath rejects skill archives that do not contain SKILL.md", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-skill-missing-md-"));
  const app = createApp(root);
  const archivePath = createSkillArchive(root, { id: "broken-skill", withSkillMd: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await assert.rejects(
    () => installSkillFromPath(app, archivePath),
    /Skill 包缺少 SKILL\.md/
  );
  assert.equal(fs.existsSync(getSkillInstallDir(app, "broken-skill")), false);
});

test("uninstallSkill removes only the target skill directory", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-skill-uninstall-"));
  const app = createApp(root);
  const firstArchive = createSkillArchive(root, { id: "first-skill" });
  const secondArchive = createSkillArchive(root, { id: "second-skill" });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  await installSkillFromPath(app, firstArchive);
  await installSkillFromPath(app, secondArchive);
  const result = await uninstallSkill(app, "first-skill");

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(getSkillInstallDir(app, "first-skill")), false);
  assert.equal(fs.existsSync(getSkillInstallDir(app, "second-skill")), true);
});
