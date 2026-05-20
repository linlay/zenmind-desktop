import { createElement, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { useServices } from "../../services/ServicesContext";
import { registerAssistantPageContextProvider } from "../../services/assistantPageContext";
import {
  buildPluginEmbeddedUrl,
  getPluginAuthBridgeProtocol,
} from "../../../shared/auth-bridge";
import {
  AGENT_APP_CLIPBOARD_REQUEST_TYPE,
  AGENT_APP_CLIPBOARD_RESPONSE_TYPE,
  DESKTOP_CONTEXT_CHANGED_MESSAGE_TYPE,
  SERVICE_WEBVIEW_BRIDGE_DEBUG_TYPE,
  SERVICE_WEBVIEW_BRIDGE_DELIVER_CHANNEL,
  SERVICE_WEBVIEW_BRIDGE_MESSAGE_CHANNEL,
  type ServiceWebviewBridgeMessage
} from "../../../shared/service-webview-bridge";
import { getServiceDisplayName } from "../../service-display";
import type { AssistantPageContext, DesktopPageContextSnapshot } from "../../../shared/contracts";
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
import {
  getCurrentPageContextSnapshot,
  publishCurrentPageContextSnapshot,
  subscribeCurrentPageContext
} from "../../services/currentPageContext";
import {
  registerCurrentPageExecutor,
  registerDesktopActionProviderForScope
} from "../../services/desktopActionRegistry";
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

type PluginPageProps = {
  hostTheme: "light" | "dark";
  pluginId?: string;
  active?: boolean;
  embedPath?: string;
  surfaceLabel?: string;
  skipContextRegistration?: boolean;
};

const MAX_PLUGIN_PAGE_CONTEXT_HEADINGS = 24;
const MAX_PLUGIN_PAGE_CONTEXT_BODY_TEXT = 40000;
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
      .slice(0, ${MAX_PLUGIN_PAGE_CONTEXT_HEADINGS}),
    bodyText: normalize(document.body?.innerText || "").slice(0, ${MAX_PLUGIN_PAGE_CONTEXT_BODY_TEXT})
  };
})()`;

function buildAgentWebclientAccessTokenInjectionScript(token: string | null, desktopAuthContext: string) {
  return `(() => {
    const token = ${JSON.stringify(token ?? "")};
    const desktopAuthContext = ${JSON.stringify(desktopAuthContext)};
    const accessTokenStorageKey = "agent-webclient.appAccessToken";
    const authContextStorageKey = "agent-webclient.appAuthContext";
    const bridgeFlag = "__ZENMIND_DESKTOP_WEBVIEW_BRIDGE__";
    const fallbackFlag = "__ZENMIND_AGENT_WEBCLIENT_AUTH_FALLBACK__";
    const fallbackTokenKey = "__ZENMIND_AGENT_WEBCLIENT_FALLBACK_TOKEN__";
    let tokenBefore = "";
    try {
      tokenBefore = window.sessionStorage.getItem(accessTokenStorageKey) || "";
    } catch {
      tokenBefore = "";
    }

    function writeToken(nextToken) {
      const normalizedToken = typeof nextToken === "string" ? nextToken.trim() : "";
      try {
        if (desktopAuthContext) {
          window.sessionStorage.setItem(authContextStorageKey, desktopAuthContext);
        }
        if (normalizedToken) {
          window.sessionStorage.setItem(accessTokenStorageKey, normalizedToken);
        } else {
          window.sessionStorage.removeItem(accessTokenStorageKey);
        }
      } catch {
        // Ignore restricted guest storage.
      }
      window.__AGENT_APP_ACCESS_TOKEN = normalizedToken || undefined;
      window[fallbackTokenKey] = normalizedToken;
      return normalizedToken;
    }

    function markBridgeAvailable() {
      try {
        Object.defineProperty(window, bridgeFlag, {
          configurable: true,
          enumerable: false,
          value: true,
          writable: false
        });
      } catch {
        window[bridgeFlag] = true;
      }
    }

    function isAuthRequest(value) {
      return Boolean(
        value &&
        typeof value === "object" &&
        value.type === "zenmind:agent-app-auth:request" &&
        value.requestId &&
        (value.action === "getAccessToken" || value.action === "refreshAccessToken")
      );
    }

    function respondToAuthRequest(value) {
      if (!isAuthRequest(value)) {
        return false;
      }
      window.dispatchEvent(new MessageEvent("message", {
        data: {
          type: "zenmind:agent-app-auth:response",
          requestId: String(value.requestId),
          token: window[fallbackTokenKey] || null
        },
        origin: location.origin,
        source: window
      }));
      return true;
    }

    markBridgeAvailable();
    const normalizedToken = writeToken(token);
    if (!window[fallbackFlag]) {
      const originalPostMessage = window.postMessage.bind(window);
      try {
        Object.defineProperty(window, fallbackFlag, {
          configurable: true,
          enumerable: false,
          value: true,
          writable: false
        });
      } catch {
        window[fallbackFlag] = true;
      }
      try {
        window.postMessage = function zenmindAgentWebclientPostMessage(value, targetOrigin, transfer) {
          if (respondToAuthRequest(value)) {
            return;
          }
          if (transfer === undefined) {
            originalPostMessage(value, targetOrigin);
            return;
          }
          originalPostMessage(value, targetOrigin, transfer);
        };
      } catch {
        // Ignore non-writable postMessage environments.
      }
      window.addEventListener("message", (event) => {
        respondToAuthRequest(event.data);
      });
    }

    return {
      bridge: Boolean(window[bridgeFlag]),
      tokenBeforeLength: tokenBefore.length,
      tokenAfterLength: normalizedToken.length
    };
  })()`;
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function buildAgentWebclientDesktopContext(snapshot: DesktopPageContextSnapshot | null) {
  if (!snapshot) {
    return null;
  }
  return snapshot;
}

function buildPluginWebviewFallbackContext(
  serviceDisplayName: string,
  embeddedUrl: string,
  webUrl: string,
  surfaceId: string,
  surfaceLabel: string,
  surfaceRoute?: string,
  embedPath?: string
): AssistantPageContext {
  const normalizedName = normalizeWhitespace(serviceDisplayName || "内嵌应用");
  const fallbackUrl = embeddedUrl || webUrl || window.location.href;
  return {
    url: fallbackUrl,
    title: normalizedName || "内嵌应用",
    selectedText: "",
    metaDescription: "",
    headings: [],
    bodyText: [
      `当前左侧区域是内嵌应用「${normalizedName || "内嵌应用"}」。`,
      "需要实时读取或操作时，优先使用 desktop.page.readCurrent、desktop.page.extractStructured、desktop.page.interact、desktop.page.fillForm、desktop.page.submitForm。"
    ].join(" "),
    browserTarget: fallbackUrl
      ? {
          kind: "webview",
          surfaceId,
          surfaceLabel,
          ...(surfaceRoute ? { surfaceRoute } : {}),
          ...(embedPath ? { embedPath } : {}),
          currentUrl: fallbackUrl
        }
      : undefined
  };
}

function readEventString(event: Event, key: string) {
  const value = (event as Event & Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function readWebviewContentsId(webview: Electron.WebviewTag | null) {
  try {
    const webContentsId = webview?.getWebContentsId();
    return Number.isFinite(webContentsId) ? webContentsId : undefined;
  } catch {
    return undefined;
  }
}

async function tryReadPluginWebviewPageContext(
  webview: Electron.WebviewTag | null,
  serviceDisplayName: string,
  embeddedUrl: string,
  webUrl: string,
  surfaceId: string,
  surfaceLabel: string,
  surfaceRoute: string,
  embedPath: string | undefined,
  currentUrl: string
): Promise<AssistantPageContext | null> {
  if (!webview) {
    return null;
  }

  try {
    const pageContext = await webview.executeJavaScript(WEBVIEW_PAGE_CONTEXT_SCRIPT, true);
    const nextUrl = typeof pageContext?.url === "string" && pageContext.url ? pageContext.url : currentUrl || embeddedUrl || webUrl;

    return {
      url: nextUrl,
      title: typeof pageContext?.title === "string" && pageContext.title
        ? pageContext.title
        : serviceDisplayName || "内嵌应用",
      selectedText: typeof pageContext?.selectedText === "string" ? pageContext.selectedText : "",
      metaDescription: typeof pageContext?.metaDescription === "string" ? pageContext.metaDescription : "",
      headings: Array.isArray(pageContext?.headings)
        ? pageContext.headings.filter((item: unknown): item is string => typeof item === "string")
        : [],
      bodyText: typeof pageContext?.bodyText === "string" ? pageContext.bodyText : "",
      browserTarget: {
        kind: "webview",
        surfaceId,
        surfaceLabel,
        ...(surfaceRoute ? { surfaceRoute } : {}),
        ...(embedPath ? { embedPath } : {}),
        currentUrl: nextUrl
      }
    };
  } catch {
    return null;
  }
}

export function PluginPage({
  hostTheme,
  pluginId: pluginIdProp,
  active,
  embedPath,
  surfaceLabel,
  skipContextRegistration
}: PluginPageProps) {
  const location = useLocation();
  const currentRoute = `${location.pathname}${location.search}`;
  const { pluginId: routePluginId } = useParams<{ pluginId: string }>();
  const pluginId = pluginIdProp ?? routePluginId ?? "";
  const { services, refresh: refreshServices } = useServices();
  const service = services.find((s) => s.id === pluginId);
  const agentPlatformService = service?.id === "agent-webclient"
    ? services.find((s) => s.id === "agent-platform")
    : null;
  const serviceDisplayName = surfaceLabel || (service ? getServiceDisplayName(service.id, service.name) : "");
  const surfaceRoute = location.pathname;
  const [bridgeError, setBridgeError] = useState("");
  const [bridgeReady, setBridgeReady] = useState(false);
  const [webviewRetryNonce, setWebviewRetryNonce] = useState(0);
  const [webviewLoadError, setWebviewLoadError] = useState(false);
  const [webviewCurrentUrl, setWebviewCurrentUrl] = useState("");
  const [serviceWebviewPreloadPath, setServiceWebviewPreloadPath] = useState("");
  const webviewRef = useRef<Electron.WebviewTag | null>(null);
  const agentWebclientTokenReloadTimerRef = useRef<number | null>(null);
  const surfaceVisibilityProps = active === undefined
    ? {}
    : {
        hidden: !active,
        "aria-hidden": !active
      };

  const webUrl = service?.healthMeta.webUrl ?? "";
  const bridgeProtocol = useMemo(
    () => getPluginAuthBridgeProtocol(service?.id),
    [service?.id],
  );
  const webviewReloadKey = [
    service?.healthMeta.pid ?? "",
    service?.id === "agent-webclient" ? agentPlatformService?.status ?? "" : "",
    service?.id === "agent-webclient" ? agentPlatformService?.healthMeta.pid ?? "" : ""
  ].join(":");
  const routeEmbedPath = useMemo(() => {
    if (service?.id !== "agent-webclient") {
      return "";
    }
    try {
      return new URLSearchParams(location.search).get("embedPath")?.trim() ?? "";
    } catch {
      return "";
    }
  }, [location.search, service?.id]);
  const effectiveEmbedPath = service?.id === "agent-webclient"
    ? (embedPath || routeEmbedPath || undefined)
    : undefined;
  const embeddedUrl = useMemo(() => {
    return buildPluginEmbeddedUrl(service?.id, webUrl, {
      hostTheme,
      desktopAuthContext: service?.id === "agent-webclient" ? webviewReloadKey : undefined,
      embedPath: effectiveEmbedPath,
      baseUrl: service?.healthMeta.port ? `http://127.0.0.1:${service.healthMeta.port}` : undefined
    });
  }, [effectiveEmbedPath, hostTheme, service?.healthMeta.port, service?.id, webUrl, webviewReloadKey]);
  const webviewBaseKey = useMemo(
    () => [service?.id ?? "service", webviewReloadKey, embeddedUrl].join(":"),
    [embeddedUrl, service?.id, webviewReloadKey]
  );
  const webviewRenderKey = useMemo(
    () => [webviewBaseKey, webviewRetryNonce].join(":"),
    [webviewBaseKey, webviewRetryNonce]
  );
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

  function readCurrentWebviewUrl() {
    try {
      const webviewUrl = webviewRef.current?.getURL();
      return typeof webviewUrl === "string" && webviewUrl.trim()
        ? webviewUrl.trim()
        : embeddedUrl;
    } catch {
      return embeddedUrl;
    }
  }

  async function readPluginPageContext() {
    return await tryReadPluginWebviewPageContext(
      webviewRef.current,
      serviceDisplayName,
      embeddedUrl,
      webUrl,
      pluginId,
      serviceDisplayName,
      surfaceRoute,
      effectiveEmbedPath,
      readCurrentWebviewUrl()
    ) ?? buildPluginWebviewFallbackContext(
      serviceDisplayName,
      embeddedUrl,
      webUrl,
      pluginId,
      serviceDisplayName,
      surfaceRoute,
      effectiveEmbedPath
    );
  }

  async function executeWebviewScript(args: Record<string, unknown>, script: string) {
    if (getUtf8ByteLength(script) > EMBEDDED_WEB_SCRIPT_MAX_BYTES) {
      return embeddedError("script_too_large", "脚本超过内嵌网页执行大小限制。");
    }
    const targetWebview = webviewRef.current;
    if (!targetWebview) {
      return embeddedError("webview_unavailable", "目标内嵌网页不可用。");
    }
    try {
      const result = await targetWebview.executeJavaScript(script, true);
      return { ok: true, result };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "webview_execution_failed",
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  const createCurrentPageDescriptor = () => {
    const currentUrl = webviewCurrentUrl || readCurrentWebviewUrl() || embeddedUrl || webUrl;
    const webContentsId = readWebviewContentsId(webviewRef.current);
    return {
      route: currentRoute,
      pageKey: `webview:${currentRoute}:${pluginId}:${currentUrl || "webview"}`,
      pageKind: "webview" as const,
      ...(pluginId ? { surfaceId: pluginId } : {}),
      ...(serviceDisplayName ? { surfaceLabel: serviceDisplayName } : {}),
      ...(surfaceRoute ? { surfaceRoute } : {}),
      ...(effectiveEmbedPath ? { embedPath: effectiveEmbedPath } : {}),
      ...(typeof webContentsId === "number" ? { webContentsId } : {})
    };
  };

  function attachDescriptorMetadata(payload: Record<string, unknown>) {
    const descriptor = createCurrentPageDescriptor();
    return {
      pageKey: descriptor.pageKey,
      pageKind: descriptor.pageKind,
      ...(descriptor.surfaceId ? { surfaceId: descriptor.surfaceId } : {}),
      ...(descriptor.surfaceLabel ? { surfaceLabel: descriptor.surfaceLabel } : {}),
      ...(descriptor.surfaceRoute ? { surfaceRoute: descriptor.surfaceRoute } : {}),
      ...(descriptor.embedPath ? { embedPath: descriptor.embedPath } : {}),
      ...payload
    };
  }

  async function executeCurrentPageRead(args: Record<string, unknown>) {
    const response = await executeWebviewScript(args, READ_PAGE_DATA_SCRIPT);
    if (!response.ok) {
      return response;
    }
    return {
      ok: true,
      result: attachDescriptorMetadata({
        realtime: true,
        readAt: new Date().toISOString(),
        pageContext: await readPluginPageContext(),
        data: filterReadPageDataResult(
          response.result,
          readAllowedValues(args.include, EMBEDDED_WEB_READ_INCLUDES)
        )
      })
    };
  }

  async function executeCurrentPageStructuredRead(args: Record<string, unknown>) {
    const response = await executeWebviewScript(args, EXTRACT_STRUCTURED_SCRIPT);
    if (!response.ok) {
      return response;
    }
    return {
      ok: true,
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
      return embeddedError("invalid_args", "selector 和有效的 action 是必填项。", args);
    }
    const response = await executeWebviewScript(args, buildInteractElementScript({
      selector,
      action: action as EmbeddedWebInteractAction,
      value: typeof args.value === "string" ? args.value : args.value == null ? undefined : String(args.value)
    }));
    if (!response.ok) {
      return response;
    }
    return {
      ok: true,
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
      return embeddedError("invalid_args", "fields 是必填项，且每个字段都需要 selector。", args);
    }
    const response = await executeWebviewScript(args, buildFillFormScript({
      formSelector: typeof args.formSelector === "string" ? args.formSelector.trim() : undefined,
      fields
    }));
    if (!response.ok) {
      return response;
    }
    return {
      ok: true,
      result: attachDescriptorMetadata({
        filled: true,
        outcome: response.result
      })
    };
  }

  async function executeCurrentPageSubmitForm(args: Record<string, unknown>) {
    const response = await executeWebviewScript(args, buildSubmitFormScript({
      formSelector: typeof args.formSelector === "string" ? args.formSelector.trim() : undefined,
      submitSelector: typeof args.submitSelector === "string" ? args.submitSelector.trim() : undefined
    }));
    if (!response.ok) {
      return response;
    }
    return {
      ok: true,
      result: attachDescriptorMetadata({
        submitted: true,
        outcome: response.result
      })
    };
  }

  useEffect(() => {
    setBridgeError("");
  }, [service?.id, embeddedUrl]);

  useEffect(() => {
    setWebviewCurrentUrl(embeddedUrl);
  }, [embeddedUrl]);

  useEffect(() => {
    if (service?.id !== "agent-webclient" || active === false || !embeddedUrl) {
      return;
    }

    const webview = webviewRef.current;
    if (!webview || webview.getURL() === embeddedUrl) {
      return;
    }

    webview.loadURL(embeddedUrl).catch((error) => {
      console.warn("[plugin-page] failed to navigate agent webclient webview", error);
    });
  }, [active, embeddedUrl, service?.id, webviewRenderKey]);

  useEffect(() => {
    setWebviewRetryNonce(0);
    setWebviewLoadError(false);
  }, [service?.status, webviewBaseKey]);

  useEffect(() => {
    let cancelled = false;
    setBridgeReady(false);
    void window.electronAPI.plugins
      .getServiceWebviewPreloadPath()
      .then((preloadPath) => {
        if (cancelled) {
          return;
        }
        setServiceWebviewPreloadPath(preloadPath);
        setBridgeReady(true);
      })
      .catch((reason) => {
        if (cancelled) {
          return;
        }
        setBridgeError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
      setBridgeReady(false);
    };
  }, []);

  function sendBridgeMessageToWebview(payload: Record<string, unknown>) {
    try {
      webviewRef.current?.send(SERVICE_WEBVIEW_BRIDGE_DELIVER_CHANNEL, payload);
    } catch {
      // Ignore bridge delivery while the guest webContents is being recreated.
    }
  }

  async function injectAgentWebclientAccessToken(token: string | null) {
    if (service?.id !== "agent-webclient") {
      return false;
    }
    const targetWebview = webviewRef.current;
    if (!targetWebview) {
      return false;
    }

    const desktopAuthContext = webviewReloadKey;
    try {
      const result = await targetWebview.executeJavaScript(
        buildAgentWebclientAccessTokenInjectionScript(token, desktopAuthContext),
        true
      ) as { tokenBeforeLength?: number; tokenAfterLength?: number } | null;
      return Boolean(
        token &&
          desktopAuthContext &&
          result &&
          (result.tokenBeforeLength ?? 0) === 0 &&
          (result.tokenAfterLength ?? 0) > 0
      );
    } catch (reason) {
      console.warn(
        "[agent-webclient] failed to inject access token fallback",
        reason instanceof Error ? reason.message : String(reason)
      );
      return false;
    }
  }

  function seedAgentWebclientAccessToken() {
    if (service?.id !== "agent-webclient" || !bridgeProtocol) {
      return;
    }
    void window.electronAPI.agentAuth
      .issueAccessToken("missing")
      .then(async (result) => {
        const token = result.ok ? result.token : null;
        const shouldReloadAfterInjection = await injectAgentWebclientAccessToken(token);
        sendBridgeMessageToWebview({
          type: bridgeProtocol.responseType,
          requestId: `agent_webclient_seed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          token
        });
        if (shouldReloadAfterInjection) {
          if (agentWebclientTokenReloadTimerRef.current !== null) {
            window.clearTimeout(agentWebclientTokenReloadTimerRef.current);
          }
          agentWebclientTokenReloadTimerRef.current = window.setTimeout(() => {
            agentWebclientTokenReloadTimerRef.current = null;
            webviewRef.current?.reload();
          }, 50);
        }
        if (!result.ok) {
          setBridgeError(result.message);
        }
      })
      .catch((reason) => {
        setBridgeError(reason instanceof Error ? reason.message : String(reason));
      });
  }

  function scheduleAgentWebclientAccessTokenSeeds() {
    const delays = [0, 150, 500, 1000, 2000];
    return delays.map((delay) => window.setTimeout(() => {
      seedAgentWebclientAccessToken();
    }, delay));
  }

  function handleWebviewBridgeMessage(event: Event) {
    const channel = readEventString(event, "channel");
    if (channel !== SERVICE_WEBVIEW_BRIDGE_MESSAGE_CHANNEL) {
      return;
    }
    const [payload] = ((event as Event & { args?: unknown[] }).args ?? []) as [ServiceWebviewBridgeMessage?];
    if (!payload || !payload.type || !payload.requestId) {
      return;
    }

    if (payload.type === SERVICE_WEBVIEW_BRIDGE_DEBUG_TYPE) {
      console.info("[service-webview]", service?.id || "plugin", payload.stage || "", payload.message || "");
      return;
    }

    if (
      bridgeProtocol &&
      payload.type === bridgeProtocol.requestType &&
      (payload.action === "getAccessToken" || payload.action === "refreshAccessToken")
    ) {
      void window.electronAPI.agentAuth
        .issueAccessToken(payload.reason === "unauthorized" ? "unauthorized" : "missing")
        .then((result) => {
          sendBridgeMessageToWebview({
            type: bridgeProtocol.responseType,
            requestId: payload.requestId,
            token: result.ok ? result.token : null
          });
          if (!result.ok) {
            setBridgeError(result.message);
          }
        })
        .catch((reason) => {
          setBridgeError(reason instanceof Error ? reason.message : String(reason));
        });
      return;
    }

    if (payload.type === AGENT_APP_CLIPBOARD_REQUEST_TYPE) {
      void window.electronAPI.clipboard
        .writeText(typeof payload.text === "string" ? payload.text : "")
        .then((result) => {
          sendBridgeMessageToWebview({
            type: AGENT_APP_CLIPBOARD_RESPONSE_TYPE,
            requestId: payload.requestId,
            ok: result.ok,
            message: result.message ?? ""
          });
        })
        .catch((reason) => {
          sendBridgeMessageToWebview({
            type: AGENT_APP_CLIPBOARD_RESPONSE_TYPE,
            requestId: payload.requestId,
            ok: false,
            message: reason instanceof Error ? reason.message : String(reason)
          });
        });
    }
  }

  function webviewLoadedChromeErrorPage() {
    try {
      return webviewRef.current?.getURL().startsWith("chrome-error://") ?? false;
    } catch {
      return false;
    }
  }

  function syncWebviewState() {
    setWebviewCurrentUrl(readCurrentWebviewUrl());
    if (!webviewLoadedChromeErrorPage()) {
      setWebviewLoadError(false);
      return;
    }

    setWebviewLoadError(true);
    void refreshServices();
    if (webviewRetryNonce >= 2 || service?.status !== "running") {
      return;
    }

    window.setTimeout(() => {
      setWebviewRetryNonce((current) => (current === webviewRetryNonce ? current + 1 : current));
    }, 450);
  }

  useEffect(() => {
    if (!bridgeReady || !serviceWebviewPreloadPath) {
      return undefined;
    }

    const targetWebview = webviewRef.current;
    if (!targetWebview) {
      return undefined;
    }

    const handleDomReady = () => {
      syncWebviewState();
      seedAgentWebclientAccessToken();
    };
    const handleDidFinishLoad = () => {
      syncWebviewState();
      seedAgentWebclientAccessToken();
    };
    const handleDidNavigate = (event: Event) => {
      const nextUrl = readEventString(event, "url");
      setWebviewCurrentUrl(nextUrl || readCurrentWebviewUrl());
      seedAgentWebclientAccessToken();
    };
    const handleDidNavigateInPage = (event: Event) => {
      const nextUrl = readEventString(event, "url");
      setWebviewCurrentUrl(nextUrl || readCurrentWebviewUrl());
      seedAgentWebclientAccessToken();
    };
    const handleDidFailLoad = () => syncWebviewState();

    targetWebview.addEventListener("dom-ready", handleDomReady);
    targetWebview.addEventListener("did-finish-load", handleDidFinishLoad);
    targetWebview.addEventListener("did-navigate", handleDidNavigate);
    targetWebview.addEventListener("did-navigate-in-page", handleDidNavigateInPage);
    targetWebview.addEventListener("did-fail-load", handleDidFailLoad);
    targetWebview.addEventListener("ipc-message", handleWebviewBridgeMessage);
    syncWebviewState();
    const seedTimers = scheduleAgentWebclientAccessTokenSeeds();

    return () => {
      seedTimers.forEach((timer) => window.clearTimeout(timer));
      targetWebview.removeEventListener("dom-ready", handleDomReady);
      targetWebview.removeEventListener("did-finish-load", handleDidFinishLoad);
      targetWebview.removeEventListener("did-navigate", handleDidNavigate);
      targetWebview.removeEventListener("did-navigate-in-page", handleDidNavigateInPage);
      targetWebview.removeEventListener("did-fail-load", handleDidFailLoad);
      targetWebview.removeEventListener("ipc-message", handleWebviewBridgeMessage);
    };
  }, [
    bridgeProtocol,
    bridgeReady,
    active,
    service?.id,
    service?.status,
    serviceWebviewPreloadPath,
    webviewRenderKey,
    webviewRetryNonce
  ]);

  useEffect(() => {
    if (active === false || !bridgeReady || !serviceWebviewPreloadPath) {
      return;
    }
    seedAgentWebclientAccessToken();
  }, [active, bridgeReady, embeddedUrl, service?.id, serviceWebviewPreloadPath, webviewRenderKey]);

  useEffect(() => {
    return () => {
      if (agentWebclientTokenReloadTimerRef.current !== null) {
        window.clearTimeout(agentWebclientTokenReloadTimerRef.current);
        agentWebclientTokenReloadTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (service?.id !== "agent-webclient" || active === false || !embeddedUrl) {
      return undefined;
    }

    const postDesktopContextChanged = () => {
      sendBridgeMessageToWebview({
        type: DESKTOP_CONTEXT_CHANGED_MESSAGE_TYPE,
        desktop: buildAgentWebclientDesktopContext(getCurrentPageContextSnapshot())
      });
    };

    postDesktopContextChanged();
    const unsubscribe = subscribeCurrentPageContext(() => {
      postDesktopContextChanged();
    });
    return () => {
      unsubscribe();
    };
  }, [active, embeddedUrl, service?.id, webviewRenderKey]);

  useEffect(() => {
    if (active === false || service?.status !== "running" || skipContextRegistration) {
      return undefined;
    }

    let cancelled = false;
    void (async () => {
      const pageContext = await readPluginPageContext();
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
    currentRoute,
    embeddedUrl,
    pluginId,
    service?.status,
    serviceDisplayName,
    skipContextRegistration,
    webviewCurrentUrl,
    webUrl
  ]);

  useEffect(() => {
    if (active === false || service?.status !== "running" || skipContextRegistration) {
      return undefined;
    }

    return registerAssistantPageContextProvider(async () => {
      return readPluginPageContext();
    });
  }, [active, embeddedUrl, pluginId, service?.status, serviceDisplayName, skipContextRegistration, webUrl]);

  useEffect(() => {
    if (active === false || service?.status !== "running" || skipContextRegistration) {
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
  }, [
    active,
    currentRoute,
    embeddedUrl,
    pluginId,
    service?.status,
    serviceDisplayName,
    skipContextRegistration,
    webviewCurrentUrl,
    webUrl
  ]);

  useEffect(() => {
    if (active === false || service?.status !== "running" || !embeddedUrl || skipContextRegistration) {
      return undefined;
    }

    function requestTargetsDifferentSurface(args: Record<string, unknown>) {
      const targetSurfaceId = typeof args.surfaceId === "string" ? args.surfaceId.trim() : "";
      return Boolean(targetSurfaceId && targetSurfaceId !== pluginId);
    }

    return registerDesktopActionProviderForScope("embeddedWeb", async (request) => {
      if (active === false || service?.status !== "running") {
        return null;
      }
      const args = request.args ?? {};
      if (requestTargetsDifferentSurface(args)) {
        return null;
      }

      switch (request.action) {
        case "desktop.embeddedWeb.getActiveSurface":
          return {
            ok: true,
            result: {
              surface: {
                id: pluginId,
                label: serviceDisplayName,
                url: embeddedUrl,
                active: active !== false,
                currentUrl: webviewCurrentUrl || embeddedUrl,
                title: serviceDisplayName
              },
              tabs: [],
              activeTab: null
            }
          };
        case "desktop.embeddedWeb.getPageContext":
          return { ok: true, result: await readPluginPageContext() };
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
            return embeddedError("invalid_script", "script 是必填项。");
          }
          return executeWebviewScript(args, script);
        }
        default:
          return null;
      }
    });
  }, [active, embeddedUrl, pluginId, service?.status, serviceDisplayName, skipContextRegistration, webviewCurrentUrl, webUrl]);

  if (!service) {
    if (pluginId === "agent-webclient") {
      return (
        <section className="empty-state" {...surfaceVisibilityProps}>
          <h1>智能助理服务未注册</h1>
          <p>未找到 agent-webclient 内置服务。请确认 Desktop 已同步完整内置资源，或在控制中心安装 agent-webclient 发布包。</p>
          <Link className="primary-link" to="/control-center">
            前往控制中心
          </Link>
        </section>
      );
    }

    return (
      <section className="empty-state" {...surfaceVisibilityProps}>
        <h1>服务未注册</h1>
        <p>未找到 ID 为 {pluginId} 的服务。</p>
        <Link className="primary-link" to="/control-center">
          返回控制中心
        </Link>
      </section>
    );
  }

  if (service.status !== "running") {
    return (
      <section className="empty-state" {...surfaceVisibilityProps}>
        <p className="eyebrow">PLUGIN</p>
        <h1>{serviceDisplayName} 暂未就绪</h1>
        <p>{service.message}</p>
        <Link className="primary-link" to="/control-center">
          前往控制中心
        </Link>
      </section>
    );
  }

  if (service.frontendMode === "none" || !webUrl || !embeddedUrl) {
    return (
      <section className="empty-state" {...surfaceVisibilityProps}>
        <h1>{serviceDisplayName}</h1>
        <p>该服务没有前端页面。</p>
        <Link className="primary-link" to="/control-center">
          返回控制中心
        </Link>
      </section>
    );
  }

  if (bridgeError) {
    return (
      <section className="empty-state" {...surfaceVisibilityProps}>
        <p className="eyebrow">PLUGIN</p>
        <h1>{serviceDisplayName}</h1>
        <p>认证桥接失败：{bridgeError}</p>
        <Link className="primary-link" to="/control-center">
          返回控制中心
        </Link>
      </section>
    );
  }

  return (
    <section className="pan-page pan-page-embedded" {...surfaceVisibilityProps}>
      <div className="pan-drag-region" aria-hidden="true" />
      <div className="pan-frame-shell">
        {bridgeReady && serviceWebviewPreloadPath ? (
          <>
            {webviewLoadError ? (
              <section className="empty-state embedded-plugin-error" aria-live="polite">
                <p className="eyebrow">PLUGIN</p>
                <h1>{serviceDisplayName}</h1>
                <p>智能助理服务正在恢复，页面会自动重新加载。</p>
              </section>
            ) : null}
            {createElement("webview", {
              key: webviewRenderKey,
              ref: (node: Electron.WebviewTag | null) => {
                webviewRef.current = node;
              },
              src: embeddedUrl,
              title: serviceDisplayName,
              className: "pan-frame",
              preload: serviceWebviewPreloadPath,
              partition: `persist:zenmind-service-${pluginId || "plugin"}`,
              allowpopups: "true",
              style: { width: "100%", height: "100%", border: "none" }
            })}
          </>
        ) : (
          <section className="empty-state">
            <p className="eyebrow">PLUGIN</p>
            <h1>{serviceDisplayName}</h1>
            <p>正在准备认证上下文…</p>
          </section>
        )}
      </div>
    </section>
  );
}
