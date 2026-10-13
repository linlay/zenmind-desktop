import type { WebContents } from "electron";
import type { WebsiteBridgePackage } from "../../website-bridges/storage";
import { buildWebsiteBridgeScript, selectWebsiteBridgePage } from "../../website-bridges/injection-script";

/** Registration and navigation share one listener set per guest, including background tabs. */
export class AwcpAddonInjection {
  constructor(private readonly readPackages: () => WebsiteBridgePackage[]) {}
  private script(url: string, enabled = true) {
    return buildWebsiteBridgeScript(url, enabled ? this.readPackages() : []);
  }
  private matches(url: string) {
    return !!selectWebsiteBridgePage(url, this.readPackages());
  }
  async ensure(guest: WebContents) {
    if (!guest.isDestroyed() && (this.matches(guest.getURL()) || this.guests.get(guest.id)?.installed())) await guest.executeJavaScript(this.script(guest.getURL()));
  }
  refresh() {
    for (const entry of this.guests.values()) entry.inject();
  }
  private readonly guests = new Map<number, { guest: WebContents; installed(): boolean; inject(): void; dispose(): void }>();

  attach(guest: WebContents) {
    if (this.guests.has(guest.id) || guest.isDestroyed()) return;
    let installed = false;
    const inject = () => {
      if (guest.isDestroyed()) return;
      const url = guest.getURL();
      if (!this.matches(url) && !installed) return;
      installed = this.matches(url);
      // Chromium main-world execution and same-origin Cookie semantics are identical
      // on macOS and Windows; no filesystem/preload path or platform API is injected.
      void guest.executeJavaScript(this.script(url)).catch(() => {
        // Navigation can destroy the execution context; the next dom-ready retries.
        // Explicit AWCP requests still surface protocol/transport failures.
      });
    };
    const inPage = (_event: unknown, _url: string, mainFrame: boolean) => { if (mainFrame) inject(); };
    const destroyed = () => this.detach(guest.id);
    this.guests.set(guest.id, { guest, inject, installed: () => installed, dispose: () => {
      guest.off("dom-ready", inject);
      guest.off("did-navigate-in-page", inPage);
      guest.off("destroyed", destroyed);
    } });
    guest.on("dom-ready", inject);
    guest.on("did-navigate-in-page", inPage);
    guest.once("destroyed", destroyed);
    inject();
  }

  detach(id: number) {
    const entry = this.guests.get(id);
    if (!entry) return;
    this.guests.delete(id);
    entry.dispose();
    if (entry.installed() && !entry.guest.isDestroyed()) void entry.guest.executeJavaScript(this.script(entry.guest.getURL(), false)).catch(() => undefined);
  }
}
