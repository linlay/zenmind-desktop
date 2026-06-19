import type { App } from "electron";
import type { WebsiteEntry, WebsiteInput, WebsiteUpdateInput } from "../../../shared/contracts";
import {
  createWebsiteItem,
  readWebsiteItems,
  writeWebsiteItems
} from "./store";
import {
  isRecord,
  normalizeAgentKey,
  normalizeWebId,
  normalizeWebsiteLabel,
  normalizeWebsiteUrl
} from "../common";
import { t } from "../../i18n/main-i18n";

const MAX_WEBSITE_ITEMS = 14;

type StoredWebsiteItems = {
  items: WebsiteEntry[];
};

function normalizeItem(item: Partial<WebsiteEntry>): WebsiteEntry | null {
  if (typeof item.id !== "string" || typeof item.label !== "string" || typeof item.url !== "string") {
    return null;
  }

  try {
    return createWebsiteItem({
      id: item.id.trim() || normalizeWebId(""),
      label: item.label,
      url: item.url,
      agentKey: item.agentKey,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    });
  } catch {
    return null;
  }
}

function sanitizeItems(rawItems: Partial<WebsiteEntry>[]) {
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const items: WebsiteEntry[] = [];

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
    return raw as Partial<WebsiteEntry>[];
  }
  if (isRecord(raw) && Array.isArray((raw as Partial<StoredWebsiteItems>).items)) {
    return (raw as Partial<StoredWebsiteItems>).items as Partial<WebsiteEntry>[];
  }
  return [];
}

function parseItemsFileContent(content: string) {
  const parsed = JSON.parse(content) as unknown;
  return sanitizeItems(parseItemsPayload(parsed));
}

export function listWebsiteItems(app: App) {
  return {
    ok: true,
    items: readWebsiteItems(app),
    message: t("website.listRead")
  };
}

export function addWebsiteItem(app: App, input: WebsiteInput) {
  const items = readWebsiteItems(app);
  if (items.length >= MAX_WEBSITE_ITEMS) {
    return {
      ok: false,
      item: null,
      items,
      message: t("website.maxItems", { count: MAX_WEBSITE_ITEMS })
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
        message: t("website.alreadyExists")
      };
    }

    const item = createWebsiteItem({
      label: input.label,
      url,
      agentKey: input.agentKey
    });
    const nextItems = [...items, item];
    writeWebsiteItems(app, nextItems);
    return {
      ok: true,
      item,
      items: nextItems,
      message: t("website.added", { label: item.label })
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

export function updateWebsiteItem(app: App, id: string, input: WebsiteUpdateInput) {
  const items = readWebsiteItems(app);
  const normalizedId = id.trim();
  const targetIndex = items.findIndex((item) => item.id === normalizedId);
  if (targetIndex === -1) {
    return {
      ok: false,
      item: null,
      items,
      message: t("website.notFound")
    };
  }

  const target = items[targetIndex];
  const updated: WebsiteEntry = {
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
          message: t("website.alreadyExists")
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
    writeWebsiteItems(app, items);
    return {
      ok: true,
      item: updated,
      items,
      message: t("website.updated", { label: updated.label })
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

export function removeWebsiteItem(app: App, id: string) {
  const items = readWebsiteItems(app);
  const normalizedId = id.trim();
  const target = items.find((item) => item.id === normalizedId);
  if (!target) {
    return {
      ok: false,
      items,
      message: t("website.notFound")
    };
  }

  const nextItems = items.filter((item) => item.id !== normalizedId);
  writeWebsiteItems(app, nextItems);
  return {
    ok: true,
    items: nextItems,
    message: t("website.deleted", { label: target.label })
  };
}

export function importWebsiteItems(app: App, fileContent: string) {
  const currentItems = readWebsiteItems(app);

  try {
    const importedItems = parseItemsFileContent(fileContent);
    if (importedItems.length === 0) {
      return {
        ok: false,
        items: currentItems,
        message: t("website.importEmpty")
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
        message: t("website.importAllExisting")
      };
    }

    writeWebsiteItems(app, nextItems);
    return {
      ok: true,
      items: nextItems,
      message: t("website.importedCount", { count: addedCount })
    };
  } catch (error) {
    return {
      ok: false,
      items: currentItems,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export function exportWebsiteItems(app: App) {
  const items = readWebsiteItems(app);
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
  MAX_WEBSITE_ITEMS,
  parseItemsFileContent
};
