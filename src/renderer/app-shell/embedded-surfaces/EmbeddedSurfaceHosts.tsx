import { useParams } from "react-router-dom";
import { ExternalWebviewPage } from "../../pages/external-webview/ExternalWebviewPage";
import { PlaceholderPage } from "../../pages/PlaceholderPage";
import { PluginPage } from "../../pages/plugin/PluginPage";

type ThemeMode = "light" | "dark";

type AgentWebclientRouteItem = {
  embedPath: string;
  label: string;
};

type EmbeddedSidebarItem = {
  label: string;
  url: string;
};

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
  if (mountedPluginIds.length === 0) {
    return null;
  }

  return (
    <>
      {/* Keep embedded plugin browsing contexts mounted so sidebar switches do not tear down live sessions. */}
      {mountedPluginIds.map((pluginId) => (
        <PluginPage
          key={pluginId}
          active={activePluginId === pluginId}
          embedPath={pluginId === "agent-webclient" ? activeAgentWebclientRoute?.embedPath : undefined}
          hostTheme={hostTheme}
          pluginId={pluginId}
          surfaceLabel={pluginId === "agent-webclient" ? activeAgentWebclientRoute?.label : undefined}
        />
      ))}
    </>
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
    <>
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
    </>
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

  return <ExternalWebviewPage surfaceId={itemId} surfaceLabel={item.label} title={item.label} url={item.url} />;
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
