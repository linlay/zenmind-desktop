import { t } from "../../support/i18n/main-i18n";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { MarketAsset, MarketCatalogItem } from "../../../shared/contracts";
import type { App } from "electron";
import type { MarketplaceOptions } from "./market-model";
import { MAX_MARKET_DOWNLOAD_BYTES } from "./market-model";
import { requestMarket } from "./market-http";
import path from "node:path";
import { downloadsRoot } from "./market-paths";

export async function readResponseBytesWithLimit(response: Response, maxBytes: number) {
  const limit = Math.max(1, Math.trunc(maxBytes));
  const declaredLength = Number.parseInt(response.headers.get("content-length") || "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new Error(t("market.main.downloadTooLarge", { maxBytes: limit }));
  }
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) {
      throw new Error(t("market.main.downloadTooLarge", { maxBytes: limit }));
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      totalBytes += value.byteLength;
      if (totalBytes > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error(t("market.main.downloadTooLarge", { maxBytes: limit }));
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

export function sha256(filePath: string) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function extensionForAsset(asset: MarketAsset) {
  if (asset.archiveType === "zip") return ".zip";
  if (asset.archiveType === "md") return ".md";
  if (asset.archiveType === "container-image" || asset.archiveType === "tar.gz") return ".tar.gz";
  if (
    asset.archiveType === "skill" ||
    asset.archiveType === "sandbox-template" ||
    asset.archiveType === "pet" ||
    asset.archiveType === "cli" ||
    asset.archiveType === "agent" ||
    asset.archiveType === "website-app"
  ) return ".zip";
  return ".zip";
}

export async function downloadAsset(
  app: App,
  item: MarketCatalogItem,
  asset: MarketAsset,
  options: MarketplaceOptions = {},
  downloadUrl = asset.url,
  maxBytes = MAX_MARKET_DOWNLOAD_BYTES
) {
  const limit = Math.min(maxBytes, MAX_MARKET_DOWNLOAD_BYTES);
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Invalid download size limit");
  if (asset.sizeBytes > limit) {
    throw new Error(t("market.main.downloadTooLarge", { maxBytes: limit }));
  }
  const response = await requestMarket(app, downloadUrl, {}, options, "market asset download");
  const bytes = await readResponseBytesWithLimit(
    response,
    asset.sizeBytes > 0 ? asset.sizeBytes : limit
  );
  if (asset.sizeBytes > 0 && bytes.length !== asset.sizeBytes) {
    throw new Error(t("market.main.downloadSizeMismatch", { expected: asset.sizeBytes, actual: bytes.length }));
  }
  const downloadPath = path.join(downloadsRoot(app), `${item.id}-${Date.now()}${extensionForAsset(asset)}`);
  fs.writeFileSync(downloadPath, bytes);
  if (asset.sha256 && sha256(downloadPath) !== asset.sha256) {
    fs.rmSync(downloadPath, { force: true });
    throw new Error(t("market.main.downloadChecksumFailed"));
  }
  return downloadPath;
}
