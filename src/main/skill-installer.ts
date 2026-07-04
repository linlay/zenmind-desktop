import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { App } from "electron";
import type { MarketCommandResult, MarketItem } from "../shared/contracts";
import { APP_BRAND } from "../shared/brand";
import { extractArchiveToDir, listArchiveEntries } from "./archive-utils";
import { getService } from "./services/service-registry";
import { getInstallDir, getServiceState } from "./services/manager";
import { getServiceConfigRoot } from "./user-paths";
import { t } from "./i18n/main-i18n";
import { resolveRuntimeRootPath } from "./runtime-root";

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

const execFileAsync = promisify(execFile);
const COMMAND_INSTALL_TIMEOUT_MS = 120_000;
const COMMAND_INSTALL_MAX_BUFFER = 1024 * 1024;
const COMMAND_DISCOVERY_MAX_DEPTH = 5;
const COMMAND_DISCOVERY_MAX_ENTRIES = 2_000;
const ANTHROPIC_SKILLS_LEGACY_IDS = new Map([
  ["docx-manipulation", "docx"],
  ["pdf-manipulation", "pdf"],
  ["pptx-manipulation", "pptx"],
  ["xlsx-manipulation", "xlsx"]
]);

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

function expandHomeShortcut(value: string, homeDir: string) {
  const trimmed = value.trim();
  if (trimmed === "~") {
    return homeDir;
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(homeDir, trimmed.slice(2));
  }
  return trimmed;
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
  const preferredRuntimeRoot = resolveRuntimeRootPath({
    platform: process.platform,
    homePath: homeDir
  });
  if (process.platform === "win32") {
    return preferredRuntimeRoot;
  }
  const desktopDir = resolveDesktopDir(app, homeDir);
  const legacyDesktopDir = path.join(homeDir, "Desktop");
  const candidates = [preferredRuntimeRoot];
  if (String(APP_BRAND.id) === "zenmind") {
    candidates.push(
      path.join(desktopDir, ".zenmind"),
      path.join(legacyDesktopDir, ".zenmind"),
      path.join(desktopDir, "zenmind-env"),
      path.join(legacyDesktopDir, "zenmind-env"),
      path.join(homeDir, "zenmind")
    );
  }
  for (const candidate of candidates) {
    if (scoreRuntimeRoot(candidate) > 0) {
      return candidate;
    }
  }
  return preferredRuntimeRoot;
}

