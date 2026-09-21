import { type App } from "electron";
import JSZip from "jszip";
import path from "node:path";

export type EnvRootConflictDecision = "migrate" | "keep" | "cancel";

export type AppPathReader = Pick<App, "getPath">;

export type AppVersionReader = Partial<Pick<App, "getAppPath" | "getVersion">>;

export type AppPackageReader = Partial<Pick<App, "getAppPath" | "isPackaged">>;

export type EnvZipEntry = {
  relativePath: string;
  directory: boolean;
  entry: JSZip.JSZipObject;
};

export type EnvZipImportResult = {
  targetRoot: string;
  copiedFiles: number;
  skippedFiles: number;
  overwrittenFiles: number;
  createdDirectories: number;
};

export type InitialEnvPackageSource = "manual" | "bundled" | "reset";

export type InitialEnvPackageManifest = {
  schemaVersion: 1;
  source: InitialEnvPackageSource;
  sourcePath: string;
  desktopVersion: string;
  sha256: string;
  size: number;
  storedAt: string;
  envZipRelativePath: string;
};

export type InitialEnvPackageRecord = {
  relativePath: string;
  manifestRelativePath: string;
  sha256: string;
  source: InitialEnvPackageSource;
  storedAt: string;
};

export type BundledEnvZipImportResult = EnvZipImportResult & {
  sourceZipPath: string;
};

export type ValidatedBundledEnvUpgradeInput = {
  sourceZipPath: string;
  previousSourceZipPath?: string;
  desktopVersion: string;
  sha256: string;
  size: number;
  desktopInit: Record<string, unknown>;
  providerRegister?: string;
};

export type RuntimeEnvResetResult = BundledEnvZipImportResult & {
  backupPath?: string;
};

export type RuntimeEnvResetFailure = Error & {
  runtimeRoot?: string;
  backupPath?: string;
  sourceZipPath?: string;
};

export const ENV_RUNTIME_DIRS = ["agents", "registries", "teams", "chats", "skills-center", "tools"] as const;

export const REMOVED_SKILLS_MARKET_DIR_NAME = "skills-market";

export const ENV_IMPORT_MARKER_RELATIVE_PATH = path.join(".desktop", "state", "desktop", "env-bootstrap.json");

export const ENV_AGENT_DEFINITION_FILE_NAME = "agent.yml";

export const BUNDLED_ENV_RESOURCES_DIR_NAME = "env";

export const ENV_ZIP_FILE_NAME = "env.zip";

export const ENV_ZIP_MANIFEST_FILE_NAME = "manifest.json";

export const ENV_INITIAL_DATA_RELATIVE_DIR = path.join(".desktop", "data", "env-initial");

export const ENV_INITIAL_PACKAGE_RELATIVE_PATH = path.join(ENV_INITIAL_DATA_RELATIVE_DIR, ENV_ZIP_FILE_NAME);

export const ENV_INITIAL_MANIFEST_FILE_NAME = "manifest.json";

export const ENV_INITIAL_MANIFEST_RELATIVE_PATH = path.join(ENV_INITIAL_DATA_RELATIVE_DIR, ENV_INITIAL_MANIFEST_FILE_NAME);

export const VERSION_FILE_NAME = "VERSION";

export const ENV_ZIP_ROOT_DIR_NAME = "env";

export type BundledEnvManifest = {
  bundled: boolean;
  fileName: string | null;
  version?: string;
  size?: number;
  sha256?: string;
};

export type BundledEnvPackage = {
  zipPath: string;
  manifest?: BundledEnvManifest;
};
