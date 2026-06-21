import type {
  DesktopCopilotPageKey,
  DesktopCopilotPagePreference,
  DesktopCopilotPagePreferences
} from "./assistant-settings";
import {
  createDefaultDesktopCopilotPagePreferences,
  isDesktopCopilotPageKey
} from "./assistant-settings";

export function resolveDesktopCopilotPageKey(pathname: string): DesktopCopilotPageKey | null {
  const normalizedPath = pathname.split(/[?#]/u)[0] || "/";
  switch (normalizedPath) {
    case "/control-center":
      return "controlCenter";
    case "/market":
      return "market";
    case "/help":
      return "help";
    case "/agents":
      return "agents";
    case "/automations":
      return "schedules";
    default:
      return null;
  }
}

export function resolveDesktopCopilotPreference(
  preferences: DesktopCopilotPagePreferences | null | undefined,
  pathname: string
): (DesktopCopilotPagePreference & { pageKey: DesktopCopilotPageKey }) | null {
  const pageKey = resolveDesktopCopilotPageKey(pathname);
  if (!pageKey) {
    return null;
  }
  const resolvedPreferences = preferences ?? createDefaultDesktopCopilotPagePreferences();
  const preference = resolvedPreferences[pageKey];
  return {
    pageKey,
    enabled: preference?.enabled ?? true,
    agentKey: preference?.agentKey || createDefaultDesktopCopilotPagePreferences()[pageKey].agentKey
  };
}

export function sanitizeDesktopCopilotPagePreferences(
  value: unknown
): DesktopCopilotPagePreferences {
  const defaults = createDefaultDesktopCopilotPagePreferences();
  const candidate = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

  for (const [rawPageKey, rawPreference] of Object.entries(candidate)) {
    if (!isDesktopCopilotPageKey(rawPageKey)) {
      continue;
    }
    const preference = rawPreference && typeof rawPreference === "object" && !Array.isArray(rawPreference)
      ? rawPreference as Partial<DesktopCopilotPagePreference>
      : {};
    defaults[rawPageKey] = {
      enabled: typeof preference.enabled === "boolean" ? preference.enabled : defaults[rawPageKey].enabled,
      agentKey: typeof preference.agentKey === "string" && preference.agentKey.trim()
        ? preference.agentKey.trim()
        : defaults[rawPageKey].agentKey
    };
  }

  return defaults;
}
