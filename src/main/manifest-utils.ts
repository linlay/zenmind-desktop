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
  ManifestDesktopBridge,
  ManifestEnvBinding,
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
    envBindings: ManifestEnvBinding[];
    bridge?: ManifestDesktopBridge;
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

type CorePortEnvBinding = {
  key: string;
  value: string;
  defaults: string[];
};

type CoreServicePortOverride = {
  portEnvKey: string;
  defaultPort: number;
  portBindings: CorePortEnvBinding[];
  urlBindingDefaults?: Record<string, string[]>;
};

const sharedCoreServicePortOverrides: Record<string, CoreServicePortOverride> = {
  "agent-container-hub": {
    portEnvKey: "BIND_ADDR",
    defaultPort: 7079,
    portBindings: [
      {
        key: "BIND_ADDR",
        value: "127.0.0.1:{{serviceDefaultPort}}",
        defaults: ["", "127.0.0.1:11960", "localhost:11960", "127.0.0.1:117079", "localhost:117079"]
      }
    ]
  },
  "agent-platform": {
    portEnvKey: "HOST_PORT",
    defaultPort: 7078,
    portBindings: [
      {
        key: "HOST_PORT",
        value: "{{serviceDefaultPort}}",
        defaults: ["", "11949", "18081", "7200", "117078"]
      },
      {
        key: "SERVER_PORT",
        value: "{{serviceDefaultPort}}",
        defaults: ["", "11949", "18081", "7200", "117078"]
      }
    ],
    urlBindingDefaults: {
      CONTAINER_HUB_BASE_URL: [
        "",
        "http://127.0.0.1:7079",
        "http://localhost:7079",
        "http://127.0.0.1:11960",
        "http://localhost:11960",
        "http://host.docker.internal:11960",
        "http://127.0.0.1:117079",
        "http://localhost:117079",
        "http://host.docker.internal:117079"
      ]
    }
  },
  "agent-webclient": {
    portEnvKey: "PORT",
    defaultPort: 7080,
    portBindings: [
      {
        key: "PORT",
        value: "{{serviceDefaultPort}}",
        defaults: ["", "11948", "18082", "117080"]
      }
    ],
    urlBindingDefaults: {
      BASE_URL: [
        "",
        "http://127.0.0.1:7078",
        "http://localhost:7078",
        "http://127.0.0.1:11949",
        "http://localhost:11949",
        "http://127.0.0.1:18081",
        "http://localhost:18081",
        "http://127.0.0.1:117078",
        "http://localhost:117078",
        "http://127.0.0.1:7200",
        "http://localhost:7200",
        "http://127.0.0.1:7000",
        "http://localhost:7000"
      ],
      WS_BASE_URL: [
        "",
        "http://127.0.0.1:7078",
        "http://localhost:7078",
        "http://127.0.0.1:11949",
        "http://localhost:11949",
        "http://127.0.0.1:18081",
        "http://localhost:18081",
        "http://127.0.0.1:117078",
        "http://localhost:117078",
        "http://127.0.0.1:7200",
        "http://localhost:7200",
        "http://127.0.0.1:7000",
        "http://localhost:7000"
      ],
      VOICE_BASE_URL: [
        "",
        "http://127.0.0.1:7078",
        "http://localhost:7078",
        "http://127.0.0.1:11949",
        "http://localhost:11949",
        "http://127.0.0.1:18081",
        "http://localhost:18081",
        "http://127.0.0.1:117078",
        "http://localhost:117078",
        "http://127.0.0.1:11953",
        "http://localhost:11953"
      ]
    }
  },
  "zenmind-app-server": {
    portEnvKey: "SERVER_PORT",
    defaultPort: 7076,
    portBindings: [
      {
        key: "SERVER_PORT",
        value: "{{serviceDefaultPort}}",
        defaults: ["", "11950", "18080", "9000", "117076"]
      }
    ]
  }
};

function getCoreServicePortOverrides(): Record<string, CoreServicePortOverride> {
  // The defaults are currently shared, but builtin service manifests are platform-specific.
  if (process.platform === "win32") {
    return sharedCoreServicePortOverrides;
  }

  if (process.platform === "darwin") {
    return sharedCoreServicePortOverrides;
  }

  return sharedCoreServicePortOverrides;
}

function getCoreServicePortOverride(serviceId: string) {
  return getCoreServicePortOverrides()[serviceId];
}

function mergeStringList(left: readonly string[] = [], right: readonly string[] = []) {
  return [...new Set([...left, ...right])];
}

function applyCoreServiceWebOverride(serviceId: string, web: ManifestWeb) {
  const override = getCoreServicePortOverride(serviceId);
  if (!override) {
    return web;
  }

  return {
    ...web,
    portEnvKey: override.portEnvKey,
    defaultPort: override.defaultPort
  } satisfies ManifestWeb;
}

