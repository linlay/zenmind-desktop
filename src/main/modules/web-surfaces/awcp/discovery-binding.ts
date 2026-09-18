import type { WebContents } from "electron";
import type { SiteControlScope } from "../cdp/site-scope";

type Binding = {
  guest: WebContents;
  revision: string;
  changed: boolean;
  indexActions: ReadonlySet<string>;
  readSections: Set<string>;
  dispose(): void;
};

// Main-owned, Run-scope-local manual binding. A page revision never replaces
// exact guest identity, and only explicitly read sections become callable.
export class AwcpManualBindings {
  private readonly bindings = new Map<SiteControlScope, Binding>();

  rememberIndex(scope: SiteControlScope, guest: WebContents, revision: string, actions: Iterable<string>) {
    this.install(scope, guest, revision, new Set(actions));
  }

  rememberSection(scope: SiteControlScope, guest: WebContents, revision: string, action: string) {
    scope.readContainer();
    const current = this.bindings.get(scope);
    if (current && !current.changed && current.guest === guest && current.revision === revision &&
        current.indexActions.has(action) && !guest.isDestroyed()) {
      current.readSections.add(action);
    }
  }

  private install(
    scope: SiteControlScope,
    guest: WebContents,
    revision: string,
    indexActions: ReadonlySet<string>,
  ) {
    scope.readContainer();
    this.clear(scope);
    const binding: Binding = {
      guest,
      revision,
      changed: false,
      indexActions,
      readSections: new Set(),
      dispose: () => undefined,
    };
    const changed = () => { binding.changed = true; binding.readSections.clear(); };
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
    if (!binding) return "manual_required";
    if (binding.changed || binding.guest !== guest || binding.guest.isDestroyed()) return "page_changed";
    if (binding.revision !== revision) return "stale_revision";
    return null;
  }

  actionKnown(scope: SiteControlScope, action: string): boolean | undefined {
    return this.bindings.get(scope)?.indexActions.has(action);
  }

  sectionRead(scope: SiteControlScope, action: string): boolean {
    return this.bindings.get(scope)?.readSections.has(action) ?? false;
  }

  invalidate(scope: SiteControlScope) {
    this.clear(scope);
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
