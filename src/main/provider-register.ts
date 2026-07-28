import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import yaml from "js-yaml";
import { getDesktopDeviceId } from "./device-identity";
import { t } from "./i18n/main-i18n";
import { resolveRuntimeRoot } from "./env-bootstrap";

const PROVIDER_REGISTER_FILE = "provider-register.json";
const DEFAULT_ENDPOINT = "";
const DEFAULT_PROVIDERS = ["th-deepseek", "th-minimax"] as const;
const MAX_ERROR_BODY_LENGTH = 240;
const PROVIDER_KEY_PATTERN = /^[A-Za-z0-9._-]+$/u;
const SQLITE_BUSY_MAX_ATTEMPTS = 6;
const SQLITE_BUSY_RETRY_BASE_DELAY_MS = 250;
const SQLITE_BUSY_RETRY_MAX_DELAY_MS = 2_000;
const SQLITE_BUSY_BACKGROUND_RETRY_BASE_DELAY_MS = 15_000;
const SQLITE_BUSY_BACKGROUND_RETRY_MAX_DELAY_MS = 5 * 60_000;

type AppPathReader = Pick<App, "getPath">;

type ProviderRegisterConfig = {
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

type ProviderRegisterFetchResponse = {
  ok: boolean;
  status: number;
  statusText?: string;
  text: () => Promise<string>;
};

type ProviderRegisterFetch = (
  input: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
  }
) => Promise<ProviderRegisterFetchResponse>;

type ProviderRegisterSleep = (delayMs: number) => Promise<void>;

type ProviderYaml = {
  apiKey?: unknown;
};

export type ProviderRegisterResult =
  | { status: "skipped"; reason: "missing" | "disabled" | "unchanged" }
  | { status: "deferred"; reason: "sqlite-busy" }
  | { status: "applied"; providers: string[]; updatedProviders: string[] };

export type ProviderRegisterOptions = {
  platform?: NodeJS.Platform;
  fetchImpl?: ProviderRegisterFetch;
  sleepImpl?: ProviderRegisterSleep;
  deviceId?: string;
  deferSqliteBusy?: boolean;
  backgroundRetryBaseDelayMs?: number;
};

const inFlightProviderRegistrations = new Map<string, Promise<ProviderRegisterResult>>();
const backgroundProviderRegistrationTimers = new Map<string, ReturnType<typeof setTimeout>>();
const backgroundProviderRegistrationAttempts = new Map<string, number>();

class ProviderRegisterSqliteBusyError extends Error {
  readonly code = "SQLITE_BUSY";

  constructor(message: string) {
    super(message);
    this.name = "ProviderRegisterSqliteBusyError";
  }
}

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

function isTransientSqliteBusyResponse(status: number, responseText: string) {
  return (
    status >= 500 &&
    status < 600 &&
    /(?:\bSQLITE_BUSY\b|database (?:table )?is locked)/iu.test(responseText)
  );
}

function providerRegisterRetryDelayMs(attempt: number) {
  return Math.min(
    SQLITE_BUSY_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1)),
    SQLITE_BUSY_RETRY_MAX_DELAY_MS
  );
}

function providerRegisterBackgroundRetryDelayMs(
  attempt: number,
  baseDelayMs = SQLITE_BUSY_BACKGROUND_RETRY_BASE_DELAY_MS
) {
  return Math.min(
    Math.max(0, baseDelayMs) * (2 ** Math.max(0, attempt - 1)),
    SQLITE_BUSY_BACKGROUND_RETRY_MAX_DELAY_MS
  );
}

function isProviderRegisterSqliteBusyError(
  error: unknown
): error is ProviderRegisterSqliteBusyError {
  return error instanceof ProviderRegisterSqliteBusyError ||
    (
      error instanceof Error &&
      (error as Error & { code?: unknown }).code === "SQLITE_BUSY"
    );
}

