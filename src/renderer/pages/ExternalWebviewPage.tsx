import { createElement, useEffect, useRef, useState } from "react";
import type { AssistantPageContext } from "../../shared/contracts";
import { registerAssistantPageContextProvider } from "../services/assistantPageContext";

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
  "title" | "currentUrl" | "guestId" | "canGoBack" | "isLoading"
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

function getUrlDisplayLabel(url: string) {
  try {
    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname === "/" ? "" : parsedUrl.pathname;
    return `${parsedUrl.hostname}${pathname}` || url;
  } catch {
    return url;
  }
}

function normalizeEditableUrl(rawValue: string) {
  const trimmedValue = rawValue.trim();
  if (!trimmedValue) {
    return null;
  }

  try {
    return new URL(trimmedValue).toString();
  } catch {
    try {
      return new URL(`https://${trimmedValue}`).toString();
    } catch {
      return null;
    }
  }
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

    webview.addEventListener("dom-ready", handleDomReady);
    webview.addEventListener("did-start-loading", handleDidStartLoading);
    webview.addEventListener("did-stop-loading", handleDidStopLoading);
    webview.addEventListener("did-navigate", handleDidNavigate);
    webview.addEventListener("did-navigate-in-page", handleDidNavigateInPage);
    webview.addEventListener("page-title-updated", handlePageTitleUpdated);
    syncFromWebview();

    return () => {
      webview.removeEventListener("dom-ready", handleDomReady);
      webview.removeEventListener("did-start-loading", handleDidStartLoading);
      webview.removeEventListener("did-stop-loading", handleDidStopLoading);
      webview.removeEventListener("did-navigate", handleDidNavigate);
      webview.removeEventListener("did-navigate-in-page", handleDidNavigateInPage);
      webview.removeEventListener("page-title-updated", handlePageTitleUpdated);
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
  const browserStateRef = useRef(browserState);

  useEffect(() => {
    browserStateRef.current = browserState;
  }, [browserState]);

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

  const openTab = (nextUrl: string, preferredTitle = "") => {
    const nextTab = createTab(nextUrl, preferredTitle);
    setBrowserState((currentState) => ({
      tabs: [...currentState.tabs, nextTab],
      activeTabId: nextTab.id
    }));
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

      openTab(nextUrl);
    });
  }, []);

  const activeTab = browserState.tabs.find((tab) => tab.id === browserState.activeTabId) ?? browserState.tabs[0];

  useEffect(() => {
    if (active === false || !activeTab) {
      return undefined;
    }

    return registerAssistantPageContextProvider(async () => {
      const currentState = browserStateRef.current;
      const currentActiveTab = currentState.tabs.find((tab) => tab.id === currentState.activeTabId) ?? currentState.tabs[0];
      if (!currentActiveTab || !activeRef.current) {
        return null;
      }

      const activeWebview = webviewRefs.current.get(currentActiveTab.id);
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
    });
  }, [active, activeTab?.id, surfaceId, surfaceLabel, title]);

  useEffect(() => {
    setAddressInputValue(activeTab?.currentUrl ?? url);
  }, [activeTab?.id, activeTab?.currentUrl, url]);

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

  return (
    <section className="pan-page external-webview-page" {...surfaceVisibilityProps}>
      <div className="pan-drag-region" aria-hidden="true" />
      <div className="external-webview-browser-chrome">
        <div className="external-webview-tabbar">
          <div className="external-webview-tab-strip" role="tablist" aria-label="嵌入网页标签页">
            {browserState.tabs.map((tab) => {
              const isActive = tab.id === browserState.activeTabId;
              const canClose = browserState.tabs.length > 1;
              return (
                <div
                  key={tab.id}
                  className={`external-webview-tab${isActive ? " is-active" : ""}`}
                  role="presentation"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className="external-webview-tab-trigger"
                    onClick={() => setActiveTab(tab.id)}
                  >
                    <span
                      className={`external-webview-tab-favicon${tab.isLoading ? " is-loading" : ""}`}
                      aria-hidden="true"
                    >
                      {tab.isLoading ? <span className="external-webview-tab-favicon-spinner" /> : getTabMonogram(tab.title, tab.currentUrl)}
                    </span>
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
              placeholder="搜索 Google 或输入网址"
              aria-label="网页地址"
            />
          </div>
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
  );
}
