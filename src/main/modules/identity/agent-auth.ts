import type { App } from "electron";
import type { AgentAuthIssueResult, AgentAuthRefreshReason } from "../../../shared/contracts";
import { t } from "../../support/i18n/main-i18n";

const TOKEN_REFRESH_SKEW_MS = 60_000;
const TOKEN_FALLBACK_CACHE_TTL_MS = 5 * 60_000;

type CachedAgentToken = {
  token: string;
  expiresAtMs: number;
};

const cachedTokens = new Map<string, CachedAgentToken>();
const pendingTokenIssues = new Map<string, Promise<AgentAuthIssueResult>>();

function getAppCacheKey(app: App) {
  const parts = ["userData", "home", "appData"].map((name) => {
    try {
      return `${name}:${app.getPath(name as Parameters<App["getPath"]>[0])}`;
    } catch {
      return "";
    }
  });
  return parts.filter(Boolean).join("|") || "default";
}

function readTokenExpiresAtMs(token: string) {
  const [, payloadPart] = token.split(".");
  if (!payloadPart) {
    return Date.now() + TOKEN_FALLBACK_CACHE_TTL_MS;
  }
  try {
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as { exp?: unknown };
    const exp = Number(payload.exp);
    return Number.isFinite(exp) && exp > 0
      ? exp * 1000
      : Date.now() + TOKEN_FALLBACK_CACHE_TTL_MS;
  } catch {
    return Date.now() + TOKEN_FALLBACK_CACHE_TTL_MS;
  }
}

function createSuccessResult(token: string): AgentAuthIssueResult {
  return {
    ok: true,
    token,
    message: t("agentAuth.accessTokenIssued")
  };
}

function readReusableCachedToken(cacheKey: string) {
  const cached = cachedTokens.get(cacheKey);
  if (!cached || cached.expiresAtMs <= Date.now() + TOKEN_REFRESH_SKEW_MS) {
    cachedTokens.delete(cacheKey);
    return null;
  }
  return cached.token;
}

export type IdentityCapabilityResolver = (app: App, capabilityId: string, options?: { authSubject?: string }) => Promise<any>;

async function issueFreshAgentAccessToken(
  app: App,
  cacheKey: string,
  resolveDesktopCapability: IdentityCapabilityResolver,
  subject: string
): Promise<AgentAuthIssueResult> {
  try {
    const capability = await resolveDesktopCapability(app, "auth.accessToken", subject ? { authSubject: subject } : undefined);
    const token = capability.token || capability.text || "";
    if (subject) {
      let issuedSubject: unknown;
      try { issuedSubject = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8")).sub; }
      catch { throw new Error("Identity service did not return a scoped access token"); }
      if (issuedSubject !== subject) throw new Error("Identity service returned a different user subject");
    }
    cachedTokens.set(cacheKey, {
      token,
      expiresAtMs: readTokenExpiresAtMs(token)
    });
    return createSuccessResult(token);
  } catch (reason) {
    return {
      ok: false,
      token: "",
      message: reason instanceof Error ? reason.message : String(reason)
    };
  }
}

export async function issueAgentAccessToken(
  app: App,
  reason: AgentAuthRefreshReason,
  resolveDesktopCapability: IdentityCapabilityResolver,
  subject = ""
): Promise<AgentAuthIssueResult> {
  if (subject && !/^desktop-user:[0-9a-f]{64}$/.test(subject)) throw new Error("Invalid Desktop identity subject");
  const cacheKey = `${getAppCacheKey(app)}\0${subject}`;
  if (reason === "unauthorized") {
    cachedTokens.delete(cacheKey);
  } else {
    const cachedToken = readReusableCachedToken(cacheKey);
    if (cachedToken) {
      return createSuccessResult(cachedToken);
    }
  }

  const pending = pendingTokenIssues.get(cacheKey);
  if (pending) {
    return pending;
  }

  const nextIssue = issueFreshAgentAccessToken(app, cacheKey, resolveDesktopCapability, subject).finally(() => {
    pendingTokenIssues.delete(cacheKey);
  });
  pendingTokenIssues.set(cacheKey, nextIssue);
  return nextIssue;
}
