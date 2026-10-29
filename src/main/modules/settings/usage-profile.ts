import type { App } from "electron";
import type {
  DesktopUsageProfileAPIKey,
  DesktopUsageProfileBalance,
  DesktopUsageProfileFailureReason,
  DesktopUsageProfileLimits,
  DesktopUsageProfileListResult,
  DesktopUsageProfileLogEntry,
  DesktopUsageProfilePrice,
  DesktopUsageProfileRateLimitDefinition,
  DesktopUsageProfileRateLimitStatus,
  DesktopUsageProfileResult,
  DesktopUsageProfileSession,
  DesktopUsageProfileTrafficBucket
} from "../../../shared/contracts";
import {
  readAgentPlatformUsageProvider,
  type AgentPlatformUsageProviderCandidate
} from "../agent-platform";
import { readTransitHubSettings } from "./transit-hub-settings";
import { getDesktopSsoBusinessToken } from "../identity";
import { t } from "../../support/i18n/main-i18n";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type DesktopUsageProfileOptions = {
  fetchImpl?: FetchLike;
  now?: Date;
  platform?: NodeJS.Platform;
  getAccessToken?: (force: boolean) => Promise<string>;
  peekAccessToken?: () => string;
  /** Internal retry guard: one SSO refresh for the whole profile query. */
  tokenRefreshAttempted?: boolean;
};

class UsageProfileFetchError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "UsageProfileFetchError";
    this.status = status;
  }
}

function asMicrocredits(value: unknown): string {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) throw new Error("Invalid micro-Credits integer string.");
  return BigInt(value).toString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeRateLimitDefinition(value: unknown): DesktopUsageProfileRateLimitDefinition {
  const item = asRecord(value);
  return {
    window: asString(item.window),
    request_quota: asNumber(item.request_quota),
    token_quota: asNumber(item.token_quota),
    quota_microcredits: asMicrocredits(item.quota_microcredits)
  };
}

function normalizeRateLimitStatus(value: unknown): DesktopUsageProfileRateLimitStatus {
  const item = asRecord(value);
  return {
    window: asString(item.window),
    state: item.state === "idle" || item.state === "expired" || item.state === "active" ? item.state : undefined,
    starts_at: asString(item.starts_at),
    resets_at: asString(item.resets_at),
    requests: asNumber(item.requests),
    request_quota: asNumber(item.request_quota),
    request_remaining: asNumber(item.request_remaining),
    tokens: asNumber(item.tokens),
    token_quota: asNumber(item.token_quota),
    token_remaining: asNumber(item.token_remaining),
    charged_microcredits: asMicrocredits(item.charged_microcredits),
    quota_microcredits: asMicrocredits(item.quota_microcredits),
    remaining_microcredits: asMicrocredits(item.remaining_microcredits)
  };
}

function normalizeTrafficBucket(value: unknown): DesktopUsageProfileTrafficBucket {
  const item = asRecord(value);
  return {
    bucket: asString(item.bucket),
    requests: asNumber(item.requests),
    request_tokens: asNumber(item.request_tokens),
    response_tokens: asNumber(item.response_tokens),
    total_tokens: asNumber(item.total_tokens),
    cache_hit_tokens: asNumber(item.cache_hit_tokens),
    cache_miss_tokens: asNumber(item.cache_miss_tokens),
    cache_total_tokens: asNumber(item.cache_total_tokens),
    cache_hit_rate: item.cache_hit_rate === null ? null : asNumber(item.cache_hit_rate),
    charged_microcredits: asMicrocredits(item.charged_microcredits),
    error_requests: asNumber(item.error_requests),
    average_latency_ms: asNumber(item.average_latency_ms)
  };
}

function normalizeCurrentKey(value: unknown): DesktopUsageProfileAPIKey {
  const item = asRecord(value);
  return {
    id: asString(item.id),
    name: asString(item.name),
    description: asString(item.description),
    key_prefix: asString(item.key_prefix),
    source: asString(item.source),
    status: asString(item.status),
    expires_at: item.expires_at === null ? null : asString(item.expires_at),
    forced_expired: asBoolean(item.forced_expired),
    request_quota: asNumber(item.request_quota),
    token_quota: asNumber(item.token_quota),
    allowed_models: asStringArray(item.allowed_models),
    rate_limits: Array.isArray(item.rate_limits) ? item.rate_limits.map(normalizeRateLimitDefinition) : [],
    used_requests: asNumber(item.used_requests),
    used_tokens: asNumber(item.used_tokens),
    last_used_at: item.last_used_at === null ? null : asString(item.last_used_at),
    deleted_at: item.deleted_at === null ? null : asString(item.deleted_at),
    created_at: asString(item.created_at),
    updated_at: asString(item.updated_at)
  };
}

