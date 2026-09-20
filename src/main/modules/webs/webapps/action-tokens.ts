import { resolveWebappAction } from "../../../../shared/webapp-bridge";
import { randomBytes } from "node:crypto";
import type { WebappEntry } from "../../../../shared/contracts";
import {
  getWebappAllowedActions,
  type WebappCapabilityScope
} from "./capability-policy";

type WebappActionGrant = {
  webappId: string;
  scope: WebappCapabilityScope;
  actions: Set<string>;
  controller: AbortController;
};

const grants = new Map<string, WebappActionGrant>();

export function issueWebappActionToken(item: WebappEntry, scope: WebappCapabilityScope) {
  const token = randomBytes(32).toString("base64url");
  grants.set(token, {
    webappId: item.id,
    controller: new AbortController(),
    scope,
    actions: new Set(getWebappAllowedActions(item, scope))
  });
  return token;
}

export function revokeWebappActionToken(token: string) {
  if (token) {
    grants.get(token)?.controller.abort();
    grants.delete(token);
  }
}

export function authorizeWebappActionToken(
  token: string,
  action: string,
  requiredScope?: WebappCapabilityScope
) {
  const grant = grants.get(token);
  return grant && grant.actions.has(resolveWebappAction(action)) && (!requiredScope || grant.scope === requiredScope)
    ? { ok: true as const, webappId: grant.webappId, scope: grant.scope, signal: grant.controller.signal }
    : { ok: false as const, webappId: "", scope: null };
}

export function invalidateWebappActionTokens() {
  for (const grant of grants.values()) grant.controller.abort();
  grants.clear();
}

export const __actionTokenTestInternals = {
  clear: invalidateWebappActionTokens,
  size() {
    return grants.size;
  }
};
