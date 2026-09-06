import fs from "node:fs";

import path from "node:path";

import {
  DEFAULT_AGENT_WEBCLIENT_DESKTOP_HOSTING
} from "../../../shared/contracts";

import { t } from "../i18n/main-i18n";

import type {
  FrontendMode,
  Manifest,
  ManifestApi,
  ManifestBackend,
  ManifestCommand,
  ManifestConfigFile,
  ManifestDesktop,
  ManifestDesktopAction,
  ManifestDesktopCapabilities,
  ManifestDesktopCapabilityProvider,
  ManifestDesktopCapabilityRequirement,
  ManifestDesktopDisabledResponse,
  ManifestDesktopHosting,
  ManifestDesktopProxyRoute,
  ManifestEnvBinding,
  ManifestFrontend,
  ManifestPluginBridge,
  ManifestPluginHooks,
  ManifestPluginResources,
  ManifestPluginSettingField,
  ManifestPluginSettingPlatform,
  ManifestPluginSettingType,
  ManifestPluginSettingValue,
  ManifestPluginSettings,
  ManifestPluginSettingsUi,
  ManifestRuntime,
  ManifestScripts,
  ManifestWeb,
  ServiceId,
  ServiceKind,
  ServiceMode
} from "../../../shared/contracts";

import { listArchiveEntries, readFileFromArchive } from "../archive/archive-utils";

export interface ServiceImportTarget {
  key: string;
  label: string;
  relativePath: string;
  required: boolean;
}

export interface ServiceDefinition extends Manifest {
  id: ServiceId;
  kind: ServiceKind;
  description: string;
  pluginApiVersion: number;
  serviceMode: ServiceMode;
  frontend: ManifestFrontend & { mode: FrontendMode };
  frontendMode: FrontendMode;
  scripts: ManifestScripts;
  configFiles: ManifestConfigFile[];
  runtime: ManifestRuntime & {
    pidRelativePath: string;
    logRelativePath: string;
    errorLogRelativePath: string;
    requiredPaths: string[];
  };
  web: ManifestWeb;
  prerequisites: string[];
  desktop: ManifestDesktop & {
    bundleTopLevelDir: string;
    envBindings: ManifestEnvBinding[];
    actions: ManifestDesktopAction[];
    capabilities: ManifestDesktopCapabilities & {
      provides: ManifestDesktopCapabilityProvider[];
      requires: ManifestDesktopCapabilityRequirement[];
    };
  };
  hooks: ManifestPluginHooks & {
    subscribe: string[];
  };
  bridge: ManifestPluginBridge & {
    requests: string[];
  };
  resources: ManifestPluginResources & {
    webapps: NonNullable<ManifestPluginResources["webapps"]>;
    agents: NonNullable<ManifestPluginResources["agents"]>;
    automations: NonNullable<ManifestPluginResources["automations"]>;
  };
  settings: ManifestPluginSettings & {
    schemaVersion: number;
    fields: ManifestPluginSettingField[];
    ui: ManifestPluginSettingsUi;
  };
  assetFileName: string;
  bundleTopLevelDir: string;
  startCommand: string[];
  stopCommand: string[];
  deployCommand: string[] | null;
  importTargets: ServiceImportTarget[];
}

export interface NormalizeManifestOptions {
  defaultKind?: ServiceKind;
  desktop?: Partial<ManifestDesktop>;
  coreServiceDefaultPorts?: Record<string, number>;
}

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function asOptionalString(value: unknown) {
  const next = asString(value).trim();
  return next ? next : undefined;
}

export function asStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function asBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

export function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function isPluginManifestInput(raw: Record<string, unknown>, options: NormalizeManifestOptions) {
  return options.defaultKind !== "builtin";
}

export function assertNoPluginManifestLegacyFields(raw: Record<string, unknown>, options: NormalizeManifestOptions) {
  if (!isPluginManifestInput(raw, options)) {
    return;
  }

  const legacyFields: Record<string, string> = {
    kind: t("manifest.legacy.kind"),
    scripts: t("manifest.legacy.scripts"),
    frontend: t("manifest.legacy.frontend"),
    web: t("manifest.legacy.web")
  };

  for (const [field, message] of Object.entries(legacyFields)) {
    if (Object.prototype.hasOwnProperty.call(raw, field)) {
      throw new Error(`plugin manifest field "${field}" is not supported. ${message}`);
    }
  }
}

