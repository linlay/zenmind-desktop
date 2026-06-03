import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { App } from "electron";
import yaml from "js-yaml";
import { getDesktopDeviceId } from "./device-identity";
import { APP_BRAND } from "../shared/generated/brand";

const DESKTOP_REGISTER_FILE = "desktop-register.json";
const DEFAULT_ENDPOINT = "https://transit-hub.zenmind.cc/api/apply-apikey";
const DEFAULT_PROVIDERS = ["th-deepseek", "th-minimax"] as const;
const MAX_ERROR_BODY_LENGTH = 240;
const PROVIDER_KEY_PATTERN = /^[A-Za-z0-9._-]+$/u;

type AppPathReader = Pick<App, "getPath">;

type DesktopRegisterConfig = {
  version?: unknown;
  enabled?: unknown;
  endpoint?: unknown;
  grant?: unknown;
  providers?: unknown;
  [key: string]: unknown;
};

type DesktopRegisterGrant = {
  type?: unknown;
  token?: unknown;
};

type DesktopRegisterFetchResponse = {
  ok: boolean;
  status: number;
  statusText?: string;
  text: () => Promise<string>;
};

type DesktopRegisterFetch = (
  input: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
  }
) => Promise<DesktopRegisterFetchResponse>;

type ProviderYaml = {
  apiKey?: unknown;
};

export type DesktopRegisterResult =
  | { status: "skipped"; reason: "missing" | "disabled" }
  | { status: "applied"; providers: string[]; updatedProviders: string[] };

export type DesktopRegisterOptions = {
  platform?: NodeJS.Platform;
  fetchImpl?: DesktopRegisterFetch;
};

function pathApiForPlatform(platform: NodeJS.Platform | undefined) {
  return platform === "win32" ? path.win32 : path.posix;
}

function getHomePath(app: AppPathReader) {
  try {
    const homePath = app.getPath("home");
    if (typeof homePath === "string" && homePath.trim()) {
      return homePath;
    }
  } catch {
    // Fall back to Node's user home when Electron cannot provide one yet.
  }
  return process.env.HOME || os.homedir();
}

export function resolveDesktopRegisterPath(
  app: AppPathReader,
  platform: NodeJS.Platform = process.platform
) {
  const pathApi = pathApiForPlatform(platform);
  const homePath = getHomePath(app);
  if (platform === "win32") {
    return pathApi.resolve(pathApi.join(homePath, APP_BRAND.paths.runtimeRootDirName, DESKTOP_REGISTER_FILE));
  }
  if (platform === "darwin") {
    return pathApi.resolve(pathApi.join(homePath, APP_BRAND.paths.runtimeRootDirName, DESKTOP_REGISTER_FILE));
  }
  return pathApi.resolve(pathApi.join(homePath, APP_BRAND.paths.runtimeRootDirName, DESKTOP_REGISTER_FILE));
}

function resolveRuntimeRoot(app: AppPathReader, platform: NodeJS.Platform = process.platform) {
  const pathApi = pathApiForPlatform(platform);
  const homePath = getHomePath(app);
  if (platform === "win32") {
    return pathApi.resolve(pathApi.join(homePath, APP_BRAND.paths.runtimeRootDirName));
  }
  if (platform === "darwin") {
    return pathApi.resolve(pathApi.join(homePath, APP_BRAND.paths.runtimeRootDirName));
  }
  return pathApi.resolve(pathApi.join(homePath, APP_BRAND.paths.runtimeRootDirName));
}

function readRegisterConfig(registerPath: string) {
  const content = fs.readFileSync(registerPath, "utf8");
  try {
    const parsed = JSON.parse(content) as DesktopRegisterConfig;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("root must be an object");
    }
    return { content, config: parsed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${DESKTOP_REGISTER_FILE} 格式不正确：${message}`);
  }
}

function normalizeEndpoint(value: unknown) {
  const endpoint = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_ENDPOINT;
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`${DESKTOP_REGISTER_FILE} endpoint 不是有效 URL。`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${DESKTOP_REGISTER_FILE} endpoint 只支持 http/https。`);
  }
  return endpoint;
}

