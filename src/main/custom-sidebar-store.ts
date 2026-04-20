import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type {
  CustomSidebarItem,
  CustomSidebarItemInput
} from "../shared/contracts";
import { CUSTOM_SIDEBAR_ICON_IDS } from "../shared/custom-sidebar-icons";

const CUSTOM_SIDEBAR_FILE = "custom-sidebar-items.json";
const MAX_CUSTOM_SIDEBAR_ITEMS = CUSTOM_SIDEBAR_ICON_IDS.length;

type StoredCustomSidebarItems = {
  items: CustomSidebarItem[];
};

function getCustomSidebarPath(app: App) {
  return path.join(app.getPath("userData"), "settings", CUSTOM_SIDEBAR_FILE);
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
    const iconId = isKnownIconId(item.iconId) && !usedIconIds.has(item.iconId)
      ? item.iconId
      : pickNextIconId(usedIconIds);
    if (!iconId) {
      return null;
    }
    usedIconIds.add(iconId);
    return {
      id: item.id.trim() || createItemId(),
      label: normalizeLabel(item.label, url),
      url,
      iconId,
      createdAt: typeof item.createdAt === "number" ? item.createdAt : now,
      updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : now
    };
  } catch {
    return null;
  }
}

function readItems(app: App): CustomSidebarItem[] {
  const targetPath = getCustomSidebarPath(app);
  if (!fs.existsSync(targetPath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(targetPath, "utf8")) as Partial<StoredCustomSidebarItems>;
    if (!Array.isArray(parsed.items)) {
      return [];
    }
    const seenIds = new Set<string>();
    const usedIconIds = new Set<string>();
    const items: CustomSidebarItem[] = [];
    for (const rawItem of parsed.items) {
      if (typeof rawItem?.id === "string" && seenIds.has(rawItem.id)) {
        continue;
      }
      const item = normalizeItem(rawItem, usedIconIds);
      if (!item || seenIds.has(item.id)) {
        continue;
      }
      seenIds.add(item.id);
      items.push(item);
    }
    return items;
  } catch (error) {
    console.warn("failed to read custom sidebar items", error);
    return [];
  }
}

function writeItems(app: App, items: CustomSidebarItem[]) {
  const targetPath = getCustomSidebarPath(app);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(
    targetPath,
    `${JSON.stringify({ items }, null, 2)}\n`,
    "utf8"
  );
}

export function listCustomSidebarItems(app: App) {
  return {
    ok: true,
    items: readItems(app),
    message: "已读取自定义侧边栏。"
  };
}

export function addCustomSidebarItem(app: App, input: CustomSidebarItemInput) {
  const items = readItems(app);
  if (items.length >= MAX_CUSTOM_SIDEBAR_ITEMS) {
    return {
      ok: false,
      item: null,
      items,
      message: `最多可添加 ${MAX_CUSTOM_SIDEBAR_ITEMS} 个自定义侧边栏入口。`
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
        message: "这个网站已经在侧边栏里了。"
      };
    }

    const usedIconIds = new Set(items.map((item) => item.iconId));
    const iconId = pickNextIconId(usedIconIds);
    if (!iconId) {
      return {
        ok: false,
        item: null,
        items,
        message: "图标库已用完，请先删除一个自定义侧边栏入口。"
      };
    }

    const now = Date.now();
    const item: CustomSidebarItem = {
      id: createItemId(),
      label: normalizeLabel(input.label, url),
      url,
      iconId,
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

export function removeCustomSidebarItem(app: App, id: string) {
  const items = readItems(app);
  const normalizedId = id.trim();
  const target = items.find((item) => item.id === normalizedId);
  if (!target) {
    return {
      ok: false,
      items,
      message: "未找到这个自定义侧边栏入口。"
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

export const __testInternals = {
  getCustomSidebarPath,
  normalizeUrl,
  normalizeLabel,
  pickNextIconId
};
