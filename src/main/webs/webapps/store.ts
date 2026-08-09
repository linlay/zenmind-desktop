import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type {
  WebappEntry,
  WebappOpenMode,
  WebappTarget
} from "../../../shared/contracts";
import {
  WEBAPP_ID_PATTERN,
  WEBAPP_MANIFEST_MAX_BYTES,
  WEBAPP_MANIFEST_VERSION,
  parseWebappManifest,
  safeParseWebappManifest,
  type WebappManifestV1
} from "../../../shared/webapp-manifest";
import {
  getDesktopWebappsDataRoot,
  getDesktopWebsConfigRoot
} from "../../user-paths";
import {
  createWebappEntryKey,
  normalizeAgentKey,
  normalizeWebsiteLabel,
  realpathInsideRoot,
  resolveWebappRelativePath,
  sortWebEntries
} from "../common";
import { withWebappManagementMetadata } from "./metadata";

export const WEBAPP_FILE = "webapp.json";
export const WEBAPP_SCHEMA_VERSION = WEBAPP_MANIFEST_VERSION;
export const WEBAPP_TARGETS = [
  "universal",
  "darwin-arm64",
  "darwin-x64",
  "windows-arm64",
  "windows-x64"
] as const satisfies readonly WebappTarget[];

const WEBAPP_PREFERENCES_FILE = "webapp-preferences.json";

type WebappPreference = {
  label?: string;
  copilotAgentKey?: string;
  openMode?: WebappOpenMode;
};

type WebappPreferenceStore = Record<string, WebappPreference>;

export function assertWebappId(value: string) {
  if (!WEBAPP_ID_PATTERN.test(value)) {
    throw new Error("webapp id is missing or invalid.");
  }
  return value;
}

export function getCurrentWebappTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): WebappTarget | "" {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    return `darwin-${arch}`;
  }
  if (platform === "win32" && (arch === "arm64" || arch === "x64")) {
    return `windows-${arch}`;
  }
  return "";
}

export function webappTargetMatchesCurrentPlatform(
  target: WebappTarget,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
) {
  return target === "universal" || target === getCurrentWebappTarget(platform, arch);
}

export function getWebappDir(app: App, id: string, platform: NodeJS.Platform = process.platform) {
  return path.join(getDesktopWebappsDataRoot(app, platform), assertWebappId(id));
}

export function getWebappPath(app: App, id: string, platform: NodeJS.Platform = process.platform) {
  return path.join(getWebappDir(app, id, platform), WEBAPP_FILE);
}

function getPreferencesPath(app: App) {
  return path.join(getDesktopWebsConfigRoot(app), WEBAPP_PREFERENCES_FILE);
}

