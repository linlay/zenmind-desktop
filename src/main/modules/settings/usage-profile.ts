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
  listAgentPlatformUsageProviderCandidates,
  type AgentPlatformUsageProviderCandidate
} from "../agent-platform";
import { t } from "../../support/i18n/main-i18n";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type DesktopUsageProfileOptions = {
  fetchImpl?: FetchLike;
  now?: Date;
};

class UsageProfileFetchError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "UsageProfileFetchError";
    this.status = status;
  }
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
    cost_quota_micro: asNumber(item.cost_quota_micro)
  };
}

function normalizeRateLimitStatus(value: unknown): DesktopUsageProfileRateLimitStatus {
  const item = asRecord(value);
  return {
    window: asString(item.window),
    starts_at: asString(item.starts_at),
    resets_at: asString(item.resets_at),
    requests: asNumber(item.requests),
    request_quota: asNumber(item.request_quota),
    request_remaining: asNumber(item.request_remaining),
    tokens: asNumber(item.tokens),
    token_quota: asNumber(item.token_quota),
    token_remaining: asNumber(item.token_remaining),
    cost_micro: asNumber(item.cost_micro),
    cost_quota_micro: asNumber(item.cost_quota_micro),
    cost_remaining_micro: asNumber(item.cost_remaining_micro)
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
    cost_micro: asNumber(item.cost_micro),
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
  return {
    currency: asString(item.currency, "USD"),
    cost_micro: asNumber(item.cost_micro),
    unlimited: asBoolean(item.unlimited),
    items: Array.isArray(item.items) ? item.items.map(normalizeRateLimitStatus) : []
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
    cost_micro: asNumber(item.cost_micro),
    estimated: asBoolean(item.estimated),
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
  return {
    id: asString(item.id),
    protocol: asString(item.protocol),
    public_model: asString(item.public_model),
    input_cost_micro_per_1m_tokens: asNumber(item.input_cost_micro_per_1m_tokens),
    input_cache_hit_cost_micro_per_1m_tokens: item.input_cache_hit_cost_micro_per_1m_tokens === null
      ? null
      : asNumber(item.input_cache_hit_cost_micro_per_1m_tokens),
    output_cost_micro_per_1m_tokens: asNumber(item.output_cost_micro_per_1m_tokens),
    currency: asString(item.currency),
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
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${candidate.apiKey}`
    }
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const payload = asRecord(await response.json());
      detail = asString(payload.error) || asString(payload.message) || detail;
    } catch {
      try {
        detail = await response.text();
      } catch {
        // Keep the HTTP status text.
      }
    }
    throw new UsageProfileFetchError(response.status, detail || `HTTP ${response.status}`);
  }
  return response.json();
}

function dedupeCandidates(candidates: AgentPlatformUsageProviderCandidate[]) {
  const seen = new Set<string>();
  const deduped: AgentPlatformUsageProviderCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.baseURL}\0${candidate.apiKey}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
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

  let candidates: AgentPlatformUsageProviderCandidate[];
  try {
    candidates = dedupeCandidates(listAgentPlatformUsageProviderCandidates(app));
  } catch (error) {
    return failureResult(
      "error",
      error instanceof Error ? error.message : String(error),
      fetchedAt
    );
  }

  if (candidates.length === 0) {
    return failureResult("not-configured", t("settings.usage.errors.notConfigured"), fetchedAt);
  }

  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - 364);
  from.setUTCHours(0, 0, 0, 0);

  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      const currentKey = normalizeCurrentKey(await fetchUsageJson(fetchImpl, candidate, "/api/me"));
      const [limits, usage, balance, logs, sessions, prices] = await Promise.all([
        fetchUsageJson(fetchImpl, candidate, "/api/me/limits").then(normalizeLimits),
        fetchUsageJson(fetchImpl, candidate, "/api/me/usage", {
          bucket: "day",
          from: from.toISOString(),
          to: now.toISOString()
        }).then(normalizeUsage),
        fetchUsageJson(fetchImpl, candidate, "/api/me/balance").then(normalizeBalance),
        fetchUsageJson(fetchImpl, candidate, "/api/me/logs", { limit: "500" }).then((value) => normalizeListResult(value, normalizeLogEntry)),
        fetchUsageJson(fetchImpl, candidate, "/api/me/sessions", { include_stale: "true", limit: "500" })
          .then((value) => normalizeListResult(value, normalizeSession)),
        fetchUsageJson(fetchImpl, candidate, "/api/me/prices").then(normalizePrices)
      ]);

      return {
        ok: true,
        provider: {
          providerKey: candidate.providerKey,
          providerName: candidate.providerName,
          baseURL: candidate.baseURL,
          model: candidate.model
        },
        currentKey,
        limits,
        usage,
        balance,
        logs,
        sessions,
        prices,
        fetchedAt
      };
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof UsageProfileFetchError && (lastError.status === 401 || lastError.status === 403)) {
    return failureResult("unauthorized", t("settings.usage.errors.unauthorized"), fetchedAt);
  }

  return failureResult(
    "unavailable",
    lastError instanceof Error ? lastError.message : t("settings.usage.errors.unavailable"),
    fetchedAt
  );
}
