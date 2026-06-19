import { createElement, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams, useNavigate } from "react-router-dom";
import { useServices } from "../../services/ServicesContext";
import { registerAssistantPageContextProvider } from "../../copilot/page-context/assistantPageContext";
import {
  buildPluginEmbeddedUrl,
  getPluginAuthBridgeProtocol,
} from "../../../shared/auth-bridge";
import { buildAgentWebclientAccessTokenInjectionScript } from "../../../shared/agent-webclient-auth-injection";
import { useI18n } from "../../i18n/useI18n";
import {
  DESKTOP_CONTEXT_CHANGED_MESSAGE_TYPE,
  DESKTOP_ROUTE_CHANGED_MESSAGE_TYPE,
  SERVICE_WEBVIEW_BRIDGE_DELIVER_CHANNEL,
  SERVICE_WEBVIEW_BRIDGE_MESSAGE_CHANNEL,
  SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL,
  type ServiceWebviewBridgeMessage,
} from "../../../shared/service-webview-bridge";
import { handleServiceWebviewBridgeMessage } from "../../services/serviceWebviewBridgeHost";
import { getServiceDisplayName } from "../../service-display";
import type {
  AssistantPageContext,
  DesktopPageContextSnapshot,
} from "../../../shared/contracts";
import type { TranslateFunction } from "../../../shared/i18n";
import {
  EXTRACT_STRUCTURED_SCRIPT,
  READ_PAGE_DATA_SCRIPT,
  buildFillFormScript,
  buildInteractElementScript,
  buildSubmitFormScript,
  type EmbeddedWebInteractAction,
} from "../../../shared/embedded-web-scripts";
import {
  getCurrentPageContextSnapshot,
  publishCurrentPageContextSnapshot,
  subscribeCurrentPageContext,
} from "../../services/currentPageContext";
import { registerPluginSurfaceWebviewRef } from "../../services/pluginSurfaceWebviewRefs";
import {
  registerCurrentPageExecutor,
  registerDesktopActionProviderForScope,
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
  readFormFields,
} from "../../copilot/page-context/embeddedWebActions";
import { STORAGE_NAMESPACE } from "../../../shared/generated/brand";

type PluginPageProps = {
  hostTheme: "light" | "dark";
  pluginId?: string;
  surfaceId?: string;
  active?: boolean;
  embedPath?: string;
  surfaceLabel?: string;
  skipContextRegistration?: boolean;
  loadInitialEmbeddedUrlDirectly?: boolean;
  suppressInitialLoadingCopy?: boolean;
};

const MAX_PLUGIN_PAGE_CONTEXT_HEADINGS = 24;
const MAX_PLUGIN_PAGE_CONTEXT_BODY_TEXT = 40000;
const AGENT_WEBCLIENT_SOURCE_FALLBACK = "agent-webclient";
const AGENT_WEBCLIENT_SOURCE_CHAT = "agent-webclient-chat";
const AGENT_WEBCLIENT_SOURCE_COPILOT = "agent-webclient-copilot";
const AGENT_WEBCLIENT_SOURCE_COPILOT_DOCK = "agent-webclient-copilot-dock";
const AGENT_WEBCLIENT_SOURCE_MANAGEMENT = "agent-webclient-management";
const AGENT_WEBCLIENT_SOURCE_QUICK_COPILOT = "agent-webclient-quick-copilot";
const AGENT_WEBCLIENT_SOURCE_TASK_BOARD_CHAT = "agent-webclient-task-board-chat";
const DESKTOP_WS_SOURCE_AGENT_WEBCLIENT = "desktop-agent-webclient";
const DESKTOP_WS_SOURCE_CHAT = "desktop-chat";
const DESKTOP_WS_SOURCE_COPILOT = "desktop-copilot";

function isCopilotEmbedPath(value: string) {
  return value === "/copilot" || value.startsWith("/copilot/") || value.startsWith("/copilot?");
}

