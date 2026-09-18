import type { WebContents } from "electron";
import type { SiteControlScope } from "../cdp/site-scope";

type Binding<T> = {
  guest: WebContents;
  revision: string;
  changed: boolean;
  contract?: T;
  dispose(): void;
};

// Main-owned, Run-scope-local contract. Page-provided revision never serves as
// guest identity; a page change releases descriptors and compiled validators.
export class AwcpDiscoveryBindings<T> {
  private readonly bindings = new Map<SiteControlScope, Binding<T>>();

  remember(scope: SiteControlScope, guest: WebContents, revision: string, contract: T) {
    scope.readContainer();
    this.clear(scope);
    const binding: Binding<T> = { guest, revision, contract, changed: false, dispose: () => undefined };
    const changed = () => { binding.changed = true; binding.contract = undefined; };
    const navigating = (...args: unknown[]) => { if (args[3] === true) changed(); };
    const inPage = (...args: unknown[]) => { if (args[2] === true) changed(); };
    guest.on("did-start-navigation", navigating);
    guest.on("did-navigate-in-page", inPage);
    guest.once("destroyed", changed);
    guest.once("render-process-gone", changed);
    this.bindings.set(scope, binding);
    const unsubscribe = scope.onRelease(() => this.clear(scope));
    binding.dispose = () => {
      unsubscribe();
      guest.off("did-start-navigation", navigating);
      guest.off("did-navigate-in-page", inPage);
      guest.off("destroyed", changed);
      guest.off("render-process-gone", changed);
    };
  }

  rejection(scope: SiteControlScope, guest: WebContents, revision: string) {
    const binding = this.bindings.get(scope);
    if (!binding) return "discovery_required";
    if (binding.changed || binding.guest !== guest || binding.guest.isDestroyed()) return "page_changed";
    if (binding.revision !== revision) return "stale_snapshot";
    return null;
  }

  contract(scope: SiteControlScope): T | undefined {
    return this.bindings.get(scope)?.contract;
  }

  clear(scope: SiteControlScope) {
    const binding = this.bindings.get(scope);
    this.bindings.delete(scope);
    binding?.dispose();
  }

  dispose() {
    for (const scope of this.bindings.keys()) this.clear(scope);
  }
}
