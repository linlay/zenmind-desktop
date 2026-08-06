import type { WebappEntry } from "../../../shared/contracts";
import {
  WEBAPP_BRIDGE_ACTIONS,
  WEBAPP_BRIDGE_CAPABILITY_ACTIONS,
  type WebappBridgeCapability
} from "../../../shared/webapp-bridge";

const LEGACY_V4_BACKEND_ACTIONS = Object.freeze([
  WEBAPP_BRIDGE_ACTIONS.assistantChat
] as const);

const LEGACY_V4_PAGE_ACTIONS = LEGACY_V4_BACKEND_ACTIONS;

export type WebappCapabilityScope = "backendActionToken" | "localPageGateway";

export const WEBAPP_CAPABILITY_POLICY = Object.freeze({
  legacyV4Backend: LEGACY_V4_BACKEND_ACTIONS,
  legacyV4Page: LEGACY_V4_PAGE_ACTIONS
});

function declaredCapabilities(item: WebappEntry) {
  return new Set<WebappBridgeCapability>(item.desktopBridge?.capabilities ?? []);
}

export function getWebappAllowedActions(item: WebappEntry, scope: WebappCapabilityScope) {
  if (item.schemaVersion < 5) {
    return [...(scope === "backendActionToken" ? LEGACY_V4_BACKEND_ACTIONS : LEGACY_V4_PAGE_ACTIONS)];
  }
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
  return item.schemaVersion === 5 && item.desktopBridge?.capabilities.includes(capability) === true;
}
