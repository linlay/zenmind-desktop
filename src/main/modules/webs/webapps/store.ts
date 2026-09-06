import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import packageValidation = require("../../../../shared/webapp-package-validation.js");
import type {
  WebappEntry,
  WebappOpenMode,
  WebappTarget,
  WebappUserConfigIssue
} from "../../../../shared/contracts";
import {
  WEBAPP_AGENT_KEY_PATTERN,
  WEBAPP_ID_PATTERN,
  WEBAPP_MANIFEST_MAX_BYTES,
  WEBAPP_MANIFEST_VERSION,
  parseWebappManifest,
  safeParseWebappManifest,
  type WebappManifest,
  type WebappUserConfigField,
  type WebappUserConfigValue,
  type WebappUserConfigValues
} from "../../../../shared/webapp-manifest";
import {
  getDesktopWebappDataRoot,
  getDesktopWebappsDataRoot,
  getDesktopWebsConfigRoot
} from "../../../infrastructure/filesystem/user-paths";
import {
  createWebappEntryKey,
  normalizeWebsiteLabel,
  sortWebEntries
} from "../common";
import { withWebappManagementMetadata } from "./metadata";
import type { WebsIntegrationPorts } from "../integration-ports";

const { validateWebappPackageDirectory } = packageValidation;

export const WEBAPP_FILE = "webapp.json";
export const WEBAPP_SCHEMA_VERSION = WEBAPP_MANIFEST_VERSION;
export const WEBAPP_TARGETS = [
  "any",
  "darwin-arm64",
  "darwin-x64",
  "darwin-universal",
  "win32-arm64",
  "win32-x64"
] as const satisfies readonly WebappTarget[];

const WEBAPP_PREFERENCES_FILE = "webapp-preferences.json";

type WebappPreference = {
  label?: string;
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
    return `win32-${arch}`;
  }
  return "";
}

