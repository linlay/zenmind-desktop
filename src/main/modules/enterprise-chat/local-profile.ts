import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { EnterpriseChatSelfProfile } from "../../../shared/contracts";
import { getDesktopConfigRoot, getRuntimeDataRoot } from "../../infrastructure/filesystem/user-paths";

const PROFILE_SCHEMA_VERSION = 1;
const MAX_MOTTO_LENGTH = 160;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

type StoredProfile = {
  motto: string;
  avatarFileName: string;
  avatarContentType: string;
};

type StoredProfiles = {
  schemaVersion: number;
  profiles: Record<string, StoredProfile>;
};

const EMPTY_PROFILE: EnterpriseChatSelfProfile = {
  motto: "",
  avatarDataUrl: "",
  hasCustomAvatar: false
};

function profileStorePath(app: App, platform: NodeJS.Platform) {
  return path.join(getDesktopConfigRoot(app, platform), "enterprise-chat-profile.json");
}

function profileAvatarRoot(app: App, platform: NodeJS.Platform) {
  return path.join(getRuntimeDataRoot(app, platform), "desktop", "enterprise-chat-profile");
}

function scopeKey(serverUrl: string, userId: string) {
  return crypto.createHash("sha256").update(`${serverUrl}\n${userId}`).digest("hex");
}

function emptyStore(): StoredProfiles {
  return { schemaVersion: PROFILE_SCHEMA_VERSION, profiles: {} };
}

function readStore(app: App, platform: NodeJS.Platform): StoredProfiles {
  try {
    const parsed = JSON.parse(fs.readFileSync(profileStorePath(app, platform), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return emptyStore();
    }
    const record = parsed as Record<string, unknown>;
    if (!record.profiles || typeof record.profiles !== "object" || Array.isArray(record.profiles)) {
      return emptyStore();
    }
    const profiles: Record<string, StoredProfile> = {};
    for (const [key, value] of Object.entries(record.profiles as Record<string, unknown>)) {
      if (!/^[a-f0-9]{64}$/u.test(key) || !value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const profile = value as Record<string, unknown>;
      profiles[key] = {
        motto: typeof profile.motto === "string" ? profile.motto.slice(0, MAX_MOTTO_LENGTH) : "",
        avatarFileName: typeof profile.avatarFileName === "string"
          ? path.basename(profile.avatarFileName)
          : "",
        avatarContentType: typeof profile.avatarContentType === "string"
          ? profile.avatarContentType
          : ""
      };
    }
    return { schemaVersion: PROFILE_SCHEMA_VERSION, profiles };
  } catch {
    return emptyStore();
  }
}

async function writeStore(app: App, platform: NodeJS.Platform, store: StoredProfiles) {
  const targetPath = profileStorePath(app, platform);
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await fs.promises.rename(temporaryPath, targetPath);
}

function detectAvatar(buffer: Buffer) {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { extension: ".png", contentType: "image/png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: ".jpg", contentType: "image/jpeg" };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { extension: ".webp", contentType: "image/webp" };
  }
  throw new Error("Avatar must be a PNG, JPEG, or WebP image.");
}

export function readEnterpriseChatSelfProfile(
  app: App,
  platform: NodeJS.Platform,
  serverUrl: string,
  userId: string
): EnterpriseChatSelfProfile {
  if (!serverUrl.trim() || !userId.trim()) {
    return { ...EMPTY_PROFILE };
  }
  const key = scopeKey(serverUrl, userId);
  const stored = readStore(app, platform).profiles[key];
  if (!stored) {
    return { ...EMPTY_PROFILE };
  }
  let avatarDataUrl = "";
  if (stored.avatarFileName && stored.avatarContentType) {
    try {
      const avatarPath = path.join(profileAvatarRoot(app, platform), key, stored.avatarFileName);
      const bytes = fs.readFileSync(avatarPath);
      if (bytes.length > 0 && bytes.length <= MAX_AVATAR_BYTES) {
        avatarDataUrl = `data:${stored.avatarContentType};base64,${bytes.toString("base64")}`;
      }
    } catch {
      avatarDataUrl = "";
    }
  }
  return {
    motto: stored.motto,
    avatarDataUrl,
    hasCustomAvatar: Boolean(avatarDataUrl)
  };
}

export async function saveEnterpriseChatMotto(
  app: App,
  platform: NodeJS.Platform,
  serverUrl: string,
  userId: string,
  motto: string
) {
  const key = scopeKey(serverUrl, userId);
  const store = readStore(app, platform);
  const current = store.profiles[key];
  store.profiles[key] = {
    motto: motto.trim().slice(0, MAX_MOTTO_LENGTH),
    avatarFileName: current?.avatarFileName ?? "",
    avatarContentType: current?.avatarContentType ?? ""
  };
  await writeStore(app, platform, store);
  return readEnterpriseChatSelfProfile(app, platform, serverUrl, userId);
}

export async function saveEnterpriseChatAvatar(
  app: App,
  platform: NodeJS.Platform,
  serverUrl: string,
  userId: string,
  sourcePath: string
) {
  const sourceStat = await fs.promises.stat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.size <= 0 || sourceStat.size > MAX_AVATAR_BYTES) {
    throw new Error("Avatar image must be smaller than 2 MB.");
  }
  const buffer = await fs.promises.readFile(sourcePath);
  const detected = detectAvatar(buffer);
  const key = scopeKey(serverUrl, userId);
  const avatarDirectory = path.join(profileAvatarRoot(app, platform), key);
  const avatarFileName = `avatar${detected.extension}`;
  const targetPath = path.join(avatarDirectory, avatarFileName);
  const temporaryPath = path.join(avatarDirectory, `avatar.${process.pid}.tmp`);
  await fs.promises.mkdir(avatarDirectory, { recursive: true, mode: 0o700 });
  for (const candidate of ["avatar.png", "avatar.jpg", "avatar.webp"]) {
    if (candidate !== avatarFileName) {
      await fs.promises.rm(path.join(avatarDirectory, candidate), { force: true });
    }
  }
  await fs.promises.writeFile(temporaryPath, buffer, { mode: 0o600 });
  await fs.promises.rename(temporaryPath, targetPath);

  const store = readStore(app, platform);
  const current = store.profiles[key];
  store.profiles[key] = {
    motto: current?.motto ?? "",
    avatarFileName,
    avatarContentType: detected.contentType
  };
  await writeStore(app, platform, store);
  return readEnterpriseChatSelfProfile(app, platform, serverUrl, userId);
}

export async function clearEnterpriseChatAvatar(
  app: App,
  platform: NodeJS.Platform,
  serverUrl: string,
  userId: string
) {
  const key = scopeKey(serverUrl, userId);
  const avatarDirectory = path.join(profileAvatarRoot(app, platform), key);
  for (const candidate of ["avatar.png", "avatar.jpg", "avatar.webp"]) {
    await fs.promises.rm(path.join(avatarDirectory, candidate), { force: true });
  }
  const store = readStore(app, platform);
  const current = store.profiles[key];
  store.profiles[key] = {
    motto: current?.motto ?? "",
    avatarFileName: "",
    avatarContentType: ""
  };
  await writeStore(app, platform, store);
  return readEnterpriseChatSelfProfile(app, platform, serverUrl, userId);
}

export const enterpriseChatLocalProfileInternals = {
  MAX_AVATAR_BYTES,
  MAX_MOTTO_LENGTH,
  detectAvatar,
  scopeKey
};
