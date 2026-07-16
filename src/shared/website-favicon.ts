import { BRAND_ID } from "./brand";

export const DESKTOP_WEBSITE_FAVICON_PROTOCOL = `${BRAND_ID}-website-favicon`;

export function buildWebsiteFaviconUrl(id: string, version?: number) {
  const normalizedId = id.trim();
  if (!normalizedId) {
    return "";
  }

  const url = `${DESKTOP_WEBSITE_FAVICON_PROTOCOL}://${encodeURIComponent(normalizedId)}/favicon`;
  return Number.isFinite(version) && Number(version) > 0
    ? `${url}?v=${Math.trunc(Number(version))}`
    : url;
}
