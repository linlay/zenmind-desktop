import {validateSkinResourcePath} from "../../../shared/desktop-skin-package";
import type { App } from "electron";
import { getMarketApiBaseUrl, readResponseBytesWithLimit, requestVisibleMarketJson, resolveMarketFetchImpl, type MarketplaceOptions } from "./common";

export async function readMarketSkinAsset(app: App, input: unknown, options: MarketplaceOptions = {}): Promise<{ dataUrl: string }> {
  const value = input as { id?: unknown; version?: unknown; path?: unknown } | null;
  if (!value || typeof value.id !== "string" || value.id.length > 64 || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(value.id)
    || typeof value.version !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,127}$/u.test(value.version)
    || typeof value.path !== "string" || !/\.(png|jpe?g)$/iu.test(value.path)
    || value.path.length > 1024 || value.path.split("/").some(part => !part || part.startsWith(".") || /[\\:%\x00-\x1f]/u.test(part)))
    throw new Error("market_skin_asset_invalid");
  try{validateSkinResourcePath(value.path)}catch{throw new Error("market_skin_asset_invalid")}
  const base = getMarketApiBaseUrl(app, options).replace(/\/+$/u, "");
  if (!base) throw new Error("market_skin_asset_unavailable");
  const resource = value.path.split("/").map(encodeURIComponent).join("/");
  const resourceURL = `${base}/skins/${encodeURIComponent(value.id)}/versions/${encodeURIComponent(value.version)}/assets/${resource}`;
  const fetchImpl = resolveMarketFetchImpl(options.fetchImpl);
  const boundedFetch: typeof fetch = async (url, init) => {
    const response = await fetchImpl(url, { ...init, method: "GET", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(15000) });
    // The shared visibility flow verifies auth/me before fetching a private
    // image. Keep that JSON handshake intact rather than decoding it as raster.
    if (String(url) !== resourceURL) return response;
    if (response.status === 401) return response;
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error("market_skin_asset_unavailable"); }
    const bytes = await readResponseBytesWithLimit(response, 16 * 1024 * 1024);
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!png && !jpeg) throw new Error("market_skin_asset_invalid");
    return new Response(JSON.stringify({ dataUrl: `data:image/${png ? "png" : "jpeg"};base64,${bytes.toString("base64")}` }), { headers: { "Content-Type": "application/json" } });
  };
  return await requestVisibleMarketJson(app,
    resourceURL,
    { ...options, fetchImpl: boundedFetch }, "skin preview") as { dataUrl: string };
}