function normalizeGrant(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${DESKTOP_REGISTER_FILE} grant 不能为空。`);
  }
  const grant = value as DesktopRegisterGrant;
  const grantType = typeof grant.type === "string" ? grant.type.trim().toLowerCase() : "jwt";
  if (grantType !== "jwt") {
    throw new Error(`${DESKTOP_REGISTER_FILE} grant.type 仅支持 jwt。`);
  }
  const token = typeof grant.token === "string" ? grant.token.trim() : "";
  if (!token) {
    throw new Error(`${DESKTOP_REGISTER_FILE} grant.token 不能为空。`);
  }
  return token;
}

function normalizeProviders(value: unknown) {
  if (value === undefined) {
    return [...DEFAULT_PROVIDERS];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${DESKTOP_REGISTER_FILE} providers 必须是字符串数组。`);
  }
  const providers: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(`${DESKTOP_REGISTER_FILE} providers 只能包含字符串。`);
    }
    const provider = entry.trim();
    if (!provider || !PROVIDER_KEY_PATTERN.test(provider)) {
      throw new Error(`${DESKTOP_REGISTER_FILE} providers 包含无效 provider key。`);
    }
    if (!providers.includes(provider)) {
      providers.push(provider);
    }
  }
  if (providers.length === 0) {
    throw new Error(`${DESKTOP_REGISTER_FILE} providers 不能为空。`);
  }
  return providers;
}

function redactSensitiveText(value: string) {
  return value
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "<redacted-jwt>")
    .replace(/\b(?:dk|th|sk)_[A-Za-z0-9_-]{8,}\b/gu, "<redacted-key>");
}

function summarizeResponseBody(value: string) {
  const normalized = redactSensitiveText(value).replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= MAX_ERROR_BODY_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_ERROR_BODY_LENGTH)}...`;
}

async function requestApiKey(input: {
  endpoint: string;
  token: string;
  deviceId: string;
  fetchImpl: DesktopRegisterFetch;
}) {
  let response: DesktopRegisterFetchResponse;
  try {
    response = await input.fetchImpl(input.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ name: input.deviceId })
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`desktop-register 申请 apikey 失败：${redactSensitiveText(message)}`);
  }

  const responseText = await response.text();
  if (!response.ok) {
    const suffix = summarizeResponseBody(responseText);
    throw new Error(
      `desktop-register 申请 apikey 失败：HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}${suffix ? `：${suffix}` : ""}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error("desktop-register 申请 apikey 失败：响应不是 JSON。");
  }

  const key = typeof (parsed as { key?: unknown })?.key === "string"
    ? (parsed as { key: string }).key.trim()
    : "";
  if (!key) {
    throw new Error("desktop-register 申请 apikey 失败：响应缺少 key。");
  }
  return key;
}

function looksLikePlaceholderProviderApiKey(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return (
    /(?:your|example|demo|placeholder|replace[-_\s]*me|change[-_\s]*me|xxx)/iu.test(normalized) ||
    /^<[^>]+>$/u.test(normalized)
  );
}

