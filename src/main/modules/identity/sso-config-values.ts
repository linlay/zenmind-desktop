import { t } from "../../support/i18n/main-i18n";
import type { OidcConfig } from "./sso-model";

export function getRecordString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function getRecordObject(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function getRecordStringArray(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }
  if (!Array.isArray(value)) {
    throw new Error(t("sso.config.stringOrArray", { key }));
  }
  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(t("sso.config.stringOnly", { key }));
    }
    const normalizedItem = item.trim();
    if (normalizedItem) {
      values.push(normalizedItem);
    }
  }
  return values;
}

export function isConfigEnabled(record: Record<string, unknown>) {
  const value = record.enabled;
  if (value === true) {
    return true;
  }
  if (typeof value === "string") {
    return /^(?:true|1|on|yes)$/iu.test(value.trim());
  }
  return false;
}

export function getRecordBoolean(record: Record<string, unknown>, key: string, defaultValue: boolean) {
  const value = record[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (/^(?:true|1|on|yes)$/iu.test(value.trim())) {
      return true;
    }
    if (/^(?:false|0|off|no)$/iu.test(value.trim())) {
      return false;
    }
  }
  return defaultValue;
}

export function getRecordOptionalBoolean(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (/^(?:true|1|on|yes)$/iu.test(value.trim())) {
      return true;
    }
    if (/^(?:false|0|off|no)$/iu.test(value.trim())) {
      return false;
    }
  }
  return undefined;
}

export function normalizeProviderName(value: string | undefined) {
  return (value || "").trim().toLowerCase();
}

export function normalizeAuthMode(value: string) {
  const normalizedValue = value.trim().toLowerCase();
  return normalizedValue === "server" ? "server" : "oidc";
}

export function normalizeBrowserMode(value: string) {
  const normalizedValue = value.trim().toLowerCase();
  if (normalizedValue === "system" || normalizedValue === "external") {
    return "system";
  }
  if (normalizedValue === "embedded" || normalizedValue === "internal" || normalizedValue === "embeded") {
    return "embedded";
  }
  return undefined;
}

export function isServerBrokerAuthMode(config: OidcConfig) {
  return config.authMode === "server";
}

export function getUrlHostname(value: string | undefined) {
  if (!value) {
    return "";
  }
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isGoogleAccountsUrl(value: string | undefined) {
  return getUrlHostname(value) === "accounts.google.com";
}

export function isGoogleTokenUrl(value: string | undefined) {
  return getUrlHostname(value) === "oauth2.googleapis.com";
}

export function looksLikeGoogleOidcConfig(input: {
  issuer?: string;
  authorizeUrl?: string;
  loginUrl?: string;
  tokenUrl?: string;
  wellKnownUrl?: string;
}) {
  return isGoogleAccountsUrl(input.issuer) ||
    isGoogleAccountsUrl(input.authorizeUrl) ||
    isGoogleAccountsUrl(input.loginUrl) ||
    isGoogleAccountsUrl(input.wellKnownUrl) ||
    isGoogleTokenUrl(input.tokenUrl);
}

export function recordLooksLikeGoogleOidcConfig(record: Record<string, unknown>) {
  return looksLikeGoogleOidcConfig({
    issuer: getRecordString(record, "issuer"),
    authorizeUrl: getRecordString(record, "authorizeUrl"),
    loginUrl: getRecordString(record, "loginUrl"),
    tokenUrl: getRecordString(record, "tokenUrl"),
    wellKnownUrl: getRecordString(record, "wellKnownUrl")
  });
}

export function isGoogleOidcConfig(config: OidcConfig) {
  return normalizeProviderName(config.provider) === "google" || looksLikeGoogleOidcConfig(config);
}

export function shouldUsePkce(config: OidcConfig) {
  return config.usePkce === true || isGoogleOidcConfig(config);
}

export function shouldUsePkceByDefault(config: OidcConfig) {
  return isGoogleOidcConfig(config) || !config.clientSecret?.trim();
}

export function isPublicPkceOidcConfig(config: OidcConfig) {
  return shouldUsePkce(config) && !config.clientSecret?.trim();
}

export function shouldUseSystemBrowser(config: OidcConfig) {
  if (config.browserMode === "system") {
    return true;
  }
  if (config.browserMode === "embedded") {
    return false;
  }
  return isServerBrokerAuthMode(config) || isGoogleOidcConfig(config);
}
