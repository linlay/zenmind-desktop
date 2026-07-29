import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ShutdownReport } from "../../shared/shutdown";

export const INSTALLER_SHUTDOWN_ACK_ARG_PREFIX = "--desktop-shutdown-ack=";

export type ShutdownAckStatus = "OK" | "FAILED" | "NO_PRIMARY";

export type InstallerShutdownRequest = {
  requested: boolean;
  ackPath: string | null;
};

function normalizeForComparison(value: string, platform: NodeJS.Platform | string) {
  const normalized = path.resolve(value);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function safePrefix(storageNamespace: string) {
  return storageNamespace.trim().replace(/[^a-zA-Z0-9._-]+/gu, "-");
}

export function validateShutdownAckPath(
  candidate: string,
  storageNamespace: string,
  options: {
    platform?: NodeJS.Platform | string;
    tempDir?: string;
  } = {}
) {
  const platform = options.platform ?? process.platform;
  const tempDir = options.tempDir ?? os.tmpdir();
  const resolved = path.resolve(candidate.trim());
  const expectedDirectory = normalizeForComparison(tempDir, platform);
  const actualDirectory = normalizeForComparison(path.dirname(resolved), platform);
  const basename = path.basename(resolved);
  const prefix = `${safePrefix(storageNamespace)}-shutdown-`;

  if (
    !candidate.trim() ||
    actualDirectory !== expectedDirectory ||
    !basename.startsWith(prefix) ||
    !basename.endsWith(".status") ||
    basename.length > 180
  ) {
    return null;
  }
  return resolved;
}

export function parseInstallerShutdownRequest(
  commandLine: string[],
  installerShutdownArgs: ReadonlySet<string>,
  storageNamespace: string,
  options: {
    platform?: NodeJS.Platform | string;
    tempDir?: string;
  } = {}
): InstallerShutdownRequest {
  const requested = commandLine.some((arg) => installerShutdownArgs.has(arg));
  if (!requested) {
    return { requested: false, ackPath: null };
  }
  const rawAckPath = commandLine
    .find((arg) => arg.startsWith(INSTALLER_SHUTDOWN_ACK_ARG_PREFIX))
    ?.slice(INSTALLER_SHUTDOWN_ACK_ARG_PREFIX.length) ?? "";
  return {
    requested: true,
    ackPath: validateShutdownAckPath(rawAckPath, storageNamespace, options)
  };
}

export function writeShutdownAck(
  ackPath: string,
  status: ShutdownAckStatus,
  report: ShutdownReport
) {
  const tempPath = `${ackPath}.${process.pid}.${randomUUID()}.tmp`;
  const contents = `${status}\n${JSON.stringify(report)}\n`;
  fs.writeFileSync(tempPath, contents, { encoding: "utf8", mode: 0o600 });
  try {
    fs.renameSync(tempPath, ackPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

export function createNoPrimaryShutdownReport(): ShutdownReport {
  return {
    mode: "installer",
    ok: true,
    timedOut: false,
    elapsedMs: 0,
    failures: [],
    survivors: []
  };
}
