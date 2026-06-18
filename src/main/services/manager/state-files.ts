import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { ServiceId } from "../../../shared/contracts";
import { getDesktopStateRoot } from "../../user-paths";
import {
  getInitializationStatePath,
  type ServiceLayout
} from "./layout";

export type InitializationState = {
  version: string;
  status: "succeeded" | "failed";
  updatedAt: string;
  lastError?: string;
  assetSignature?: string;
};

type LastRunningServicesState = {
  runningServiceIds: ServiceId[];
  updatedAt: string;
};

const LAST_RUNNING_SERVICES_FILE = "last-running-services.json";
export const INSTALL_ONLY_STARTUP_SERVICE_IDS = ["agent-container-hub"] as const;
export const OPTIONAL_AUTO_STARTUP_SERVICE_IDS = [] as const;
export const DEFAULT_STARTUP_SERVICE_IDS = ["identity-center", "agent-platform", "agent-webclient"] as const;
const REMOVED_STARTUP_SERVICE_IDS = ["tunnel-hub-agent"] as const;
const RESTORE_PRIORITY = ["agent-container-hub", "identity-center", "agent-platform", "agent-webclient"] as const;
const INSTALL_ONLY_STARTUP_SERVICE_ID_SET = new Set<ServiceId>(INSTALL_ONLY_STARTUP_SERVICE_IDS);
const OPTIONAL_AUTO_STARTUP_SERVICE_ID_SET = new Set<ServiceId>(OPTIONAL_AUTO_STARTUP_SERVICE_IDS);
const REMOVED_STARTUP_SERVICE_ID_SET = new Set<ServiceId>(REMOVED_STARTUP_SERVICE_IDS);
const NON_BLOCKING_RESTORE_SERVICE_ID_SET = new Set<ServiceId>([
  ...INSTALL_ONLY_STARTUP_SERVICE_IDS,
  ...OPTIONAL_AUTO_STARTUP_SERVICE_IDS
]);
const DEFAULT_STARTUP_SERVICE_ID_SET = new Set<ServiceId>(DEFAULT_STARTUP_SERVICE_IDS);

export function readInitializationState(layoutOrInstallDir: ServiceLayout | string): InitializationState | null {
  const filePath = getInitializationStatePath(layoutOrInstallDir);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const version = typeof parsed.version === "string" ? parsed.version : "";
    const status = parsed.status === "succeeded" || parsed.status === "failed" ? parsed.status : null;
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : "";
    const lastError = typeof parsed.lastError === "string" && parsed.lastError.trim() ? parsed.lastError : undefined;
    const assetSignature = typeof parsed.assetSignature === "string" && parsed.assetSignature.trim()
      ? parsed.assetSignature
      : undefined;
    if (!version || !status || !updatedAt) {
      return null;
    }
    return {
      version,
      status,
      updatedAt,
      ...(assetSignature ? { assetSignature } : {}),
      ...(lastError ? { lastError } : {})
    };
  } catch {
    return null;
  }
}

export function writeInitializationState(layoutOrInstallDir: ServiceLayout | string, state: InitializationState) {
  const filePath = getInitializationStatePath(layoutOrInstallDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function getLastRunningServicesStatePath(app: App) {
  return path.join(getDesktopStateRoot(app), LAST_RUNNING_SERVICES_FILE);
}

export function orderServiceIdsForRestore(serviceIds: ServiceId[]) {
  const priority = new Map<ServiceId, number>(RESTORE_PRIORITY.map((serviceId, index) => [serviceId, index]));
  return [...new Set(serviceIds)].sort((left, right) => {
    const leftPriority = priority.get(left) ?? RESTORE_PRIORITY.length;
    const rightPriority = priority.get(right) ?? RESTORE_PRIORITY.length;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    return left.localeCompare(right);
  });
}

export function getDefaultStartupServiceIds() {
  return [...DEFAULT_STARTUP_SERVICE_IDS];
}

export function getServiceIdsToRestore(app: App) {
  return orderServiceIdsForRestore([
    ...getDefaultStartupServiceIds(),
    ...readLastRunningServices(app).filter((serviceId) =>
      !INSTALL_ONLY_STARTUP_SERVICE_ID_SET.has(serviceId) &&
      !OPTIONAL_AUTO_STARTUP_SERVICE_ID_SET.has(serviceId) &&
      !REMOVED_STARTUP_SERVICE_ID_SET.has(serviceId)
    )
  ]);
}

export function getOptionalServiceIdsToRestore(app: App) {
  return orderServiceIdsForRestore(
    readLastRunningServices(app).filter((serviceId) =>
      !DEFAULT_STARTUP_SERVICE_ID_SET.has(serviceId) &&
      !INSTALL_ONLY_STARTUP_SERVICE_ID_SET.has(serviceId) &&
      !OPTIONAL_AUTO_STARTUP_SERVICE_ID_SET.has(serviceId) &&
      !REMOVED_STARTUP_SERVICE_ID_SET.has(serviceId)
    )
  );
}

export function isNonBlockingRestoreFailure(serviceId: ServiceId) {
  return NON_BLOCKING_RESTORE_SERVICE_ID_SET.has(serviceId);
}

export function readLastRunningServices(app: App): ServiceId[] {
  const filePath = getLastRunningServicesStatePath(app);
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const runningServiceIds = Array.isArray(parsed.runningServiceIds)
      ? parsed.runningServiceIds.filter((value): value is ServiceId => typeof value === "string" && value.trim().length > 0)
      : [];
    return orderServiceIdsForRestore(runningServiceIds);
  } catch {
    return [];
  }
}

export function writeLastRunningServices(app: App, serviceIds: ServiceId[]) {
  const filePath = getLastRunningServicesStatePath(app);
  const state: LastRunningServicesState = {
    runningServiceIds: orderServiceIdsForRestore(serviceIds),
    updatedAt: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
