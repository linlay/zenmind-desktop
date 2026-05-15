import { createElement, useEffect, useRef, useState } from "react";
import type {
  DragEvent as ReactDragEvent,
  FormEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent
} from "react";
import { createPortal } from "react-dom";
import type { AssistantPageContext } from "../../shared/contracts";
import {
  createExternalWebviewBookmarkId,
  getAnchoredBookmarkMenuCoordinates,
  getFallbackBookmarkTitle,
  getItemsHiddenByVisibleIds,
  getUrlDisplayLabel,
  MAX_EXTERNAL_WEBVIEW_BOOKMARKS,
  moveItemByIdToIndex,
  normalizeBookmarkUrl,
  normalizeFaviconUrl,
  normalizeStoredBookmarks,
  pickFirstSafeFaviconUrl,
  reorderItemsById,
  shouldOpenBookmarkInNewTab
} from "../../shared/external-webview-bookmarks";
import type { ExternalWebviewBookmark } from "../../shared/external-webview-bookmarks";
import {
  EXTRACT_STRUCTURED_SCRIPT,
  READ_PAGE_DATA_SCRIPT,
  buildInteractElementScript,
  type EmbeddedWebInteractAction,
  type EmbeddedWebReadInclude,
  type EmbeddedWebStructuredTarget
} from "../../shared/embedded-web-scripts";
import { registerAssistantPageContextProvider } from "../services/assistantPageContext";
import { registerDesktopActionProviderForScope } from "../services/desktopActionRegistry";

type ExternalWebviewPageProps = {
  title: string;
  url: string;
  active?: boolean;
  surfaceId?: string;
  surfaceLabel?: string;
};

type ExternalWebviewTabState = {
  id: string;
  title: string;
  currentUrl: string;
  faviconUrl?: string;
  guestId: number | null;
  canGoBack: boolean;
  isLoading: boolean;
};

type ExternalWebviewBrowserState = {
  tabs: ExternalWebviewTabState[];
  activeTabId: string;
};

type ExternalWebviewTabPatch = Partial<Pick<
  ExternalWebviewTabState,
  "title" | "currentUrl" | "faviconUrl" | "guestId" | "canGoBack" | "isLoading"
>>;

type BookmarkMenuState =
  | { kind: "context"; bookmarkId: string; x: number; y: number }
  | { kind: "overflow"; x: number; y: number };

type BookmarkEditorState = {
  bookmarkId: string;
  value: string;
};

const WEBVIEW_PAGE_CONTEXT_SCRIPT = `(() => {
  const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const readMetaDescription = () => {
    const meta = document.querySelector('meta[name="description"], meta[property="og:description"]');
    return normalize(meta?.getAttribute("content") || "");
  };
  return {
    url: String(location.href || ""),
    title: normalize(document.title || ""),
    selectedText: normalize(getSelection()?.toString() || "").slice(0, 8000),
    metaDescription: readMetaDescription(),
    headings: Array.from(document.querySelectorAll("h1, h2, h3"))
      .map((node) => normalize(node.textContent || ""))
      .filter(Boolean)
      .slice(0, 24),
    bodyText: normalize(document.body?.innerText || "").slice(0, 40000)
  };
})()`;

const EMBEDDED_WEB_SCRIPT_MAX_BYTES = 256 * 1024;
const EMBEDDED_WEB_READ_INCLUDES = new Set<EmbeddedWebReadInclude>(["forms", "links", "images"]);
const EMBEDDED_WEB_STRUCTURED_TARGETS = new Set<EmbeddedWebStructuredTarget>(["tables", "lists", "forms", "links"]);
const EMBEDDED_WEB_INTERACT_ACTIONS = new Set<EmbeddedWebInteractAction>(["click", "fill", "scroll", "focus", "select"]);
const BOOKMARKS_STORAGE_KEY = "zenmind-desktop.external-webview.bookmarks";
const BOOKMARK_MENU_WIDTH = 306;
const BOOKMARK_MENU_MAX_HEIGHT = 340;

type ExternalWebviewPaneProps = {
  tab: ExternalWebviewTabState;
  active: boolean;
  onTabStateChange: (tabId: string, patch: ExternalWebviewTabPatch) => void;
  onWebviewRefChange: (tabId: string, webview: Electron.WebviewTag | null) => void;
};

function getFallbackTabTitle(defaultTitle: string, url: string) {
  const trimmedTitle = defaultTitle.trim();
  if (trimmedTitle) {
    return trimmedTitle;
  }

  try {
    const parsedUrl = new URL(url);
    return parsedUrl.hostname.replace(/^www\./u, "") || url;
  } catch {
    return url;
  }
}

function normalizeEditableUrl(rawValue: string) {
  const trimmedValue = rawValue.trim();
  if (!trimmedValue) {
    return null;
  }

  const normalizeParsedUrl = (parsedUrl: URL) => {
    return ["http:", "https:"].includes(parsedUrl.protocol) ? parsedUrl.toString() : null;
  };

  try {
    return normalizeParsedUrl(new URL(trimmedValue));
  } catch {
    try {
      return normalizeParsedUrl(new URL(`https://${trimmedValue}`));
    } catch {
      return null;
    }
  }
}

function getUtf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function readAllowedValues<T extends string>(
  value: unknown,
  allowedValues: Set<T>
) {
  const rawValues = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return rawValues
    .map((item) => String(item).trim())
    .filter((item): item is T => allowedValues.has(item as T));
}

function filterReadPageDataResult(result: unknown, includes: EmbeddedWebReadInclude[]) {
  if (!result || typeof result !== "object" || includes.length === 0) {
    return result;
  }
  const filtered = { ...(result as Record<string, unknown>) };
  if (!includes.includes("forms")) {
    delete filtered.forms;
    delete filtered.fields;
  }
  if (!includes.includes("links")) {
    delete filtered.links;
  }
  if (!includes.includes("images")) {
    delete filtered.images;
  }
  return filtered;
}

function filterStructuredResult(result: unknown, targets: EmbeddedWebStructuredTarget[]) {
  if (!result || typeof result !== "object" || targets.length === 0) {
    return result;
  }
  const filtered = { ...(result as Record<string, unknown>) };
  for (const key of ["tables", "lists", "forms", "links"] satisfies EmbeddedWebStructuredTarget[]) {
    if (!targets.includes(key)) {
      delete filtered[key];
    }
  }
  return filtered;
}

function getTabMonogram(title: string, url: string) {
  const source = title.trim() || getUrlDisplayLabel(url);
  const match = source.match(/[A-Za-z0-9\u4e00-\u9fa5]/u);
  return match ? match[0].toUpperCase() : "·";
}

