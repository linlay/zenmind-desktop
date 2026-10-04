import type { MobilePairingPayloadV2 } from "./contracts";

const DESKTOP_WS_PAIRING_PREFIX = "zmpair:v2:";
const DESKTOP_WS_PATH = "/ws";

type BufferCtor = {
  from(input: string, encoding?: string): { toString(encoding?: string): string };
};

function bufferCtor(): BufferCtor | null {
  const candidate = (globalThis as { Buffer?: BufferCtor }).Buffer;
  return candidate && typeof candidate.from === "function" ? candidate : null;
}

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function encodeBase64Url(text: string) {
  const buffer = bufferCtor();
  if (buffer) {
    return buffer.from(text, "utf8").toString("base64url");
  }

  const bytes = new TextEncoder().encode(text);
  const chunks: string[] = [];
  for (let index = 0; index < bytes.length; index += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + 0x8000)));
  }
  return btoa(chunks.join("")).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
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

export function encodePairingPayloadV2(payload: MobilePairingPayloadV2) {
  return `${DESKTOP_WS_PAIRING_PREFIX}${encodeBase64Url(JSON.stringify(payload))}`;
}