function resolveAgentWebclientWsSource(surfaceId: string, embedPath: string | undefined) {
  const normalizedSurfaceId = surfaceId.trim();
  if (normalizedSurfaceId === AGENT_WEBCLIENT_SOURCE_COPILOT_DOCK) {
    return DESKTOP_WS_SOURCE_COPILOT;
  }
  if (normalizedSurfaceId === AGENT_WEBCLIENT_SOURCE_QUICK_COPILOT) {
    return DESKTOP_WS_SOURCE_COPILOT;
  }
  if (normalizedSurfaceId === AGENT_WEBCLIENT_SOURCE_TASK_BOARD_CHAT) {
    return DESKTOP_WS_SOURCE_CHAT;
  }
  if (normalizedSurfaceId === AGENT_WEBCLIENT_SOURCE_CHAT) {
    return DESKTOP_WS_SOURCE_CHAT;
  }
  if (normalizedSurfaceId === AGENT_WEBCLIENT_SOURCE_COPILOT) {
    return DESKTOP_WS_SOURCE_COPILOT;
  }
  if (normalizedSurfaceId === AGENT_WEBCLIENT_SOURCE_FALLBACK) {
    return DESKTOP_WS_SOURCE_AGENT_WEBCLIENT;
  }

  const normalizedEmbedPath = (embedPath ?? "").trim();
  if (normalizedEmbedPath.startsWith("/agent/")) {
    return DESKTOP_WS_SOURCE_CHAT;
  }
  if (isCopilotEmbedPath(normalizedEmbedPath)) {
    return DESKTOP_WS_SOURCE_COPILOT;
  }
  if (
    normalizedEmbedPath === "/agents" ||
    normalizedEmbedPath === "/automations" ||
    normalizedEmbedPath === "/memory" ||
    normalizedEmbedPath === "/registries"
  ) {
    return DESKTOP_WS_SOURCE_AGENT_WEBCLIENT;
  }
  return DESKTOP_WS_SOURCE_AGENT_WEBCLIENT;
}
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

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function buildAgentWebclientDesktopContext(
  snapshot: DesktopPageContextSnapshot | null,
) {
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
  embedPath?: string,
  t: TranslateFunction,
): AssistantPageContext {
  const fallbackName = t("pluginPage.embeddedAppFallback");
  const normalizedName = normalizeWhitespace(serviceDisplayName || fallbackName);
  const fallbackUrl = embeddedUrl || webUrl || window.location.href;
  return {
    url: fallbackUrl,
    title: normalizedName || fallbackName,
    selectedText: "",
    metaDescription: "",
    headings: [],
    bodyText: [
      t("pluginPage.contextCurrentEmbeddedApp", { name: normalizedName || fallbackName }),
      t("pluginPage.contextUseDesktopPage"),
    ].join(" "),
    browserTarget: fallbackUrl
      ? {
          kind: "webview",
          surfaceId,
          surfaceLabel,
          ...(surfaceRoute ? { surfaceRoute } : {}),
          ...(embedPath ? { embedPath } : {}),
          currentUrl: fallbackUrl,
        }
      : undefined,
  };
}