export function webappTargetMatchesCurrentPlatform(
  target: WebappTarget,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
) {
  if (target === "any") {
    return true;
  }
  if (target === "darwin-universal") {
    return platform === "darwin" && (arch === "arm64" || arch === "x64");
  }
  return target === getCurrentWebappTarget(platform, arch);
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

export function getWebappUserConfigPath(app: App, id: string) {
  return path.join(getDesktopWebappDataRoot(app, assertWebappId(id)), "config", "user-config.json");
}

function readStoredUserConfigValues(app: App, id: string): WebappUserConfigValues {
  try {
    const value = JSON.parse(fs.readFileSync(getWebappUserConfigPath(app, id), "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    const result: WebappUserConfigValues = {};
    for (const [key, candidate] of Object.entries(value)) {
      if (
        typeof candidate === "string" ||
        typeof candidate === "boolean" ||
        typeof candidate === "number" && Number.isFinite(candidate)
      ) {
        result[key] = candidate;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function getUserConfigFieldDefault(field: WebappUserConfigField): WebappUserConfigValue | undefined {
  return "default" in field ? field.default : undefined;
}

function isValidUserConfigValue(field: WebappUserConfigField, value: unknown) {
  if (field.type === "text" || field.type === "textarea") {
    return typeof value === "string" && value.length <= field.maxLength;
  }
  if (field.type === "number") {
    return typeof value === "number" &&
      Number.isFinite(value) &&
      (field.min === undefined || value >= field.min) &&
      (field.max === undefined || value <= field.max);
  }
  if (field.type === "boolean") {
    return typeof value === "boolean";
  }
  if (typeof value !== "string" || !value) {
    return false;
  }
  if ("source" in field) {
    return field.source === "desktop.agents" && WEBAPP_AGENT_KEY_PATTERN.test(value);
  }
  return field.options.some((option) => option.value === value);
}

function normalizeWebappUserConfigValues(
  manifest: WebappManifest,
  input: unknown,
  options: { includeDefaults: boolean; rejectUnknown: boolean }
) {
  const source = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const fields = manifest.userConfig?.fields ?? [];
  const fieldNames = new Set(fields.map((field) => field.name));
  const values: WebappUserConfigValues = {};
  const issues: WebappUserConfigIssue[] = [];

  if (options.rejectUnknown) {
    for (const key of Object.keys(source)) {
      if (!fieldNames.has(key)) {
        issues.push({ field: key, message: "This field is not declared by the WebApp." });
      }
    }
  }

  for (const field of fields) {
    const hasInput = Object.hasOwn(source, field.name);
    const candidate = hasInput ? source[field.name] : undefined;
    if (hasInput && !isValidUserConfigValue(field, candidate)) {
      issues.push({ field: field.name, message: `Value is invalid for ${field.type}.` });
      continue;
    }
    if (hasInput) {
      values[field.name] = candidate as WebappUserConfigValue;
      continue;
    }
    const defaultValue = getUserConfigFieldDefault(field);
    if (options.includeDefaults && defaultValue !== undefined) {
      values[field.name] = defaultValue;
      continue;
    }
    if (field.required) {
      issues.push({ field: field.name, message: "A value is required." });
    }
  }
  return { values, issues };
}

export function readWebappUserConfigState(app: App, id: string) {
  const webappId = assertWebappId(id);
  const manifest = readManifestFile(getWebappDir(app, webappId));
  const stored = readStoredUserConfigValues(app, webappId);
  return normalizeWebappUserConfigValues(manifest, stored, {
    includeDefaults: true,
    rejectUnknown: false
  });
}

export function readWebappUserConfigValues(app: App, id: string): WebappUserConfigValues {
  return readWebappUserConfigState(app, id).values;
}

export function validateWebappUserConfigValues(
  manifest: WebappManifest,
  input: unknown
) {
  return normalizeWebappUserConfigValues(manifest, input, {
    includeDefaults: false,
    rejectUnknown: true
  });
}

export function writeWebappUserConfigValues(
  app: App,
  id: string,
  input: unknown
) {
  const webappId = assertWebappId(id);
  const manifest = readManifestFile(getWebappDir(app, webappId));
  const normalized = validateWebappUserConfigValues(manifest, input);
  if (normalized.issues.length > 0) {
    return {
      ok: false as const,
      values: readWebappUserConfigValues(app, webappId),
      issues: normalized.issues
    };
  }

  const overrides: WebappUserConfigValues = {};
  for (const field of manifest.userConfig?.fields ?? []) {
    if (!Object.hasOwn(normalized.values, field.name)) {
      continue;
    }
    const value = normalized.values[field.name]!;
    const defaultValue = getUserConfigFieldDefault(field);
    if (defaultValue !== value) {
      overrides[field.name] = value;
    }
  }

  const filePath = getWebappUserConfigPath(app, webappId);
  if (Object.keys(overrides).length === 0) {
    fs.rmSync(filePath, { force: true });
  } else {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(overrides, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    fs.renameSync(temporaryPath, filePath);
  }

  return {
    ok: true as const,
    values: readWebappUserConfigValues(app, webappId),
    issues: [] as WebappUserConfigIssue[]
  };
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

function readManifestFile(webappDir: string): WebappManifest {
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

function manifestToEntry(
  manifest: WebappManifest,
  webappDir: string,
  preference: WebappPreference = {},
  userConfigValues: WebappUserConfigValues = {}
): WebappEntry {
  if (!webappTargetMatchesCurrentPlatform(manifest.target)) {
    throw new Error(`webapp target ${manifest.target} is not compatible with this Desktop.`);
  }
  validateWebappPackageDirectory(webappDir, manifest);
  const manifestStat = fs.statSync(path.join(webappDir, WEBAPP_FILE));
  return {
    ...manifest,
    label: preference.label ?? manifest.label,
    openMode: preference.openMode ?? "workspace",
    id: manifest.id,
    entryKey: createWebappEntryKey(manifest.id),
    kind: "webapp",
    ...(manifest.copilot
      ? {
          copilotAgentKey: manifest.copilot.agentKey,
          copilotMustUseSkills: [...manifest.copilot.mustUseSkills]
        }
      : typeof userConfigValues.agentKey === "string" && WEBAPP_AGENT_KEY_PATTERN.test(userConfigValues.agentKey)
        ? { copilotAgentKey: userConfigValues.agentKey }
        : {}),
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

export function readWebappItems(
  app: App,
  platform: NodeJS.Platform = process.platform,
  ports?: WebsIntegrationPorts
) {
  return readInstalledWebappItems(app, platform).map((item) =>
    withWebappManagementMetadata(app, item, ports)
  );
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
      const userConfigValues = readWebappUserConfigValues(app, manifest.id);
      items.push(manifestToEntry(manifest, webappDir, preferences[manifest.id], userConfigValues));
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
    openMode?: WebappOpenMode;
  },
  platform: NodeJS.Platform = process.platform,
  ports?: WebsIntegrationPorts
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
  if (input.openMode === "workspace" || input.openMode === "dialog") {
    if (input.openMode === "workspace") {
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
  return withWebappManagementMetadata(
    app,
    manifestToEntry(manifest, webappDir, next, readWebappUserConfigValues(app, webappId)),
    ports
  );
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
