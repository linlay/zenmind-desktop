import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { App } from "electron";
import { DESKTOP_PET_USER_ASSET_PROTOCOL } from "../../../shared/desktop-pet";
import { getDesktopPetsDataRoot } from "../../user-paths";

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

const DESKTOP_PET_ASSET_EXTENSIONS = new Set([
  ".apng",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp"
]);

function getPathApi(platform: NodeJS.Platform | string) {
  if (platform === "win32") {
    return path.win32;
  }
  if (platform === "darwin") {
    return path.posix;
  }
  return path.posix;
}

function normalizeDesktopPetProtocolId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
}

function decodeDesktopPetAssetPathname(pathname: string) {
  try {
    return pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
  } catch {
    return [];
  }
}

function isSafeDesktopPetAssetSegments(segments: string[]) {
  return segments.length > 0 &&
    segments.every((segment) =>
      segment &&
      segment !== "." &&
      segment !== ".." &&
      !segment.startsWith(".") &&
      !segment.includes("/") &&
      !segment.includes("\\")
    );
}

function isAllowedDesktopPetAssetFile(filePath: string, platform: NodeJS.Platform | string) {
  return DESKTOP_PET_ASSET_EXTENSIONS.has(getPathApi(platform).extname(filePath).toLowerCase());
}

function realpathIfExists(filePath: string) {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return "";
  }
}

export function isDesktopPetAssetPathInsideRoot(
  rootPath: string,
  targetPath: string,
  platform: NodeJS.Platform | string = process.platform
) {
  const pathApi = getPathApi(platform);
  const relativePath = pathApi.relative(rootPath, targetPath);
  if (platform === "win32") {
    return relativePath === "" || Boolean(relativePath && !relativePath.startsWith("..") && !pathApi.isAbsolute(relativePath));
  }
  if (platform === "darwin") {
    return relativePath === "" || Boolean(relativePath && !relativePath.startsWith("..") && !pathApi.isAbsolute(relativePath));
  }
  return relativePath === "" || Boolean(relativePath && !relativePath.startsWith("..") && !pathApi.isAbsolute(relativePath));
}

export function resolveDesktopPetAssetRequest(
  app: App,
  requestUrl: string,
  platform: NodeJS.Platform | string = process.platform
) {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return "";
  }
  if (parsed.protocol !== `${DESKTOP_PET_USER_ASSET_PROTOCOL}:`) {
    return "";
  }

  const petId = normalizeDesktopPetProtocolId(decodeURIComponent(parsed.hostname));
  if (!petId || petId !== parsed.hostname) {
    return "";
  }

  const segments = decodeDesktopPetAssetPathname(parsed.pathname);
  if (!isSafeDesktopPetAssetSegments(segments)) {
    return "";
  }

  const pathApi = getPathApi(platform);
  const petRoot = pathApi.join(getDesktopPetsDataRoot(app), petId);
  const targetPath = pathApi.resolve(petRoot, ...segments);
  if (!isAllowedDesktopPetAssetFile(targetPath, platform)) {
    return "";
  }

  const petRootRealPath = realpathIfExists(petRoot);
  const targetRealPath = realpathIfExists(targetPath);
  if (!petRootRealPath || !targetRealPath) {
    return "";
  }
  if (!isDesktopPetAssetPathInsideRoot(petRootRealPath, targetRealPath, platform)) {
    return "";
  }
  try {
    return fs.statSync(targetRealPath).isFile() ? targetRealPath : "";
  } catch {
    return "";
  }
}

export function registerDesktopPetAssetProtocolScheme(protocolModule: ProtocolModule) {
  protocolModule.registerSchemesAsPrivileged([
    {
      scheme: DESKTOP_PET_USER_ASSET_PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true
      }
    }
  ]);
}

export function registerDesktopPetAssetProtocol(
  app: App,
  protocolModule: ProtocolModule,
  netModule: NetModule,
  platform: NodeJS.Platform | string = process.platform
) {
  protocolModule.handle(DESKTOP_PET_USER_ASSET_PROTOCOL, async (request) => {
    const filePath = resolveDesktopPetAssetRequest(app, request.url, platform);
    if (!filePath) {
      return new Response("Not found", { status: 404 });
    }
    return netModule.fetch(pathToFileURL(filePath).toString());
  });
}
