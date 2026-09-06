import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { App } from "electron";
import type { DesktopDeviceIdentityInfo } from "../../../shared/contracts";
import { STORAGE_NAMESPACE } from "../../../shared/brand";
import { getDesktopConfigRoot } from "../../infrastructure/filesystem/user-paths";

const DEVICE_IDENTITY_FILE = "device-identity.json";
const DEVICE_IDENTITY_VERSION = 2;
const DEVICE_NAMESPACE = STORAGE_NAMESPACE;
const DEVICE_ID_HASH_NAMESPACE = `${DEVICE_NAMESPACE}:device:v2`;
const MACHINE_HASH_NAMESPACE = `${DEVICE_NAMESPACE}:machine:v2`;
const UNAVAILABLE_MACHINE_ID = "unavailable";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SYSTEM_GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/iu;
const cachedDeviceIdentities = new Map<string, DesktopDeviceIdentity>();

export type DesktopMachineSource =
  | "darwinIOPlatformUUID"
  | "windowsMachineGuid"
  | "unavailable";

type DesktopMachineIdentity = {
  machineId: string;
  source: DesktopMachineSource;
};

type ExecFileSyncLike = typeof execFileSync;

export type DesktopDeviceIdentity = {
  version: number;
  installId: string;
  deviceId: string;
  machineHash: string;
  machineSource: DesktopMachineSource;
  createdAt: string;
  updatedAt: string;
  lastMachineMismatchAt?: string;
};

export type DesktopDeviceIdentityOptions = {
  platform?: NodeJS.Platform;
  now?: () => Date;
  randomUUID?: () => string;
  readMachineIdentity?: (platform: NodeJS.Platform) => DesktopMachineIdentity;
};

function isValidUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

function isValidSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_PATTERN.test(value.trim());
}

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeUuid(value: string) {
  return value.trim().toLowerCase();
}

function normalizeSystemMachineId(value: unknown) {
  const normalized = readText(value).replace(/^\{|\}$/gu, "").toLowerCase();
  if (!SYSTEM_GUID_PATTERN.test(normalized)) {
    return "";
  }
  if (/^0{8}-0{4}-0{4}-0{4}-0{12}$/u.test(normalized)) {
    return "";
  }
  return normalized;
}

function normalizeMachineSource(value: unknown): DesktopMachineSource | "" {
  if (value === "darwinIOPlatformUUID" || value === "windowsMachineGuid" || value === "unavailable") {
    return value;
  }
  return "";
}

function hashParts(namespace: string, parts: string[]) {
  const hash = createHash("sha256");
  hash.update(namespace);
  for (const part of parts) {
    hash.update("\0");
    hash.update(part);
  }
  return hash.digest("hex");
}

function uuidFromHashHex(hex: string) {
  const chars = hex.slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const normalized = chars.join("");
  return [
    normalized.slice(0, 8),
    normalized.slice(8, 12),
    normalized.slice(12, 16),
    normalized.slice(16, 20),
    normalized.slice(20, 32)
  ].join("-");
}

function deriveMachineHash(platform: NodeJS.Platform, machineId: string) {
  return hashParts(MACHINE_HASH_NAMESPACE, [platform, machineId]);
}

function deriveDeviceId(platform: NodeJS.Platform, machineId: string, installId: string) {
  return uuidFromHashHex(hashParts(DEVICE_ID_HASH_NAMESPACE, [platform, machineId, installId]));
}

function createUnavailableMachineIdentity(): DesktopMachineIdentity {
  return {
    machineId: UNAVAILABLE_MACHINE_ID,
    source: "unavailable"
  };
}

function parseDarwinIOPlatformUUID(output: string) {
  const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/u.exec(output);
  return normalizeSystemMachineId(match?.[1]);
}

function parseWindowsMachineGuid(output: string) {
  const match = /\bMachineGuid\s+REG_\w+\s+([^\r\n]+)/iu.exec(output);
  return normalizeSystemMachineId(match?.[1]);
}

function readDarwinMachineIdentity(execFile: ExecFileSyncLike): DesktopMachineIdentity | null {
  try {
    const output = execFile("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_500
    });
    const machineId = parseDarwinIOPlatformUUID(String(output));
    return machineId ? { machineId, source: "darwinIOPlatformUUID" } : null;
  } catch {
    return null;
  }
}

