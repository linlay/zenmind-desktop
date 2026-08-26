import { ArrowLeftOutlined, EditOutlined, FileTextOutlined, GlobalOutlined } from "@ant-design/icons";
import { createElement, useCallback, useEffect, useRef, useState } from "react";
import type {
  FocusEvent as ReactFocusEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent
} from "react";
import { useLocation } from "react-router-dom";
import { PRODUCT_NAME } from "../../../shared/brand";
import type { AssistantPageContext } from "../../../shared/contracts";
import type { DesktopWebActionStateResult } from "../../../shared/desktop-actions";
import type { EmbeddedCdpSurfaceKind } from "../../../shared/embedded-cdp";
import {
  createChatChildSurfaceIdentity,
  createSurfaceIdentity,
  createWebEntrySurfaceIdentity,
  resolveLegacyFixedSurfaceId,
  type SurfaceIdentity
} from "../../../shared/surface-identity";
import { BUILTIN_BROWSER_ROUTE, BUILTIN_BROWSER_SURFACE_ID } from "../../../shared/browser-surfaces";
import { DESKTOP_SSO_WEBVIEW_PARTITION } from "../../../shared/sso";
import { normalizeWebviewBlobPopupUrl } from "../../../shared/webview-popup";
import { closeWebTabFromOrder } from "../../../shared/web-tab-lifecycle";
import {
  buildInteractElementScript,
  type EmbeddedWebInteractAction
} from "../../../shared/embedded-web-scripts";
import { registerAssistantPageContextProvider } from "../../copilot/page-context/assistantPageContext";
import { publishCurrentPageContextSnapshot } from "../../services/currentPageContext";
import { registerDesktopActionProviderForScope } from "../../services/desktopActionRegistry";
import { registerWebSurfaceStateProvider } from "../../services/webSurfaceStateRegistry";
import { registerSurfaceRuntimeDownloadListener } from "../../services/surfaceRuntimeDownloads";
import { SidebarActionIcon } from "../../components/BrandMark";
import {
  Favicon,
  normalizeFaviconUrl,
} from "../../components/Favicon";
import { WebviewDebugOverlay } from "../../components/WebviewDebugOverlay";
import { useI18n } from "../../i18n/useI18n";
import {
  EMBEDDED_WEB_INTERACT_ACTIONS,
  EMBEDDED_WEB_SCRIPT_MAX_BYTES,
  getUtf8ByteLength,
  readActionSelector
} from "../../copilot/page-context/webActions";

export type ExternalWebviewControllerState = {
  surfaceId: string;
  activeTabId: string | null;
  tabs: Array<{
    tabId: string;
    targetId: string;
    title: string;
    url: string;
    isLoading: boolean;
  }>;
};

export type ExternalWebviewController = {
  getState: () => Promise<ExternalWebviewControllerState>;
  openTab: (url: string, title?: string) => Promise<ExternalWebviewControllerState>;
  activateTab: (tabId: string) => Promise<ExternalWebviewControllerState>;
  closeTab: (tabId: string) => Promise<ExternalWebviewControllerState | null>;
  unregisterSurface: () => Promise<void>;
};

export type ExternalWebviewRuntimeSnapshot = {
  tabs: Array<{
    title: string;
    currentUrl: string;
    faviconUrl?: string;
    partition?: string;
    userAgent?: string;
  }>;
  activeTabIndex: number;
};

type ExternalWebviewPageProps = {
  title: string;
  url: string;
  active?: boolean | undefined;
  surfaceId?: string;
  surfaceIdentity?: SurfaceIdentity;
  surfaceIdentityKey?: string;
  surfaceRoute?: string;
  surfaceKind?: EmbeddedCdpSurfaceKind;
  surfaceLabel?: string;
  chrome?: "browser" | "app";
  partition?: string;
  refreshOnDesktopSso?: boolean;
  assistantDockOpen?: boolean;
  onOpenAssistantDock?: () => void;
  onCloseAssistantDock?: () => void;
  onCloseSurface?: () => void;
  showSurfaceCloseButton?: boolean;
  surfaceCloseLabel?: string;
  onFaviconDiscovered?: (faviconUrl: string) => void;
  ownerChatId?: string;
  presentationScope?: "main-workspace" | "workpanel";
  allowUserTabCreation?: boolean;
  allowTabUrlCopy?: boolean;
  showToolbar?: boolean;
  workPanelToolbarKind?: "web" | "document";
  toolbarDocumentName?: string;
  showLoadingProgress?: boolean;
  enableDesktopWebActions?: boolean;
  registerPublicWebSurface?: boolean;
  onLoadingChange?: (isLoading: boolean) => void;
  pageReviewActive?: boolean;
  onTogglePageReview?: (page: { url: string; title: string }) => void;
  preloadUrl?: string;
  onIpcMessage?: (event: Event & { channel?: string; args?: unknown[] }) => void;
  onRuntimeProtectionChange?: (protectedFromSleep: boolean) => void;
  initialRuntimeSnapshot?: ExternalWebviewRuntimeSnapshot | null;
  onRuntimeSnapshotChange?: (snapshot: ExternalWebviewRuntimeSnapshot) => void;
  cdpActive?: boolean;
  publishPageContext?: boolean;
  onControllerReady?: (controller: ExternalWebviewController | null) => void;
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
  canGoForward: boolean;
  isLoading: boolean;
};

type ExternalWebviewBrowserState = {
  tabs: ExternalWebviewTabState[];
  activeTabId: string;
};

type ExternalWebviewTabPatch = Partial<Pick<
  ExternalWebviewTabState,
  "title" | "currentUrl" | "faviconUrl" | "guestId" | "canGoBack" | "canGoForward" | "isLoading"
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
let surfaceRegistrationSequence = 0;

function createSurfaceRegistrationId() {
  surfaceRegistrationSequence += 1;
  return `web-surface-${Date.now()}-${surfaceRegistrationSequence}`;
}

function getEmbeddedCdpSurfaceApi() {
  const embeddedCdp = window.electronAPI?.embeddedCdp;
  return typeof embeddedCdp?.registerSurface === "function" &&
    typeof embeddedCdp?.unregisterSurface === "function"
    ? embeddedCdp
    : null;
}