export function getSkillsMarketDir(app: App) {
  try {
    const service = getService("agent-platform");
    const envPath = path.join(getServiceConfigRoot(app, service.id, service.kind), ".env");
    if (fs.existsSync(envPath)) {
      const configured = parseEnvFile(fs.readFileSync(envPath, "utf8")).get("SKILLS_MARKET_DIR")?.trim();
      if (configured) {
        return expandHomeShortcut(configured, resolveHomeDir(app));
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
      throw new Error(t("skillInstaller.unsafePath", { entry }));
    }
  }
}

function getSingleTopLevelDir(root: string) {
  const entries = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => !entry.name.startsWith("__MACOSX"));
  if (entries.length !== 1 || !entries[0].isDirectory()) {
    throw new Error(t("skillInstaller.singleTopLevelRequired"));
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

function splitCommandLine(input: string) {
  const tokens: string[] = [];
  let current = "";
  let quote = "";
  let escaping = false;
  let tokenStarted = false;
  for (const char of input.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      tokenStarted = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      tokenStarted = true;
      continue;
    }
    if ((char === "\"" || char === "'") && (!quote || quote === char)) {
      quote = quote ? "" : char;
      tokenStarted = true;
      continue;
    }
    if (!quote && /\s/u.test(char)) {
      if (tokenStarted) {
        tokens.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    current += char;
    tokenStarted = true;
  }
  if (escaping) {
    current += "\\";
  }
  if (quote) {
    throw new Error(t("skillInstaller.unclosedQuote"));
  }
  if (tokenStarted) {
    tokens.push(current);
  }
  return tokens;
}

function normalizedPackageCommandName(command: string) {
  const basename = path.basename(command).toLowerCase();
  return basename.replace(/\.(cmd|exe)$/u, "");
}

function ensureSupportedPackageCommand(command: string) {
  const name = normalizedPackageCommandName(command);
  if (name !== "npm" && name !== "npx") {
    throw new Error(t("skillInstaller.unsupportedCommand"));
  }
  return name;
}

function isNpxFlagWithValue(value: string) {
  return [
    "-c",
    "--call",
    "--cache",
    "--package",
    "-p",
    "--registry",
    "--userconfig"
  ].includes(value);
}

function findPackageExecutionStartIndex(args: string[], startIndex = 0) {
  for (let index = startIndex; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--") {
      continue;
    }
    if (isNpxFlagWithValue(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("--package=") || value.startsWith("-p=")) {
      continue;
    }
    if (value.startsWith("-")) {
      continue;
    }
    return index;
  }
  return -1;
}

function isSkillsPackageSpecifier(value: string) {
  return /^skills(?:@.+)?$/u.test(value.trim());
}

function isAnthropicSkillsSource(value: string) {
  const normalized = value.trim().toLowerCase().replace(/\.git$/u, "");
  return (
    normalized === "anthropics/skills" ||
    normalized === "github:anthropics/skills" ||
    normalized === "git@github.com:anthropics/skills" ||
    normalized === "https://github.com/anthropics/skills" ||
    normalized === "http://github.com/anthropics/skills"
  );
}

function findAnthropicSkillsAddSourceIndex(args: string[], startIndex: number) {
  if (startIndex < 0 || !isSkillsPackageSpecifier(args[startIndex] || "")) {
    return -1;
  }
  let commandIndex = startIndex + 1;
  if (args[commandIndex] === "--") {
    commandIndex += 1;
  }
  if (args[commandIndex] === "skills") {
    commandIndex += 1;
  }
  if (
    args[commandIndex] !== "add" ||
    !isAnthropicSkillsSource(args[commandIndex + 1] || "")
  ) {
    return -1;
  }
  return commandIndex + 1;
}

function normalizeAnthropicSkillsAddArgs(args: string[], startIndex: number) {
  if (findAnthropicSkillsAddSourceIndex(args, startIndex) < 0) {
    return args;
  }

  return args.map((arg, index) => {
    if (arg.startsWith("--skill=")) {
      const skillId = arg.slice("--skill=".length);
      const mapped = ANTHROPIC_SKILLS_LEGACY_IDS.get(skillId);
      return mapped ? `--skill=${mapped}` : arg;
    }
    if (args[index - 1] === "--skill") {
      return ANTHROPIC_SKILLS_LEGACY_IDS.get(arg) ?? arg;
    }
    return arg;
  });
}

function normalizeNpxDownloadArgs(args: string[]) {
  return normalizeAnthropicSkillsAddArgs(args, findPackageExecutionStartIndex(args));
}

function normalizeNpmDownloadArgs(args: string[]) {
  const subcommand = args[0];
  if (subcommand !== "exec" && subcommand !== "x") {
    return args;
  }
  return normalizeAnthropicSkillsAddArgs(args, findPackageExecutionStartIndex(args, 1));
}

function normalizeSkillDownloadCommand(command: string, args: string[]) {
  const name = normalizedPackageCommandName(command);
  if (name === "npx") {
    return {
      command,
      args: normalizeNpxDownloadArgs(args)
    };
  }
  if (name === "npm") {
    return {
      command,
      args: normalizeNpmDownloadArgs(args)
    };
  }
  return { command, args };
}

function windowsCommandLineArg(value: string) {
  return `"${value.replace(/"/gu, "\"\"").replace(/%/gu, "%%")}"`;
}

function splitPathList(value: string | undefined) {
  return (value ?? "").split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
}

function resolveWindowsPackageCommandPath(command: string) {
  if (path.isAbsolute(command) && fs.existsSync(command)) {
    return command;
  }
  const basenames = path.extname(command) ? [command] : [`${command}.cmd`, `${command}.exe`, command];
  for (const dirPath of splitPathList(process.env.PATH ?? process.env.Path)) {
    for (const basename of basenames) {
      const candidate = path.join(dirPath, basename);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // Keep scanning when a PATH entry is unreadable.
      }
    }
  }
  return command;
}

function resolvePackageManagerExecution(command: string, args: string[]) {
  const name = ensureSupportedPackageCommand(command);
  if (process.platform === "win32") {
    // npm/npx on Windows are normally .cmd shims, so execute them through cmd.exe explicitly.
    const executableName = command.toLowerCase().endsWith(".cmd") || command.toLowerCase().endsWith(".exe")
      ? command
      : `${name}.cmd`;
    const executable = resolveWindowsPackageCommandPath(executableName);
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        ["call", windowsCommandLineArg(executable), ...args.map(windowsCommandLineArg)].join(" ")
      ],
      windowsVerbatimArguments: true
    };
  }

  if (process.platform === "darwin") {
    return { command, args };
  }

  return { command, args };
}

