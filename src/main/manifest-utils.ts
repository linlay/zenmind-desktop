import fs from "node:fs";
import path from "node:path";
import type {
  FrontendMode,
  Manifest,
  ManifestApi,
  ManifestBackend,
  ManifestCommand,
  ManifestConfigFile,
  ManifestDesktop,
  ManifestFrontend,
  ManifestRuntime,
  ManifestScripts,
  ManifestWeb,
  ServiceId,
  ServiceKind
} from "../shared/contracts";
import { listArchiveEntries, readFileFromArchive } from "./archive-utils";

export interface ServiceImportTarget {
  key: string;
  label: string;
  relativePath: string;
  required: boolean;
}

export interface ServiceDefinition extends Manifest {
  id: ServiceId;
  description: string;
  frontend: ManifestFrontend & { mode: FrontendMode };
  frontendMode: FrontendMode;
  configFiles: ManifestConfigFile[];
  runtime: ManifestRuntime & {
    pidRelativePath: string;
    logRelativePath: string;
    errorLogRelativePath: string;
    requiredPaths: string[];
  };
  web: ManifestWeb;
  prerequisites: string[];
  desktop: ManifestDesktop & {
    bundleTopLevelDir: string;
  };
  assetFileName: string;
  bundleTopLevelDir: string;
  startCommand: string[];
  stopCommand: string[];
  deployCommand: string[] | null;
  importTargets: ServiceImportTarget[];
}

export interface NormalizeManifestOptions {
  defaultKind?: ServiceKind;
  desktop?: Partial<ManifestDesktop>;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function asOptionalString(value: unknown) {
  const next = asString(value).trim();
  return next ? next : undefined;
}

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function asBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isFrontendMode(value: unknown): value is FrontendMode {
  return value === "none" || value === "embedded" || value === "standalone";
}

function isServiceKind(value: unknown): value is ServiceKind {
  return value === "builtin" || value === "plugin";
}

function toManifestCommand(value: unknown): ManifestCommand | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }

  const parts = asStringArray(value);
  return parts.length > 0 ? parts : undefined;
}

function resolveFrontend(raw: Record<string, unknown>) {
  const frontend = asObject(raw.frontend);
  const legacyFrontendMode = raw.frontendMode;
  const legacyHasFrontend = raw.hasFrontend;
  const mode = isFrontendMode(frontend.mode)
    ? frontend.mode
    : isFrontendMode(legacyFrontendMode)
      ? legacyFrontendMode
      : legacyHasFrontend === true
        ? "standalone"
        : "none";

  return {
    mode,
    entry: asOptionalString(frontend.entry),
    assetsPrefix: asOptionalString(frontend.assetsPrefix),
    directAccess: asBoolean(frontend.directAccess),
    hostManaged: asBoolean(frontend.hostManaged),
    dist: asOptionalString(frontend.dist),
    index: asOptionalString(frontend.index),
    spa: asBoolean(frontend.spa)
  } satisfies ManifestFrontend;
}

function resolveScripts(raw: Record<string, unknown>) {
  const scripts = asObject(raw.scripts);
  const legacyRuntime = asObject(raw.runtime);

  const start = toManifestCommand(scripts.start ?? legacyRuntime.startCommand);
  const stop = toManifestCommand(scripts.stop ?? legacyRuntime.stopCommand);
  const deploy = toManifestCommand(scripts.deploy);

  if (!start || !stop) {
    throw new Error("manifest scripts.start/stop are required");
  }

  return {
    start,
    stop,
    deploy
  } satisfies ManifestScripts;
}

function resolveConfigFiles(raw: Record<string, unknown>) {
  if (!Array.isArray(raw.configFiles)) {
    return [];
  }

  return raw.configFiles.map((item) => {
    const config = asObject(item);
    return {
      key: asString(config.key),
      label: asString(config.label),
      relativePath: asString(config.relativePath),
      templateRelativePath: asOptionalString(config.templateRelativePath),
      required: config.required !== false
    } satisfies ManifestConfigFile;
  });
}

function resolveRuntime(raw: Record<string, unknown>) {
  const runtime = asObject(raw.runtime);
  return {
    pidRelativePath: asOptionalString(runtime.pidRelativePath) ?? "",
    logRelativePath: asOptionalString(runtime.logRelativePath) ?? "",
    errorLogRelativePath: asOptionalString(runtime.errorLogRelativePath) ?? "",
    requiredPaths: asStringArray(runtime.requiredPaths)
  } satisfies ManifestRuntime & {
    pidRelativePath: string;
    logRelativePath: string;
    errorLogRelativePath: string;
    requiredPaths: string[];
  };
}