function readWindowsMachineIdentity(execFile: ExecFileSyncLike): DesktopMachineIdentity | null {
  try {
    const output = execFile("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_500,
      windowsHide: true
    });
    const machineId = parseWindowsMachineGuid(String(output));
    return machineId ? { machineId, source: "windowsMachineGuid" } : null;
  } catch {
    return null;
  }
}

function readPlatformMachineIdentity(
  platform: NodeJS.Platform = process.platform,
  execFile: ExecFileSyncLike = execFileSync
): DesktopMachineIdentity {
  if (platform === "darwin") {
    return readDarwinMachineIdentity(execFile) ?? createUnavailableMachineIdentity();
  }
  if (platform === "win32") {
    return readWindowsMachineIdentity(execFile) ?? createUnavailableMachineIdentity();
  }
  return createUnavailableMachineIdentity();
}

function readDesktopDeviceIdentityFile(identityPath: string): DesktopDeviceIdentity | null {
  if (!fs.existsSync(identityPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(identityPath, "utf8")) as Partial<DesktopDeviceIdentity>;
    if (parsed.version !== DEVICE_IDENTITY_VERSION ||
      !isValidUuid(parsed.installId) ||
      !isValidUuid(parsed.deviceId) ||
      !isValidSha256Hex(parsed.machineHash)) {
      return null;
    }

    const machineSource = normalizeMachineSource(parsed.machineSource);
    if (!machineSource) {
      return null;
    }

    const createdAt = readText(parsed.createdAt) || new Date().toISOString();
    const updatedAt = readText(parsed.updatedAt) || createdAt;
    const lastMachineMismatchAt = readText(parsed.lastMachineMismatchAt);
    const identity: DesktopDeviceIdentity = {
      version: DEVICE_IDENTITY_VERSION,
      installId: normalizeUuid(parsed.installId),
      deviceId: normalizeUuid(parsed.deviceId),
      machineHash: parsed.machineHash.trim().toLowerCase(),
      machineSource,
      createdAt,
      updatedAt
    };
    if (lastMachineMismatchAt) {
      identity.lastMachineMismatchAt = lastMachineMismatchAt;
    }
    return identity;
  } catch {
    // Corrupt or legacy identity files are replaced below with a v2 identity.
  }
  return null;
}

function writeDesktopDeviceIdentity(identityPath: string, identity: DesktopDeviceIdentity) {
  fs.mkdirSync(path.dirname(identityPath), { recursive: true });
  fs.writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
}

function cloneDesktopDeviceIdentity(identity: DesktopDeviceIdentity): DesktopDeviceIdentity {
  return { ...identity };
}

function cacheDesktopDeviceIdentity(identityPath: string, identity: DesktopDeviceIdentity) {
  const cached = cloneDesktopDeviceIdentity(identity);
  cachedDeviceIdentities.set(identityPath, cached);
  return cloneDesktopDeviceIdentity(cached);
}

function clearDesktopDeviceIdentityCache(identityPath?: string) {
  if (identityPath) {
    cachedDeviceIdentities.delete(identityPath);
    return;
  }
  cachedDeviceIdentities.clear();
}

function buildDesktopDeviceIdentity(input: {
  platform: NodeJS.Platform;
  installId: string;
  machineIdentity: DesktopMachineIdentity;
  createdAt: string;
  updatedAt: string;
  lastMachineMismatchAt?: string;
}): DesktopDeviceIdentity {
  const installId = normalizeUuid(input.installId);
  const normalizedMachineId = input.machineIdentity.source === "unavailable"
    ? UNAVAILABLE_MACHINE_ID
    : normalizeSystemMachineId(input.machineIdentity.machineId);
  const machineId = normalizedMachineId || UNAVAILABLE_MACHINE_ID;
  const machineSource = normalizedMachineId ? input.machineIdentity.source : "unavailable";
  const identity: DesktopDeviceIdentity = {
    version: DEVICE_IDENTITY_VERSION,
    installId,
    deviceId: deriveDeviceId(input.platform, machineId, installId),
    machineHash: deriveMachineHash(input.platform, machineId),
    machineSource,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt
  };
  if (input.lastMachineMismatchAt) {
    identity.lastMachineMismatchAt = input.lastMachineMismatchAt;
  }
  return identity;
}

