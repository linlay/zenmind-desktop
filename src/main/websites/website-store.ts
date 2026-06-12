import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type {
  WebsiteBackendConfig,
  WebsiteExternalEntry,
  WebsiteFrontendConfig,
  WebsiteListItem,
  WebsiteLocalAppEntry
} from "../../shared/contracts";
import { getDesktopWebsitesDataRoot } from "../user-paths";

export const WEBSITE_FILE = "website.json";
const MAX_LABEL_LENGTH = 24;
const MAX_WEBSITE_ID_LENGTH = 80;

type StoredWebsite = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map(readString).filter(Boolean)
    : [];
}

function readStringRecord(value: unknown) {
  if (!isRecord(value)) {
    return {};
  }
  const output: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const normalizedKey = readString(key);
    const normalizedValue = readString(rawValue);
    if (normalizedKey) {
      output[normalizedKey] = normalizedValue;
    }
  }
  return output;
}

function createItemId() {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeWebsiteId(value: string) {
  const normalized = value
    .trim()
    .replace(/^user:/u, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, MAX_WEBSITE_ID_LENGTH);
  return normalized || createItemId();
}

export function getWebsiteDir(app: App, id: string) {
  return path.join(getDesktopWebsitesDataRoot(app), normalizeWebsiteId(id));
}

export function getWebsitePath(app: App, id: string) {
  return path.join(getWebsiteDir(app, id), WEBSITE_FILE);
}

export function normalizeWebsiteUrl(inputUrl: string) {
  const raw = inputUrl.trim();
  if (!raw) {
    throw new Error("网站地址不能为空。");
  }

  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//iu.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error("请输入有效的网站地址，例如 www.baidu.com。");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("仅支持 http 或 https 网站地址。");
  }
  if (!parsed.hostname) {
    throw new Error("请输入有效的网站地址，例如 www.baidu.com。");
  }
  return parsed.toString();
}

export function normalizeWebsiteLabel(inputLabel: string | undefined, urlOrFallback: string) {
  const trimmed = (inputLabel ?? "").trim();
  if (trimmed) {
    return trimmed.slice(0, MAX_LABEL_LENGTH);
  }

  try {
    const hostname = new URL(urlOrFallback).hostname.replace(/^www\./iu, "");
    const knownLabels: Record<string, string> = {
      "baidu.com": "百度"
    };
    if (knownLabels[hostname]) {
      return knownLabels[hostname];
    }
    const firstPart = hostname.split(".")[0];
    return firstPart ? firstPart.slice(0, MAX_LABEL_LENGTH) : "自定义网站";
  } catch {
    return urlOrFallback ? urlOrFallback.slice(0, MAX_LABEL_LENGTH) : "自定义网站";
  }
}

export function normalizeAgentKey(inputAgentKey: unknown) {
  if (typeof inputAgentKey !== "string") {
    return undefined;
  }
  const normalized = inputAgentKey.trim();
  return normalized || undefined;
}

function toTimestamp(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }
  return Date.now();
}

export function toIsoTimestamp(value: number) {
  return new Date(Number.isFinite(value) ? value : Date.now()).toISOString();
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

function splitSafeRelativePath(relativePath: string) {
  const normalized = relativePath.trim().replace(/\\/gu, "/");
  if (!normalized || normalized.startsWith("/") || path.isAbsolute(normalized)) {
    throw new Error(`path must be relative: ${relativePath}`);
  }
  const segments = normalized.split("/").filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === ".." || segment.startsWith("."))
  ) {
    throw new Error(`path contains an unsafe segment: ${relativePath}`);
  }
  return segments;
}

export function resolveWebsiteRelativePath(projectDir: string, relativePath: string) {
  const segments = splitSafeRelativePath(relativePath);
  const resolvedPath = path.resolve(projectDir, ...segments);
  if (!isPathInsideRoot(projectDir, resolvedPath)) {
    throw new Error(`path escapes website root: ${relativePath}`);
  }
  return resolvedPath;
}

function realpathInsideRoot(rootDir: string, targetPath: string) {
  const realRoot = fs.realpathSync(rootDir);
  const realTarget = fs.realpathSync(targetPath);
  if (!isPathInsideRoot(realRoot, realTarget)) {
    throw new Error(`path escapes website root: ${targetPath}`);
  }
  return realTarget;
}