function normalizeLimits(value: unknown): DesktopUsageProfileLimits {
  const item = asRecord(value);
  const lifetime = asRecord(item.lifetime);
  return {
    lifetime: {
      requests: asNumber(lifetime.requests),
      request_quota: asNumber(lifetime.request_quota),
      request_remaining: asNumber(lifetime.request_remaining),
      tokens: asNumber(lifetime.tokens),
      token_quota: asNumber(lifetime.token_quota),
      token_remaining: asNumber(lifetime.token_remaining)
    },
    rate_limit_usage: Array.isArray(item.rate_limit_usage)
      ? item.rate_limit_usage.map(normalizeRateLimitStatus)
      : []
  };
}

function normalizeUsage(value: unknown) {
  const item = asRecord(value);
  return {
    summary: normalizeTrafficBucket(item.summary),
    items: Array.isArray(item.items) ? item.items.map(normalizeTrafficBucket) : []
  };
}

function normalizeBalance(value: unknown): DesktopUsageProfileBalance {
  const item = asRecord(value);
  if (item.unit !== "CREDITS" || item.microcredits_per_credit !== 1_000_000 || typeof item.credits_unlimited !== "boolean" || typeof item.unlimited !== "boolean") {
    throw new Error("Unsupported Transit Hub Credits contract.");
  }
  return {
    unit: "CREDITS",
    microcredits_per_credit: 1000000,
    quota_microcredits: asMicrocredits(item.quota_microcredits),
    used_microcredits: asMicrocredits(item.used_microcredits),
    remaining_microcredits: asMicrocredits(item.remaining_microcredits),
    credits_unlimited: item.credits_unlimited,
    unlimited: item.unlimited,
    items: Array.isArray(item.items) ? item.items.map(normalizeRateLimitStatus) : [],
    degraded_components: asStringArray(item.degraded_components)
  };
}

function normalizeLogEntry(value: unknown): DesktopUsageProfileLogEntry {
  const item = asRecord(value);
  return {
    id: asNumber(item.id),
    api_key_id: asString(item.api_key_id),
    api_key_name: asString(item.api_key_name),
    protocol: asString(item.protocol),
    public_model: asString(item.public_model),
    upstream_model: asString(item.upstream_model),
    provider: asString(item.provider),
    pool: asString(item.pool),
    account: asString(item.account),
    device_id: asString(item.device_id),
    source: asString(item.source),
    status_code: asNumber(item.status_code),
    latency_ms: asNumber(item.latency_ms),
    request_tokens: asNumber(item.request_tokens),
    response_tokens: asNumber(item.response_tokens),
    total_tokens: asNumber(item.total_tokens),
    cache_hit_tokens: asNumber(item.cache_hit_tokens),
    cache_miss_tokens: asNumber(item.cache_miss_tokens),
    cache_total_tokens: asNumber(item.cache_total_tokens),
    cache_hit_rate: item.cache_hit_rate === null ? null : asNumber(item.cache_hit_rate),
    charged_microcredits: asMicrocredits(item.charged_microcredits),
    estimated: item.billing_status === "estimated",
    billing_status: asString(item.billing_status),
    usage_source: asString(item.usage_source),
    characters: asNumber(item.characters),
    image_count: asNumber(item.image_count),
    error_type: asString(item.error_type),
    created_at: asString(item.created_at)
  };
}

function normalizeSession(value: unknown): DesktopUsageProfileSession {
  const item = asRecord(value);
  return {
    api_key_id: asString(item.api_key_id),
    api_key_name: asString(item.api_key_name),
    key_prefix: asString(item.key_prefix),
    device_id: asString(item.device_id),
    source: asString(item.source),
    first_seen_at: asString(item.first_seen_at),
    last_seen_at: asString(item.last_seen_at),
    active: asBoolean(item.active),
    last_status_code: asNumber(item.last_status_code),
    request_count: asNumber(item.request_count),
    token_count: asNumber(item.token_count)
  };
}