type ExternalWebviewPaneProps = {
  tab: ExternalWebviewTabState;
  active: boolean;
  surfaceId?: string;
  surfaceIdentity?: SurfaceIdentity;
  surfaceLabel?: string;
  onTabStateChange: (tabId: string, patch: ExternalWebviewTabPatch) => void;
  onWebviewRefChange: (tabId: string, webview: Electron.WebviewTag | null) => void;
  onCloseRequested: (tabId: string) => void;
  onDomReady: (tabId: string) => void;
  preloadUrl?: string;
  onIpcMessage?: (event: Event & { channel?: string; args?: unknown[] }) => void;
  onFaviconDiscovered?: (faviconUrl: string) => void;
  onRuntimeProtectionChange?: (
    tabId: string,
    reason: string,
    protectedFromSleep: boolean,
  ) => void;
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

function getEditableAddressInputValue(value: string) {
  return value === BLANK_EXTERNAL_WEBVIEW_URL ? "" : value;
}

function ExternalWebviewPane({
  tab,
  active,
  surfaceId,
  surfaceIdentity,
  surfaceLabel,
  onTabStateChange,
  onWebviewRefChange,
  onCloseRequested,
  onDomReady,
  preloadUrl,
  onIpcMessage,
  onFaviconDiscovered,
  onRuntimeProtectionChange,
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
        nextPatch.canGoForward = webview.canGoForward();
      } catch {
        nextPatch.canGoForward = false;
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
      onDomReady(tab.id);
    };
    const handleClose = () => {
      onCloseRequested(tab.id);
    };
    const handleDidStartLoading = () => {
      onRuntimeProtectionChange?.(tab.id, "loading", true);
      syncFromWebview({ isLoading: true });
    };
    const handleDidStopLoading = () => {
      onRuntimeProtectionChange?.(tab.id, "loading", false);
      syncFromWebview({ isLoading: false });
    };
    const handleDidFailLoad = () => {
      onRuntimeProtectionChange?.(tab.id, "loading", false);
      syncFromWebview({ isLoading: false });
    };
    const handleMediaStartedPlaying = () => {
      onRuntimeProtectionChange?.(tab.id, "media", true);
    };
    const handleMediaPaused = () => {
      onRuntimeProtectionChange?.(tab.id, "media", false);
    };
    const handleDidNavigate = (event: Event) => {
      const nextUrl = readEventString(event, "url");
      syncFromWebview(nextUrl ? { currentUrl: nextUrl } : {});
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
        onFaviconDiscovered?.(nextFaviconUrl);
      }
    };
    webview.addEventListener("dom-ready", handleDomReady);
    webview.addEventListener("did-start-loading", handleDidStartLoading);
    webview.addEventListener("did-stop-loading", handleDidStopLoading);
    webview.addEventListener("did-fail-load", handleDidFailLoad);
    webview.addEventListener("did-navigate", handleDidNavigate);
    webview.addEventListener("did-navigate-in-page", handleDidNavigateInPage);
    webview.addEventListener("page-title-updated", handlePageTitleUpdated);
    webview.addEventListener("page-favicon-updated", handlePageFaviconUpdated);
    webview.addEventListener("media-started-playing", handleMediaStartedPlaying);
    webview.addEventListener("media-paused", handleMediaPaused);
    webview.addEventListener("close", handleClose);
    if (onIpcMessage) webview.addEventListener("ipc-message", onIpcMessage as EventListener);
    syncFromWebview();

    return () => {
      webview.removeEventListener("dom-ready", handleDomReady);
      webview.removeEventListener("did-start-loading", handleDidStartLoading);
      webview.removeEventListener("did-stop-loading", handleDidStopLoading);
      webview.removeEventListener("did-fail-load", handleDidFailLoad);
      webview.removeEventListener("did-navigate", handleDidNavigate);
      webview.removeEventListener("did-navigate-in-page", handleDidNavigateInPage);
      webview.removeEventListener("page-title-updated", handlePageTitleUpdated);
      webview.removeEventListener("page-favicon-updated", handlePageFaviconUpdated);
      webview.removeEventListener("media-started-playing", handleMediaStartedPlaying);
      webview.removeEventListener("media-paused", handleMediaPaused);
      webview.removeEventListener("close", handleClose);
      if (onIpcMessage) webview.removeEventListener("ipc-message", onIpcMessage as EventListener);
      onRuntimeProtectionChange?.(tab.id, "loading", false);
      onRuntimeProtectionChange?.(tab.id, "media", false);
    };
  }, [
    onCloseRequested,
    onDomReady,
    onFaviconDiscovered,
    onIpcMessage,
    onRuntimeProtectionChange,
    onTabStateChange,
    tab.currentUrl,
    tab.id,
  ]);

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
        // Main receives popup requests and routes them to the owning surface.
        allowpopups: "true",
        partition: tab.partition,
        ...(preloadUrl ? { preload: preloadUrl } : {}),
        useragent: tab.userAgent,
        style: { width: "100%", height: "100%", border: "none" }
      })}
      <WebviewDebugOverlay url={tab.currentUrl} surfaceIdentity={surfaceIdentity} />
    </div>
  );
}

