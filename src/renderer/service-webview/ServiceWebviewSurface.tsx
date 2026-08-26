import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useLocation, useParams, useNavigate } from "react-router-dom";
import { useServices } from "../services/ServicesContext";
import { registerAssistantPageContextProvider } from "../copilot/page-context/assistantPageContext";
import {
  buildServiceWebviewUrl,
  getServiceWebviewAuthProtocol,
} from "../../shared/auth-bridge";
import {
  areAgentWebclientChatBusinessRoutesEquivalent,
  areAgentWebclientHostRouteParamsEqual,
  areAgentWebclientChatNavigationUrlsEquivalent,
  createAgentWebclientAgentPath,
  readAgentWebclientAgentRouteKey,
  resolveAgentWebclientDesktopAgentSwitchTarget,
  resolveAgentWebclientDesktopChatRouteFromUrl,
  resolveAgentWebclientWsSource,
} from "../../shared/agent-webclient-routes";
import { useI18n } from "../i18n/useI18n";
import {
  AGENT_WEBCLIENT_NEW_CHAT_PREPARE_RESPONSE_TYPE,
  DESKTOP_CONTEXT_CHANGED_MESSAGE_TYPE,
  DESKTOP_ROUTE_CHANGED_MESSAGE_TYPE,
  DESKTOP_SURFACE_ACTIVE_CHANGED_MESSAGE_TYPE,
  SERVICE_WEBVIEW_BRIDGE_DELIVER_CHANNEL,
  SERVICE_WEBVIEW_BRIDGE_MESSAGE_CHANNEL,
  SERVICE_WEBVIEW_MODAL_OVERLAY_STATE_CHANNEL,
  SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL,
  type ServiceWebviewBridgeMessage,
  type ServiceWebviewModalOverlayState,
} from "../../shared/service-webview-bridge";
import { handleServiceWebviewBridgeMessage } from "../services/serviceWebviewBridgeHost";
import { getServiceDisplayName } from "../service-display";
import { buildSettingsSectionPath } from "../settings/settingsRoutes";
import type {
  AssistantPageContext,
  CanonicalChatSyncRequest,
  CanonicalChatSyncResult,
  DesktopPageContextSnapshot,
} from "../../shared/contracts";
import {
  classifyAgentWebclientNewChatRegistration,
  createCanonicalAgentChatRoute,
  createPreparedAgentChatRoute,
  readAgentWebclientNewChatSource,
  resolveAgentWebclientNewChatRegistrationOutcome,
} from "../../shared/canonical-chat-sync";
import type { TranslateFunction } from "../../shared/i18n";
import {
  buildInteractElementScript,
  type EmbeddedWebInteractAction,
} from "../../shared/embedded-web-scripts";
import {
  getCurrentPageContextSnapshot,
  publishCurrentPageContextSnapshot,
  subscribeCurrentPageContext,
} from "../services/currentPageContext";
import { registerServiceSurfaceWebviewRef } from "../services/serviceSurfaceWebviewRefs";
import { registerDesktopActionProviderForScope } from "../services/desktopActionRegistry";
import { registerWebSurfaceStateProvider } from "../services/webSurfaceStateRegistry";
import { registerSurfaceRuntimeDownloadListener } from "../services/surfaceRuntimeDownloads";
import {
  EMBEDDED_WEB_INTERACT_ACTIONS,
  EMBEDDED_WEB_SCRIPT_MAX_BYTES,
  getUtf8ByteLength,
  readActionSelector,
} from "../copilot/page-context/webActions";
import { STORAGE_NAMESPACE } from "../../shared/brand";
import type { EmbeddedCdpSurfaceRegistration } from "../../shared/embedded-cdp";
import { WebviewDebugOverlay } from "../components/WebviewDebugOverlay";
import {
  resolveAgentWebclientWebviewSurfaceType,
  type WebviewContextMenuSurfaceType,
} from "../../shared/webview-context-menu";
import type { WebviewSelectionToolbarState } from "../../shared/webview-selection-toolbar";
import {
  COPILOT_CHAT_SURFACE_ID,
  COPILOT_DOCK_SURFACE_ID,
  KANBAN_CHAT_SURFACE_ID,
  MAIN_CHAT_SURFACE_ID,
  createServiceSurfaceIdentity,
  resolveLegacyFixedSurfaceId,
  type SurfaceIdentity
} from "../../shared/surface-identity";
import { WebviewSelectionToolbar } from "./WebviewSelectionToolbar";

type ServiceWebviewUrlChangeSource = "host" | "guest";

