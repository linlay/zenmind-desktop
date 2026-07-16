import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type {
  WebsiteFaviconCacheInput,
  WebsiteFaviconCacheResult,
} from "../../../shared/contracts";
import { buildWebsiteFaviconUrl } from "../../../shared/website-favicon";
import { getWebsiteDir, readWebsiteItems } from "./store";

const FAVICON_DOWNLOAD_TIMEOUT_MS = 10_000;
const FAVICON_MAX_BYTES = 1024 * 1024;
const FAVICON_MAX_REDIRECTS = 3;

const FAVICON_EXTENSION_BY_CONTENT_TYPE = new Map<string, string>([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/bmp", ".bmp"],
  ["image/ico", ".ico"],
  ["image/icon", ".ico"],
  ["image/x-icon", ".ico"],
  ["image/vnd.microsoft.icon", ".ico"],
  ["image/svg+xml", ".svg"],
]);

const FAVICON_FILE_NAMES = [...new Set(
  [...FAVICON_EXTENSION_BY_CONTENT_TYPE.values()].map((extension) => `favicon${extension}`),
)];

type FaviconFetchResponse = {
  ok: boolean;
  status: number;
  url: string;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  body?: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(): Promise<unknown>;
      releaseLock?(): void;
    };
  } | null;
};

type FaviconFetch = (
  url: string,
  init: { redirect: "manual"; signal: AbortSignal },
) => Promise<FaviconFetchResponse>;

type DownloadedFavicon = {
  bytes: Buffer;
  extension: string;
};

let faviconVersionSequence = 0;

function nextFaviconVersion() {
  faviconVersionSequence = Math.max(Date.now(), faviconVersionSequence + 1);
  return faviconVersionSequence;
}

function emptyResult(message: string): WebsiteFaviconCacheResult {
  return { ok: false, faviconUrl: "", message };
}

function normalizeContentType(value: string | null) {
  return (value ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isRedirectStatus(status: number) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function parseContentLength(value: string | null) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function decodeDataImageUrl(value: string): DownloadedFavicon | null {
  const match = value.match(/^data:(image\/(?:png|jpe?g|gif|webp|bmp|x-icon|vnd\.microsoft\.icon))(;base64)?,([\s\S]*)$/iu);
  if (!match) {
    return null;
  }

  const contentType = match[1].toLowerCase();
  const extension = FAVICON_EXTENSION_BY_CONTENT_TYPE.get(contentType);
  if (!extension) {
    return null;
  }

  try {
    const bytes = match[2]
      ? Buffer.from(match[3], "base64")
      : Buffer.from(decodeURIComponent(match[3]), "utf8");
    return bytes.length > 0 && bytes.length <= FAVICON_MAX_BYTES ? { bytes, extension } : null;
  } catch {
    return null;
  }
}

async function readFaviconResponseBytes(response: FaviconFetchResponse) {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > FAVICON_MAX_BYTES) {
      throw new Error("favicon response is too large");
    }
    return bytes;
  }

  const chunks: Buffer[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      const chunk = Buffer.from(value);
      byteLength += chunk.length;
      if (byteLength > FAVICON_MAX_BYTES) {
        await reader.cancel();
        throw new Error("favicon response is too large");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }

  if (byteLength === 0) {
    throw new Error("favicon response is too large");
  }
  return Buffer.concat(chunks, byteLength);
}

async function downloadHttpFavicon(
  url: string,
  fetchImpl: FaviconFetch,
  timeoutMs = FAVICON_DOWNLOAD_TIMEOUT_MS,
): Promise<DownloadedFavicon> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let currentUrl = url;

  try {
    for (let redirects = 0; redirects <= FAVICON_MAX_REDIRECTS; redirects += 1) {
      const response = await fetchImpl(currentUrl, { redirect: "manual", signal: controller.signal });
      if (isRedirectStatus(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirects === FAVICON_MAX_REDIRECTS) {
          throw new Error("favicon redirect failed");
        }
        const nextUrl = new URL(location, currentUrl).toString();
        if (!isHttpUrl(nextUrl)) {
          throw new Error("favicon redirect URL is invalid");
        }
        currentUrl = nextUrl;
        continue;
      }

      if (!response.ok) {
        throw new Error(`favicon request failed: ${response.status}`);
      }

      const contentType = normalizeContentType(response.headers.get("content-type"));
      const extension = FAVICON_EXTENSION_BY_CONTENT_TYPE.get(contentType);
      if (!extension) {
        throw new Error("favicon response is not a supported image");
      }

      const contentLength = parseContentLength(response.headers.get("content-length"));
      if (contentLength !== null && contentLength > FAVICON_MAX_BYTES) {
        throw new Error("favicon response is too large");
      }

      const bytes = await readFaviconResponseBytes(response);
      return { bytes, extension };
    }
  } finally {
    clearTimeout(timer);
  }

  throw new Error("favicon redirect failed");
}