function readEventString(event: Event, key: string) {
  const value = (event as Event & Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function readEventBoolean(event: Event, key: string) {
  const value = (event as Event & Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

function readWebviewContentsId(webview: Electron.WebviewTag | null) {
  try {
    const webContentsId = webview?.getWebContentsId();
    return Number.isFinite(webContentsId) ? webContentsId : undefined;
  } catch {
    return undefined;
  }
}

function parseHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function buildPluginWebviewSrcUrl(embeddedUrl: string) {
  const parsed = parseHttpUrl(embeddedUrl);
  return parsed ? `${parsed.origin}/` : embeddedUrl;
}

function hasPluginRoute(url: URL) {
  return Boolean(url.pathname !== "/" || url.search || url.hash);
}

function isPluginRouteSyncTarget(value: string, webviewSrcUrl: string) {
  const parsed = parseHttpUrl(value);
  const src = parseHttpUrl(webviewSrcUrl);
  if (!parsed || !src || parsed.origin !== src.origin) {
    return false;
  }

  const pathname = parsed.pathname;
  if (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/ws" ||
    pathname === "/runtime-config.js" ||
    pathname === "/__webpack_hmr"
  ) {
    return false;
  }

  return true;
}

function resolvePluginCurrentUrl(
  actualUrl: string,
  embeddedUrl: string,
  webviewSrcUrl: string,
) {
  const actual = parseHttpUrl(actualUrl);
  const embedded = parseHttpUrl(embeddedUrl);
  const src = parseHttpUrl(webviewSrcUrl);
  if (!actual) {
    return embeddedUrl;
  }
  if (
    embedded &&
    src &&
    actual.origin === src.origin &&
    !hasPluginRoute(actual) &&
    hasPluginRoute(embedded)
  ) {
    return embedded.toString();
  }
  return actual.toString();
}

function buildPluginRouteChangedMessage(
  targetUrl: string,
  reason: "initial" | "navigation" | "route-sync",
): ServiceWebviewBridgeMessage | null {
  const parsed = parseHttpUrl(targetUrl);
  if (!parsed) {
    return null;
  }
  return {
    type: DESKTOP_ROUTE_CHANGED_MESSAGE_TYPE,
    requestId: `plugin_route_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    reason,
    url: parsed.toString(),
    origin: parsed.origin,
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
  };
}

function buildClientSideRouteNavigationScript(targetUrl: string) {
  return `(() => {
    const target = new URL(${JSON.stringify(targetUrl)}, window.location.href);
    if (target.origin !== window.location.origin) {
      return { ok: false, reason: "origin-mismatch", href: window.location.href };
    }
    const oldUrl = window.location.href;
    const nextPath = target.pathname + target.search + target.hash;
    const currentPath = window.location.pathname + window.location.search + window.location.hash;
    if (nextPath !== currentPath) {
      window.history.pushState(window.history.state, "", nextPath);
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
      if (new URL(oldUrl).hash !== target.hash) {
        window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL: oldUrl, newURL: target.href }));
      }
    }
    return { ok: true, href: window.location.href };
  })()`;
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
  currentUrl: string,
  t: TranslateFunction,
): Promise<AssistantPageContext | null> {
  if (!webview) {
    return null;
  }

  try {
    const pageContext = await webview.executeJavaScript(
      WEBVIEW_PAGE_CONTEXT_SCRIPT,
      true,
    );
    const nextUrl =
      typeof pageContext?.url === "string" && pageContext.url
        ? pageContext.url
        : currentUrl || embeddedUrl || webUrl;

    return {
      url: nextUrl,
      title:
        typeof pageContext?.title === "string" && pageContext.title
          ? pageContext.title
          : serviceDisplayName || t("pluginPage.embeddedAppFallback"),
      selectedText:
        typeof pageContext?.selectedText === "string"
          ? pageContext.selectedText
          : "",
      metaDescription:
        typeof pageContext?.metaDescription === "string"
          ? pageContext.metaDescription
          : "",
      headings: Array.isArray(pageContext?.headings)
        ? pageContext.headings.filter(
            (item: unknown): item is string => typeof item === "string",
          )
        : [],
      bodyText:
        typeof pageContext?.bodyText === "string" ? pageContext.bodyText : "",
      browserTarget: {
        kind: "webview",
        surfaceId,
        surfaceLabel,
        ...(surfaceRoute ? { surfaceRoute } : {}),
        ...(embedPath ? { embedPath } : {}),
        currentUrl: nextUrl,
      },
    };
  } catch {
    return null;
  }
}

export function PluginPage({
  hostTheme,
  pluginId: pluginIdProp,
  surfaceId: surfaceIdProp,
  active,
  embedPath,
  surfaceLabel,
  skipContextRegistration,
  loadInitialEmbeddedUrlDirectly,
  suppressInitialLoadingCopy,
}: PluginPageProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const currentRoute = `${location.pathname}${location.search}`;
  const { pluginId: routePluginId } = useParams<{ pluginId: string }>();
  const pluginId = pluginIdProp ?? routePluginId ?? "";
  const surfaceId = surfaceIdProp?.trim() || pluginId;
  const { locale, t } = useI18n();
  const { services, refresh: refreshServices } = useServices();
  const service = services.find((s) => s.id === pluginId);
  const agentPlatformService =
    service?.id === "agent-webclient"
      ? services.find((s) => s.id === "agent-platform")
      : null;
  const serviceDisplayName =
    surfaceLabel ||
    (service ? getServiceDisplayName(service.id, service.name, t) : "");
  const surfaceRoute = location.pathname;
  const [bridgeError, setBridgeError] = useState("");
  const [bridgeReady, setBridgeReady] = useState(false);
  const [webviewRetryNonce, setWebviewRetryNonce] = useState(0);
  const [webviewLoadError, setWebviewLoadError] = useState(false);
  const [webviewCurrentUrl, setWebviewCurrentUrl] = useState("");
  const [serviceWebviewPreloadUrl, setServiceWebviewPreloadUrl] = useState("");
  const [agentPlatformMonitorAccessToken, setAgentPlatformMonitorAccessToken] =
    useState("");
  const webviewRef = useRef<Electron.WebviewTag | null>(null);
  const lastDirectWebviewRouteRef = useRef("");
  const surfaceVisibilityProps =
    active === undefined
      ? {}
      : {
          hidden: !active,
          "aria-hidden": !active,
        };

  useEffect(() => {
    return registerPluginSurfaceWebviewRef(surfaceId, webviewRef);
  }, [surfaceId]);

  const webUrl = service?.healthMeta.webUrl ?? "";
  const bridgeProtocol = useMemo(
    () => getPluginAuthBridgeProtocol(service?.id),
    [service?.id],
  );
  const webviewReloadKey = [
    service?.healthMeta.pid ?? "",
    service?.id === "agent-webclient"
      ? (agentPlatformService?.status ?? "")
      : "",
    service?.id === "agent-webclient"
      ? (agentPlatformService?.healthMeta.pid ?? "")
      : "",
  ].join(":");
  const routeEmbedPath = useMemo(() => {
    if (service?.id !== "agent-webclient") {
      return "";
    }
    try {
      return (
        new URLSearchParams(location.search).get("embedPath")?.trim() ?? ""
      );
    } catch {
      return "";
    }
  }, [location.search, service?.id]);
  const effectiveEmbedPath =
    service?.id === "agent-webclient"
      ? embedPath || routeEmbedPath || undefined
      : undefined;
  const wsSource = service?.id === "agent-webclient"
    ? resolveAgentWebclientWsSource(surfaceId, effectiveEmbedPath)
    : undefined;
  const embeddedUrl = useMemo(() => {
    return buildPluginEmbeddedUrl(service?.id, webUrl, {
      hostTheme,
      hostLocale: service?.id === "agent-webclient" ? locale : undefined,
      desktopAuthContext:
        service?.id === "agent-webclient" ? webviewReloadKey : undefined,
      accessToken:
        service?.id === "agent-platform"
          ? agentPlatformMonitorAccessToken
          : undefined,
      embedPath: effectiveEmbedPath,
      wsSource,
      baseUrl: service?.healthMeta.port
        ? `http://127.0.0.1:${service.healthMeta.port}`
        : undefined,
    });
  }, [
    agentPlatformMonitorAccessToken,
    effectiveEmbedPath,
    hostTheme,
    locale,
    service?.healthMeta.port,
    service?.id,
    webUrl,
    webviewReloadKey,
    wsSource,
  ]);
  const webviewOriginSrcUrl = useMemo(
    () => buildPluginWebviewSrcUrl(embeddedUrl),
    [embeddedUrl],
  );
  const webviewDirectLoadScope = [
    service?.id ?? "service",
    webviewReloadKey,
    webviewOriginSrcUrl,
  ].join(":");
  const initialWebviewSrcRef = useRef<{ scope: string; url: string } | null>(
    null,
  );
  if (
    loadInitialEmbeddedUrlDirectly &&
    embeddedUrl &&
    initialWebviewSrcRef.current?.scope !== webviewDirectLoadScope
  ) {
    initialWebviewSrcRef.current = {
      scope: webviewDirectLoadScope,
      url: embeddedUrl,
    };
  }
  const webviewSrcUrl =
    loadInitialEmbeddedUrlDirectly
      ? (initialWebviewSrcRef.current?.url ?? embeddedUrl)
      : webviewOriginSrcUrl;
  const webviewBaseKey = useMemo(
    () => [service?.id ?? "service", webviewReloadKey, webviewSrcUrl].join(":"),
    [service?.id, webviewReloadKey, webviewSrcUrl],
  );
  const webviewRenderKey = useMemo(
    () => [webviewBaseKey, webviewRetryNonce].join(":"),
    [webviewBaseKey, webviewRetryNonce],
  );
  function embeddedError(code: string, message: string, details?: unknown) {
    return {
      ok: false,
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
      },
    };
  }

  function readCurrentWebviewUrl() {
    try {
      const webviewUrl = webviewRef.current?.getURL();
      return typeof webviewUrl === "string" && webviewUrl.trim()
        ? resolvePluginCurrentUrl(webviewUrl.trim(), embeddedUrl, webviewSrcUrl)
        : embeddedUrl;
    } catch {
      return embeddedUrl;
    }
  }

  async function readPluginPageContext() {
    return (
      (await tryReadPluginWebviewPageContext(
        webviewRef.current,
        serviceDisplayName,
        embeddedUrl,
        webUrl,
        surfaceId,
        serviceDisplayName,
        surfaceRoute,
        effectiveEmbedPath,
        readCurrentWebviewUrl(),
        t,
      )) ??
      buildPluginWebviewFallbackContext(
        serviceDisplayName,
        embeddedUrl,
        webUrl,
        surfaceId,
        serviceDisplayName,
        surfaceRoute,
        effectiveEmbedPath,
        t,
      )
    );
  }

  async function executeWebviewScript(
    args: Record<string, unknown>,
    script: string,
  ) {
    if (getUtf8ByteLength(script) > EMBEDDED_WEB_SCRIPT_MAX_BYTES) {
      return embeddedError(
        "script_too_large",
        t("externalWebview.error.scriptTooLarge"),
      );
    }
    const targetWebview = webviewRef.current;
    if (!targetWebview) {
      return embeddedError("webview_unavailable", t("pluginPage.error.webviewUnavailable"));
    }
    try {
      const result = await targetWebview.executeJavaScript(script, true);
      return { ok: true, result };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "webview_execution_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  const createCurrentPageDescriptor = () => {
    const currentUrl =
      webviewCurrentUrl || readCurrentWebviewUrl() || embeddedUrl || webUrl;
    const webContentsId = readWebviewContentsId(webviewRef.current);
    return {
      route: currentRoute,
      pageKey: `webview:${currentRoute}:${surfaceId}:${currentUrl || "webview"}`,
      pageKind: "webview" as const,
      ...(surfaceId ? { surfaceId } : {}),
      ...(serviceDisplayName ? { surfaceLabel: serviceDisplayName } : {}),
      ...(surfaceRoute ? { surfaceRoute } : {}),
      ...(effectiveEmbedPath ? { embedPath: effectiveEmbedPath } : {}),
      ...(typeof webContentsId === "number" ? { webContentsId } : {}),
    };
  };

  function attachDescriptorMetadata(payload: Record<string, unknown>) {
    const descriptor = createCurrentPageDescriptor();
    return {
      pageKey: descriptor.pageKey,
      pageKind: descriptor.pageKind,
      ...(descriptor.surfaceId ? { surfaceId: descriptor.surfaceId } : {}),
      ...(descriptor.surfaceLabel
        ? { surfaceLabel: descriptor.surfaceLabel }
        : {}),
      ...(descriptor.surfaceRoute
        ? { surfaceRoute: descriptor.surfaceRoute }
        : {}),
      ...(descriptor.embedPath ? { embedPath: descriptor.embedPath } : {}),
      ...payload,
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
          readAllowedValues(args.include, EMBEDDED_WEB_READ_INCLUDES),
        ),
      }),
    };
  }

  async function executeCurrentPageStructuredRead(
    args: Record<string, unknown>,
  ) {
    const response = await executeWebviewScript(
      args,
      EXTRACT_STRUCTURED_SCRIPT,
    );
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
          readAllowedValues(args.targets, EMBEDDED_WEB_STRUCTURED_TARGETS),
        ),
      }),
    };
  }

  async function executeCurrentPageInteract(args: Record<string, unknown>) {
    const selector = readActionSelector(args);
    const action = typeof args.action === "string" ? args.action.trim() : "";
    if (
      !selector ||
      !EMBEDDED_WEB_INTERACT_ACTIONS.has(action as EmbeddedWebInteractAction)
    ) {
      return embeddedError(
        "invalid_args",
        t("desktopAction.selectorActionRequired"),
        args,
      );
    }
    const response = await executeWebviewScript(
      args,
      buildInteractElementScript({
        selector,
        action: action as EmbeddedWebInteractAction,
        value:
          typeof args.value === "string"
            ? args.value
            : args.value == null
              ? undefined
              : String(args.value),
      }),
    );
    if (!response.ok) {
      return response;
    }
    return {
      ok: true,
      result: attachDescriptorMetadata({
        interacted: true,
        action,
        outcome: response.result,
      }),
    };
  }

  async function executeCurrentPageFillForm(args: Record<string, unknown>) {
    const fields = readFormFields(args);
    if (fields.length === 0) {
      return embeddedError(
        "invalid_args",
        t("desktopAction.fieldsSelectorRequired"),
        args,
      );
    }
    const response = await executeWebviewScript(
      args,
      buildFillFormScript({
        formSelector:
          typeof args.formSelector === "string"
            ? args.formSelector.trim()
            : undefined,
        fields,
      }),
    );
    if (!response.ok) {
      return response;
    }
    return {
      ok: true,
      result: attachDescriptorMetadata({
        filled: true,
        outcome: response.result,
      }),
    };
  }

  async function executeCurrentPageSubmitForm(args: Record<string, unknown>) {
    const response = await executeWebviewScript(
      args,
      buildSubmitFormScript({
        formSelector:
          typeof args.formSelector === "string"
            ? args.formSelector.trim()
            : undefined,
        submitSelector:
          typeof args.submitSelector === "string"
            ? args.submitSelector.trim()
            : undefined,
      }),
    );
    if (!response.ok) {
      return response;
    }
    return {
      ok: true,
      result: attachDescriptorMetadata({
        submitted: true,
        outcome: response.result,
      }),
    };
  }

  useEffect(() => {
    setBridgeError("");
  }, [service?.id, embeddedUrl]);

  useEffect(() => {
    setWebviewCurrentUrl(embeddedUrl);
  }, [embeddedUrl]);

  useEffect(() => {
    setWebviewRetryNonce(0);
    setWebviewLoadError(false);
  }, [service?.status, webviewBaseKey]);

  useEffect(() => {
    let cancelled = false;
    setBridgeReady(false);
    void window.electronAPI.plugins
      .getServiceWebviewPreloadUrl()
      .then((preloadUrl) => {
        if (cancelled) {
          return;
        }
        setServiceWebviewPreloadUrl(preloadUrl);
        setBridgeReady(true);
      })
      .catch((reason) => {
        if (cancelled) {
          return;
        }

        setBridgeError(
          reason instanceof Error ? reason.message : String(reason),
        );
      });
    return () => {
      cancelled = true;
      setBridgeReady(false);
    };
  }, []);

  function sendBridgeMessageToWebview(payload: ServiceWebviewBridgeMessage) {
    try {
      webviewRef.current?.send(SERVICE_WEBVIEW_BRIDGE_DELIVER_CHANNEL, payload);
    } catch {
      // Ignore bridge delivery while the guest webContents is being recreated.
    }
  }

  function dispatchPluginRouteEventToWebview(payload: Record<string, unknown>) {
    try {
      webviewRef.current?.send(SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL, payload);
    } catch {
      // Ignore bridge delivery while the guest webContents is being recreated.
    }
  }

  function sendPluginRouteToWebview(
    targetUrl: string,
    reason: "initial" | "navigation" | "route-sync",
  ) {
    const payload = buildPluginRouteChangedMessage(targetUrl, reason);
    if (!payload) {
      return;
    }
    dispatchPluginRouteEventToWebview(payload);
  }

  function requestDirectWebviewRouteLoad() {
    if (!loadInitialEmbeddedUrlDirectly || !embeddedUrl) {
      return;
    }

    const targetWebview = webviewRef.current;
    if (!targetWebview) {
      return;
    }

    try {
      const currentUrl = targetWebview.getURL().trim();
      const normalizedCurrentUrl = currentUrl
        ? resolvePluginCurrentUrl(currentUrl, embeddedUrl, webviewSrcUrl)
        : "";
      if (normalizedCurrentUrl === embeddedUrl) {
        lastDirectWebviewRouteRef.current = embeddedUrl;
        return;
      }
      if (!currentUrl && lastDirectWebviewRouteRef.current === embeddedUrl) {
        return;
      }
      lastDirectWebviewRouteRef.current = embeddedUrl;
      setWebviewCurrentUrl(embeddedUrl);
      const currentParsed = parseHttpUrl(currentUrl);
      const targetParsed = parseHttpUrl(embeddedUrl);
      if (
        currentParsed &&
        targetParsed &&
        currentParsed.origin === targetParsed.origin &&
        !webviewLoadedChromeErrorPage()
      ) {
        void targetWebview.executeJavaScript(
          buildClientSideRouteNavigationScript(embeddedUrl),
          true,
        ).catch((reason) => {
          console.warn(
            "[service-webview] failed to apply client-side embedded route",
            reason instanceof Error ? reason.message : String(reason),
          );
          void targetWebview.loadURL(embeddedUrl);
        });
        return;
      }
      void targetWebview.loadURL(embeddedUrl);
    } catch (reason) {
      console.warn(
        "[service-webview] failed to load direct embedded route",
        reason instanceof Error ? reason.message : String(reason),
      );
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
      const result = (await targetWebview.executeJavaScript(
        buildAgentWebclientAccessTokenInjectionScript(
          token,
          desktopAuthContext,
        ),
        true,
      )) as { tokenBeforeLength?: number; tokenAfterLength?: number } | null;
      return Boolean(
        token &&
        desktopAuthContext &&
        result &&
        (result.tokenBeforeLength ?? 0) === 0 &&
        (result.tokenAfterLength ?? 0) > 0,
      );
    } catch (reason) {
      console.warn(
        "[agent-webclient] failed to inject access token fallback",
        reason instanceof Error ? reason.message : String(reason),
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
        await injectAgentWebclientAccessToken(token);
        sendBridgeMessageToWebview({
          type: bridgeProtocol.responseType,
          requestId: `agent_webclient_seed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          token,
        });
        if (!result.ok) {
          setBridgeError(result.message);
        }
      })
      .catch((reason) => {
        setBridgeError(
          reason instanceof Error ? reason.message : String(reason),
        );
      });
  }

  function scheduleAgentWebclientAccessTokenSeeds() {
    const delays = [0, 150, 500, 1000, 2000];
    return delays.map((delay) =>
      window.setTimeout(() => {
        seedAgentWebclientAccessToken();
      }, delay),
    );
  }

  function handleWebviewBridgeMessage(event: Event) {
    const channel = readEventString(event, "channel");
    if (channel !== SERVICE_WEBVIEW_BRIDGE_MESSAGE_CHANNEL) {
      return;
    }
    const [payload] = ((event as Event & { args?: unknown[] }).args ?? []) as [
      ServiceWebviewBridgeMessage?,
    ];
    if (!payload || !payload.type || !payload.requestId) {
      return;
    }

    handleServiceWebviewBridgeMessage(payload, {
      serviceId: service?.id,
      bridgeProtocol,
      sendBridgeMessageToWebview,
      setBridgeError,
      logDebug: (stage, message) => {
        console.info("[service-webview]", service?.id || "plugin", stage, message);
      },
    });
  }

  function webviewLoadedChromeErrorPage() {
    try {
      return (
        webviewRef.current?.getURL().startsWith("chrome-error://") ?? false
      );
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
      setWebviewRetryNonce((current) =>
        current === webviewRetryNonce ? current + 1 : current,
      );
    }, 450);
  }

  useEffect(() => {
    if (!bridgeReady || !serviceWebviewPreloadUrl) {
      return undefined;
    }

    const targetWebview = webviewRef.current;
    if (!targetWebview) {
      return undefined;
    }

    const handleDomReady = () => {
      syncWebviewState();
      sendPluginRouteToWebview(embeddedUrl, "initial");
      seedAgentWebclientAccessToken();
    };
    const handleDidFinishLoad = () => {
      syncWebviewState();
      sendPluginRouteToWebview(embeddedUrl, "route-sync");
      seedAgentWebclientAccessToken();
    };
    const syncNavigationRoute = (event: Event) => {
      const nextUrl = readEventString(event, "url");
      const resolvedUrl = nextUrl
        ? resolvePluginCurrentUrl(nextUrl, embeddedUrl, webviewSrcUrl)
        : readCurrentWebviewUrl();
      setWebviewCurrentUrl(resolvedUrl);
      if (
        nextUrl &&
        readEventBoolean(event, "isMainFrame") !== false &&
        isPluginRouteSyncTarget(nextUrl, webviewSrcUrl)
      ) {
        sendPluginRouteToWebview(resolvedUrl, "navigation");
      }
      seedAgentWebclientAccessToken();
    };
    const handleDidNavigate = (event: Event) => {
      syncNavigationRoute(event);
    };
    const handleDidNavigateInPage = (event: Event) => {
      syncNavigationRoute(event);
    };
    const handleDidFailLoad = () => syncWebviewState();

    targetWebview.addEventListener("dom-ready", handleDomReady);
    targetWebview.addEventListener("did-finish-load", handleDidFinishLoad);
    targetWebview.addEventListener("did-navigate", handleDidNavigate);
    targetWebview.addEventListener(
      "did-navigate-in-page",
      handleDidNavigateInPage,
    );
    targetWebview.addEventListener("did-fail-load", handleDidFailLoad);
    targetWebview.addEventListener("ipc-message", handleWebviewBridgeMessage);
    syncWebviewState();
    sendPluginRouteToWebview(embeddedUrl, "route-sync");
    const seedTimers = scheduleAgentWebclientAccessTokenSeeds();

    return () => {
      seedTimers.forEach((timer) => window.clearTimeout(timer));
      targetWebview.removeEventListener("dom-ready", handleDomReady);
      targetWebview.removeEventListener("did-finish-load", handleDidFinishLoad);
      targetWebview.removeEventListener("did-navigate", handleDidNavigate);
      targetWebview.removeEventListener(
        "did-navigate-in-page",
        handleDidNavigateInPage,
      );
      targetWebview.removeEventListener("did-fail-load", handleDidFailLoad);
      targetWebview.removeEventListener(
        "ipc-message",
        handleWebviewBridgeMessage,
      );
    };
  }, [
    bridgeProtocol,
    bridgeReady,
    active,
    pluginId,
    surfaceId,
    service?.id,
    service?.status,
    serviceDisplayName,
    serviceWebviewPreloadUrl,
    embeddedUrl,
    surfaceRoute,
    webviewSrcUrl,
    webviewRenderKey,
    webviewRetryNonce,
  ]);

  useEffect(() => {
    if (active === false || !bridgeReady || !serviceWebviewPreloadUrl) {
      return;
    }
    seedAgentWebclientAccessToken();
  }, [
    active,
    bridgeReady,
    embeddedUrl,
    service?.id,
    serviceWebviewPreloadUrl,
    webviewRenderKey,
  ]);

  useEffect(() => {
    if (active === false || !bridgeReady || !serviceWebviewPreloadUrl) {
      return;
    }
    requestDirectWebviewRouteLoad();
  }, [
    active,
    bridgeReady,
    embeddedUrl,
    loadInitialEmbeddedUrlDirectly,
    serviceWebviewPreloadUrl,
    webviewRenderKey,
    webviewSrcUrl,
  ]);

  useEffect(() => {
    if (service?.id !== "agent-platform") {
      setAgentPlatformMonitorAccessToken("");
      return undefined;
    }
    if (active === false || service.status !== "running") {
      return undefined;
    }

    let cancelled = false;
    setBridgeError("");
    void window.electronAPI.agentAuth
      .issueAccessToken("missing")
      .then((result) => {
        if (cancelled) {
          return;
        }
        const token = result.ok ? result.token.trim() : "";
        if (token) {
          setAgentPlatformMonitorAccessToken(token);
          return;
        }
        setBridgeError(result.message);
      })
      .catch((reason) => {
        if (cancelled) {
          return;
        }
        setBridgeError(
          reason instanceof Error ? reason.message : String(reason),
        );
      });

    return () => {
      cancelled = true;
    };
  }, [active, service?.id, service?.status, webviewReloadKey]);

  useEffect(() => {
    if (service?.id !== "agent-webclient" || active === false || !embeddedUrl) {
      return undefined;
    }

    const postDesktopContextChanged = () => {
      sendBridgeMessageToWebview({
        type: DESKTOP_CONTEXT_CHANGED_MESSAGE_TYPE,
        desktop: buildAgentWebclientDesktopContext(
          getCurrentPageContextSnapshot(),
        ),
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
    if (
      active === false ||
      service?.status !== "running" ||
      skipContextRegistration
    ) {
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
        pageContext,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [
    active,
    currentRoute,
    embeddedUrl,
    surfaceId,
    service?.status,
    serviceDisplayName,
    skipContextRegistration,
    webviewCurrentUrl,
    webUrl,
  ]);

  useEffect(() => {
    if (
      active === false ||
      service?.status !== "running" ||
      skipContextRegistration
    ) {
      return undefined;
    }

    return registerAssistantPageContextProvider(async () => {
      return readPluginPageContext();
    });
  }, [
    active,
    embeddedUrl,
    surfaceId,
    service?.status,
    serviceDisplayName,
    skipContextRegistration,
    webUrl,
  ]);

  useEffect(() => {
    if (
      active === false ||
      service?.status !== "running" ||
      skipContextRegistration
    ) {
      return undefined;
    }

    return registerCurrentPageExecutor({
      getDescriptor: createCurrentPageDescriptor,
      readCurrent: async (request) =>
        executeCurrentPageRead(request.args ?? {}),
      extractStructured: async (request) =>
        executeCurrentPageStructuredRead(request.args ?? {}),
      interact: async (request) =>
        executeCurrentPageInteract(request.args ?? {}),
      fillForm: async (request) =>
        executeCurrentPageFillForm(request.args ?? {}),
      submitForm: async (request) =>
        executeCurrentPageSubmitForm(request.args ?? {}),
    });
  }, [
    active,
    currentRoute,
    embeddedUrl,
    surfaceId,
    service?.status,
    serviceDisplayName,
    skipContextRegistration,
    webviewCurrentUrl,
    webUrl,
  ]);

  useEffect(() => {
    if (
      active === false ||
      service?.status !== "running" ||
      !embeddedUrl ||
      skipContextRegistration
    ) {
      return undefined;
    }

    function requestTargetsDifferentSurface(args: Record<string, unknown>) {
      const targetSurfaceId =
        typeof args.surfaceId === "string" ? args.surfaceId.trim() : "";
      return Boolean(targetSurfaceId && targetSurfaceId !== surfaceId);
    }

    return registerDesktopActionProviderForScope(
      "embeddedWeb",
      async (request) => {
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
                  id: surfaceId,
                  surfaceId,
                  serviceId: pluginId,
                  label: serviceDisplayName,
                  url: embeddedUrl,
                  active: active !== false,
                  currentUrl: webviewCurrentUrl || embeddedUrl,
                  title: serviceDisplayName,
                },
                tabs: [],
                activeTab: null,
              },
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
              return embeddedError("invalid_script", t("externalWebview.error.invalidScript"));
            }
            return executeWebviewScript(args, script);
          }
          default:
            return null;
        }
      },
    );
  }, [
    active,
    embeddedUrl,
    pluginId,
    surfaceId,
    service?.status,
    serviceDisplayName,
    skipContextRegistration,
    t,
    webviewCurrentUrl,
    webUrl,
  ]);

  if (!service) {
    if (pluginId === "agent-webclient") {
      return (
        <section className="empty-state" {...surfaceVisibilityProps}>
          <h1>{t("pluginPage.agentServiceMissingTitle")}</h1>
          <p>{t("pluginPage.agentServiceMissingDescription")}</p>
          <Link className="primary-link" to="/control-center">
            {t("pluginPage.openControlCenter")}
          </Link>
        </section>
      );
    }

    return (
      <section className="empty-state" {...surfaceVisibilityProps}>
        <h1>{t("pluginPage.serviceMissingTitle")}</h1>
        <p>{t("pluginPage.serviceMissingDescription", { pluginId })}</p>
        <Link className="primary-link" to="/control-center">
          {t("pluginPage.backToControlCenter")}
        </Link>
      </section>
    );
  }

  if (service.status !== "running") {
    return (
      <section className="empty-state" {...surfaceVisibilityProps}>
        <p className="eyebrow">PLUGIN</p>
        <h1>{t("pluginPage.notReadyTitle", { name: serviceDisplayName })}</h1>
        <p>{service.message}</p>
        <Link className="primary-link" to="/control-center">
          {t("pluginPage.openControlCenter")}
        </Link>
      </section>
    );
  }

  if (
    (service.frontendMode === "none" && service.id !== "agent-platform") ||
    !webUrl ||
    !embeddedUrl
  ) {
    return (
      <section className="empty-state" {...surfaceVisibilityProps}>
        <h1>{serviceDisplayName}</h1>
        <p>{t("pluginPage.noFrontend")}</p>
        <Link className="primary-link" to="/control-center">
          {t("pluginPage.backToControlCenter")}
        </Link>
      </section>
    );
  }

  if (bridgeError) {
    return (
      <section className="empty-state" {...surfaceVisibilityProps}>
        <p className="eyebrow">PLUGIN</p>
        <h1>{serviceDisplayName}</h1>
        <p>{t("pluginPage.authBridgeFailed", { message: bridgeError })}</p>
        <Link className="primary-link" to="/control-center">
          {t("pluginPage.backToControlCenter")}
        </Link>
      </section>
    );
  }

  if (service.id === "agent-platform" && !agentPlatformMonitorAccessToken) {
    return (
      <section className="empty-state" {...surfaceVisibilityProps}>
        <p className="eyebrow">PLUGIN</p>
        <h1>{serviceDisplayName}</h1>
        <p>Preparing secure monitor preview.</p>
      </section>
    );
  }

  return (
    <section
      className={[
        "pan-page",
        "pan-page-embedded",
        service.id === "agent-webclient" ? "pan-page-agent-webclient" : ""
      ].filter(Boolean).join(" ")}
      {...surfaceVisibilityProps}
    >
      {active && pluginId !== "agent-webclient" && (
        <button
          className="embedded-back-button"
          onClick={() => {
            navigate(-1);
          }}
          title={t("pluginPage.back")}
          aria-label={t("common.back")}
        >
          <svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="currentColor">
            <path d="m313-440 224 224-57 57-320-320 320-320 57 57-224 224h487v80H313Z"/>
          </svg>
        </button>
      )}
      <div className="pan-frame-shell">
        {bridgeReady && serviceWebviewPreloadUrl ? (
          <>
            {webviewLoadError ? (
              <section
                className="empty-state embedded-plugin-error"
                aria-live="polite"
              >
                <p className="eyebrow">PLUGIN</p>
                <h1>{serviceDisplayName}</h1>
                <p>{t("pluginPage.agentRecovering")}</p>
              </section>
            ) : null}
            {createElement("webview", {
              key: webviewRenderKey,
              ref: (node: Electron.WebviewTag | null) => {
                webviewRef.current = node;
              },
              src: webviewSrcUrl,
              title: serviceDisplayName,
              className: "pan-frame",
              preload: serviceWebviewPreloadUrl,
              partition: `persist:${STORAGE_NAMESPACE}-service-${pluginId || "plugin"}`,
              allowpopups: "true",
              style: { width: "100%", height: "100%", border: "none" },
            })}
          </>
        ) : suppressInitialLoadingCopy ? (
          <section
            className="empty-state"
            aria-busy="true"
            aria-label={t("pluginPage.loading", { name: serviceDisplayName })}
          />
        ) : (
          <section className="empty-state">
            <p className="eyebrow">PLUGIN</p>
            <h1>{serviceDisplayName}</h1>
            <p>{t("pluginPage.preparingAuth")}</p>
          </section>
        )}
      </div>
    </section>
  );
}
