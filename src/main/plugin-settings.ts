import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type {
  ManifestPluginSettingField,
  ManifestPluginSettingValue,
  PluginGlobalShortcutStatus,
  PluginSettingsReadResult,
  PluginSettingsValues,
  PluginSettingsWriteResult,
  ServiceId
} from "../shared/contracts";
import type { ServiceDefinition } from "./manifest-utils";
import { getService } from "./services/service-registry";
import { getInstallDir, getServiceLayout } from "./services/manager/layout";
import { staticSiteHostManager } from "./static-site-host-manager";

const PLUGIN_SETTINGS_FILE = "settings.json";

type StoredPluginSettings = {
  schemaVersion?: unknown;
  values?: unknown;
  updatedAt?: unknown;
};

type ValidationMode = "stored" | "write";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getPluginService(serviceId: ServiceId) {
  const service = getService(serviceId);
  if (service.kind !== "plugin") {
    throw new Error(`service ${serviceId} is not a plugin`);
  }
  return service;
}

export function getPluginSettingsPath(app: App, service: ServiceDefinition) {
  const layout = getServiceLayout(app, service);
  return path.join(layout.configDir, PLUGIN_SETTINGS_FILE);
}

function readStoredPluginSettings(settingsPath: string): StoredPluginSettings {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf8")) as StoredPluginSettings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function readNumber(value: unknown, field: ManifestPluginSettingField, mode: ValidationMode) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    if (mode === "stored") return undefined;
    throw new Error(`${field.label} must be a number.`);
  }
  if (field.min !== undefined && value < field.min) {
    throw new Error(`${field.label} must be greater than or equal to ${field.min}.`);
  }
  if (field.max !== undefined && value > field.max) {
    throw new Error(`${field.label} must be less than or equal to ${field.max}.`);
  }
  return field.type === "duration" ? Math.trunc(value) : value;
}

function allowedOptionValues(field: ManifestPluginSettingField) {
  return new Set((field.options ?? []).map((option) => option.value));
}

function readSettingValue(
  field: ManifestPluginSettingField,
  value: unknown,
  mode: ValidationMode
): ManifestPluginSettingValue | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  switch (field.type) {
    case "text":
    case "textarea":
    case "shortcut":
      if (typeof value === "string") return value;
      if (mode === "stored") return undefined;
      throw new Error(`${field.label} must be text.`);
    case "number":
    case "duration":
      return readNumber(value, field, mode);
    case "boolean":
      if (typeof value === "boolean") return value;
      if (mode === "stored") return undefined;
      throw new Error(`${field.label} must be true or false.`);
    case "select": {
      if (typeof value !== "string") {
        if (mode === "stored") return undefined;
        throw new Error(`${field.label} must be one of the configured options.`);
      }
      const allowed = allowedOptionValues(field);
      if (allowed.size > 0 && value && !allowed.has(value)) {
        if (mode === "stored") return undefined;
        throw new Error(`${field.label} contains an unknown option.`);
      }
      return value;
    }
    case "multiselect": {
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        if (mode === "stored") return undefined;
        throw new Error(`${field.label} must be a list of options.`);
      }
      const allowed = allowedOptionValues(field);
      const selected = [...new Set(value)];
      if (allowed.size > 0 && selected.some((item) => !allowed.has(item))) {
        if (mode === "stored") return undefined;
        throw new Error(`${field.label} contains an unknown option.`);
      }
      return selected;
    }
    default:
      return undefined;
  }
}

function isEmptyRequiredValue(value: ManifestPluginSettingValue | undefined) {
  return value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0);
}

function normalizeSettingsPlatform(platform: NodeJS.Platform): "darwin" | "win32" | "linux" {
  if (platform === "win32") {
    return "win32";
  }
  if (platform === "darwin") {
    return "darwin";
  }
  return "linux";
}

export function getPluginSettingsDefaults(
  service: ServiceDefinition,
  platform: NodeJS.Platform = process.platform
): PluginSettingsValues {
  const defaults: PluginSettingsValues = {};
  const platformKey = normalizeSettingsPlatform(platform);
  for (const field of service.settings.fields) {
    const platformDefault = field.defaultValueByPlatform?.[platformKey];
    const rawDefault = platformDefault !== undefined ? platformDefault : field.defaultValue;
    const value = readSettingValue(field, rawDefault, "stored");
    if (value !== undefined) {
      defaults[field.key] = value;
    }
  }
  return defaults;
}