function applyCoreServiceEnvBindingOverrides(serviceId: string, envBindings: ManifestEnvBinding[]) {
  const override = getCoreServicePortOverride(serviceId);
  if (!override) {
    return envBindings;
  }

  const portBindingsByKey = new Map(override.portBindings.map((binding) => [binding.key, binding]));
  const seenPortBindings = new Set<string>();
  const nextBindings = envBindings.map((binding) => {
    const portBinding = portBindingsByKey.get(binding.key);
    if (portBinding) {
      seenPortBindings.add(binding.key);
      return {
        ...binding,
        value: portBinding.value,
        onlyIfDefault: true,
        defaults: mergeStringList(binding.defaults, portBinding.defaults)
      } satisfies ManifestEnvBinding;
    }

    const urlDefaults = override.urlBindingDefaults?.[binding.key];
    if (urlDefaults) {
      return {
        ...binding,
        onlyIfDefault: true,
        defaults: mergeStringList(binding.defaults, urlDefaults)
      } satisfies ManifestEnvBinding;
    }

    return binding;
  });

  for (const binding of override.portBindings) {
    if (seenPortBindings.has(binding.key)) {
      continue;
    }
    nextBindings.push({
      key: binding.key,
      value: binding.value,
      onlyIfDefault: true,
      defaults: binding.defaults
    });
  }

  return nextBindings;
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

const agentPlatformDesktopConfigFiles: ManifestConfigFile[] = [
  {
    key: "container-hub",
    label: "configs/container-hub.yml",
    relativePath: "configs/container-hub.yml",
    templateRelativePath: "configs/container-hub.example.yml",
    required: false
  },
  {
    key: "bash",
    label: "configs/bash.yml",
    relativePath: "configs/bash.yml",
    templateRelativePath: "configs/bash.example.yml",
    required: false
  },
  {
    key: "file-tools",
    label: "configs/file-tools.yml",
    relativePath: "configs/file-tools.yml",
    templateRelativePath: "configs/file-tools.example.yml",
    required: false
  },
  {
    key: "cors",
    label: "configs/cors.yml",
    relativePath: "configs/cors.yml",
    templateRelativePath: "configs/cors.example.yml",
    required: false
  },
  {
    key: "prompts",
    label: "configs/prompts.yml",
    relativePath: "configs/prompts.yml",
    templateRelativePath: "configs/prompts.example.yml",
    required: false
  },
  {
    key: "channels",
    label: "configs/channels.yml",
    relativePath: "configs/channels.yml",
    templateRelativePath: "configs/channels.example.yml",
    required: false
  }
];

function resolveServiceConfigFiles(raw: Record<string, unknown>, serviceId: string) {
  const configFiles = resolveConfigFiles(raw);
  if (serviceId !== "agent-platform") {
    return configFiles;
  }

  const existingKeys = new Set(configFiles.map((configFile) => configFile.key));
  const existingPaths = new Set(configFiles.map((configFile) => configFile.relativePath));
  const missingConfigFiles = agentPlatformDesktopConfigFiles.filter(
    (configFile) => !existingKeys.has(configFile.key) && !existingPaths.has(configFile.relativePath)
  );

  return missingConfigFiles.length > 0 ? [...configFiles, ...missingConfigFiles] : configFiles;
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

function resolveEnvBindings(raw: Record<string, unknown>): ManifestEnvBinding[] {
  const desktop = asObject(raw.desktop);
  if (!Array.isArray(desktop.envBindings)) {
    return [];
  }
  const result: ManifestEnvBinding[] = [];
  for (const item of desktop.envBindings) {
    const binding = asObject(item);
    const key = asString(binding.key).trim();
    if (!key) continue;
    const entry: ManifestEnvBinding = { key };
    const value = asOptionalString(binding.value);
    if (value !== undefined) entry.value = value;
    const fromService = asOptionalString(binding.fromService);
    if (fromService !== undefined) entry.fromService = fromService;
    const template = asOptionalString(binding.template);
    if (template !== undefined) entry.template = template;
    const onlyIfDefault = asBoolean(binding.onlyIfDefault);
    if (onlyIfDefault !== undefined) entry.onlyIfDefault = onlyIfDefault;
    if (Array.isArray(binding.defaults)) {
      entry.defaults = binding.defaults.filter((d): d is string => typeof d === "string");
    }
    result.push(entry);
  }
  return result;
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
  const envBindings = resolveEnvBindings(raw);

  const bridgeRaw = asObject(desktop.bridge);
  const bridge: ManifestDesktopBridge | undefined = bridgeRaw.category === "bridge"
    ? {
        category: "bridge" as const,
        channelId: asString(bridgeRaw.channelId),
        channelName: asString(bridgeRaw.channelName),
        gatewayInfoEndpoint: asString(bridgeRaw.gatewayInfoEndpoint)
      }
    : undefined;

  return {
    assetFileName,
    bundleTopLevelDir,
    envBindings,
    bridge
  } satisfies ManifestDesktop & { bundleTopLevelDir: string; envBindings: ManifestEnvBinding[]; bridge?: ManifestDesktopBridge };
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
  const web = applyCoreServiceWebOverride(id, resolveWeb(raw));
  const envBindings = applyCoreServiceEnvBindingOverrides(id, desktop.envBindings);

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
    configFiles: resolveServiceConfigFiles(raw, id),
    runtime,
    web,
    prerequisites: asStringArray(raw.prerequisites),
    desktop: {
      ...desktop,
      envBindings
    },
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
