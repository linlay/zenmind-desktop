import { randomBytes } from "node:crypto";
import { WEBAPP_CAPABILITY_POLICY } from "./capability-policy";

type WebappActionGrant = {
  webappId: string;
  actions: Set<string>;
};

const grants = new Map<string, WebappActionGrant>();

export function issueWebappActionToken(webappId: string) {
  const token = randomBytes(32).toString("base64url");
  grants.set(token, {
    webappId,
    actions: new Set(WEBAPP_CAPABILITY_POLICY.backendActionToken)
  });
  return token;
}

export function revokeWebappActionToken(token: string) {
  if (token) {
    grants.delete(token);
  }
}

export function authorizeWebappActionToken(token: string, action: string) {
  const grant = grants.get(token);
  return grant && grant.actions.has(action)
    ? { ok: true as const, webappId: grant.webappId }
    : { ok: false as const, webappId: "" };
}

export const __actionTokenTestInternals = {
  clear() {
    grants.clear();
  },
  size() {
    return grants.size;
  }
};