function isInstallableArchive(filePath: string) {
  const normalized = filePath.toLowerCase();
  return normalized.endsWith(".zip");
}

function isIgnoredCommandDiscoveryDir(name: string) {
  return name === ".git" || name === ".cache" || name === ".npm" || name === ".pnpm-store";
}

function createCommandInstallEnv(downloadRoot: string) {
  const homeDir = path.join(downloadRoot, "home");
  const npmCacheDir = path.join(downloadRoot, "npm-cache");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(npmCacheDir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    npm_config_cache: npmCacheDir
  };

  if (process.platform === "win32") {
    env.USERPROFILE = homeDir;
    const parsed = path.parse(homeDir);
    env.HOMEDRIVE = parsed.root.replace(/\\$/u, "");
    env.HOMEPATH = homeDir.slice(env.HOMEDRIVE.length) || "\\";
  } else if (process.platform === "darwin") {
    env.HOME = homeDir;
  }

  return env;
}

function relativeDepth(root: string, filePath: string) {
  const relative = path.relative(root, filePath);
  return relative ? relative.split(path.sep).length : 0;
}

function findDownloadedSkillSource(root: string) {
  const archives: string[] = [];
  const skillDirs: string[] = [];
  const skillFiles: string[] = [];
  let visited = 0;

  function walk(currentDir: string, depth: number) {
    if (depth > COMMAND_DISCOVERY_MAX_DEPTH || visited > COMMAND_DISCOVERY_MAX_ENTRIES) {
      return;
    }
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      visited += 1;
      if (visited > COMMAND_DISCOVERY_MAX_ENTRIES) {
        return;
      }
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isFile()) {
        if (entry.name === "SKILL.md") {
          skillFiles.push(fullPath);
        } else if (isInstallableArchive(fullPath)) {
          archives.push(fullPath);
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (isIgnoredCommandDiscoveryDir(entry.name)) {
          continue;
        }
        if (fs.existsSync(path.join(fullPath, "SKILL.md"))) {
          skillDirs.push(fullPath);
        }
        walk(fullPath, depth + 1);
      }
    }
  }

  walk(root, 0);
  const sortedArchives = archives.sort((left, right) => relativeDepth(root, left) - relativeDepth(root, right) || left.localeCompare(right));
  const sortedSkillDirs = skillDirs.sort((left, right) => relativeDepth(root, left) - relativeDepth(root, right) || left.localeCompare(right));
  const sortedSkillFiles = skillFiles.sort((left, right) => relativeDepth(root, left) - relativeDepth(root, right) || left.localeCompare(right));
  const candidates = [...sortedArchives, ...sortedSkillDirs, ...sortedSkillFiles];
  if (candidates.length === 0) {
    throw new Error(t("skillInstaller.downloadNoPackage"));
  }
  return candidates[0];
}

async function buildMessage(app: App, skillName: string) {
  try {
    const state = await getServiceState(app, "agent-platform");
    if (state.status === "running") {
      return t("skillInstaller.installedRestartRequired", { name: skillName });
    }
    return t("skillInstaller.installedNextStart", { name: skillName });
  } catch {
    return t("skillInstaller.installedNextStart", { name: skillName });
  }
}

