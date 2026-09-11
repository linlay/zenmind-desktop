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
};

const grants = new Map<string, WebappActionGrant>();

export function issueWebappActionToken(item: WebappEntry, scope: WebappCapabilityScope) {
  const token = randomBytes(32).toString("base64url");
  grants.set(token, {
    webappId: item.id,
    scope,
    actions: new Set(getWebappAllowedActions(item, scope))
  });
  return token;
}

export function revokeWebappActionToken(token: string) {
  if (token) {
    grants.delete(token);
  }
}

export function authorizeWebappActionToken(
  token: string,
  action: string,
  requiredScope?: WebappCapabilityScope
) {
  const grant = grants.get(token);
  return grant && grant.actions.has(action) && (!requiredScope || grant.scope === requiredScope)
    ? { ok: true as const, webappId: grant.webappId, scope: grant.scope }
    : { ok: false as const, webappId: "", scope: null };
}

export const __actionTokenTestInternals = {
  clear() {
    grants.clear();
  },
  size() {
    return grants.size;
  }
};