type ServiceWebviewSurfaceProps = {
  hostTheme: "light" | "dark";
  serviceId?: string;
  surfaceId?: string;
  surfaceIdentity?: SurfaceIdentity;
  surfaceIdentityKey?: string;
  active?: boolean | undefined;
  surfaceOwnershipActive?: boolean;
  desktopRoute?: string;
  embedPath?: string;
  surfaceLabel?: string;
  ownerChatId?: string;
  skipContextRegistration?: boolean;
  devToolsTarget?: "copilot";
  loadInitialEmbeddedUrlDirectly?: boolean;
  suppressInitialLoadingCopy?: boolean;
  focusRequestId?: number | null;
  onFocusRequestHandled?: (requestId: number) => void;
  onCurrentUrlChange?: (url: string, source: ServiceWebviewUrlChangeSource) => void;
  onRuntimeProtectionChange?: (protectedFromSleep: boolean) => void;
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
type VisibleSelectionToolbarState = Extract<
  WebviewSelectionToolbarState,
  { visible: true }
>;

type PendingCanonicalChatSync = {
  request: CanonicalChatSyncRequest;
  targetRoute: string;
};

type PendingNewChatPreparation = {
  request: {
    requestId: string;
    agentKey: string;
    sourceChatId: string;
    newChat: string;
  };
  sourceRoute: string;
  targetRoute: string;
  registrationId: string;
  guestWebContentsId: number;
  timeoutId: number;
};

type RegisteredSafeSurfaceIdentity = {
  registrationId: string;
  webContentsId: number;
  pageRoute: string;
  pageRouteIdentity: string;
  ownerChatId: string;
};

type PendingDirectRouteTransition = {
  id: number;
  targetUrl: string;
};

type ServiceWebviewEventContext = {
  embeddedUrl: string;
  webviewSrcUrl: string;
  currentRoute: string;
  ownsActiveSurface: boolean;
  serviceId: string;
  surfaceId: string;
  reportDiagnostic: (stage: string, details?: Record<string, unknown>) => void;
  syncWebviewState: () => void;
  refreshCurrentPageSnapshotTarget: () => void;
  sendServiceRouteToWebview: (
    targetUrl: string,
    reason: "initial" | "navigation" | "route-sync",
  ) => void;
  updateWebviewCurrentUrl: (url: string, source: ServiceWebviewUrlChangeSource) => void;
  navigate: (targetRoute: string, options?: { replace?: boolean }) => void;
  handleWebviewBridgeMessage: (event: Event) => void;
  requestDirectWebviewRouteLoad: () => void;
  setRuntimeProtected: (
    reason: string,
    protectedFromSleep: boolean,
  ) => void;
};

const MAX_SERVICE_WEBVIEW_PAGE_CONTEXT_HEADINGS = 24;
const MAX_SERVICE_WEBVIEW_PAGE_CONTEXT_BODY_TEXT = 40000;
const AGENT_WEBCLIENT_SOURCE_CHAT = MAIN_CHAT_SURFACE_ID;
const AGENT_WEBCLIENT_LIVE_CHAT_SURFACE_IDS = new Set([
  AGENT_WEBCLIENT_SOURCE_CHAT,
  COPILOT_CHAT_SURFACE_ID,
  COPILOT_DOCK_SURFACE_ID,
  KANBAN_CHAT_SURFACE_ID,
]);
const AGENT_WEBCLIENT_WORK_PANEL_ROLES = new Set<SurfaceIdentity["surfaceRole"]>([
  "overview",
  "debug",
  "btw",
  "source",
  "project",
  "file-diff",
  "artifact",
  "reference",
  "file",
  "planning",
  "agent",
  "copilot",
]);
let serviceSurfaceRegistrationSequence = 0;

function createServiceSurfaceRegistrationId() {
  serviceSurfaceRegistrationSequence += 1;
  return `service-surface-${Date.now()}-${serviceSurfaceRegistrationSequence}`;
}

function getEmbeddedCdpSurfaceApi() {
  const embeddedCdp = window.electronAPI?.embeddedCdp;
  return typeof embeddedCdp?.registerSurface === "function" &&
    typeof embeddedCdp?.unregisterSurface === "function"
    ? embeddedCdp
    : null;
}

function resolveContextMenuSurfaceType(
  serviceId: string,
  surfaceRole: SurfaceIdentity["surfaceRole"],
): WebviewContextMenuSurfaceType {
  if (serviceId !== "agent-webclient") return "service";
  return resolveAgentWebclientWebviewSurfaceType(surfaceRole);
}

function isAgentWebclientChatSurface(serviceId: string | undefined, surfaceId: string | undefined) {
  return serviceId === "agent-webclient" && surfaceId === AGENT_WEBCLIENT_SOURCE_CHAT;
}

function isAgentWebclientLiveChatSurface(serviceId: string | undefined, surfaceId: string | undefined) {
  return serviceId === "agent-webclient" && AGENT_WEBCLIENT_LIVE_CHAT_SURFACE_IDS.has(surfaceId || "");
}

function isAgentWebclientLifecycleSurface(
  serviceId: string | undefined,
  surfaceId: string | undefined,
  surfaceIdentity: SurfaceIdentity,
) {
  if (isAgentWebclientLiveChatSurface(serviceId, surfaceId)) return true;
  return serviceId === "agent-webclient" &&
    surfaceIdentity.surfaceLevel === "child" &&
    surfaceIdentity.parentSurfaceId === MAIN_CHAT_SURFACE_ID &&
    Boolean(surfaceIdentity.ownerChatId) &&
    AGENT_WEBCLIENT_WORK_PANEL_ROLES.has(surfaceIdentity.surfaceRole);
}

function isAgentWebclientManagementSurface(serviceId: string | undefined, surfaceId: string | undefined) {
  return serviceId === "agent-webclient" && surfaceId === createServiceSurfaceIdentity("agent-webclient").surfaceId;
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
      .slice(0, ${MAX_SERVICE_WEBVIEW_PAGE_CONTEXT_HEADINGS}),
    bodyText: normalize(document.body?.innerText || "").slice(0, ${MAX_SERVICE_WEBVIEW_PAGE_CONTEXT_BODY_TEXT})
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

function buildServiceWebviewFallbackContext(
  serviceDisplayName: string,
  embeddedUrl: string,
  webUrl: string,
  surfaceId: string,
  surfaceLabel: string,
  t: TranslateFunction,
  surfaceRoute?: string,
  embedPath?: string,
): AssistantPageContext {
  const fallbackName = t("serviceWebview.embeddedAppFallback");
  const normalizedName = normalizeWhitespace(serviceDisplayName || fallbackName);
  const fallbackUrl = embeddedUrl || webUrl || window.location.href;
  return {
    url: fallbackUrl,
    title: normalizedName || fallbackName,
    selectedText: "",
    metaDescription: "",
    headings: [],
    bodyText: [
      t("serviceWebview.contextCurrentEmbeddedApp", { name: normalizedName || fallbackName }),
      t("serviceWebview.contextUseDesktopWebActions"),
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

function readEventNumber(event: Event, key: string) {
  const value = (event as Event & Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function resolveDesktopSurfacePathname(route: string) {
  try {
    return new URL(route, "http://desktop.local").pathname;
  } catch {
    return route.split(/[?#]/u, 1)[0] || "/";
  }
}

function isMainChatRouteAligned(
  desktopRoute: string,
  guestUrl: string,
  embeddedUrl: string,
) {
  const guestRoute = resolveAgentWebclientDesktopChatRouteFromUrl(guestUrl, embeddedUrl);
  return Boolean(
    guestRoute &&
    areAgentWebclientChatBusinessRoutesEquivalent(desktopRoute, guestRoute),
  );
}

function buildServiceWebviewSrcUrl(embeddedUrl: string) {
  const parsed = parseHttpUrl(embeddedUrl);
  return parsed ? `${parsed.origin}/` : embeddedUrl;
}

function hasServiceWebviewRoute(url: URL) {
  return Boolean(url.pathname !== "/" || url.search || url.hash);
}

function isServiceWebviewRouteSyncTarget(value: string, webviewSrcUrl: string) {
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

function resolveServiceWebviewCurrentUrl(
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
    !hasServiceWebviewRoute(actual) &&
    hasServiceWebviewRoute(embedded)
  ) {
    return embedded.toString();
  }
  return actual.toString();
}

function buildServiceWebviewRouteChangedMessage(
  targetUrl: string,
  reason: "initial" | "navigation" | "route-sync",
): ServiceWebviewBridgeMessage | null {
  const parsed = parseHttpUrl(targetUrl);
  if (!parsed) {
    return null;
  }
  return {
    type: DESKTOP_ROUTE_CHANGED_MESSAGE_TYPE,
    requestId: `service_webview_route_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
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

async function tryReadServiceWebviewPageContext(
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
          : serviceDisplayName || t("serviceWebview.embeddedAppFallback"),
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

export function ServiceWebviewSurface({
  hostTheme,
  serviceId: serviceIdProp,
  surfaceId: surfaceIdProp,
  surfaceIdentity: surfaceIdentityProp,
  surfaceIdentityKey,
  active,
  surfaceOwnershipActive,
  desktopRoute: desktopRouteProp,
  embedPath,
  surfaceLabel,
  ownerChatId,
  skipContextRegistration,
  devToolsTarget,
  loadInitialEmbeddedUrlDirectly,
  suppressInitialLoadingCopy,
  focusRequestId,
  onFocusRequestHandled,
  onCurrentUrlChange,
  onRuntimeProtectionChange,
}: ServiceWebviewSurfaceProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const currentRoute = `${location.pathname}${location.search}`;
  const currentRouteWithHash = `${location.pathname}${location.search}${location.hash}`;
  const desiredDesktopRoute = desktopRouteProp?.trim() || currentRouteWithHash;
  const { serviceId: routeServiceId, pluginId: routePluginId } = useParams<{
    serviceId?: string;
    pluginId?: string;
  }>();
  const serviceId = serviceIdProp ?? routeServiceId ?? routePluginId ?? "";
  const surfaceIdentity = surfaceIdentityProp ?? createServiceSurfaceIdentity(serviceId);
  const resolvedSurfaceIdentityKey = surfaceIdentityKey?.trim() || (
    surfaceIdentity.surfaceRole === "service" ? serviceId.trim() : ""
  );
  const surfaceId = surfaceIdentity.surfaceId || surfaceIdProp?.trim() || serviceId;
  const ownsActiveSurface = surfaceOwnershipActive ?? active !== false;
  const { locale, t } = useI18n();
  const { services, refresh: refreshServices } = useServices();
  const service = services.find((s) => s.id === serviceId);
  const agentPlatformService =
    service?.id === "agent-webclient"
      ? services.find((s) => s.id === "agent-platform")
      : null;
  const serviceDisplayName =
    surfaceLabel ||
    (service ? getServiceDisplayName(service.id, service.name, t) : "");
  const controlCenterPath = "/control-center";
  const pluginsSettingsPath = buildSettingsSectionPath("plugins");
  const serviceManagementPath = service?.kind === "plugin" ? pluginsSettingsPath : controlCenterPath;
  const serviceOpenManagementLabel =
    service?.kind === "plugin" ? t("serviceWebview.openPlugins") : t("serviceWebview.openControlCenter");
  const serviceBackManagementLabel =
    service?.kind === "plugin" ? t("serviceWebview.backToPlugins") : t("serviceWebview.backToControlCenter");
  const serviceKindLabel =
    service?.kind === "plugin"
      ? t("serviceWebview.kind.plugin")
      : t("serviceWebview.kind.service");
  const surfaceRoute = resolveDesktopSurfacePathname(desiredDesktopRoute);
  const [bridgeError, setBridgeError] = useState("");
  const [bridgeReady, setBridgeReady] = useState(false);
  const [webviewRetryNonce, setWebviewRetryNonce] = useState(0);
  const [webviewLoadError, setWebviewLoadError] = useState(false);
  const [webviewCurrentUrl, setWebviewCurrentUrl] = useState("");
  const [webviewSnapshotNonce, setWebviewSnapshotNonce] = useState(0);
  const [selectionToolbarState, setSelectionToolbarState] =
    useState<VisibleSelectionToolbarState | null>(null);
  const [webviewModalOverlayVisible, setWebviewModalOverlayVisible] = useState(false);
  const [serviceWebviewPreloadUrl, setServiceWebviewPreloadUrl] = useState("");
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState !== "hidden");
  const [agentPlatformMonitorAccessToken, setAgentPlatformMonitorAccessToken] =
    useState("");
  const webviewRef = useRef<Electron.WebviewTag | null>(null);
  const surfaceRegistrationIdRef = useRef("");
  const surfaceRegistrationRetryRef = useRef(0);
  const registeredSafeSurfaceIdentityRef = useRef<RegisteredSafeSurfaceIdentity | null>(null);
  const routeTransitionSequenceRef = useRef(0);
  const pendingDirectRouteTransitionRef = useRef<PendingDirectRouteTransition | null>(null);
  const webviewDomReadyRef = useRef<{ ready: boolean; webContentsId?: number }>({ ready: false });
  const webviewEventContextRef = useRef<ServiceWebviewEventContext | null>(null);
  if (!surfaceRegistrationIdRef.current) {
    surfaceRegistrationIdRef.current = createServiceSurfaceRegistrationId();
  }
  const windowModalOverlaySourceId = `service-webview:${surfaceId}`;
  // Child surfaces only mask their own panel; root/utility surfaces occupy the
  // main content area and should extend that mask into Windows window controls.
  const shouldMaskWindowControls =
    active !== false &&
    ownsActiveSurface &&
    surfaceIdentity.surfaceLevel !== "child" &&
    webviewModalOverlayVisible;
  const lastHandledFocusRequestIdRef = useRef(0);
  const lastDirectWebviewRouteRef = useRef("");
  const lastHostAppliedChatRouteRef = useRef("");
  const lastReportedCurrentUrlRef = useRef("");
  const lastAgentSwitchNewChatTimestampRef = useRef(0);
  const lastLiveSurfaceLifecycleRef = useRef<{
    active: boolean;
    webContentsId: number | undefined;
  } | null>(null);
  const runtimeProtectionReasonsRef = useRef(new Set<string>());
  const onCurrentUrlChangeRef = useRef(onCurrentUrlChange);
  const pendingCanonicalChatSyncRef = useRef<PendingCanonicalChatSync | null>(null);
  const pendingNewChatPreparationRef = useRef<PendingNewChatPreparation | null>(null);
  const currentRouteWithHashRef = useRef(currentRouteWithHash);
  currentRouteWithHashRef.current = currentRouteWithHash;
  const surfaceVisibilityProps =
    active === undefined
      ? {}
      : {
          hidden: !active,
          "aria-hidden": !active,
        };

  useEffect(() => {
    return registerServiceSurfaceWebviewRef(surfaceId, webviewRef);
  }, [surfaceId]);

  useEffect(() => {
    return () => {
      const pending = pendingNewChatPreparationRef.current;
      if (pending) {
        window.clearTimeout(pending.timeoutId);
        pendingNewChatPreparationRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const syncDocumentVisibility = () => {
      setDocumentVisible(document.visibilityState !== "hidden");
    };
    syncDocumentVisibility();
    document.addEventListener("visibilitychange", syncDocumentVisibility);
    return () => {
      document.removeEventListener("visibilitychange", syncDocumentVisibility);
    };
  }, []);

  const handleWebviewRef = useCallback((node: Electron.WebviewTag | null): void => {
    if (webviewRef.current === node) {
      return;
    }
    setSelectionToolbarState(null);
    setWebviewModalOverlayVisible(false);
    routeTransitionSequenceRef.current += 1;
    pendingDirectRouteTransitionRef.current = null;
    webviewDomReadyRef.current = { ready: false };
    webviewRef.current = node;
    if (node) {
      setWebviewSnapshotNonce((current) => current + 1);
    }
  }, []);

  useEffect(() => {
    window.electronAPI.desktopShell.setWebviewModalOverlayVisible(
      windowModalOverlaySourceId,
      shouldMaskWindowControls,
    );
  }, [shouldMaskWindowControls, windowModalOverlaySourceId]);

  useEffect(() => {
    return () => {
      window.electronAPI.desktopShell.setWebviewModalOverlayVisible(
        windowModalOverlaySourceId,
        false,
      );
    };
  }, [windowModalOverlaySourceId]);

  useEffect(() => {
    return window.electronAPI.serviceWebview.onSelectionToolbarState((state) => {
      const webContentsId = readWebviewContentsId(webviewRef.current);
      if (
        state.guestId !== webContentsId ||
        state.registrationId !== surfaceRegistrationIdRef.current ||
        state.surfaceId !== surfaceId
      ) {
        return;
      }
      if (!state.visible) {
        setSelectionToolbarState((current) =>
          current?.selectionId === state.selectionId ? null : current
        );
        return;
      }
      if (active === false || service?.id !== "agent-webclient") return;
      setSelectionToolbarState(state);
    });
  }, [active, service?.id, surfaceId, webviewSnapshotNonce]);

  useEffect(() => {
    if (active === false) setSelectionToolbarState(null);
  }, [active]);

  useEffect(() => {
    onCurrentUrlChangeRef.current = onCurrentUrlChange;
  }, [onCurrentUrlChange]);

  useEffect(() => {
    if (!isAgentWebclientChatSurface(serviceId, surfaceId)) return undefined;
    return window.electronAPI.canonicalChatSync.onRequest((request) => {
      if (request.surfaceId !== surfaceId) return;
      const respond = (result: CanonicalChatSyncResult) => {
        window.electronAPI.canonicalChatSync.respond(result);
      };
      const webContentsId = readWebviewContentsId(webviewRef.current);
      if (
        active === false ||
        request.surfaceId !== MAIN_CHAT_SURFACE_ID ||
        request.registrationId !== surfaceRegistrationIdRef.current ||
        request.guestWebContentsId !== webContentsId
      ) {
        respond({
          requestId: request.requestId,
          ok: false,
          code: "stale_source",
          message: "canonical Chat request no longer belongs to the active Main Chat surface",
        });
        return;
      }
      const targetRoute = createCanonicalAgentChatRoute(currentRouteWithHash, request);
      if (!targetRoute || ownerChatId?.trim()) {
        respond({
          requestId: request.requestId,
          ok: false,
          code: "route_mismatch",
          message: "Desktop route no longer matches the new Chat query source",
        });
        return;
      }
      const previous = pendingCanonicalChatSyncRef.current;
      if (previous && previous.request.requestId !== request.requestId) {
        respond({
          requestId: previous.request.requestId,
          ok: false,
          code: "stale_source",
          message: "canonical Chat request was superseded by a newer query",
        });
      }
      pendingCanonicalChatSyncRef.current = { request, targetRoute };
      surfaceRegistrationRetryRef.current = 0;
      navigate(targetRoute, { replace: true });
    });
  }, [
    active,
    currentRouteWithHash,
    navigate,
    ownerChatId,
    serviceId,
    surfaceId,
  ]);

  useEffect(() => {
    const pending = pendingCanonicalChatSyncRef.current;
    if (!pending) return;
    if (active !== false && currentRouteWithHash === pending.targetRoute) return;
    pendingCanonicalChatSyncRef.current = null;
    window.electronAPI.canonicalChatSync.respond({
      requestId: pending.request.requestId,
      ok: false,
      code: "stale_source",
      message: "Main Chat changed before canonical surface registration completed",
    });
  }, [active, currentRouteWithHash]);

  useEffect(() => {
    const requestId = Number.isSafeInteger(focusRequestId) && Number(focusRequestId) > 0
      ? Number(focusRequestId)
      : 0;
    if (
      !requestId ||
      requestId === lastHandledFocusRequestIdRef.current ||
      active !== true ||
      !isAgentWebclientChatSurface(serviceId, surfaceId)
    ) {
      return;
    }
    const targetWebview = webviewRef.current;
    if (!targetWebview) {
      return;
    }
    try {
      targetWebview.focus();
      lastHandledFocusRequestIdRef.current = requestId;
      onFocusRequestHandled?.(requestId);
    } catch {
      // Keep the request pending so a recreated WebView can consume it later.
    }
  }, [active, focusRequestId, onFocusRequestHandled, serviceId, surfaceId, webviewSnapshotNonce]);

  const webUrl = service?.healthMeta.webUrl ?? "";
  const bridgeProtocol = useMemo(
    () => getServiceWebviewAuthProtocol(service?.id),
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
    return buildServiceWebviewUrl(service?.id, webUrl, {
      hostTheme,
      hostLocale: service?.id === "agent-webclient" ? locale : undefined,
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
    wsSource,
  ]);

  const finishNewChatPreparation = useCallback((
    pending: PendingNewChatPreparation,
    result: { ok: true } | { ok: false; message: string },
    restoreSourceRoute = false,
  ) => {
    if (
      pendingNewChatPreparationRef.current?.request.requestId !==
      pending.request.requestId
    ) {
      return;
    }
    pendingNewChatPreparationRef.current = null;
    window.clearTimeout(pending.timeoutId);
    sendBridgeMessageToWebview({
      type: AGENT_WEBCLIENT_NEW_CHAT_PREPARE_RESPONSE_TYPE,
      requestId: pending.request.requestId,
      ok: result.ok,
      ...(!result.ok ? { message: result.message } : {}),
    });
    if (
      restoreSourceRoute &&
      currentRouteWithHashRef.current === pending.targetRoute
    ) {
      navigate(pending.sourceRoute, { replace: true });
    }
  }, [navigate]);

  const prepareAgentWebclientNewChat = useCallback((request: {
    requestId: string;
    agentKey: string;
    sourceChatId: string;
    newChat: string;
  }): { ok: true } | { ok: false; message: string } => {
    const normalizedRequest = {
      requestId: request.requestId.trim(),
      agentKey: request.agentKey.trim(),
      sourceChatId: request.sourceChatId.trim(),
      newChat: request.newChat.trim(),
    };
    const webContentsId = readWebviewContentsId(webviewRef.current);
    const targetRoute = createPreparedAgentChatRoute(
      currentRouteWithHash,
      normalizedRequest,
    );
    const guestRoute = resolveAgentWebclientDesktopChatRouteFromUrl(
      readCurrentWebviewUrl(),
      embeddedUrl,
    );
    if (
      serviceId !== "agent-webclient" ||
      surfaceId !== MAIN_CHAT_SURFACE_ID ||
      active === false ||
      !ownsActiveSurface ||
      !webContentsId ||
      !normalizedRequest.requestId ||
      normalizedRequest.requestId.length > 128 ||
      normalizedRequest.agentKey.length > 256 ||
      normalizedRequest.sourceChatId.length > 512 ||
      ownerChatId?.trim() !== normalizedRequest.sourceChatId ||
      !targetRoute ||
      !guestRoute ||
      !areAgentWebclientChatBusinessRoutesEquivalent(
        currentRouteWithHash,
        guestRoute,
      )
    ) {
      return {
        ok: false,
        message: "new Chat preparation does not match the active Main Chat source",
      };
    }
    if (pendingNewChatPreparationRef.current) {
      return {
        ok: false,
        message: "another new Chat preparation is already in progress",
      };
    }

    const pending: PendingNewChatPreparation = {
      request: normalizedRequest,
      sourceRoute: currentRouteWithHash,
      targetRoute,
      registrationId: surfaceRegistrationIdRef.current,
      guestWebContentsId: webContentsId,
      timeoutId: 0,
    };
    pending.timeoutId = window.setTimeout(() => {
      reportServiceWebviewDiagnostic("new-chat-preparation-timeout", {
        requestId: pending.request.requestId,
        agentKey: pending.request.agentKey,
        sourceChatId: pending.request.sourceChatId,
        newChat: pending.request.newChat,
      });
      finishNewChatPreparation(
        pending,
        { ok: false, message: "new Chat surface preparation timed out" },
        true,
      );
    }, 8_000);
    pendingNewChatPreparationRef.current = pending;
    surfaceRegistrationRetryRef.current = 0;
    navigate(targetRoute);
    return { ok: true };
  }, [
    active,
    currentRouteWithHash,
    embeddedUrl,
    finishNewChatPreparation,
    navigate,
    ownerChatId,
    ownsActiveSurface,
    serviceId,
    surfaceId,
  ]);

  useEffect(() => {
    const pending = pendingNewChatPreparationRef.current;
    if (!pending) return;
    const webContentsId = readWebviewContentsId(webviewRef.current);
    if (
      active !== false &&
      ownsActiveSurface &&
      webContentsId === pending.guestWebContentsId &&
      (currentRouteWithHash === pending.sourceRoute ||
        currentRouteWithHash === pending.targetRoute)
    ) {
      return;
    }
    reportServiceWebviewDiagnostic("new-chat-preparation-identity-changed", {
      requestId: pending.request.requestId,
      expectedRoute: pending.targetRoute,
      currentRoute: currentRouteWithHash,
      expectedGuestWebContentsId: pending.guestWebContentsId,
      currentGuestWebContentsId: webContentsId,
    });
    finishNewChatPreparation(
      pending,
      { ok: false, message: "Main Chat changed before new Chat preparation completed" },
      true,
    );
  }, [
    active,
    currentRouteWithHash,
    finishNewChatPreparation,
    ownsActiveSurface,
    webviewSnapshotNonce,
  ]);

  useEffect(() => {
    const embeddedCdp = getEmbeddedCdpSurfaceApi();
    const targetWebview = webviewRef.current;
    const webContentsId = readWebviewContentsId(targetWebview);
    if (!embeddedCdp || !targetWebview || !webContentsId || !surfaceId) {
      return;
    }
    let currentUrl = embeddedUrl;
    let title = serviceDisplayName;
    let canGoBack = false;
    let canGoForward = false;
    let isLoading = false;
    try {
      currentUrl = targetWebview.getURL() || webviewCurrentUrl || embeddedUrl;
      title = targetWebview.getTitle() || serviceDisplayName;
      canGoBack = targetWebview.canGoBack();
      canGoForward = targetWebview.canGoForward();
      isLoading = targetWebview.isLoading();
    } catch {
      return;
    }
    let cancelled = false;
    let retryTimer: number | null = null;
    const mainChatSurface = isAgentWebclientChatSurface(serviceId, surfaceId);
    const routeAligned = !mainChatSurface || isMainChatRouteAligned(
      desiredDesktopRoute,
      currentUrl,
      embeddedUrl,
    );
    const registrationActive = ownsActiveSurface && routeAligned;
    const registeredSafeIdentity = registeredSafeSurfaceIdentityRef.current;
    const preserveRegisteredIdentity = Boolean(
      mainChatSurface &&
      !registrationActive &&
      registeredSafeIdentity &&
      registeredSafeIdentity.registrationId === surfaceRegistrationIdRef.current &&
      registeredSafeIdentity.webContentsId === webContentsId,
    );
    const registration: EmbeddedCdpSurfaceRegistration = {
      registrationId: surfaceRegistrationIdRef.current,
      ...surfaceIdentity,
      ...(resolvedSurfaceIdentityKey ? { surfaceIdentityKey: resolvedSurfaceIdentityKey } : {}),
      surfaceKind: "service",
      surfaceType: resolveContextMenuSurfaceType(serviceId, surfaceIdentity.surfaceRole),
      ...(serviceId ? { serviceId } : {}),
      pageRoute: preserveRegisteredIdentity
        ? registeredSafeIdentity?.pageRoute || surfaceRoute
        : surfaceRoute,
      ...(mainChatSurface
        ? {
            pageRouteIdentity: preserveRegisteredIdentity
              ? registeredSafeIdentity?.pageRouteIdentity || desiredDesktopRoute
              : desiredDesktopRoute,
          }
        : {}),
      ...((preserveRegisteredIdentity
        ? registeredSafeIdentity?.ownerChatId
        : ownerChatId?.trim())
        ? {
            ownerChatId: preserveRegisteredIdentity
              ? registeredSafeIdentity?.ownerChatId
              : ownerChatId?.trim(),
          }
        : {}),
      label: serviceDisplayName || surfaceId,
      url: webUrl || embeddedUrl,
      active: registrationActive,
      tabs: [{
        tabId: surfaceId,
        currentUrl,
        title,
        webContentsId,
        canGoBack,
        canGoForward,
        isLoading,
      }],
      activeTabId: surfaceId,
    };
    const readPendingNewChatRegistration = () => {
      const pending = pendingNewChatPreparationRef.current;
      if (
        !pending ||
        pending.registrationId !== registration.registrationId ||
        pending.guestWebContentsId !== webContentsId ||
        !registrationActive ||
        registration.pageRouteIdentity !== pending.targetRoute
      ) {
        return null;
      }
      return {
        pending,
        state: classifyAgentWebclientNewChatRegistration({
          sourceRoute: pending.sourceRoute,
          targetRoute: pending.targetRoute,
          pageRouteIdentity: registration.pageRouteIdentity,
          guestUrl: currentUrl,
          ownerChatId: registration.ownerChatId,
        }),
      };
    };
    if (!registrationActive) {
      sendLiveSurfaceLifecycleToWebview(false);
    }
    void embeddedCdp.registerSurface(registration).then((result) => {
      if (cancelled) return;
      const pendingRegistration = readPendingNewChatRegistration();
      const pendingRegistrationOutcome = pendingRegistration
        ? resolveAgentWebclientNewChatRegistrationOutcome(
            pendingRegistration.state,
            result.ok,
          )
        : null;
      if (result.ok) {
        surfaceRegistrationRetryRef.current = 0;
        if (registrationActive && mainChatSurface) {
          registeredSafeSurfaceIdentityRef.current = {
            registrationId: registration.registrationId,
            webContentsId,
            pageRoute: registration.pageRoute || "",
            pageRouteIdentity: registration.pageRouteIdentity || "",
            ownerChatId: registration.ownerChatId || "",
          };
        }
        if (registrationActive) {
          sendLiveSurfaceLifecycleToWebview(true);
        }
        if (pendingRegistrationOutcome === "acknowledge" && pendingRegistration) {
          reportServiceWebviewDiagnostic("new-chat-preparation-ready", {
            requestId: pendingRegistration.pending.request.requestId,
            registrationState: pendingRegistration.state,
          });
          finishNewChatPreparation(pendingRegistration.pending, { ok: true });
        } else if (pendingRegistrationOutcome === "wait" && pendingRegistration) {
          reportServiceWebviewDiagnostic("new-chat-preparation-waiting-for-guest-route", {
            requestId: pendingRegistration.pending.request.requestId,
            registrationState: pendingRegistration.state,
          });
        } else if (pendingRegistrationOutcome === "fail" && pendingRegistration) {
          reportServiceWebviewDiagnostic("new-chat-preparation-identity-changed", {
            requestId: pendingRegistration.pending.request.requestId,
            registrationState: pendingRegistration.state,
          });
          finishNewChatPreparation(
            pendingRegistration.pending,
            {
              ok: false,
              message: "Main Chat changed before new Chat surface preparation completed",
            },
            true,
          );
        }
        const pending = pendingCanonicalChatSyncRef.current;
        if (
          pending &&
          pending.request.registrationId === registration.registrationId &&
          pending.request.guestWebContentsId === webContentsId &&
          registration.ownerChatId?.trim() === pending.request.chatId
        ) {
          if (
            registrationActive &&
            ownerChatId?.trim() === pending.request.chatId &&
            desiredDesktopRoute === pending.targetRoute
          ) {
            pendingCanonicalChatSyncRef.current = null;
            window.electronAPI.canonicalChatSync.respond({
              requestId: pending.request.requestId,
              ok: true,
            });
          } else {
            pendingCanonicalChatSyncRef.current = null;
            window.electronAPI.canonicalChatSync.respond({
              requestId: pending.request.requestId,
              ok: false,
              code: "stale_source",
              message: "Main Chat changed before canonical surface registration completed",
            });
          }
        }
        return;
      }
      surfaceRegistrationRetryRef.current = 0;
      if (result.reason === "route_not_aligned") {
        return;
      }
      reportServiceWebviewDiagnostic("surface-registration-rejected", {
        reason: result.reason,
        registrationId: registration.registrationId,
        surfaceType: registration.surfaceType,
        newChatPreparationState: pendingRegistration?.state,
      });
      if (pendingRegistrationOutcome === "fail" && pendingRegistration) {
        finishNewChatPreparation(
          pendingRegistration.pending,
          {
            ok: false,
            message: pendingRegistration.state === "target_ready"
              ? "Main Chat surface rejected its new Chat registration"
              : "Main Chat changed before new Chat surface preparation completed",
          },
          true,
        );
      }
      const pending = pendingCanonicalChatSyncRef.current;
      if (
        pending &&
        pending.request.registrationId === registration.registrationId &&
        pending.request.guestWebContentsId === webContentsId &&
        registration.ownerChatId?.trim() === pending.request.chatId
      ) {
        pendingCanonicalChatSyncRef.current = null;
        window.electronAPI.canonicalChatSync.respond({
          requestId: pending.request.requestId,
          ok: false,
          code: "surface_registration_failure",
          message: "Main Chat surface rejected its canonical owner registration",
        });
      }
    }).catch((error) => {
      if (cancelled) return;
      const pendingRegistration = readPendingNewChatRegistration();
      const attempt = surfaceRegistrationRetryRef.current + 1;
      surfaceRegistrationRetryRef.current = attempt;
      reportServiceWebviewDiagnostic("surface-registration-failed", {
        attempt,
        error: error instanceof Error ? error.message : String(error),
        registrationId: registration.registrationId,
        surfaceType: registration.surfaceType,
        newChatPreparationState: pendingRegistration?.state,
      });
      if (attempt <= 2) {
        retryTimer = window.setTimeout(() => {
          setWebviewSnapshotNonce((current) => current + 1);
        }, attempt === 1 ? 100 : 300);
        return;
      }
      if (pendingRegistration) {
        finishNewChatPreparation(
          pendingRegistration.pending,
          {
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          },
          true,
        );
      }
      const pending = pendingCanonicalChatSyncRef.current;
      if (
        pending &&
        pending.request.registrationId === registration.registrationId &&
        pending.request.guestWebContentsId === webContentsId &&
        registration.ownerChatId?.trim() === pending.request.chatId
      ) {
        pendingCanonicalChatSyncRef.current = null;
        window.electronAPI.canonicalChatSync.respond({
          requestId: pending.request.requestId,
          ok: false,
          code: "surface_registration_failure",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [
    ownsActiveSurface,
    ownerChatId,
    desiredDesktopRoute,
    effectiveEmbedPath,
    embeddedUrl,
    serviceDisplayName,
    serviceId,
    finishNewChatPreparation,
    surfaceId,
    surfaceIdentity.interaction,
    surfaceIdentity.ownerChatId,
    surfaceIdentity.parentSurfaceId,
    surfaceIdentity.surfaceId,
    surfaceIdentity.surfaceLevel,
    surfaceIdentity.surfaceRole,
    resolvedSurfaceIdentityKey,
    surfaceRoute,
    webUrl,
    webviewCurrentUrl,
    webviewSnapshotNonce,
  ]);

  useEffect(() => {
    const registrationId = surfaceRegistrationIdRef.current;
    return () => {
      void getEmbeddedCdpSurfaceApi()?.unregisterSurface({
        registrationId,
        surfaceId,
      }).catch(() => undefined);
    };
  }, [surfaceId]);
  const webviewOriginSrcUrl = useMemo(
    () => buildServiceWebviewSrcUrl(embeddedUrl),
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
  function embeddedError(code: string, message: string, details?: unknown): EmbeddedWebScriptError {
    return {
      ok: false as const,
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
      },
    };
  }

  function reportServiceWebviewDiagnostic(
    stage: string,
    details: Record<string, unknown> = {},
  ) {
    const targetWebview = webviewRef.current;
    let currentUrl = "";
    let webContentsId: number | undefined;
    try {
      currentUrl = targetWebview?.getURL() ?? "";
      webContentsId = readWebviewContentsId(targetWebview);
    } catch {
      // The guest can disappear during route changes or app shutdown.
    }
    window.electronAPI.diagnostics?.reportRendererError({
      source: "service-webview",
      message: stage,
      filename: "ServiceWebviewSurface.tsx",
      details: {
        serviceId: service?.id ?? serviceId,
        serviceStatus: service?.status ?? "",
        surfaceId,
        surfaceRoute,
        embedPath: effectiveEmbedPath,
        active: active !== false,
        embeddedUrl,
        webviewSrcUrl,
        currentUrl,
        webContentsId,
        ...details,
      },
    });
  }

  function readCurrentWebviewUrl() {
    try {
      const webviewUrl = webviewRef.current?.getURL();
      return typeof webviewUrl === "string" && webviewUrl.trim()
        ? resolveServiceWebviewCurrentUrl(webviewUrl.trim(), embeddedUrl, webviewSrcUrl)
        : embeddedUrl;
    } catch {
      return embeddedUrl;
    }
  }

  function updateWebviewCurrentUrl(nextUrl: string, source: ServiceWebviewUrlChangeSource) {
    setWebviewCurrentUrl(nextUrl);
    if (!nextUrl || lastReportedCurrentUrlRef.current === nextUrl) {
      return;
    }
    lastReportedCurrentUrlRef.current = nextUrl;
    onCurrentUrlChangeRef.current?.(nextUrl, source);
  }

  function refreshCurrentPageSnapshotTarget() {
    setWebviewSnapshotNonce((current) => current + 1);
  }

  async function readServiceWebviewPageContext() {
    return (
      (await tryReadServiceWebviewPageContext(
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
      buildServiceWebviewFallbackContext(
        serviceDisplayName,
        embeddedUrl,
        webUrl,
        surfaceId,
        serviceDisplayName,
        t,
        surfaceRoute,
        effectiveEmbedPath,
      )
    );
  }

  function publishCopilotDevToolsTarget() {
    if (devToolsTarget !== "copilot") {
      return;
    }

    const webContentsId = readWebviewContentsId(webviewRef.current);
    const isActive =
      ownsActiveSurface &&
      documentVisible &&
      service?.status === "running" &&
      typeof webContentsId === "number";
    const currentUrl = webviewCurrentUrl || readCurrentWebviewUrl();
    void window.electronAPI.copilot.publishDevToolsTarget({
      surfaceId,
      active: isActive,
      ...(typeof webContentsId === "number" ? { webContentsId } : {}),
      ...(currentUrl ? { currentUrl } : {}),
    }).catch(() => undefined);
  }

  useEffect(() => {
    publishCopilotDevToolsTarget();
  }, [
    ownsActiveSurface,
    devToolsTarget,
    documentVisible,
    embeddedUrl,
    service?.status,
    surfaceId,
    webviewCurrentUrl,
    webviewSnapshotNonce,
    webviewSrcUrl,
  ]);

  useEffect(() => {
    if (devToolsTarget !== "copilot") {
      return undefined;
    }
    return () => {
      void window.electronAPI.copilot.publishDevToolsTarget({
        surfaceId,
        active: false,
      }).catch(() => undefined);
    };
  }, [devToolsTarget, surfaceId]);

  async function executeWebviewScript(
    args: Record<string, unknown>,
    script: string,
  ): Promise<EmbeddedWebScriptResult> {
    if (getUtf8ByteLength(script) > EMBEDDED_WEB_SCRIPT_MAX_BYTES) {
      return embeddedError(
        "script_too_large",
        t("externalWebview.error.scriptTooLarge"),
      );
    }
    const targetWebview = webviewRef.current;
    if (!targetWebview) {
      reportServiceWebviewDiagnostic("execute-script-skipped", {
        reason: "webview-unavailable",
      });
      return embeddedError("webview_unavailable", t("serviceWebview.error.webviewUnavailable"));
    }
    try {
      reportServiceWebviewDiagnostic("execute-script-start", {
        scriptBytes: getUtf8ByteLength(script),
      });
      const result = await targetWebview.executeJavaScript(script, true);
      reportServiceWebviewDiagnostic("execute-script-finish");
      return { ok: true as const, result };
    } catch (error) {
      reportServiceWebviewDiagnostic("execute-script-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false as const,
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

  function attachDescriptorMetadata<T extends Record<string, unknown>>(payload: T) {
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
      ok: true as const,
      result: attachDescriptorMetadata({
        interacted: true,
        action,
        outcome: response.result,
      }),
    };
  }

  useEffect(() => {
    setBridgeError("");
  }, [service?.id, embeddedUrl]);

  useEffect(() => {
    updateWebviewCurrentUrl(embeddedUrl, "host");
  }, [embeddedUrl]);

  useEffect(() => {
    setWebviewRetryNonce(0);
    setWebviewLoadError(false);
    setSelectionToolbarState(null);
  }, [service?.status, webviewBaseKey]);

  useEffect(() => {
    let cancelled = false;
    setBridgeReady(false);
    void window.electronAPI.serviceWebview.getPreloadUrl()
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

  function sendLiveSurfaceLifecycleToWebview(nextActive: boolean) {
    if (!isAgentWebclientLifecycleSurface(serviceId, surfaceId, surfaceIdentity)) return;
    const webContentsId = readWebviewContentsId(webviewRef.current);
    const previous = lastLiveSurfaceLifecycleRef.current;
    // Registry metadata (for example ownerChatId) can change while the same
    // guest stays active. Only a real active transition or guest replacement
    // may trigger WebClient replay/attach recovery.
    if (
      previous?.active === nextActive &&
      previous.webContentsId === webContentsId
    ) {
      return;
    }
    sendBridgeMessageToWebview({
      type: DESKTOP_SURFACE_ACTIVE_CHANGED_MESSAGE_TYPE,
      active: nextActive,
      surfaceId,
    });
    lastLiveSurfaceLifecycleRef.current = {
      active: nextActive,
      webContentsId,
    };
  }

  const liveSurfaceLifecycleEnabled = isAgentWebclientLifecycleSurface(
    serviceId,
    surfaceId,
    surfaceIdentity,
  );
  useEffect(() => {
    if (!liveSurfaceLifecycleEnabled) return;
    return () => sendLiveSurfaceLifecycleToWebview(false);
  }, [
    liveSurfaceLifecycleEnabled,
    serviceId,
    surfaceId,
  ]);

  function dispatchServiceWebviewRouteEventToWebview(payload: Record<string, unknown>) {
    try {
      webviewRef.current?.send(SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL, payload);
    } catch {
      // Ignore bridge delivery while the guest webContents is being recreated.
    }
  }

  function sendServiceRouteToWebview(
    targetUrl: string,
    reason: "initial" | "navigation" | "route-sync",
  ) {
    if (isAgentWebclientChatSurface(service?.id, surfaceId)) {
      const currentUrl = readCurrentWebviewUrl();
      if (
        !areAgentWebclientChatNavigationUrlsEquivalent(currentUrl, targetUrl) ||
        areAgentWebclientHostRouteParamsEqual(currentUrl, targetUrl)
      ) {
        return;
      }
    }
    const payload = buildServiceWebviewRouteChangedMessage(targetUrl, reason);
    if (!payload) {
      return;
    }
    if (
      reason !== "navigation" &&
      isAgentWebclientChatSurface(service?.id, surfaceId)
    ) {
      lastHostAppliedChatRouteRef.current = targetUrl;
    }
    dispatchServiceWebviewRouteEventToWebview(payload);
  }

  function requestDirectWebviewRouteLoad() {
    if (!loadInitialEmbeddedUrlDirectly || !embeddedUrl) {
      return;
    }

    const transitionId = routeTransitionSequenceRef.current + 1;
    routeTransitionSequenceRef.current = transitionId;
    const transition: PendingDirectRouteTransition = {
      id: transitionId,
      targetUrl: embeddedUrl,
    };
    pendingDirectRouteTransitionRef.current = transition;
    const targetWebview = webviewRef.current;
    const webContentsId = readWebviewContentsId(targetWebview);
    const domReady = webviewDomReadyRef.current;
    if (
      !targetWebview ||
      !targetWebview.isConnected ||
      !webContentsId ||
      !domReady.ready ||
      domReady.webContentsId !== webContentsId
    ) {
      reportServiceWebviewDiagnostic("direct-route-load-skipped", {
        reason: "guest-not-ready",
        transitionId,
      });
      return;
    }
    const targetUrl = transition.targetUrl;
    const isStaleTransition = () => {
      const latest = pendingDirectRouteTransitionRef.current;
      return latest?.id !== transitionId || latest.targetUrl !== targetUrl;
    };
    const loadTargetUrl = () => {
      if (isStaleTransition()) return;
      webviewDomReadyRef.current = { ready: false, webContentsId };
      void targetWebview.loadURL(targetUrl).catch((reason: unknown) => {
        if (isStaleTransition()) return;
        reportServiceWebviewDiagnostic("direct-route-load-failed", {
          transitionId,
          targetUrl,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      });
    };
    if (isAgentWebclientChatSurface(service?.id, surfaceId)) {
      lastHostAppliedChatRouteRef.current = targetUrl;
    }

    try {
      const currentUrl = targetWebview.getURL().trim();
      const normalizedCurrentUrl = currentUrl
        ? resolveServiceWebviewCurrentUrl(currentUrl, targetUrl, webviewSrcUrl)
        : "";
      const isSemanticAgentChatRouteMatch =
        isAgentWebclientChatSurface(service?.id, surfaceId) &&
        areAgentWebclientChatNavigationUrlsEquivalent(currentUrl, targetUrl);
      if (normalizedCurrentUrl === targetUrl || isSemanticAgentChatRouteMatch) {
        lastDirectWebviewRouteRef.current = targetUrl;
        pendingDirectRouteTransitionRef.current = null;
        reportServiceWebviewDiagnostic("direct-route-load-skipped", {
          reason: "already-at-target",
          transitionId,
          semanticAgentChatRouteMatch: isSemanticAgentChatRouteMatch || undefined,
        });
        return;
      }
      if (!currentUrl && lastDirectWebviewRouteRef.current === targetUrl) {
        reportServiceWebviewDiagnostic("direct-route-load-skipped", {
          reason: "pending-first-url",
          transitionId,
        });
        return;
      }
      lastDirectWebviewRouteRef.current = targetUrl;
      updateWebviewCurrentUrl(targetUrl, "host");
      const currentParsed = parseHttpUrl(currentUrl);
      const targetParsed = parseHttpUrl(targetUrl);
      if (
        currentParsed &&
        targetParsed &&
        currentParsed.origin === targetParsed.origin &&
        !webviewLoadedChromeErrorPage()
      ) {
        reportServiceWebviewDiagnostic("direct-route-client-navigation", {
          transitionId,
          targetUrl,
        });
        void targetWebview.executeJavaScript(
          buildClientSideRouteNavigationScript(targetUrl),
          true,
        ).then((clientNavigationResult: unknown) => {
          if (isStaleTransition()) {
            reportServiceWebviewDiagnostic("direct-route-client-navigation-stale", {
              transitionId,
              targetUrl,
              latestTargetUrl: pendingDirectRouteTransitionRef.current?.targetUrl,
            });
            return;
          }
          const resultRecord =
            clientNavigationResult &&
            typeof clientNavigationResult === "object" &&
            !Array.isArray(clientNavigationResult)
              ? clientNavigationResult as Record<string, unknown>
              : {};
          const resultHref =
            typeof resultRecord.href === "string" ? resultRecord.href.trim() : "";
          const resolvedResultUrl = resultHref
            ? resolveServiceWebviewCurrentUrl(resultHref, targetUrl, webviewSrcUrl)
            : "";
          if (resolvedResultUrl === targetUrl) {
            pendingDirectRouteTransitionRef.current = null;
            updateWebviewCurrentUrl(resolvedResultUrl, "guest");
            return;
          }
          reportServiceWebviewDiagnostic("direct-route-client-navigation-mismatch", {
            transitionId,
            href: resultHref,
            targetUrl,
          });
          loadTargetUrl();
        }).catch((reason: unknown) => {
          if (isStaleTransition()) {
            reportServiceWebviewDiagnostic("direct-route-client-navigation-stale", {
              transitionId,
              targetUrl,
              latestTargetUrl: pendingDirectRouteTransitionRef.current?.targetUrl,
            });
            return;
          }
          reportServiceWebviewDiagnostic("direct-route-client-navigation-failed", {
            transitionId,
            error: reason instanceof Error ? reason.message : String(reason),
          });
          console.warn(
            "[service-webview] failed to apply client-side embedded route",
            reason instanceof Error ? reason.message : String(reason),
          );
          loadTargetUrl();
        });
        return;
      }
      reportServiceWebviewDiagnostic("direct-route-load-url", {
        transitionId,
        targetUrl,
      });
      loadTargetUrl();
    } catch (reason) {
      reportServiceWebviewDiagnostic("direct-route-load-failed", {
        transitionId,
        targetUrl,
        error: reason instanceof Error ? reason.message : String(reason),
      });
      console.warn(
        "[service-webview] failed to load direct embedded route",
        reason instanceof Error ? reason.message : String(reason),
      );
    }
  }

  function handleWebviewBridgeMessage(event: Event) {
    const channel = readEventString(event, "channel");
    if (channel === SERVICE_WEBVIEW_MODAL_OVERLAY_STATE_CHANNEL) {
      const [state] = ((event as Event & { args?: unknown[] }).args ?? []) as [
        ServiceWebviewModalOverlayState?,
      ];
      setWebviewModalOverlayVisible(state?.visible === true);
      return;
    }
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
      serviceId: service?.id ?? serviceId,
      bridgeProtocol,
      desktopAuthContext:
        service?.id === "agent-webclient" ? webviewReloadKey : undefined,
      sendBridgeMessageToWebview,
      prepareAgentWebclientNewChat,
      setBridgeError,
      logDebug: (stage, message) => {
        console.info("[service-webview]", service?.id || "service", stage, message);
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
    updateWebviewCurrentUrl(readCurrentWebviewUrl(), "guest");
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

  function setRuntimeProtected(
    reason: string,
    protectedFromSleep: boolean,
  ) {
    const wasProtected = runtimeProtectionReasonsRef.current.size > 0;
    if (protectedFromSleep) {
      runtimeProtectionReasonsRef.current.add(reason);
    } else {
      runtimeProtectionReasonsRef.current.delete(reason);
    }
    const isProtected = runtimeProtectionReasonsRef.current.size > 0;
    if (isProtected !== wasProtected) {
      onRuntimeProtectionChange?.(isProtected);
    }
  }

  webviewEventContextRef.current = {
    embeddedUrl,
    webviewSrcUrl,
    currentRoute,
    ownsActiveSurface,
    serviceId: service?.id ?? serviceId,
    surfaceId,
    reportDiagnostic: reportServiceWebviewDiagnostic,
    syncWebviewState,
    refreshCurrentPageSnapshotTarget,
    sendServiceRouteToWebview,
    updateWebviewCurrentUrl,
    navigate,
    handleWebviewBridgeMessage,
    requestDirectWebviewRouteLoad,
    setRuntimeProtected,
  };

  useEffect(() => registerSurfaceRuntimeDownloadListener((state) => {
    const context = webviewEventContextRef.current;
    if (!context) return;
    if (
      state.active &&
      readWebviewContentsId(webviewRef.current) !== state.webContentsId
    ) {
      return;
    }
    context.setRuntimeProtected(`download:${state.downloadId}`, state.active);
  }), []);

  useEffect(() => {
    if (!bridgeReady || !serviceWebviewPreloadUrl) {
      return undefined;
    }

    const targetWebview = webviewRef.current;
    if (!targetWebview) {
      return undefined;
    }

    const handleDomReady = () => {
      const webContentsId = readWebviewContentsId(targetWebview);
      webviewDomReadyRef.current = { ready: true, webContentsId };
      const context = webviewEventContextRef.current;
      if (!context) return;
      context.reportDiagnostic("dom-ready");
      context.syncWebviewState();
      context.refreshCurrentPageSnapshotTarget();
      context.sendServiceRouteToWebview(context.embeddedUrl, "initial");
      context.requestDirectWebviewRouteLoad();
    };
    const handleDidFinishLoad = () => {
      const context = webviewEventContextRef.current;
      if (!context) return;
      context.reportDiagnostic("did-finish-load");
      context.syncWebviewState();
      context.refreshCurrentPageSnapshotTarget();
      context.sendServiceRouteToWebview(context.embeddedUrl, "route-sync");
    };
    const handleDidStartLoading = () => {
      webviewEventContextRef.current?.setRuntimeProtected("loading", true);
    };
    const handleDidStopLoading = () => {
      webviewEventContextRef.current?.setRuntimeProtected("loading", false);
    };
    const handleMediaStartedPlaying = () => {
      webviewEventContextRef.current?.setRuntimeProtected("media", true);
    };
    const handleMediaPaused = () => {
      webviewEventContextRef.current?.setRuntimeProtected("media", false);
    };
    const syncNavigationRoute = (event: Event) => {
      const context = webviewEventContextRef.current;
      if (!context) return;
      const nextUrl = readEventString(event, "url");
      context.reportDiagnostic("navigation", {
        url: nextUrl,
        isMainFrame: readEventBoolean(event, "isMainFrame"),
      });
      const resolvedUrl = nextUrl
        ? resolveServiceWebviewCurrentUrl(
            nextUrl,
            context.embeddedUrl,
            context.webviewSrcUrl,
          )
        : readCurrentWebviewUrl();
      context.updateWebviewCurrentUrl(resolvedUrl, "guest");
      const canSyncDesktopRoute = context.ownsActiveSurface;
      if (
        canSyncDesktopRoute &&
        isAgentWebclientChatSurface(context.serviceId, context.surfaceId)
      ) {
        const switchedAgentKey = resolveAgentWebclientDesktopAgentSwitchTarget(
          resolvedUrl,
          context.webviewSrcUrl,
          context.currentRoute,
        );
        if (switchedAgentKey) {
          const nextTimestamp = Math.max(
            Date.now(),
            lastAgentSwitchNewChatTimestampRef.current + 1,
          );
          const newChat = String(nextTimestamp);
          if (/^[1-9]\d{12}$/u.test(newChat)) {
            lastAgentSwitchNewChatTimestampRef.current = nextTimestamp;
            const params = new URLSearchParams({ newChat });
            context.navigate(createAgentWebclientAgentPath(switchedAgentKey, params), {
              replace: true,
            });
            return;
          }
        }
        const nextChatRoute = resolveAgentWebclientDesktopChatRouteFromUrl(
          resolvedUrl,
          context.webviewSrcUrl,
        );
        const isHostRouteEcho = Boolean(lastHostAppliedChatRouteRef.current) &&
          areAgentWebclientChatNavigationUrlsEquivalent(
            lastHostAppliedChatRouteRef.current,
            resolvedUrl,
          );
        const isSameDesktopBusinessRoute = Boolean(nextChatRoute) &&
          areAgentWebclientChatBusinessRoutesEquivalent(
            context.currentRoute,
            nextChatRoute,
          );
        const newChatBootstrapSource = readAgentWebclientNewChatSource(context.currentRoute);
        const newChatBootstrapOwnsPromotion = Boolean(
          newChatBootstrapSource &&
          readAgentWebclientAgentRouteKey(nextChatRoute) ===
            newChatBootstrapSource.agentKey,
        );
        if (
          nextChatRoute &&
          !isHostRouteEcho &&
          !isSameDesktopBusinessRoute &&
          !newChatBootstrapOwnsPromotion
        ) {
          context.navigate(nextChatRoute, { replace: true });
        }
      } else if (
        canSyncDesktopRoute &&
        isAgentWebclientManagementSurface(context.serviceId, context.surfaceId)
      ) {
        const nextChatRoute = resolveAgentWebclientDesktopChatRouteFromUrl(
          resolvedUrl,
          context.webviewSrcUrl,
        );
        if (nextChatRoute) {
          context.navigate(nextChatRoute);
        }
      }
      if (
        nextUrl &&
        readEventBoolean(event, "isMainFrame") !== false &&
        isServiceWebviewRouteSyncTarget(nextUrl, context.webviewSrcUrl)
      ) {
        context.sendServiceRouteToWebview(resolvedUrl, "navigation");
      }
    };
    const handleDidNavigate = (event: Event) => {
      syncNavigationRoute(event);
    };
    const handleDidNavigateInPage = (event: Event) => {
      syncNavigationRoute(event);
    };
    const handleDidFailLoad = (event: Event) => {
      const context = webviewEventContextRef.current;
      if (!context) return;
      context.setRuntimeProtected("loading", false);
      context.reportDiagnostic("did-fail-load", {
        url: readEventString(event, "validatedURL") || readEventString(event, "url"),
        errorCode: readEventNumber(event, "errorCode"),
        errorDescription: readEventString(event, "errorDescription"),
      });
      context.syncWebviewState();
    };
    const handleIpcMessage = (event: Event) => {
      webviewEventContextRef.current?.handleWebviewBridgeMessage(event);
    };

    webviewEventContextRef.current?.reportDiagnostic("listeners-attached");
    targetWebview.addEventListener("dom-ready", handleDomReady);
    targetWebview.addEventListener("did-finish-load", handleDidFinishLoad);
    targetWebview.addEventListener("did-start-loading", handleDidStartLoading);
    targetWebview.addEventListener("did-stop-loading", handleDidStopLoading);
    targetWebview.addEventListener("did-navigate", handleDidNavigate);
    targetWebview.addEventListener(
      "did-navigate-in-page",
      handleDidNavigateInPage,
    );
    targetWebview.addEventListener("did-fail-load", handleDidFailLoad);
    targetWebview.addEventListener("media-started-playing", handleMediaStartedPlaying);
    targetWebview.addEventListener("media-paused", handleMediaPaused);
    targetWebview.addEventListener("ipc-message", handleIpcMessage);
    webviewEventContextRef.current?.syncWebviewState();
    const context = webviewEventContextRef.current;
    if (context) {
      context.sendServiceRouteToWebview(context.embeddedUrl, "route-sync");
    }
    return () => {
      webviewEventContextRef.current?.reportDiagnostic("listeners-detached");
      targetWebview.removeEventListener("dom-ready", handleDomReady);
      targetWebview.removeEventListener("did-finish-load", handleDidFinishLoad);
      targetWebview.removeEventListener("did-start-loading", handleDidStartLoading);
      targetWebview.removeEventListener("did-stop-loading", handleDidStopLoading);
      targetWebview.removeEventListener("did-navigate", handleDidNavigate);
      targetWebview.removeEventListener(
        "did-navigate-in-page",
        handleDidNavigateInPage,
      );
      targetWebview.removeEventListener("did-fail-load", handleDidFailLoad);
      targetWebview.removeEventListener("media-started-playing", handleMediaStartedPlaying);
      targetWebview.removeEventListener("media-paused", handleMediaPaused);
      targetWebview.removeEventListener("ipc-message", handleIpcMessage);
      webviewEventContextRef.current?.setRuntimeProtected("loading", false);
      webviewEventContextRef.current?.setRuntimeProtected("media", false);
      if (webviewDomReadyRef.current.webContentsId === readWebviewContentsId(targetWebview)) {
        webviewDomReadyRef.current = { ready: false };
      }
    };
  }, [bridgeReady, serviceWebviewPreloadUrl, webviewRenderKey]);

  useEffect(() => {
    if (active === false || !bridgeReady || !serviceWebviewPreloadUrl) {
      return;
    }
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
    if (
      active === false ||
      !bridgeReady ||
      !serviceWebviewPreloadUrl ||
      !isAgentWebclientChatSurface(service?.id, surfaceId)
    ) {
      return;
    }
    sendServiceRouteToWebview(embeddedUrl, "route-sync");
  }, [active, bridgeReady, embeddedUrl, service?.id, serviceWebviewPreloadUrl, surfaceId]);

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
    if (
      service?.id !== "agent-webclient" ||
      isAgentWebclientChatSurface(service?.id, surfaceId) ||
      active === false ||
      !embeddedUrl
    ) {
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
  }, [active, embeddedUrl, service?.id, surfaceId, webviewRenderKey]);

  useEffect(() => {
    if (
      !ownsActiveSurface ||
      service?.status !== "running" ||
      skipContextRegistration
    ) {
      return undefined;
    }

    let cancelled = false;
    void (async () => {
      const pageContext = await readServiceWebviewPageContext();
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
    ownsActiveSurface,
    currentRoute,
    embeddedUrl,
    surfaceId,
    service?.status,
    serviceDisplayName,
    skipContextRegistration,
    webviewCurrentUrl,
    webviewSnapshotNonce,
    webUrl,
  ]);

  useEffect(() => {
    if (!surfaceId || !service) {
      return undefined;
    }
    return registerWebSurfaceStateProvider(surfaceId, () => {
      const targetWebview = webviewRef.current;
      const currentUrl = webviewCurrentUrl || readCurrentWebviewUrl() || embeddedUrl || webUrl;
      let canGoBack = false;
      let canGoForward = false;
      try {
        canGoBack = targetWebview?.canGoBack() ?? false;
        canGoForward = targetWebview?.canGoForward() ?? false;
      } catch {
        // The service guest may detach while its runtime is stopping.
      }
      const open = service.status === "running" && Boolean(targetWebview && embeddedUrl);
      const tabId = `service-tab:${surfaceId}`;
      return {
        surface: {
          id: surfaceId,
          ...surfaceIdentity,
          kind: "service",
          label: serviceDisplayName,
          url: embeddedUrl || webUrl,
          route: surfaceRoute,
          open,
          active: ownsActiveSurface
        },
        tabs: open
          ? [{
              tabId,
              title: serviceDisplayName,
              currentUrl,
              active: true,
              isLoading: !bridgeReady,
              canGoBack,
              canGoForward
            }]
          : [],
        activeTabId: open ? tabId : null
      };
    });
  }, [
    ownsActiveSurface,
    bridgeReady,
    embeddedUrl,
    service,
    serviceDisplayName,
    surfaceId,
    surfaceRoute,
    webUrl,
    webviewCurrentUrl,
    webviewSnapshotNonce
  ]);

  useEffect(() => {
    if (
      !ownsActiveSurface ||
      service?.status !== "running" ||
      skipContextRegistration
    ) {
      return undefined;
    }

    return registerAssistantPageContextProvider(async () => {
      return readServiceWebviewPageContext();
    });
  }, [
    ownsActiveSurface,
    embeddedUrl,
    surfaceId,
    service?.status,
    serviceDisplayName,
    skipContextRegistration,
    webUrl,
  ]);

  useEffect(() => {
    const isSurfaceActive = ownsActiveSurface;
    if (
      !isSurfaceActive ||
      service?.status !== "running" ||
      !embeddedUrl ||
      skipContextRegistration
    ) {
      return undefined;
    }

    function requestTargetsDifferentSurface(args: Record<string, unknown>) {
      const targetSurfaceId =
        typeof args.surfaceId === "string" ? args.surfaceId.trim() : "";
      return Boolean(
        targetSurfaceId &&
        resolveLegacyFixedSurfaceId(targetSurfaceId) !== surfaceId &&
        targetSurfaceId !== serviceId
      );
    }

    return registerDesktopActionProviderForScope(
      "web",
      async (request) => {
        if (service?.status !== "running") {
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
            return executeWebviewScript(args, script);
          }
          default:
            return null;
        }
      },
    );
  }, [
    ownsActiveSurface,
    embeddedUrl,
    serviceId,
    surfaceId,
    service?.status,
    serviceDisplayName,
    skipContextRegistration,
    t,
    webviewCurrentUrl,
    webUrl,
  ]);

  if (!service) {
    if (serviceId === "agent-webclient") {
      return (
        <section className="empty-state" {...surfaceVisibilityProps}>
          <h1>{t("serviceWebview.agentServiceMissingTitle")}</h1>
          <p>{t("serviceWebview.agentServiceMissingDescription")}</p>
          <Link className="primary-link" to={controlCenterPath}>
            {t("serviceWebview.openControlCenter")}
          </Link>
        </section>
      );
    }

    return (
      <section className="empty-state" {...surfaceVisibilityProps}>
        <h1>{t("serviceWebview.serviceMissingTitle")}</h1>
        <p>{t("serviceWebview.serviceMissingDescription", { serviceId })}</p>
        <Link className="primary-link" to={pluginsSettingsPath}>
          {t("serviceWebview.backToPlugins")}
        </Link>
      </section>
    );
  }

  if (service.status !== "running") {
    return (
      <section className="empty-state" {...surfaceVisibilityProps}>
        <p className="eyebrow">{serviceKindLabel}</p>
        <h1>{t("serviceWebview.notReadyTitle", { name: serviceDisplayName })}</h1>
        <p>{service.message}</p>
        <Link className="primary-link" to={serviceManagementPath}>
          {serviceOpenManagementLabel}
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
        <p>{t("serviceWebview.noFrontend")}</p>
        <Link className="primary-link" to={serviceManagementPath}>
          {serviceBackManagementLabel}
        </Link>
      </section>
    );
  }

  if (bridgeError) {
    return (
      <section className="empty-state" {...surfaceVisibilityProps}>
        <p className="eyebrow">{serviceKindLabel}</p>
        <h1>{serviceDisplayName}</h1>
        <p>{t("serviceWebview.authBridgeFailed", { message: bridgeError })}</p>
        <Link className="primary-link" to={serviceManagementPath}>
          {serviceBackManagementLabel}
        </Link>
      </section>
    );
  }

  if (service.id === "agent-platform" && !agentPlatformMonitorAccessToken) {
    return (
      <section className="empty-state" {...surfaceVisibilityProps}>
        <p className="eyebrow">{serviceKindLabel}</p>
        <h1>{serviceDisplayName}</h1>
        <p>Preparing secure monitor preview.</p>
      </section>
    );
  }

  return (
    <section
      className={[
        "embedded-surface-page",
        "embedded-surface-page-embedded"
      ].filter(Boolean).join(" ")}
      {...surfaceVisibilityProps}
    >
      {active && serviceId !== "agent-webclient" && (
        <button
          className="embedded-back-button"
          onClick={() => {
            navigate(-1);
          }}
          title={t("serviceWebview.back")}
          aria-label={t("common.back")}
        >
          <svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="currentColor">
            <path d="m313-440 224 224-57 57-320-320 320-320 57 57-224 224h487v80H313Z"/>
          </svg>
        </button>
      )}
      <div className="embedded-surface-frame-shell">
        <WebviewDebugOverlay
          url={webviewCurrentUrl || embeddedUrl || webviewSrcUrl}
          surfaceIdentity={surfaceIdentity}
        />
        {bridgeReady && serviceWebviewPreloadUrl ? (
          <>
            {webviewLoadError ? (
              <section
                className="empty-state service-webview-error"
                aria-live="polite"
              >
                <p className="eyebrow">{serviceKindLabel}</p>
                <h1>{serviceDisplayName}</h1>
                <p>{t("serviceWebview.agentRecovering")}</p>
              </section>
            ) : null}
            {createElement("webview", {
              key: webviewRenderKey,
              ref: handleWebviewRef,
              src: webviewSrcUrl,
              title: serviceDisplayName,
              className: "embedded-surface-frame",
              preload: serviceWebviewPreloadUrl,
              partition: `persist:${STORAGE_NAMESPACE}-service-${serviceId || "plugin"}`,
              allowpopups: "true",
              style: { width: "100%", height: "100%", border: "none" },
            })}
            {selectionToolbarState && active !== false ? (
              <WebviewSelectionToolbar
                anchor={selectionToolbarState.rect}
                selectionId={selectionToolbarState.selectionId}
                onDismiss={() => setSelectionToolbarState(null)}
              />
            ) : null}
          </>
        ) : suppressInitialLoadingCopy ? (
          <section
            className="empty-state"
            aria-busy="true"
            aria-label={t("serviceWebview.loading", { name: serviceDisplayName })}
          />
        ) : (
          <section className="empty-state">
            <p className="eyebrow">{serviceKindLabel}</p>
            <h1>{serviceDisplayName}</h1>
            <p>{t("serviceWebview.preparingAuth")}</p>
          </section>
        )}
      </div>
    </section>
  );
}
