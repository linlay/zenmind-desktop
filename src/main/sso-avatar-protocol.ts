import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { App } from "electron";
import {
  DESKTOP_SSO_AVATAR_PROTOCOL
} from "../shared/sso-avatar";
import { resolveDesktopSsoAvatarRequest } from "./oidc-sso";
import { getDesktopSsoAvatarCacheDir } from "./sso-avatar-storage";

const AVATAR_DOWNLOAD_TIMEOUT_MS = 10_000;
const AVATAR_MAX_BYTES = 1024 * 1024;
const AVATAR_MAX_REDIRECTS = 3;

const AVATAR_EXTENSION_BY_CONTENT_TYPE = new Map<string, string>([
  ["image/gif", ".gif"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);

const AVATAR_CONTENT_TYPE_BY_EXTENSION = new Map<string, string>(
  [...AVATAR_EXTENSION_BY_CONTENT_TYPE.entries()].map(([contentType, extension]) => [
    extension,
    contentType,
  ]),
);

type ProtocolModule = {
  registerSchemesAsPrivileged(schemes: Array<{
    scheme: string;
    privileges: {
      standard: boolean;
      secure: boolean;
      supportFetchAPI: boolean;
      corsEnabled: boolean;
    };
  }>): void;
  handle(scheme: string, handler: (request: { url: string }) => unknown): void;
};

type AvatarFetch = (
  url: string,
  init: {
    credentials: "include";
    headers: Record<string, string>;
    redirect: "manual";
    signal: AbortSignal;
  },
) => Promise<Response>;

type SessionModule = {
  defaultSession: {
    fetch: AvatarFetch;
  };
};

type NetModule = {
  fetch(url: string): Promise<unknown>;
};

const pendingDownloads = new Map<string, Promise<string>>();

function pathApiForPlatform(platform: NodeJS.Platform | string) {
  return platform === "win32" ? path.win32 : path.posix;
}

function findCachedAvatar(
  app: App,
  version: string,
  platform: NodeJS.Platform | string,
) {
  const pathApi = pathApiForPlatform(platform);
  const cacheDir = getDesktopSsoAvatarCacheDir(app, platform);
  for (const extension of AVATAR_CONTENT_TYPE_BY_EXTENSION.keys()) {
    const candidate = pathApi.join(cacheDir, `${version}${extension}`);
    try {
      if (fs.lstatSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Try the next supported image extension.
    }
  }
  return "";
}

function parseContentLength(value: string | null) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isRedirectStatus(status: number) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readResponseBytes(response: Response) {
  const declaredLength = parseContentLength(response.headers.get("content-length"));
  if (declaredLength !== null && declaredLength > AVATAR_MAX_BYTES) {
    throw new Error("avatar response is too large");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > AVATAR_MAX_BYTES) {
      throw new Error("avatar response is too large");
    }
    return bytes;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      total += value.byteLength;
      if (total > AVATAR_MAX_BYTES) {
        await reader.cancel();
        throw new Error("avatar response is too large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) {
    throw new Error("avatar response is empty");
  }
  return Buffer.concat(chunks, total);
}

async function downloadAvatar(
  sourceUrl: string,
  trustedOrigin: string,
  fetchImpl: AvatarFetch,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AVATAR_DOWNLOAD_TIMEOUT_MS);
  let currentUrl = sourceUrl;
  try {
    for (let redirects = 0; redirects <= AVATAR_MAX_REDIRECTS; redirects += 1) {
      if (new URL(currentUrl).origin !== trustedOrigin) {
        throw new Error("avatar redirect origin is not trusted");
      }
      const response = await fetchImpl(currentUrl, {
        credentials: "include",
        headers: {
          Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif",
        },
        redirect: "manual",
        signal: controller.signal,
      });
      if (isRedirectStatus(response.status)) {
        if (redirects === AVATAR_MAX_REDIRECTS) {
          throw new Error("avatar redirect limit exceeded");
        }
        const location = response.headers.get("location")?.trim() || "";
        if (!location) {
          throw new Error("avatar redirect is missing location");
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (!response.ok) {
        throw new Error(`avatar request failed: ${response.status}`);
      }
      const contentType = (response.headers.get("content-type") ?? "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();
      const extension = AVATAR_EXTENSION_BY_CONTENT_TYPE.get(contentType);
      if (!extension) {
        throw new Error("avatar response is not a supported image");
      }
      return {
        bytes: await readResponseBytes(response),
        extension,
      };
    }
  } finally {
    clearTimeout(timeout);
  }
  throw new Error("avatar redirect limit exceeded");
}

async function ensureCachedAvatar(
  app: App,
  version: string,
  sessionModule: SessionModule,
  platform: NodeJS.Platform | string,
) {
  const cached = findCachedAvatar(app, version, platform);
  if (cached) {
    return cached;
  }
  const resolved = resolveDesktopSsoAvatarRequest(app, version);
  if (!resolved) {
    return "";
  }
  const pathApi = pathApiForPlatform(platform);
  const cacheDir = getDesktopSsoAvatarCacheDir(app, platform);
  const downloaded = await downloadAvatar(
    resolved.sourceUrl,
    resolved.trustedOrigin,
    sessionModule.defaultSession.fetch.bind(sessionModule.defaultSession),
  );
  fs.mkdirSync(cacheDir, { recursive: true });
  const targetPath = pathApi.join(cacheDir, `${version}${downloaded.extension}`);
  const temporaryPath = pathApi.join(
    cacheDir,
    `.${version}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(temporaryPath, downloaded.bytes, { mode: 0o600 });
  try {
    fs.renameSync(temporaryPath, targetPath);
  } catch (error) {
    if (!findCachedAvatar(app, version, platform)) {
      throw error;
    }
  } finally {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Another request may already have committed the same cache entry.
    }
  }
  for (const entry of fs.readdirSync(cacheDir)) {
    if (!entry.startsWith(`${version}.`) && !entry.startsWith(`.${version}.`)) {
      try {
        fs.rmSync(pathApi.join(cacheDir, entry), { force: true });
      } catch {
        // Stale avatars are harmless and can be removed by logout.
      }
    }
  }
  return findCachedAvatar(app, version, platform);
}

function avatarVersionFromRequest(requestUrl: string) {
  try {
    const parsed = new URL(requestUrl);
    return parsed.protocol === `${DESKTOP_SSO_AVATAR_PROTOCOL}:` &&
      parsed.pathname === "/avatar" &&
      /^[a-f0-9]{24}$/u.test(parsed.hostname)
      ? parsed.hostname
      : "";
  } catch {
    return "";
  }
}

export function registerDesktopSsoAvatarProtocolScheme(protocolModule: ProtocolModule) {
  protocolModule.registerSchemesAsPrivileged([
    {
      scheme: DESKTOP_SSO_AVATAR_PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

export function registerDesktopSsoAvatarProtocol(
  app: App,
  protocolModule: ProtocolModule,
  netModule: NetModule,
  sessionModule: SessionModule,
  platform: NodeJS.Platform | string = process.platform,
) {
  protocolModule.handle(DESKTOP_SSO_AVATAR_PROTOCOL, async (request) => {
    const version = avatarVersionFromRequest(request.url);
    if (!version || !resolveDesktopSsoAvatarRequest(app, version)) {
      return new Response("Not found", { status: 404 });
    }
    let download = pendingDownloads.get(version);
    if (!download) {
      download = ensureCachedAvatar(app, version, sessionModule, platform);
      pendingDownloads.set(version, download);
    }
    try {
      const filePath = await download;
      if (!filePath) {
        return new Response("Not found", { status: 404 });
      }
      return netModule.fetch(pathToFileURL(filePath).toString());
    } catch {
      return new Response("Not found", { status: 404 });
    } finally {
      if (pendingDownloads.get(version) === download) {
        pendingDownloads.delete(version);
      }
    }
  });
}

export const __testInternals = {
  AVATAR_DOWNLOAD_TIMEOUT_MS,
  AVATAR_MAX_BYTES,
  AVATAR_MAX_REDIRECTS,
  avatarVersionFromRequest,
  downloadAvatar,
  findCachedAvatar,
  readResponseBytes,
};
