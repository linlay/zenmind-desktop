import type { WebContents } from "electron";
import { installAwcpAddon } from "./page-runtime";
import { qiuerForumRule } from "./qiuer-forum";

/** Reviewed, bundled rules; remote pages cannot supply scripts or widen matches. */
export const AWCP_ADDON_RULES = [qiuerForumRule] as const;

export function matchAwcpAddon(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password) return null;
    return AWCP_ADDON_RULES.find((rule) => url.origin === rule.origin &&
      (url.pathname === rule.pathPrefix || url.pathname.startsWith(rule.pathPrefix + "/"))) ?? null;
  } catch { return null; }
}

export function buildAwcpAddonScript(url: string, enabled = true) {
  return `(${installAwcpAddon.toString()})(${JSON.stringify(enabled ? matchAwcpAddon(url) : null)},${JSON.stringify(url)})`;
}

export async function ensureAwcpAddon(guest: Pick<WebContents, "getURL" | "executeJavaScript" | "isDestroyed">) {
  if (guest.isDestroyed()) return;
  const url = guest.getURL();
  if (!matchAwcpAddon(url)) return;
  await guest.executeJavaScript(buildAwcpAddonScript(url));
}

/** Registration and navigation share one listener set per guest, including background tabs. */
export class AwcpAddonInjection {
  private readonly guests = new Map<number, { guest: WebContents; installed(): boolean; dispose(): void }>();

  attach(guest: WebContents) {
    if (this.guests.has(guest.id) || guest.isDestroyed()) return;
    let installed = false;
    const inject = () => {
      if (guest.isDestroyed()) return;
      const url = guest.getURL();
      if (!matchAwcpAddon(url) && !installed) return;
      installed = !!matchAwcpAddon(url);
      // Chromium main-world execution and same-origin Cookie semantics are identical
      // on macOS and Windows; no filesystem/preload path or platform API is injected.
      void guest.executeJavaScript(buildAwcpAddonScript(url)).catch(() => {
        // Navigation can destroy the execution context; the next dom-ready retries.
        // Explicit AWCP requests still surface protocol/transport failures.
      });
    };
    const inPage = (_event: unknown, _url: string, mainFrame: boolean) => { if (mainFrame) inject(); };
    const destroyed = () => this.detach(guest.id);
    this.guests.set(guest.id, { guest, installed: () => installed, dispose: () => {
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
    if (entry.installed() && !entry.guest.isDestroyed()) void entry.guest.executeJavaScript(buildAwcpAddonScript(entry.guest.getURL(), false)).catch(() => undefined);
  }
}