function normalizeListResult<T>(value: unknown, normalizeItem: (value: unknown) => T): DesktopUsageProfileListResult<T> {
  const item = asRecord(value);
  const items = Array.isArray(item.items) ? item.items.map(normalizeItem) : [];
  return {
    items,
    total: asNumber(item.total, items.length),
    limit: asNumber(item.limit, items.length),
    offset: asNumber(item.offset)
  };
}

function normalizePrice(value: unknown): DesktopUsageProfilePrice {
  const item = asRecord(value);
  const billing = asRecord(item.billing);
  if (item.unit !== "CREDITS" || !["tokens", "image", "characters", "free"].includes(asString(billing.mode))) throw new Error("Unsupported model price contract.");
  if (billing.mode === "characters") asMicrocredits(billing.microcredits_per_10k_characters);
  return {
    id: asString(item.id),
    protocol: asString(item.protocol),
    public_model: asString(item.public_model),
    input_microcredits_per_1m_tokens: asMicrocredits(item.input_microcredits_per_1m_tokens),
    input_cache_hit_microcredits_per_1m_tokens: item.input_cache_hit_microcredits_per_1m_tokens == null
      ? null
      : asMicrocredits(item.input_cache_hit_microcredits_per_1m_tokens),
    output_microcredits_per_1m_tokens: asMicrocredits(item.output_microcredits_per_1m_tokens),
    unit: asString(item.unit),
    billing: {
      mode: asString(asRecord(item.billing).mode),
      microcredits_per_10k_characters: asRecord(item.billing).microcredits_per_10k_characters == null ? undefined : asMicrocredits(asRecord(item.billing).microcredits_per_10k_characters),
      image_prices: Array.isArray(asRecord(item.billing).image_prices) ? (asRecord(item.billing).image_prices as unknown[]).map((value) => {
        const image = asRecord(value);
        return { size: asString(image.size), quality: asString(image.quality), charged_microcredits: asMicrocredits(image.charged_microcredits) };
      }) : undefined
    },
    created_at: asString(item.created_at),
    updated_at: asString(item.updated_at)
  };
}

function normalizePrices(value: unknown) {
  const item = asRecord(value);
  return {
    items: Array.isArray(item.items) ? item.items.map(normalizePrice) : []
  };
}

function usageApiURL(baseURL: string, pathname: string, query?: Record<string, string>) {
  const url = new URL(pathname, baseURL);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }
  return url;
}

