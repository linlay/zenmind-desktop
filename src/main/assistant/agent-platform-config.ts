import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { App } from "electron";
import yaml from "js-yaml";
import type { AssistantSettingsPublic } from "../../shared/contracts";
import { getServiceConfigRoot, getServicesRoot } from "../user-paths";
import type { AssistantSettingsPrivate } from "./settings-store";
import { readAssistantSettings, toPublicAssistantSettings } from "./settings-store";

type ProviderConfig = {
  key?: string;
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  protocols?: {
    OPENAI?: {
      endpointPath?: string;
    };
  };
};

type ModelConfig = {
  key?: string;
  provider?: string;
  protocol?: string;
  modelId?: string;
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

function joinURLPath(baseURL: string, endpointPath: string) {
  return `${baseURL.replace(/\/+$/u, "")}/${endpointPath.replace(/^\/+/u, "")}`;
}

function endpointToBaseURL(baseURL: string, endpointPath: string) {
  const endpoint = joinURLPath(baseURL, endpointPath || "/v1/chat/completions");
  return endpoint.replace(/\/chat\/completions$/u, "");
}

function getPathOrFallback(app: App, name: "desktop" | "home", fallback: string) {
  try {
    return app.getPath(name);
  } catch {
    return fallback;
  }
}

const PROVIDER_API_KEY_ENV_PART = "PROVIDER_APIKEY_KEY_PART";
const PROVIDER_API_KEY_CODE_PART = "zenmind-provider";
const DEFAULT_PROVIDER_API_KEY_ENV_PART = "0.1.0";
const AES_WRAPPED_PATTERN = /^AES\((.+)\)$/u;

type ProviderConfigLocation = {
  providerPath: string;
  modelDirs: string[];
  env: Map<string, string>;
};

function getPathMtimeMs(filePath: string) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function listInstalledAgentPlatformEnvPaths(app: App) {
  const serviceRoot = path.join(getServicesRoot(app), "agent-platform");
  try {
    return fs.readdirSync(serviceRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(serviceRoot, entry.name, ".env"))
      .filter((envPath) => fs.existsSync(envPath))
      .sort((left, right) => getPathMtimeMs(right) - getPathMtimeMs(left));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function readAgentPlatformEnv(app: App) {
  const desktopPath = getPathOrFallback(app, "desktop", path.join(getPathOrFallback(app, "home", process.env.HOME || ""), "Desktop"));
  const envPaths = [
    path.join(getServiceConfigRoot(app, "agent-platform", "builtin"), ".env"),
    ...listInstalledAgentPlatformEnvPaths(app),
    path.join(desktopPath, "agent-platform", ".env")
  ];
  const merged = new Map<string, string>();
  for (const envPath of [...new Set(envPaths)].reverse()) {
    for (const [key, value] of parseEnv(readTextIfExists(envPath))) {
      merged.set(key, value);
    }
  }
  return merged;
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
    throw new Error(`agent-platform provider ${providerKey} apiKey 解密失败：AES payload 格式不正确。`);
  }

  const nonceSize = 12;
  const tagSize = 16;
  if (payload.length <= nonceSize + tagSize) {
    throw new Error(`agent-platform provider ${providerKey} apiKey 解密失败：AES payload 长度不正确。`);
  }

  try {
    const key = crypto
      .createHash("sha256")
      .update(`${PROVIDER_API_KEY_CODE_PART}:${envPart.trim()}`)
      .digest();
    const nonce = payload.subarray(0, nonceSize);
    const encrypted = payload.subarray(nonceSize);
    const ciphertext = encrypted.subarray(0, encrypted.length - tagSize);
    const tag = encrypted.subarray(encrypted.length - tagSize);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8").trim();
    if (!plaintext) {
      throw new Error("empty plaintext");
    }
    return plaintext;
  } catch {
    throw new Error(`agent-platform provider ${providerKey} apiKey 解密失败：密钥片段不匹配或密文已损坏。`);
  }
}

function looksLikePlaceholderProviderAPIKey(apiKey: string) {
  const normalized = apiKey.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return /(?:your|example|demo|placeholder|replace[-_\s]*me|change[-_\s]*me|xxx)/iu.test(normalized);
}

function resolveProviderConfigLocation(app: App, providerKey = "minimax"): ProviderConfigLocation | null {
  const env = readAgentPlatformEnv(app);
  const desktopPath = getPathOrFallback(app, "desktop", path.join(getPathOrFallback(app, "home", process.env.HOME || ""), "Desktop"));
  const homePath = getPathOrFallback(app, "home", path.dirname(desktopPath));
  const legacyDesktopPath = path.join(homePath, "Desktop");
  const candidates: Array<{ providerPath: string; modelDirs: string[] }> = [];
  const envRegistriesDir = process.env.REGISTRIES_DIR || process.env.AGENT_PLATFORM_REGISTRIES_DIR;
  if (envRegistriesDir) {
    candidates.push({
      providerPath: path.join(envRegistriesDir, "providers", `${providerKey}.yml`),
      modelDirs: [path.join(envRegistriesDir, "models")]
    });
  }
  const configuredRegistriesDir = env.get("REGISTRIES_DIR");
  if (configuredRegistriesDir) {
    candidates.push({
      providerPath: path.join(configuredRegistriesDir, "providers", `${providerKey}.yml`),
      modelDirs: [path.join(configuredRegistriesDir, "models")]
    });
  }

  const runtimeRegistryDirs = [
    path.join(homePath, ".zenmind", "registries"),
    path.join(desktopPath, ".zenmind", "registries"),
    path.join(legacyDesktopPath, ".zenmind", "registries"),
    path.join(desktopPath, "zenmind-env", "registries"),
    path.join(legacyDesktopPath, "zenmind-env", "registries"),
    path.join(homePath, "zenmind", "registries")
  ];
  for (const registriesDir of [...new Set(runtimeRegistryDirs)]) {
    candidates.push({
      providerPath: path.join(registriesDir, "providers", `${providerKey}.yml`),
      modelDirs: [path.join(registriesDir, "models")]
    });
  }

  const desktopRegistriesDir = path.join(desktopPath, "zenmind-env", "registries");

  if (providerKey === "minimax") {
    candidates.push({
      providerPath: path.join(desktopPath, "minimax.yml"),
      modelDirs: [
        path.join(desktopRegistriesDir, "models"),
        path.join(desktopPath, "zenmind-env", "registries.example", "models")
      ]
    });
  }

  const match = candidates.find((candidate) => fs.existsSync(candidate.providerPath));
  return match ? { ...match, env } : null;
}

export function loadAgentPlatformMinimaxSettings(app: App): AssistantSettingsPrivate | null {
  const location = resolveProviderConfigLocation(app, "minimax");
  if (!location) {
    return null;
  }
  const localSettings = readAssistantSettings(app);

  const provider = loadYamlFile<ProviderConfig>(location.providerPath);
  if (!provider?.baseUrl || !provider.apiKey) {
    return null;
  }

  const defaultModelKey = provider.defaultModel || "minimax-m2_7-openai";
  const modelPath = location.modelDirs
    .map((modelDir) => path.join(modelDir, `${defaultModelKey}.yml`))
    .find((candidate) => fs.existsSync(candidate));
  const model = modelPath ? loadYamlFile<ModelConfig>(modelPath) : null;
  const modelId = model?.modelId || "MiniMax-M2.7";
  const endpointPath = provider.protocols?.OPENAI?.endpointPath || "/v1/chat/completions";

  return {
    baseURL: endpointToBaseURL(provider.baseUrl, endpointPath),
    model: modelId,
    apiKey: resolveProviderAPIKey(provider.key || "minimax", provider.apiKey, location.env),
    voiceCorrectionEnabled: localSettings.voiceCorrectionEnabled,
    desktopHelperAgentKey: localSettings.desktopHelperAgentKey,
    quickAssistantEnabled: localSettings.quickAssistantEnabled,
    quickAssistantAgentKey: localSettings.quickAssistantAgentKey,
    desktopCopilotPages: localSettings.desktopCopilotPages
  };
}

export function loadAgentPlatformProviderSettings(
  app: App,
  providerKey: string,
  options: {
    modelKey?: string;
    modelId?: string;
    rejectPlaceholderApiKey?: boolean;
  } = {}
): AssistantSettingsPrivate | null {
  const normalizedProviderKey = providerKey.trim();
  if (!normalizedProviderKey) {
    return null;
  }

  const location = resolveProviderConfigLocation(app, normalizedProviderKey);
  if (!location) {
    return null;
  }
  const localSettings = readAssistantSettings(app);

  const provider = loadYamlFile<ProviderConfig>(location.providerPath);
  if (!provider?.baseUrl || !provider.apiKey) {
    return null;
  }

  const modelKey = options.modelKey || provider.defaultModel || "";
  const modelPath = modelKey
    ? location.modelDirs
        .map((modelDir) => path.join(modelDir, `${modelKey}.yml`))
        .find((candidate) => fs.existsSync(candidate))
    : "";
  const model = modelPath ? loadYamlFile<ModelConfig>(modelPath) : null;
  const modelId = options.modelId || model?.modelId || provider.defaultModel || "";
  if (!modelId) {
    return null;
  }
  const endpointPath = provider.protocols?.OPENAI?.endpointPath || "/v1/chat/completions";
  const apiKey = resolveProviderAPIKey(provider.key || normalizedProviderKey, provider.apiKey, location.env);
  if (options.rejectPlaceholderApiKey && looksLikePlaceholderProviderAPIKey(apiKey)) {
    return null;
  }

  return {
    baseURL: endpointToBaseURL(provider.baseUrl, endpointPath),
    model: modelId,
    apiKey,
    voiceCorrectionEnabled: localSettings.voiceCorrectionEnabled,
    desktopHelperAgentKey: localSettings.desktopHelperAgentKey,
    quickAssistantEnabled: localSettings.quickAssistantEnabled,
    quickAssistantAgentKey: localSettings.quickAssistantAgentKey,
    desktopCopilotPages: localSettings.desktopCopilotPages
  };
}

export function loadAgentPlatformVoiceAsrSettings(app: App): AssistantSettingsPrivate | null {
  return loadAgentPlatformProviderSettings(app, "bailian", {
    modelId: "qwen3-asr-flash",
    rejectPlaceholderApiKey: true
  });
}

export function loadAgentPlatformAssistantSettings(app: App): AssistantSettingsPrivate | null {
  return loadAgentPlatformProviderSettings(app, "openai") ?? loadAgentPlatformMinimaxSettings(app);
}

function warnAgentPlatformSettingsLoadFailure(scope: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[assistant] Failed to load agent-platform ${scope} settings: ${message}`);
}

export function tryLoadAgentPlatformMinimaxSettings(app: App): AssistantSettingsPrivate | null {
  try {
    return loadAgentPlatformMinimaxSettings(app);
  } catch (error) {
    warnAgentPlatformSettingsLoadFailure("minimax", error);
    return null;
  }
}

export function tryLoadAgentPlatformVoiceAsrSettings(app: App): AssistantSettingsPrivate | null {
  try {
    return loadAgentPlatformVoiceAsrSettings(app);
  } catch (error) {
    warnAgentPlatformSettingsLoadFailure("voice-asr", error);
    return null;
  }
}

export function tryLoadAgentPlatformAssistantSettings(app: App): AssistantSettingsPrivate | null {
  try {
    return loadAgentPlatformAssistantSettings(app);
  } catch (error) {
    warnAgentPlatformSettingsLoadFailure("assistant", error);
    return null;
  }
}

export function getAgentPlatformSettingsPublic(app: App): AssistantSettingsPublic | null {
  const settings = tryLoadAgentPlatformAssistantSettings(app);
  if (!settings) {
    return null;
  }
  return toPublicAssistantSettings(settings, "agent-platform", "agent-platform");
}

export function getAgentPlatformMinimaxSettingsPublic(app: App): AssistantSettingsPublic | null {
  return getAgentPlatformSettingsPublic(app);
}

export const __testInternals = {
  endpointToBaseURL,
  parseEnv,
  readAgentPlatformEnv,
  resolveProviderConfigLocation,
  resolveProviderAPIKey,
  looksLikePlaceholderProviderAPIKey,
  loadAgentPlatformProviderSettings
};
