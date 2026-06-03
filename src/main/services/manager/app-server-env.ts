import fs from "node:fs";
import path from "node:path";
import {
  resolveConfigTemplatePath,
  type ServiceLayout
} from "./layout";

const APP_SERVER_BCRYPT_KEYS = [
  "AUTH_ADMIN_PASSWORD_BCRYPT",
  "AUTH_APP_MASTER_PASSWORD_BCRYPT"
] as const;
const APP_SERVER_FALLBACK_PASSWORD_BCRYPT =
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

function resolveDefaultAppServerBcryptEnvValue(layout: ServiceLayout, key: string) {
  return readTemplateBcryptEnvValue(layout, key) ||
    singleQuoteEnvValue(APP_SERVER_FALLBACK_PASSWORD_BCRYPT);
}

export function syncZenmindAppServerDesktopEnv(
  layout: ServiceLayout,
  content: string,
  updates: Map<string, string>
) {
  updates.set("AUTH_DB_PATH", path.join(layout.dataDir, "auth.db"));

  for (const key of APP_SERVER_BCRYPT_KEYS) {
    const currentRawValue = readRawEnvValue(content, key);
    if (!isSingleQuotedBcryptEnvValue(currentRawValue)) {
      updates.set(key, resolveDefaultAppServerBcryptEnvValue(layout, key));
    }
  }
}

export const __testInternals = {
  readRawEnvValue,
  isSingleQuotedBcryptEnvValue,
  singleQuoteEnvValue
};
