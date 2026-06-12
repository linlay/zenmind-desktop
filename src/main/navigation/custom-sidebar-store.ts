import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { CustomSidebarItem, CustomSidebarItemInput, CustomSidebarUpdateInput, WebsiteExternalEntry } from "../../shared/contracts";
import { getDesktopConfigRoot, getDesktopWebsitesDataRoot } from "../user-paths";
import {
  WEBSITE_FILE,
  createExternalWebsiteItem,
  getWebsitePath,
  normalizeAgentKey,
  normalizeWebsiteId,
  normalizeWebsiteLabel,
  normalizeWebsiteUrl,
  readExternalWebsiteItems,
  writeExternalWebsiteItems
} from "../websites/website-store";

const LEGACY_CUSTOM_SIDEBAR_FILE = "custom-sidebar-items.json";
const MAX_CUSTOM_SIDEBAR_ITEMS = 14;

type StoredCustomSidebarItems = {
  items: CustomSidebarItem[];
};

function getCustomSidebarPath(app: App) {
  return path.join(getDesktopConfigRoot(app), LEGACY_CUSTOM_SIDEBAR_FILE);
}

function getWebsitesRoot(app: App) {
  return getDesktopWebsitesDataRoot(app);
}

function toCustomSidebarItem(item: WebsiteExternalEntry): CustomSidebarItem {
  return {
    id: item.id,
    label: item.label,
    url: item.url,
    ...(item.agentKey ? { agentKey: item.agentKey } : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function toExternalWebsiteItem(item: CustomSidebarItem): WebsiteExternalEntry {
  return {
    id: item.id,
    kind: "external",
    label: item.label,
    url: item.url,
    ...(item.agentKey ? { agentKey: item.agentKey } : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function readItems(app: App): CustomSidebarItem[] {
  const websiteItems = readExternalWebsiteItems(app).map(toCustomSidebarItem);
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
  writeExternalWebsiteItems(app, sanitizeItems(items).map(toExternalWebsiteItem));
}

function normalizeItem(item: Partial<CustomSidebarItem>): CustomSidebarItem | null {
  if (typeof item.id !== "string" || typeof item.label !== "string" || typeof item.url !== "string") {
    return null;
  }

  try {
    return toCustomSidebarItem(createExternalWebsiteItem({
      id: item.id.trim() || normalizeWebsiteId(""),
      label: item.label,
      url: item.url,
      agentKey: item.agentKey,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    }));
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
    const url = normalizeWebsiteUrl(input.url);
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
      id: normalizeWebsiteId(""),
      label: normalizeWebsiteLabel(input.label, url),
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
      const nextUrl = normalizeWebsiteUrl(input.url);
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
      updated.label = normalizeWebsiteLabel(input.label ?? target.label, updated.url);
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
  normalizeUrl: normalizeWebsiteUrl,
  normalizeLabel: normalizeWebsiteLabel,
  normalizeWebsiteId,
  normalizeAgentKey,
  parseItemsFileContent
};
