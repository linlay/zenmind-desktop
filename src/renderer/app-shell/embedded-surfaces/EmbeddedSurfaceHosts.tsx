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

type ThemeMode = "light" | "dark";

type AgentWebclientRouteItem = Pick<AgentWebclientResolvedRoute, "embedPath" | "label" | "kind">;

const ExternalWebviewPage = lazy(() =>
  import("../../pages/external-webview/ExternalWebviewPage").then((module) => ({ default: module.ExternalWebviewPage }))
);
const PluginPage = lazy(() =>
  import("../../pages/plugin/PluginPage").then((module) => ({ default: module.PluginPage }))
);

type EmbeddedSidebarItem = {
  label: string;
  url: string;
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
  mounted
}: {
  active: boolean;
  mounted: boolean;
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
      />
    </EmbeddedSurfaceSuspense>
  );
}

export function CustomSidebarSurfaceHost({
  activeItemId,
  itemMap,
  mountedItemIds
}: {
  activeItemId: string | null;
  itemMap: Map<string, EmbeddedSidebarItem>;
  mountedItemIds: string[];
}) {
  const visibleItemIds =
    activeItemId && itemMap.has(activeItemId) && !mountedItemIds.includes(activeItemId)
      ? [...mountedItemIds, activeItemId]
      : mountedItemIds;

  if (visibleItemIds.length === 0) {
    return null;
  }

  return (
    <EmbeddedSurfaceSuspense>
      {visibleItemIds.map((itemId) => {
        const item = itemMap.get(itemId);
        if (!item) {
          return null;
        }

        return (
          <ExternalWebviewPage
            key={itemId}
            active={activeItemId === itemId}
            surfaceId={itemId}
            surfaceLabel={item.label}
            title={item.label}
            url={item.url}
          />
        );
      })}
    </EmbeddedSurfaceSuspense>
  );
}

export function ExternalItemRoute({
  itemMap
}: {
  itemMap: Map<string, EmbeddedSidebarItem>;
}) {
  const { itemId = "" } = useParams<{ itemId: string }>();
  const item = itemMap.get(itemId);

  if (!item) {
    return (
      <PlaceholderPage
        title="入口不存在"
        description="该内嵌网站不存在或已被删除，请在设置中检查。"
      />
    );
  }

  return (
    <EmbeddedSurfaceSuspense>
      <ExternalWebviewPage surfaceId={itemId} surfaceLabel={item.label} title={item.label} url={item.url} />
    </EmbeddedSurfaceSuspense>
  );
}

export function CustomSidebarRouteFallback({
  itemMap
}: {
  itemMap: Map<string, EmbeddedSidebarItem>;
}) {
  const { itemId = "" } = useParams<{ itemId: string }>();
  if (itemMap.has(itemId)) {
    return null;
  }

  return (
    <PlaceholderPage
      title="入口不存在"
      description="该内嵌网站不存在或已被删除，请在设置中检查。"
    />
  );
}