function defaultSleepImpl(delayMs: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function requestApiKey(input: {
  endpoint: string;
  token: string;
  deviceId: string;
  fetchImpl: ProviderRegisterFetch;
  sleepImpl: ProviderRegisterSleep;
}) {
  for (let attempt = 1; attempt <= SQLITE_BUSY_MAX_ATTEMPTS; attempt += 1) {
    let response: ProviderRegisterFetchResponse;
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
      throw new Error(t("providerRegister.requestFailed", { message: redactSensitiveText(message) }));
    }

    const responseText = await response.text();
    if (!response.ok) {
      const sqliteBusy = isTransientSqliteBusyResponse(response.status, responseText);
      if (
        attempt < SQLITE_BUSY_MAX_ATTEMPTS &&
        sqliteBusy
      ) {
        const delayMs = providerRegisterRetryDelayMs(attempt);
        console.warn(
          `[provider-register] Transit Hub database busy; retrying attempt=${attempt + 1}/${SQLITE_BUSY_MAX_ATTEMPTS} delayMs=${delayMs}`
        );
        await input.sleepImpl(delayMs);
        continue;
      }
      const suffix = summarizeResponseBody(responseText);
      const message = t("providerRegister.httpFailed", {
        status: response.status,
        statusText: response.statusText ? ` ${response.statusText}` : "",
        suffix: suffix ? `: ${suffix}` : ""
      });
      if (sqliteBusy) {
        throw new ProviderRegisterSqliteBusyError(message);
      }
      throw new Error(message);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      throw new Error(t("providerRegister.responseNotJson"));
    }

    const key = typeof (parsed as { key?: unknown })?.key === "string"
      ? (parsed as { key: string }).key.trim()
      : "";
    if (!key) {
      throw new Error(t("providerRegister.responseMissingKey"));
    }
    return key;
  }

  throw new Error(t("providerRegister.requestFailed", { message: "retry attempts exhausted" }));
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
  if (config.enabled !== true) {
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
  if (typeof globalThis.fetch !== "function") {
    throw new Error(t("providerRegister.fetchUnsupported"));
  }
  return globalThis.fetch as unknown as ProviderRegisterFetch;
}

async function ensureProviderRegisterApiKeyInternal(
  app: App,
  options: ProviderRegisterOptions,
  registerPath: string
): Promise<ProviderRegisterResult> {
  const platform = options.platform ?? process.platform;
  if (!fs.existsSync(registerPath)) {
    return { status: "skipped", reason: "missing" };
  }

  const { config } = readRegisterConfig(registerPath);
  const providers = normalizeProviders(config.providers);
  let targets: ReturnType<typeof readProviderTargets>;
  if (config.enabled !== true) {
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
    if (config.enabled === true) {
      safetyCleanRegister(registerPath, config, platform);
    }
    return { status: "skipped", reason: "unchanged" };
  }

  const endpoint = normalizeEndpoint(config.endpoint);
  const token = normalizeGrant(config.grant);
  const deviceId = options.deviceId ?? getDesktopDeviceId(app);
  const apiKey = await requestApiKey({
    endpoint,
    token,
    deviceId,
    fetchImpl: options.fetchImpl ?? defaultFetchImpl(),
    sleepImpl: options.sleepImpl ?? defaultSleepImpl
  });
  const updatedProviders = applyProviderApiKey({ targets, apiKey });
  safetyCleanRegister(registerPath, config, platform);
  console.info(
    `[provider-register] applied registration key for providers=${providers.join(",")} updated=${updatedProviders.join(",") || "none"}`
  );
  return { status: "applied", providers, updatedProviders };
}

function scheduleProviderRegisterBackgroundRetry(
  app: App,
  options: ProviderRegisterOptions,
  registerPath: string
) {
  if (backgroundProviderRegistrationTimers.has(registerPath)) {
    return;
  }

  const attempt = (backgroundProviderRegistrationAttempts.get(registerPath) ?? 0) + 1;
  backgroundProviderRegistrationAttempts.set(registerPath, attempt);
  const delayMs = providerRegisterBackgroundRetryDelayMs(
    attempt,
    options.backgroundRetryBaseDelayMs
  );
  console.warn(
    `[provider-register] Transit Hub database remains busy; startup will continue and registration will retry in ${delayMs}ms`
  );

  const timer = setTimeout(() => {
    backgroundProviderRegistrationTimers.delete(registerPath);
    void ensureProviderRegisterApiKey(app, {
      ...options,
      deferSqliteBusy: false
    })
      .then((result) => {
        backgroundProviderRegistrationAttempts.delete(registerPath);
        if (result.status === "applied") {
          console.info("[provider-register] background registration completed");
        }
      })
      .catch((error) => {
        if (
          isProviderRegisterSqliteBusyError(error) &&
          fs.existsSync(registerPath)
        ) {
          scheduleProviderRegisterBackgroundRetry(app, options, registerPath);
          return;
        }
        backgroundProviderRegistrationAttempts.delete(registerPath);
        console.error(
          "[provider-register] background registration stopped",
          error instanceof Error ? error.message : String(error)
        );
      });
  }, delayMs);
  timer.unref?.();
  backgroundProviderRegistrationTimers.set(registerPath, timer);
}

function clearProviderRegisterBackgroundRetries() {
  for (const timer of backgroundProviderRegistrationTimers.values()) {
    clearTimeout(timer);
  }
  backgroundProviderRegistrationTimers.clear();
  backgroundProviderRegistrationAttempts.clear();
}

export function ensureProviderRegisterApiKey(
  app: App,
  options: ProviderRegisterOptions = {}
): Promise<ProviderRegisterResult> {
  const platform = options.platform ?? process.platform;
  const registerPath = resolveProviderRegisterPath(app, platform);
  const existing = inFlightProviderRegistrations.get(registerPath);
  if (existing) {
    if (!options.deferSqliteBusy) {
      return existing;
    }
    return existing.catch((error) => {
      if (!isProviderRegisterSqliteBusyError(error)) {
        throw error;
      }
      scheduleProviderRegisterBackgroundRetry(app, options, registerPath);
      return { status: "deferred", reason: "sqlite-busy" };
    });
  }

  const task = ensureProviderRegisterApiKeyInternal(app, options, registerPath);
  const trackedTask = task.finally(() => {
    if (inFlightProviderRegistrations.get(registerPath) === trackedTask) {
      inFlightProviderRegistrations.delete(registerPath);
    }
  });
  inFlightProviderRegistrations.set(registerPath, trackedTask);
  if (!options.deferSqliteBusy) {
    return trackedTask;
  }
  return trackedTask.catch((error) => {
    if (!isProviderRegisterSqliteBusyError(error)) {
      throw error;
    }
    scheduleProviderRegisterBackgroundRetry(app, options, registerPath);
    return { status: "deferred", reason: "sqlite-busy" };
  });
}

export const __testInternals = {
  DEFAULT_ENDPOINT,
  DEFAULT_PROVIDERS,
  PROVIDER_REGISTER_FILE,
  SQLITE_BUSY_MAX_ATTEMPTS,
  normalizeProviders,
  resolveProviderRegisterPath,
  buildResetContent,
  isTransientSqliteBusyResponse,
  isProviderRegisterSqliteBusyError,
  providerRegisterBackgroundRetryDelayMs,
  providerRegisterRetryDelayMs,
  clearProviderRegisterBackgroundRetries,
  requestApiKey,
  upsertProviderApiKeyContent
};