export function asStringRecord(value: unknown) {
  const record = asObject(value);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string") {
      result[key] = item;
    }
  }
  return result;
}

export type CoreServicePortOverride = {
  defaultPort: number;
};

export const sharedCoreServicePortOverrides: Record<string, CoreServicePortOverride> = {
  "agent-container-hub": {
    defaultPort: 7079
  },
  "agent-platform": {
    defaultPort: 7078
  },
  "agent-webclient": {
    defaultPort: 7080
  },
  "identity-center": {
    defaultPort: 7076
  }
};

export const testCoreServicePortOffsets: Record<string, number> = {
  "agent-webclient": 0,
  "agent-platform": 1,
  "identity-center": 2,
  "agent-container-hub": 3
};

export function getTestCoreServicePortBase() {
  const raw = process.env.DESKTOP_TEST_CORE_SERVICE_PORT_BASE?.trim() ?? "";
  if (!raw || !/^\d+$/u.test(raw)) {
    return null;
  }

  const portBase = Number.parseInt(raw, 10);
  return Number.isInteger(portBase) && portBase > 0 && portBase + 3 <= 65535
    ? portBase
    : null;
}

export function applyTestCoreServicePortBase(
  overrides: Record<string, CoreServicePortOverride>,
  portBase: number | null
) {
  if (!portBase) {
    return overrides;
  }

  return Object.fromEntries(Object.entries(overrides).map(([serviceId, override]) => {
    const offset = testCoreServicePortOffsets[serviceId];
    return [
      serviceId,
      offset === undefined
        ? override
        : {
            ...override,
            defaultPort: portBase + offset
          }
    ];
  }));
}

export function isValidTcpPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535;
}

export function applyConfiguredCoreServiceDefaultPorts(
  overrides: Record<string, CoreServicePortOverride>,
  defaultPorts: Record<string, number> | undefined
) {
  if (!defaultPorts) {
    return overrides;
  }

  return Object.fromEntries(Object.entries(overrides).map(([serviceId, override]) => {
    const defaultPort = defaultPorts[serviceId];
    return [
      serviceId,
      isValidTcpPort(defaultPort)
        ? {
            ...override,
            defaultPort
          }
        : override
    ];
  }));
}

export function getCoreServicePortOverrides(options: NormalizeManifestOptions = {}): Record<string, CoreServicePortOverride> {
  // The defaults are currently shared, but builtin service manifests are platform-specific.
  let overrides: Record<string, CoreServicePortOverride>;
  if (process.platform === "win32") {
    overrides = applyTestCoreServicePortBase(sharedCoreServicePortOverrides, getTestCoreServicePortBase());
  } else if (process.platform === "darwin") {
    overrides = applyTestCoreServicePortBase(sharedCoreServicePortOverrides, getTestCoreServicePortBase());
  } else {
    overrides = applyTestCoreServicePortBase(sharedCoreServicePortOverrides, getTestCoreServicePortBase());
  }

  return applyConfiguredCoreServiceDefaultPorts(overrides, options.coreServiceDefaultPorts);
}

export function getCoreServicePortOverride(serviceId: string, options: NormalizeManifestOptions = {}) {
  return getCoreServicePortOverrides(options)[serviceId];
}

export function applyCoreServiceWebOverride(serviceId: string, web: ManifestWeb, options: NormalizeManifestOptions) {
  const override = getCoreServicePortOverride(serviceId, options);
  if (!override) {
    return web;
  }

  return {
    ...web,
    defaultPort: override.defaultPort
  } satisfies ManifestWeb;
}

export function isFrontendMode(value: unknown): value is FrontendMode {
  return value === "none" || value === "embedded" || value === "standalone";
}

export function isServiceKind(value: unknown): value is ServiceKind {
  return value === "builtin" || value === "plugin";
}

export function toManifestCommand(value: unknown): ManifestCommand | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }

  const parts = asStringArray(value);
  return parts.length > 0 ? parts : undefined;
}

export function resolveFrontend(raw: Record<string, unknown>) {
  const frontend = asObject(raw.frontend);
  const service = asObject(raw.service);
  const mode = isFrontendMode(frontend.mode)
    ? frontend.mode
    : isFrontendMode(service.ui)
    ? service.ui
    : "none";

  return {
    mode,
    entry: asOptionalString(frontend.entry),
    assetsPrefix: asOptionalString(frontend.assetsPrefix),
    directAccess: asBoolean(frontend.directAccess),
    hostManaged: asBoolean(frontend.hostManaged),
    dist: asOptionalString(frontend.dist),
    index: asOptionalString(frontend.index),
    spa: asBoolean(frontend.spa)
  } satisfies ManifestFrontend;
}