function resolveApi(raw: Record<string, unknown>) {
  if (raw.api === undefined) {
    return undefined;
  }
  const api = asObject(raw.api);
  return {
    enabled: api.enabled !== false,
    adminBaseUrl: asOptionalString(api.adminBaseUrl),
    openidBaseUrl: asOptionalString(api.openidBaseUrl),
    oauth2BaseUrl: asOptionalString(api.oauth2BaseUrl)
  } satisfies ManifestApi;
}

function resolveBackend(raw: Record<string, unknown>) {
  if (raw.backend === undefined) {
    return undefined;
  }
  const backend = asObject(raw.backend);
  const entry = asOptionalString(backend.entry);
  return entry ? ({ entry } satisfies ManifestBackend) : undefined;
}

function resolveWeb(raw: Record<string, unknown>) {
  if (raw.web === undefined) {
    return {
      routePath: "",
      portEnvKey: "",
      defaultPort: 0
    } satisfies ManifestWeb;
  }

  const web = asObject(raw.web);
  return {
    routePath: asString(web.routePath),
    portEnvKey: asString(web.portEnvKey),
    defaultPort: asNumber(web.defaultPort) ?? 0
  } satisfies ManifestWeb;
}

function resolveDesktop(
  raw: Record<string, unknown>,
  options: NormalizeManifestOptions,
  serviceId: string
) {
  const desktop = asObject(raw.desktop);
  const assetFileName =
    options.desktop?.assetFileName ?? asOptionalString(desktop.assetFileName);
  const bundleTopLevelDir =
    options.desktop?.bundleTopLevelDir ??
    asOptionalString(desktop.bundleTopLevelDir) ??
    serviceId;

  return {
    assetFileName,
    bundleTopLevelDir,
    autoStart: asBoolean(desktop.autoStart)
  } satisfies ManifestDesktop & { bundleTopLevelDir: string };
}

function normalizeExecutable(entry: string) {
  if (path.isAbsolute(entry) || entry.startsWith("./") || entry.startsWith("../")) {
    return entry;
  }
  return `./${entry}`;
}

function resolveCommand(command: ManifestCommand | undefined) {
  if (!command) {
    return null;
  }

  const parts = Array.isArray(command) ? command : [command];
  if (parts.length === 0) {
    return null;
  }

  const [entry, ...args] = parts.map((part) => part.trim()).filter(Boolean);
  if (!entry) {
    return null;
  }

  return [normalizeExecutable(entry), ...args];
}

export function normalizeManifest(manifest: Manifest, options: NormalizeManifestOptions = {}): ServiceDefinition {
  const raw = asObject(manifest);
  const id = asOptionalString(raw.id);
  if (!id) {
    throw new Error("manifest id is required");
  }

  const scripts = resolveScripts(raw);
  const runtime = resolveRuntime(raw);
  const frontend = resolveFrontend(raw);
  const desktop = resolveDesktop(raw, options, id);

  return {
    id,
    name: asOptionalString(raw.name) ?? id,
    kind: isServiceKind(raw.kind) ? raw.kind : (options.defaultKind ?? "plugin"),
    version: asOptionalString(raw.version) ?? "",
    description: asOptionalString(raw.description) ?? "",
    platform:
      raw.platform === undefined
        ? undefined
        : {
            os: asString(asObject(raw.platform).os),
            arch: asString(asObject(raw.platform).arch)
          },
    frontend,
    frontendMode: frontend.mode,
    api: resolveApi(raw),
    backend: resolveBackend(raw),
    scripts,
    configFiles: resolveConfigFiles(raw),
    runtime,
    web: resolveWeb(raw),
    prerequisites: asStringArray(raw.prerequisites),
    desktop,
    assetFileName: desktop.assetFileName ?? "",
    bundleTopLevelDir: desktop.bundleTopLevelDir,
    startCommand: resolveCommand(scripts.start) ?? [],
    stopCommand: resolveCommand(scripts.stop) ?? [],
    deployCommand: resolveCommand(scripts.deploy),
    importTargets: []
  };
}

export function readManifestFile(manifestPath: string) {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
}

export function listTarEntries(archivePath: string) {
  return [...listArchiveEntries(archivePath)];
}

export function findManifestEntry(archivePath: string) {
  return listTarEntries(archivePath).find((entry) => entry.endsWith("/manifest.json") || entry === "manifest.json") ?? null;
}

export function readManifestFromArchive(archivePath: string) {
  const manifestEntry = findManifestEntry(archivePath);
  if (!manifestEntry) {
    throw new Error(`archive does not contain manifest.json: ${archivePath}`);
  }

  const manifestContent = readFileFromArchive(archivePath, manifestEntry);
  return JSON.parse(manifestContent) as Manifest;
}
