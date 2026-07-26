import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type {
  WebappBackendConfig,
  WebappContainerBackendConfig,
  WebappEntry,
  WebappFrontendConfig,
  WebappHealthConfig,
  WebappManagedBackendBase,
  WebappTarget
} from "../../../shared/contracts";
import { getDesktopWebappsDataRoot } from "../../user-paths";
import {
  createWebId,
  createWebappEntryKey,
  isRecord,
  normalizeAgentKey,
  normalizeWebId,
  normalizeWebsiteLabel,
  readString,
  readStringArray,
  readStringRecord,
  realpathInsideRoot,
  resolveWebappRelativePath,
  sortWebEntries,
  toIsoTimestamp,
  toTimestamp
} from "../common";
import { withWebappManagementMetadata } from "./metadata";

export const WEBAPP_FILE = "webapp.json";
export const WEBAPP_SCHEMA_VERSION = 4;
export const WEBAPP_LEGACY_CANONICAL_SCHEMA_VERSION = 3;
export const WEBAPP_JAVA_MIN_MAJOR = 21;
export const WEBAPP_TARGETS = [
  "universal",
  "darwin-arm64",
  "darwin-x64",
  "windows-arm64",
  "windows-x64"
] as const satisfies readonly WebappTarget[];

function normalizeSchemaVersion(value: unknown): 2 | 3 | 4 {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return parsed === 4 ? 4 : parsed === 3 ? 3 : 2;
}

export function getCurrentWebappTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): WebappTarget | "" {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    return `darwin-${arch}`;
  }
  if (platform === "win32" && (arch === "arm64" || arch === "x64")) {
    return `windows-${arch}`;
  }
  return "";
}

export function webappTargetMatchesCurrentPlatform(
  target: WebappTarget,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
) {
  return target === "universal" || target === getCurrentWebappTarget(platform, arch);
}

function normalizeTarget(value: unknown, schemaVersion: 2 | 3 | 4): WebappTarget {
  const target = readString(value);
  if (!target && schemaVersion < 4) {
    return "universal";
  }
  if (!(WEBAPP_TARGETS as readonly string[]).includes(target)) {
    throw new Error(`target must be one of: ${WEBAPP_TARGETS.join(", ")}.`);
  }
  return target as WebappTarget;
}

function normalizeVersion(value: unknown, schemaVersion: 2 | 3 | 4) {
  const version = readString(value);
  if (!version && schemaVersion < 4) {
    return "0.0.0";
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error("version must be a semantic version such as 1.0.0.");
  }
  return version;
}

function readCopilotAgentKey(value: Record<string, unknown>) {
  return normalizeAgentKey(readString(value.copilotAgentKey) || readString(value.agentKey));
}

function normalizePort(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return 0;
  }
  const port = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("backend.port must be an integer between 0 and 65535.");
  }
  return port;
}

function normalizeApiPrefix(value: unknown) {
  const raw = readString(value) || "/api";
  const prefixed = raw.startsWith("/") ? raw : `/${raw}`;
  return prefixed.replace(/\/+$/u, "") || "/api";
}

