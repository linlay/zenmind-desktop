import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { App } from "electron";
import type { MarketCommandResult, MarketItem } from "../shared/contracts";
import { extractArchiveToDir, listArchiveEntries } from "./archive-utils";
import { getService } from "./service-registry";
import { getInstallDir, getServiceState } from "./service-manager";
import { getServiceConfigRoot } from "./user-paths";

type SkillMetadata = {
  id: string;
  name: string;
  version: string;
  description: string;
  tags: string[];
};

type SkillInstallOptions = {
  source?: "cloud" | "local";
  expectedId?: string;
  expectedVersion?: string;
  metadata?: Partial<SkillMetadata>;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function slugify(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\.[^.]+$/u, "")
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized || "local-skill";
}

function parseEnvFile(content: string) {
  const env = new Map<string, string>();
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/gu, "");
    env.set(key, value);
  }
  return env;
}

function resolveHomeDir(app: App) {
  try {
    const homePath = app.getPath("home")?.trim();
    if (homePath) {
      return homePath;
    }
  } catch {
    // Fall through to Node's home directory.
  }
  return process.env.HOME || os.homedir();
}

function resolveDesktopDir(app: App, homeDir = resolveHomeDir(app)) {
  try {
    const desktopPath = app.getPath("desktop")?.trim();
    if (desktopPath) {
      return desktopPath;
    }
  } catch {
    // Fall through to the conventional Desktop location.
  }
  return path.join(homeDir, "Desktop");
}

function scoreRuntimeRoot(runtimeRoot: string) {
  if (!fs.existsSync(runtimeRoot) || !fs.statSync(runtimeRoot).isDirectory()) {
    return -1;
  }
  return ["agents", "registries", "teams", "chats", "skills-market"]
    .filter((entry) => fs.existsSync(path.join(runtimeRoot, entry)))
    .length;
}

function resolveDesktopRuntimeRoot(app: App) {
  const homeDir = resolveHomeDir(app);
  const desktopDir = resolveDesktopDir(app, homeDir);
  const legacyDesktopDir = path.join(homeDir, "Desktop");
  const candidates = [...new Set([
    path.join(homeDir, ".zenmind"),
    path.join(desktopDir, ".zenmind"),
    path.join(legacyDesktopDir, ".zenmind"),
    path.join(desktopDir, "zenmind-env"),
    path.join(legacyDesktopDir, "zenmind-env"),
    path.join(homeDir, "zenmind")
  ])];
  for (const candidate of candidates) {
    if (scoreRuntimeRoot(candidate) > 0) {
      return candidate;
    }
  }
  return path.join(homeDir, ".zenmind");
}

export function getSkillsMarketDir(app: App) {
  try {
    const service = getService("agent-platform");
    const envPath = path.join(getServiceConfigRoot(app, service.id, service.kind, getInstallDir(app, service)), ".env");
    if (fs.existsSync(envPath)) {
      const configured = parseEnvFile(fs.readFileSync(envPath, "utf8")).get("SKILLS_MARKET_DIR")?.trim();
      if (configured) {
        return configured;
      }
    }
  } catch {
    // agent-platform may not be registered yet in focused tests or fresh installs.
  }
  return path.join(resolveDesktopRuntimeRoot(app), "skills-market");
}

export function getSkillInstallDir(app: App, skillId: string) {
  return path.join(getSkillsMarketDir(app), skillId);
}

function readSkillMetadata(skillDir: string): SkillMetadata {
  const skillJsonPath = path.join(skillDir, "skill.json");
  const fallbackId = slugify(path.basename(skillDir));
  if (!fs.existsSync(skillJsonPath)) {
    return {
      id: fallbackId,
      name: path.basename(skillDir),
      version: "0.0.0",
      description: "",
      tags: []
    };
  }
  const raw = asObject(JSON.parse(fs.readFileSync(skillJsonPath, "utf8")));
  const id = slugify(asString(raw.id) || fallbackId);
  return {
    id,
    name: asString(raw.name) || id,
    version: asString(raw.version) || "0.0.0",
    description: asString(raw.description),
    tags: asStringArray(raw.tags)
  };
}

function ensureSafeArchiveEntries(archivePath: string) {
  for (const entry of listArchiveEntries(archivePath)) {
    const normalized = entry.replace(/\\/gu, "/");
    if (
      !normalized ||
      normalized.startsWith("/") ||
      normalized.includes("../") ||
      normalized === ".." ||
      /^[a-zA-Z]:\//u.test(normalized)
    ) {
      throw new Error(`Skill 包包含不安全路径：${entry}`);
    }
  }
}

function getSingleTopLevelDir(root: string) {
  const entries = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => !entry.name.startsWith("__MACOSX"));
  if (entries.length !== 1 || !entries[0].isDirectory()) {
    throw new Error("Skill 包应包含单个顶层目录");
  }
  return path.join(root, entries[0].name);
}

function getPreparedSkillDir(root: string, fallbackId: string) {
  if (fs.existsSync(path.join(root, "SKILL.md"))) {
    const preparedDir = path.join(root, fallbackId);
    fs.mkdirSync(preparedDir, { recursive: true });
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.name === fallbackId || entry.name.startsWith("__MACOSX")) {
        continue;
      }
      fs.renameSync(path.join(root, entry.name), path.join(preparedDir, entry.name));
    }
    return preparedDir;
  }
  return getSingleTopLevelDir(root);
}

