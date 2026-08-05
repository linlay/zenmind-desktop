export type EnterpriseChatRemoteActionRisk = "low" | "medium" | "high";

export type EnterpriseChatRemoteActionDefinition = {
  name: string;
  category: string;
  title: string;
  risk: EnterpriseChatRemoteActionRisk;
  summary: (args: Record<string, unknown>) => string;
};

function text(args: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().slice(0, 160);
    }
  }
  return "";
}

function targetSummary(label: string, args: Record<string, unknown>, ...keys: string[]) {
  const target = text(args, ...keys);
  return target ? `${label}: ${target}` : label;
}

export const ENTERPRISE_CHAT_REMOTE_ACTIONS = [
  { name: "desktop.controlCenter.openService", category: "navigation", title: "Open Control Center service", risk: "low", summary: (args) => targetSummary("Open Control Center service", args, "serviceId", "id") },
  { name: "desktop.market.openItem", category: "navigation", title: "Open market item", risk: "low", summary: (args) => targetSummary("Open market item", args, "itemId", "id") },
  { name: "desktop.agent.open", category: "navigation", title: "Open agent", risk: "low", summary: (args) => targetSummary("Open agent", args, "agentKey", "id") },
  { name: "desktop.skill.open", category: "navigation", title: "Open skill", risk: "low", summary: (args) => targetSummary("Open skill", args, "skillKey", "id") },
  { name: "desktop.website.open", category: "navigation", title: "Open website", risk: "low", summary: (args) => targetSummary("Open website", args, "websiteId", "id") },
  { name: "desktop.webapp.open", category: "navigation", title: "Open WebApp", risk: "medium", summary: (args) => targetSummary("Start and open WebApp", args, "webappId", "id") },

  { name: "desktop.theme.set", category: "appearance", title: "Change theme", risk: "medium", summary: (args) => targetSummary("Change Desktop theme", args, "themeMode") },
  { name: "desktop.locale.set", category: "appearance", title: "Change language", risk: "medium", summary: (args) => targetSummary("Change Desktop language", args, "locale") },
  { name: "desktop.pet.show", category: "appearance", title: "Show pet", risk: "medium", summary: () => "Show Desktop pet" },
  { name: "desktop.pet.hide", category: "appearance", title: "Hide pet", risk: "medium", summary: () => "Hide Desktop pet" },
  { name: "desktop.pet.set", category: "appearance", title: "Set pet", risk: "medium", summary: (args) => targetSummary("Set Desktop pet", args, "appearanceId", "id") },
  { name: "desktop.copilot.setPagePreference", category: "appearance", title: "Set page assistant", risk: "medium", summary: (args) => targetSummary("Set page assistant", args, "pageKey") },

  { name: "desktop.website.add", category: "content", title: "Add website", risk: "medium", summary: (args) => targetSummary("Add website", (args.input as Record<string, unknown>) || args, "label", "url") },
  { name: "desktop.website.update", category: "content", title: "Update website", risk: "medium", summary: (args) => targetSummary("Update website", args, "websiteId", "id") },
  { name: "desktop.webapp.updatePreferences", category: "content", title: "Update WebApp", risk: "medium", summary: (args) => targetSummary("Update WebApp preferences", args, "webappId", "id") },
  { name: "desktop.webapp.restart", category: "content", title: "Restart WebApp", risk: "high", summary: (args) => targetSummary("Restart WebApp", args, "webappId", "id") },
  { name: "desktop.agent.update", category: "content", title: "Update agent", risk: "high", summary: (args) => targetSummary("Update agent", args, "agentKey", "id") },
  { name: "desktop.skill.update", category: "content", title: "Update skill", risk: "high", summary: (args) => targetSummary("Update skill file", args, "skillKey", "id") },

  { name: "desktop.market.installItem", category: "installation", title: "Install market item", risk: "high", summary: (args) => targetSummary("Install market item", args, "itemId", "id") },
  { name: "desktop.market.updateItem", category: "installation", title: "Update market item", risk: "high", summary: (args) => targetSummary("Update market item", args, "itemId", "id") },
  { name: "desktop.controlCenter.startService", category: "installation", title: "Start Desktop service", risk: "high", summary: (args) => targetSummary("Start Desktop service", args, "serviceId", "id") },
  { name: "desktop.controlCenter.restartService", category: "installation", title: "Restart Desktop service", risk: "high", summary: (args) => targetSummary("Restart Desktop service", args, "serviceId", "id") },

  { name: "desktop.support.requestDiagnostics", category: "support", title: "Request diagnostics", risk: "high", summary: () => "Collect and send a redacted diagnostic bundle" },
  { name: "desktop.support.requestScreenshot", category: "support", title: "Request screenshot", risk: "high", summary: (args) => targetSummary("Capture and send a Desktop screenshot", args, "mode") },
  { name: "desktop.support.requestServiceLogs", category: "support", title: "Request service logs", risk: "high", summary: (args) => targetSummary("Read and send service logs", args, "serviceId") },
  { name: "desktop.support.requestWebappLogs", category: "support", title: "Request WebApp logs", risk: "high", summary: (args) => targetSummary("Read and send WebApp logs", args, "webappId", "id") },
  { name: "desktop.support.requestSystemInfo", category: "support", title: "Request system information", risk: "high", summary: () => "Collect and send system information" }
] as const satisfies readonly EnterpriseChatRemoteActionDefinition[];

export const ENTERPRISE_CHAT_REMOTE_ACTION_NAMES = ENTERPRISE_CHAT_REMOTE_ACTIONS.map((item) => item.name);

export function getEnterpriseChatRemoteAction(action: string): EnterpriseChatRemoteActionDefinition | null {
  return ENTERPRISE_CHAT_REMOTE_ACTIONS.find((item) => item.name === action) ?? null;
}