export function isPathInsideRoot(rootDir: string, targetPath: string) {
  const relative = path.relative(rootDir, targetPath);
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeExternalWebsite(raw: StoredWebsite, fallbackId: string): WebsiteExternalEntry | null {
  const urlText = readString(raw.url);
  if (!urlText) {
    return null;
  }
  const url = normalizeWebsiteUrl(urlText);
  const now = Date.now();
  const id = normalizeWebsiteId(readString(raw.id) || fallbackId || createItemId());
  const agentKey = normalizeAgentKey(raw.agentKey);
  return {
    id,
    kind: "external",
    label: normalizeWebsiteLabel(readString(raw.label), url),
    url,
    ...(agentKey ? { agentKey } : {}),
    createdAt: raw.createdAt === undefined ? now : toTimestamp(raw.createdAt),
    updatedAt: raw.updatedAt === undefined ? now : toTimestamp(raw.updatedAt)
  };
}

function normalizeFrontend(raw: unknown, projectDir: string): WebsiteFrontendConfig {
  const frontend = isRecord(raw) ? raw : {};
  const root = readString(frontend.root) || "frontend";
  const index = readString(frontend.index) || "index.html";
  const apiPrefix = normalizeApiPrefix(frontend.apiPrefix);
  const rootPath = resolveWebsiteRelativePath(projectDir, root);
  const rootRealPath = realpathInsideRoot(projectDir, rootPath);
  if (!fs.statSync(rootRealPath).isDirectory()) {
    throw new Error(`frontend.root is not a directory: ${root}`);
  }
  const indexPath = resolveWebsiteRelativePath(rootRealPath, index);
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

function normalizeBackend(raw: unknown, projectDir: string): WebsiteBackendConfig {
  const backend = isRecord(raw) ? raw : {};
  const runtime = readString(backend.runtime) || "node";
  if (runtime !== "node") {
    throw new Error("backend.runtime must be node.");
  }
  const entry = readString(backend.entry);
  if (!entry) {
    throw new Error("backend.entry is required.");
  }
  const entryPath = resolveWebsiteRelativePath(projectDir, entry);
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

function normalizeLocalWebsite(raw: StoredWebsite, projectDir: string, fallbackId: string): WebsiteLocalAppEntry {
  const now = Date.now();
  const id = normalizeWebsiteId(readString(raw.id) || fallbackId || createItemId());
  const agentKey = normalizeAgentKey(raw.agentKey);
  return {
    id,
    kind: "local-app",
    label: normalizeWebsiteLabel(readString(raw.label), id),
    frontend: normalizeFrontend(raw.frontend, projectDir),
    backend: normalizeBackend(raw.backend, projectDir),
    ...(agentKey ? { agentKey } : {}),
    createdAt: raw.createdAt === undefined ? now : toTimestamp(raw.createdAt),
    updatedAt: raw.updatedAt === undefined ? now : toTimestamp(raw.updatedAt)
  };
}

export function normalizeWebsiteManifest(value: unknown, projectDir: string, fallbackId = ""): WebsiteListItem | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.kind === "local-app" || value.schemaVersion === 2) {
    return normalizeLocalWebsite(value, projectDir, fallbackId);
  }
  return normalizeExternalWebsite(value, fallbackId);
}

function readWebsiteManifestFile(websiteDir: string) {
  const websitePath = path.join(websiteDir, WEBSITE_FILE);
  return JSON.parse(fs.readFileSync(websitePath, "utf8")) as unknown;
}

export function readWebsiteItemFromDir(websiteDir: string, fallbackId = "") {
  return normalizeWebsiteManifest(readWebsiteManifestFile(websiteDir), websiteDir, fallbackId || path.basename(websiteDir));
}

function sanitizeItems(items: WebsiteListItem[]) {
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const output: WebsiteListItem[] = [];
  for (const item of items) {
    if (seenIds.has(item.id)) {
      continue;
    }
    if (item.kind === "external") {
      if (seenUrls.has(item.url)) {
        continue;
      }
      seenUrls.add(item.url);
    }
    seenIds.add(item.id);
    output.push(item);
  }
  return output;
}

export function readWebsiteItems(app: App) {
  const root = getDesktopWebsitesDataRoot(app);
  if (!fs.existsSync(root)) {
    return [];
  }
  const items: WebsiteListItem[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      const item = readWebsiteItemFromDir(path.join(root, entry.name), entry.name);
      if (item) {
        items.push(item);
      }
    } catch (error) {
      console.warn("failed to read website item", path.join(root, entry.name, WEBSITE_FILE), error);
    }
  }
  return sanitizeItems(items).sort((a, b) => a.createdAt - b.createdAt || a.label.localeCompare(b.label, "zh-CN"));
}

export function readExternalWebsiteItems(app: App) {
  return readWebsiteItems(app).filter((item): item is WebsiteExternalEntry => item.kind === "external");
}

export function writeExternalWebsiteItems(app: App, items: WebsiteExternalEntry[]) {
  const root = getDesktopWebsitesDataRoot(app);
  fs.mkdirSync(root, { recursive: true });
  const normalizedItems = sanitizeItems(items) as WebsiteExternalEntry[];
  const expectedDirs = new Set(normalizedItems.map((item) => normalizeWebsiteId(item.id)));

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || expectedDirs.has(entry.name)) {
      continue;
    }
    try {
      const existing = readWebsiteItemFromDir(path.join(root, entry.name), entry.name);
      if (existing?.kind === "external") {
        fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
      }
    } catch {
      // Preserve unknown user directories instead of risking local app data loss.
    }
  }

  for (const item of normalizedItems) {
    const websiteId = normalizeWebsiteId(item.id);
    const targetPath = getWebsitePath(app, websiteId);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, `${JSON.stringify({
      schemaVersion: 1,
      id: websiteId,
      label: item.label,
      url: item.url,
      ...(item.agentKey ? { agentKey: item.agentKey } : {}),
      createdAt: toIsoTimestamp(item.createdAt),
      updatedAt: toIsoTimestamp(item.updatedAt)
    }, null, 2)}\n`, "utf8");
  }
}

export function createExternalWebsiteItem(input: {
  id?: string;
  label?: string;
  url: string;
  agentKey?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}): WebsiteExternalEntry {
  const url = normalizeWebsiteUrl(input.url);
  const now = Date.now();
  const agentKey = normalizeAgentKey(input.agentKey);
  return {
    id: normalizeWebsiteId(input.id || createItemId()),
    kind: "external",
    label: normalizeWebsiteLabel(input.label, url),
    url,
    ...(agentKey ? { agentKey } : {}),
    createdAt: input.createdAt === undefined ? now : toTimestamp(input.createdAt),
    updatedAt: input.updatedAt === undefined ? now : toTimestamp(input.updatedAt)
  };
}

export function isExternalWebsiteFile(value: unknown) {
  try {
    return Boolean(normalizeExternalWebsite(isRecord(value) ? value : {}, ""));
  } catch {
    return false;
  }
}