function writeSkillMetadataIfMissing(skillDir: string, fallback: Partial<SkillMetadata>) {
  const skillJsonPath = path.join(skillDir, "skill.json");
  if (fs.existsSync(skillJsonPath)) {
    return;
  }
  const fallbackId = slugify(fallback.id || path.basename(skillDir));
  fs.writeFileSync(
    skillJsonPath,
    `${JSON.stringify({
      id: fallbackId,
      name: fallback.name || fallbackId,
      version: fallback.version || "0.0.0",
      description: fallback.description || "",
      tags: fallback.tags || []
    }, null, 2)}\n`,
    "utf8"
  );
}

function preserveBackup(targetDir: string) {
  if (!fs.existsSync(targetDir)) {
    return "";
  }
  const backupDir = `${targetDir}.backup-${Date.now()}`;
  fs.rmSync(backupDir, { recursive: true, force: true });
  fs.renameSync(targetDir, backupDir);
  return backupDir;
}

function restoreBackup(targetDir: string, backupDir: string) {
  fs.rmSync(targetDir, { recursive: true, force: true });
  if (backupDir && fs.existsSync(backupDir)) {
    fs.renameSync(backupDir, targetDir);
  }
}

function cleanupBackup(backupDir: string) {
  if (backupDir) {
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
}

async function buildMessage(app: App, skillName: string) {
  try {
    const state = await getServiceState(app, "agent-platform");
    if (state.status === "running") {
      return `技能 ${skillName} 已安装，请重启智能体平台后生效。`;
    }
    return `技能 ${skillName} 已安装，下次启动智能体平台后生效。`;
  } catch {
    return `技能 ${skillName} 已安装，下次启动智能体平台后生效。`;
  }
}

export async function installSkillFromPath(app: App, sourcePath: string, options: SkillInstallOptions = {}): Promise<MarketCommandResult> {
  const extension = path.basename(sourcePath).toLowerCase();
  const skillsRoot = getSkillsMarketDir(app);
  fs.mkdirSync(skillsRoot, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(skillsRoot, ".tmp-"));
  let preparedDir = "";
  try {
    if (extension.endsWith(".md")) {
      const skillId = slugify(path.basename(sourcePath));
      preparedDir = path.join(tempRoot, skillId);
      fs.mkdirSync(preparedDir, { recursive: true });
      fs.copyFileSync(sourcePath, path.join(preparedDir, "SKILL.md"));
      fs.writeFileSync(
        path.join(preparedDir, "skill.json"),
        `${JSON.stringify({
          id: skillId,
          name: path.basename(sourcePath).replace(/\.[^.]+$/u, ""),
          version: options.expectedVersion ?? "0.0.0",
          description: `本地导入，来源文件：${path.basename(sourcePath)}`,
          tags: []
        }, null, 2)}\n`,
        "utf8"
      );
    } else {
      ensureSafeArchiveEntries(sourcePath);
      extractArchiveToDir(sourcePath, tempRoot);
      preparedDir = getPreparedSkillDir(tempRoot, slugify(options.metadata?.id || options.expectedId || path.basename(sourcePath)));
      if (!fs.existsSync(path.join(preparedDir, "SKILL.md"))) {
        throw new Error("Skill 包缺少 SKILL.md");
      }
      writeSkillMetadataIfMissing(preparedDir, {
        id: options.metadata?.id ?? options.expectedId,
        name: options.metadata?.name,
        version: options.metadata?.version ?? options.expectedVersion,
        description: options.metadata?.description,
        tags: options.metadata?.tags
      });
    }

    const metadata = readSkillMetadata(preparedDir);
    if (options.expectedId && metadata.id !== options.expectedId) {
      throw new Error(`Skill 包 id 不匹配：期望 ${options.expectedId}，实际 ${metadata.id}`);
    }
    if (options.expectedVersion && metadata.version !== options.expectedVersion) {
      throw new Error(`Skill 包版本不匹配：期望 ${options.expectedVersion}，实际 ${metadata.version}`);
    }
    const targetDir = getSkillInstallDir(app, metadata.id);
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    const backupDir = preserveBackup(targetDir);
    try {
      fs.cpSync(preparedDir, targetDir, { recursive: true });
      cleanupBackup(backupDir);
    } catch (error) {
      restoreBackup(targetDir, backupDir);
      throw error;
    }

    return {
      ok: true,
      itemId: metadata.id,
      type: "skill",
      state: "installed",
      message: await buildMessage(app, metadata.name),
      installPath: targetDir
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function listInstalledSkills(app: App): MarketItem[] {
  const root = getSkillsMarketDir(app);
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".tmp-") && !entry.name.includes(".backup-"))
    .map((entry) => {
      const installPath = path.join(root, entry.name);
      const metadata = readSkillMetadata(installPath);
      return {
        id: metadata.id,
        type: "skill",
        name: metadata.name,
        version: metadata.version,
        description: metadata.description,
        tags: metadata.tags,
        state: "local-imported",
        source: "local",
        installedVersion: metadata.version,
        installPath
      };
    });
}

export async function uninstallSkill(app: App, skillId: string): Promise<MarketCommandResult> {
  const installDir = getSkillInstallDir(app, skillId);
  fs.rmSync(installDir, { recursive: true, force: true });
  return {
    ok: true,
    itemId: skillId,
    type: "skill",
    state: "not-installed",
    message: `技能 ${skillId} 已卸载。`
  };
}