function removeFaviconFiles(websiteDir: string, exceptFileName = "") {
  for (const fileName of FAVICON_FILE_NAMES) {
    if (fileName === exceptFileName) {
      continue;
    }
    try {
      fs.rmSync(path.join(websiteDir, fileName), { force: true });
    } catch {
      // A stale favicon is harmless; a later refresh can replace it.
    }
  }
}

export function clearCachedWebsiteFavicon(
  app: App,
  id: string,
  platform: NodeJS.Platform = process.platform,
) {
  removeFaviconFiles(getWebsiteDir(app, id, platform));
}

export function findCachedWebsiteFaviconPath(
  app: App,
  id: string,
  platform: NodeJS.Platform = process.platform,
) {
  const websiteDir = getWebsiteDir(app, id, platform);
  for (const fileName of FAVICON_FILE_NAMES) {
    const candidate = path.join(websiteDir, fileName);
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Try the next supported file name.
    }
  }
  return "";
}

export async function cacheWebsiteFavicon(
  app: App,
  input: WebsiteFaviconCacheInput,
  options: { fetchImpl?: FaviconFetch; platform?: NodeJS.Platform; timeoutMs?: number } = {},
): Promise<WebsiteFaviconCacheResult> {
  const id = typeof input?.id === "string" ? input.id.trim() : "";
  const websiteUrl = typeof input?.websiteUrl === "string" ? input.websiteUrl.trim() : "";
  const faviconUrl = typeof input?.faviconUrl === "string" ? input.faviconUrl.trim() : "";
  if (!id || !websiteUrl || !faviconUrl) {
    return emptyResult("Favicon input is invalid.");
  }

  const website = readWebsiteItems(app, options.platform).find(
    (item) => item.id === id && item.url === websiteUrl,
  );
  if (!website) {
    return emptyResult("Website configuration changed before the favicon was cached.");
  }

  try {
    const downloaded = decodeDataImageUrl(faviconUrl) ?? (
      isHttpUrl(faviconUrl)
        ? await downloadHttpFavicon(
          faviconUrl,
          options.fetchImpl ?? (fetch as unknown as FaviconFetch),
          options.timeoutMs,
        )
        : null
    );
    if (!downloaded) {
      return emptyResult("Favicon URL is not supported.");
    }

    const websiteDir = getWebsiteDir(app, id, options.platform);
    const fileName = `favicon${downloaded.extension}`;
    const targetPath = path.join(websiteDir, fileName);
    const temporaryPath = path.join(
      websiteDir,
      `.${fileName}.${process.pid}.${nextFaviconVersion()}.tmp`,
    );
    fs.mkdirSync(websiteDir, { recursive: true });
    fs.writeFileSync(temporaryPath, downloaded.bytes);
    try {
      fs.rmSync(targetPath, { force: true });
      fs.renameSync(temporaryPath, targetPath);
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
    removeFaviconFiles(websiteDir, fileName);

    return {
      ok: true,
      faviconUrl: buildWebsiteFaviconUrl(id, nextFaviconVersion()),
      message: "Favicon cached.",
    };
  } catch (error) {
    return emptyResult(error instanceof Error ? error.message : String(error));
  }
}

export const __testInternals = {
  FAVICON_DOWNLOAD_TIMEOUT_MS,
  FAVICON_EXTENSION_BY_CONTENT_TYPE,
  FAVICON_FILE_NAMES,
  FAVICON_MAX_BYTES,
  FAVICON_MAX_REDIRECTS,
  decodeDataImageUrl,
  downloadHttpFavicon,
  readFaviconResponseBytes,
};
