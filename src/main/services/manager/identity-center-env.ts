import fs from "node:fs";
import path from "node:path";
import {
  resolveConfigTemplatePath,
  type ServiceLayout
} from "./layout";

const IDENTITY_CENTER_BCRYPT_KEYS = [
  "AUTH_ADMIN_PASSWORD_BCRYPT",
  "AUTH_APP_MASTER_PASSWORD_BCRYPT"
] as const;
const IDENTITY_CENTER_FALLBACK_PASSWORD_BCRYPT =
  "$2a$10$VAC1MOfQV2f6L3LqgU5PweT25AdVaRK3yvMLwXjA0uRUhtnbbQ1ue";
const BCRYPT_HASH_PATTERN = /^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$/u;

function singleQuoteEnvValue(value: string) {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function readRawEnvValue(content: string, key: string) {
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const lineKey = trimmed.slice(0, separatorIndex).trim();
    if (lineKey === key) {
      return trimmed.slice(separatorIndex + 1).trim();
    }
  }
  return "";
}

function unquoteEnvValue(rawValue: string) {
  return rawValue.trim().replace(/^['"]|['"]$/gu, "");
}

function isAbsoluteEnvPath(rawValue: string) {
  const value = unquoteEnvValue(rawValue);
  return path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function isSingleQuotedBcryptEnvValue(rawValue: string) {
  const trimmed = rawValue.trim();
  if (!trimmed.startsWith("'") || !trimmed.endsWith("'") || trimmed.length < 2) {
    return false;
  }
  return BCRYPT_HASH_PATTERN.test(trimmed.slice(1, -1));
}

function readTemplateBcryptEnvValue(layout: ServiceLayout, key: string) {
  const templatePath = resolveConfigTemplatePath(layout, ".env.example");
  if (!fs.existsSync(templatePath)) {
    return "";
  }

  try {
    const rawValue = readRawEnvValue(fs.readFileSync(templatePath, "utf8"), key);
    if (isSingleQuotedBcryptEnvValue(rawValue)) {
      return rawValue;
    }
    const unquoted = unquoteEnvValue(rawValue);
    if (BCRYPT_HASH_PATTERN.test(unquoted)) {
      return singleQuoteEnvValue(unquoted);
    }
  } catch {
    // Fall back below when bundled templates are unreadable or stale.
  }
  return "";
}

function resolveDefaultIdentityCenterBcryptEnvValue(layout: ServiceLayout, key: string) {
  return readTemplateBcryptEnvValue(layout, key) ||
    singleQuoteEnvValue(IDENTITY_CENTER_FALLBACK_PASSWORD_BCRYPT);
}

export function syncIdentityCenterDesktopEnv(
  layout: ServiceLayout,
  content: string,
  updates: Map<string, string>
) {
  for (const key of IDENTITY_CENTER_BCRYPT_KEYS) {
    const currentRawValue = readRawEnvValue(content, key);
    if (!isSingleQuotedBcryptEnvValue(currentRawValue)) {
      updates.set(key, resolveDefaultIdentityCenterBcryptEnvValue(layout, key));
    }
  }
}

export function normalizeIdentityCenterEnvContentForDesktop(content: string) {
  const nextLines = content
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return true;
      }
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) {
        return true;
      }
      const key = trimmed.slice(0, separatorIndex).trim();
      if (key !== "AUTH_DB_PATH") {
        return true;
      }
      return isAbsoluteEnvPath(trimmed.slice(separatorIndex + 1));
    });

  if (nextLines.length === 0) {
    return "";
  }
  return `${nextLines.join("\n").replace(/\n+$/u, "")}\n`;
}

export const __testInternals = {
  readRawEnvValue,
  isSingleQuotedBcryptEnvValue,
  singleQuoteEnvValue,
  normalizeIdentityCenterEnvContentForDesktop
};