export function hasPluginResources(raw: Record<string, unknown>) {
  const resources = asObject(raw.resources);
  return (
    Array.isArray(resources.webapps) ||
    Array.isArray(resources.agents) ||
    Array.isArray(resources.automations)
  );
}

export function resolveServiceMode(raw: Record<string, unknown>): ServiceMode {
  const scripts = asObject(raw.scripts);
  const lifecycle = asObject(raw.lifecycle);
  const hasStartOrStop =
    lifecycle.start !== undefined ||
    lifecycle.stop !== undefined ||
    scripts.start !== undefined ||
    scripts.stop !== undefined;
  return hasStartOrStop || !hasPluginResources(raw) ? "service" : "resource";
}

export function resolveScripts(raw: Record<string, unknown>, serviceMode: ServiceMode) {
  const scripts = asObject(raw.scripts);
  const lifecycle = asObject(raw.lifecycle);

  const start = toManifestCommand(lifecycle.start) ?? toManifestCommand(scripts.start);
  const stop = toManifestCommand(lifecycle.stop) ?? toManifestCommand(scripts.stop);
  const deploy = toManifestCommand(lifecycle.deploy) ?? toManifestCommand(scripts.deploy);

  if ((!start || !stop) && serviceMode === "service") {
    throw new Error("manifest lifecycle.start/stop are required");
  }

  return {
    start: start ?? [],
    stop: stop ?? [],
    deploy
  } satisfies ManifestScripts;
}

export function resolveConfigFiles(raw: Record<string, unknown>) {
  if (!Array.isArray(raw.configFiles)) {
    return [];
  }

  return raw.configFiles.map((item) => {
    const config = asObject(item);
    return {
      key: asString(config.key),
      label: asString(config.label),
      relativePath: asString(config.relativePath),
      templateRelativePath: asOptionalString(config.templateRelativePath),
      required: config.required !== false
    } satisfies ManifestConfigFile;
  });
}

export function resolveServiceConfigFiles(raw: Record<string, unknown>, _serviceId: string) {
  return resolveConfigFiles(raw);
}

export function resolveRuntime(raw: Record<string, unknown>) {
  const runtime = asObject(raw.runtime);
  return {
    pidRelativePath: asOptionalString(runtime.pidRelativePath) ?? "",
    logRelativePath: asOptionalString(runtime.logRelativePath) ?? "",
    errorLogRelativePath: asOptionalString(runtime.errorLogRelativePath) ?? "",
    requiredPaths: asStringArray(runtime.requiredPaths)
  } satisfies ManifestRuntime & {
    pidRelativePath: string;
    logRelativePath: string;
    errorLogRelativePath: string;
    requiredPaths: string[];
  };
}

export function applyCoreServiceRuntimeOverride(serviceId: string, runtime: ReturnType<typeof resolveRuntime>) {
  if (serviceId !== "agent-platform") {
    return runtime;
  }

  return {
    ...runtime,
    pidRelativePath: "run/agent-platform.pid",
    logRelativePath: "run/agent-platform.log"
  };
}

export function resolveApi(raw: Record<string, unknown>) {
  if (raw.api === undefined) {
    return undefined;
  }
  const api = asObject(raw.api);
  return {
    enabled: api.enabled !== false,
    adminBaseUrl: asOptionalString(api.adminBaseUrl),
    openidBaseUrl: asOptionalString(api.openidBaseUrl),
    oauth2BaseUrl: asOptionalString(api.oauth2BaseUrl)
  } satisfies ManifestApi;
}

export function resolveBackend(raw: Record<string, unknown>) {
  if (raw.backend === undefined) {
    return undefined;
  }
  const backend = asObject(raw.backend);
  const entry = asOptionalString(backend.entry);
  return entry ? ({ entry } satisfies ManifestBackend) : undefined;
}

