export const DEFAULT_DESKTOP_HELPER_AGENT_KEY = "desktopAssistant";

export const DESKTOP_COPILOT_PAGE_KEYS = [
  "controlCenter",
  "market",
  "help",
  "agents",
  "schedules",
  "memory"
] as const;

export type DesktopCopilotPageKey = typeof DESKTOP_COPILOT_PAGE_KEYS[number];

export interface DesktopCopilotPagePreference {
  enabled: boolean;
  agentKey: string;
}

export type DesktopCopilotPagePreferences = Record<DesktopCopilotPageKey, DesktopCopilotPagePreference>;
export type DesktopCopilotPagePreferencesInput = Partial<Record<DesktopCopilotPageKey, Partial<DesktopCopilotPagePreference>>>;

export const DESKTOP_COPILOT_PAGE_LABELS: Record<DesktopCopilotPageKey, string> = {
  controlCenter: "控制中心",
  market: "功能市场",
  help: "帮助",
  agents: "智能体管理",
  schedules: "自动化",
  memory: "记忆管理"
};

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