function sanitizePluginSettingsValues(
  service: ServiceDefinition,
  values: unknown,
  mode: ValidationMode
): PluginSettingsValues {
  const rawValues = isObject(values) ? values : {};
  const sanitized: PluginSettingsValues = {};
  for (const field of service.settings.fields) {
    const value = readSettingValue(field, rawValues[field.key], mode);
    if (field.required && isEmptyRequiredValue(value)) {
      if (mode === "stored") {
        continue;
      }
      throw new Error(`${field.label} is required.`);
    }
    if (value !== undefined) {
      sanitized[field.key] = value;
    }
  }
  return sanitized;
}

export function readPluginSettingsSnapshot(
  app: App,
  serviceId: ServiceId,
  shortcutStatuses: PluginGlobalShortcutStatus[] = [],
  platform: NodeJS.Platform = process.platform
): PluginSettingsReadResult {
  const service = getPluginService(serviceId);
  const settingsPath = getPluginSettingsPath(app, service);
  const stored = readStoredPluginSettings(settingsPath);
  const defaults = getPluginSettingsDefaults(service, platform);
  const saved = sanitizePluginSettingsValues(service, stored.values, "stored");
  return {
    ok: true,
    serviceId: service.id,
    settingsPath,
    schema: service.settings,
    defaults,
    values: {
      ...defaults,
      ...saved
    },
    shortcutStatuses
  };
}

export function writePluginSettingsValues(
  app: App,
  serviceId: ServiceId,
  values: unknown,
  shortcutStatuses: PluginGlobalShortcutStatus[] = []
): PluginSettingsWriteResult {
  const service = getPluginService(serviceId);
  const settingsPath = getPluginSettingsPath(app, service);
  const previous = readPluginSettingsSnapshot(app, service.id);
  const nextValues = sanitizePluginSettingsValues(service, values, "write");
  const next = {
    schemaVersion: 1,
    values: nextValues,
    updatedAt: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");

  const nextSnapshot = readPluginSettingsSnapshot(app, service.id, shortcutStatuses);
  const changedKeys = service.settings.fields
    .map((field) => field.key)
    .filter((key) => JSON.stringify(previous.values[key]) !== JSON.stringify(nextSnapshot.values[key]));
  const restartRequired = service.settings.fields.some((field) =>
    field.restartRequired === true && changedKeys.includes(field.key)
  );

  return {
    ...nextSnapshot,
    message: restartRequired
      ? `${service.name} 设置已保存，部分设置需重启插件后生效。`
      : `${service.name} 设置已保存。`,
    restartRequired,
    changedKeys
  };
}

function resolvePluginRelativePath(rootDir: string, relativePath: string) {
  const normalized = relativePath.trim().replace(/\\/gu, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === "." || part === ".." || part.startsWith("."))) {
    throw new Error("customHtmlPath must be a visible relative path inside the plugin directory.");
  }
  const resolved = path.resolve(rootDir, normalized);
  const relative = path.relative(rootDir, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("customHtmlPath escapes the plugin directory.");
  }
  return resolved;
}

export async function openPluginSettingsPage(app: App, serviceId: ServiceId) {
  const service = getPluginService(serviceId);
  const customHtmlPath = service.settings.ui.customHtmlPath?.trim() ?? "";
  if (!customHtmlPath) {
    return {
      ok: false,
      message: `${service.name} 未声明自定义设置页。`,
      serviceId: service.id
    };
  }
  const installDir = getInstallDir(app, service);
  const htmlPath = resolvePluginRelativePath(installDir, customHtmlPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(htmlPath);
  } catch {
    return {
      ok: false,
      message: `自定义设置页不存在：${customHtmlPath}`,
      serviceId: service.id
    };
  }
  if (!stat.isFile()) {
    return {
      ok: false,
      message: `自定义设置页不是文件：${customHtmlPath}`,
      serviceId: service.id
    };
  }

  const state = await staticSiteHostManager.start({
    siteId: `plugin-settings-${service.id}`,
    rootDir: path.dirname(htmlPath),
    index: path.basename(htmlPath),
    spa: false
  });
  return {
    ok: true,
    message: `${service.name} 设置页已准备好。`,
    serviceId: service.id,
    url: state.webUrl
  };
}

export function getPluginSettingsEnv(app: App, service: ServiceDefinition): NodeJS.ProcessEnv {
  if (service.kind !== "plugin") {
    return {};
  }
  const snapshot = readPluginSettingsSnapshot(app, service.id);
  return {
    DESKTOP_PLUGIN_SETTINGS_FILE: snapshot.settingsPath,
    DESKTOP_PLUGIN_SETTINGS_JSON: JSON.stringify(snapshot.values)
  };
}
