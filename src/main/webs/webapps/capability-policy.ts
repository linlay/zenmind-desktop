import type { WebappEntry } from "../../../shared/contracts";
import {
  WEBAPP_BRIDGE_ACTIONS,
  WEBAPP_BRIDGE_CAPABILITY_ACTIONS,
  type WebappBridgeCapability
} from "../../../shared/webapp-bridge";

export type WebappCapabilityScope = "backendActionToken" | "localPageGateway";

function declaredCapabilities(item: WebappEntry) {
  return new Set(
    Object.keys(item.desktopBridge?.capabilities ?? {}) as WebappBridgeCapability[]
  );
}

export function getWebappAllowedActions(item: WebappEntry, scope: WebappCapabilityScope) {
  const declared = declaredCapabilities(item);
  const actions = new Set<string>();
  if (scope === "localPageGateway") {
    actions.add(WEBAPP_BRIDGE_ACTIONS.capabilitiesList);
  }
  for (const capability of declared) {
    if (scope === "backendActionToken" && capability !== "assistant.chat") {
      continue;
    }
    for (const action of WEBAPP_BRIDGE_CAPABILITY_ACTIONS[capability]) {
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
  return getWebappAllowedActions(item, scope).includes(action);
}

export function webappDeclaresCapability(item: WebappEntry, capability: WebappBridgeCapability) {
  return Object.hasOwn(item.desktopBridge?.capabilities ?? {}, capability);
}