function readEventString(event: Event, key: string) {
  const candidate = (event as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : "";
}

function readStoredBookmarks() {
  try {
    return normalizeStoredBookmarks(JSON.parse(window.localStorage.getItem(BOOKMARKS_STORAGE_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

function ArrowLeftIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M11.75 4.75 6.5 10l5.25 5.25" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M15.1 7.2A6 6 0 1 0 16 10" />
      <path d="M12.5 4.6h3.1v3.1" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="4.75" />
      <path d="m12 12 4.25 4.25" />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m10 2.75 2.23 4.52 4.99.72-3.61 3.52.85 4.97L10 14.14 5.54 16.48l.85-4.97L2.78 7.99l4.99-.72L10 2.75Z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 4.5v11M4.5 10h11" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m5.5 5.5 9 9m0-9-9 9" />
    </svg>
  );
}

function BookmarkOverflowIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m7.25 5.5 4.5 4.5-4.5 4.5" />
      <path d="m11.25 5.5 4.5 4.5-4.5 4.5" />
    </svg>
  );
}

type SiteIconProps = {
  title: string;
  url: string;
  faviconUrl?: string;
  className: string;
};

function SiteIcon({ title, url, faviconUrl, className }: SiteIconProps) {
  const normalizedFaviconUrl = normalizeFaviconUrl(faviconUrl, url);
  const [failedFaviconUrl, setFailedFaviconUrl] = useState<string | null>(null);
  const shouldShowFavicon = normalizedFaviconUrl && failedFaviconUrl !== normalizedFaviconUrl;

  useEffect(() => {
    setFailedFaviconUrl(null);
  }, [normalizedFaviconUrl]);

  if (shouldShowFavicon) {
    return (
      <span className={`${className} has-image`} aria-hidden="true">
        <img
          src={normalizedFaviconUrl}
          alt=""
          draggable={false}
          onError={() => setFailedFaviconUrl(normalizedFaviconUrl)}
        />
      </span>
    );
  }

  return (
    <span className={className} aria-hidden="true">
      {getTabMonogram(title, url)}
    </span>
  );
}

function getBookmarkMenuCoordinates(
  anchor: { left: number; top: number; right: number; bottom: number },
  options: { menuWidth?: number; menuMaxHeight?: number } = {}
) {
  const viewportWidth = window.innerWidth || BOOKMARK_MENU_WIDTH;
  const viewportHeight = window.innerHeight || BOOKMARK_MENU_MAX_HEIGHT;
  return getAnchoredBookmarkMenuCoordinates(
    anchor,
    { width: viewportWidth, height: viewportHeight },
    {
      menuWidth: options.menuWidth ?? BOOKMARK_MENU_WIDTH,
      menuMaxHeight: options.menuMaxHeight ?? BOOKMARK_MENU_MAX_HEIGHT
    }
  );
}

function areStringArraysEqual(first: string[], second: string[]) {
  return first.length === second.length && first.every((item, index) => item === second[index]);
}

function ExternalWebviewPane({
  tab,
  active,
  onTabStateChange,
  onWebviewRefChange
}: ExternalWebviewPaneProps) {
  const webviewRef = useRef<Electron.WebviewTag | null>(null);
  const initialSrcRef = useRef(tab.currentUrl);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) {
      return;
    }

    const syncFromWebview = (patch: ExternalWebviewTabPatch = {}) => {
      const nextPatch: ExternalWebviewTabPatch = { ...patch };

      try {
        nextPatch.guestId = webview.getWebContentsId();
      } catch {
        // Ignore until Electron attaches the underlying guest contents.
      }

      try {
        const nextUrl = webview.getURL();
        if (nextUrl) {
          nextPatch.currentUrl = nextUrl;
        }
      } catch {
        // Ignore until the webview has a committed navigation.
      }

      try {
        const nextTitle = webview.getTitle();
        if (nextTitle) {
          nextPatch.title = nextTitle;
        }
      } catch {
        // Ignore until the embedded page exposes a title.
      }

      try {
        nextPatch.canGoBack = webview.canGoBack();
      } catch {
        nextPatch.canGoBack = false;
      }

      try {
        nextPatch.isLoading = webview.isLoading();
      } catch {
        // Ignore while the guest contents are still booting.
      }

      onTabStateChange(tab.id, nextPatch);
    };

    const handleDomReady = () => {
      syncFromWebview();
    };
    const handleDidStartLoading = () => {
      syncFromWebview({ isLoading: true });
    };
    const handleDidStopLoading = () => {
      syncFromWebview({ isLoading: false });
    };
    const handleDidNavigate = (event: Event) => {
      const nextUrl = readEventString(event, "url");
      syncFromWebview(nextUrl ? { currentUrl: nextUrl, isLoading: false } : { isLoading: false });
    };
    const handleDidNavigateInPage = (event: Event) => {
      const nextUrl = readEventString(event, "url");
      syncFromWebview(nextUrl ? { currentUrl: nextUrl } : {});
    };
    const handlePageTitleUpdated = (event: Event) => {
      const nextTitle = readEventString(event, "title");
      syncFromWebview(nextTitle ? { title: nextTitle } : {});
    };
    const handlePageFaviconUpdated = (event: Event) => {
      const favicons = (event as Event & { favicons?: unknown }).favicons;
      const nextFaviconUrl = pickFirstSafeFaviconUrl(favicons, webview.getURL() || tab.currentUrl);
      if (nextFaviconUrl) {
        syncFromWebview({ faviconUrl: nextFaviconUrl });
      }
    };

    webview.addEventListener("dom-ready", handleDomReady);
    webview.addEventListener("did-start-loading", handleDidStartLoading);
    webview.addEventListener("did-stop-loading", handleDidStopLoading);
    webview.addEventListener("did-navigate", handleDidNavigate);
    webview.addEventListener("did-navigate-in-page", handleDidNavigateInPage);
    webview.addEventListener("page-title-updated", handlePageTitleUpdated);
    webview.addEventListener("page-favicon-updated", handlePageFaviconUpdated);
    syncFromWebview();

    return () => {
      webview.removeEventListener("dom-ready", handleDomReady);
      webview.removeEventListener("did-start-loading", handleDidStartLoading);
      webview.removeEventListener("did-stop-loading", handleDidStopLoading);
      webview.removeEventListener("did-navigate", handleDidNavigate);
      webview.removeEventListener("did-navigate-in-page", handleDidNavigateInPage);
      webview.removeEventListener("page-title-updated", handlePageTitleUpdated);
      webview.removeEventListener("page-favicon-updated", handlePageFaviconUpdated);
    };
  }, [onTabStateChange, tab.id]);

  return (
    <div
      className={`external-webview-panel${active ? " is-active" : ""}`}
      hidden={!active}
      aria-hidden={!active}
    >
      {createElement("webview", {
        ref: (node: Electron.WebviewTag | null) => {
          webviewRef.current = node;
          onWebviewRefChange(tab.id, node);
        },
        src: initialSrcRef.current,
        title: tab.title,
        className: "pan-frame external-webview-frame",
        allowpopups: "true",
        style: { width: "100%", height: "100%", border: "none" }
      })}
    </div>
  );
}