function readPreferences(app: App): WebappPreferenceStore {
  try {
    const value = JSON.parse(fs.readFileSync(getPreferencesPath(app), "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    const result: WebappPreferenceStore = {};
    for (const [id, raw] of Object.entries(value)) {
      if (!WEBAPP_ID_PATTERN.test(id) || !raw || typeof raw !== "object" || Array.isArray(raw)) {
        continue;
      }
      const candidate = raw as Record<string, unknown>;
      const preference: WebappPreference = {};
      if (typeof candidate.label === "string" && candidate.label.trim()) {
        preference.label = normalizeWebsiteLabel(candidate.label, id);
      }
      if (typeof candidate.copilotAgentKey === "string") {
        const agentKey = normalizeAgentKey(candidate.copilotAgentKey);
        if (agentKey) {
          preference.copilotAgentKey = agentKey;
        }
      }
      if (candidate.openMode === "workspace" || candidate.openMode === "dialog") {
        preference.openMode = candidate.openMode;
      }
      if (Object.keys(preference).length > 0) {
        result[id] = preference;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function writePreferences(app: App, preferences: WebappPreferenceStore) {
  const filePath = getPreferencesPath(app);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

export function removeWebappPreferences(app: App, id: string) {
  const webappId = assertWebappId(id);
  const preferences = readPreferences(app);
  if (!Object.hasOwn(preferences, webappId)) {
    return;
  }
  delete preferences[webappId];
  writePreferences(app, preferences);
}

function readManifestFile(webappDir: string): WebappManifestV1 {
  const manifestPath = path.join(webappDir, WEBAPP_FILE);
  const stat = fs.statSync(manifestPath);
  if (!stat.isFile()) {
    throw new Error("webapp.json must be an ordinary file.");
  }
  if (stat.size > WEBAPP_MANIFEST_MAX_BYTES) {
    throw new Error(`webapp.json must not exceed ${WEBAPP_MANIFEST_MAX_BYTES} bytes.`);
  }
  return parseWebappManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown);
}

function validatePackagePaths(manifest: WebappManifestV1, webappDir: string) {
  const frontendRoot = resolveWebappRelativePath(webappDir, manifest.frontend.root);
  const frontendRealRoot = realpathInsideRoot(webappDir, frontendRoot);
  if (!fs.statSync(frontendRealRoot).isDirectory()) {
    throw new Error(`frontend.root is not a directory: ${manifest.frontend.root}`);
  }
  const indexPath = resolveWebappRelativePath(frontendRealRoot, manifest.frontend.index);
  const indexRealPath = realpathInsideRoot(frontendRealRoot, indexPath);
  if (!fs.statSync(indexRealPath).isFile()) {
    throw new Error(`frontend.index is not a file: ${manifest.frontend.index}`);
  }

  const command = manifest.backend?.command;
  if (!command || command.type === "system") {
    return;
  }
  const relativeEntry = command.type === "electron-node" ? command.script : command.executable;
  const entryPath = resolveWebappRelativePath(webappDir, relativeEntry);
  const entryRealPath = realpathInsideRoot(webappDir, entryPath);
  if (!fs.statSync(entryRealPath).isFile()) {
    throw new Error(`backend command entry is not a file: ${relativeEntry}`);
  }
  if (
    command.type === "electron-node" &&
    ![".js", ".cjs", ".mjs"].includes(path.extname(entryRealPath).toLowerCase())
  ) {
    throw new Error("electron-node backend script must be a .js, .cjs, or .mjs file.");
  }
  if (
    command.type === "bundled" &&
    process.platform === "win32" &&
    path.extname(entryRealPath).toLowerCase() !== ".exe"
  ) {
    throw new Error("Windows bundled backend executable must be an .exe file.");
  }
}

function manifestToEntry(
  manifest: WebappManifestV1,
  webappDir: string,
  preference: WebappPreference = {}
): WebappEntry {
  if (!webappTargetMatchesCurrentPlatform(manifest.target)) {
    throw new Error(`webapp target ${manifest.target} is not compatible with this Desktop.`);
  }
  validatePackagePaths(manifest, webappDir);
  const manifestStat = fs.statSync(path.join(webappDir, WEBAPP_FILE));
  return {
    ...manifest,
    label: preference.label ?? manifest.label,
    openMode: preference.openMode ?? manifest.openMode,
    id: manifest.id,
    entryKey: createWebappEntryKey(manifest.id),
    kind: "webapp",
    ...(preference.copilotAgentKey ? { copilotAgentKey: preference.copilotAgentKey } : {}),
    createdAt: manifestStat.birthtimeMs || manifestStat.ctimeMs,
    updatedAt: manifestStat.mtimeMs
  };
}

export function normalizeWebappManifest(value: unknown, projectDir: string): WebappEntry {
  const manifest = parseWebappManifest(value);
  return manifestToEntry(manifest, projectDir);
}

export function readWebappManifestFromDir(webappDir: string) {
  return readManifestFile(webappDir);
}

export function readWebappItemFromDir(webappDir: string, expectedId = "") {
  const manifest = readManifestFile(webappDir);
  if (expectedId && manifest.id !== assertWebappId(expectedId)) {
    throw new Error(`webapp id mismatch: expected ${expectedId}, received ${manifest.id}.`);
  }
  return manifestToEntry(manifest, webappDir);
}

function sanitizeWebappItems(items: WebappEntry[]) {
  const seenIds = new Set<string>();
  return items.filter((item) => {
    if (seenIds.has(item.id)) {
      return false;
    }
    seenIds.add(item.id);
    return true;
  });
}

export function readWebappItems(app: App, platform: NodeJS.Platform = process.platform) {
  return readInstalledWebappItems(app, platform).map((item) => withWebappManagementMetadata(app, item));
}

export function readInstalledWebappItems(app: App, platform: NodeJS.Platform = process.platform) {
  const root = getDesktopWebappsDataRoot(app, platform);
  if (!fs.existsSync(root)) {
    return [];
  }
  const preferences = readPreferences(app);
  const items: WebappEntry[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !WEBAPP_ID_PATTERN.test(entry.name)) {
      continue;
    }
    const webappDir = path.join(root, entry.name);
    try {
      const manifest = readManifestFile(webappDir);
      if (manifest.id !== entry.name) {
        throw new Error(`webapp id must match its installation directory: ${entry.name}.`);
      }
      items.push(manifestToEntry(manifest, webappDir, preferences[manifest.id]));
    } catch (error) {
      console.warn("failed to read webapp item", path.join(webappDir, WEBAPP_FILE), error);
    }
  }
  return sortWebEntries(sanitizeWebappItems(items));
}

export function isWebappFile(value: unknown) {
  return safeParseWebappManifest(value).success;
}

export function writeWebappPreferenceFields(
  app: App,
  id: string,
  input: {
    label?: string;
    copilotAgentKey?: string;
    openMode?: WebappOpenMode;
  },
  platform: NodeJS.Platform = process.platform
) {
  const webappId = assertWebappId(id);
  const webappDir = getWebappDir(app, webappId, platform);
  const manifest = readManifestFile(webappDir);
  if (manifest.id !== webappId) {
    throw new Error(`webapp id mismatch: expected ${webappId}, received ${manifest.id}.`);
  }
  const preferences = readPreferences(app);
  const current = preferences[webappId] ?? {};
  const next: WebappPreference = { ...current };
  if (typeof input.label === "string") {
    const label = normalizeWebsiteLabel(input.label, webappId);
    if (label === manifest.label) {
      delete next.label;
    } else {
      next.label = label;
    }
  }
  if (typeof input.copilotAgentKey === "string") {
    const agentKey = normalizeAgentKey(input.copilotAgentKey);
    if (agentKey) {
      next.copilotAgentKey = agentKey;
    } else {
      delete next.copilotAgentKey;
    }
  }
  if (input.openMode === "workspace" || input.openMode === "dialog") {
    if (input.openMode === manifest.openMode) {
      delete next.openMode;
    } else {
      next.openMode = input.openMode;
    }
  }
  if (Object.keys(next).length > 0) {
    preferences[webappId] = next;
  } else {
    delete preferences[webappId];
  }
  writePreferences(app, preferences);
  return withWebappManagementMetadata(app, manifestToEntry(manifest, webappDir, next));
}

export function writeCanonicalWebappManifest(webappDir: string, expectedId = "") {
  const manifest = readManifestFile(webappDir);
  if (expectedId && manifest.id !== assertWebappId(expectedId)) {
    throw new Error(`webapp id mismatch: expected ${expectedId}, received ${manifest.id}.`);
  }
  fs.writeFileSync(
    path.join(webappDir, WEBAPP_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  return manifestToEntry(manifest, webappDir);
}
