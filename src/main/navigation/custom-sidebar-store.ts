import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { CustomSidebarItem, CustomSidebarItemInput, CustomSidebarUpdateInput } from "../../shared/contracts";
import { getDesktopConfigRoot, getDesktopWebsitesDataRoot } from "../user-paths";

const WEBSITE_FILE = "website.json";
const LEGACY_CUSTOM_SIDEBAR_FILE = "custom-sidebar-items.json";
const MAX_CUSTOM_SIDEBAR_ITEMS = 14;

type StoredCustomSidebarItems = {
  items: CustomSidebarItem[];
};

type StoredWebsite = {
  schemaVersion?: unknown;
  id?: unknown;
  label?: unknown;
  url?: unknown;
  agentKey?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};

function getCustomSidebarPath(app: App) {
  return path.join(getDesktopConfigRoot(app), LEGACY_CUSTOM_SIDEBAR_FILE);
}

function getWebsitesRoot(app: App) {
  return getDesktopWebsitesDataRoot(app);
}

function normalizeWebsiteId(value: string) {
  const normalized = value
    .trim()
    .replace(/^user:/u, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return normalized || createItemId();
}

function getWebsiteDir(app: App, id: string) {
  return path.join(getWebsitesRoot(app), normalizeWebsiteId(id));
}

function getWebsitePath(app: App, id: string) {
  return path.join(getWebsiteDir(app, id), WEBSITE_FILE);
}

function createItemId() {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeUrl(inputUrl: string) {
  const raw = inputUrl.trim();
  if (!raw) {
    throw new Error("网站地址不能为空。");
  }

  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
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

function normalizeLabel(inputLabel: string | undefined, url: string) {
  const trimmed = (inputLabel ?? "").trim();
  if (trimmed) {
    return trimmed.slice(0, 24);
  }

  try {
    const hostname = new URL(url).hostname.replace(/^www\./i, "");
    const knownLabels: Record<string, string> = {
      "baidu.com": "百度"
    };
    if (knownLabels[hostname]) {
      return knownLabels[hostname];
    }
    const firstPart = hostname.split(".")[0];
    return firstPart ? firstPart.slice(0, 24) : "自定义网站";
  } catch {
    return "自定义网站";
  }
}

function normalizeAgentKey(inputAgentKey: unknown) {
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

function toIsoTimestamp(value: number) {
  return new Date(Number.isFinite(value) ? value : Date.now()).toISOString();
}

function normalizeItem(item: Partial<CustomSidebarItem>): CustomSidebarItem | null {
  if (typeof item.id !== "string" || typeof item.label !== "string" || typeof item.url !== "string") {
    return null;
  }

  try {
    const url = normalizeUrl(item.url);
    const now = Date.now();
    const agentKey = normalizeAgentKey(item.agentKey);
    return {
      id: normalizeWebsiteId(item.id.trim() || createItemId()),
      label: normalizeLabel(item.label, url),
      url,
      ...(agentKey ? { agentKey } : {}),
      createdAt: item.createdAt === undefined ? now : toTimestamp(item.createdAt),
      updatedAt: item.updatedAt === undefined ? now : toTimestamp(item.updatedAt)
    };
  } catch {
    return null;
  }
}

function sanitizeItems(rawItems: Partial<CustomSidebarItem>[]) {
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const items: CustomSidebarItem[] = [];

  for (const rawItem of rawItems) {
    if (typeof rawItem?.id === "string" && seenIds.has(rawItem.id)) {
      continue;
    }

    const item = normalizeItem(rawItem);
    if (!item || seenIds.has(item.id) || seenUrls.has(item.url)) {
      continue;
    }

    seenIds.add(item.id);
    seenUrls.add(item.url);
    items.push(item);
  }

  return items;
}

function parseItemsPayload(raw: unknown) {
  if (Array.isArray(raw)) {
    return raw as Partial<CustomSidebarItem>[];
  }
  if (raw && typeof raw === "object" && Array.isArray((raw as Partial<StoredCustomSidebarItems>).items)) {
    return (raw as Partial<StoredCustomSidebarItems>).items as Partial<CustomSidebarItem>[];
  }
  return [];
}

function parseItemsFileContent(content: string) {
  const parsed = JSON.parse(content) as unknown;
  return sanitizeItems(parseItemsPayload(parsed));
}

function normalizeWebsiteFile(value: unknown): CustomSidebarItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const website = value as StoredWebsite;
  return normalizeItem({
    id: typeof website.id === "string" ? website.id : "",
    label: typeof website.label === "string" ? website.label : "",
    url: typeof website.url === "string" ? website.url : "",
    agentKey: typeof website.agentKey === "string" ? website.agentKey : undefined,
    createdAt: toTimestamp(website.createdAt),
    updatedAt: toTimestamp(website.updatedAt)
  });
}

function readWebsiteItems(app: App) {
  const root = getWebsitesRoot(app);
  if (!fs.existsSync(root)) {
    return [];
  }
  const items: CustomSidebarItem[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const websitePath = path.join(root, entry.name, WEBSITE_FILE);
    try {
      const item = normalizeWebsiteFile(JSON.parse(fs.readFileSync(websitePath, "utf8")));
      if (item) {
        items.push(item);
      }
    } catch (error) {
      console.warn("failed to read website item", websitePath, error);
    }
  }
  return sanitizeItems(items).sort((a, b) => a.createdAt - b.createdAt || a.label.localeCompare(b.label, "zh-CN"));
}

function readItems(app: App): CustomSidebarItem[] {
  const websiteItems = readWebsiteItems(app);
  if (websiteItems.length > 0) {
    return websiteItems;
  }

  const targetPath = getCustomSidebarPath(app);
  if (!fs.existsSync(targetPath)) {
    return [];
  }

  try {
    const legacyItems = parseItemsFileContent(fs.readFileSync(targetPath, "utf8"));
    if (legacyItems.length > 0) {
      writeItems(app, legacyItems);
    }
    return legacyItems;
  } catch (error) {
    console.warn("failed to read custom sidebar items", error);
    return [];
  }
}

function writeItems(app: App, items: CustomSidebarItem[]) {
  const root = getWebsitesRoot(app);
  fs.mkdirSync(root, { recursive: true });
  const normalizedItems = sanitizeItems(items);
  const expectedDirs = new Set(normalizedItems.map((item) => normalizeWebsiteId(item.id)));
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !expectedDirs.has(entry.name)) {
      fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
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

export function listCustomSidebarItems(app: App) {
  return {
    ok: true,
    items: readItems(app),
    message: "已读取内嵌网站。"
  };
}

export function addCustomSidebarItem(app: App, input: CustomSidebarItemInput) {
  const items = readItems(app);
  if (items.length >= MAX_CUSTOM_SIDEBAR_ITEMS) {
    return {
      ok: false,
      item: null,
      items,
      message: `最多可添加 ${MAX_CUSTOM_SIDEBAR_ITEMS} 个内嵌网站。`
    };
  }

  try {
    const url = normalizeUrl(input.url);
    const existing = items.find((item) => item.url === url);
    if (existing) {
      return {
        ok: false,
        item: existing,
        items,
        message: "这个网站已经是内嵌网站了。"
      };
    }

    const now = Date.now();
    const agentKey = normalizeAgentKey(input.agentKey);
    const item: CustomSidebarItem = {
      id: normalizeWebsiteId(createItemId()),
      label: normalizeLabel(input.label, url),
      url,
      ...(agentKey ? { agentKey } : {}),
      createdAt: now,
      updatedAt: now
    };
    const nextItems = [...items, item];
    writeItems(app, nextItems);
    return {
      ok: true,
      item,
      items: nextItems,
      message: `已添加「${item.label}」。`
    };
  } catch (error) {
    return {
      ok: false,
      item: null,
      items,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export function updateCustomSidebarItem(app: App, id: string, input: CustomSidebarUpdateInput) {
  const items = readItems(app);
  const normalizedId = id.trim();
  const targetIndex = items.findIndex((item) => item.id === normalizedId);
  if (targetIndex === -1) {
    return {
      ok: false,
      item: null,
      items,
      message: "未找到这个内嵌网站。"
    };
  }

  const target = items[targetIndex];
  const updated: CustomSidebarItem = {
    ...target,
    updatedAt: Date.now()
  };

  try {
    if (typeof input.url === "string") {
      const nextUrl = normalizeUrl(input.url);
      const duplicate = items.find((item) => item.id !== normalizedId && item.url === nextUrl);
      if (duplicate) {
        return {
          ok: false,
          item: target,
          items,
          message: "这个网站已经是内嵌网站了。"
        };
      }
      updated.url = nextUrl;
    }

    if (typeof input.label === "string" || typeof input.url === "string") {
      updated.label = normalizeLabel(input.label ?? target.label, updated.url);
    }

    if (typeof input.agentKey === "string") {
      const agentKey = normalizeAgentKey(input.agentKey);
      if (agentKey) {
        updated.agentKey = agentKey;
      } else {
        delete updated.agentKey;
      }
    }

    items[targetIndex] = updated;
    writeItems(app, items);
    return {
      ok: true,
      item: updated,
      items,
      message: `已更新「${updated.label}」。`
    };
  } catch (error) {
    return {
      ok: false,
      item: target,
      items,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export function removeCustomSidebarItem(app: App, id: string) {
  const items = readItems(app);
  const normalizedId = id.trim();
  const target = items.find((item) => item.id === normalizedId);
  if (!target) {
    return {
      ok: false,
      items,
      message: "未找到这个内嵌网站。"
    };
  }

  const nextItems = items.filter((item) => item.id !== normalizedId);
  writeItems(app, nextItems);
  return {
    ok: true,
    items: nextItems,
    message: `已删除「${target.label}」。`
  };
}

export function importCustomSidebarItems(app: App, fileContent: string) {
  const currentItems = readItems(app);

  try {
    const importedItems = parseItemsFileContent(fileContent);
    if (importedItems.length === 0) {
      return {
        ok: false,
        items: currentItems,
        message: "导入文件中没有可用的内嵌网站。"
      };
    }

    const currentUrls = new Set(currentItems.map((item) => item.url));
    const mergedRawItems = [
      ...currentItems,
      ...importedItems.filter((item) => !currentUrls.has(item.url))
    ];
    const nextItems = sanitizeItems(mergedRawItems);
    const addedCount = nextItems.length - currentItems.length;

    if (addedCount <= 0) {
      return {
        ok: false,
        items: currentItems,
        message: "导入的入口已全部存在于当前侧边栏中。"
      };
    }

    writeItems(app, nextItems);
    return {
      ok: true,
      items: nextItems,
      message: `已导入 ${addedCount} 个内嵌网站。`
    };
  } catch (error) {
    return {
      ok: false,
      items: currentItems,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export function exportCustomSidebarItems(app: App) {
  const items = readItems(app);
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      items
    },
    null,
    2
  );
}

export const __testInternals = {
  getCustomSidebarPath,
  getWebsitesRoot,
  getWebsitePath,
  WEBSITE_FILE,
  LEGACY_CUSTOM_SIDEBAR_FILE,
  normalizeUrl,
  normalizeLabel,
  normalizeWebsiteId,
  normalizeAgentKey,
  parseItemsFileContent
};