function normalizeHealthPath(value: unknown) {
  const raw = readString(value) || "/api/health";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

export function getWebappDir(app: App, id: string, platform: NodeJS.Platform = process.platform) {
  return path.join(getDesktopWebappsDataRoot(app, platform), normalizeWebId(id));
}

export function getWebappPath(app: App, id: string, platform: NodeJS.Platform = process.platform) {
  return path.join(getWebappDir(app, id, platform), WEBAPP_FILE);
}

function normalizeHealth(raw: unknown, schemaVersion: 2 | 3 | 4, legacyHealthPath: unknown): WebappHealthConfig {
  if (schemaVersion < 4) {
    return {
      type: "http",
      path: normalizeHealthPath(legacyHealthPath),
      timeoutMs: 10_000
    };
  }
  if (!isRecord(raw)) {
    throw new Error("backend.health is required for schema v4.");
  }
  const type = readString(raw.type);
  const timeoutMs = raw.timeoutMs === undefined
    ? 10_000
    : Number.parseInt(String(raw.timeoutMs), 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error("backend.health.timeoutMs must be between 1000 and 120000.");
  }
  if (type === "tcp") {
    return { type: "tcp", timeoutMs };
  }
  if (type !== "http") {
    throw new Error("backend.health.type must be http or tcp.");
  }
  const healthPath = readString(raw.path);
  if (!healthPath) {
    throw new Error("backend.health.path is required for HTTP health checks.");
  }
  return {
    type: "http",
    path: normalizeHealthPath(healthPath),
    timeoutMs
  };
}

function normalizeFrontend(
  raw: unknown,
  projectDir: string,
  schemaVersion: 2 | 3 | 4
): WebappFrontendConfig {
  const frontend = isRecord(raw) ? raw : {};
  const mode = schemaVersion === 4 ? readString(frontend.mode) : "static";
  if (mode === "proxy") {
    return { mode: "proxy" };
  }
  if (schemaVersion === 4 && mode !== "static") {
    throw new Error("frontend.mode must be static or proxy.");
  }
  const root = readString(frontend.root) || "frontend";
  const index = readString(frontend.index) || "index.html";
  const apiPrefix = normalizeApiPrefix(frontend.apiPrefix);
  const rootPath = resolveWebappRelativePath(projectDir, root);
  const rootRealPath = realpathInsideRoot(projectDir, rootPath);
  if (!fs.statSync(rootRealPath).isDirectory()) {
    throw new Error(`frontend.root is not a directory: ${root}`);
  }
  const indexPath = resolveWebappRelativePath(rootRealPath, index);
  const indexRealPath = realpathInsideRoot(rootRealPath, indexPath);
  if (!fs.statSync(indexRealPath).isFile()) {
    throw new Error(`frontend.index is not a file: ${index}`);
  }
  return {
    mode: "static",
    root,
    index,
    spa: frontend.spa === false ? false : true,
    apiPrefix
  };
}

function normalizeManagedBackend(
  backend: Record<string, unknown>,
  projectDir: string,
  schemaVersion: 2 | 3 | 4
): WebappManagedBackendBase {
  const entry = readString(backend.entry);
  if (!entry) {
    throw new Error("backend.entry is required.");
  }
  const entryPath = resolveWebappRelativePath(projectDir, entry);
  const entryRealPath = realpathInsideRoot(projectDir, entryPath);
  if (!fs.statSync(entryRealPath).isFile()) {
    throw new Error(`backend.entry is not a file: ${entry}`);
  }
  return {
    entry,
    args: readStringArray(backend.args),
    env: readStringRecord(backend.env),
    port: normalizePort(backend.port),
    health: normalizeHealth(backend.health, schemaVersion, backend.healthPath)
  };
}

function normalizeJvmArgs(value: unknown) {
  const args = readStringArray(value);
  const forbidden = new Set([
    "-jar",
    "-cp",
    "-classpath",
    "--class-path",
    "-m",
    "--module"
  ]);
  for (const argument of args) {
    const option = argument.split("=", 1)[0]?.toLowerCase() ?? "";
    if (argument.startsWith("@") || forbidden.has(option)) {
      throw new Error(`backend.jvmArgs may contain JVM options only: ${argument}`);
    }
  }
  return args;
}

function normalizeContainerBackend(
  backend: Record<string, unknown>,
  schemaVersion: 2 | 3 | 4
): WebappContainerBackendConfig {
  for (const forbidden of [
    "entry",
    "args",
    "env",
    "port",
    "runtime",
    "jvmArgs",
    "command",
    "commands",
    "shell",
    "start",
    "stop",
    "build",
    "buildContext",
    "dockerfile"
  ]) {
    if (backend[forbidden] !== undefined) {
      throw new Error(`backend.${forbidden} is not allowed for an external container.`);
    }
  }
  if (readString(backend.management) !== "external") {
    throw new Error("backend.management must be external for a container launcher.");
  }
  const engine = readString(backend.engine) || "auto";
  if (engine !== "auto" && engine !== "docker" && engine !== "podman") {
    throw new Error("backend.engine must be auto, docker, or podman.");
  }
  const containerName = readString(backend.containerName);
  const image = readString(backend.image);
  const containerPort = Number.parseInt(String(backend.containerPort ?? ""), 10);
  if (!containerName) {
    throw new Error("backend.containerName is required.");
  }
  if (!image) {
    throw new Error("backend.image is required.");
  }
  if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
    throw new Error("backend.containerPort must be an integer between 1 and 65535.");
  }
  return {
    launcher: "container",
    management: "external",
    engine,
    containerName,
    image,
    containerPort,
    health: normalizeHealth(backend.health, schemaVersion, undefined)
  };
}

