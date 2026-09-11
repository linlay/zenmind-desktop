import type { WebContents } from "electron";
import type { BrowserSurfaceRegistry } from "../browser-surface-registry";
import type { RegisteredWebviewSurfaceTarget } from "../browser-surface-registry.shared";

const issuedScopes = new WeakSet<object>();
const throttleLeases = new WeakMap<WebContents, { count: number; previous: boolean }>();

function scopeError(message: string) {
  return Object.assign(new Error(message), { code: "site_control_unavailable" });
}

function acquireThrottleLease(contents: WebContents) {
  const current = throttleLeases.get(contents);
  if (current) {
    current.count += 1;
  } else {
    const previous = contents.getBackgroundThrottling();
    contents.setBackgroundThrottling(false);
    throttleLeases.set(contents, { count: 1, previous });
  }
  return () => {
    const lease = throttleLeases.get(contents);
    if (!lease || --lease.count > 0) return;
    throttleLeases.delete(contents);
    if (!contents.isDestroyed()) {
      try { contents.setBackgroundThrottling(lease.previous); } catch { /* Guest is closing. */ }
    }
  };
}

/** Main-only capability. JSON input cannot reproduce membership in issuedScopes. */
class SiteCdpScope {
  private enabled = false;
  private revoked = "";
  private unsubscribe: (() => unknown) | null = null;
  private readonly guests = new Map<number, () => void>();
  private readonly failedGuests = new Set<number>();

  constructor(
    private readonly registry: BrowserSurfaceRegistry,
    readonly surfaceId: string,
    readonly registrationId: string,
    readonly ownerWebContentsId: number,
    private readonly kind: "website" | "webapp",
    private readonly initialGuestId: number,
  ) {
    issuedScopes.add(this);
    this.unsubscribe = registry.subscribeLifecycle((event) => {
      if (event.surface.surfaceId !== surfaceId) return;
      if (event.type === "unregistered" || event.surface.registrationId !== registrationId) {
        this.release("The application page instance was closed or replaced.");
      } else if (this.enabled) {
        try { this.readSurface(); } catch { /* readSurface revokes invalid scopes. */ }
      }
    });
  }

  activate() {
    if (this.revoked) return;
    this.enabled = true;
    try { this.readSurface(); } catch { /* Retain a revoked capability; never fall back to the foreground. */ }
  }

  release(reason = "The page control Run has ended.") {
    if (this.revoked) return;
    this.revoked = reason;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const dispose of this.guests.values()) dispose();
    this.guests.clear();
  }

  readSurface() {
    if (this.revoked || !this.enabled) throw scopeError(this.revoked || "The page control Run is not accepted yet.");
    const snapshot = this.registry.getRegisteredSurfaceSnapshot(this.surfaceId, this.registrationId, this.ownerWebContentsId);
    const tabs = snapshot?.tabs.filter((tab) => !this.failedGuests.has(tab.webContentsId)) ?? [];
    if (!snapshot || snapshot.registered.surfaceKind !== this.kind || !tabs.length ||
      (this.kind === "webapp" && (tabs.length !== 1 || tabs[0].webContentsId !== this.initialGuestId))) {
      this.release("The application page instance was closed or replaced.");
      throw scopeError(this.revoked);
    }
    const liveIds = new Set(tabs.map((tab) => tab.webContentsId));
    for (const [id, dispose] of this.guests) {
      if (!liveIds.has(id)) { dispose(); this.guests.delete(id); }
    }
    try {
      for (const tab of tabs) {
        if (this.guests.has(tab.webContentsId)) continue;
        const contents = this.registry.findWebContentsById(tab.webContentsId);
        if (!contents || contents.isDestroyed()) throw scopeError("The application tab is unavailable.");
        const restore = acquireThrottleLease(contents);
        const onGone = () => {
          this.failedGuests.add(contents.id);
          try { this.readSurface(); } catch { /* Last guest removal revokes this scope. */ }
        };
        contents.once("destroyed", onGone);
        contents.once("render-process-gone", onGone);
        this.guests.set(contents.id, () => {
          contents.off("destroyed", onGone);
          contents.off("render-process-gone", onGone);
          restore();
        });
      }
    } catch (error) {
      this.release("The application guest could not acquire background control.");
      throw error;
    }
    const registered = snapshot.registered;
    const activeTab = tabs.find((tab) => tab.tabId === registered.activeTabId);
    return {
      ...registered,
      surfaceKind: this.kind,
      id: this.surfaceId,
      targetGeneration: this.registrationId,
      open: true,
      tabs,
      activeTabId: activeTab?.tabId ?? null,
      currentUrl: activeTab?.currentUrl,
      title: activeTab?.title,
      webContentsId: activeTab?.webContentsId,
    };
  }

  validateTab(tab: { tabId: string; webContentsId: number }) {
    if (!this.readSurface().tabs?.some((candidate) => candidate.tabId === tab.tabId && candidate.webContentsId === tab.webContentsId)) {
      throw Object.assign(new Error("The application tab is closed or unavailable."), { code: "target_not_found" });
    }
  }
}

export type { SiteCdpScope };

export function requireSiteCdpScope(scope: SiteCdpScope) {
  if (!scope || !issuedScopes.has(scope)) throw scopeError("Invalid internal page control capability.");
  return scope;
}

export function captureCopilotSiteCdpScope(registry: BrowserSurfaceRegistry, dock: RegisteredWebviewSurfaceTarget): SiteCdpScope | undefined {
  if (dock.surfaceRole !== "copilot-dock" || !dock.active || !dock.parentSurfaceId) return;
  const parent = registry.listRegisteredSurfaces().find((surface) => surface.surfaceId === dock.parentSurfaceId);
  if (!parent) throw scopeError("Copilot parent page is no longer registered.");
  if (parent.surfaceKind !== "website" && parent.surfaceKind !== "webapp") return;
  const snapshot = registry.getRegisteredSurfaceSnapshot(parent.surfaceId, parent.targetGeneration || "", dock.ownerWebContentsId);
  if (!snapshot || !parent.active || !snapshot.registered.active ||
    snapshot.registered.surfaceIdentityKey !== dock.surfaceIdentityKey || !snapshot.tabs.length) {
    throw scopeError("Copilot context does not match the current application page.");
  }
  return new SiteCdpScope(registry, parent.surfaceId, snapshot.registered.registrationId,
    dock.ownerWebContentsId, parent.surfaceKind, snapshot.tabs[0].webContentsId);
}
