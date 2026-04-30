import { createElement, useEffect, useRef, useState } from "react";

type ExternalWebviewPageProps = {
  title: string;
  url: string;
  active?: boolean;
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

const NEW_TAB_URL = "about:blank";
const NEW_TAB_TITLE = "新标签页";
const BOOKMARK_BAR_ITEMS = [
  { label: "手机新标签页", tone: "blue" },
  { label: "云台", tone: "cyan" },
  { label: "Server Integration", tone: "purple" },
  { label: "腾讯云", tone: "red" },
  { label: "Google Service", tone: "yellow" },
  { label: "jialin Notebook", tone: "black" },
  { label: "Tencent Cloud", tone: "blue" },
  { label: "Claude Code 源码", tone: "cyan" }
] as const;

type ExternalWebviewPaneProps = {
  tab: ExternalWebviewTabState;
  active: boolean;
  onTabStateChange: (tabId: string, patch: ExternalWebviewTabPatch) => void;
  onWebviewRefChange: (tabId: string, webview: Electron.WebviewTag | null) => void;
};

function isNewTabUrl(url: string) {
  return url === "" || url === NEW_TAB_URL;
}

function getFallbackTabTitle(defaultTitle: string, url: string) {
  if (isNewTabUrl(url)) {
    return NEW_TAB_TITLE;
  }

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

function getTabDisplayTitle(tab: ExternalWebviewTabState) {
  return isNewTabUrl(tab.currentUrl) ? NEW_TAB_TITLE : tab.title;
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

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285f4"
        d="M23.5 12.3c0-.8-.1-1.5-.2-2.2H12v4.2h6.5c-.3 1.4-1.1 2.6-2.3 3.4v2.8h3.7c2.2-2 3.6-4.9 3.6-8.2Z"
      />
      <path
        fill="#34a853"
        d="M12 24c3.1 0 5.8-1 7.7-2.8l-3.7-2.8c-1 .7-2.4 1.1-4 1.1-3 0-5.6-2-6.5-4.8H1.8v2.9C3.7 21.4 7.6 24 12 24Z"
      />
      <path
        fill="#fbbc05"
        d="M5.5 14.7a7.2 7.2 0 0 1 0-4.7V7.1H1.8A12 12 0 0 0 1.8 17.6l3.7-2.9Z"
      />
      <path
        fill="#ea4335"
        d="M12 4.5c1.7 0 3.2.6 4.4 1.7l3.3-3.3A11.2 11.2 0 0 0 12 0C7.6 0 3.7 2.6 1.8 6.4L5.5 9.3C6.4 6.5 9 4.5 12 4.5Z"
      />
    </svg>
  );
}

function ChromeTabIcon() {
  return (
    <span className="external-webview-tab-chrome-mark" aria-hidden="true">
      <span className="external-webview-tab-chrome-center" />
    </span>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 4.5v11M4.5 10h11" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m5.5 7.5 4.5 4.5 4.5-4.5" />
    </svg>
  );
}

function ExtensionsIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M7.5 3.5h5v3h1.4a2.1 2.1 0 0 1 0 4.2h-1.4v5.8h-5v-2a2 2 0 1 0-4 0v2h-1v-5.8h1.4a2.1 2.1 0 1 0 0-4.2H2.5v-3h5Z" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="4.5" r="1.25" />
      <circle cx="10" cy="10" r="1.25" />
      <circle cx="10" cy="15.5" r="1.25" />
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

export function ExternalWebviewPage({ title, url, active }: ExternalWebviewPageProps) {
  const tabSequenceRef = useRef(0);
  const webviewRefs = useRef(new Map<string, Electron.WebviewTag>());
  const addressInputRef = useRef<HTMLInputElement | null>(null);
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
    const resolvedUrl = initialUrl.trim() || NEW_TAB_URL;
    return {
      id: `external-tab-${tabSequenceRef.current}`,
      title: getFallbackTabTitle(preferredTitle, resolvedUrl),
      currentUrl: resolvedUrl,
      guestId: null,
      canGoBack: false,
      isLoading: !isNewTabUrl(resolvedUrl)
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
  const [addressInputValue, setAddressInputValue] = useState(() => isNewTabUrl(url) ? "" : url);
  const [addressInputFocused, setAddressInputFocused] = useState(false);
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
    setAddressInputValue(isNewTabUrl(url) ? "" : url);
  }, [title, url]);

  const openTab = (nextUrl = NEW_TAB_URL, preferredTitle = NEW_TAB_TITLE) => {
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
    const nextUrl = activeTab?.currentUrl ?? url;
    setAddressInputValue(isNewTabUrl(nextUrl) ? "" : nextUrl);
  }, [activeTab?.id, activeTab?.currentUrl, url]);

  useEffect(() => {
    if (active === false || !activeTab || !isNewTabUrl(activeTab.currentUrl)) {
      return;
    }

    const animationFrame = window.requestAnimationFrame(() => {
      addressInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [active, activeTab?.id, activeTab?.currentUrl]);

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

    if (!addressInputValue.trim()) {
      setAddressInputValue(isNewTabUrl(activeTab.currentUrl) ? "" : activeTab.currentUrl);
      return;
    }

    const normalizedUrl = normalizeEditableUrl(addressInputValue);
    if (!normalizedUrl) {
      setAddressInputValue(isNewTabUrl(activeTab.currentUrl) ? "" : activeTab.currentUrl);
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
      setAddressInputValue(isNewTabUrl(activeTab.currentUrl) ? "" : activeTab.currentUrl);
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
              const tabTitle = getTabDisplayTitle(tab);
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
                      {tab.isLoading ? <span className="external-webview-tab-favicon-spinner" /> : <ChromeTabIcon />}
                    </span>
                    <span className="external-webview-tab-title">{tabTitle}</span>
                  </button>
                  {canClose ? (
                    <button
                      type="button"
                      className="external-webview-tab-close"
                      onClick={(event) => {
                        event.stopPropagation();
                        closeTab(tab.id);
                      }}
                      aria-label={`关闭 ${tabTitle}`}
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
            onClick={() => openTab()}
            aria-label="新建标签页"
            title="新建标签页"
          >
            <PlusIcon />
          </button>
          <button
            type="button"
            className="external-webview-tab-search"
            aria-label="搜索标签页"
            title="搜索标签页"
          >
            <ChevronDownIcon />
          </button>
        </div>
        <div className="external-webview-toolbar">
          <div className="external-webview-toolbar-actions">
            {activeTab?.canGoBack ? (
              <button
                type="button"
                className="external-webview-toolbar-button"
                onClick={handleGoBack}
                aria-label="后退"
                title="后退"
              >
                <ArrowLeftIcon />
              </button>
            ) : null}
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
          <div
            className={[
              "external-webview-toolbar-location",
              addressInputFocused ? "is-focused" : "",
              activeTab && isNewTabUrl(activeTab.currentUrl) ? "is-new-tab" : ""
            ].filter(Boolean).join(" ")}
          >
            <span className="external-webview-toolbar-location-icon" aria-hidden="true">
              <GoogleIcon />
            </span>
            <input
              ref={addressInputRef}
              type="text"
              className="external-webview-toolbar-location-input"
              value={addressInputValue}
              onChange={(event) => {
                setAddressInputValue(event.target.value);
              }}
              onBlur={() => {
                setAddressInputFocused(false);
                const nextUrl = activeTab?.currentUrl ?? url;
                setAddressInputValue(isNewTabUrl(nextUrl) ? "" : nextUrl);
              }}
              onFocus={() => {
                setAddressInputFocused(true);
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
          <div className="external-webview-toolbar-right">
            <button type="button" className="external-webview-toolbar-button" aria-label="扩展程序" title="扩展程序">
              <ExtensionsIcon />
            </button>
            <span className="external-webview-toolbar-divider" aria-hidden="true" />
            <button type="button" className="external-webview-profile-button" aria-label="个人资料" title="个人资料">
              n
            </button>
            <button type="button" className="external-webview-toolbar-button" aria-label="更多" title="更多">
              <MoreIcon />
            </button>
          </div>
        </div>
        <div className="external-webview-bookmarks-bar" aria-hidden="true">
          {BOOKMARK_BAR_ITEMS.map((item) => (
            <span className="external-webview-bookmark-item" key={item.label}>
              <span className={`external-webview-bookmark-icon is-${item.tone}`} />
              <span className="external-webview-bookmark-label">{item.label}</span>
            </span>
          ))}
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
