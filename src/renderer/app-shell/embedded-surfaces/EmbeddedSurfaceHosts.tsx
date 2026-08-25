import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
import {
  COPILOT_CHAT_SURFACE_ID,
  MAIN_CHAT_SURFACE_ID,
  createServiceSurfaceIdentity,
  createSurfaceIdentity,
  createWebEntrySurfaceIdentity
} from "../../../shared/surface-identity";

type ThemeMode = "light" | "dark";

type AgentWebclientRouteItem = Pick<AgentWebclientResolvedRoute, "embedPath" | "label" | "kind">;

const ExternalWebviewPage = lazy(() =>
  import("../../pages/external-webview/ExternalWebviewPage").then((module) => ({ default: module.ExternalWebviewPage }))
);
const ServiceWebviewSurface = lazy(() =>
  import("../../service-webview/ServiceWebviewSurface").then((module) => ({ default: module.ServiceWebviewSurface }))
);

type EmbeddedSidebarItem = {
  id?: string;
  kind?: "website" | "webapp";
  label: string;
  url: string;
  chrome?: "browser" | "app";
  runtimeStatus?: "idle" | "starting" | "running" | "blocked" | "error";
  runtimeMessage?: string;
};

export type WebappPresentationOwner =
  | { scope: "main-workspace" }
  | { scope: "workpanel"; ownerChatId: string; itemId: string }
  | { scope: "dialog" }
  | { scope: "detached" };

const AGENT_WEBCLIENT_CHAT_SURFACE_ID = MAIN_CHAT_SURFACE_ID;
const AGENT_WEBCLIENT_COPILOT_SURFACE_ID = COPILOT_CHAT_SURFACE_ID;

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
  activeOwnerChatId,
}: {
  activeServiceId: string | null;
  activeAgentWebclientRoute: AgentWebclientRouteItem | null;
  agentChatFocusRequestId?: number | null;
  hostTheme: ThemeMode;
  mountedServiceIds: string[];
  onAgentChatFocusRequestHandled?: (requestId: number) => void;
  activeOwnerChatId?: string | null;
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
          : createServiceSurfaceIdentity(AGENT_WEBCLIENT_SERVICE_ID).surfaceId
      : activeServiceId
        ? createServiceSurfaceIdentity(activeServiceId).surfaceId
        : null;
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
      {/* Keep browsing contexts mounted; page active/inactive lifecycle, not the sidebar, owns Run attach/detach. */}
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
          ownerChatId={activeOwnerChatId || undefined}
          serviceId={AGENT_WEBCLIENT_SERVICE_ID}
          surfaceIdentity={createSurfaceIdentity("main-chat", "", {
            ownerChatId: activeOwnerChatId || undefined
          })}
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
          surfaceIdentity={createSurfaceIdentity("copilot-chat")}
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
          surfaceIdentity={createServiceSurfaceIdentity(AGENT_WEBCLIENT_SERVICE_ID)}
          surfaceIdentityKey={AGENT_WEBCLIENT_SERVICE_ID}
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
        surfaceIdentity={createSurfaceIdentity("browser")}
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
  const visibleEntryKeys = (
    activeEntryKey && itemMap.has(activeEntryKey) && !mountedEntryKeys.includes(activeEntryKey)
      ? [...mountedEntryKeys, activeEntryKey]
      : mountedEntryKeys
  ).filter((entryKey) => itemMap.get(entryKey)?.kind !== "webapp");

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
            surfaceIdentity={createWebEntrySurfaceIdentity(item.kind ?? "website", entryKey)}
            surfaceIdentityKey={entryKey}
            surfaceRoute={`/webs/${entryKey}`}
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

function CanonicalWebappSurface({
  active,
  entryKey,
  item,
  owner,
  onClose,
}: {
  active: boolean;
  entryKey: string;
  item: EmbeddedSidebarItem;
  owner: WebappPresentationOwner;
  onClose?: () => void;
}) {
  const { t } = useI18n();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [bounds, setBounds] = useState<CSSProperties>({});

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    const appContent = surface?.closest<HTMLElement>(".app-content");
    if (!surface || !appContent || owner.scope === "dialog" || owner.scope === "detached") return undefined;
    const findTarget = () => {
      if (owner.scope === "main-workspace") {
        return appContent.querySelector<HTMLElement>(":scope > .app-main");
      }
      return Array.from(appContent.querySelectorAll<HTMLElement>("[data-work-panel-item]")).find((candidate) =>
        candidate.dataset.workPanelOwner === owner.ownerChatId && candidate.dataset.workPanelItem === owner.itemId,
      ) ?? null;
    };
    const target = findTarget();
    const updateBounds = () => {
      const nextTarget = findTarget();
      if (!nextTarget || nextTarget.hidden) {
        setBounds({});
        return;
      }
      const rootRect = appContent.getBoundingClientRect();
      const targetRect = nextTarget.getBoundingClientRect();
      setBounds({
        left: targetRect.left - rootRect.left,
        top: targetRect.top - rootRect.top,
        width: targetRect.width,
        height: targetRect.height,
      });
    };
    updateBounds();
    const observer = new ResizeObserver(updateBounds);
    observer.observe(appContent);
    if (target) observer.observe(target);
    window.addEventListener("resize", updateBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateBounds);
    };
  }, [active, owner]);

  const renderable = owner.scope === "main-workspace" || owner.scope === "workpanel";
  const positioned = typeof bounds.width === "number" && bounds.width > 0 && typeof bounds.height === "number" && bounds.height > 0;
  const visible = active && renderable && positioned;
  const ownerChatId = owner.scope === "workpanel" ? owner.ownerChatId : undefined;
  const itemId = owner.scope === "workpanel" ? owner.itemId : undefined;
  return (
    <div
      ref={surfaceRef}
      className={`canonical-webapp-surface${visible ? " is-active" : ""}`}
      style={bounds}
      data-work-panel-owner={ownerChatId}
      data-work-panel-item={itemId}
      data-webapp-entry={entryKey}
      aria-hidden={!visible}
    >
      {!renderable ? null : !item.url ? (
        <PlaceholderPage
          title={item.runtimeStatus === "starting" || item.runtimeStatus === "idle" ? t("startup.title.starting") : t("webapp.startFailed")}
          description={item.runtimeMessage || (item.runtimeStatus === "starting" || item.runtimeStatus === "idle" ? t("webapp.starting") : t("webapp.startFailed"))}
        />
      ) : (
        <ExternalWebviewPage
          active={visible}
          cdpActive={owner.scope === "main-workspace" && visible}
          surfaceIdentity={createWebEntrySurfaceIdentity("webapp", entryKey)}
          surfaceIdentityKey={entryKey}
          surfaceRoute={`/webs/${entryKey}`}
          surfaceKind="webapp"
          surfaceLabel={item.label}
          title={item.label}
          url={item.url}
          chrome={item.chrome}
          ownerChatId={ownerChatId}
          presentationScope={owner.scope === "workpanel" ? "workpanel" : "main-workspace"}
          publishPageContext={owner.scope === "main-workspace"}
          registerPublicWebSurface={owner.scope === "main-workspace"}
          onCloseSurface={onClose}
        />
      )}
    </div>
  );
}

