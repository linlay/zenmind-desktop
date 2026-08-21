import { useEffect, useRef, type RefObject } from "react";
import type { WebviewContextMenuSurfaceType } from "../../shared/webview-context-menu";
import type { SurfaceIdentity } from "../../shared/surface-identity";

let registrationSequence = 0;

function createRegistrationId() {
  registrationSequence += 1;
  return `single-webview-surface-${Date.now()}-${registrationSequence}`;
}

export function useSingleWebviewSurfaceRegistration(options: {
  webviewRef: RefObject<Electron.WebviewTag | null>;
  surfaceIdentity: SurfaceIdentity;
  surfaceIdentityKey?: string;
  surfaceType: WebviewContextMenuSurfaceType;
  serviceId?: string;
  pageRoute: string;
  label: string;
  url: string;
  active?: boolean;
  refreshKey?: unknown;
}) {
  const registrationIdRef = useRef("");
  if (!registrationIdRef.current) {
    registrationIdRef.current = createRegistrationId();
  }

  useEffect(() => {
    const embeddedCdp = window.electronAPI?.embeddedCdp;
    const webview = options.webviewRef.current;
    if (
      !webview ||
      !options.surfaceIdentity.surfaceId ||
      typeof embeddedCdp?.registerSurface !== "function" ||
      typeof embeddedCdp?.unregisterSurface !== "function"
    ) {
      return;
    }
    const sync = () => {
      try {
        const webContentsId = webview.getWebContentsId();
        if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) return;
        const surfaceId = options.surfaceIdentity.surfaceId;
        void embeddedCdp.registerSurface({
          registrationId: registrationIdRef.current,
          ...options.surfaceIdentity,
          ...(options.surfaceIdentityKey?.trim()
            ? { surfaceIdentityKey: options.surfaceIdentityKey.trim() }
            : {}),
          surfaceKind: "service",
          surfaceType: options.surfaceType,
          ...(options.serviceId ? { serviceId: options.serviceId } : {}),
          pageRoute: options.pageRoute,
          label: options.label,
          url: options.url,
          active: options.active !== false,
          tabs: [{
            tabId: surfaceId,
            currentUrl: webview.getURL() || options.url,
            title: webview.getTitle() || options.label,
            webContentsId,
            canGoBack: webview.canGoBack(),
            canGoForward: webview.canGoForward(),
            isLoading: webview.isLoading(),
          }],
          activeTabId: surfaceId,
        }).catch(() => undefined);
      } catch {
        // A guest can be replaced between a DOM event and registration.
      }
    };
    const events = [
      "dom-ready",
      "did-navigate",
      "did-navigate-in-page",
      "did-start-loading",
      "did-stop-loading",
    ];
    for (const eventName of events) webview.addEventListener(eventName, sync);
    sync();
    const registrationId = registrationIdRef.current;
    return () => {
      for (const eventName of events) webview.removeEventListener(eventName, sync);
      void embeddedCdp.unregisterSurface({
        registrationId,
        surfaceId: options.surfaceIdentity.surfaceId,
      }).catch(() => undefined);
    };
  }, [
    options.active,
    options.label,
    options.pageRoute,
    options.refreshKey,
    options.serviceId,
    options.surfaceIdentity.interaction,
    options.surfaceIdentity.ownerChatId,
    options.surfaceIdentity.parentSurfaceId,
    options.surfaceIdentity.surfaceId,
    options.surfaceIdentity.surfaceLevel,
    options.surfaceIdentity.surfaceRole,
    options.surfaceIdentityKey,
    options.surfaceType,
    options.url,
    options.webviewRef,
  ]);
}
