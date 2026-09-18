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
class SiteControlScope {
  private enabled = false;
  private revoked = "";
  private unsubscribe: (() => unknown) | null = null;
  private readonly guests = new Map<number, () => void>();
  private readonly failedGuests = new Set<number>();
  private readonly releaseListeners = new Set<(reason: string) => void>();

  constructor(
    private readonly registry: BrowserSurfaceRegistry,
    readonly containerId: string,
    readonly registrationId: string,
    readonly ownerWebContentsId: number,
    private readonly kind: "website" | "webapp" | "chat-work-panel",
    private readonly initialGuestId: number,
  ) {
    issuedScopes.add(this);
    this.unsubscribe = registry.subscribeLifecycle((event) => {
      if (event.surface.surfaceId !== containerId) return;
      if (event.type === "unregistered" || event.surface.registrationId !== registrationId) {
        this.release("The application page instance was closed or replaced.");
      } else if (this.enabled) {
        try { this.readContainer(); } catch { /* readContainer revokes invalid scopes. */ }
      }
    });
  }

  activate() {
    if (this.revoked) return;
    this.enabled = true;
    try { this.readContainer(); } catch { /* Retain a revoked capability; never fall back to the foreground. */ }
  }

  release(reason = "The page control Run has ended.") {
    if (this.revoked) return;
    this.revoked = reason;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const dispose of this.guests.values()) dispose();
    this.guests.clear();
    for (const listener of [...this.releaseListeners]) {
      try { listener(reason); } catch { /* Capability cleanup must not be interrupted by observers. */ }
    }
    this.releaseListeners.clear();
  }

  onRelease(listener: (reason: string) => void) {
    if (this.revoked) {
      listener(this.revoked);
      return () => undefined;
    }
    this.releaseListeners.add(listener);
    return () => this.releaseListeners.delete(listener);
  }

  readContainer() {
    if (this.revoked || !this.enabled) throw scopeError(this.revoked || "The page control Run is not accepted yet.");
    const snapshot = this.registry.getRegisteredSurfaceSnapshot(this.containerId, this.registrationId, this.ownerWebContentsId);
    const tabs = snapshot?.tabs.filter((tab) => !this.failedGuests.has(tab.webContentsId)) ?? [];
    if (!snapshot || snapshot.registered.surfaceKind !== this.kind || !tabs.length ||
      (this.kind !== "website" && (tabs.length !== 1 || tabs[0].webContentsId !== this.initialGuestId))) {
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
          try { this.readContainer(); } catch { /* Last guest removal revokes this scope. */ }
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
      id: this.containerId,
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
    if (!this.readContainer().tabs?.some((candidate) => candidate.tabId === tab.tabId && candidate.webContentsId === tab.webContentsId)) {
      throw Object.assign(new Error("The application tab is closed or unavailable."), { code: "target_not_found" });
    }
  }
}

export type { SiteControlScope };

export function requireSiteControlScope(scope: SiteControlScope) {
  if (!scope || !issuedScopes.has(scope)) throw scopeError("Invalid internal page control capability.");
  return scope;
}

export function captureCopilotSiteControlScope(registry: BrowserSurfaceRegistry, dock: RegisteredWebviewSurfaceTarget): SiteControlScope | undefined {
  if (dock.surfaceRole !== "copilot-dock" || !dock.active || !dock.parentSurfaceId) return;
  const parent = registry.listRegisteredSurfaces().find((surface) => surface.surfaceId === dock.parentSurfaceId);
  if (!parent) throw scopeError("Copilot parent page is no longer registered.");
  if (parent.surfaceKind !== "website" && parent.surfaceKind !== "webapp") return;
  const snapshot = registry.getRegisteredSurfaceSnapshot(parent.surfaceId, parent.targetGeneration || "", dock.ownerWebContentsId);
  if (!snapshot || !parent.active || !snapshot.registered.active ||
    snapshot.registered.surfaceIdentityKey !== dock.surfaceIdentityKey || !snapshot.tabs.length) {
    throw scopeError("Copilot context does not match the current application page.");
  }
  return new SiteControlScope(registry, parent.surfaceId, snapshot.registered.registrationId,
    dock.ownerWebContentsId, parent.surfaceKind, snapshot.tabs[0].webContentsId);
}

/** Short-lived execution lease, issued only after owner Chat authorization. */
export function acquireWorkPanelControlScope(registry: BrowserSurfaceRegistry, containerId: string, chatId: string) {
  const container = registry.listWorkPanelContainers().find((entry) => entry.id === containerId);
  if (!container || container.ownerChatId !== chatId || container.surfaceRole !== "workpanel-web" || !/^https?:/u.test(container.url)) {
    throw scopeError("The page does not belong to the calling Chat.");
  }
  const tab = container.tabs[0];
  const guest = tab && registry.resolveWebviewSurfaceTarget(tab.webContentsId);
  if (!guest) throw scopeError("The page is unavailable.");
  const scope = new SiteControlScope(registry, container.id, container.targetGeneration || "", guest.ownerWebContentsId, "chat-work-panel", tab.webContentsId);
  scope.activate();
  return scope;
}
