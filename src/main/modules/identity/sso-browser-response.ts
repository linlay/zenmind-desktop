import type { DesktopSsoClaimsConfig } from "./sso-model";
import type { DesktopSsoClaims } from "../../../shared/contracts";

export async function readDesktopSsoWebSessionExchangeError(response: {
  status?: number;
  statusText?: string;
  text?: () => Promise<string>;
}) {
  const status = typeof response.status === "number" && response.status > 0
    ? response.status
    : 0;
  const statusText = response.statusText?.trim() || "";
  let detail = "";
  if (typeof response.text === "function") {
    try {
      detail = (await response.text()).trim();
    } catch {
      detail = "";
    }
  }
  return [status ? String(status) : "", statusText, detail]
    .filter(Boolean)
    .join(" - ") || "unknown error";
}

export function getRecordValue(value: unknown, key: string) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

export function getRecordString(value: unknown, key: string) {
  const rawValue = getRecordValue(value, key);
  return typeof rawValue === "string" && rawValue.trim() ? rawValue.trim() : "";
}

export function getRecordIdString(value: unknown, key: string) {
  const rawValue = getRecordValue(value, key);
  if (typeof rawValue === "string" && rawValue.trim()) {
    return rawValue.trim();
  }
  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    return String(rawValue);
  }
  return "";
}

export const DESKTOP_SSO_AVATAR_CLAIM_KEYS = ["avatarUrl", "picture", "avatar_url", "avatar"] as const;

export function getRecordAvatarUrl(value: unknown) {
  for (const key of DESKTOP_SSO_AVATAR_CLAIM_KEYS) {
    const avatarUrl = getRecordString(value, key);
    if (avatarUrl) {
      return avatarUrl;
    }
  }
  return "";
}

export function createWebSessionClaims(
  user: unknown,
  exchangeUrl: string,
  claimsConfig: DesktopSsoClaimsConfig
): DesktopSsoClaims | null {
  const id = getRecordIdString(user, "id");
  if (!id) {
    return null;
  }
  const email = getRecordString(user, "email");
  const displayName = getRecordString(user, "displayName") || getRecordString(user, "name");
  const avatarUrl = getRecordAvatarUrl(user);
  return {
    sub: `${claimsConfig.webSessionSubPrefix}${id}`,
    issuer: new URL(exchangeUrl).origin,
    audience: claimsConfig.audience,
    ...(email ? { email } : {}),
    ...(displayName ? { name: displayName } : {}),
    ...(avatarUrl ? { avatarUrl } : {})
  };
}