async function fetchUsageJson(fetchImpl: FetchLike, candidate: AgentPlatformUsageProviderCandidate, pathname: string, query?: Record<string, string>) {
  const response = await fetchImpl(usageApiURL(candidate.baseURL, pathname, query), {
    redirect: "error",
    credentials: "omit",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${candidate.apiKey}`
    }
  });
  if (!response.ok) {
    throw new UsageProfileFetchError(response.status, `HTTP ${response.status}`);
  }
  return response.json();
}

function failureResult(reason: DesktopUsageProfileFailureReason, message: string, fetchedAt: string): DesktopUsageProfileResult {
  return {
    ok: false,
    reason,
    message,
    fetchedAt
  };
}

export async function getDesktopUsageProfile(
  app: App,
  options: DesktopUsageProfileOptions = {}
): Promise<DesktopUsageProfileResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  const now = options.now ?? new Date();
  const fetchedAt = now.toISOString();
  if (!fetchImpl) {
    return failureResult("error", t("settings.usage.errors.fetchUnavailable"), fetchedAt);
  }

  let configurationReady = false;
  try {
    const settings = readTransitHubSettings(app, options.platform);
    if (!settings?.enabled) return failureResult("not-configured", t("settings.usage.errors.notConfigured"), fetchedAt);
    const getToken = options.getAccessToken ?? (async () => getDesktopSsoBusinessToken() || "");
    const peekToken = options.peekAccessToken ?? (() => getDesktopSsoBusinessToken() || "");
    const candidate = settings.auth.mode === "apikey"
      ? readAgentPlatformUsageProvider(app, settings.auth.providerKey, options.platform)
      : { providerKey: "", providerName: "Transit Hub", baseURL: settings.baseUrl, model: "", sourcePath: "", apiKey: "" };
    if (settings.auth.mode === "apikey" && new URL(candidate.baseURL).origin !== new URL(settings.baseUrl).origin) {
      throw new Error("Transit Hub and API key provider origins do not match.");
    }
    configurationReady = true;
    candidate.baseURL = settings.baseUrl;
    if (settings.auth.mode === "access-token") candidate.apiKey = await getToken(false);
    if (!candidate.apiKey) return failureResult("unauthorized", t("settings.usage.errors.unauthorized"), fetchedAt);
    async function refreshAndRetry(): Promise<DesktopUsageProfileResult> {
      if (options.tokenRefreshAttempted || peekToken() !== candidate.apiKey) {
        return failureResult("unauthorized", t("settings.usage.errors.unauthorized"), fetchedAt);
      }
      const refreshed = await getToken(true);
      if (!refreshed) return failureResult("unauthorized", t("settings.usage.errors.unauthorized"), fetchedAt);
      return getDesktopUsageProfile(app, { ...options, tokenRefreshAttempted: true });
    }
    let currentKey;
    try {
      currentKey = normalizeCurrentKey(await fetchUsageJson(fetchImpl, candidate, "/api/me"));
    } catch (error) {
      if (settings.auth.mode === "access-token" && error instanceof UsageProfileFetchError && error.status === 401) return await refreshAndRetry();
      throw error;
    }
    const from = new Date(now);
    from.setUTCDate(from.getUTCDate() - 364);
    from.setUTCHours(0, 0, 0, 0);
    const unavailableSections: Array<"limits" | "usage" | "balance" | "logs" | "sessions" | "prices"> = [];
    let unauthorizedSection = false;
    async function section<T>(name: typeof unavailableSections[number], read: () => Promise<T>): Promise<T | null> {
      try { return await read(); } catch (error) {
        if (error instanceof UsageProfileFetchError && error.status === 401) unauthorizedSection = true;
        unavailableSections.push(name);
        return null;
      }
    }
    const [limits, usage, balance, logs, sessions, prices] = await Promise.all([
      section("limits", () => fetchUsageJson(fetchImpl, candidate, "/api/me/limits").then(normalizeLimits)),
      section("usage", () => fetchUsageJson(fetchImpl, candidate, "/api/me/usage", { bucket: "day", from: from.toISOString(), to: now.toISOString() }).then(normalizeUsage)),
      section("balance", () => fetchUsageJson(fetchImpl, candidate, "/api/me/balance").then(normalizeBalance)),
      section("logs", () => fetchUsageJson(fetchImpl, candidate, "/api/me/logs", { limit: "500" }).then((v) => normalizeListResult(v, normalizeLogEntry))),
      section("sessions", () => fetchUsageJson(fetchImpl, candidate, "/api/me/sessions", { include_stale: "true", limit: "500" }).then((v) => normalizeListResult(v, normalizeSession))),
      section("prices", () => fetchUsageJson(fetchImpl, candidate, "/api/me/prices").then(normalizePrices))
    ]);
    if (settings.auth.mode === "access-token" && unauthorizedSection && !options.tokenRefreshAttempted) return await refreshAndRetry();
    if (settings.auth.mode === "access-token" && peekToken() !== candidate.apiKey) {
      return failureResult("unauthorized", t("settings.usage.errors.unauthorized"), fetchedAt);
    }
    // Reimporting configuration while a query is running invalidates its results too.
    if (JSON.stringify(readTransitHubSettings(app, options.platform)) !== JSON.stringify(settings)) {
      return failureResult("unavailable", t("settings.usage.errors.unavailable"), fetchedAt);
    }
    return {
      ok: true,
      provider: { providerKey: candidate.providerKey, providerName: candidate.providerName, baseURL: candidate.baseURL, model: candidate.model, authMode: settings.auth.mode },
      currentKey, limits, usage, balance, logs, sessions, prices, unavailableSections, fetchedAt
    };
  } catch (error) {
    if (!configurationReady) return failureResult("error", t("settings.usage.errors.configuration"), fetchedAt);
    // Remote errors must not echo credentials or response bodies into IPC/logs.
    return failureResult(error instanceof UsageProfileFetchError && [401, 403].includes(error.status) ? "unauthorized" : "unavailable",
      t(error instanceof UsageProfileFetchError && [401, 403].includes(error.status) ? "settings.usage.errors.unauthorized" : "settings.usage.errors.unavailable"), fetchedAt);
  }
}