export function ExternalWebviewPage({
  title,
  url,
  active,
  surfaceId: surfaceIdProp,
  surfaceIdentity: surfaceIdentityProp,
  surfaceIdentityKey,
  surfaceRoute: surfaceRouteProp,
  surfaceKind,
  surfaceLabel,
  chrome = "browser",
  partition,
  refreshOnDesktopSso = false,
  assistantDockOpen = false,
  onOpenAssistantDock,
  onCloseSurface,
  showSurfaceCloseButton = false,
  surfaceCloseLabel,
  onFaviconDiscovered,
  ownerChatId,
  presentationScope,
  allowUserTabCreation = true,
  allowTabUrlCopy = false,
  showToolbar = true,
  workPanelToolbarKind = "web",
  toolbarDocumentName,
  showLoadingProgress = false,
  enableDesktopWebActions = true,
  registerPublicWebSurface = true,
  onLoadingChange,
  pageReviewActive = false,
  onTogglePageReview,
  preloadUrl,
  onIpcMessage,
  onRuntimeProtectionChange,
  initialRuntimeSnapshot,
  onRuntimeSnapshotChange,
  cdpActive,
  publishPageContext = true,
  onControllerReady
}: ExternalWebviewPageProps) {
  const { t } = useI18n();
  const location = useLocation();
  const currentRoute = `${location.pathname}${location.search}`;
  const appChrome = chrome === "app";
  const tabSequenceRef = useRef(0);
  const webviewRefs = useRef(new Map<string, Electron.WebviewTag>());
  const desktopSsoAuthenticatedRef = useRef(false);
  const surfaceKeyRef = useRef(`${title}\u0000${url}\u0000${partition || ""}`);
  const activeRef = useRef(active !== false);
  const runtimeProtectionReasonsRef = useRef(new Set<string>());
  const runtimeDownloadTabIdsRef = useRef(new Map<string, string>());
  const onRuntimeProtectionChangeRef = useRef(onRuntimeProtectionChange);
  onRuntimeProtectionChangeRef.current = onRuntimeProtectionChange;
  const onRuntimeSnapshotChangeRef = useRef(onRuntimeSnapshotChange);
  onRuntimeSnapshotChangeRef.current = onRuntimeSnapshotChange;
  const [surfaceRegistrationId] = useState(createSurfaceRegistrationId);
  const registeredSurfaceKind = surfaceKind ?? (surfaceIdProp === BUILTIN_BROWSER_SURFACE_ID ? "browser" : null);
  const workPanelBrowser = registeredSurfaceKind === "chat-work-panel";
  const documentToolbar = workPanelBrowser && workPanelToolbarKind === "document";
  const surfaceIdentity = surfaceIdentityProp ?? (
    registeredSurfaceKind === "browser"
      ? createSurfaceIdentity("browser")
      : registeredSurfaceKind === "website" || registeredSurfaceKind === "webapp"
        ? createWebEntrySurfaceIdentity(registeredSurfaceKind, surfaceIdentityKey || surfaceIdProp || "")
        : registeredSurfaceKind === "chat-work-panel"
          ? createChatChildSurfaceIdentity("workpanel-web", surfaceIdentityKey || surfaceIdProp || "", ownerChatId || "")
          : null
  );
  const surfaceId = surfaceIdentity?.surfaceId || surfaceIdProp;
  const registeredSurfaceRoute = surfaceRouteProp ?? (registeredSurfaceKind === "chat-work-panel"
    ? ""
    : surfaceId === BUILTIN_BROWSER_SURFACE_ID
      ? BUILTIN_BROWSER_ROUTE
      : surfaceId
        ? `/webs/${surfaceId}`
        : currentRoute);
  const faviconReportedRef = useRef(false);
  const initialFaviconTabIdRef = useRef("");
  const surfaceClassName = [
    "embedded-surface-page external-webview-page",
    appChrome ? "" : "has-browser-chrome",
    workPanelBrowser ? "is-work-panel-browser" : "",
    showToolbar ? "has-browser-toolbar" : "",
    pageReviewActive ? "is-page-review-active" : "",
    !appChrome && !showToolbar ? "is-toolbarless-browser" : "",
    appChrome ? "is-app-surface" : "",
    onOpenAssistantDock && !assistantDockOpen ? "has-copilot-launcher" : "",
    active === false ? "is-inactive-surface" : ""
  ].filter(Boolean).join(" ");
  const surfaceVisibilityProps = active === undefined
    ? {}
    : {
        "aria-hidden": active === false
      };

  const handleRuntimeProtectionChange = useCallback((
    tabId: string,
    reason: string,
    protectedFromSleep: boolean,
  ) => {
    const key = `${tabId}:${reason}`;
    const wasProtected = runtimeProtectionReasonsRef.current.size > 0;
    if (protectedFromSleep) {
      runtimeProtectionReasonsRef.current.add(key);
    } else {
      runtimeProtectionReasonsRef.current.delete(key);
    }
    const isProtected = runtimeProtectionReasonsRef.current.size > 0;
    if (isProtected !== wasProtected) {
      onRuntimeProtectionChangeRef.current?.(isProtected);
    }
  }, []);

  useEffect(() => () => {
    runtimeProtectionReasonsRef.current.clear();
    runtimeDownloadTabIdsRef.current.clear();
    onRuntimeProtectionChangeRef.current?.(false);
  }, []);

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
      canGoForward: false,
      isLoading: true
    } satisfies ExternalWebviewTabState;
  };

  const createInitialBrowserState = (restoreRuntimeSnapshot = false) => {
    const snapshotTabs = restoreRuntimeSnapshot
      ? initialRuntimeSnapshot?.tabs.filter((tab) => tab.currentUrl.trim())
      : undefined;
    if (snapshotTabs && snapshotTabs.length > 0) {
      const tabs = snapshotTabs.map((tab) => ({
        ...createTab(tab.currentUrl, tab.title, {
          partition: tab.partition,
          userAgent: tab.userAgent,
        }),
        faviconUrl: tab.faviconUrl,
      }));
      const activeTabIndex = Math.max(
        0,
        Math.min(initialRuntimeSnapshot?.activeTabIndex ?? 0, tabs.length - 1),
      );
      initialFaviconTabIdRef.current = tabs[activeTabIndex]?.id ?? tabs[0].id;
      return {
        tabs,
        activeTabId: tabs[activeTabIndex]?.id ?? tabs[0].id,
      } satisfies ExternalWebviewBrowserState;
    }
    const initialTab = createTab(url, title);
    initialFaviconTabIdRef.current = initialTab.id;
    return {
      tabs: [initialTab],
      activeTabId: initialTab.id
    } satisfies ExternalWebviewBrowserState;
  };

  const [browserState, setBrowserState] = useState<ExternalWebviewBrowserState>(
    () => createInitialBrowserState(true),
  );
  const [addressInputValue, setAddressInputValue] = useState(() => url);
  const [addressInputUnlocked, setAddressInputUnlocked] = useState(false);
  const [tabsOverflowing, setTabsOverflowing] = useState(false);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [tabDragOffsetX, setTabDragOffsetX] = useState(0);
  const browserStateRef = useRef(browserState);
  useEffect(() => registerSurfaceRuntimeDownloadListener((state) => {
    if (state.active) {
      const sourceTab = browserStateRef.current.tabs.find(
        (tab) => tab.guestId === state.webContentsId,
      );
      if (!sourceTab) return;
      runtimeDownloadTabIdsRef.current.set(state.downloadId, sourceTab.id);
      handleRuntimeProtectionChange(
        sourceTab.id,
        `download:${state.downloadId}`,
        true,
      );
      return;
    }
    const sourceTabId = runtimeDownloadTabIdsRef.current.get(state.downloadId);
    if (!sourceTabId) return;
    runtimeDownloadTabIdsRef.current.delete(state.downloadId);
    handleRuntimeProtectionChange(
      sourceTabId,
      `download:${state.downloadId}`,
      false,
    );
  }), [handleRuntimeProtectionChange]);
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
  const refreshWaitersRef = useRef(new Map<string, {
    finish: (result: { tabId: string; ok: boolean; code?: string; message?: string }) => void;
  }>());

  const commitBrowserState = (
    update: (currentState: ExternalWebviewBrowserState) => ExternalWebviewBrowserState
  ) => {
    const currentState = browserStateRef.current;
    const nextState = update(currentState);
    if (nextState !== currentState) {
      browserStateRef.current = nextState;
      setBrowserState(nextState);
    }
    return nextState;
  };

  const syncEmbeddedCdpSurface = async (state: ExternalWebviewBrowserState) => {
    const embeddedCdp = getEmbeddedCdpSurfaceApi();
    if (!embeddedCdp || !registeredSurfaceKind || !surfaceId || !surfaceIdentity) {
      return;
    }
    const registeredTabs = state.tabs
      .filter((tab): tab is ExternalWebviewTabState & { guestId: number } => typeof tab.guestId === "number")
      .map((tab) => ({
        tabId: tab.id,
        currentUrl: tab.currentUrl,
        title: tab.title,
        webContentsId: tab.guestId,
        ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}),
        canGoBack: tab.canGoBack,
        canGoForward: tab.canGoForward,
        isLoading: tab.isLoading
      }));
    if (registeredTabs.length === 0) {
      await embeddedCdp.unregisterSurface({
        registrationId: surfaceRegistrationId,
        surfaceId
      });
      return;
    }
    const registeredActiveTabId = registeredTabs.some((tab) => tab.tabId === state.activeTabId)
      ? state.activeTabId
      : registeredTabs[0]?.tabId ?? null;
    const response = await embeddedCdp.registerSurface({
      registrationId: surfaceRegistrationId,
      ...surfaceIdentity,
      ...(surfaceIdentityKey?.trim() ? { surfaceIdentityKey: surfaceIdentityKey.trim() } : {}),
      surfaceKind: registeredSurfaceKind,
      surfaceType: registeredSurfaceKind,
      pageRoute: registeredSurfaceRoute,
      ...(ownerChatId ? { ownerChatId } : {}),
      ...(presentationScope ? { presentationScope } : {}),
      label: surfaceLabel ?? title,
      url,
      active: cdpActive ?? activeRef.current,
      tabs: registeredTabs,
      activeTabId: registeredActiveTabId
    });
    if (!response.ok) {
      throw new Error("Embedded CDP surface could not be registered.");
    }
  };

  useEffect(() => {
    browserStateRef.current = browserState;
    const activeTabIndex = Math.max(
      0,
      browserState.tabs.findIndex((tab) => tab.id === browserState.activeTabId),
    );
    onRuntimeSnapshotChangeRef.current?.({
      tabs: browserState.tabs.map((tab) => ({
        title: tab.title,
        currentUrl: tab.currentUrl,
        ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}),
        ...(tab.partition ? { partition: tab.partition } : {}),
        ...(tab.userAgent ? { userAgent: tab.userAgent } : {}),
      })),
      activeTabIndex,
    });
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
    faviconReportedRef.current = false;
    const nextState = createInitialBrowserState(false);
    browserStateRef.current = nextState;
    setBrowserState(nextState);
    setAddressInputValue(url);
    setAddressInputUnlocked(false);
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
    commitBrowserState((currentState) => {
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
    commitBrowserState((currentState) => {
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
    for (const [tabId, waiter] of refreshWaitersRef.current) {
      waiter.finish({
        tabId,
        ok: false,
        code: "surface_unmounted"
      });
    }
  }, []);

  const handleTabStripWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!tabsOverflowing || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) {
      return;
    }

    event.currentTarget.scrollLeft += event.deltaY;
  };

  const closeTab = async (tabId: string) => {
    const currentState = browserStateRef.current;
    const transition = closeWebTabFromOrder(
      currentState.tabs.map((tab) => tab.id),
      currentState.activeTabId,
      tabId
    );
    if (!transition) {
      return null;
    }

    refreshWaitersRef.current.get(tabId)?.finish({
      tabId,
      ok: false,
      code: "tab_closed"
    });
    webviewRefs.current.delete(tabId);
    const remainingTabs = currentState.tabs.filter((tab) => tab.id !== tabId);
    const nextActiveTabId = transition.activeTabId ?? "";
    const nextState = commitBrowserState(() => ({
      tabs: remainingTabs,
      activeTabId: nextActiveTabId
    }));
    await syncEmbeddedCdpSurface(nextState);
    const closedSurface = remainingTabs.length === 0;
    if (closedSurface) {
      onCloseSurface?.();
    }
    return {
      surfaceId: surfaceId ?? "",
      closedTabId: tabId,
      closedSurface,
      remainingTabIds: remainingTabs.map((tab) => tab.id),
      activeTabId: nextActiveTabId || null
    };
  };

  const finishRefreshWaiter = (tabId: string) => {
    refreshWaitersRef.current.get(tabId)?.finish({ tabId, ok: true });
  };

  const waitForTabDomReady = (tabId: string, timeoutMs: number) => {
    return new Promise<{ tabId: string; ok: boolean; code?: string; message?: string }>((resolve) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        finish({
          tabId,
          ok: false,
          code: "dom_ready_timeout"
        });
      }, timeoutMs);
      const finish = (result: { tabId: string; ok: boolean; code?: string; message?: string }) => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timer);
        refreshWaitersRef.current.delete(tabId);
        resolve(result);
      };
      refreshWaitersRef.current.set(tabId, { finish });
    });
  };

  const refreshSurface = async () => {
    const snapshot = [...browserStateRef.current.tabs];
    const deadline = Date.now() + 15_000;
    const pending = snapshot.map((tab) => {
      const webview = webviewRefs.current.get(tab.id);
      if (!webview) {
        return Promise.resolve({
          tabId: tab.id,
          ok: false,
          code: "tab_unavailable",
          message: t("externalWebview.error.tabUnavailable")
        });
      }
      const ready = waitForTabDomReady(tab.id, Math.max(0, deadline - Date.now()));
      try {
        webview.reload();
      } catch (error) {
        refreshWaitersRef.current.get(tab.id)?.finish({
          tabId: tab.id,
          ok: false,
          code: "reload_failed",
          message: error instanceof Error ? error.message : String(error)
        });
      }
      return ready;
    });
    const tabResults = await Promise.all(pending);
    const refreshedTabIds = tabResults.filter((result) => result.ok).map((result) => result.tabId);
    const failedTabs = tabResults
      .filter((result) => !result.ok)
      .map(({ tabId, code, message }) => ({
        tabId,
        code: code || "refresh_failed",
        message: message || (
          code === "tab_closed"
            ? t("externalWebview.error.refreshTabClosed")
            : code === "dom_ready_timeout"
              ? t("externalWebview.error.refreshTimeout")
              : code === "surface_unmounted"
                ? t("externalWebview.error.refreshSurfaceUnmounted")
                : t("externalWebview.error.refreshFailed")
        )
      }));
    return {
      surfaceId: surfaceId ?? "",
      refreshedTabIds,
      failedTabs,
      activeTabId: browserStateRef.current.activeTabId || null
    };
  };

  const handleTabStateChange = (tabId: string, patch: ExternalWebviewTabPatch) => {
    commitBrowserState((currentState) => {
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
          nextTab.canGoForward === tab.canGoForward &&
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
    return window.electronAPI.onWebviewOpenTab(({
      target,
      navigationKind,
      sourceGuestId,
      url: requestedUrl,
      partition,
      userAgent,
    }) => {
      if (appChrome || target !== "desktop-browser") {
        return;
      }
      const currentState = browserStateRef.current;
      const sourceTab = currentState.tabs.find((tab) => tab.guestId === sourceGuestId);
      const nextUrl = navigationKind === "blob"
        ? normalizeWebviewBlobPopupUrl(requestedUrl)
        : requestedUrl;
      if (!nextUrl || (navigationKind === "blob" && !sourceTab)) {
        return;
      }
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
    if (!refreshOnDesktopSso || !window.electronAPI.sso?.onStatusChanged) {
      return undefined;
    }
    return window.electronAPI.sso.onStatusChanged((status) => {
      if (!status.authenticated) {
        desktopSsoAuthenticatedRef.current = false;
        return;
      }
      if (status.pending || !status.completedSteps.accessToken) {
        return;
      }
      if (desktopSsoAuthenticatedRef.current) {
        return;
      }
      desktopSsoAuthenticatedRef.current = true;
      for (const tab of browserStateRef.current.tabs) {
        if (tab.partition !== DESKTOP_SSO_WEBVIEW_PARTITION) {
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
  }, [refreshOnDesktopSso]);

  const activeTab = browserState.tabs.find((tab) => tab.id === browserState.activeTabId) ?? browserState.tabs[0];
  const onLoadingChangeRef = useRef(onLoadingChange);
  onLoadingChangeRef.current = onLoadingChange;

  useEffect(() => {
    onLoadingChangeRef.current?.(Boolean(activeTab?.isLoading));
  }, [activeTab?.id, activeTab?.isLoading]);

  useEffect(() => () => {
    onLoadingChangeRef.current?.(false);
  }, []);

  useEffect(() => {
    void syncEmbeddedCdpSurface(browserState).catch(() => undefined);
  }, [
    active,
    browserState,
    registeredSurfaceKind,
    surfaceRegistrationId,
    surfaceId,
    surfaceIdentity?.interaction,
    surfaceIdentity?.ownerChatId,
    surfaceIdentity?.parentSurfaceId,
    surfaceIdentity?.surfaceId,
    surfaceIdentity?.surfaceLevel,
    surfaceIdentity?.surfaceRole,
    surfaceIdentityKey,
    surfaceLabel,
    cdpActive,
    ownerChatId,
    presentationScope,
    title,
    url
  ]);

  useEffect(() => {
    const embeddedCdp = getEmbeddedCdpSurfaceApi();
    if (!embeddedCdp || !registeredSurfaceKind || !surfaceId) {
      return undefined;
    }
    return () => {
      void embeddedCdp.unregisterSurface({
        registrationId: surfaceRegistrationId,
        surfaceId
      }).catch(() => undefined);
    };
  }, [registeredSurfaceKind, surfaceRegistrationId, surfaceId]);

  useEffect(() => {
    setAddressInputUnlocked(false);
  }, [activeTab?.id]);

  const getActiveWebviewState = () => {
    const currentState = browserStateRef.current;
    const currentActiveTab = currentState.tabs.find((tab) => tab.id === currentState.activeTabId) ?? currentState.tabs[0];
    return {
      currentState,
      currentActiveTab,
      activeWebview: currentActiveTab ? webviewRefs.current.get(currentActiveTab.id) ?? null : null
    };
  };

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

  const getPublicWebSurfaceState = () => {
    const currentState = browserStateRef.current;
    return {
      surface: {
        id: surfaceId ?? "",
        surfaceId: surfaceId ?? "",
        surfaceRole: surfaceIdentity?.surfaceRole ?? "browser",
        surfaceLevel: surfaceIdentity?.surfaceLevel ?? "root",
        ...(surfaceIdentity?.parentSurfaceId ? { parentSurfaceId: surfaceIdentity.parentSurfaceId } : {}),
        ...(surfaceIdentity?.ownerChatId ? { ownerChatId: surfaceIdentity.ownerChatId } : {}),
        interaction: surfaceIdentity?.interaction ?? "interactive",
        kind: registeredSurfaceKind === "chat-work-panel"
          ? "browser" as const
          : registeredSurfaceKind ?? "browser" as const,
        label: surfaceLabel ?? title,
        url,
        route: registeredSurfaceRoute,
        open: currentState.tabs.length > 0,
        active: activeRef.current
      },
      tabs: currentState.tabs.map((tab) => ({
        tabId: tab.id,
        title: tab.title,
        currentUrl: tab.currentUrl,
        ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}),
        active: tab.id === currentState.activeTabId,
        isLoading: tab.isLoading,
        canGoBack: tab.canGoBack,
        canGoForward: tab.canGoForward
      })),
      activeTabId: currentState.activeTabId || null
    };
  };

  const getDesktopWebActionState = (): DesktopWebActionStateResult => {
    const state = getPublicWebSurfaceState();
    const { id: _internalSurfaceId, ...surface } = state.surface;
    return {
      surface,
      tabs: state.tabs,
      activeTab: state.tabs.find((tab) => tab.tabId === state.activeTabId) ?? null
    };
  };

  useEffect(() => {
    if (!registerPublicWebSurface || !surfaceId || !registeredSurfaceKind) {
      return undefined;
    }
    return registerWebSurfaceStateProvider(surfaceId, getPublicWebSurfaceState);
  }, [registerPublicWebSurface, registeredSurfaceKind, registeredSurfaceRoute, surfaceId, surfaceLabel, title, url]);

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

  useEffect(() => {
    if (!publishPageContext || active === false || !activeTab) {
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
  }, [
    active,
    publishPageContext,
    activeTab?.currentUrl,
    activeTab?.guestId,
    activeTab?.id,
    activeTab?.title,
    currentRoute,
    surfaceId,
    surfaceLabel,
    title,
    url
  ]);

  useEffect(() => {
    if (!publishPageContext || active === false || !activeTab) {
      return undefined;
    }

    return registerAssistantPageContextProvider(async () => {
      return readActivePageContext();
    });
  }, [active, activeTab?.id, publishPageContext, surfaceId, surfaceLabel, title]);

  useEffect(() => {
    if (!enableDesktopWebActions || active === false) {
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
      const canonicalTargetSurfaceId = resolveLegacyFixedSurfaceId(targetSurfaceId);
      return Boolean(
        targetSurfaceId &&
        surfaceId &&
        canonicalTargetSurfaceId !== surfaceId &&
        targetSurfaceId !== surfaceIdProp &&
        targetSurfaceId !== surfaceIdentityKey
      );
    }

    return registerDesktopActionProviderForScope("web", async (request) => {
      if (!activeRef.current) {
        return null;
      }
      const args = request.args ?? {};
      if (requestTargetsDifferentSurface(args)) {
        return null;
      }

      switch (request.action) {
        case "desktop.web.interactElement": {
          const response = await executeCurrentPageInteract(args);
          if (!response.ok) {
            return response;
          }
          return { ok: true, result: response.result.outcome };
        }
        case "desktop.web.executeScript": {
          const script = typeof args.script === "string" ? args.script : "";
          if (!script.trim()) {
            return embeddedError("invalid_script", t("externalWebview.error.invalidScript"));
          }
          return executeActiveWebviewScript(args, script);
        }
        case "desktop.web.navigate": {
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
          return {
            ok: true,
            result: { ...getDesktopWebActionState(), targetTabId: tabId, navigatedUrl: nextUrl }
          };
        }
        case "desktop.web.reload": {
          const tabId = readTargetTabId(args);
          const targetWebview = webviewRefs.current.get(tabId);
          if (!targetWebview) {
            return embeddedError("tab_unavailable", t("externalWebview.error.tabUnavailable"), { tabId });
          }
          targetWebview.reload();
          return { ok: true, result: { ...getDesktopWebActionState(), targetTabId: tabId } };
        }
        case "desktop.web.refreshSurface": {
          const targetSurfaceId = typeof args.surfaceId === "string" ? args.surfaceId.trim() : "";
          if (!targetSurfaceId) {
            return embeddedError("invalid_args", t("externalWebview.error.surfaceIdRequired"));
          }
          const result = await refreshSurface();
          if (result.failedTabs.length > 0) {
            return embeddedError(
              "surface_refresh_partial",
              t("externalWebview.error.surfaceRefreshPartial"),
              result
            );
          }
          return { ok: true, result };
        }
        case "desktop.web.goBack": {
          const tabId = readTargetTabId(args);
          const targetWebview = webviewRefs.current.get(tabId);
          if (!targetWebview) {
            return embeddedError("tab_unavailable", t("externalWebview.error.tabUnavailable"), { tabId });
          }
          if (!targetWebview.canGoBack()) {
            return embeddedError("cannot_go_back", t("externalWebview.error.cannotGoBack"), { tabId });
          }
          targetWebview.goBack();
          return { ok: true, result: { ...getDesktopWebActionState(), targetTabId: tabId } };
        }
        case "desktop.web.openTab": {
          const nextUrl = readActionUrl(args);
          if (!nextUrl) {
            return embeddedError("invalid_url", t("externalWebview.error.invalidUrl"), args);
          }
          const preferredTitle = typeof args.title === "string" ? args.title : "";
          const nextTab = openTab(nextUrl, preferredTitle);
          return { ok: true, result: { ...getDesktopWebActionState(), openedTabId: nextTab.id } };
        }
        case "desktop.web.closeTab": {
          const targetSurfaceId = typeof args.surfaceId === "string" ? args.surfaceId.trim() : "";
          const tabId = typeof args.tabId === "string" ? args.tabId.trim() : "";
          if (!targetSurfaceId || !tabId) {
            return embeddedError("invalid_args", t("externalWebview.error.closeArgsRequired"));
          }
          const result = await closeTab(tabId);
          if (!result) {
            return embeddedError("tab_not_found", t("externalWebview.error.tabNotFound"), { tabId });
          }
          return {
            ok: true,
            result: {
              ...(result.closedSurface
                ? { surface: null, tabs: [], activeTab: null }
                : getDesktopWebActionState()),
              closedTabId: result.closedTabId,
              closedSurface: result.closedSurface
            }
          };
        }
        case "desktop.web.switchTab": {
          const tabId = readTargetTabId(args);
          if (!browserStateRef.current.tabs.some((tab) => tab.id === tabId)) {
            return embeddedError("tab_not_found", t("externalWebview.error.tabNotFound"), { tabId });
          }
          setActiveTab(tabId);
          await syncEmbeddedCdpSurface(browserStateRef.current);
          return { ok: true, result: getDesktopWebActionState() };
        }
        default:
          return null;
      }
    });
  }, [active, activeTab?.id, enableDesktopWebActions, onCloseSurface, surfaceId, surfaceLabel, t, title, url]);

  const readControllerState = async (waitForTabId?: string) => {
    if (!surfaceId || !registeredSurfaceKind) {
      throw new Error("Embedded CDP surface is unavailable.");
    }
    const deadline = Date.now() + 8_000;
    do {
      await syncEmbeddedCdpSurface(browserStateRef.current);
      const response = await window.electronAPI.embeddedCdp.getSurfaceTargetState({
        registrationId: surfaceRegistrationId,
        surfaceId
      });
      const targets = response.targets ?? [];
      if (response.ok && (!waitForTabId || targets.some((target) => target.tabId === waitForTabId))) {
        return {
          surfaceId,
          activeTabId: response.activeTabId ?? null,
          tabs: targets.map((target) => ({
            tabId: target.tabId,
            targetId: target.targetId,
            title: target.title,
            url: target.currentUrl,
            isLoading: target.isLoading
          }))
        } satisfies ExternalWebviewControllerState;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw new Error("Work Panel webview target is unavailable.");
  };

  useEffect(() => {
    if (!onControllerReady) {
      return undefined;
    }
    const controller: ExternalWebviewController = {
      getState: () => readControllerState(),
      openTab: async (nextUrl, preferredTitle = "") => {
        const nextTab = openTab(nextUrl, preferredTitle);
        return readControllerState(nextTab.id);
      },
      activateTab: async (tabId) => {
        if (!browserStateRef.current.tabs.some((tab) => tab.id === tabId)) {
          throw new Error("tab_not_found");
        }
        setActiveTab(tabId);
        return readControllerState(tabId);
      },
      closeTab: async (tabId) => {
        const result = await closeTab(tabId);
        if (!result) {
          return null;
        }
        return result.closedSurface ? null : readControllerState();
      },
      unregisterSurface: async () => {
        if (!surfaceId || !registeredSurfaceKind) {
          return;
        }
        await getEmbeddedCdpSurfaceApi()?.unregisterSurface({
          registrationId: surfaceRegistrationId,
          surfaceId
        });
      }
    };
    onControllerReady(controller);
    return () => onControllerReady(null);
  });

  useEffect(() => {
    if (addressInputUnlocked) {
      return;
    }
    setAddressInputValue(getEditableAddressInputValue(activeTab?.currentUrl ?? url));
  }, [activeTab?.id, activeTab?.currentUrl, addressInputUnlocked, url]);

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

  const handleGoForward = () => {
    if (!activeTab?.canGoForward) {
      return;
    }

    const activeWebview = webviewRefs.current.get(activeTab.id);
    if (!activeWebview) {
      return;
    }

    try {
      if (activeWebview.canGoForward()) {
        activeWebview.goForward();
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
      if (workPanelBrowser) setAddressInputUnlocked(false);
      return;
    }

    const activeWebview = webviewRefs.current.get(activeTab.id);
    if (!activeWebview || typeof activeWebview.loadURL !== "function") {
      setAddressInputValue(normalizedUrl);
      if (workPanelBrowser) setAddressInputUnlocked(false);
      return;
    }

    if (workPanelBrowser) setAddressInputUnlocked(false);
    void activeWebview.loadURL(normalizedUrl).then(() => {
      setAddressInputValue(normalizedUrl);
    }).catch(() => {
      setAddressInputValue(getEditableAddressInputValue(activeTab.currentUrl));
    });
  };

  const handleAddressInputFocus = (event: ReactFocusEvent<HTMLInputElement>) => {
    if (addressInputUnlocked) {
      return;
    }

    setAddressInputUnlocked(true);
    event.currentTarget.select();
  };

  const handleTabContextMenu = async (
    event: ReactMouseEvent<HTMLDivElement>,
    tab: ExternalWebviewTabState
  ) => {
    if (!allowTabUrlCopy) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const urlToCopy = tab.currentUrl;
    const result = await window.electronAPI.chatWorkPanelTabContextMenu.popup({
      mode: "copy-url",
      x: event.clientX,
      y: event.clientY
    });
    if (result.actionId === "copy-url") {
      await window.electronAPI.clipboard.writeText(urlToCopy);
    }
  };

  const handleAssistantDockOpen = () => {
    onOpenAssistantDock?.();
  };

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
              const canClose = true;
              return (
                <div
                  key={tab.id}
                  className={`external-webview-tab${isActive ? " is-active" : ""}${
                    draggingTabId === tab.id ? " is-dragging" : ""
                  }`}
                  data-tab-id={tab.id}
                  style={draggingTabId === tab.id ? { transform: `translateX(${tabDragOffsetX}px)` } : undefined}
                  role="presentation"
                  onContextMenu={(event) => {
                    void handleTabContextMenu(event, tab).catch(() => undefined);
                  }}
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
                      <Favicon
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
                        void closeTab(tab.id).catch(() => undefined);
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
            {allowUserTabCreation ? <button
              type="button"
              className="external-webview-tab-add"
              onClick={() => openTab(BLANK_EXTERNAL_WEBVIEW_URL, "")}
              aria-label={t("externalWebview.newTab")}
              title={t("externalWebview.newTab")}
            >
            <PlusIcon />
          </button> : null}
          {showSurfaceCloseButton && onCloseSurface ? (
            <button
              type="button"
              className="external-webview-surface-close"
              onClick={onCloseSurface}
              aria-label={surfaceCloseLabel}
              title={surfaceCloseLabel}
            >
              <CloseIcon />
            </button>
          ) : null}
        </div>
        {showToolbar ? (
          <div className={`external-webview-toolbar${pageReviewActive ? " is-review-mode" : ""}`}>
            {pageReviewActive && workPanelBrowser && onTogglePageReview ? (
              <>
                <button
                  type="button"
                  className="external-webview-toolbar-return"
                  onClick={() => onTogglePageReview({
                    url: activeTab?.currentUrl ?? url,
                    title: activeTab?.title ?? title,
                  })}
                  aria-label={t("chatWorkPanel.review.returnPreview")}
                  title={t("chatWorkPanel.review.returnPreview")}
                >
                  <ArrowLeftOutlined aria-hidden="true" />
                  <span>{t("chatWorkPanel.review.returnPreview")}</span>
                </button>
                <span className="external-webview-toolbar-review-hint">
                  {t("chatWorkPanel.review.htmlTool")}
                </span>
              </>
            ) : (
              <>
                <div className="external-webview-toolbar-actions">
                  {!documentToolbar ? <>
                    <button
                      type="button"
                      className="external-webview-toolbar-button"
                      onClick={handleGoBack}
                      disabled={!activeTab?.canGoBack}
                      aria-label={t("externalWebview.back")}
                      title={t("externalWebview.back")}
                    >
                      <SidebarActionIcon kind="back" />
                    </button>
                    <button
                      type="button"
                      className="external-webview-toolbar-button"
                      onClick={handleGoForward}
                      disabled={!activeTab?.canGoForward}
                      aria-label={t("externalWebview.forward")}
                      title={t("externalWebview.forward")}
                    >
                      <SidebarActionIcon kind="forward" />
                    </button>
                  </> : null}
                  <button
                    type="button"
                    className="external-webview-toolbar-button"
                    onClick={handleReload}
                    aria-label={t("externalWebview.refresh")}
                    title={t("externalWebview.refresh")}
                  >
                    <SidebarActionIcon kind="refresh" />
                  </button>
                </div>
                <div className={`external-webview-toolbar-location${addressInputUnlocked ? " is-editing" : ""}`}>
                  <span className="external-webview-toolbar-location-icon" aria-hidden="true">
                    {documentToolbar ? <FileTextOutlined /> : workPanelBrowser ? <GlobalOutlined /> : <SearchIcon />}
                  </span>
                  {documentToolbar ? (
                    <span
                      className="external-webview-toolbar-location-input is-static"
                      title={toolbarDocumentName || title}
                    >
                      {toolbarDocumentName || title}
                    </span>
                  ) : (
                    <input
                      type="text"
                      className="external-webview-toolbar-location-input"
                      value={addressInputValue}
                      onChange={(event) => {
                        setAddressInputValue(event.target.value);
                      }}
                      onFocus={handleAddressInputFocus}
                      onBlur={() => {
                        setAddressInputUnlocked(false);
                        setAddressInputValue(getEditableAddressInputValue(activeTab?.currentUrl ?? url));
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Escape" && workPanelBrowser) {
                          event.preventDefault();
                          setAddressInputUnlocked(false);
                          setAddressInputValue(getEditableAddressInputValue(activeTab?.currentUrl ?? url));
                          return;
                        }
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
                  )}
                  {workPanelBrowser && onTogglePageReview ? (
                    <button
                      type="button"
                      className="external-webview-toolbar-edit"
                      onClick={() => onTogglePageReview({
                        url: activeTab?.currentUrl ?? url,
                        title: activeTab?.title ?? title,
                      })}
                      aria-label={t("chatWorkPanel.tabContextMenu.enterReview")}
                      aria-pressed={false}
                      title={t("chatWorkPanel.tabContextMenu.enterReview")}
                    >
                      <EditOutlined aria-hidden="true" />
                      <span className="external-webview-toolbar-edit-label">
                        {t("externalWebview.editPage")}
                      </span>
                    </button>
                  ) : null}
                </div>
              </>
            )}
          </div>
        ) : null}
        </div>
      )}
      {onOpenAssistantDock && !assistantDockOpen ? (
        <button
          type="button"
          className="external-webview-copilot-button"
          onClick={handleAssistantDockOpen}
          aria-label={t("sidebar.copilot.open", { appName: PRODUCT_NAME })}
          aria-expanded={false}
          title={t("sidebar.copilot.title")}
        >
          <SidebarActionIcon
            kind="sidebar_right"
            className="external-webview-copilot-button-icon"
          />
        </button>
      ) : null}
      <div className={`embedded-surface-frame-shell external-webview-frame-shell${appChrome ? " is-app-surface" : ""}`}>
        {showLoadingProgress && activeTab?.isLoading ? (
          <div
            className="external-webview-loading-progress"
            role="progressbar"
            aria-label={t("common.loading")}
          >
            <span />
          </div>
        ) : null}
        {browserState.tabs.map((tab) => (
          <ExternalWebviewPane
            key={tab.id}
            tab={tab}
            active={tab.id === browserState.activeTabId}
            surfaceId={surfaceId}
            surfaceIdentity={surfaceIdentity ?? undefined}
            surfaceLabel={surfaceLabel ?? title}
            onTabStateChange={handleTabStateChange}
            onCloseRequested={(tabId) => {
              void closeTab(tabId).catch(() => undefined);
            }}
            onDomReady={finishRefreshWaiter}
            preloadUrl={preloadUrl}
            onIpcMessage={onIpcMessage}
            onWebviewRefChange={(tabId, webview) => {
              if (webview) {
                webviewRefs.current.set(tabId, webview);
                return;
              }
              webviewRefs.current.delete(tabId);
            }}
            onFaviconDiscovered={
              onFaviconDiscovered && tab.id === initialFaviconTabIdRef.current
                ? (faviconUrl: string) => {
                    if (faviconReportedRef.current) {
                      return;
                    }
                    faviconReportedRef.current = true;
                    onFaviconDiscovered(faviconUrl);
                  }
                : undefined
            }
            onRuntimeProtectionChange={handleRuntimeProtectionChange}
          />
        ))}
      </div>
    </section>
    </>
  );
}
