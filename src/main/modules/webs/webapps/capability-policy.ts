import type { WebappEntry } from "../../../../shared/contracts";
import {
  WEBAPP_BRIDGE_ACTIONS,
  resolveWebappAction,
  WEBAPP_BRIDGE_CAPABILITY_ACTIONS,
} from "../../../../shared/webapp-bridge";

export type WebappCapabilityScope = "backendActionToken" | "localPageGateway";

export function getWebappAllowedActions(item: WebappEntry, scope: WebappCapabilityScope) {
  const actions = new Set<string>();
  if (scope === "localPageGateway") {
    actions.add(WEBAPP_BRIDGE_ACTIONS.capabilitiesList);
  }
  for (const [capability, capabilityActions] of Object.entries(WEBAPP_BRIDGE_CAPABILITY_ACTIONS)) {
    if (capability === "kanban.read" && !item.desktopBridge?.kanbanRead) continue;
    if ((capability === "connector.read" || capability === "desktop.connector.authenticate") && !Object.keys(item.desktopBridge?.connectorOperations ?? {}).length) continue;
    if (scope === "backendActionToken" && capability !== "assistant.chat" && capability !== "connector.read" && capability !== "skill.read" && capability !== "artifact.read" && capability !== "kanban.read") {
      continue;
    }
    for (const action of capabilityActions) {
      actions.add(action);
    }
  }

  return [...actions];
}

export function isWebappActionAllowed(
  item: WebappEntry,
  scope: WebappCapabilityScope,
  action: string
) {
  return getWebappAllowedActions(item, scope).includes(resolveWebappAction(action));
}