export function ExternalWebviewPage({ title, url, active, surfaceId, surfaceLabel }: ExternalWebviewPageProps) {
  const tabSequenceRef = useRef(0);
  const webviewRefs = useRef(new Map<string, Electron.WebviewTag>());
  const surfaceKeyRef = useRef(`${title}\u0000${url}`);
  const activeRef = useRef(active !== false);
  const surfaceVisibilityProps = active === undefined
    ? {}
    : {
        hidden: !active,
        "aria-hidden": !active
      };

  const createTab = (initialUrl: string, preferredTitle: string) => {
    tabSequenceRef.current += 1;
    return {
      id: `external-tab-${tabSequenceRef.current}`,
      title: getFallbackTabTitle(preferredTitle, initialUrl),
      currentUrl: initialUrl,
      faviconUrl: undefined,
      guestId: null,
      canGoBack: false,
      isLoading: true
    } satisfies ExternalWebviewTabState;
  };

  const createInitialBrowserState = () => {
    const initialTab = createTab(url, title);
    return {
      tabs: [initialTab],
      activeTabId: initialTab.id
    } satisfies ExternalWebviewBrowserState;
  };

  const [browserState, setBrowserState] = useState<ExternalWebviewBrowserState>(() => createInitialBrowserState());
  const [addressInputValue, setAddressInputValue] = useState(() => url);
  const [bookmarks, setBookmarks] = useState<ExternalWebviewBookmark[]>(() => readStoredBookmarks());
  const [bookmarkMenu, setBookmarkMenu] = useState<BookmarkMenuState | null>(null);
  const [bookmarkEditor, setBookmarkEditor] = useState<BookmarkEditorState | null>(null);
  const [bookmarksOverflowing, setBookmarksOverflowing] = useState(false);
  const [visibleBookmarkIds, setVisibleBookmarkIds] = useState<string[]>([]);
  const [tabsOverflowing, setTabsOverflowing] = useState(false);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [tabDragOffsetX, setTabDragOffsetX] = useState(0);
  const [draggingBookmarkId, setDraggingBookmarkId] = useState<string | null>(null);
  const [bookmarkDragOffsetX, setBookmarkDragOffsetX] = useState(0);
  const browserStateRef = useRef(browserState);
  const bookmarksRef = useRef(bookmarks);
  const tabsStripRef = useRef<HTMLDivElement | null>(null);
  const bookmarksListRef = useRef<HTMLDivElement | null>(null);
  const bookmarkMenuRef = useRef<HTMLDivElement | null>(null);
  const bookmarkEditorRef = useRef<HTMLFormElement | null>(null);
  const tabPointerDragRef = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    dragging: boolean;
  } | null>(null);
  const tabPointerCleanupRef = useRef<(() => void) | null>(null);
  const bookmarkPointerDragRef = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    dragging: boolean;
  } | null>(null);
  const bookmarkPointerCleanupRef = useRef<(() => void) | null>(null);
  const suppressTabClickRef = useRef(false);
  const suppressBookmarkClickRef = useRef(false);

  useEffect(() => {
    browserStateRef.current = browserState;
  }, [browserState]);

  useEffect(() => {
    bookmarksRef.current = bookmarks;
  }, [bookmarks]);

  useEffect(() => {
    activeRef.current = active !== false;
  }, [active]);

  useEffect(() => {
    const nextSurfaceKey = `${title}\u0000${url}`;
    if (surfaceKeyRef.current === nextSurfaceKey) {
      return;
    }
    surfaceKeyRef.current = nextSurfaceKey;
    webviewRefs.current.clear();
    setBrowserState(createInitialBrowserState());
    setAddressInputValue(url);
  }, [title, url]);

  const openTab = (
    nextUrl: string,
    preferredTitle = "",
    options: { afterTabId?: string | null } = {}
  ) => {
    const nextTab = createTab(nextUrl, preferredTitle);
    setBrowserState((currentState) => {
      const anchorTabId = options.afterTabId ?? currentState.activeTabId;
      const anchorIndex = currentState.tabs.findIndex((tab) => tab.id === anchorTabId);
      const insertionIndex = anchorIndex === -1 ? currentState.tabs.length : anchorIndex + 1;
      return {
        tabs: [
          ...currentState.tabs.slice(0, insertionIndex),
          nextTab,
          ...currentState.tabs.slice(insertionIndex)
        ],
        activeTabId: nextTab.id
      };
    });
    return nextTab;
  };

  const setActiveTab = (tabId: string) => {
    setBrowserState((currentState) => {
      if (currentState.activeTabId === tabId) {
        return currentState;
      }
      return {
        ...currentState,
        activeTabId: tabId
      };
    });
  };

  const clearTabPointerListeners = () => {
    tabPointerCleanupRef.current?.();
    tabPointerCleanupRef.current = null;
  };

  const finishTabPointerDrag = () => {
    const pointerDragState = tabPointerDragRef.current;
    if (pointerDragState?.dragging) {
      suppressTabClickRef.current = true;
      window.setTimeout(() => {
        suppressTabClickRef.current = false;
      }, 0);
    }
    clearTabPointerListeners();
    tabPointerDragRef.current = null;
    setDraggingTabId(null);
    setTabDragOffsetX(0);
  };

  const updateTabPointerDrag = (clientX: number, clientY: number) => {
    const pointerDragState = tabPointerDragRef.current;
    const tabsStrip = tabsStripRef.current;
    if (!pointerDragState || !tabsStrip) {
      return false;
    }

    const movedDistance = Math.abs(clientX - pointerDragState.startX) +
      Math.abs(clientY - pointerDragState.startY);
    if (!pointerDragState.dragging && movedDistance < 6) {
      return false;
    }

    pointerDragState.dragging = true;
    setDraggingTabId(pointerDragState.id);

    const tabElements = Array.from(
      tabsStrip.querySelectorAll<HTMLElement>("[data-tab-id]")
    ).filter((tabElement) => tabElement.dataset.tabId !== pointerDragState.id);
    const currentTabOrder = browserStateRef.current.tabs;
    let insertionIndex = currentTabOrder.length;
    for (const tabElement of tabElements) {
      const tabRect = tabElement.getBoundingClientRect();
      const targetTabId = tabElement.dataset.tabId;
      if (!tabRect) {
        continue;
      }

      if (clientX < tabRect.left + tabRect.width / 2) {
        const targetIndex = currentTabOrder.findIndex((tab) => tab.id === targetTabId);
        insertionIndex = targetIndex === -1 ? insertionIndex : targetIndex;
        break;
      }
    }

    const currentState = browserStateRef.current;
    const nextTabs = moveItemByIdToIndex(
      currentState.tabs,
      pointerDragState.id,
      insertionIndex
    );
    if (nextTabs !== currentState.tabs) {
      const nextState = {
        ...currentState,
        tabs: nextTabs
      };
      browserStateRef.current = nextState;
      setBrowserState(nextState);
      pointerDragState.startX = clientX;
      pointerDragState.startY = clientY;
      setTabDragOffsetX(0);
    } else {
      setTabDragOffsetX(clientX - pointerDragState.startX);
    }

    return true;
  };

  const handleTabPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (updateTabPointerDrag(event.clientX, event.clientY)) {
      event.preventDefault();
    }
  };

  const handleTabPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    tabId: string
  ) => {
    if (event.button !== 0) {
      return;
    }

    clearTabPointerListeners();
    tabPointerDragRef.current = {
      id: tabId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false
    };

    const document = event.currentTarget.ownerDocument;
    const handleDocumentPointerMove = (pointerEvent: PointerEvent) => {
      const pointerDragState = tabPointerDragRef.current;
      if (!pointerDragState || pointerEvent.pointerId !== pointerDragState.pointerId) {
        return;
      }

      if (updateTabPointerDrag(pointerEvent.clientX, pointerEvent.clientY)) {
        pointerEvent.preventDefault();
      }
    };
    const handleDocumentPointerEnd = (pointerEvent: PointerEvent) => {
      const pointerDragState = tabPointerDragRef.current;
      if (!pointerDragState || pointerEvent.pointerId !== pointerDragState.pointerId) {
        return;
      }

      finishTabPointerDrag();
    };

    document.addEventListener("pointermove", handleDocumentPointerMove, { passive: false });
    document.addEventListener("pointerup", handleDocumentPointerEnd);
    document.addEventListener("pointercancel", handleDocumentPointerEnd);
    tabPointerCleanupRef.current = () => {
      document.removeEventListener("pointermove", handleDocumentPointerMove);
      document.removeEventListener("pointerup", handleDocumentPointerEnd);
      document.removeEventListener("pointercancel", handleDocumentPointerEnd);
    };
  };

  useEffect(() => () => {
    clearTabPointerListeners();
  }, []);

  const handleTabStripWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!tabsOverflowing || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) {
      return;
    }

    event.currentTarget.scrollLeft += event.deltaY;
  };

  const closeTab = (tabId: string) => {
    webviewRefs.current.delete(tabId);
    setBrowserState((currentState) => {
      if (currentState.tabs.length <= 1) {
        return currentState;
      }

      const closingIndex = currentState.tabs.findIndex((tab) => tab.id === tabId);
      if (closingIndex === -1) {
        return currentState;
      }

      const remainingTabs = currentState.tabs.filter((tab) => tab.id !== tabId);
      const nextActiveTabId = currentState.activeTabId === tabId
        ? (remainingTabs[Math.max(0, closingIndex - 1)] ?? remainingTabs[0]).id
        : currentState.activeTabId;

      return {
        tabs: remainingTabs,
        activeTabId: nextActiveTabId
      };
    });
  };

  const handleTabStateChange = (tabId: string, patch: ExternalWebviewTabPatch) => {
    setBrowserState((currentState) => {
      let changed = false;
      const nextTabs = currentState.tabs.map((tab) => {
        if (tab.id !== tabId) {
          return tab;
        }

        const nextTab = {
          ...tab,
          ...patch
        };
        const sameTab =
          nextTab.title === tab.title &&
          nextTab.currentUrl === tab.currentUrl &&
          nextTab.faviconUrl === tab.faviconUrl &&
          nextTab.guestId === tab.guestId &&
          nextTab.canGoBack === tab.canGoBack &&
          nextTab.isLoading === tab.isLoading;
        if (sameTab) {
          return tab;
        }

        changed = true;
        return nextTab;
      });

      if (!changed) {
        return currentState;
      }

      return {
        ...currentState,
        tabs: nextTabs
      };
    });
  };

  useEffect(() => {
    return window.electronAPI.onWebviewOpenTab(({ sourceGuestId, url: nextUrl }) => {
      const currentState = browserStateRef.current;
      const sourceTab = currentState.tabs.find((tab) => tab.guestId === sourceGuestId);
      if (!sourceTab) {
        if (!activeRef.current) {
          return;
        }

        const activeTab = currentState.tabs.find((tab) => tab.id === currentState.activeTabId);
        const allowFallback = currentState.tabs.length === 1 || activeTab?.guestId == null;
        if (!allowFallback) {
          return;
        }
      }

      openTab(nextUrl, "", { afterTabId: sourceTab?.id });
    });
  }, []);

  const activeTab = browserState.tabs.find((tab) => tab.id === browserState.activeTabId) ?? browserState.tabs[0];

  const getActiveWebviewState = () => {
    const currentState = browserStateRef.current;
    const currentActiveTab = currentState.tabs.find((tab) => tab.id === currentState.activeTabId) ?? currentState.tabs[0];
    return {
      currentState,
      currentActiveTab,
      activeWebview: currentActiveTab ? webviewRefs.current.get(currentActiveTab.id) ?? null : null
    };
  };

  const serializeTab = (tab: ExternalWebviewTabState) => ({
    id: tab.id,
    title: tab.title,
    currentUrl: tab.currentUrl,
    faviconUrl: tab.faviconUrl,
    guestId: tab.guestId,
    canGoBack: tab.canGoBack,
    isLoading: tab.isLoading
  });

  const getEmbeddedWebSurfaceState = () => {
    const { currentState, currentActiveTab, activeWebview } = getActiveWebviewState();
    let webContentsId = currentActiveTab?.guestId ?? null;
    if (activeWebview) {
      try {
        webContentsId = activeWebview.getWebContentsId();
      } catch {
        // Keep the last synced guest id if Electron has not attached yet.
      }
    }
    const activeTabSnapshot = currentActiveTab ? serializeTab({
      ...currentActiveTab,
      guestId: webContentsId
    }) : null;
    return {
      surface: {
        id: surfaceId,
        label: surfaceLabel ?? title,
        url,
        active: activeRef.current,
        currentUrl: activeTabSnapshot?.currentUrl ?? url,
        title: activeTabSnapshot?.title ?? title,
        webContentsId
      },
      tabs: currentState.tabs.map((tab) => serializeTab(tab)),
      activeTab: activeTabSnapshot
    };
  };

  const readActivePageContext = async () => {
    const { currentActiveTab, activeWebview } = getActiveWebviewState();
    if (!currentActiveTab || !activeRef.current) {
      return null;
    }

    if (!activeWebview) {
      return {
        url: currentActiveTab.currentUrl,
        title: currentActiveTab.title,
        selectedText: "",
        metaDescription: "",
        headings: [],
        bodyText: ""
      } satisfies AssistantPageContext;
    }

    try {
      const webContentsId = activeWebview.getWebContentsId();
      const pageContext = await activeWebview.executeJavaScript(WEBVIEW_PAGE_CONTEXT_SCRIPT, true);
      return {
        url: typeof pageContext?.url === "string" ? pageContext.url : currentActiveTab.currentUrl,
        title: typeof pageContext?.title === "string" && pageContext.title
          ? pageContext.title
          : currentActiveTab.title,
        selectedText: typeof pageContext?.selectedText === "string" ? pageContext.selectedText : "",
        metaDescription: typeof pageContext?.metaDescription === "string" ? pageContext.metaDescription : "",
        headings: Array.isArray(pageContext?.headings)
          ? pageContext.headings.filter((item: unknown): item is string => typeof item === "string")
          : [],
        bodyText: typeof pageContext?.bodyText === "string" ? pageContext.bodyText : "",
        browserTarget: Number.isFinite(webContentsId)
          ? {
              kind: "webview",
              webContentsId,
              surfaceId,
              surfaceLabel: surfaceLabel ?? title,
              currentUrl: currentActiveTab.currentUrl
            }
          : undefined
      } satisfies AssistantPageContext;
    } catch {
      return {
        url: currentActiveTab.currentUrl,
        title: currentActiveTab.title,
        selectedText: "",
        metaDescription: "",
        headings: [],
        bodyText: ""
      } satisfies AssistantPageContext;
    }
  };

  useEffect(() => {
    if (active === false || !activeTab) {
      return undefined;
    }

    return registerAssistantPageContextProvider(async () => {
      return readActivePageContext();
    });
  }, [active, activeTab?.id, surfaceId, surfaceLabel, title]);

  useEffect(() => {
    if (active === false) {
      return undefined;
    }

    function readActionUrl(args: Record<string, unknown>) {
      const rawUrl = typeof args.url === "string"
        ? args.url
        : typeof args.href === "string"
          ? args.href
          : "";
      return normalizeEditableUrl(rawUrl);
    }

    function readTargetTabId(args: Record<string, unknown>) {
      return typeof args.tabId === "string" && args.tabId.trim()
        ? args.tabId.trim()
        : browserStateRef.current.activeTabId;
    }

    function requestTargetsDifferentSurface(args: Record<string, unknown>) {
      const targetSurfaceId = typeof args.surfaceId === "string" ? args.surfaceId.trim() : "";
      return Boolean(targetSurfaceId && surfaceId && targetSurfaceId !== surfaceId);
    }

    function embeddedError(code: string, message: string, details?: unknown) {
      return {
        ok: false,
        error: {
          code,
          message,
          ...(details === undefined ? {} : { details })
        }
      };
    }

    async function executeActiveWebviewScript(args: Record<string, unknown>, script: string) {
      if (getUtf8ByteLength(script) > EMBEDDED_WEB_SCRIPT_MAX_BYTES) {
        return embeddedError("script_too_large", "脚本超过内嵌网站执行大小限制。");
      }

      const tabId = readTargetTabId(args);
      const targetWebview = webviewRefs.current.get(tabId);
      if (!targetWebview) {
        return embeddedError("tab_unavailable", "目标内嵌网站标签页不可用。", { tabId });
      }

      const result = await targetWebview.executeJavaScript(script, true);
      return { ok: true, result };
    }

    return registerDesktopActionProviderForScope("embeddedWeb", async (request) => {
      if (!activeRef.current) {
        return null;
      }
      const args = request.args ?? {};
      if (requestTargetsDifferentSurface(args)) {
        return null;
      }

      switch (request.action) {
        case "desktop.embeddedWeb.getActiveSurface":
          return { ok: true, result: getEmbeddedWebSurfaceState() };
        case "desktop.embeddedWeb.getPageContext":
          return { ok: true, result: await readActivePageContext() };
        case "desktop.embeddedWeb.readPageData": {
          const response = await executeActiveWebviewScript(args, READ_PAGE_DATA_SCRIPT);
          if (!response.ok) {
            return response;
          }
          return {
            ok: true,
            result: filterReadPageDataResult(
              response.result,
              readAllowedValues(args.include, EMBEDDED_WEB_READ_INCLUDES)
            )
          };
        }
        case "desktop.embeddedWeb.extractStructured": {
          const response = await executeActiveWebviewScript(args, EXTRACT_STRUCTURED_SCRIPT);
          if (!response.ok) {
            return response;
          }
          return {
            ok: true,
            result: filterStructuredResult(
              response.result,
              readAllowedValues(args.targets, EMBEDDED_WEB_STRUCTURED_TARGETS)
            )
          };
        }
        case "desktop.embeddedWeb.interactElement": {
          const selector = typeof args.selector === "string" ? args.selector.trim() : "";
          const action = typeof args.action === "string" ? args.action.trim() : "";
          if (!selector || !EMBEDDED_WEB_INTERACT_ACTIONS.has(action as EmbeddedWebInteractAction)) {
            return embeddedError("invalid_args", "selector 和有效的 action 是必填项。", args);
          }
          return executeActiveWebviewScript(args, buildInteractElementScript({
            selector,
            action: action as EmbeddedWebInteractAction,
            value: typeof args.value === "string" ? args.value : args.value == null ? undefined : String(args.value)
          }));
        }
        case "desktop.embeddedWeb.executeScript": {
          const script = typeof args.script === "string" ? args.script : "";
          if (!script.trim()) {
            return embeddedError("invalid_script", "script 是必填项。");
          }
          return executeActiveWebviewScript(args, script);
        }
        case "desktop.embeddedWeb.navigate": {
          const nextUrl = readActionUrl(args);
          if (!nextUrl) {
            return embeddedError("invalid_url", "内嵌网站地址必须是 http 或 https URL。", args);
          }
          const tabId = readTargetTabId(args);
          const targetWebview = webviewRefs.current.get(tabId);
          if (!targetWebview) {
            return embeddedError("tab_unavailable", "目标内嵌网站标签页不可用。", { tabId });
          }
          await targetWebview.loadURL(nextUrl);
          setAddressInputValue(nextUrl);
          return { ok: true, result: { ...getEmbeddedWebSurfaceState(), navigatedUrl: nextUrl } };
        }
        case "desktop.embeddedWeb.reload": {
          const tabId = readTargetTabId(args);
          const targetWebview = webviewRefs.current.get(tabId);
          if (!targetWebview) {
            return embeddedError("tab_unavailable", "目标内嵌网站标签页不可用。", { tabId });
          }
          targetWebview.reload();
          return { ok: true, result: getEmbeddedWebSurfaceState() };
        }
        case "desktop.embeddedWeb.goBack": {
          const tabId = readTargetTabId(args);
          const targetWebview = webviewRefs.current.get(tabId);
          if (!targetWebview) {
            return embeddedError("tab_unavailable", "目标内嵌网站标签页不可用。", { tabId });
          }
          if (!targetWebview.canGoBack()) {
            return embeddedError("cannot_go_back", "当前内嵌网站标签页没有可后退的历史记录。", { tabId });
          }
          targetWebview.goBack();
          return { ok: true, result: getEmbeddedWebSurfaceState() };
        }
        case "desktop.embeddedWeb.openTab": {
          const nextUrl = readActionUrl(args);
          if (!nextUrl) {
            return embeddedError("invalid_url", "内嵌网站地址必须是 http 或 https URL。", args);
          }
          const preferredTitle = typeof args.title === "string" ? args.title : "";
          const nextTab = openTab(nextUrl, preferredTitle);
          return { ok: true, result: { ...getEmbeddedWebSurfaceState(), openedTab: serializeTab(nextTab) } };
        }
        case "desktop.embeddedWeb.closeTab": {
          const tabId = readTargetTabId(args);
          const currentState = browserStateRef.current;
          if (currentState.tabs.length <= 1) {
            return embeddedError("last_tab", "不能关闭最后一个内嵌网站标签页。", { tabId });
          }
          if (!currentState.tabs.some((tab) => tab.id === tabId)) {
            return embeddedError("tab_not_found", "未找到目标内嵌网站标签页。", { tabId });
          }
          setBrowserState((state) => {
            const targetIndex = state.tabs.findIndex((tab) => tab.id === tabId);
            if (targetIndex === -1 || state.tabs.length <= 1) {
              return state;
            }
            const nextTabs = state.tabs.filter((tab) => tab.id !== tabId);
            const nextActiveTabId = state.activeTabId === tabId
              ? nextTabs[Math.max(0, targetIndex - 1)]?.id ?? nextTabs[0].id
              : state.activeTabId;
            webviewRefs.current.delete(tabId);
            return {
              tabs: nextTabs,
              activeTabId: nextActiveTabId
            };
          });
          return { ok: true, result: { closedTabId: tabId } };
        }
        case "desktop.embeddedWeb.switchTab": {
          const tabId = readTargetTabId(args);
          if (!browserStateRef.current.tabs.some((tab) => tab.id === tabId)) {
            return embeddedError("tab_not_found", "未找到目标内嵌网站标签页。", { tabId });
          }
          setActiveTab(tabId);
          return { ok: true, result: { ...getEmbeddedWebSurfaceState(), activeTabId: tabId } };
        }
        default:
          return null;
      }
    });
  }, [active, activeTab?.id, surfaceId, surfaceLabel, title, url]);

  useEffect(() => {
    setAddressInputValue(activeTab?.currentUrl ?? url);
  }, [activeTab?.id, activeTab?.currentUrl, url]);

  useEffect(() => {
    const tabsStrip = tabsStripRef.current;
    if (!tabsStrip) {
      setTabsOverflowing(false);
      return undefined;
    }

    const measureOverflow = () => {
      setTabsOverflowing(tabsStrip.scrollWidth > tabsStrip.clientWidth + 2);
    };

    measureOverflow();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measureOverflow);
    resizeObserver?.observe(tabsStrip);
    window.addEventListener("resize", measureOverflow);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measureOverflow);
    };
  }, [browserState.tabs.length]);

  useEffect(() => {
    const tabsStrip = tabsStripRef.current;
    const activeTabId = activeTab?.id;
    if (!tabsStrip || !activeTabId) {
      return;
    }

    const activeTabElement = tabsStrip.querySelector<HTMLElement>(`[data-tab-id="${activeTabId}"]`);
    activeTabElement?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTab?.id, browserState.tabs.length]);

  useEffect(() => {
    try {
      window.localStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify(bookmarks));
    } catch {
      // Keep bookmark changes in memory when localStorage is not available.
    }
  }, [bookmarks]);

  useEffect(() => {
    const bookmarksList = bookmarksListRef.current;
    if (!bookmarksList) {
      setBookmarksOverflowing(false);
      setVisibleBookmarkIds([]);
      return undefined;
    }

    const measureOverflow = () => {
      const listRect = bookmarksList.getBoundingClientRect();
      const nextVisibleBookmarkIds = Array.from(
        bookmarksList.querySelectorAll<HTMLButtonElement>("[data-bookmark-id]")
      ).flatMap((button) => {
        const bookmarkId = button.dataset.bookmarkId;
        if (!bookmarkId) {
          return [];
        }

        const itemRect = button.getBoundingClientRect();
        return itemRect.left >= listRect.left - 1 && itemRect.right <= listRect.right + 1
          ? [bookmarkId]
          : [];
      });

      setVisibleBookmarkIds((currentVisibleIds) => areStringArraysEqual(currentVisibleIds, nextVisibleBookmarkIds)
        ? currentVisibleIds
        : nextVisibleBookmarkIds);
      setBookmarksOverflowing(bookmarksList.scrollWidth > bookmarksList.clientWidth + 2);
    };

    measureOverflow();
    const animationFrame = window.requestAnimationFrame(measureOverflow);
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measureOverflow);
    resizeObserver?.observe(bookmarksList);
    window.addEventListener("resize", measureOverflow);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measureOverflow);
    };
  }, [bookmarks]);

  useEffect(() => {
    if (bookmarks.length === 0) {
      return;
    }

    setBookmarks((currentBookmarks) => {
      let changed = false;
      const nextBookmarks = currentBookmarks.map((bookmark) => {
        const matchingTab = browserState.tabs.find((tab) => normalizeBookmarkUrl(tab.currentUrl) === bookmark.url);
        if (!matchingTab) {
          return bookmark;
        }

        const nextFaviconUrl = normalizeFaviconUrl(matchingTab.faviconUrl, bookmark.url) ?? bookmark.faviconUrl;
        const nextTitle = bookmark.customTitle
          ? bookmark.title
          : getFallbackBookmarkTitle(matchingTab.title, bookmark.url);
        if (nextFaviconUrl === bookmark.faviconUrl && nextTitle === bookmark.title) {
          return bookmark;
        }

        changed = true;
        return {
          ...bookmark,
          title: nextTitle,
          ...(nextFaviconUrl ? { faviconUrl: nextFaviconUrl } : {})
        };
      });

      return changed ? nextBookmarks : currentBookmarks;
    });
  }, [bookmarks.length, browserState.tabs]);

  useEffect(() => {
    if (!bookmarkMenu && !bookmarkEditor) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setBookmarkMenu(null);
        setBookmarkEditor(null);
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (
        target &&
        (bookmarkMenuRef.current?.contains(target) || bookmarkEditorRef.current?.contains(target))
      ) {
        return;
      }

      setBookmarkMenu(null);
      setBookmarkEditor(null);
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [bookmarkEditor, bookmarkMenu]);

  useEffect(() => {
    if (bookmarkMenu?.kind === "context" && !bookmarks.some((bookmark) => bookmark.id === bookmarkMenu.bookmarkId)) {
      setBookmarkMenu(null);
    }
  }, [bookmarkMenu, bookmarks]);

  const handleGoBack = () => {
    if (!activeTab?.canGoBack) {
      return;
    }

    const activeWebview = webviewRefs.current.get(activeTab.id);
    if (!activeWebview) {
      return;
    }

    try {
      if (activeWebview.canGoBack()) {
        activeWebview.goBack();
      }
    } catch {
      // Ignore transient guest-content errors while the active webview updates.
    }
  };

  const handleReload = () => {
    if (!activeTab) {
      return;
    }

    const activeWebview = webviewRefs.current.get(activeTab.id);
    if (!activeWebview) {
      return;
    }

    try {
      activeWebview.reload();
    } catch {
      // Ignore reload attempts before the guest contents are ready.
    }
  };

  const handleNavigateToInputUrl = () => {
    if (!activeTab) {
      return;
    }

    const normalizedUrl = normalizeEditableUrl(addressInputValue);
    if (!normalizedUrl) {
      setAddressInputValue(activeTab.currentUrl);
      return;
    }

    const activeWebview = webviewRefs.current.get(activeTab.id);
    if (!activeWebview) {
      setAddressInputValue(normalizedUrl);
      return;
    }

    void activeWebview.loadURL(normalizedUrl).then(() => {
      setAddressInputValue(normalizedUrl);
    }).catch(() => {
      setAddressInputValue(activeTab.currentUrl);
    });
  };

  const activeBookmarkUrl = activeTab ? normalizeBookmarkUrl(activeTab.currentUrl) : null;
  const activeBookmark = activeBookmarkUrl
    ? bookmarks.find((bookmark) => bookmark.url === activeBookmarkUrl) ?? null
    : null;

  const getRendererPlatform = () => window.navigator.platform || window.navigator.userAgent;

  const openBookmarkInNewTab = (bookmark: ExternalWebviewBookmark) => {
    openTab(bookmark.url, bookmark.title);
  };

  const handleToggleBookmark = () => {
    if (!activeTab || !activeBookmarkUrl) {
      return;
    }

    setBookmarks((currentBookmarks) => {
      const existing = currentBookmarks.find((bookmark) => bookmark.url === activeBookmarkUrl);
      if (existing) {
        return currentBookmarks.filter((bookmark) => bookmark.url !== activeBookmarkUrl);
      }

      const nextBookmark: ExternalWebviewBookmark = {
        id: createExternalWebviewBookmarkId(),
        title: getFallbackBookmarkTitle(activeTab.title, activeBookmarkUrl),
        url: activeBookmarkUrl,
        ...(normalizeFaviconUrl(activeTab.faviconUrl, activeBookmarkUrl)
          ? { faviconUrl: normalizeFaviconUrl(activeTab.faviconUrl, activeBookmarkUrl) ?? undefined }
          : {}),
        createdAt: Date.now()
      };
      return [nextBookmark, ...currentBookmarks].slice(0, MAX_EXTERNAL_WEBVIEW_BOOKMARKS);
    });
  };

  const handleOpenBookmark = (bookmark: ExternalWebviewBookmark, options: { newTab?: boolean } = {}) => {
    setBookmarkMenu(null);
    if (options.newTab) {
      openBookmarkInNewTab(bookmark);
      return;
    }

    if (!activeTab) {
      openBookmarkInNewTab(bookmark);
      return;
    }

    const activeWebview = webviewRefs.current.get(activeTab.id);
    if (!activeWebview) {
      openBookmarkInNewTab(bookmark);
      return;
    }

    void activeWebview.loadURL(bookmark.url).catch(() => {
      openBookmarkInNewTab(bookmark);
    });
  };

  const handleBookmarkClick = (event: ReactMouseEvent<HTMLButtonElement>, bookmark: ExternalWebviewBookmark) => {
    if (suppressBookmarkClickRef.current) {
      event.preventDefault();
      return;
    }

    const newTab = shouldOpenBookmarkInNewTab(event, getRendererPlatform());
    handleOpenBookmark(bookmark, { newTab });
  };

  const handleBookmarkAuxClick = (event: ReactMouseEvent<HTMLButtonElement>, bookmark: ExternalWebviewBookmark) => {
    if (!shouldOpenBookmarkInNewTab(event, getRendererPlatform())) {
      return;
    }

    event.preventDefault();
    handleOpenBookmark(bookmark, { newTab: true });
  };

  const moveBookmarkBeforeOrAfterTarget = (movedBookmarkId: string, targetBookmarkId: string) => {
    setBookmarks((currentBookmarks) => reorderItemsById(currentBookmarks, movedBookmarkId, targetBookmarkId));
  };

  const handleBookmarkDragStart = (event: ReactDragEvent<HTMLButtonElement>, bookmarkId: string) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", bookmarkId);
    setDraggingBookmarkId(bookmarkId);
    setBookmarkMenu(null);
  };

  const handleBookmarkDragOver = (event: ReactDragEvent<HTMLButtonElement>, targetBookmarkId: string) => {
    const movedBookmarkId = draggingBookmarkId || event.dataTransfer.getData("text/plain");
    if (!movedBookmarkId || movedBookmarkId === targetBookmarkId) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const handleBookmarkDrop = (event: ReactDragEvent<HTMLButtonElement>, targetBookmarkId: string) => {
    const movedBookmarkId = draggingBookmarkId || event.dataTransfer.getData("text/plain");
    if (movedBookmarkId && movedBookmarkId !== targetBookmarkId) {
      event.preventDefault();
      moveBookmarkBeforeOrAfterTarget(movedBookmarkId, targetBookmarkId);
    }
    setDraggingBookmarkId(null);
  };

  const clearBookmarkPointerListeners = () => {
    bookmarkPointerCleanupRef.current?.();
    bookmarkPointerCleanupRef.current = null;
  };

  const finishBookmarkPointerDrag = () => {
    const pointerDragState = bookmarkPointerDragRef.current;
    if (pointerDragState?.dragging) {
      suppressBookmarkClickRef.current = true;
      window.setTimeout(() => {
        suppressBookmarkClickRef.current = false;
      }, 0);
    }
    clearBookmarkPointerListeners();
    bookmarkPointerDragRef.current = null;
    setDraggingBookmarkId(null);
    setBookmarkDragOffsetX(0);
  };

  const updateBookmarkPointerDrag = (clientX: number, clientY: number) => {
    const pointerDragState = bookmarkPointerDragRef.current;
    const bookmarksList = bookmarksListRef.current;
    if (!pointerDragState || !bookmarksList) {
      return false;
    }

    const movedDistance = Math.abs(clientX - pointerDragState.startX) +
      Math.abs(clientY - pointerDragState.startY);
    if (!pointerDragState.dragging && movedDistance < 6) {
      return false;
    }

    pointerDragState.dragging = true;
    setDraggingBookmarkId(pointerDragState.id);

    const bookmarkButtons = Array.from(
      bookmarksList.querySelectorAll<HTMLButtonElement>("[data-bookmark-id]")
    ).filter((button) => button.dataset.bookmarkId !== pointerDragState.id);
    const currentBookmarks = bookmarksRef.current;
    let insertionIndex = currentBookmarks.length;
    for (const button of bookmarkButtons) {
      const buttonRect = button.getBoundingClientRect();
      const targetBookmarkId = button.dataset.bookmarkId;

      if (clientX < buttonRect.left + buttonRect.width / 2) {
        const targetIndex = currentBookmarks.findIndex((bookmark) => bookmark.id === targetBookmarkId);
        insertionIndex = targetIndex === -1 ? insertionIndex : targetIndex;
        break;
      }
    }

    const nextBookmarks = moveItemByIdToIndex(
      currentBookmarks,
      pointerDragState.id,
      insertionIndex
    );
    if (nextBookmarks !== currentBookmarks) {
      bookmarksRef.current = nextBookmarks;
      setBookmarks(nextBookmarks);
      pointerDragState.startX = clientX;
      pointerDragState.startY = clientY;
      setBookmarkDragOffsetX(0);
    } else {
      setBookmarkDragOffsetX(clientX - pointerDragState.startX);
    }

    return true;
  };

  const handleBookmarkPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (updateBookmarkPointerDrag(event.clientX, event.clientY)) {
      event.preventDefault();
    }
  };

  const handleBookmarkPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    bookmarkId: string
  ) => {
    if (event.button !== 0) {
      return;
    }

    clearBookmarkPointerListeners();
    setBookmarkMenu(null);
    bookmarkPointerDragRef.current = {
      id: bookmarkId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false
    };

    const document = event.currentTarget.ownerDocument;
    const handleDocumentPointerMove = (pointerEvent: PointerEvent) => {
      const pointerDragState = bookmarkPointerDragRef.current;
      if (!pointerDragState || pointerEvent.pointerId !== pointerDragState.pointerId) {
        return;
      }

      if (updateBookmarkPointerDrag(pointerEvent.clientX, pointerEvent.clientY)) {
        pointerEvent.preventDefault();
      }
    };
    const handleDocumentPointerEnd = (pointerEvent: PointerEvent) => {
      const pointerDragState = bookmarkPointerDragRef.current;
      if (!pointerDragState || pointerEvent.pointerId !== pointerDragState.pointerId) {
        return;
      }

      finishBookmarkPointerDrag();
    };

    document.addEventListener("pointermove", handleDocumentPointerMove, { passive: false });
    document.addEventListener("pointerup", handleDocumentPointerEnd);
    document.addEventListener("pointercancel", handleDocumentPointerEnd);
    bookmarkPointerCleanupRef.current = () => {
      document.removeEventListener("pointermove", handleDocumentPointerMove);
      document.removeEventListener("pointerup", handleDocumentPointerEnd);
      document.removeEventListener("pointercancel", handleDocumentPointerEnd);
    };
  };

  useEffect(() => () => {
    clearBookmarkPointerListeners();
  }, []);

  const handleBookmarkContextMenu = (
    event: ReactMouseEvent<HTMLButtonElement>,
    bookmark: ExternalWebviewBookmark
  ) => {
    event.preventDefault();
    const coordinates = getBookmarkMenuCoordinates(
      event.currentTarget.getBoundingClientRect(),
      { menuWidth: 220 }
    );
    setBookmarkEditor(null);
    setBookmarkMenu({
      kind: "context",
      bookmarkId: bookmark.id,
      ...coordinates
    });
  };

  const handleOpenOverflowMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const coordinates = getBookmarkMenuCoordinates({
      left: rect.right - BOOKMARK_MENU_WIDTH,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom
    });
    setBookmarkEditor(null);
    setBookmarkMenu({
      kind: "overflow",
      ...coordinates
    });
  };

  const handleStartRenameBookmark = (bookmark: ExternalWebviewBookmark) => {
    setBookmarkMenu(null);
    setBookmarkEditor({
      bookmarkId: bookmark.id,
      value: bookmark.title
    });
  };

  const handleDeleteBookmark = (bookmark: ExternalWebviewBookmark) => {
    setBookmarkMenu(null);
    setBookmarks((currentBookmarks) => currentBookmarks.filter((item) => item.id !== bookmark.id));
  };

  const handleSaveBookmarkRename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!bookmarkEditor) {
      return;
    }

    setBookmarks((currentBookmarks) => currentBookmarks.map((bookmark) => {
      if (bookmark.id !== bookmarkEditor.bookmarkId) {
        return bookmark;
      }

      return {
        ...bookmark,
        title: getFallbackBookmarkTitle(bookmarkEditor.value, bookmark.url),
        customTitle: true
      };
    }));
    setBookmarkEditor(null);
  };

  const contextMenuBookmark = bookmarkMenu?.kind === "context"
    ? bookmarks.find((bookmark) => bookmark.id === bookmarkMenu.bookmarkId) ?? null
    : null;
  const editingBookmark = bookmarkEditor
    ? bookmarks.find((bookmark) => bookmark.id === bookmarkEditor.bookmarkId) ?? null
    : null;
  const overflowBookmarks = bookmarksOverflowing ? getItemsHiddenByVisibleIds(bookmarks, visibleBookmarkIds) : [];
  const showBookmarkOverflow = overflowBookmarks.length > 0;
  const bookmarkMenuNode = bookmarkMenu ? (
    <div
      ref={bookmarkMenuRef}
      className={`external-webview-bookmark-menu is-${bookmarkMenu.kind}`}
      style={{ left: bookmarkMenu.x, top: bookmarkMenu.y }}
      role="menu"
      aria-label={bookmarkMenu.kind === "overflow" ? "更多收藏" : "收藏操作"}
    >
      {bookmarkMenu.kind === "overflow" ? (
        overflowBookmarks.map((bookmark) => (
          <div className="external-webview-bookmark-menu-row" key={bookmark.id} role="none">
            <button
              type="button"
              className={`external-webview-bookmark-menu-item is-bookmark${
                draggingBookmarkId === bookmark.id ? " is-dragging" : ""
              }`}
              draggable
              onClick={() => handleOpenBookmark(bookmark)}
              onContextMenu={(event) => handleBookmarkContextMenu(event, bookmark)}
              onDragStart={(event) => handleBookmarkDragStart(event, bookmark.id)}
              onDragOver={(event) => handleBookmarkDragOver(event, bookmark.id)}
              onDrop={(event) => handleBookmarkDrop(event, bookmark.id)}
              onDragEnd={() => setDraggingBookmarkId(null)}
              role="menuitem"
            >
              <SiteIcon
                className="external-webview-bookmark-menu-icon"
                title={bookmark.title}
                url={bookmark.url}
                faviconUrl={bookmark.faviconUrl}
              />
              <span>{bookmark.title}</span>
            </button>
            <button
              type="button"
              className="external-webview-bookmark-menu-action"
              onClick={() => handleOpenBookmark(bookmark, { newTab: true })}
              role="menuitem"
              aria-label={`在新标签页打开 ${bookmark.title}`}
            >
              新
            </button>
            <button
              type="button"
              className="external-webview-bookmark-menu-action"
              onClick={() => handleStartRenameBookmark(bookmark)}
              role="menuitem"
              aria-label={`重命名 ${bookmark.title}`}
            >
              改
            </button>
            <button
              type="button"
              className="external-webview-bookmark-menu-action is-danger"
              onClick={() => handleDeleteBookmark(bookmark)}
              role="menuitem"
              aria-label={`删除 ${bookmark.title}`}
            >
              删
            </button>
          </div>
        ))
      ) : contextMenuBookmark ? (
        <>
          <button
            type="button"
            className="external-webview-bookmark-menu-item"
            onClick={() => handleOpenBookmark(contextMenuBookmark)}
            role="menuitem"
          >
            打开
          </button>
          <button
            type="button"
            className="external-webview-bookmark-menu-item"
            onClick={() => handleOpenBookmark(contextMenuBookmark, { newTab: true })}
            role="menuitem"
          >
            在新标签页打开
          </button>
          <span className="external-webview-bookmark-menu-separator" role="separator" />
          <button
            type="button"
            className="external-webview-bookmark-menu-item"
            onClick={() => handleStartRenameBookmark(contextMenuBookmark)}
            role="menuitem"
          >
            重命名
          </button>
          <button
            type="button"
            className="external-webview-bookmark-menu-item is-danger"
            onClick={() => handleDeleteBookmark(contextMenuBookmark)}
            role="menuitem"
          >
            删除
          </button>
        </>
      ) : null}
    </div>
  ) : null;
  const bookmarkEditorNode = bookmarkEditor && editingBookmark ? (
    <div className="external-webview-bookmark-editor-backdrop" role="presentation">
      <form
        ref={bookmarkEditorRef}
        className="external-webview-bookmark-editor"
        onSubmit={handleSaveBookmarkRename}
        role="dialog"
        aria-modal="true"
        aria-label="重命名收藏"
      >
        <label htmlFor="external-webview-bookmark-editor-input">名称</label>
        <input
          id="external-webview-bookmark-editor-input"
          value={bookmarkEditor.value}
          autoFocus
          onChange={(event) => setBookmarkEditor({
            bookmarkId: bookmarkEditor.bookmarkId,
            value: event.target.value
          })}
        />
        <p>{getUrlDisplayLabel(editingBookmark.url)}</p>
        <div className="external-webview-bookmark-editor-actions">
          <button type="button" onClick={() => setBookmarkEditor(null)}>
            取消
          </button>
          <button type="submit">
            保存
          </button>
        </div>
      </form>
    </div>
  ) : null;

  return (
    <>
    <section className="pan-page external-webview-page" {...surfaceVisibilityProps}>
      <div className="pan-drag-region" aria-hidden="true" />
      <div className="external-webview-browser-chrome">
        <div className="external-webview-tabbar">
          <div
            className={`external-webview-tab-strip${tabsOverflowing ? " is-overflowing" : ""}`}
            ref={tabsStripRef}
            role="tablist"
            aria-label="嵌入网页标签页"
            onWheel={handleTabStripWheel}
            onPointerMove={handleTabPointerMove}
            onPointerUp={finishTabPointerDrag}
            onPointerCancel={finishTabPointerDrag}
          >
            {browserState.tabs.map((tab) => {
              const isActive = tab.id === browserState.activeTabId;
              const canClose = browserState.tabs.length > 1;
              return (
                <div
                  key={tab.id}
                  className={`external-webview-tab${isActive ? " is-active" : ""}${
                    draggingTabId === tab.id ? " is-dragging" : ""
                  }`}
                  data-tab-id={tab.id}
                  style={draggingTabId === tab.id ? { transform: `translateX(${tabDragOffsetX}px)` } : undefined}
                  role="presentation"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className="external-webview-tab-trigger"
                    onClick={(event) => {
                      if (suppressTabClickRef.current) {
                        event.preventDefault();
                        return;
                      }
                      setActiveTab(tab.id);
                    }}
                    onPointerDown={(event) => handleTabPointerDown(event, tab.id)}
                  >
                    {tab.isLoading ? (
                      <span className="external-webview-tab-favicon is-loading" aria-hidden="true">
                        <span className="external-webview-tab-favicon-spinner" />
                      </span>
                    ) : (
                      <SiteIcon
                        className="external-webview-tab-favicon"
                        title={tab.title}
                        url={tab.currentUrl}
                        faviconUrl={tab.faviconUrl}
                      />
                    )}
                    <span className="external-webview-tab-title">{tab.title}</span>
                  </button>
                  {canClose ? (
                    <button
                      type="button"
                      className="external-webview-tab-close"
                      onClick={(event) => {
                        event.stopPropagation();
                        closeTab(tab.id);
                      }}
                      aria-label={`关闭 ${tab.title}`}
                    >
                      <CloseIcon />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
          <button
            type="button"
            className="external-webview-tab-add"
            onClick={() => openTab(url, title)}
            aria-label="新建标签页"
            title="新建标签页"
          >
            <PlusIcon />
          </button>
        </div>
        <div className="external-webview-toolbar">
          <div className="external-webview-toolbar-actions">
            <button
              type="button"
              className="external-webview-toolbar-button"
              onClick={handleGoBack}
              disabled={!activeTab?.canGoBack}
              aria-label="后退"
              title="后退"
            >
              <ArrowLeftIcon />
            </button>
            <button
              type="button"
              className="external-webview-toolbar-button"
              onClick={handleReload}
              aria-label="刷新"
              title="刷新"
            >
              <RefreshIcon />
            </button>
          </div>
          <div className="external-webview-toolbar-location">
            <span className="external-webview-toolbar-location-icon" aria-hidden="true">
              <SearchIcon />
            </span>
            <input
              type="text"
              className="external-webview-toolbar-location-input"
              value={addressInputValue}
              onChange={(event) => {
                setAddressInputValue(event.target.value);
              }}
              onBlur={() => {
                setAddressInputValue(activeTab?.currentUrl ?? url);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") {
                  return;
                }
                event.preventDefault();
                handleNavigateToInputUrl();
              }}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="none"
              placeholder="搜索或输入网址"
              aria-label="网页地址"
            />
          </div>
          <button
            type="button"
            className={`external-webview-bookmark-toggle${activeBookmark ? " is-active" : ""}`}
            onClick={handleToggleBookmark}
            disabled={!activeBookmarkUrl}
            aria-label={activeBookmark ? "取消收藏当前页" : "收藏当前页"}
            title={activeBookmark ? "取消收藏当前页" : "收藏当前页"}
          >
            <StarIcon />
          </button>
        </div>
        <div className="external-webview-bookmarks-bar" aria-label="收藏栏">
          <div
            className="external-webview-bookmarks-list"
            ref={bookmarksListRef}
            onPointerMove={handleBookmarkPointerMove}
            onPointerUp={finishBookmarkPointerDrag}
            onPointerCancel={finishBookmarkPointerDrag}
          >
              {bookmarks.length === 0 ? (
                <span className="external-webview-bookmark-empty">收藏会显示在这里</span>
              ) : (
                bookmarks.map((bookmark) => (
                  <button
                    type="button"
                    className={`external-webview-bookmark-item${
                      draggingBookmarkId === bookmark.id ? " is-dragging" : ""
                    }`}
                    key={bookmark.id}
                    data-bookmark-id={bookmark.id}
                    style={draggingBookmarkId === bookmark.id
                      ? { transform: `translateX(${bookmarkDragOffsetX}px)` }
                      : undefined}
                    onClick={(event) => handleBookmarkClick(event, bookmark)}
                    onAuxClick={(event) => handleBookmarkAuxClick(event, bookmark)}
                    onContextMenu={(event) => handleBookmarkContextMenu(event, bookmark)}
                    onPointerDown={(event) => handleBookmarkPointerDown(event, bookmark.id)}
                    title={bookmark.url}
                  >
                    <SiteIcon
                      className="external-webview-bookmark-icon"
                      title={bookmark.title}
                      url={bookmark.url}
                      faviconUrl={bookmark.faviconUrl}
                    />
                    <span className="external-webview-bookmark-label">{bookmark.title}</span>
                  </button>
                ))
              )}
          </div>
            {showBookmarkOverflow ? (
              <button
                type="button"
                className="external-webview-bookmark-overflow"
                onClick={handleOpenOverflowMenu}
                aria-label="显示更多收藏"
                title="显示更多收藏"
              >
                <BookmarkOverflowIcon />
              </button>
            ) : null}
        </div>
        </div>
      <div className="pan-frame-shell external-webview-frame-shell">
        {browserState.tabs.map((tab) => (
          <ExternalWebviewPane
            key={tab.id}
            tab={tab}
            active={tab.id === browserState.activeTabId}
            onTabStateChange={handleTabStateChange}
            onWebviewRefChange={(tabId, webview) => {
              if (webview) {
                webviewRefs.current.set(tabId, webview);
                return;
              }
              webviewRefs.current.delete(tabId);
            }}
          />
        ))}
      </div>
    </section>
    {bookmarkMenuNode ? createPortal(bookmarkMenuNode, document.body) : null}
    {bookmarkEditorNode ? createPortal(bookmarkEditorNode, document.body) : null}
    </>
  );
}
