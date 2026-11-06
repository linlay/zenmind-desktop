import {
  type ManifestPluginHooks,
  type EngineResource,
  type ManifestPluginBridge,
  type ManifestPluginSettingType,
  type ManifestPluginSettingPlatform,
  type ManifestPluginSettingValue,
  type ManifestPluginSettingField,
  type ManifestPluginSettingsUi,
  type ManifestDesktopAction
} from "../../../shared/contracts";
import { asObject, asStringArray, asString, asOptionalString, asBoolean, asNumber } from "./manifest-values";
import { ServiceDefinition } from "./manifest-types";

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

// Engine declarations use the existing Manifest parser; never coerce execution fields.
function engineObject(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid engine declaration object");
  const object = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(object, key)) || Object.keys(object).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new Error("Invalid engine declaration fields");
  }
  return object;
}

function engineString(value: unknown, label: string, pattern?: RegExp): string {
  if (typeof value !== "string" || !value || value.includes("\0") || (pattern && !pattern.test(value))) throw new Error(`Invalid engine ${label}`);
  return value;
}

const engineID = /^[a-z0-9][a-z0-9.-]*$/u;
const engineVersion = /^\d+\.\d+\.\d+$/u;
const enginePath = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/u;

function engineArgs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32 || value.some(arg => typeof arg !== "string" || arg.length > 4096 || arg.includes("\0"))) throw new Error("Invalid engine launch arguments");
  return [...value];
}

function engineList(value: unknown, label: string, min = 0, max = 16): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`Invalid engine ${label}`);
  return value;
}

function uniqueEngineIDs(values: string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate engine ${label}`);
}

function resolveAgentEngines(raw: Record<string, unknown>): EngineResource[] {
  const resources = asObject(raw.resources);
  if (resources.agentEngines === undefined) return [];
  // First-release engine packages are declaration-only; generic plugin resources
  // continue using API v1 and their existing installation/rollback ownership.
  engineObject(raw, ["pluginApiVersion", "id", "name", "version", "description", "platform", "desktop", "requires", "resources"]);
  engineObject(resources, ["agentEngines"]);
  engineObject(raw.desktop, ["bundleTopLevelDir"]);
  const engines = engineList(resources.agentEngines, "resources", 1);
  const requires = engineObject(raw.requires, ["platformAgentEngineApi", "webclientAgentEngineApi"]);
  if (raw.pluginApiVersion !== 2 || requires.platformAgentEngineApi !== 2 || requires.webclientAgentEngineApi !== 1) throw new Error("Unsupported engine plugin API");
  engineString(raw.id, "plugin identity", engineID);
  engineString(raw.version, "plugin version", engineVersion);
  const platform = engineObject(raw.platform, ["os", "arch"]);
  if (!["darwin", "windows"].includes(asString(platform.os)) || !["arm64", "amd64"].includes(asString(platform.arch))) throw new Error("Invalid engine platform");
  if (asObject(raw.desktop).bundleTopLevelDir !== raw.id) throw new Error("Invalid engine bundle identity");
  if (raw.lifecycle !== undefined || raw.service !== undefined || raw.backend !== undefined || raw.api !== undefined) throw new Error("Engine plugins are resource plugins without service lifecycle");
  const result = engines.map(value => {
    const engine = engineObject(value, ["id", "name", "protocol", "transport", "launch", "dependencies"], ["adapter", "authentication"]);
    const launch = engineObject(engine.launch, ["runtime", "entry", "args"]);
    if (engine.protocol !== "acp" || engine.transport !== "stdio" || (launch.runtime !== "node" && launch.runtime !== "executable")) throw new Error("Unsupported engine launch protocol");
    const adapter = engine.adapter === undefined ? undefined : engineObject(engine.adapter, ["package", "version", "acpSdkVersion"]);

    const dependencies = engineList(engine.dependencies, "dependencies").map(value => {
      const dependency = engineObject(value, ["id", "version", "delivery"], ["path", "entry"]);
      if (dependency.delivery !== "bundled" && dependency.delivery !== "host-managed") throw new Error("Invalid engine dependency delivery");
      return {
        id: engineString(dependency.id, "dependency id", engineID),
        version: engineString(dependency.version, "dependency version", engineVersion),
        delivery: dependency.delivery,
        ...(dependency.path === undefined ? {} : { path: engineString(dependency.path, "dependency path", /^[A-Za-z0-9_@-][A-Za-z0-9._@-]*(\/[A-Za-z0-9_@-][A-Za-z0-9._@-]*)*$/u) }),
        ...(dependency.entry === undefined ? {} : { entry: engineString(dependency.entry, "dependency entry", /^[A-Za-z0-9_@-][A-Za-z0-9._@-]*(\/[A-Za-z0-9_@-][A-Za-z0-9._@-]*)*$/u) })
      } as EngineResource["dependencies"][number];
    });
    uniqueEngineIDs(dependencies.map(item => item.id), "dependency IDs");
    const authentication = engine.authentication === undefined ? undefined : engineObject(engine.authentication, ["terminalMethods"], ["agentMethods"]);
    const agentMethods = authentication?.agentMethods === undefined ? undefined : engineList(authentication.agentMethods, "agent authentication methods", 0, 8).map(value => {
      const method = engineString(value, "agent authentication method");
      if (method.length > 128) throw new Error("Invalid engine authentication method length");
      return method;
    });
    const methods = authentication === undefined ? undefined : engineList(authentication.terminalMethods, "authentication methods", 0, 8).map(value => {
      const method = engineObject(value, ["methodId", "args"]);
      return { methodId: engineString(method.methodId, "authentication method"), args: engineArgs(method.args) };
    });
    if (methods) uniqueEngineIDs([...methods.map(item => item.methodId), ...(agentMethods ?? [])], "authentication methods");
    return {
      id: engineString(engine.id, "resource id", engineID), name: engineString(engine.name, "name"), protocol: "acp", transport: "stdio",
      launch: { runtime: launch.runtime, entry: engineString(launch.entry, "launch entry", enginePath), args: engineArgs(launch.args) },
      ...(adapter ? { adapter: { package: engineString(adapter.package, "adapter package"), version: engineString(adapter.version, "adapter version", engineVersion), acpSdkVersion: engineString(adapter.acpSdkVersion, "ACP SDK version", engineVersion) } } : {}),
      dependencies, ...(methods ? { authentication: { terminalMethods: methods, ...(agentMethods ? { agentMethods } : {}) } } : {})
    } satisfies EngineResource;
  });
  uniqueEngineIDs(result.map(item => item.id), "resource IDs");
  return result;
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
          zoneId: asOptionalString(automation.zoneId),
          remainingRuns: asNumber(automation.remainingRuns),
          query: asObject(automation.query)
        };
      }).filter((item) => item.id && item.name && item.cron && item.agentKey)
    : [];
  return { webapps, agents, automations, agentEngines: resolveAgentEngines(raw) };
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
