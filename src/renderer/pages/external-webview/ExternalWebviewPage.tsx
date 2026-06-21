import { createElement, useEffect, useRef, useState } from "react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent
} from "react";
import { useLocation } from "react-router-dom";
import type { AssistantPageContext } from "../../../shared/contracts";
import {
  EXTRACT_STRUCTURED_SCRIPT,
  READ_PAGE_DATA_SCRIPT,
  buildFillFormScript,
  buildInteractElementScript,
  buildSubmitFormScript,
  type EmbeddedWebInteractAction,
  type EmbeddedWebReadInclude,
  type EmbeddedWebStructuredTarget
} from "../../../shared/embedded-web-scripts";
import { registerAssistantPageContextProvider } from "../../copilot/page-context/assistantPageContext";
import {
  getCurrentPageContextSnapshot,
  publishCurrentPageContextSnapshot,
  subscribeCurrentPageContext
} from "../../services/currentPageContext";
import {
  registerCurrentPageExecutor,
  registerDesktopActionProviderForScope
} from "../../services/desktopActionRegistry";
import { useI18n } from "../../i18n/useI18n";
import {
  EMBEDDED_WEB_INTERACT_ACTIONS,
  EMBEDDED_WEB_READ_INCLUDES,
  EMBEDDED_WEB_SCRIPT_MAX_BYTES,
  EMBEDDED_WEB_STRUCTURED_TARGETS,
  filterReadPageDataResult,
  filterStructuredResult,
  getUtf8ByteLength,
  readActionSelector,
  readAllowedValues,
  readFormFields
} from "../../copilot/page-context/embeddedWebActions";

type ExternalWebviewPageProps = {
  title: string;
  url: string;
  active?: boolean | undefined;
  surfaceId?: string;
  surfaceLabel?: string;
  chrome?: "browser" | "app";
  partition?: string;
};

type EmbeddedWebScriptResult =
  | { ok: true; result: unknown }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        details?: unknown;
      };
    };
type EmbeddedWebScriptError = Extract<EmbeddedWebScriptResult, { ok: false }>;

