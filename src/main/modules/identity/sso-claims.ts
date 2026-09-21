import type { DesktopSsoClaims } from "../../../shared/contracts";
import { t } from "../../support/i18n/main-i18n";
import type { KeyObject } from "node:crypto";
import { createPublicKey } from "node:crypto";
import type { OidcConfig } from "./sso-model";
import { DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG } from "./sso-defaults";

export function decodeJsonPart(part: string) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

export function normalizeStringClaim(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function normalizeAudience(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.find((item): item is string => typeof item === "string") ?? "";
  }
  return "";
}

export const DESKTOP_SSO_AVATAR_CLAIM_KEYS = ["avatarUrl", "picture", "avatar_url", "avatar"] as const;

export function normalizeDesktopSsoAvatarUrlClaim(payload: Record<string, unknown>) {
  for (const key of DESKTOP_SSO_AVATAR_CLAIM_KEYS) {
    const avatarUrl = normalizeStringClaim(payload[key]);
    if (avatarUrl) {
      return avatarUrl;
    }
  }
  return "";
}

export function includesAudience(value: unknown, expected: string) {
  if (typeof value === "string") {
    return value === expected;
  }
  return Array.isArray(value) && value.includes(expected);
}

export function createClaims(payload: Record<string, unknown>): DesktopSsoClaims {
  const sub = normalizeStringClaim(payload.sub);
  if (!sub) {
    throw new Error(t("sso.token.idTokenMissingSub"));
  }
  const claims: DesktopSsoClaims = {
    sub,
    issuer: normalizeStringClaim(payload.iss),
    audience: normalizeAudience(payload.aud)
  };
  const name = normalizeStringClaim(payload.name);
  const email = normalizeStringClaim(payload.email);
  const avatarUrl = normalizeDesktopSsoAvatarUrlClaim(payload);
  if (name) {
    claims.name = name;
  }
  if (email) {
    claims.email = email;
  }
  if (avatarUrl) {
    claims.avatarUrl = avatarUrl;
  }
  return claims;
}

export function keyObjectFromJwk(jwk: Record<string, unknown>): KeyObject {
  return createPublicKey({ key: jwk, format: "jwk" });
}

export function getJwtPayload(token: string) {
  const [, payloadPart] = token.split(".");
  if (!payloadPart) return {};
  try {
    return decodeJsonPart(payloadPart);
  } catch {
    return {};
  }
}

export function createDesktopTicketPlaceholderClaims(config: OidcConfig): DesktopSsoClaims {
  const claimsConfig = config.claims || DEFAULT_DESKTOP_SSO_CLAIMS_CONFIG;
  return {
    sub: claimsConfig.ticketPlaceholderSub,
    issuer: config.webSessionExchange ? new URL(config.webSessionExchange.url).origin : config.serverAuthorizeUrl || "desktop-sso-server",
    audience: claimsConfig.audience
  };
}

export function isDesktopSsoClaimsValue(value: unknown): value is DesktopSsoClaims {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.sub === "string" &&
    typeof record.issuer === "string" &&
    typeof record.audience === "string";
}