export async function installSkillFromPath(app: App, sourcePath: string, options: SkillInstallOptions = {}): Promise<MarketCommandResult> {
  const extension = path.basename(sourcePath).toLowerCase();
  const skillsRoot = getSkillsMarketDir(app);
  fs.mkdirSync(skillsRoot, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(skillsRoot, ".tmp-"));
  let preparedDir = "";
  try {
    const sourceStats = fs.statSync(sourcePath);
    if (sourceStats.isDirectory()) {
      preparedDir = path.join(tempRoot, slugify(options.metadata?.id || options.expectedId || path.basename(sourcePath)));
      fs.cpSync(sourcePath, preparedDir, { recursive: true });
      if (!fs.existsSync(path.join(preparedDir, "SKILL.md"))) {
        throw new Error(t("skillInstaller.dirMissingSkillMd"));
      }
      writeSkillMetadataIfMissing(preparedDir, {
        id: options.metadata?.id ?? options.expectedId,
        name: options.metadata?.name,
        version: options.metadata?.version ?? options.expectedVersion,
        description: options.metadata?.description,
        tags: options.metadata?.tags
      });
    } else if (extension.endsWith(".md")) {
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
          description: t("skillInstaller.localImportDescription", { file: path.basename(sourcePath) }),
          tags: []
        }, null, 2)}\n`,
        "utf8"
      );
    } else if (extension.endsWith(".zip")) {
      ensureSafeArchiveEntries(sourcePath);
      await extractArchiveToDir(sourcePath, tempRoot);
      preparedDir = getPreparedSkillDir(tempRoot, slugify(options.metadata?.id || options.expectedId || path.basename(sourcePath)));
      if (!fs.existsSync(path.join(preparedDir, "SKILL.md"))) {
        throw new Error(t("skillInstaller.packageMissingSkillMd"));
      }
      writeSkillMetadataIfMissing(preparedDir, {
        id: options.metadata?.id ?? options.expectedId,
        name: options.metadata?.name,
        version: options.metadata?.version ?? options.expectedVersion,
        description: options.metadata?.description,
        tags: options.metadata?.tags
      });
    } else {
      throw new Error(t("skillInstaller.unsupportedPackageType"));
    }

    const metadata = readSkillMetadata(preparedDir);
    if (options.expectedId && metadata.id !== options.expectedId) {
      throw new Error(t("skillInstaller.idMismatch", { expected: options.expectedId, actual: metadata.id }));
    }
    if (options.expectedVersion && metadata.version !== options.expectedVersion) {
      throw new Error(t("skillInstaller.versionMismatch", { expected: options.expectedVersion, actual: metadata.version }));
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

export async function installSkillFromCommand(app: App, commandText: string): Promise<MarketCommandResult> {
  const tokens = splitCommandLine(commandText);
  if (tokens.length === 0) {
    throw new Error(t("skillInstaller.commandRequired"));
  }
  const [rawCommand, ...rawArgs] = tokens;
  const { command, args } = normalizeSkillDownloadCommand(rawCommand, rawArgs);
  const execution = resolvePackageManagerExecution(command, args);
  const downloadsRoot = path.join(getSkillsMarketDir(app), ".downloads");
  fs.mkdirSync(downloadsRoot, { recursive: true });
  const downloadRoot = fs.mkdtempSync(path.join(downloadsRoot, "desktop-skill-download-"));
  try {
    await execFileAsync(execution.command, execution.args, {
      cwd: downloadRoot,
      env: createCommandInstallEnv(downloadRoot),
      encoding: "utf8",
      timeout: COMMAND_INSTALL_TIMEOUT_MS,
      maxBuffer: COMMAND_INSTALL_MAX_BUFFER,
      windowsVerbatimArguments: execution.windowsVerbatimArguments,
      windowsHide: true
    });
    const sourcePath = findDownloadedSkillSource(downloadRoot);
    return await installSkillFromPath(app, sourcePath, { source: "cloud" });
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(t("skillInstaller.downloadFailed", { message: error.message }));
    }
    throw error;
  } finally {
    fs.rmSync(downloadRoot, { recursive: true, force: true });
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
    message: t("skillInstaller.uninstalled", { id: skillId })
  };
}