type ExternalWebviewTabState = {
  id: string;
  title: string;
  currentUrl: string;
  faviconUrl?: string;
  partition?: string;
  userAgent?: string;
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

const BLANK_EXTERNAL_WEBVIEW_URL = "about:blank";
const SAFE_DATA_IMAGE_PATTERN = /^data:image\/(?:png|jpe?g|gif|webp|bmp|x-icon|vnd\.microsoft\.icon);/iu;

type ExternalWebviewPaneProps = {
  tab: ExternalWebviewTabState;
  active: boolean;
  surfaceId?: string;
  surfaceLabel?: string;
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

function shouldRefreshWebviewAfterDesktopSso(value: string) {
  try {
    const parsedUrl = new URL(value);
    if (parsedUrl.pathname === "/auth/oauth2/authorize") {
      return true;
    }
    const hash = parsedUrl.hash.toLowerCase();
    if (!hash.startsWith("#/login") && !hash.startsWith("#/prevent")) {
      return false;
    }
    return parsedUrl.hash.includes("service=");
  } catch {
    return false;
  }
}

function defaultDesktopPageDebugArgs(action: string) {
  switch (action) {
    case "desktop.page.readCurrent":
      return { include: ["forms", "links", "images"] };
    case "desktop.page.extractStructured":
      return { targets: ["tables", "lists", "forms", "links"] };
    case "desktop.page.interact":
      return { selector: "", action: "click", value: "" };
    case "desktop.page.fillForm":
      return { formSelector: "", fields: [{ selector: "", value: "", action: "fill" }] };
    case "desktop.page.submitForm":
      return { formSelector: "", submitSelector: "" };
    default:
      return {};
  }
}

function formatDebugJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function getTabMonogram(title: string, url: string) {
  const source = title.trim() || getUrlDisplayLabel(url);
  const match = source.match(/[A-Za-z0-9\u4e00-\u9fa5]/u);
  return match ? match[0].toUpperCase() : "·";
}

function readEventString(event: Event, key: string) {
  const candidate = (event as unknown as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : "";
}

function getUrlDisplayLabel(url: string) {
  try {
    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname === "/" ? "" : parsedUrl.pathname;
    return `${parsedUrl.hostname}${pathname}` || url;
  } catch {
    return url;
  }
}

function normalizeFaviconUrl(inputUrl: unknown, baseUrl?: string | null) {
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

function pickFirstSafeFaviconUrl(favicons: unknown, baseUrl?: string | null) {
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

function moveItemByIdToIndex<T extends { id: string }>(items: T[], movedId: string, targetIndex: number) {
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

function getEditableAddressInputValue(value: string) {
  return value === BLANK_EXTERNAL_WEBVIEW_URL ? "" : value;
}

function ExternalWebviewPane({
  tab,
  active,
  surfaceId,
  surfaceLabel,
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
      let nextWebContentsId: number | null = null;

      try {
        nextWebContentsId = webview.getWebContentsId();
        nextPatch.guestId = nextWebContentsId;
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
  }, [onTabStateChange, tab.currentUrl, tab.id]);

  return (
    <div
      className={`external-webview-panel${active ? " is-active" : ""}`}
      hidden={!active}
      aria-hidden={!active}
    >
      {createElement("webview", {
        ref: (node: Electron.WebviewTag | null): void => {
          webviewRef.current = node;
          onWebviewRefChange(tab.id, node);
        },
        src: initialSrcRef.current,
        title: tab.title,
        className: "embedded-surface-frame external-webview-frame",
        allowpopups: "true",
        partition: tab.partition,
        useragent: tab.userAgent,
        style: { width: "100%", height: "100%", border: "none" }
      })}
    </div>
  );
}

export function ExternalWebviewPage({
  title,
  url,
  active,
  surfaceId,
  surfaceLabel,
  chrome = "browser",
  partition
}: ExternalWebviewPageProps) {
  const { t } = useI18n();
  const location = useLocation();
  const currentRoute = `${location.pathname}${location.search}`;
  const appChrome = chrome === "app";
  const tabSequenceRef = useRef(0);
  const webviewRefs = useRef(new Map<string, Electron.WebviewTag>());
  const surfaceKeyRef = useRef(`${title}\u0000${url}\u0000${partition || ""}`);
  const activeRef = useRef(active !== false);
  const surfaceClassName = [
    "embedded-surface-page external-webview-page",
    appChrome ? "is-app-surface" : "",
    active === false ? "is-inactive-surface" : ""
  ].filter(Boolean).join(" ");
  const surfaceVisibilityProps = active === undefined
    ? {}
    : {
        "aria-hidden": active === false
      };

  const createTab = (
    initialUrl: string,
    preferredTitle: string,
    options: { partition?: string; userAgent?: string } = {}
  ) => {
    tabSequenceRef.current += 1;
    return {
      id: `external-tab-${tabSequenceRef.current}`,
      title: getFallbackTabTitle(preferredTitle, initialUrl),
      currentUrl: initialUrl,
      faviconUrl: undefined,
      partition: options.partition ?? partition,
      userAgent: options.userAgent,
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
  const [debugSidebarOpen, setDebugSidebarOpen] = useState(false);
  const [debugActions, setDebugActions] = useState<string[]>([]);
  const [debugAction, setDebugAction] = useState("desktop.page.readCurrent");
  const [debugArgsJson, setDebugArgsJson] = useState(formatDebugJson(defaultDesktopPageDebugArgs("desktop.page.readCurrent")));
  const [debugResultJson, setDebugResultJson] = useState("");
  const [debugPending, setDebugPending] = useState(false);
  const [debugSnapshot, setDebugSnapshot] = useState(getCurrentPageContextSnapshot());
  const [tabsOverflowing, setTabsOverflowing] = useState(false);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [tabDragOffsetX, setTabDragOffsetX] = useState(0);
  const browserStateRef = useRef(browserState);
  const tabsStripRef = useRef<HTMLDivElement | null>(null);
  const tabPointerDragRef = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    dragging: boolean;
  } | null>(null);
  const tabPointerCleanupRef = useRef<(() => void) | null>(null);
  const suppressTabClickRef = useRef(false);

  useEffect(() => {
    browserStateRef.current = browserState;
  }, [browserState]);

  useEffect(() => {
    activeRef.current = active !== false;
  }, [active]);

  useEffect(() => {
    const nextSurfaceKey = `${title}\u0000${url}\u0000${partition || ""}`;
    if (surfaceKeyRef.current === nextSurfaceKey) {
      return;
    }
    surfaceKeyRef.current = nextSurfaceKey;
    webviewRefs.current.clear();
    setBrowserState(createInitialBrowserState());
    setAddressInputValue(url);
  }, [title, url, partition]);

  const openTab = (
    nextUrl: string,
    preferredTitle = "",
    options: { afterTabId?: string | null; partition?: string; userAgent?: string } = {}
  ) => {
    const nextTab = createTab(nextUrl, preferredTitle, {
      partition: options.partition,
      userAgent: options.userAgent
    });
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
    return window.electronAPI.onWebviewOpenTab(({ sourceGuestId, url: nextUrl, partition, userAgent }) => {
      if (appChrome) {
        return;
      }
      const currentState = browserStateRef.current;
      const sourceTab = currentState.tabs.find((tab) => tab.guestId === sourceGuestId);
      const isHostOpenRequest = sourceGuestId < 0;
      if (isHostOpenRequest) {
        if (!activeRef.current) {
          return;
        }

        openTab(nextUrl, "", {
          partition,
          userAgent
        });
        return;
      }

      if (!sourceTab) {
        if (!activeRef.current) {
          return;
        }

        const activeTab = currentState.tabs.find((tab) => tab.id === currentState.activeTabId);
        const allowFallback = currentState.tabs.length === 1 || activeTab?.guestId == null;
        if (!allowFallback) {
          return;
        }
        openTab(nextUrl, "", {
          partition: activeTab?.partition,
          userAgent: activeTab?.userAgent
        });
        return;
      }

      openTab(nextUrl, "", {
        afterTabId: sourceTab.id,
        partition: sourceTab.partition,
        userAgent: sourceTab.userAgent
      });
    });
  }, [appChrome, partition]);

  useEffect(() => {
    if (!window.electronAPI.sso?.onStatusChanged) {
      return undefined;
    }
    return window.electronAPI.sso.onStatusChanged((status) => {
      if (!status.authenticated) {
        return;
      }
      for (const tab of browserStateRef.current.tabs) {
        const currentUrl = tab.currentUrl;
        if (!shouldRefreshWebviewAfterDesktopSso(currentUrl)) {
          continue;
        }
        const webview = webviewRefs.current.get(tab.id);
        if (!webview) {
          continue;
        }
        try {
          webview.reload();
        } catch {
          // Ignore transient guest-content errors while the active webview updates.
        }
      }
    });
  }, []);

  const activeTab = browserState.tabs.find((tab) => tab.id === browserState.activeTabId) ?? browserState.tabs[0];

  useEffect(() => {
    return subscribeCurrentPageContext((snapshot) => {
      setDebugSnapshot(snapshot);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.desktopActions.list().then((response) => {
      if (cancelled || !response.ok) {
        return;
      }
      const pageActions = response.actions
        .map((action) => action.name)
        .filter((name) => name.startsWith("desktop.page."));
      setDebugActions(pageActions);
      if (pageActions.length > 0 && !pageActions.includes(debugAction)) {
        const nextAction = pageActions.includes("desktop.page.readCurrent") ? "desktop.page.readCurrent" : pageActions[0];
        setDebugAction(nextAction);
        setDebugArgsJson(formatDebugJson(defaultDesktopPageDebugArgs(nextAction)));
      }
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [debugAction]);

  function handleSelectDebugAction(nextAction: string) {
    setDebugAction(nextAction);
    setDebugArgsJson(formatDebugJson(defaultDesktopPageDebugArgs(nextAction)));
  }

  async function executeDebugAction() {
    setDebugPending(true);
    const startedAt = performance.now();
    try {
      const args = debugArgsJson.trim() ? JSON.parse(debugArgsJson) as Record<string, unknown> : {};
      const response = await window.electronAPI.desktopActions.call({
        action: debugAction,
        args,
        source: {
          agentKey: "manual_debug"
        },
        permissionMode: "full_access",
        expectedPageKey: debugSnapshot?.pageKey
      });
      setDebugResultJson(formatDebugJson({
        elapsedMs: Math.round(performance.now() - startedAt),
        request: {
          action: debugAction,
          args,
          expectedPageKey: debugSnapshot?.pageKey
        },
        response
      }));
    } catch (error) {
      setDebugResultJson(formatDebugJson({
        elapsedMs: Math.round(performance.now() - startedAt),
        error: error instanceof Error ? error.message : String(error)
      }));
    } finally {
      setDebugPending(false);
    }
  }

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

  function embeddedError(code: string, message: string, details?: unknown): EmbeddedWebScriptError {
    return {
      ok: false as const,
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details })
      }
    };
  }

  function readTargetTabId(args: Record<string, unknown>) {
    return typeof args.tabId === "string" && args.tabId.trim()
      ? args.tabId.trim()
      : browserStateRef.current.activeTabId;
  }

  async function executeActiveWebviewScript(
    args: Record<string, unknown>,
    script: string
  ): Promise<EmbeddedWebScriptResult> {
    if (getUtf8ByteLength(script) > EMBEDDED_WEB_SCRIPT_MAX_BYTES) {
      return embeddedError("script_too_large", t("externalWebview.error.scriptTooLarge"));
    }

    const tabId = readTargetTabId(args);
    const targetWebview = webviewRefs.current.get(tabId);
    if (!targetWebview) {
      return embeddedError("tab_unavailable", t("externalWebview.error.tabUnavailable"), { tabId });
    }

    try {
      const result = await targetWebview.executeJavaScript(script, true);
      return { ok: true as const, result };
    } catch (error) {
      return {
        ok: false as const,
        error: {
          code: "webview_execution_failed",
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

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
        browserTarget: {
          kind: "webview",
          surfaceId,
          surfaceLabel: surfaceLabel ?? title,
          surfaceRoute: currentRoute,
          currentUrl: currentActiveTab.currentUrl
        }
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

  const createCurrentPageDescriptor = () => {
    const { currentActiveTab, activeWebview } = getActiveWebviewState();
    let webContentsId = currentActiveTab?.guestId ?? undefined;
    if (activeWebview) {
      try {
        const nextWebContentsId = activeWebview.getWebContentsId();
        if (Number.isFinite(nextWebContentsId)) {
          webContentsId = nextWebContentsId;
        }
      } catch {
        // Keep the last synced guest id if Electron has not attached yet.
      }
    }
    return {
      route: currentRoute,
      pageKey: `webview:${currentRoute}:${surfaceId || url}:${currentActiveTab?.id ?? "default"}`,
      pageKind: "webview" as const,
      ...(surfaceId ? { surfaceId } : {}),
      ...(surfaceLabel || title ? { surfaceLabel: surfaceLabel ?? title } : {}),
      ...(currentRoute ? { surfaceRoute: currentRoute } : {}),
      ...(typeof webContentsId === "number" ? { webContentsId } : {})
    };
  };

  function attachDescriptorMetadata<T extends Record<string, unknown>>(
    payload: T
  ) {
    const descriptor = createCurrentPageDescriptor();
    return {
      pageKey: descriptor.pageKey,
      pageKind: descriptor.pageKind,
      ...(descriptor.surfaceId ? { surfaceId: descriptor.surfaceId } : {}),
      ...(descriptor.surfaceLabel ? { surfaceLabel: descriptor.surfaceLabel } : {}),
      ...(descriptor.surfaceRoute ? { surfaceRoute: descriptor.surfaceRoute } : {}),
      ...payload
    };
  }

  async function executeCurrentPageRead(args: Record<string, unknown>) {
    const response = await executeActiveWebviewScript(args, READ_PAGE_DATA_SCRIPT);
    if (!response.ok) {
      return response;
    }
    return {
      ok: true as const,
      result: attachDescriptorMetadata({
        realtime: true,
        readAt: new Date().toISOString(),
        pageContext: await readActivePageContext(),
        data: filterReadPageDataResult(
          response.result,
          readAllowedValues(args.include, EMBEDDED_WEB_READ_INCLUDES)
        )
      })
    };
  }

  async function executeCurrentPageStructuredRead(args: Record<string, unknown>) {
    const response = await executeActiveWebviewScript(args, EXTRACT_STRUCTURED_SCRIPT);
    if (!response.ok) {
      return response;
    }
    return {
      ok: true as const,
      result: attachDescriptorMetadata({
        realtime: true,
        readAt: new Date().toISOString(),
        data: filterStructuredResult(
          response.result,
          readAllowedValues(args.targets, EMBEDDED_WEB_STRUCTURED_TARGETS)
        )
      })
    };
  }

  async function executeCurrentPageInteract(args: Record<string, unknown>) {
    const selector = readActionSelector(args);
    const action = typeof args.action === "string" ? args.action.trim() : "";
    if (!selector || !EMBEDDED_WEB_INTERACT_ACTIONS.has(action as EmbeddedWebInteractAction)) {
      return embeddedError("invalid_args", t("desktopAction.selectorActionRequired"), args);
    }
    const response = await executeActiveWebviewScript(args, buildInteractElementScript({
      selector,
      action: action as EmbeddedWebInteractAction,
      value: typeof args.value === "string" ? args.value : args.value == null ? undefined : String(args.value)
    }));
    if (!response.ok) {
      return response;
    }
    return {
      ok: true as const,
      result: attachDescriptorMetadata({
        interacted: true,
        action,
        outcome: response.result
      })
    };
  }

  async function executeCurrentPageFillForm(args: Record<string, unknown>) {
    const fields = readFormFields(args);
    if (fields.length === 0) {
      return embeddedError("invalid_args", t("desktopAction.fieldsSelectorRequired"), args);
    }
    const response = await executeActiveWebviewScript(args, buildFillFormScript({
      formSelector: typeof args.formSelector === "string" ? args.formSelector.trim() : undefined,
      fields
    }));
    if (!response.ok) {
      return response;
    }
    return {
      ok: true as const,
      result: attachDescriptorMetadata({
        filled: true,
        outcome: response.result
      })
    };
  }

  async function executeCurrentPageSubmitForm(args: Record<string, unknown>) {
    const response = await executeActiveWebviewScript(args, buildSubmitFormScript({
      formSelector: typeof args.formSelector === "string" ? args.formSelector.trim() : undefined,
      submitSelector: typeof args.submitSelector === "string" ? args.submitSelector.trim() : undefined
    }));
    if (!response.ok) {
      return response;
    }
    return {
      ok: true as const,
      result: attachDescriptorMetadata({
        submitted: true,
        outcome: response.result
      })
    };
  }

  useEffect(() => {
    if (active === false || !activeTab) {
      return undefined;
    }

    let cancelled = false;
    void (async () => {
      const pageContext = await readActivePageContext();
      if (cancelled) {
        return;
      }
      publishCurrentPageContextSnapshot({
        ...createCurrentPageDescriptor(),
        pageContext
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [active, activeTab?.id, currentRoute, surfaceId, surfaceLabel, title, url]);

  useEffect(() => {
    if (active === false || !activeTab) {
      return undefined;
    }

    return registerAssistantPageContextProvider(async () => {
      return readActivePageContext();
    });
  }, [active, activeTab?.id, surfaceId, surfaceLabel, title]);

  useEffect(() => {
    if (active === false || !activeTab) {
      return undefined;
    }

    return registerCurrentPageExecutor({
      getDescriptor: createCurrentPageDescriptor,
      readCurrent: async (request) => executeCurrentPageRead(request.args ?? {}),
      extractStructured: async (request) => executeCurrentPageStructuredRead(request.args ?? {}),
      interact: async (request) => executeCurrentPageInteract(request.args ?? {}),
      fillForm: async (request) => executeCurrentPageFillForm(request.args ?? {}),
      submitForm: async (request) => executeCurrentPageSubmitForm(request.args ?? {})
    });
  }, [active, activeTab?.id, currentRoute, surfaceId, surfaceLabel, title, url]);

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

    function requestTargetsDifferentSurface(args: Record<string, unknown>) {
      const targetSurfaceId = typeof args.surfaceId === "string" ? args.surfaceId.trim() : "";
      return Boolean(targetSurfaceId && surfaceId && targetSurfaceId !== surfaceId);
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
          const response = await executeCurrentPageRead(args);
          if (!response.ok) {
            return response;
          }
          return { ok: true, result: response.result.data };
        }
        case "desktop.embeddedWeb.extractStructured": {
          const response = await executeCurrentPageStructuredRead(args);
          if (!response.ok) {
            return response;
          }
          return { ok: true, result: response.result.data };
        }
        case "desktop.embeddedWeb.interactElement": {
          const response = await executeCurrentPageInteract(args);
          if (!response.ok) {
            return response;
          }
          return { ok: true, result: response.result.outcome };
        }
        case "desktop.embeddedWeb.executeScript": {
          const script = typeof args.script === "string" ? args.script : "";
          if (!script.trim()) {
            return embeddedError("invalid_script", t("externalWebview.error.invalidScript"));
          }
          return executeActiveWebviewScript(args, script);
        }
        case "desktop.embeddedWeb.navigate": {
          const nextUrl = readActionUrl(args);
          if (!nextUrl) {
            return embeddedError("invalid_url", t("externalWebview.error.invalidUrl"), args);
          }
          const tabId = readTargetTabId(args);
          const targetWebview = webviewRefs.current.get(tabId);
          if (!targetWebview) {
            return embeddedError("tab_unavailable", t("externalWebview.error.tabUnavailable"), { tabId });
          }
          await targetWebview.loadURL(nextUrl);
          setAddressInputValue(nextUrl);
          return { ok: true, result: { ...getEmbeddedWebSurfaceState(), navigatedUrl: nextUrl } };
        }
        case "desktop.embeddedWeb.reload": {
          const tabId = readTargetTabId(args);
          const targetWebview = webviewRefs.current.get(tabId);
          if (!targetWebview) {
            return embeddedError("tab_unavailable", t("externalWebview.error.tabUnavailable"), { tabId });
          }
          targetWebview.reload();
          return { ok: true, result: getEmbeddedWebSurfaceState() };
        }
        case "desktop.embeddedWeb.goBack": {
          const tabId = readTargetTabId(args);
          const targetWebview = webviewRefs.current.get(tabId);
          if (!targetWebview) {
            return embeddedError("tab_unavailable", t("externalWebview.error.tabUnavailable"), { tabId });
          }
          if (!targetWebview.canGoBack()) {
            return embeddedError("cannot_go_back", t("externalWebview.error.cannotGoBack"), { tabId });
          }
          targetWebview.goBack();
          return { ok: true, result: getEmbeddedWebSurfaceState() };
        }
        case "desktop.embeddedWeb.openTab": {
          const nextUrl = readActionUrl(args);
          if (!nextUrl) {
            return embeddedError("invalid_url", t("externalWebview.error.invalidUrl"), args);
          }
          const preferredTitle = typeof args.title === "string" ? args.title : "";
          const nextTab = openTab(nextUrl, preferredTitle);
          return { ok: true, result: { ...getEmbeddedWebSurfaceState(), openedTab: serializeTab(nextTab) } };
        }
        case "desktop.embeddedWeb.closeTab": {
          const tabId = readTargetTabId(args);
          const currentState = browserStateRef.current;
          if (currentState.tabs.length <= 1) {
            return embeddedError("last_tab", t("externalWebview.error.lastTab"), { tabId });
          }
          if (!currentState.tabs.some((tab) => tab.id === tabId)) {
            return embeddedError("tab_not_found", t("externalWebview.error.tabNotFound"), { tabId });
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
            return embeddedError("tab_not_found", t("externalWebview.error.tabNotFound"), { tabId });
          }
          setActiveTab(tabId);
          return { ok: true, result: { ...getEmbeddedWebSurfaceState(), activeTabId: tabId } };
        }
        default:
          return null;
      }
    });
  }, [active, activeTab?.id, surfaceId, surfaceLabel, t, title, url]);

  useEffect(() => {
    setAddressInputValue(getEditableAddressInputValue(activeTab?.currentUrl ?? url));
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
      setAddressInputValue(getEditableAddressInputValue(activeTab.currentUrl));
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
      setAddressInputValue(getEditableAddressInputValue(activeTab.currentUrl));
    });
  };

  const debugSidebarNode = debugSidebarOpen ? (
    <aside className="external-webview-debug-sidebar" aria-label={t("externalWebview.debugSidebar")}>
      <div className="external-webview-debug-header">
        <div>
          <strong>desktop.page</strong>
          <span>{debugSnapshot?.pageKind ?? "unknown"}</span>
        </div>
        <button
          type="button"
          className="external-webview-debug-icon-button"
          onClick={() => setDebugSidebarOpen(false)}
          aria-label={t("externalWebview.closeDebugSidebar")}
          title={t("common.close")}
        >
          <CloseIcon />
        </button>
      </div>
      <dl className="external-webview-debug-target">
        <div>
          <dt>pageKey</dt>
          <dd>{debugSnapshot?.pageKey ?? t("externalWebview.notSynced")}</dd>
        </div>
        <div>
          <dt>surface</dt>
          <dd>{debugSnapshot?.surfaceId ?? t("externalWebview.defaultSurface")} {debugSnapshot?.surfaceLabel ?? ""}</dd>
        </div>
      </dl>
      <label className="external-webview-debug-field">
        <span>{t("externalWebview.action")}</span>
        <select value={debugAction} onChange={(event) => handleSelectDebugAction(event.target.value)}>
          {(debugActions.length > 0 ? debugActions : ["desktop.page.readCurrent"]).map((action) => (
            <option key={action} value={action}>{action}</option>
          ))}
        </select>
      </label>
      <label className="external-webview-debug-field">
        <span>{t("externalWebview.argsJson")}</span>
        <textarea value={debugArgsJson} onChange={(event) => setDebugArgsJson(event.target.value)} spellCheck={false} />
      </label>
      <div className="external-webview-debug-actions">
        <button type="button" onClick={() => void executeDebugAction()} disabled={debugPending}>
          {debugPending ? t("externalWebview.executing") : t("externalWebview.execute")}
        </button>
        <button type="button" onClick={() => setDebugResultJson("")} disabled={!debugResultJson}>
          {t("externalWebview.clear")}
        </button>
        <button
          type="button"
          onClick={() => void window.electronAPI.clipboard.writeText(debugResultJson)}
          disabled={!debugResultJson}
        >
          {t("externalWebview.copy")}
        </button>
      </div>
      <label className="external-webview-debug-field is-result">
        <span>{t("externalWebview.result")}</span>
        <textarea value={debugResultJson} readOnly spellCheck={false} placeholder={t("externalWebview.resultPlaceholder")} />
      </label>
    </aside>
  ) : null;

  return (
    <>
    <section className={surfaceClassName} {...surfaceVisibilityProps}>
      {appChrome ? null : (
      <div className="external-webview-browser-chrome">
        <div className="external-webview-tabbar">
          <div
            className={`external-webview-tab-strip${tabsOverflowing ? " is-overflowing" : ""}`}
            ref={tabsStripRef}
            role="tablist"
            aria-label={t("externalWebview.tabs")}
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
                      aria-label={t("externalWebview.closeTab", { title: tab.title })}
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
              onClick={() => openTab(BLANK_EXTERNAL_WEBVIEW_URL, "")}
              aria-label={t("externalWebview.newTab")}
              title={t("externalWebview.newTab")}
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
              aria-label={t("externalWebview.back")}
              title={t("externalWebview.back")}
            >
              <ArrowLeftIcon />
            </button>
            <button
              type="button"
              className="external-webview-toolbar-button"
              onClick={handleReload}
              aria-label={t("externalWebview.refresh")}
              title={t("externalWebview.refresh")}
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
                setAddressInputValue(getEditableAddressInputValue(activeTab?.currentUrl ?? url));
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
              placeholder={t("externalWebview.addressPlaceholder")}
              aria-label={t("externalWebview.address")}
            />
          </div>
          <button
            type="button"
            className={`external-webview-debug-toggle${debugSidebarOpen ? " is-active" : ""}`}
            onClick={() => setDebugSidebarOpen((value) => !value)}
            aria-label={t("externalWebview.openDesktopDebug")}
            title={t("externalWebview.desktopDebugTitle")}
          >
            pg
          </button>
        </div>
        </div>
      )}
      <div className={`embedded-surface-frame-shell external-webview-frame-shell${appChrome ? " is-app-surface" : ""}`}>
        {browserState.tabs.map((tab) => (
          <ExternalWebviewPane
            key={tab.id}
            tab={tab}
            active={tab.id === browserState.activeTabId}
            surfaceId={surfaceId}
            surfaceLabel={surfaceLabel ?? title}
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
      {appChrome ? null : debugSidebarNode}
    </section>
    </>
  );
}
