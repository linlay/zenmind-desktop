export const DEFAULT_DESKTOP_HELPER_AGENT_KEY = "desktopAssistant";
export const DEFAULT_QUICK_ASSISTANT_ENABLED = true;
export const DEFAULT_QUICK_ASSISTANT_AGENT_KEY = DEFAULT_DESKTOP_HELPER_AGENT_KEY;

export const DESKTOP_COPILOT_PAGE_KEYS = [
  "controlCenter",
  "market",
  "help",
  "agents",
  "schedules"
] as const;

export type DesktopCopilotPageKey = typeof DESKTOP_COPILOT_PAGE_KEYS[number];

export interface DesktopCopilotPagePreference {
  enabled: boolean;
  agentKey: string;
}

export type DesktopCopilotPagePreferences = Record<DesktopCopilotPageKey, DesktopCopilotPagePreference>;
export type DesktopCopilotPagePreferencesInput = Partial<Record<DesktopCopilotPageKey, Partial<DesktopCopilotPagePreference>>>;

export function createDefaultDesktopCopilotPagePreferences(): DesktopCopilotPagePreferences {
  return DESKTOP_COPILOT_PAGE_KEYS.reduce((preferences, pageKey) => {
    preferences[pageKey] = {
      enabled: true,
      agentKey: DEFAULT_DESKTOP_HELPER_AGENT_KEY
    };
    return preferences;
  }, {} as DesktopCopilotPagePreferences);
}

export function isDesktopCopilotPageKey(value: string): value is DesktopCopilotPageKey {
  return (DESKTOP_COPILOT_PAGE_KEYS as readonly string[]).includes(value);
}
