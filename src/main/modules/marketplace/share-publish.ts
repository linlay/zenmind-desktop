import { createHash } from "node:crypto";
import type { App } from "electron";
import { MARKET_SHARE_RECEIVER, readMarketShareContext } from "../../../shared/market-share";
import type { ShareEnvelope } from "../../../shared/contracts/shares";
import type { PreparedShare, ShareServicePort } from "../../support/share-ports";
import { t } from "../../support/i18n/main-i18n";
import { asObject } from "./catalog-values";
import { normalizeCatalog } from "./catalog-normalization";
import { requestVisibleMarketJson } from "./market-http";
import { getMarketplaceCatalogUrl } from "./market-settings";
import { SHARE_INFO_PREVIEW } from "../../support/share-info-preview";

export function createMarketShare(app: App, shares: Pick<ShareServicePort, "publish">, input: unknown) {
  const value = asObject(input);
  const { itemId, resourceVersion } = value;
  if (Object.keys(value).length !== 2 || typeof resourceVersion !== "string" || !resourceVersion.trim() || resourceVersion.length > 128 || /\p{Cc}/u.test(resourceVersion) || typeof itemId !== "string" || itemId.trim() !== itemId || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(itemId) || itemId.includes("..")) {
    return Promise.resolve({ ok: false as const, message: t("market.share.invalid") });
  }
  return shares.publish(async limits => {
    const url = getMarketplaceCatalogUrl(app, {});
    if (!url) return { ok: false, message: t("market.main.marketApiNotConfigured") };
    const raw = await requestVisibleMarketJson(app, url, {}, "market share catalog request");
    const prepared = prepareMarketShare(raw, itemId, resourceVersion);
    if (prepared.manifest.length > limits.maxManifestBytes) return { ok: false, message: t("assistant.chatShareSnapshotTooLarge") };
    if (prepared.resources.reduce((total, resource) => total + resource.bytes.length, 0) > limits.maxResourceBytes) return { ok: false, message: t("assistant.chatShareResourcesTooLarge") };
    return prepared;
  });
}

/** Only freshly verified catalog data can supply identity/version/display facts. */
export function prepareMarketShare(raw: unknown, itemId: string, expectedVersion: string): PreparedShare {
  const catalog = normalizeCatalog(raw);
  const item = catalog.items.find(item => item.id === itemId && item.type === "connector");
  const rawItems = asObject(raw).items;
  const original = Array.isArray(rawItems) ? rawItems.map(asObject).find(candidate => candidate.id === itemId && candidate.type === "connector") : undefined;
  // normalizeCatalog's legacy 0.0.0 fallback cannot invent a share version.
  if (!item || !original || typeof original.version !== "string" || !original.version.trim() || item.version !== original.version.trim()) throw new Error(t("market.share.invalid"));
  if (item.version !== expectedVersion) throw new Error(t("market.share.versionChanged"));
  const context = readMarketShareContext({ itemId: item.id, resourceType: "connector", resourceVersion: item.version,
    display: { name: item.name, description: item.description, author: item.author || "", tags: item.tags } });
  if (!context) throw new Error(t("market.share.invalid"));
  const data = Buffer.from(JSON.stringify({ version: 1, context,
    labels: { type: t("market.tab.mcps.label"), version: t("market.share.version"), author: t("market.storefront.detail.author") } }), "utf8");
  const resources = [
    { id: "000000000000000000000001", name: "index.html", mimeType: "text/html", path: "index.html", bytes: SHARE_INFO_PREVIEW },
    { id: "000000000000000000000002", name: "data.json", mimeType: "application/json", path: "data.json", bytes: data },
  ];
  let title = t("market.share.pageTitle", { name: context.display.name });
  if (Buffer.byteLength(title) > 255 || /\p{Cc}/u.test(title)) title = t("market.share.pageTitle", { name: context.itemId });
  const envelope: ShareEnvelope = {
    protocolVersion: 1, kind: "market-resource", title,
    source: { module: "marketplace", id: item.id }, content: { version: 1, resourceId: resources[1].id },
    resources: resources.map(({ bytes, ...resource }) => ({ ...resource, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") })),
    preview: { type: "package", entrypoint: "index.html" },
    desktop: { receiverId: MARKET_SHARE_RECEIVER, contextVersion: 1, context },
  };
  return { manifest: Buffer.from(JSON.stringify(envelope), "utf8"), resources };
}
