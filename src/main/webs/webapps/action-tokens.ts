import { randomBytes } from "node:crypto";

const DEFAULT_WEBAPP_BACKEND_ACTIONS = new Set([
  "desktop.assistant.complete",
  "desktop.assistant.translate"
]);

type WebappActionGrant = {
  webappId: string;
  actions: Set<string>;
};

const grants = new Map<string, WebappActionGrant>();

export function issueWebappActionToken(webappId: string) {
  const token = randomBytes(32).toString("base64url");
  grants.set(token, {
    webappId,
    actions: new Set(DEFAULT_WEBAPP_BACKEND_ACTIONS)
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
