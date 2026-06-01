import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { App } from "electron";
import { getDesktopConfigRoot } from "./user-paths";

const DEVICE_IDENTITY_FILE = "device-identity.json";
const DEVICE_IDENTITY_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type DesktopDeviceIdentity = {
  version: number;
  deviceId: string;
  createdAt: string;
};

function isValidUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

function readDesktopDeviceIdentityFile(identityPath: string): DesktopDeviceIdentity | null {
  if (!fs.existsSync(identityPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(identityPath, "utf8")) as Partial<DesktopDeviceIdentity>;
    if (isValidUuid(parsed.deviceId)) {
      return {
        version: typeof parsed.version === "number" ? parsed.version : DEVICE_IDENTITY_VERSION,
        deviceId: parsed.deviceId.trim(),
        createdAt: typeof parsed.createdAt === "string" && parsed.createdAt.trim()
          ? parsed.createdAt.trim()
          : new Date().toISOString()
      };
    }
  } catch {
    // Corrupt identity files are replaced below with a fresh installation ID.
  }
  return null;
}

function writeDesktopDeviceIdentity(identityPath: string, identity: DesktopDeviceIdentity) {
  fs.mkdirSync(path.dirname(identityPath), { recursive: true });
  fs.writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
}

export function getDesktopDeviceIdentityPath(app: App) {
  return path.join(getDesktopConfigRoot(app), DEVICE_IDENTITY_FILE);
}

export function getDesktopDeviceIdentity(app: App): DesktopDeviceIdentity {
  const identityPath = getDesktopDeviceIdentityPath(app);
  const existing = readDesktopDeviceIdentityFile(identityPath);
  if (existing) {
    return existing;
  }

  const identity: DesktopDeviceIdentity = {
    version: DEVICE_IDENTITY_VERSION,
    deviceId: randomUUID(),
    createdAt: new Date().toISOString()
  };
  writeDesktopDeviceIdentity(identityPath, identity);
  return identity;
}

export function getDesktopDeviceId(app: App) {
  return getDesktopDeviceIdentity(app).deviceId;
}

export const __testInternals = {
  DEVICE_IDENTITY_FILE,
  DEVICE_IDENTITY_VERSION,
  isValidUuid,
  readDesktopDeviceIdentityFile
};