function parseProviderYaml(content: string, providerKey: string) {
  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`provider ${providerKey} YAML 格式不正确：${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`provider ${providerKey} YAML 必须是对象。`);
  }
  return parsed as ProviderYaml;
}

function providerNeedsApiKeyUpdate(content: string, providerKey: string) {
  const provider = parseProviderYaml(content, providerKey);
  if (typeof provider.apiKey !== "string") {
    return true;
  }
  return looksLikePlaceholderProviderApiKey(provider.apiKey);
}

function formatYamlScalar(value: string) {
  if (/^[A-Za-z0-9._~+/=-]+$/u.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function upsertProviderApiKeyContent(content: string, apiKey: string) {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/u);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const apiKeyLine = `apiKey: ${formatYamlScalar(apiKey)}`;
  const existingIndex = lines.findIndex((line) => /^\s*apiKey\s*:/u.test(line));
  if (existingIndex >= 0) {
    const indent = /^\s*/u.exec(lines[existingIndex])?.[0] ?? "";
    lines[existingIndex] = `${indent}${apiKeyLine}`;
    return `${lines.join(newline)}${newline}`;
  }

  const baseUrlIndex = lines.findIndex((line) => /^\s*baseUrl\s*:/u.test(line));
  const keyIndex = lines.findIndex((line) => /^\s*key\s*:/u.test(line));
  const insertIndex = baseUrlIndex >= 0 ? baseUrlIndex + 1 : keyIndex >= 0 ? keyIndex + 1 : lines.length;
  lines.splice(insertIndex, 0, apiKeyLine);
  return `${lines.join(newline)}${newline}`;
}

function readProviderTargets(input: {
  app: AppPathReader;
  providers: string[];
  platform: NodeJS.Platform;
}) {
  const pathApi = pathApiForPlatform(input.platform);
  const runtimeRoot = resolveRuntimeRoot(input.app, input.platform);
  return input.providers.map((providerKey) => {
    const providerPath = pathApi.join(runtimeRoot, "registries", "providers", `${providerKey}.yml`);
    if (!fs.existsSync(providerPath)) {
      throw new Error(`desktop-register provider 文件不存在：${providerKey}`);
    }
    const content = fs.readFileSync(providerPath, "utf8");
    return {
      providerKey,
      providerPath,
      content,
      needsUpdate: providerNeedsApiKeyUpdate(content, providerKey)
    };
  });
}

function applyProviderApiKey(input: {
  targets: ReturnType<typeof readProviderTargets>;
  apiKey: string;
}) {
  const updatedProviders: string[] = [];
  for (const target of input.targets) {
    if (!target.needsUpdate) {
      continue;
    }
    fs.writeFileSync(
      target.providerPath,
      upsertProviderApiKeyContent(target.content, input.apiKey),
      "utf8"
    );
    updatedProviders.push(target.providerKey);
  }
  return updatedProviders;
}

function setRegisterEnabledFalseContent(content: string, config: DesktopRegisterConfig) {
  const replaced = content.replace(/("enabled"\s*:\s*)true\b/u, "$1false");
  if (replaced !== content) {
    try {
      const parsed = JSON.parse(replaced) as DesktopRegisterConfig;
      if (parsed?.enabled === false) {
        return replaced;
      }
    } catch {
      // Fall back to normalized JSON below.
    }
  }
  return `${JSON.stringify({ ...config, enabled: false }, null, 2)}\n`;
}

function writeRegisterDisabled(registerPath: string, content: string, config: DesktopRegisterConfig, platform: NodeJS.Platform) {
  fs.writeFileSync(registerPath, setRegisterEnabledFalseContent(content, config), "utf8");
  if (platform === "win32") {
    return;
  }
  fs.chmodSync(registerPath, 0o600);
}

function defaultFetchImpl(): DesktopRegisterFetch {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("desktop-register 申请 apikey 失败：当前运行时不支持 fetch。");
  }
  return globalThis.fetch as unknown as DesktopRegisterFetch;
}

export async function ensureDesktopRegisterApiKey(
  app: App,
  options: DesktopRegisterOptions = {}
): Promise<DesktopRegisterResult> {
  const platform = options.platform ?? process.platform;
  const registerPath = resolveDesktopRegisterPath(app, platform);
  if (!fs.existsSync(registerPath)) {
    return { status: "skipped", reason: "missing" };
  }

  const { content, config } = readRegisterConfig(registerPath);
  if (config.enabled !== true) {
    return { status: "skipped", reason: "disabled" };
  }

  const endpoint = normalizeEndpoint(config.endpoint);
  const token = normalizeGrant(config.grant);
  const providers = normalizeProviders(config.providers);
  const targets = readProviderTargets({ app, providers, platform });
  const deviceId = getDesktopDeviceId(app);
  const apiKey = await requestApiKey({
    endpoint,
    token,
    deviceId,
    fetchImpl: options.fetchImpl ?? defaultFetchImpl()
  });
  const updatedProviders = applyProviderApiKey({ targets, apiKey });
  writeRegisterDisabled(registerPath, content, config, platform);
  console.info(
    `[desktop-register] applied registration key for providers=${providers.join(",")} updated=${updatedProviders.join(",") || "none"}`
  );
  return { status: "applied", providers, updatedProviders };
}

export const __testInternals = {
  DEFAULT_ENDPOINT,
  DEFAULT_PROVIDERS,
  DESKTOP_REGISTER_FILE,
  looksLikePlaceholderProviderApiKey,
  normalizeProviders,
  resolveDesktopRegisterPath,
  setRegisterEnabledFalseContent,
  upsertProviderApiKeyContent
};
