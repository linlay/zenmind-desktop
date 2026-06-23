import { lazy, Suspense, useEffect, useRef, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { PlaceholderPage } from "../../pages/PlaceholderPage";
import { setActivePluginSurfaceId } from "../../services/pluginSurfaceWebviewRefs";
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
import { useI18n } from "../../i18n/useI18n";

type ThemeMode = "light" | "dark";

type AgentWebclientRouteItem = Pick<AgentWebclientResolvedRoute, "embedPath" | "label" | "kind">;

const ExternalWebviewPage = lazy(() =>
  import("../../pages/external-webview/ExternalWebviewPage").then((module) => ({ default: module.ExternalWebviewPage }))
);
const PluginPage = lazy(() =>
  import("../../pages/plugin/PluginPage").then((module) => ({ default: module.PluginPage }))
);

type EmbeddedSidebarItem = {
  kind?: "website" | "webapp";
  label: string;
  url: string;
  chrome?: "browser" | "app";
  runtimeStatus?: "idle" | "starting" | "running" | "error";
  runtimeMessage?: string;
};

const AGENT_WEBCLIENT_PLUGIN_ID = AGENT_WEBCLIENT_SERVICE_ID;
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

function shouldLoadInitialServiceUrlDirectly(pluginId: string) {
  return pluginId === "identity-center" || pluginId === "agent-platform";
}

function resolveWebsiteSsoPartition(item: EmbeddedSidebarItem) {
  return item.kind === "website" ? DESKTOP_SSO_WEBVIEW_PARTITION : undefined;
}

export function PluginSurfaceHost({
  activePluginId,
  activeAgentWebclientRoute,
  hostTheme,
  mountedPluginIds
}: {
  activePluginId: string | null;
  activeAgentWebclientRoute: AgentWebclientRouteItem | null;
  hostTheme: ThemeMode;
  mountedPluginIds: string[];
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

  const agentWebclientMounted = mountedPluginIds.includes(AGENT_WEBCLIENT_PLUGIN_ID);
  const agentChatRoute =
    activeAgentWebclientRouteKind === "chat"
      ? activeAgentWebclientRoute
      : lastAgentChatRouteRef.current;
  const copilotRoute =
    activeAgentWebclientRouteKind === "copilot"
      ? activeAgentWebclientRoute
      : lastCopilotRouteRef.current;
  const activeSurfaceId =
    activePluginId === AGENT_WEBCLIENT_PLUGIN_ID
      ? activeAgentWebclientRouteKind === "chat"
        ? AGENT_WEBCLIENT_CHAT_SURFACE_ID
        : activeAgentWebclientRouteKind === "copilot"
          ? AGENT_WEBCLIENT_COPILOT_SURFACE_ID
          : AGENT_WEBCLIENT_PLUGIN_ID
      : activePluginId;
  const nonAgentPluginIds = mountedPluginIds.filter((pluginId) => pluginId !== AGENT_WEBCLIENT_PLUGIN_ID);
  const shouldRenderAgentChatSurface = agentWebclientMounted && Boolean(agentChatRoute);
  const shouldRenderCopilotSurface = agentWebclientMounted && Boolean(copilotRoute);
  const shouldRenderAgentManagementSurface =
    agentWebclientMounted &&
    activePluginId === AGENT_WEBCLIENT_PLUGIN_ID &&
    activeAgentWebclientRouteKind !== "chat" &&
    activeAgentWebclientRouteKind !== "copilot";

  useEffect(() => {
    setActivePluginSurfaceId(activeSurfaceId);
    return () => {
      setActivePluginSurfaceId(null);
    };
  }, [activeSurfaceId]);

  if (
    nonAgentPluginIds.length === 0 &&
    !shouldRenderAgentChatSurface &&
    !shouldRenderCopilotSurface &&
    !shouldRenderAgentManagementSurface
  ) {
    return null;
  }

  return (
    <EmbeddedSurfaceSuspense>
      {/* Keep embedded plugin browsing contexts mounted so sidebar switches do not tear down live sessions. */}
      {nonAgentPluginIds.map((pluginId) => (
        <PluginPage
          key={pluginId}
          active={activePluginId === pluginId}
          hostTheme={hostTheme}
          loadInitialEmbeddedUrlDirectly={shouldLoadInitialServiceUrlDirectly(pluginId)}
          pluginId={pluginId}
        />
      ))}
      {shouldRenderAgentChatSurface ? (
        <PluginPage
          key={AGENT_WEBCLIENT_CHAT_SURFACE_ID}
          active={activePluginId === AGENT_WEBCLIENT_PLUGIN_ID && activeAgentWebclientRouteKind === "chat"}
          embedPath={agentChatRoute?.embedPath}
          hostTheme={hostTheme}
          loadInitialEmbeddedUrlDirectly={Boolean(agentChatRoute?.embedPath)}
          pluginId={AGENT_WEBCLIENT_PLUGIN_ID}
          surfaceId={AGENT_WEBCLIENT_CHAT_SURFACE_ID}
          surfaceLabel={agentChatRoute?.label}
        />
      ) : null}
      {shouldRenderCopilotSurface ? (
        <PluginPage
          key={AGENT_WEBCLIENT_COPILOT_SURFACE_ID}
          active={activePluginId === AGENT_WEBCLIENT_PLUGIN_ID && activeAgentWebclientRouteKind === "copilot"}
          embedPath={copilotRoute?.embedPath}
          hostTheme={hostTheme}
          loadInitialEmbeddedUrlDirectly={Boolean(copilotRoute?.embedPath)}
          pluginId={AGENT_WEBCLIENT_PLUGIN_ID}
          surfaceId={AGENT_WEBCLIENT_COPILOT_SURFACE_ID}
          surfaceLabel={copilotRoute?.label}
        />
      ) : null}
      {shouldRenderAgentManagementSurface ? (
        <PluginPage
          key={AGENT_WEBCLIENT_PLUGIN_ID}
          active
          embedPath={activeAgentWebclientRouteKind === "management" ? activeAgentWebclientRoute?.embedPath : undefined}
          hostTheme={hostTheme}
          loadInitialEmbeddedUrlDirectly={activeAgentWebclientRouteKind === "management" && Boolean(activeAgentWebclientRoute?.embedPath)}
          pluginId={AGENT_WEBCLIENT_PLUGIN_ID}
          surfaceId={AGENT_WEBCLIENT_PLUGIN_ID}
          surfaceLabel={activeAgentWebclientRoute?.label}
        />
      ) : null}
    </EmbeddedSurfaceSuspense>
  );
}

export function BuiltinBrowserSurfaceHost({
  active,
  mounted,
  assistantDockOpen,
  onOpenAssistantDock
}: {
  active: boolean;
  mounted: boolean;
  assistantDockOpen?: boolean;
  onOpenAssistantDock?: () => void;
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
        assistantDockOpen={assistantDockOpen}
        onOpenAssistantDock={onOpenAssistantDock}
      />
    </EmbeddedSurfaceSuspense>
  );
}

export function WebSurfaceHost({
  activeEntryKey,
  itemMap,
  mountedEntryKeys,
  assistantDockOpen,
  onOpenAssistantDock
}: {
  activeEntryKey: string | null;
  itemMap: Map<string, EmbeddedSidebarItem>;
  mountedEntryKeys: string[];
  assistantDockOpen?: boolean;
  onOpenAssistantDock?: () => void;
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

        return (
          <ExternalWebviewPage
            key={entryKey}
            active={activeEntryKey === entryKey}
            surfaceId={entryKey}
            surfaceLabel={item.label}
            title={item.label}
            url={item.url}
            chrome={item.chrome}
            partition={resolveWebsiteSsoPartition(item)}
            assistantDockOpen={assistantDockOpen}
            onOpenAssistantDock={onOpenAssistantDock}
          />
        );
      })}
    </EmbeddedSurfaceSuspense>
  );
}

export function ExternalItemRoute({
  itemMap,
  assistantDockOpen,
  onOpenAssistantDock
}: {
  itemMap: Map<string, EmbeddedSidebarItem>;
  assistantDockOpen?: boolean;
  onOpenAssistantDock?: () => void;
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
        assistantDockOpen={assistantDockOpen}
        onOpenAssistantDock={onOpenAssistantDock}
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
