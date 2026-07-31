import { BRAND_ID } from "./brand";

export const DESKTOP_SSO_AVATAR_PROTOCOL = `${BRAND_ID}-sso-avatar`;

export function buildDesktopSsoAvatarUrl(version: string) {
  const normalizedVersion = version.trim().toLowerCase();
  return /^[a-f0-9]{24}$/u.test(normalizedVersion)
    ? `${DESKTOP_SSO_AVATAR_PROTOCOL}://${normalizedVersion}/avatar`
    : "";
}
