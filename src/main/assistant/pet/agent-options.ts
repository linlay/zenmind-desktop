import type {
  AssistantNavAgentIcon,
  DesktopPetAgentOption,
} from "../../../shared/contracts";
import {
  DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY,
  sanitizeDesktopPetUnreadCount,
  toDesktopPetText,
} from "../../../shared/desktop-pet";

type AgentSummary = {
  key?: unknown;
  name?: unknown;
  displayName?: unknown;
  role?: unknown;
  icon?: unknown;
  stats?: {
    unreadCount?: unknown;
  };
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAgentIcon(agent: AgentSummary): AssistantNavAgentIcon | undefined {
  if (typeof agent.icon === "string" && agent.icon.trim()) {
    return agent.icon.trim();
  }
  if (!isObjectRecord(agent.icon)) {
    return undefined;
  }
  const color = toDesktopPetText(agent.icon.color);
  const name = toDesktopPetText(agent.icon.name);
  return color || name
    ? {
        ...(color ? { color } : {}),
        ...(name ? { name } : {}),
      }
    : undefined;
}

export function toDesktopPetAgentOptions(agentsInput: unknown): DesktopPetAgentOption[] {
  const agents = Array.isArray(agentsInput) ? agentsInput as AgentSummary[] : [];
  return agents
    .map((agent) => {
      const agentKey = toDesktopPetText(agent.key);
      if (!agentKey) {
        return null;
      }
      const icon = readAgentIcon(agent);
      return {
        agentKey,
        displayName:
          toDesktopPetText(agent.name) ||
          toDesktopPetText(agent.displayName) ||
          agentKey,
        role: toDesktopPetText(agent.role),
        ...(icon ? { icon } : {}),
        unreadCount: sanitizeDesktopPetUnreadCount(agent.stats?.unreadCount),
      };
    })
    .filter((agent): agent is DesktopPetAgentOption => Boolean(agent))
    .sort((left, right) => {
      if (left.agentKey === DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY) {
        return -1;
      }
      if (right.agentKey === DEFAULT_DESKTOP_PET_BOUND_AGENT_KEY) {
        return 1;
      }
      return left.displayName.localeCompare(right.displayName, "zh-CN");
    });
}