export function resolveWeb(raw: Record<string, unknown>) {
  const service = asObject(raw.service);
  const serviceWeb = asObject(service.web);
  if (raw.web === undefined && service.web === undefined) {
    return {
      routePath: "",
      portEnvKey: "",
      defaultPort: 0
    } satisfies ManifestWeb;
  }

  const web = asObject(raw.web);
  return {
    routePath: asString(serviceWeb.healthPath) || asString(web.routePath),
    portEnvKey: asString(serviceWeb.portEnvKey) || asString(web.portEnvKey),
    defaultPort: asNumber(serviceWeb.defaultPort) ?? asNumber(web.defaultPort) ?? 0
  } satisfies ManifestWeb;
}

export function resolvePluginHooks(raw: Record<string, unknown>): ManifestPluginHooks & { subscribe: string[] } {
  const hooks = asObject(raw.hooks);
  return {
    subscribe: asStringArray(hooks.subscribe)
  };
}

export function resolvePluginBridge(raw: Record<string, unknown>): ManifestPluginBridge & { requests: string[] } {
  const bridge = asObject(raw.bridge);
  return {
    requests: asStringArray(bridge.requests)
  };
}

export function resolvePluginResources(raw: Record<string, unknown>): ServiceDefinition["resources"] {
  const resources = asObject(raw.resources);
  const webapps = Array.isArray(resources.webapps)
    ? resources.webapps.map((item) => {
        const webapp = asObject(item);
        return {
          id: asString(webapp.id),
          source: asString(webapp.source)
        };
      }).filter((item) => item.id && item.source)
    : [];
  const agents = Array.isArray(resources.agents)
    ? resources.agents.map((item) => {
        const agent = asObject(item);
        return {
          key: asString(agent.key),
          definition: asObject(agent.definition),
          soulPrompt: asOptionalString(agent.soulPrompt),
          agentsPrompt: asOptionalString(agent.agentsPrompt)
        };
      }).filter((item) => item.key)
    : [];
  const automations = Array.isArray(resources.automations)
    ? resources.automations.map((item) => {
        const automation = asObject(item);
        return {
          id: asString(automation.id),
          name: asString(automation.name),
          description: asOptionalString(automation.description),
          cron: asString(automation.cron),
          agentKey: asString(automation.agentKey),
          enabled: asBoolean(automation.enabled),
          teamId: asOptionalString(automation.teamId),
          zoneId: asOptionalString(automation.zoneId),
          remainingRuns: asNumber(automation.remainingRuns),
          query: asObject(automation.query)
        };
      }).filter((item) => item.id && item.name && item.cron && item.agentKey)
    : [];
  return { webapps, agents, automations };
}

export const SUPPORTED_PLUGIN_SETTING_TYPES = new Set<ManifestPluginSettingType>([
  "text",
  "textarea",
  "number",
  "boolean",
  "select",
  "multiselect",
  "shortcut",
  "duration"
]);

export const SUPPORTED_PLUGIN_SETTING_PLATFORMS = new Set<ManifestPluginSettingPlatform>([
  "darwin",
  "win32",
  "linux"
] as ManifestPluginSettingPlatform[]);

export function isPluginSettingType(value: unknown): value is ManifestPluginSettingType {
  return typeof value === "string" && SUPPORTED_PLUGIN_SETTING_TYPES.has(value as ManifestPluginSettingType);
}

export function resolvePluginSettingValue(
  type: ManifestPluginSettingType,
  value: unknown
): ManifestPluginSettingValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  switch (type) {
    case "text":
    case "textarea":
    case "select":
    case "shortcut":
      return typeof value === "string" ? value : undefined;
    case "number":
    case "duration":
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "multiselect":
      return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : undefined;
    default:
      return undefined;
  }
}

export function resolvePluginSettingOptions(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      const option = asObject(item);
      const optionValue = asOptionalString(option.value);
      const label = asOptionalString(option.label) ?? optionValue;
      return optionValue && label ? { label, value: optionValue } : null;
    })
    .filter((item): item is { label: string; value: string } => Boolean(item));
}

