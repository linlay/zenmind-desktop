import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { WebappBackendConfig, WebappEntry, WebappFrontendConfig } from "../../../shared/contracts";
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
export const WEBAPP_SCHEMA_VERSION = 3;

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

function normalizeFrontend(raw: unknown, projectDir: string): WebappFrontendConfig {
  const frontend = isRecord(raw) ? raw : {};
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
    root,
    index,
    spa: frontend.spa === false ? false : true,
    apiPrefix
  };
}

function normalizeBackend(raw: unknown, projectDir: string): WebappBackendConfig | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const backend = isRecord(raw) ? raw : {};
  const runtime = readString(backend.runtime) || "node";
  if (runtime !== "node") {
    throw new Error("backend.runtime must be node.");
  }
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
    runtime: "node",
    entry,
    args: readStringArray(backend.args),
    env: readStringRecord(backend.env),
    port: normalizePort(backend.port),
    healthPath: normalizeHealthPath(backend.healthPath)
  };
}

export function normalizeWebappManifest(value: unknown, projectDir: string, fallbackId = ""): WebappEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const now = Date.now();
  const id = normalizeWebId(readString(value.id) || fallbackId || createWebId());
  const copilotAgentKey = readCopilotAgentKey(value);
  const backend = normalizeBackend(value.backend, projectDir);
  return {
    id,
    entryKey: createWebappEntryKey(id),
    kind: "webapp",
    label: normalizeWebsiteLabel(readString(value.label), id),
    frontend: normalizeFrontend(value.frontend, projectDir),
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
  return isRecord(value) && (value.kind === "webapp" || value.kind === "local-app" || value.schemaVersion === 2 || value.schemaVersion === WEBAPP_SCHEMA_VERSION);
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
    schemaVersion: WEBAPP_SCHEMA_VERSION,
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
  const next: Record<string, unknown> = {
    ...raw,
    schemaVersion: WEBAPP_SCHEMA_VERSION,
    id: item.id,
    kind: "webapp",
    label: item.label,
    frontend: item.frontend,
    ...(item.backend ? { backend: item.backend } : {}),
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