function normalizeBackend(
  raw: unknown,
  projectDir: string,
  schemaVersion: 2 | 3 | 4
): WebappBackendConfig | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const backend = isRecord(raw) ? raw : {};
  if (schemaVersion === 4) {
    for (const forbidden of ["command", "commands", "shell", "cwd", "startCommand", "stopCommand"]) {
      if (backend[forbidden] !== undefined) {
        throw new Error(`backend.${forbidden} is not allowed; use a built-in launcher.`);
      }
    }
  }
  const launcher = schemaVersion === 4
    ? readString(backend.launcher)
    : readString(backend.runtime) || "node";
  if (launcher === "container") {
    return normalizeContainerBackend(backend, schemaVersion);
  }
  if (launcher !== "node" && launcher !== "native" && launcher !== "java") {
    throw new Error("backend.launcher must be node, native, java, or container.");
  }
  if (schemaVersion < 4 && launcher !== "node") {
    throw new Error("backend.runtime must be node.");
  }
  const common = normalizeManagedBackend(backend, projectDir, schemaVersion);
  if (launcher === "node") {
    if (
      schemaVersion === 4 &&
      ![".js", ".cjs", ".mjs"].includes(path.extname(common.entry).toLowerCase())
    ) {
      throw new Error("Node backend.entry must be a .js, .cjs, or .mjs file.");
    }
    return { launcher: "node", runtime: "node", ...common };
  }
  if (launcher === "java") {
    if (path.extname(common.entry).toLowerCase() !== ".jar") {
      throw new Error("Java backend.entry must be a .jar file.");
    }
    return {
      launcher: "java",
      ...common,
      jvmArgs: normalizeJvmArgs(backend.jvmArgs)
    };
  }
  if (process.platform === "win32" && path.extname(common.entry).toLowerCase() !== ".exe") {
    throw new Error("Windows native backend.entry must be an .exe file.");
  }
  return { launcher: "native", ...common };
}

export function normalizeWebappManifest(value: unknown, projectDir: string, fallbackId = ""): WebappEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const now = Date.now();
  const schemaVersion = normalizeSchemaVersion(value.schemaVersion);
  const target = normalizeTarget(value.target, schemaVersion);
  if (!webappTargetMatchesCurrentPlatform(target)) {
    throw new Error(`webapp target ${target} is not compatible with this Desktop.`);
  }
  const id = normalizeWebId(readString(value.id) || fallbackId || createWebId());
  const copilotAgentKey = readCopilotAgentKey(value);
  const backend = normalizeBackend(value.backend, projectDir, schemaVersion);
  const frontend = normalizeFrontend(value.frontend, projectDir, schemaVersion);
  if (frontend.mode === "proxy" && !backend) {
    throw new Error("frontend.mode proxy requires a backend.");
  }
  return {
    id,
    entryKey: createWebappEntryKey(id),
    kind: "webapp",
    schemaVersion,
    version: normalizeVersion(value.version, schemaVersion),
    target,
    label: normalizeWebsiteLabel(readString(value.label), id),
    frontend,
    ...(backend ? { backend } : {}),
    ...(copilotAgentKey ? { copilotAgentKey } : {}),
    createdAt: value.createdAt === undefined ? now : toTimestamp(value.createdAt),
    updatedAt: value.updatedAt === undefined ? now : toTimestamp(value.updatedAt)
  };
}

function readWebappManifestFile(webappDir: string) {
  const webappPath = path.join(webappDir, WEBAPP_FILE);
  return JSON.parse(fs.readFileSync(webappPath, "utf8")) as unknown;
}

export function readWebappItemFromDir(webappDir: string, fallbackId = "") {
  return normalizeWebappManifest(readWebappManifestFile(webappDir), webappDir, fallbackId || path.basename(webappDir));
}

function sanitizeWebappItems(items: WebappEntry[]) {
  const seenIds = new Set<string>();
  const output: WebappEntry[] = [];
  for (const item of items) {
    if (seenIds.has(item.id)) {
      continue;
    }
    seenIds.add(item.id);
    output.push(item);
  }
  return output;
}

export function readWebappItems(app: App, platform: NodeJS.Platform = process.platform) {
  return readWebappItemsWithoutMigration(app, platform).map((item) => withWebappManagementMetadata(app, item));
}

export function readWebappItemsWithoutMigration(app: App, platform: NodeJS.Platform = process.platform) {
  const root = getDesktopWebappsDataRoot(app, platform);
  if (!fs.existsSync(root)) {
    return [];
  }
  const items: WebappEntry[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      const item = readWebappItemFromDir(path.join(root, entry.name), entry.name);
      if (item) {
        items.push(item);
      }
    } catch (error) {
      console.warn("failed to read webapp item", path.join(root, entry.name, WEBAPP_FILE), error);
    }
  }
  return sortWebEntries(sanitizeWebappItems(items));
}