export function resolvePluginSettingPlatformDefaults(
  type: ManifestPluginSettingType,
  value: unknown
) {
  const defaults = asObject(value);
  const result: Partial<Record<ManifestPluginSettingPlatform, ManifestPluginSettingValue>> = {};
  for (const [platform, defaultValue] of Object.entries(defaults)) {
    if (!SUPPORTED_PLUGIN_SETTING_PLATFORMS.has(platform as ManifestPluginSettingPlatform)) {
      continue;
    }
    const normalizedValue = resolvePluginSettingValue(type, defaultValue);
    if (normalizedValue !== undefined) {
      result[platform as ManifestPluginSettingPlatform] = normalizedValue;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function resolvePluginSettings(raw: Record<string, unknown>): ServiceDefinition["settings"] {
  const settings = asObject(raw.settings);
  const schemaVersion = Math.trunc(asNumber(settings.schemaVersion) ?? 1);
  const fields: ManifestPluginSettingField[] = [];
  const seenKeys = new Set<string>();

  if (Array.isArray(settings.fields)) {
    for (const item of settings.fields) {
      const field = asObject(item);
      const key = asOptionalString(field.key);
      const type = isPluginSettingType(field.type) ? field.type : undefined;
      if (!key || !type || seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
      const normalized: ManifestPluginSettingField = {
        key,
        type,
        label: asOptionalString(field.label) ?? key,
        required: field.required === true,
        restartRequired: field.restartRequired === true
      };
      const description = asOptionalString(field.description);
      if (description) normalized.description = description;
      const placeholder = asOptionalString(field.placeholder);
      if (placeholder) normalized.placeholder = placeholder;
      const defaultValue = resolvePluginSettingValue(type, field.defaultValue);
      if (defaultValue !== undefined) normalized.defaultValue = defaultValue;
      const defaultValueByPlatform = resolvePluginSettingPlatformDefaults(type, field.defaultValueByPlatform);
      if (defaultValueByPlatform) normalized.defaultValueByPlatform = defaultValueByPlatform;
      const options = resolvePluginSettingOptions(field.options);
      if (options.length > 0) normalized.options = options;
      const min = asNumber(field.min);
      if (min !== undefined) normalized.min = min;
      const max = asNumber(field.max);
      if (max !== undefined) normalized.max = max;
      const step = asNumber(field.step);
      if (step !== undefined) normalized.step = step;
      fields.push(normalized);
    }
  }

  const uiRaw = asObject(settings.ui);
  const ui: ManifestPluginSettingsUi = {};
  const customHtmlPath = asOptionalString(uiRaw.customHtmlPath);
  if (customHtmlPath) {
    ui.customHtmlPath = customHtmlPath;
  }

  return {
    schemaVersion: schemaVersion > 0 ? schemaVersion : 1,
    fields,
    ui
  };
}

export function validateDesktopActionGlobalShortcutReferences(
  action: ManifestDesktopAction,
  settings: ServiceDefinition["settings"]
) {
  const settingKey = action.globalShortcut?.settingKey;
  if (!settingKey) {
    return;
  }
  const field = settings.fields.find((item) => item.key === settingKey);
  if (!field || field.type !== "shortcut") {
    throw new Error(`desktop action ${action.id} globalShortcut.settingKey must reference a shortcut setting field.`);
  }
}

export function resolveDesktopActions(
  raw: Record<string, unknown>,
  settings: ServiceDefinition["settings"]
): ManifestDesktopAction[] {
  const desktop = asObject(raw.desktop);
  if (!Array.isArray(desktop.actions)) {
    return [];
  }
  const actions: ManifestDesktopAction[] = [];
  for (const item of desktop.actions) {
    const action = asObject(item);
    const id = asString(action.id);
    const label = asString(action.label);
    const icon = asOptionalString(action.icon);
    if (!id || !label) {
      continue;
    }
    const entry: ManifestDesktopAction = {
      id,
      label,
      ...(icon ? { icon } : {}),
      placement: "controlCenter",
      requiresRunning: action.requiresRunning === true
    };
    const globalShortcut = asObject(action.globalShortcut);
    const settingKey = asOptionalString(globalShortcut.settingKey);
    if (settingKey) {
      entry.globalShortcut = { settingKey };
    }
    validateDesktopActionGlobalShortcutReferences(entry, settings);
    actions.push(entry);
  }
  return actions;
}

export function normalizeRoutePath(value: unknown) {
  const pathValue = asOptionalString(value);
  if (!pathValue) {
    return "";
  }
  return pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
}

export function cloneDisabledResponse(
  response: ManifestDesktopDisabledResponse | undefined
): ManifestDesktopDisabledResponse | undefined {
  if (!response) {
    return undefined;
  }
  return {
    ...(response.status === undefined ? {} : { status: response.status }),
    ...(response.json === undefined ? {} : { json: response.json }),
    ...(response.body === undefined ? {} : { body: response.body }),
    ...(response.contentType === undefined ? {} : { contentType: response.contentType })
  };
}
