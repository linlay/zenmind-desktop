export function resolveServiceWebviewWsMonitorUrl(input: unknown, pageHref: string): string {
  function normalizeText(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
  }

  function decodeBase64UrlJson(segment: string): Record<string, unknown> | null {
    try {
      const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
      const decoded = typeof globalThis.atob === "function"
        ? globalThis.atob(padded)
        : typeof Buffer !== "undefined"
          ? Buffer.from(padded, "base64").toString("binary")
          : "";
      if (!decoded) {
        return null;
      }
      try {
        const jsonText = decodeURIComponent(
          Array.from(decoded)
            .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`)
            .join("")
        );
        return JSON.parse(jsonText) as Record<string, unknown>;
      } catch {
        return JSON.parse(decoded) as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }

  function readDeviceIdFromToken(token: string) {
    const payloadSegment = token.split(".")[1] || "";
    const payload = payloadSegment ? decodeBase64UrlJson(payloadSegment) : null;
    return normalizeText(payload?.device_id) || normalizeText(payload?.deviceId);
  }

  const originalUrl = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : String(input ?? "");
  let pageUrl: URL;
  try {
    pageUrl = new URL(pageHref);
  } catch {
    return originalUrl;
  }

  const source = normalizeText(pageUrl.searchParams.get("wsSource"));
  if (!source) {
    return originalUrl;
  }

  let wsUrl: URL;
  try {
    wsUrl = new URL(originalUrl, pageUrl.toString());
  } catch {
    return originalUrl;
  }
  if ((wsUrl.protocol !== "ws:" && wsUrl.protocol !== "wss:") || wsUrl.pathname !== "/ws") {
    return originalUrl;
  }

  wsUrl.searchParams.set("source", source);
  wsUrl.searchParams.set("deviceId", readDeviceIdFromToken(wsUrl.searchParams.get("token") || ""));
  return wsUrl.toString();
}
