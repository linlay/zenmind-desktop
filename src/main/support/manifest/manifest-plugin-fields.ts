import {
  type ManifestPluginHooks,
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
