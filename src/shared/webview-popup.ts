const MAX_WEBVIEW_POPUP_URL_LENGTH = 8_192;
const URL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

function normalizeRawUrl(value: unknown) {
  const input = typeof value === "string" ? value : "";
  if (
    !input ||
    input.length > MAX_WEBVIEW_POPUP_URL_LENGTH ||
    URL_CONTROL_CHARACTERS.test(input)
  ) {
    return "";
  }
  return input.trim();
}

function readTrustedWebviewOrigin(value: unknown) {
  const raw = normalizeRawUrl(value);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.origin;
    }
    const normalizedBlobUrl = normalizeWebviewBlobPopupUrl(raw);
    return normalizedBlobUrl ? new URL(normalizedBlobUrl).origin : "";
  } catch {
    return "";
  }
}

export function isBlobSchemeUrl(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return false;
  try {
    return new URL(raw).protocol === "blob:";
  } catch {
    return /^blob:/iu.test(raw);
  }
}

export function normalizeWebviewBlobPopupUrl(value: unknown) {
  const raw = normalizeRawUrl(value);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "blob:") return "";
    const creatorOrigin = new URL(parsed.origin);
    const embeddedUrl = new URL(parsed.pathname);
    if (
      (creatorOrigin.protocol !== "http:" && creatorOrigin.protocol !== "https:") ||
      embeddedUrl.origin !== creatorOrigin.origin ||
      embeddedUrl.username ||
      embeddedUrl.password
    ) {
      return "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

export function normalizeWebviewBlobPopupForSource(
  value: unknown,
  sourceUrl: unknown,
  referrerUrl?: unknown,
) {
  const normalized = normalizeWebviewBlobPopupUrl(value);
  if (!normalized) return "";
  const creatorOrigin = new URL(normalized).origin;
  const referrerOrigin = readTrustedWebviewOrigin(referrerUrl);
  const sourceOrigin = readTrustedWebviewOrigin(sourceUrl);
  const openerOrigin = referrerOrigin || sourceOrigin;
  return openerOrigin && openerOrigin === creatorOrigin ? normalized : "";
}

export function getWebviewBlobPopupHostname(value: unknown) {
  const normalized = normalizeWebviewBlobPopupUrl(value);
  if (!normalized) return "";
  return new URL(new URL(normalized).origin).hostname;
}
