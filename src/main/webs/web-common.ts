import fs from "node:fs";
import path from "node:path";
import type { WebEntryKey, WebsiteEntry } from "../../shared/contracts";

const MAX_LABEL_LENGTH = 24;
const MAX_WEB_ID_LENGTH = 80;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map(readString).filter(Boolean)
    : [];
}

export function readStringRecord(value: unknown) {
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

export function createWebId() {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeWebId(value: string) {
  const normalized = value
    .trim()
    .replace(/^user:/u, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, MAX_WEB_ID_LENGTH);
  return normalized || createWebId();
}

export function createWebsiteEntryKey(id: string): `website:${string}` {
  return `website:${normalizeWebId(id)}`;
}

export function createWebappEntryKey(id: string): `webapp:${string}` {
  return `webapp:${normalizeWebId(id)}`;
}

export function normalizeWebEntryKey(value: unknown): WebEntryKey | null {
  const raw = readString(value);
  if (raw.startsWith("website:")) {
    return createWebsiteEntryKey(raw.slice("website:".length));
  }
  if (raw.startsWith("webapp:")) {
    return createWebappEntryKey(raw.slice("webapp:".length));
  }
  if (raw.startsWith("custom:")) {
    return createWebsiteEntryKey(raw.slice("custom:".length));
  }
  return raw ? createWebsiteEntryKey(raw) : null;
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

export function toTimestamp(value: unknown) {
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

export function isPathInsideRoot(rootDir: string, targetPath: string) {
  const relative = path.relative(rootDir, targetPath);
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveWebappRelativePath(projectDir: string, relativePath: string) {
  const segments = splitSafeRelativePath(relativePath);
  const resolvedPath = path.resolve(projectDir, ...segments);
  if (!isPathInsideRoot(projectDir, resolvedPath)) {
    throw new Error(`path escapes webapp root: ${relativePath}`);
  }
  return resolvedPath;
}

export function realpathInsideRoot(rootDir: string, targetPath: string) {
  const realRoot = fs.realpathSync(rootDir);
  const realTarget = fs.realpathSync(targetPath);
  if (!isPathInsideRoot(realRoot, realTarget)) {
    throw new Error(`path escapes webapp root: ${targetPath}`);
  }
  return realTarget;
}

export function sortWebEntries<T extends { createdAt: number; label: string }>(items: T[]) {
  return [...items].sort((a, b) => a.createdAt - b.createdAt || a.label.localeCompare(b.label, "zh-CN"));
}

export function sanitizeWebsiteItems(items: WebsiteEntry[]) {
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const output: WebsiteEntry[] = [];
  for (const item of items) {
    if (seenIds.has(item.id) || seenUrls.has(item.url)) {
      continue;
    }
    seenIds.add(item.id);
    seenUrls.add(item.url);
    output.push(item);
  }
  return output;
}
