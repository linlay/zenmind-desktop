import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { App } from "electron";
import yaml from "js-yaml";
import { APP_BRAND } from "../../../shared/brand";
import { resolveRuntimeRoot } from "../../infrastructure/filesystem/runtime-environment";
import { getServiceConfigRoot } from "../../infrastructure/filesystem/user-paths";
import { t } from "../../support/i18n/main-i18n";

type ProviderConfig = {
  key?: string;
  baseUrl?: string;
  apiKey?: string;
  useAccessToken?: boolean;
  defaultModel?: string;
  protocols?: {
    OPENAI?: {
      endpointPath?: string;
    };
  };
};

function readTextIfExists(filePath: string) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function parseEnv(content: string) {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    values.set(key, rawValue.replace(/^["']|["']$/gu, ""));
  }
  return values;
}

function loadYamlFile<T>(filePath: string): T | null {
  const content = readTextIfExists(filePath);
  if (!content) {
    return null;
  }
  return yaml.load(content) as T;
}

const PROVIDER_API_KEY_ENV_PART = "PROVIDER_APIKEY_KEY_PART";
const PROVIDER_API_KEY_CODE_PART = `${APP_BRAND.storageNamespace}:provider`;
const DEFAULT_PROVIDER_API_KEY_ENV_PART = "0.1.0";
const AES_WRAPPED_PATTERN = /^AES\((.+)\)$/u;

export type AgentPlatformUsageProviderCandidate = {
  providerKey: string;
  providerName: string;
  baseURL: string;
  model: string;
  apiKey: string;
  sourcePath: string;
};

function readAgentPlatformEnv(app: App, platform: NodeJS.Platform = process.platform) {
  const envPath = path.join(getServiceConfigRoot(app, "agent-platform", "builtin", platform), ".env");
  const env = new Map<string, string>();
  for (const [key, value] of parseEnv(readTextIfExists(envPath))) {
    env.set(key, value);
  }
  return env;
}

function resolveProviderAPIKey(providerKey: string, raw: string, env: Map<string, string>) {
  const trimmed = raw.trim();
  const match = AES_WRAPPED_PATTERN.exec(trimmed);
  if (!match) {
    return trimmed;
  }

  const envPart = process.env[PROVIDER_API_KEY_ENV_PART]?.trim() ||
    env.get(PROVIDER_API_KEY_ENV_PART)?.trim() ||
    DEFAULT_PROVIDER_API_KEY_ENV_PART;

  let payload: Buffer;
  try {
    payload = Buffer.from(match[1], "base64url");
  } catch {
    throw new Error(t("agentPlatform.providerApiKeyPayloadInvalid", { providerKey }));
  }

  const nonceSize = 12;
  const tagSize = 16;
  if (payload.length <= nonceSize + tagSize) {
    throw new Error(t("agentPlatform.providerApiKeyPayloadLengthInvalid", { providerKey }));
  }

  const nonce = payload.subarray(0, nonceSize);
  const encrypted = payload.subarray(nonceSize);
  const ciphertext = encrypted.subarray(0, encrypted.length - tagSize);
  const tag = encrypted.subarray(encrypted.length - tagSize);

  try {
    const key = crypto
      .createHash("sha256")
      .update(`${PROVIDER_API_KEY_CODE_PART}:${envPart.trim()}`)
      .digest();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8").trim();
    if (!plaintext) {
      throw new Error("empty plaintext");
    }
    return plaintext;
  } catch {
    throw new Error(t("agentPlatform.providerApiKeyDecryptFailed", { providerKey }));
  }
}

function looksLikePlaceholderProviderAPIKey(apiKey: string) {
  const normalized = apiKey.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return /(?:your|example|demo|placeholder|replace[-_\s]*me|change[-_\s]*me|xxx)/iu.test(normalized);
}

export function readAgentPlatformUsageProvider(app: App, providerKey: string, platform: NodeJS.Platform = process.platform): AgentPlatformUsageProviderCandidate {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(providerKey)) throw new Error("Invalid Transit Hub providerKey.");
  const providerDir = path.join(resolveRuntimeRoot(app, platform), "registries", "providers");
  const paths = ["yml", "yaml"].map((ext) => path.join(providerDir, `${providerKey}.${ext}`)).filter((file) => fs.existsSync(file));
  if (paths.length !== 1) throw new Error("Transit Hub provider is missing or ambiguous.");
  const provider = loadYamlFile<ProviderConfig>(paths[0]);
  if (!provider?.baseUrl || !provider.apiKey || provider.useAccessToken || (provider.key && provider.key !== providerKey)) {
    throw new Error("Transit Hub provider must supply an API key and must not use access-token authentication.");
  }
  const apiKey = resolveProviderAPIKey(providerKey, provider.apiKey, readAgentPlatformEnv(app, platform));
  if (looksLikePlaceholderProviderAPIKey(apiKey)) throw new Error("Transit Hub provider API key is not configured.");
  return { providerKey, providerName: providerKey, baseURL: provider.baseUrl, model: provider.defaultModel || "", apiKey, sourcePath: paths[0] };
}

export const __testInternals = {
  parseEnv,
  readAgentPlatformEnv,
  resolveProviderAPIKey,
  looksLikePlaceholderProviderAPIKey,
  readAgentPlatformUsageProvider
};
