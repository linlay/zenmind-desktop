import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { CustomSidebarItem, CustomSidebarItemInput, CustomSidebarUpdateInput } from "../../shared/contracts";
import { CUSTOM_SIDEBAR_ICON_IDS } from "../../shared/custom-sidebar-icons";
import { getDesktopConfigRoot } from "../user-paths";

const CUSTOM_SIDEBAR_FILE = "custom-sidebar-items.json";
const MAX_CUSTOM_SIDEBAR_ITEMS = CUSTOM_SIDEBAR_ICON_IDS.length;

type StoredCustomSidebarItems = {
  items: CustomSidebarItem[];
};

function getCustomSidebarPath(app: App) {
  return path.join(getDesktopConfigRoot(app), CUSTOM_SIDEBAR_FILE);
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

function isKnownIconId(iconId: unknown): iconId is string {
  return typeof iconId === "string" && (CUSTOM_SIDEBAR_ICON_IDS as readonly string[]).includes(iconId);
}

function pickNextIconId(usedIconIds: Set<string>) {
  return CUSTOM_SIDEBAR_ICON_IDS.find((iconId) => !usedIconIds.has(iconId)) ?? null;
}

function normalizeItem(item: Partial<CustomSidebarItem>, usedIconIds: Set<string>): CustomSidebarItem | null {
  if (typeof item.id !== "string" || typeof item.label !== "string" || typeof item.url !== "string") {
    return null;
  }

  try {
    const url = normalizeUrl(item.url);
    const now = Date.now();
    const iconId =
      isKnownIconId(item.iconId) && !usedIconIds.has(item.iconId)
        ? item.iconId
        : pickNextIconId(usedIconIds);
    if (!iconId) {
      return null;
    }
    usedIconIds.add(iconId);
    const agentKey = normalizeAgentKey(item.agentKey);
    return {
      id: item.id.trim() || createItemId(),
      label: normalizeLabel(item.label, url),
      url,
      iconId,
      ...(agentKey ? { agentKey } : {}),
      createdAt: typeof item.createdAt === "number" ? item.createdAt : now,
      updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : now
    };
  } catch {
    return null;
  }
}

function sanitizeItems(rawItems: Partial<CustomSidebarItem>[]) {
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const usedIconIds = new Set<string>();
  const items: CustomSidebarItem[] = [];

  for (const rawItem of rawItems) {
    if (typeof rawItem?.id === "string" && seenIds.has(rawItem.id)) {
      continue;
    }

    const item = normalizeItem(rawItem, usedIconIds);
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

function readItems(app: App): CustomSidebarItem[] {
  const targetPath = getCustomSidebarPath(app);
  if (!fs.existsSync(targetPath)) {
    return [];
  }

  try {
    return parseItemsFileContent(fs.readFileSync(targetPath, "utf8"));
  } catch (error) {
    console.warn("failed to read custom sidebar items", error);
    return [];
  }
}

function writeItems(app: App, items: CustomSidebarItem[]) {
  const targetPath = getCustomSidebarPath(app);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify({ items }, null, 2)}\n`, "utf8");
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

    const usedIconIds = new Set(items.map((item) => item.iconId));
    const iconId = pickNextIconId(usedIconIds);
    if (!iconId) {
      return {
        ok: false,
        item: null,
        items,
        message: "图标库已用完，请先删除一个内嵌网站。"
      };
    }

    const now = Date.now();
    const agentKey = normalizeAgentKey(input.agentKey);
    const item: CustomSidebarItem = {
      id: createItemId(),
      label: normalizeLabel(input.label, url),
      url,
      iconId,
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
  normalizeUrl,
  normalizeLabel,
  normalizeAgentKey,
  pickNextIconId,
  parseItemsFileContent
};