export function isWebappFile(value: unknown) {
  return isRecord(value) && (
    value.kind === "webapp" ||
    value.kind === "local-app" ||
    value.schemaVersion === 2 ||
    value.schemaVersion === 3 ||
    value.schemaVersion === WEBAPP_SCHEMA_VERSION
  );
}

export function writeWebappPreferenceFields(
  app: App,
  id: string,
  input: {
    label?: string;
    copilotAgentKey?: string;
  },
  platform: NodeJS.Platform = process.platform
) {
  const webappPath = getWebappPath(app, id, platform);
  const raw = readWebappManifestFile(path.dirname(webappPath));
  if (!isRecord(raw)) {
    throw new Error("webapp.json must contain an object.");
  }

  const item = readWebappItemFromDir(path.dirname(webappPath), id);
  if (!item) {
    throw new Error("webapp.json is invalid.");
  }

  const updatedAt = Date.now();
  const requestedCopilotAgentKey = typeof input.copilotAgentKey === "string"
    ? normalizeAgentKey(input.copilotAgentKey)
    : item.copilotAgentKey;
  const next: Record<string, unknown> = {
    ...raw,
    schemaVersion: item.schemaVersion === 4
      ? WEBAPP_SCHEMA_VERSION
      : WEBAPP_LEGACY_CANONICAL_SCHEMA_VERSION,
    id: item.id,
    kind: "webapp",
    ...(requestedCopilotAgentKey ? { copilotAgentKey: requestedCopilotAgentKey } : {}),
    updatedAt: toIsoTimestamp(updatedAt)
  };
  delete next.agentKey;
  if (!requestedCopilotAgentKey) {
    delete next.copilotAgentKey;
  }

  if (typeof input.label === "string") {
    next.label = normalizeWebsiteLabel(input.label, item.id);
  }
  if (typeof input.copilotAgentKey === "string") {
    if (requestedCopilotAgentKey) {
      next.copilotAgentKey = requestedCopilotAgentKey;
    } else {
      delete next.copilotAgentKey;
    }
  }

  fs.writeFileSync(webappPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return withWebappManagementMetadata(app, readWebappItemFromDir(path.dirname(webappPath), id)!);
}

export function writeCanonicalWebappManifest(webappDir: string, fallbackId = "") {
  const raw = readWebappManifestFile(webappDir);
  if (!isRecord(raw)) {
    throw new Error("webapp.json must contain an object.");
  }
  const item = normalizeWebappManifest(raw, webappDir, fallbackId || path.basename(webappDir));
  if (!item) {
    throw new Error("webapp.json is invalid.");
  }
  const schemaVersion = item.schemaVersion === 4
    ? WEBAPP_SCHEMA_VERSION
    : WEBAPP_LEGACY_CANONICAL_SCHEMA_VERSION;
  const legacyFrontend = item.frontend.mode === "static"
    ? {
      root: item.frontend.root,
      index: item.frontend.index,
      spa: item.frontend.spa,
      apiPrefix: item.frontend.apiPrefix
    }
    : item.frontend;
  const legacyBackend = item.backend?.launcher === "node"
    ? {
      runtime: "node",
      entry: item.backend.entry,
      args: item.backend.args,
      env: item.backend.env,
      port: item.backend.port,
      healthPath: item.backend.health.type === "http"
        ? item.backend.health.path
        : "/api/health"
    }
    : item.backend;
  const next: Record<string, unknown> = {
    ...raw,
    schemaVersion,
    id: item.id,
    kind: "webapp",
    label: item.label,
    ...(schemaVersion === 4 ? {
      version: item.version,
      target: item.target,
      frontend: item.frontend,
      ...(item.backend ? { backend: item.backend } : {})
    } : {
      frontend: legacyFrontend,
      ...(legacyBackend ? { backend: legacyBackend } : {})
    }),
    ...(item.copilotAgentKey ? { copilotAgentKey: item.copilotAgentKey } : {}),
    createdAt: toIsoTimestamp(item.createdAt),
    updatedAt: toIsoTimestamp(item.updatedAt)
  };
  delete next.agentKey;
  if (!item.backend) {
    delete next.backend;
  }
  if (!item.copilotAgentKey) {
    delete next.copilotAgentKey;
  }
  fs.writeFileSync(path.join(webappDir, WEBAPP_FILE), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return normalizeWebappManifest(next, webappDir, item.id)!;
}