function hasCurrentMachineBinding(identity: DesktopDeviceIdentity, expected: DesktopDeviceIdentity) {
  return identity.deviceId === expected.deviceId &&
    identity.machineHash === expected.machineHash &&
    identity.machineSource === expected.machineSource;
}

export function getDesktopDeviceIdentityPath(app: App) {
  return path.join(getDesktopConfigRoot(app), DEVICE_IDENTITY_FILE);
}

export function getDesktopDeviceIdentity(
  app: App,
  options: DesktopDeviceIdentityOptions = {}
): DesktopDeviceIdentity {
  const identityPath = getDesktopDeviceIdentityPath(app);
  const cachedIdentity = cachedDeviceIdentities.get(identityPath);
  if (cachedIdentity) {
    return cloneDesktopDeviceIdentity(cachedIdentity);
  }
  const platform = options.platform ?? process.platform;
  const now = (options.now ?? (() => new Date()))().toISOString();
  const machineIdentity = options.readMachineIdentity?.(platform) ?? readPlatformMachineIdentity(platform);
  const existing = readDesktopDeviceIdentityFile(identityPath);
  if (existing) {
    if (machineIdentity.source === "unavailable" && existing.machineSource !== "unavailable") {
      console.warn(
        "[device-identity] system machine identity is unavailable; preserving the stored process identity"
      );
      return cacheDesktopDeviceIdentity(identityPath, existing);
    }
    const expected = buildDesktopDeviceIdentity({
      platform,
      installId: existing.installId,
      machineIdentity,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
      lastMachineMismatchAt: existing.lastMachineMismatchAt
    });
    if (hasCurrentMachineBinding(existing, expected)) {
      return cacheDesktopDeviceIdentity(identityPath, existing);
    }

    const rebound = buildDesktopDeviceIdentity({
      platform,
      installId: existing.installId,
      machineIdentity,
      createdAt: existing.createdAt,
      updatedAt: now,
      lastMachineMismatchAt: now
    });
    console.warn(
      "[device-identity] confirmed a system machine identity change during process identity initialization; rebinding the Desktop device identity"
    );
    writeDesktopDeviceIdentity(identityPath, rebound);
    return cacheDesktopDeviceIdentity(identityPath, rebound);
  }

  const installId = options.randomUUID?.() ?? randomUUID();
  const identity: DesktopDeviceIdentity = {
    ...buildDesktopDeviceIdentity({
      platform,
      installId: isValidUuid(installId) ? installId : randomUUID(),
      machineIdentity,
      createdAt: now,
      updatedAt: now
    })
  };
  if (machineIdentity.source === "unavailable") {
    console.warn(
      "[device-identity] system machine identity is unavailable; using a process-stable fallback identity"
    );
  }
  writeDesktopDeviceIdentity(identityPath, identity);
  return cacheDesktopDeviceIdentity(identityPath, identity);
}

export function getDesktopDeviceId(app: App, options: DesktopDeviceIdentityOptions = {}) {
  return getDesktopDeviceIdentity(app, options).deviceId;
}

export function getDesktopDeviceIdentityInfo(
  app: App,
  options: DesktopDeviceIdentityOptions = {}
): DesktopDeviceIdentityInfo {
  const identity = getDesktopDeviceIdentity(app, options);
  const info: DesktopDeviceIdentityInfo = {
    identityPath: getDesktopDeviceIdentityPath(app),
    version: identity.version,
    installId: identity.installId,
    deviceId: identity.deviceId,
    machineHash: identity.machineHash,
    machineSource: identity.machineSource,
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt
  };
  if (identity.lastMachineMismatchAt) {
    info.lastMachineMismatchAt = identity.lastMachineMismatchAt;
  }
  return info;
}

export const __testInternals = {
  DEVICE_IDENTITY_FILE,
  DEVICE_IDENTITY_VERSION,
  UNAVAILABLE_MACHINE_ID,
  buildDesktopDeviceIdentity,
  deriveDeviceId,
  deriveMachineHash,
  isValidUuid,
  parseDarwinIOPlatformUUID,
  parseWindowsMachineGuid,
  readDesktopDeviceIdentityFile,
  readPlatformMachineIdentity,
  clearDesktopDeviceIdentityCache
};
