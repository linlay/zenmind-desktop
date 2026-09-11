import fs from "node:fs";
import path from "node:path";
import { net, type App } from "electron";
import yaml from "js-yaml";
import { requestApiKey, ProviderRegisterHttpError, type ProviderRegisterFetch } from "./provider-register-network";
import { t } from "../../support/i18n/main-i18n";
import { resolveRuntimeRoot } from "../../infrastructure/filesystem/runtime-environment";

const PROVIDER_REGISTER_FILE = "provider-register.json";
const DEFAULT_ENDPOINT = "";
const DEFAULT_PROVIDERS = ["th-deepseek", "th-minimax"] as const;

const PROVIDER_KEY_PATTERN = /^[A-Za-z0-9._-]+$/u;

type AppPathReader = Pick<App, "getPath">;

type ProviderRegisterConfig = {
  mode?: unknown;
  version?: unknown;
  enabled?: unknown;
  endpoint?: unknown;
  grant?: unknown;
  providers?: unknown;
  [key: string]: unknown;
};

type ProviderRegisterGrant = {
  type?: unknown;
  token?: unknown;
};

type ProviderYaml = {
  apiKey?: unknown;
};

export type ProviderRegisterResult =
  | { status: "skipped"; reason: "missing" | "disabled" | "unchanged" }
  | { status: "applied"; providers: string[]; updatedProviders: string[] };

export type ProviderRegisterOptions = {
  platform?: NodeJS.Platform;
  fetchImpl?: ProviderRegisterFetch;
  getDesktopDeviceId: (app: App) => string;
  preparation?: boolean;
  getAccessToken?: () => string | null;
  refreshAccessToken?: () => Promise<string>;
  onLoginRequired?: () => void;
};

export function resolveProviderRegisterPath(
  app: AppPathReader,
  platform: NodeJS.Platform = process.platform
) {
  return path.join(resolveRuntimeRoot(app, platform), PROVIDER_REGISTER_FILE);
}

function pathApiForRuntimeRoot(platform: NodeJS.Platform, runtimeRoot: string) {
  if (platform === "win32") {
    return runtimeRoot.includes("/") && !runtimeRoot.includes("\\") ? path.posix : path.win32;
  }
  return path.posix;
}

function readRegisterConfig(registerPath: string) {
  const content = fs.readFileSync(registerPath, "utf8");
  try {
    const parsed = JSON.parse(content) as ProviderRegisterConfig;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("root must be an object");
    }
    return { content, config: parsed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(t("providerRegister.invalidFormat", { file: PROVIDER_REGISTER_FILE, message }));
  }
}

export function getProviderRegisterMode(app: AppPathReader, platform: NodeJS.Platform = process.platform) {
  const file = resolveProviderRegisterPath(app, platform);
  if (!fs.existsSync(file)) return "disabled" as const;
  return normalizeMode(readRegisterConfig(file).config);
}

function normalizeMode(config: ProviderRegisterConfig): "access-token" | "grant-jwt" {
  if (config.mode === undefined) return "grant-jwt";
  if (config.mode === "access-token" || config.mode === "grant-jwt") return config.mode;
  throw new Error(t("providerRegister.modeInvalid"));
}

// Called only after managed consumers have stopped on identity loss.
export function clearAccessTokenProviderKeys(app: AppPathReader, platform: NodeJS.Platform = process.platform) {
  if (getProviderRegisterMode(app, platform) !== "access-token") return;
  const { config } = readRegisterConfig(resolveProviderRegisterPath(app, platform));
  const targets = readProviderTargets({ app, platform, providers: normalizeProviders(config.providers) });
  applyProviderApiKey({ targets: targets.map(target => ({ ...target, needsUpdate: true })), apiKey: "" });
}

function normalizeEndpoint(value: unknown) {
  const endpoint = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_ENDPOINT;
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(t("providerRegister.endpointInvalid", { file: PROVIDER_REGISTER_FILE }));
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(t("providerRegister.endpointProtocol", { file: PROVIDER_REGISTER_FILE }));
  }
  return endpoint;
}

function normalizeGrant(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(t("providerRegister.grantRequired", { file: PROVIDER_REGISTER_FILE }));
  }
  const grant = value as ProviderRegisterGrant;
  const grantType = typeof grant.type === "string" ? grant.type.trim().toLowerCase() : "jwt";
  if (grantType !== "jwt") {
    throw new Error(t("providerRegister.grantTypeUnsupported", { file: PROVIDER_REGISTER_FILE }));
  }
  const token = typeof grant.token === "string" ? grant.token.trim() : "";
  if (!token) {
    throw new Error(t("providerRegister.grantTokenRequired", { file: PROVIDER_REGISTER_FILE }));
  }
  return token;
}

