export type ExternalWebviewBookmark = {
  id: string;
  title: string;
  url: string;
  createdAt: number;
  faviconUrl?: string;
  customTitle?: boolean;
};

export type BookmarkOpenInput = {
  button?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
};

export type BookmarkMenuAnchor = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type BookmarkMenuViewport = {
  width: number;
  height: number;
};

export type BookmarkMenuCoordinateOptions = {
  menuWidth?: number;
  menuMaxHeight?: number;
  gap?: number;
  margin?: number;
};

export const MAX_EXTERNAL_WEBVIEW_BOOKMARKS = 24;
export const EXTERNAL_WEBVIEW_BOOKMARK_TITLE_LIMIT = 48;

const SAFE_DATA_IMAGE_PATTERN = /^data:image\/(?:png|jpe?g|gif|webp|bmp|x-icon|vnd\.microsoft\.icon);/iu;

function trimBookmarkTitle(input: unknown) {
  return typeof input === "string"
    ? input.replace(/\s+/gu, " ").trim().slice(0, EXTERNAL_WEBVIEW_BOOKMARK_TITLE_LIMIT)
    : "";
}

export function createExternalWebviewBookmarkId() {
  return `bookmark-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeBookmarkUrl(inputUrl: unknown) {
  if (typeof inputUrl !== "string") {
    return null;
  }

  try {
    const parsedUrl = new URL(inputUrl.trim());
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return null;
    }
    return parsedUrl.toString();
  } catch {
    return null;
  }
}

export function getUrlDisplayLabel(url: string) {
  try {
    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname === "/" ? "" : parsedUrl.pathname;
    return `${parsedUrl.hostname}${pathname}` || url;
  } catch {
    return url;
  }
}

export function getFallbackBookmarkTitle(preferredTitle: unknown, url: string) {
  const title = trimBookmarkTitle(preferredTitle);
  return title || getUrlDisplayLabel(url).slice(0, EXTERNAL_WEBVIEW_BOOKMARK_TITLE_LIMIT);
}

export function normalizeFaviconUrl(inputUrl: unknown, baseUrl?: string | null) {
  if (typeof inputUrl !== "string") {
    return null;
  }

  const trimmedUrl = inputUrl.trim();
  if (!trimmedUrl) {
    return null;
  }

  if (SAFE_DATA_IMAGE_PATTERN.test(trimmedUrl)) {
    return trimmedUrl;
  }

  try {
    const parsedUrl = baseUrl ? new URL(trimmedUrl, baseUrl) : new URL(trimmedUrl);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return null;
    }
    return parsedUrl.toString();
  } catch {
    return null;
  }
}

export function pickFirstSafeFaviconUrl(favicons: unknown, baseUrl?: string | null) {
  if (!Array.isArray(favicons)) {
    return null;
  }

  for (const faviconUrl of favicons) {
    const normalizedFaviconUrl = normalizeFaviconUrl(faviconUrl, baseUrl);
    if (normalizedFaviconUrl) {
      return normalizedFaviconUrl;
    }
  }

  return null;
}

export function normalizeStoredBookmarks(raw: unknown): ExternalWebviewBookmark[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const seenUrls = new Set<string>();
  const bookmarks: ExternalWebviewBookmark[] = [];
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const bookmark = candidate as Partial<ExternalWebviewBookmark>;
    const normalizedUrl = normalizeBookmarkUrl(bookmark.url);
    if (!normalizedUrl || seenUrls.has(normalizedUrl)) {
      continue;
    }

    seenUrls.add(normalizedUrl);
    const normalizedFaviconUrl = normalizeFaviconUrl(bookmark.faviconUrl, normalizedUrl);
    bookmarks.push({
      id: typeof bookmark.id === "string" && bookmark.id.trim()
        ? bookmark.id
        : createExternalWebviewBookmarkId(),
      title: getFallbackBookmarkTitle(bookmark.title, normalizedUrl),
      url: normalizedUrl,
      ...(normalizedFaviconUrl ? { faviconUrl: normalizedFaviconUrl } : {}),
      createdAt: typeof bookmark.createdAt === "number" ? bookmark.createdAt : Date.now(),
      ...(bookmark.customTitle === true ? { customTitle: true } : {})
    });

    if (bookmarks.length >= MAX_EXTERNAL_WEBVIEW_BOOKMARKS) {
      break;
    }
  }

  return bookmarks;
}

export function shouldOpenBookmarkInNewTab(input: BookmarkOpenInput, platform = "") {
  if (input.button === 1) {
    return true;
  }

  const isMac = /Mac|iPhone|iPad|iPod/iu.test(platform);
  return isMac ? input.metaKey === true : input.ctrlKey === true;
}

export function getAnchoredBookmarkMenuCoordinates(
  anchor: BookmarkMenuAnchor,
  viewport: BookmarkMenuViewport,
  options: BookmarkMenuCoordinateOptions = {}
) {
  const menuWidth = options.menuWidth ?? 306;
  const menuMaxHeight = options.menuMaxHeight ?? 340;
  const gap = options.gap ?? 4;
  const margin = options.margin ?? 8;
  const viewportWidth = viewport.width || menuWidth;
  const viewportHeight = viewport.height || menuMaxHeight;
  const maxX = Math.max(margin, viewportWidth - menuWidth - margin);
  const maxY = Math.max(margin, viewportHeight - menuMaxHeight - margin);
  const x = Math.max(margin, Math.min(anchor.left, maxX));
  const belowY = anchor.bottom + gap;
  const y = belowY + menuMaxHeight + margin <= viewportHeight
    ? belowY
    : Math.max(margin, Math.min(anchor.top - menuMaxHeight - gap, maxY));

  return { x, y };
}

export function reorderItemsById<T extends { id: string }>(items: T[], movedId: string, targetId: string) {
  if (movedId === targetId) {
    return items;
  }

  const movedIndex = items.findIndex((item) => item.id === movedId);
  const targetIndex = items.findIndex((item) => item.id === targetId);
  if (movedIndex === -1 || targetIndex === -1) {
    return items;
  }

  const nextItems = [...items];
  const [movedItem] = nextItems.splice(movedIndex, 1);
  if (!movedItem) {
    return items;
  }

  const nextTargetIndex = nextItems.findIndex((item) => item.id === targetId);
  const insertionIndex = movedIndex < targetIndex ? nextTargetIndex + 1 : nextTargetIndex;
  nextItems.splice(insertionIndex, 0, movedItem);
  return nextItems;
}

export function moveItemByIdToIndex<T extends { id: string }>(items: T[], movedId: string, targetIndex: number) {
  const movedIndex = items.findIndex((item) => item.id === movedId);
  if (movedIndex === -1) {
    return items;
  }

  const boundedTargetIndex = Math.max(0, Math.min(targetIndex, items.length));
  const insertionIndex = movedIndex < boundedTargetIndex ? boundedTargetIndex - 1 : boundedTargetIndex;
  if (insertionIndex === movedIndex) {
    return items;
  }

  const nextItems = [...items];
  const [movedItem] = nextItems.splice(movedIndex, 1);
  if (!movedItem) {
    return items;
  }

  nextItems.splice(insertionIndex, 0, movedItem);
  return nextItems;
}

export function getItemsHiddenByVisibleIds<T extends { id: string }>(items: T[], visibleIds: string[]) {
  if (visibleIds.length === 0) {
    return items;
  }

  const visibleIdSet = new Set(visibleIds);
  return items.filter((item) => !visibleIdSet.has(item.id));
}
