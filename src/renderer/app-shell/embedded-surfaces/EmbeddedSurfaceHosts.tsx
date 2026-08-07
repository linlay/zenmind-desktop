import { lazy, Suspense, useEffect, useRef, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { PlaceholderPage } from "../../pages/PlaceholderPage";
import { setActiveServiceSurfaceId } from "../../services/serviceSurfaceWebviewRefs";
import {
  BUILTIN_BROWSER_DEFAULT_URL,
  BUILTIN_BROWSER_SURFACE_ID,
  BUILTIN_BROWSER_SURFACE_LABEL
} from "../../../shared/browser-surfaces";
import {
  AGENT_WEBCLIENT_SERVICE_ID,
  type AgentWebclientRouteKind,
  type AgentWebclientResolvedRoute
} from "../../../shared/agent-webclient-routes";
import { DESKTOP_SSO_WEBVIEW_PARTITION } from "../../../shared/sso";
import type { WebEntryKey } from "../../../shared/contracts/webs";
import { useI18n } from "../../i18n/useI18n";

type ThemeMode = "light" | "dark";

type AgentWebclientRouteItem = Pick<AgentWebclientResolvedRoute, "embedPath" | "label" | "kind">;

const ExternalWebviewPage = lazy(() =>
  import("../../pages/external-webview/ExternalWebviewPage").then((module) => ({ default: module.ExternalWebviewPage }))
);
const ServiceWebviewSurface = lazy(() =>
  import("../../service-webview/ServiceWebviewSurface").then((module) => ({ default: module.ServiceWebviewSurface }))
);

type EmbeddedSidebarItem = {
  kind?: "website" | "webapp";
  label: string;
  url: string;
  chrome?: "browser" | "app";
  runtimeStatus?: "idle" | "starting" | "running" | "blocked" | "error";
  runtimeMessage?: string;
};

const AGENT_WEBCLIENT_CHAT_SURFACE_ID = "agent-webclient-chat";
const AGENT_WEBCLIENT_COPILOT_SURFACE_ID = "agent-webclient-copilot";

function EmbeddedSurfaceSuspense({ children }: { children: ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}

function resolveAgentWebclientRouteKind(
  route: AgentWebclientRouteItem | null,
): AgentWebclientRouteKind | null {
  return route?.kind ?? null;
}

function shouldLoadInitialServiceUrlDirectly(serviceId: string) {
  return serviceId === "identity-center" || serviceId === "agent-platform";
}

function resolveWebsiteSsoPartition(item: EmbeddedSidebarItem) {
  return item.kind === "website" ? DESKTOP_SSO_WEBVIEW_PARTITION : undefined;
}

export function ServiceWebviewSurfaceHost({
  activeServiceId,
  activeAgentWebclientRoute,
  agentChatFocusRequestId,
  hostTheme,
  mountedServiceIds,
  onAgentChatFocusRequestHandled,
}: {
  activeServiceId: string | null;
  activeAgentWebclientRoute: AgentWebclientRouteItem | null;
  agentChatFocusRequestId?: number | null;
  hostTheme: ThemeMode;
  mountedServiceIds: string[];
  onAgentChatFocusRequestHandled?: (requestId: number) => void;
}) {
  const activeAgentWebclientRouteKind = resolveAgentWebclientRouteKind(activeAgentWebclientRoute);
  const lastAgentChatRouteRef = useRef<AgentWebclientRouteItem | null>(null);
  const lastCopilotRouteRef = useRef<AgentWebclientRouteItem | null>(null);

  if (activeAgentWebclientRouteKind === "chat") {
    lastAgentChatRouteRef.current = activeAgentWebclientRoute;
  }
  if (activeAgentWebclientRouteKind === "copilot") {
    lastCopilotRouteRef.current = activeAgentWebclientRoute;
  }

  const agentWebclientMounted = mountedServiceIds.includes(AGENT_WEBCLIENT_SERVICE_ID);
  const agentChatRoute =
    activeAgentWebclientRouteKind === "chat"
      ? activeAgentWebclientRoute
      : lastAgentChatRouteRef.current;
  const copilotRoute =
    activeAgentWebclientRouteKind === "copilot"
      ? activeAgentWebclientRoute
      : lastCopilotRouteRef.current;
  const activeSurfaceId =
    activeServiceId === AGENT_WEBCLIENT_SERVICE_ID
      ? activeAgentWebclientRouteKind === "chat"
        ? AGENT_WEBCLIENT_CHAT_SURFACE_ID
        : activeAgentWebclientRouteKind === "copilot"
          ? AGENT_WEBCLIENT_COPILOT_SURFACE_ID
          : AGENT_WEBCLIENT_SERVICE_ID
      : activeServiceId;
  const nonAgentServiceIds = mountedServiceIds.filter((serviceId) => serviceId !== AGENT_WEBCLIENT_SERVICE_ID);
  const shouldRenderAgentChatSurface = agentWebclientMounted && Boolean(agentChatRoute);
  const shouldRenderCopilotSurface = agentWebclientMounted && Boolean(copilotRoute);
  const shouldRenderAgentManagementSurface =
    agentWebclientMounted &&
    activeServiceId === AGENT_WEBCLIENT_SERVICE_ID &&
    activeAgentWebclientRouteKind !== "chat" &&
    activeAgentWebclientRouteKind !== "copilot";

  useEffect(() => {
    setActiveServiceSurfaceId(activeSurfaceId);
    return () => {
      setActiveServiceSurfaceId(null);
    };
  }, [activeSurfaceId]);

  if (
    nonAgentServiceIds.length === 0 &&
    !shouldRenderAgentChatSurface &&
    !shouldRenderCopilotSurface &&
    !shouldRenderAgentManagementSurface
  ) {
    return null;
  }

  return (
    <EmbeddedSurfaceSuspense>
      {/* Keep service webview browsing contexts mounted so sidebar switches do not tear down live sessions. */}
      {nonAgentServiceIds.map((serviceId) => (
        <ServiceWebviewSurface
          key={serviceId}
          active={activeServiceId === serviceId}
          hostTheme={hostTheme}
          loadInitialEmbeddedUrlDirectly={shouldLoadInitialServiceUrlDirectly(serviceId)}
          serviceId={serviceId}
        />
      ))}
      {shouldRenderAgentChatSurface ? (
        <ServiceWebviewSurface
          key={AGENT_WEBCLIENT_CHAT_SURFACE_ID}
          active={activeServiceId === AGENT_WEBCLIENT_SERVICE_ID && activeAgentWebclientRouteKind === "chat"}
          embedPath={agentChatRoute?.embedPath}
          focusRequestId={agentChatFocusRequestId}
          hostTheme={hostTheme}
          loadInitialEmbeddedUrlDirectly={Boolean(agentChatRoute?.embedPath)}
          onFocusRequestHandled={onAgentChatFocusRequestHandled}
          serviceId={AGENT_WEBCLIENT_SERVICE_ID}
          surfaceId={AGENT_WEBCLIENT_CHAT_SURFACE_ID}
          surfaceLabel={agentChatRoute?.label}
        />
      ) : null}
      {shouldRenderCopilotSurface ? (
        <ServiceWebviewSurface
          key={AGENT_WEBCLIENT_COPILOT_SURFACE_ID}
          active={activeServiceId === AGENT_WEBCLIENT_SERVICE_ID && activeAgentWebclientRouteKind === "copilot"}
          embedPath={copilotRoute?.embedPath}
          hostTheme={hostTheme}
          loadInitialEmbeddedUrlDirectly={Boolean(copilotRoute?.embedPath)}
          serviceId={AGENT_WEBCLIENT_SERVICE_ID}
          surfaceId={AGENT_WEBCLIENT_COPILOT_SURFACE_ID}
          surfaceLabel={copilotRoute?.label}
        />
      ) : null}
      {shouldRenderAgentManagementSurface ? (
        <ServiceWebviewSurface
          key={AGENT_WEBCLIENT_SERVICE_ID}
          active
          embedPath={activeAgentWebclientRouteKind === "management" ? activeAgentWebclientRoute?.embedPath : undefined}
          hostTheme={hostTheme}
          loadInitialEmbeddedUrlDirectly={activeAgentWebclientRouteKind === "management" && Boolean(activeAgentWebclientRoute?.embedPath)}
          serviceId={AGENT_WEBCLIENT_SERVICE_ID}
          surfaceId={AGENT_WEBCLIENT_SERVICE_ID}
          surfaceLabel={activeAgentWebclientRoute?.label}
        />
      ) : null}
    </EmbeddedSurfaceSuspense>
  );
}

export function BuiltinBrowserSurfaceHost({
  active,
  mounted,
  onCloseSurface,
  assistantDockOpen,
  onOpenAssistantDock,
  onCloseAssistantDock
}: {
  active: boolean;
  mounted: boolean;
  onCloseSurface?: () => void;
  assistantDockOpen?: boolean;
  onOpenAssistantDock?: () => void;
  onCloseAssistantDock?: () => void;
}) {
  if (!mounted) {
    return null;
  }

  return (
    <EmbeddedSurfaceSuspense>
      <ExternalWebviewPage
        surfaceId={BUILTIN_BROWSER_SURFACE_ID}
        surfaceLabel={BUILTIN_BROWSER_SURFACE_LABEL}
        active={active}
        title={BUILTIN_BROWSER_SURFACE_LABEL}
        url={BUILTIN_BROWSER_DEFAULT_URL}
        onCloseSurface={onCloseSurface}
        assistantDockOpen={assistantDockOpen}
        onOpenAssistantDock={onOpenAssistantDock}
        onCloseAssistantDock={onCloseAssistantDock}
      />
    </EmbeddedSurfaceSuspense>
  );
}

export function WebSurfaceHost({
  activeEntryKey,
  itemMap,
  mountedEntryKeys,
  onCloseWebItem,
  onWebsiteFaviconDiscovered,
  assistantDockOpen,
  onOpenAssistantDock,
  onCloseAssistantDock
}: {
  activeEntryKey: WebEntryKey | null;
  itemMap: Map<WebEntryKey, EmbeddedSidebarItem>;
  mountedEntryKeys: WebEntryKey[];
  onCloseWebItem?: (entryKey: WebEntryKey) => void;
  onWebsiteFaviconDiscovered?: (
    entryKey: string,
    websiteUrl: string,
    faviconUrl: string,
  ) => void;
  assistantDockOpen?: boolean;
  onOpenAssistantDock?: () => void;
  onCloseAssistantDock?: () => void;
}) {
  const { t } = useI18n();
  const visibleEntryKeys =
    activeEntryKey && itemMap.has(activeEntryKey) && !mountedEntryKeys.includes(activeEntryKey)
      ? [...mountedEntryKeys, activeEntryKey]
      : mountedEntryKeys;

  if (visibleEntryKeys.length === 0) {
    return null;
  }

  return (
    <EmbeddedSurfaceSuspense>
      {visibleEntryKeys.map((entryKey) => {
        const item = itemMap.get(entryKey);
        if (!item) {
          return null;
        }
        if (!item.url) {
          if (activeEntryKey !== entryKey) {
            return null;
          }
          const starting = item.runtimeStatus === "starting" || item.runtimeStatus === "idle";
          return (
            <PlaceholderPage
              key={entryKey}
              title={starting ? t("startup.title.starting") : t("webapp.startFailed")}
              description={item.runtimeMessage || (starting ? t("webapp.starting") : t("webapp.startFailed"))}
            />
          );
        }

        const isWebsite = item.kind === "website";

        return (
          <ExternalWebviewPage
            key={entryKey}
            active={activeEntryKey === entryKey}
            surfaceId={entryKey}
            surfaceKind={item.kind}
            surfaceLabel={item.label}
            title={item.label}
            url={item.url}
            chrome={item.chrome}
            partition={resolveWebsiteSsoPartition(item)}
            refreshOnDesktopSso={isWebsite}
            onCloseSurface={onCloseWebItem ? () => onCloseWebItem(entryKey) : undefined}
            onFaviconDiscovered={
              isWebsite && onWebsiteFaviconDiscovered
                ? (faviconUrl: string) =>
                    onWebsiteFaviconDiscovered(entryKey, item.url, faviconUrl)
                : undefined
            }
            assistantDockOpen={assistantDockOpen}
            onOpenAssistantDock={onOpenAssistantDock}
            onCloseAssistantDock={onCloseAssistantDock}
          />
        );
      })}
    </EmbeddedSurfaceSuspense>
  );
}

export function ExternalItemRoute({
  itemMap,
  onCloseSurface,
  assistantDockOpen,
  onOpenAssistantDock,
  onCloseAssistantDock
}: {
  itemMap: Map<string, EmbeddedSidebarItem>;
  onCloseSurface?: () => void;
  assistantDockOpen?: boolean;
  onOpenAssistantDock?: () => void;
  onCloseAssistantDock?: () => void;
}) {
  const { t } = useI18n();
  const { itemId = "" } = useParams<{ itemId: string }>();
  const item = itemMap.get(itemId);

  if (!item) {
    return (
      <PlaceholderPage
        title={t("webapp.entryMissingTitle")}
        description={t("webapp.entryMissingDescription")}
      />
    );
  }
  if (!item.url) {
    const starting = item.runtimeStatus === "starting" || item.runtimeStatus === "idle";
    return (
      <PlaceholderPage
        title={starting ? t("startup.title.starting") : t("webapp.startFailed")}
        description={item.runtimeMessage || (starting ? t("webapp.starting") : t("webapp.startFailed"))}
      />
    );
  }

  return (
    <EmbeddedSurfaceSuspense>
      <ExternalWebviewPage
        surfaceId={itemId}
        surfaceLabel={item.label}
        title={item.label}
        url={item.url}
        chrome={item.chrome}
        partition={resolveWebsiteSsoPartition(item)}
        refreshOnDesktopSso={item.kind === "website"}
        onCloseSurface={onCloseSurface}
        assistantDockOpen={assistantDockOpen}
        onOpenAssistantDock={onOpenAssistantDock}
        onCloseAssistantDock={onCloseAssistantDock}
      />
    </EmbeddedSurfaceSuspense>
  );
}

export function WebRouteFallback({
  itemMap
}: {
  itemMap: Map<string, EmbeddedSidebarItem>;
}) {
  const { t } = useI18n();
  const { entryKey = "" } = useParams<{ entryKey: string }>();
  if (itemMap.has(entryKey)) {
    return null;
  }

  return (
    <PlaceholderPage
      title={t("webapp.entryMissingTitle")}
      description={t("webapp.entryMissingDescription")}
    />
  );
}

export function EmptyWebSurfaceRoute() {
  const { t } = useI18n();
  return (
    <PlaceholderPage
      title={t("webapp.emptySurfaceTitle")}
      description={t("webapp.emptySurfaceDescription")}
    />
  );
}
