export const DEFAULT_DESKTOP_HELPER_AGENT_KEY = "desktopAssistant";
export const DEFAULT_CHAT_DEFAULT_AGENT_KEY = "";
export const DEFAULT_QUICK_ASSISTANT_ENABLED = true;
export const DEFAULT_QUICK_ASSISTANT_AGENT_KEY = DEFAULT_DESKTOP_HELPER_AGENT_KEY;
export const DEFAULT_QUICK_ASSISTANT_SHORTCUT = "Alt+Space";

export const DESKTOP_COPILOT_PAGE_KEYS = [
  "controlCenter",
  "market",
  "help",
  "agents",
  "schedules",
  "skills"
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

function normalizeShortcutPart(part: string) {
  const normalizedPart = part.trim();
  const lowerPart = normalizedPart.toLowerCase().replace(/[\s_-]+/gu, "");
  switch (lowerPart) {
    case "cmd":
    case "command":
    case "meta":
      return "Command";
    case "cmdorctrl":
    case "commandorcontrol":
    case "commandorctrl":
      return "CommandOrControl";
    case "ctrl":
    case "control":
      return "Control";
    case "alt":
    case "option":
      return "Alt";
    case "shift":
      return "Shift";
    case "space":
    case "spacebar":
      return "Space";
    case "esc":
    case "escape":
      return "Esc";
    case "arrowup":
      return "Up";
    case "arrowdown":
      return "Down";
    case "arrowleft":
      return "Left";
    case "arrowright":
      return "Right";
    case "pageup":
      return "PageUp";
    case "pagedown":
      return "PageDown";
    default:
      return normalizedPart.length === 1
        ? normalizedPart.toUpperCase()
        : normalizedPart;
  }
}

export function normalizeQuickAssistantShortcut(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    return DEFAULT_QUICK_ASSISTANT_SHORTCUT;
  }
  const parts = value
    .split("+")
    .map(normalizeShortcutPart)
    .filter(Boolean);
  return parts.length > 0 ? parts.join("+") : DEFAULT_QUICK_ASSISTANT_SHORTCUT;
}
