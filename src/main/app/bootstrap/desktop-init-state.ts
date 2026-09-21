import { type App } from "electron";
import { type WebEntryKey } from "../../../shared/contracts";
import fs from "node:fs";
import path from "node:path";
import { getDesktopStateRoot, getDesktopConfigRoot } from "../../infrastructure/filesystem/user-paths";
import { resolveRuntimeRoot } from "../../infrastructure/filesystem/runtime-environment";

export const DESKTOP_INIT_FILE = "desktop-init.json";

export const DESKTOP_INIT_ASSISTANT_FILE = "assistant.json";

export const DESKTOP_INIT_BOOTSTRAP_STATE_FILE = "bootstrap.json";

export type AppPathReader = Pick<App, "getPath">;

export type BootstrapSectionResult = "applied" | "absent" | "failed" | "preserved";

export type BootstrapAssistantResult = "recorded" | "absent" | "failed";

export type BootstrapApplyResult = {
  profile: BootstrapSectionResult;
  kanban: BootstrapSectionResult;
  pet: BootstrapSectionResult;
  market: BootstrapSectionResult;
  updates: BootstrapSectionResult;
  sso: BootstrapSectionResult;
  tunnelHub: BootstrapSectionResult;
  webs: BootstrapSectionResult;
  assistant: BootstrapAssistantResult;
  desktopActionBridge: BootstrapSectionResult;
  enterpriseIm: BootstrapSectionResult;
  help: BootstrapSectionResult;
  services: BootstrapSectionResult;
};

export type BootstrapSiteItemResult = {
  entryKey: WebEntryKey;
  status: "installed" | "skipped";
  message?: string;
};

export type BootstrapWebsReport = {
  mode: "initialize" | "preserve";
  items: BootstrapSiteItemResult[];
  warnings: string[];
};

export type DesktopInitBootstrapState = {
  schemaVersion: 2;
  appliedAt: string;
  sourcePath: string;
  consumed: boolean;
  appliedResult: BootstrapApplyResult;
  failedSections: string[];
  errors: Record<string, string>;
  websReport: BootstrapWebsReport;
};

export type DesktopInitAssistantDefaults = {
  defaultChatAgentKey?: string;
  bootstrapAgentKey?: string;
  bootstrapChatId?: string;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function isValidHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return Boolean(parsed.host) && (parsed.protocol === "http:" || parsed.protocol === "https:");
  } catch {
    return false;
  }
}

export function isLoopbackHost(hostname: string) {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

export function isValidRelayUrl(value: string) {
  try {
    const parsed = new URL(value);
    if (!parsed.host) {
      return false;
    }
    if (parsed.protocol === "wss:") {
      return true;
    }
    return parsed.protocol === "ws:" && isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

export function isPlaceholderUrl(value: string) {
  return !value || value === "http://" || value === "https://" || value === "ws://" || value === "wss://";
}

export function readJsonFile(filePath: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function writeJsonFile(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function writeBootstrapState(
  app: App,
  state: DesktopInitBootstrapState,
  platform: NodeJS.Platform = process.platform
) {
  writeJsonFile(path.join(getDesktopStateRoot(app, platform), DESKTOP_INIT_BOOTSTRAP_STATE_FILE), state);
}

export function removeDesktopInitFile(initPath: string) {
  try {
    fs.rmSync(initPath, { force: true });
  } catch (error) {
    console.warn(`[desktop-init] failed to remove consumed ${DESKTOP_INIT_FILE}:`, error);
  }
}

export function removeDesktopInitSitesStaging(initPath: string) {
  const desktopInitDir = path.join(path.dirname(initPath), "desktop-init");
  const sitesDir = path.join(desktopInitDir, "sites");
  try {
    fs.rmSync(sitesDir, { recursive: true, force: true });
    if (fs.existsSync(desktopInitDir) && fs.readdirSync(desktopInitDir).length === 0) {
      fs.rmdirSync(desktopInitDir);
    }
  } catch (error) {
    console.warn("[desktop-init] failed to remove consumed Sites staging:", error);
  }
}

export function pathApiForRuntimeRoot(platform: NodeJS.Platform, runtimeRoot: string) {
  if (platform === "win32") {
    // Cross-platform tests inject POSIX temp directories while simulating Windows behavior.
    if (path.posix.isAbsolute(runtimeRoot)) {
      return path.posix;
    }
    return path.win32;
  }
  if (platform === "darwin") {
    if (path.win32.isAbsolute(runtimeRoot) && !path.posix.isAbsolute(runtimeRoot)) {
      return path.win32;
    }
    return path.posix;
  }
  return path.posix;
}

export function writeAssistantDefaults(
  app: App,
  assistantDefaults: DesktopInitAssistantDefaults | null,
  platform: NodeJS.Platform = process.platform
): BootstrapAssistantResult {
  if (!assistantDefaults) {
    return "absent";
  }
  writeJsonFile(path.join(getDesktopConfigRoot(app, platform), DESKTOP_INIT_ASSISTANT_FILE), {
    schemaVersion: 1,
    ...assistantDefaults
  });
  return "recorded";
}

export function resolveDesktopInitPath(app: AppPathReader, platform: NodeJS.Platform = process.platform) {
  const runtimeRoot = resolveRuntimeRoot(app, platform);
  const pathApi = pathApiForRuntimeRoot(platform, runtimeRoot);
  return pathApi.join(runtimeRoot, DESKTOP_INIT_FILE);
}

export function runBootstrapSection<T extends string>(
  sectionId: keyof BootstrapApplyResult,
  errors: Record<string, string>,
  apply: () => T
) {
  try {
    return apply();
  } catch (error) {
    const message = errorMessage(error);
    errors[sectionId] = message;
    console.warn(`[desktop-init] failed to apply ${String(sectionId)} defaults:`, error);
    return "failed" as const;
  }
}

export function getFailedSections(result: BootstrapApplyResult) {
  return Object.entries(result)
    .filter(([, status]) => status === "failed")
    .map(([sectionId]) => sectionId);
}
