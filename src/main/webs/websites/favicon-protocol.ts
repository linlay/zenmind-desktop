import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { App } from "electron";
import { DESKTOP_WEBSITE_FAVICON_PROTOCOL } from "../../../shared/website-favicon";
import { normalizeWebId } from "../common";
import { findCachedWebsiteFaviconPath } from "./favicon-cache";
import { getWebsiteDir, readWebsiteItems } from "./store";

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

type NetModule = {
  fetch(url: string): Promise<unknown>;
};

function pathApiForPlatform(platform: NodeJS.Platform | string) {
  return platform === "win32" ? path.win32 : path.posix;
}

export function isWebsiteFaviconPathInsideRoot(
  rootPath: string,
  targetPath: string,
  platform: NodeJS.Platform | string,
) {
  const pathApi = pathApiForPlatform(platform);
  const relativePath = pathApi.relative(rootPath, targetPath);
  return Boolean(
    relativePath && !relativePath.startsWith("..") && !pathApi.isAbsolute(relativePath),
  );
}

function decodeWebsiteId(value: string) {
  try {
    const decoded = decodeURIComponent(value);
    return decoded && normalizeWebId(decoded) === decoded ? decoded : "";
  } catch {
    return "";
  }
}

export function resolveWebsiteFaviconRequest(
  app: App,
  requestUrl: string,
  platform: NodeJS.Platform | string = process.platform,
) {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return "";
  }
  if (
    parsed.protocol !== `${DESKTOP_WEBSITE_FAVICON_PROTOCOL}:` ||
    parsed.pathname !== "/favicon"
  ) {
    return "";
  }

  const id = decodeWebsiteId(parsed.hostname);
  const normalizedPlatform = platform as NodeJS.Platform;
  if (!id || !readWebsiteItems(app, normalizedPlatform).some((item) => item.id === id)) {
    return "";
  }

  const websiteDir = getWebsiteDir(app, id, normalizedPlatform);
  const cachedPath = findCachedWebsiteFaviconPath(app, id, normalizedPlatform);
  if (!cachedPath) {
    return "";
  }

  try {
    const rootRealPath = fs.realpathSync.native(websiteDir);
    const targetRealPath = fs.realpathSync.native(cachedPath);
    if (!isWebsiteFaviconPathInsideRoot(rootRealPath, targetRealPath, platform)) {
      return "";
    }
    return fs.statSync(targetRealPath).isFile() ? targetRealPath : "";
  } catch {
    return "";
  }
}

export function registerWebsiteFaviconProtocolScheme(protocolModule: ProtocolModule) {
  protocolModule.registerSchemesAsPrivileged([
    {
      scheme: DESKTOP_WEBSITE_FAVICON_PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

export function registerWebsiteFaviconProtocol(
  app: App,
  protocolModule: ProtocolModule,
  netModule: NetModule,
  platform: NodeJS.Platform | string = process.platform,
) {
  protocolModule.handle(DESKTOP_WEBSITE_FAVICON_PROTOCOL, async (request) => {
    const filePath = resolveWebsiteFaviconRequest(app, request.url, platform);
    if (!filePath) {
      return new Response("Not found", { status: 404 });
    }
    return netModule.fetch(pathToFileURL(filePath).toString());
  });
}