export function CanonicalWebappSurfaceHost({
  activeEntryKey,
  itemMap,
  mountedEntryKeys,
  presentations,
  workPanelState,
  activeWorkPanelChatId,
  workPanelVisible,
  onCloseWebItem,
}: {
  activeEntryKey: WebEntryKey | null;
  itemMap: Map<WebEntryKey, EmbeddedSidebarItem>;
  mountedEntryKeys: WebEntryKey[];
  presentations: Record<string, WebappPresentationOwner>;
  workPanelState: { workspaces: Array<{ ownerChatId: string; activeItemId: string | null }> };
  activeWorkPanelChatId: string | null;
  workPanelVisible: boolean;
  onCloseWebItem?: (entryKey: WebEntryKey) => void;
}) {
  const presentationEntryKeys = [...itemMap.entries()].flatMap(([entryKey, item]) =>
    item.kind === "webapp" && item.id && presentations[item.id] ? [entryKey] : [],
  );
  const entryKeys: WebEntryKey[] = [...new Set<WebEntryKey>([
    ...mountedEntryKeys.filter((entryKey) => itemMap.get(entryKey)?.kind === "webapp"),
    ...presentationEntryKeys,
  ])];
  if (entryKeys.length === 0) return null;
  return (
    <div className="canonical-webapp-layer" aria-label="WebApp presentation layer">
      <EmbeddedSurfaceSuspense>
        {entryKeys.map((entryKey) => {
          const item = itemMap.get(entryKey);
          const owner = item?.id ? presentations[item.id] : undefined;
          if (!item || item.kind !== "webapp" || !owner) return null;
          const active = owner.scope === "main-workspace"
            ? activeEntryKey === entryKey
            : owner.scope === "workpanel"
              ? workPanelVisible && activeWorkPanelChatId === owner.ownerChatId &&
                workPanelState.workspaces.find((workspace) => workspace.ownerChatId === owner.ownerChatId)?.activeItemId === owner.itemId
              : false;
          return (
            <CanonicalWebappSurface
              key={entryKey}
              active={active}
              entryKey={entryKey}
              item={item}
              owner={owner}
              onClose={onCloseWebItem ? () => onCloseWebItem(entryKey) : undefined}
            />
          );
        })}
      </EmbeddedSurfaceSuspense>
    </div>
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
        surfaceIdentity={item.kind ? createWebEntrySurfaceIdentity(item.kind, itemId) : undefined}
        surfaceIdentityKey={item.kind ? itemId : undefined}
        surfaceKind={item.kind}
        surfaceRoute={`/webs/${itemId}`}
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
