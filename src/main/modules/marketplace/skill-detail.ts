import type { App } from "electron";
import type { MarketSkillContentResult } from "../../../shared/contracts/market-skill-detail";
import { getMarketApiBaseUrl, readResponseBytesWithLimit, requestPublicMarketJson, resolveMarketFetchImpl, type MarketplaceOptions } from "./common";

const MAX_SKILL_CONTENT_BYTES = 256 * 1024;
const SKILL_CONTENT_TIMEOUT_MS = 15_000;

/** Public metadata reads intentionally never enter Market's authenticated request path. */
export async function readMarketSkillContent(
  app: App,
  id: unknown,
  options: MarketplaceOptions = {}
): Promise<MarketSkillContentResult> {
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/u.test(id) || id.includes("..")) {
    throw new Error("market_skill_content_invalid_id");
  }
  const baseUrl = getMarketApiBaseUrl(app, options).replace(/\/+$/u, "");
  if (!baseUrl) throw new Error("market_skill_content_unavailable");
  const fetchImpl = resolveMarketFetchImpl(options.fetchImpl);
  const boundedFetch: typeof fetch = async (url, init) => {
    const response = await fetchImpl(url, {
      ...init,
      method: "GET",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(SKILL_CONTENT_TIMEOUT_MS)
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("market_skill_content_unavailable");
    }
    const bytes = await readResponseBytesWithLimit(response, MAX_SKILL_CONTENT_BYTES);
    return new Response(bytes.toString("utf8"), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  let payload: unknown;
  try {
    payload = await requestPublicMarketJson(app, `${baseUrl}/skills/${encodeURIComponent(id)}/skill-md`,
      { ...options, fetchImpl: boundedFetch }, "public skill documentation");
  } catch {
    // Remote error bodies can contain server paths or sensitive diagnostic data.
    throw new Error("market_skill_content_unavailable");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || typeof (payload as { content?: unknown }).content !== "string") {
    throw new Error("market_skill_content_invalid_response");
  }
  const content = (payload as { content: string }).content;
  if (!content.trim()) throw new Error("market_skill_content_empty");
  if (Buffer.byteLength(content, "utf8") > MAX_SKILL_CONTENT_BYTES) throw new Error("market_skill_content_too_large");
  return { content };
}
