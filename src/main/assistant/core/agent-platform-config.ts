import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { App } from "electron";
import yaml from "js-yaml";
import type { AssistantSettingsPublic } from "../../../shared/contracts";
import { APP_BRAND } from "../../../shared/brand";
import { resolveRuntimeRoot } from "../../env-bootstrap";
import { getServiceConfigRoot } from "../../user-paths";
import { t } from "../../i18n/main-i18n";
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

const PROVIDER_API_KEY_ENV_PART = "PROVIDER_APIKEY_KEY_PART";
const PROVIDER_API_KEY_CODE_PART = `${APP_BRAND.storageNamespace}:provider`;
const DEFAULT_PROVIDER_API_KEY_ENV_PART = "0.1.0";
const AES_WRAPPED_PATTERN = /^AES\((.+)\)$/u;

type ProviderConfigLocation = {
  providerPath: string;
  modelDirs: string[];
  env: Map<string, string>;
};

export type AgentPlatformUsageProviderCandidate = {
  providerKey: string;
  providerName: string;
  baseURL: string;
  model: string;
  apiKey: string;
  sourcePath: string;
};

function readAgentPlatformEnv(app: App) {
  const envPath = path.join(getServiceConfigRoot(app, "agent-platform", "builtin"), ".env");
  const env = new Map<string, string>();
  for (const [key, value] of parseEnv(readTextIfExists(envPath))) {
    env.set(key, value);
  }
  return env;
}

function resolveRegistriesDirs(app: App, _env: Map<string, string>) {
  return [path.join(resolveRuntimeRoot(app), "registries")];
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

function resolveProviderConfigLocation(app: App, providerKey = "minimax"): ProviderConfigLocation | null {
  const env = readAgentPlatformEnv(app);
  const candidates: Array<{ providerPath: string; modelDirs: string[] }> = [];
  for (const registriesDir of resolveRegistriesDirs(app, env)) {
    candidates.push({
      providerPath: path.join(registriesDir, "providers", `${providerKey}.yml`),
      modelDirs: [path.join(registriesDir, "models")]
    });
  }

  const match = candidates.find((candidate) => fs.existsSync(candidate.providerPath));
  return match ? { ...match, env } : null;
}

function listProviderConfigFiles(registriesDir: string) {
  const providerDir = path.join(registriesDir, "providers");
  try {
    return fs.readdirSync(providerDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/iu.test(entry.name))
      .map((entry) => path.join(providerDir, entry.name))
      .sort((left, right) => left.localeCompare(right, "en-US"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function readModelId(modelDirs: string[], modelKey: string) {
  if (!modelKey) {
    return "";
  }
  const modelPath = modelDirs
    .map((modelDir) => path.join(modelDir, `${modelKey}.yml`))
    .find((candidate) => fs.existsSync(candidate));
  if (!modelPath) {
    return "";
  }
  return loadYamlFile<ModelConfig>(modelPath)?.modelId || "";
}

function usageProviderPriority(providerKey: string) {
  if (providerKey === "openai") {
    return 0;
  }
  if (providerKey === "minimax") {
    return 1;
  }
  if (/transit|hub|^th[-_]/iu.test(providerKey)) {
    return 2;
  }
  return 3;
}

export function listAgentPlatformUsageProviderCandidates(app: App): AgentPlatformUsageProviderCandidate[] {
  const env = readAgentPlatformEnv(app);
  const seenPaths = new Set<string>();
  const candidates: AgentPlatformUsageProviderCandidate[] = [];
  for (const registriesDir of resolveRegistriesDirs(app, env)) {
    const modelDirs = [path.join(registriesDir, "models")];
    for (const providerPath of listProviderConfigFiles(registriesDir)) {
      if (seenPaths.has(providerPath)) {
        continue;
      }
      seenPaths.add(providerPath);
      const provider = loadYamlFile<ProviderConfig>(providerPath);
      if (!provider?.baseUrl || !provider.apiKey) {
        continue;
      }
      const fileKey = path.basename(providerPath).replace(/\.ya?ml$/iu, "");
      const providerKey = provider.key?.trim() || fileKey;
      const defaultModel = provider.defaultModel?.trim() || "";
      const endpointPath = provider.protocols?.OPENAI?.endpointPath || "/v1/chat/completions";
      const apiKey = resolveProviderAPIKey(providerKey, provider.apiKey, env);
      if (looksLikePlaceholderProviderAPIKey(apiKey)) {
        continue;
      }
      candidates.push({
        providerKey,
        providerName: providerKey,
        baseURL: endpointToBaseURL(provider.baseUrl, endpointPath),
        model: readModelId(modelDirs, defaultModel) || defaultModel,
        apiKey,
        sourcePath: providerPath
      });
    }
  }
  return candidates.sort((left, right) => {
    const priorityDelta = usageProviderPriority(left.providerKey) - usageProviderPriority(right.providerKey);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    return left.providerKey.localeCompare(right.providerKey, "en-US");
  });
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
    bootstrapAgentKey: localSettings.bootstrapAgentKey,
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
    bootstrapAgentKey: localSettings.bootstrapAgentKey,
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
  resolveRegistriesDirs,
  resolveProviderAPIKey,
  looksLikePlaceholderProviderAPIKey,
  listAgentPlatformUsageProviderCandidates,
  loadAgentPlatformProviderSettings
};
