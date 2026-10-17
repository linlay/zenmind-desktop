const DESKTOP_WS_PATH = "/ws";

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeDesktopWsUrlInput(value: unknown, fallback = ""): string {
  const trimmed = readText(value);
  if (!trimmed) {
    return fallback;
  }
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed) ? trimmed : `wss://${trimmed}`;

  try {
    const url = new URL(withProtocol);
    if (url.protocol === "http:") {
      url.protocol = "ws:";
    } else if (url.protocol === "https:") {
      url.protocol = "wss:";
    }
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      return fallback;
    }
    url.pathname = DESKTOP_WS_PATH;
    url.hash = "";
    url.search = "";
    return url.toString();
  } catch {
    return fallback;
  }
}