function normalizeProviders(value: unknown) {
  if (value === undefined) {
    return [...DEFAULT_PROVIDERS];
  }
  if (!Array.isArray(value)) {
    throw new Error(t("providerRegister.providersMustBeArray", { file: PROVIDER_REGISTER_FILE }));
  }
  const providers: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(t("providerRegister.providersStringOnly", { file: PROVIDER_REGISTER_FILE }));
    }
    const provider = entry.trim();
    if (!provider || !PROVIDER_KEY_PATTERN.test(provider)) {
      throw new Error(t("providerRegister.providerKeyInvalid", { file: PROVIDER_REGISTER_FILE }));
    }
    if (!providers.includes(provider)) {
      providers.push(provider);
    }
  }
  if (providers.length === 0) {
    throw new Error(t("providerRegister.providersRequired", { file: PROVIDER_REGISTER_FILE }));
  }
  return providers;
}

function parseProviderYaml(content: string, providerKey: string) {
  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(t("providerRegister.providerYamlInvalid", { providerKey, message }));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(t("providerRegister.providerYamlObject", { providerKey }));
  }
  return parsed as ProviderYaml;
}

function providerNeedsApiKeyUpdate(content: string, providerKey: string) {
  const provider = parseProviderYaml(content, providerKey);
  if (provider.apiKey === undefined || provider.apiKey === null) {
    return true;
  }
  return typeof provider.apiKey === "string" && !provider.apiKey.trim();
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
  const runtimeRoot = resolveRuntimeRoot(input.app, input.platform);
  const pathApi = pathApiForRuntimeRoot(input.platform, runtimeRoot);
  return input.providers.map((providerKey) => {
    const providerPath = pathApi.join(runtimeRoot, "registries", "providers", `${providerKey}.yml`);
    if (!fs.existsSync(providerPath)) {
      throw new Error(t("providerRegister.providerFileMissing", { providerKey }));
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

function buildResetContent(config: ProviderRegisterConfig) {
  const grant: Record<string, unknown> = {};
  if (typeof config.grant === "object" && config.grant !== null && !Array.isArray(config.grant)) {
    const grantIn = config.grant as Record<string, unknown>;
    if (typeof grantIn.type === "string") {
      grant.type = grantIn.type;
    }
  }
  grant.token = "";
  const { version: _version, ...rest } = config as Record<string, unknown>;
  return `${JSON.stringify({ ...rest, enabled: false, grant }, null, 2)}\n`;
}

function safetyCleanRegister(registerPath: string, config: ProviderRegisterConfig, platform: NodeJS.Platform) {
  fs.writeFileSync(registerPath, buildResetContent(config), "utf8");
  if (platform !== "win32") {
    fs.chmodSync(registerPath, 0o600);
  }
  if (config.enabled !== true && config.mode !== "grant-jwt") {
    return;
  }
  try {
    fs.rmSync(registerPath, { force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(t("providerRegister.cleanupFailed", { message }));
  }
}

function defaultFetchImpl(): ProviderRegisterFetch {
  if (typeof net?.fetch !== "function") {
    throw new Error(t("providerRegister.fetchUnsupported"));
  }
  // Chromium resolves the native macOS/Windows system proxy; Node fetch does not.
  return (input, init) => net.fetch(input, init);
}

export async function ensureProviderRegisterApiKey(
  app: App,
  options: ProviderRegisterOptions
): Promise<ProviderRegisterResult> {
  const platform = options.platform ?? process.platform;
  const registerPath = resolveProviderRegisterPath(app, platform);
  if (!fs.existsSync(registerPath)) {
    return { status: "skipped", reason: "missing" };
  }

  const { config } = readRegisterConfig(registerPath);
  const mode = normalizeMode(config);
  const providers = normalizeProviders(config.providers);
  if (mode === "access-token") {
    // Identity service deployment must be allowed before the interactive login gate.
    if (options.preparation) return { status: "skipped", reason: "unchanged" };
    return bindAccessTokenProviders(app, options, config, providers, registerPath);
  }
  let targets: ReturnType<typeof readProviderTargets>;
  if (config.mode === undefined && config.enabled !== true) {
    try {
      targets = readProviderTargets({ app, providers, platform });
    } catch {
      return { status: "skipped", reason: "disabled" };
    }
    if (!targets.some((target) => target.needsUpdate)) {
      return { status: "skipped", reason: "disabled" };
    }
  } else {
    targets = readProviderTargets({ app, providers, platform });
  }
  if (!targets.some((target) => target.needsUpdate)) {
    if (config.enabled === true || config.mode === "grant-jwt") {
      safetyCleanRegister(registerPath, config, platform);
    }
    return { status: "skipped", reason: "unchanged" };
  }

  const endpoint = normalizeEndpoint(config.endpoint);
  const token = normalizeGrant(config.grant);
  const deviceId = options.getDesktopDeviceId(app);
  const apiKey = await requestApiKey({
    endpoint,
    token,
    deviceId,
    fetchImpl: options.fetchImpl ?? defaultFetchImpl()
  });
  const updatedProviders = applyProviderApiKey({ targets, apiKey });
  safetyCleanRegister(registerPath, config, platform);
  console.info(
    `[provider-register] applied registration key for providers=${providers.join(",")} updated=${updatedProviders.join(",") || "none"}`
  );
  return { status: "applied", providers, updatedProviders };
}

const identityEpochs = new Map<string, number>();
export function invalidateProviderRegistration(app: AppPathReader, platform: NodeJS.Platform = process.platform) {
  const file = resolveProviderRegisterPath(app, platform);
  identityEpochs.set(file, (identityEpochs.get(file) ?? 0) + 1);
}

const bindingsInFlight = new Map<string, Promise<ProviderRegisterResult>>();

async function bindAccessTokenProviders(app: App, options: ProviderRegisterOptions, config: ProviderRegisterConfig, providers: string[], registerPath: string): Promise<ProviderRegisterResult> {
  const endpoint = normalizeEndpoint(config.endpoint);
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) {
    throw new Error(t("providerRegister.secureEndpointRequired"));
  }
  let token = options.getAccessToken?.() || "";
  if (!token) {
    options.onLoginRequired?.();
    throw new Error(t("providerRegister.loginRequired"));
  }
  const pending = bindingsInFlight.get(registerPath);
  if (pending) {
    // Wait for the previous identity's request, but never consume its result.
    await pending.catch(() => undefined);
    return bindAccessTokenProviders(app, options, config, providers, registerPath);
  }
  const run = async (): Promise<ProviderRegisterResult> => {
    const platform = options.platform ?? process.platform;
    const targets = readProviderTargets({ app, providers, platform });
    const deviceId = options.getDesktopDeviceId(app);
    const epoch = identityEpochs.get(registerPath) ?? 0;
    const isCurrent = () => (identityEpochs.get(registerPath) ?? 0) === epoch && options.getAccessToken?.() === token && options.getDesktopDeviceId(app) === deviceId &&
      fs.existsSync(registerPath) && JSON.stringify(readRegisterConfig(registerPath).config) === JSON.stringify(config);
    let apiKey: string;
    try {
      apiKey = await requestApiKey({ endpoint, token, deviceId, bind: true, fetchImpl: options.fetchImpl ?? defaultFetchImpl() });
    } catch (error) {
      if (!(error instanceof ProviderRegisterHttpError) || error.status !== 401 || !options.refreshAccessToken || !isCurrent()) throw error;
      token = await options.refreshAccessToken();
      if (!token || !isCurrent()) { options.onLoginRequired?.(); throw new Error(t("providerRegister.loginRequired")); }
      apiKey = await requestApiKey({ endpoint, token, deviceId, bind: true, fetchImpl: options.fetchImpl ?? defaultFetchImpl() });
    }
    // No await between identity validation and committing the selected providers.
    if (!isCurrent()) throw new Error(t("providerRegister.identityChanged"));
    const updatedProviders = applyProviderApiKey({ targets: targets.map(target => ({ ...target, needsUpdate: true })), apiKey });
    return { status: "applied", providers, updatedProviders };
  };
  const promise = run(); bindingsInFlight.set(registerPath, promise);
  try { return await promise; } finally { if (bindingsInFlight.get(registerPath) === promise) bindingsInFlight.delete(registerPath); }
}

export const __testInternals = {
  DEFAULT_ENDPOINT,
  DEFAULT_PROVIDERS,
  PROVIDER_REGISTER_FILE,
  normalizeProviders,
  resolveProviderRegisterPath,
  buildResetContent,
  upsertProviderApiKeyContent
};
