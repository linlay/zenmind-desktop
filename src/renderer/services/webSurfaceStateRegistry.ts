export type WebSurfaceTabState = {
  tabId: string;
  title: string;
  currentUrl: string;
  faviconUrl?: string;
  active: boolean;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
};

export type WebSurfaceState = {
  surface: {
    id: string;
    kind: "website" | "webapp" | "browser" | "service";
    label: string;
    url: string;
    route: string;
    open: boolean;
    active: boolean;
  };
  tabs: WebSurfaceTabState[];
  activeTabId: string | null;
};

type WebSurfaceStateProvider = () => WebSurfaceState;

const providers = new Map<string, { token: symbol; read: WebSurfaceStateProvider }>();

export function registerWebSurfaceStateProvider(surfaceId: string, read: WebSurfaceStateProvider) {
  const normalizedSurfaceId = surfaceId.trim();
  const token = Symbol(normalizedSurfaceId);
  providers.set(normalizedSurfaceId, { token, read });
  return () => {
    if (providers.get(normalizedSurfaceId)?.token === token) {
      providers.delete(normalizedSurfaceId);
    }
  };
}

export function readWebSurfaceState(surfaceId: string) {
  return providers.get(surfaceId.trim())?.read() ?? null;
}
