const guards = new WeakMap<Document, { count: number; dispose: () => void; capture: () => void; restore: () => void; input: () => void }>();
const backgroundSite = ".is-site-surface.is-inactive-surface, .is-site-surface .external-webview-panel[hidden]";

function focusHostElement(element: HTMLElement) {
  element.focus({ preventScroll: true });
  // Electron's webview host and its inner iframe have distinct DOM focus.
  element.shadowRoot?.querySelector("iframe")?.focus({ preventScroll: true });
}

/** Guest CDP focus must not leave the user's foreground host element behind. */
export function retainForegroundFocusForBackgroundSites(document: Document) {
  const existing = guards.get(document);
  if (existing) {
    existing.count += 1;
  } else {
    let foreground = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let input = false;
    const capture = () => {
      const target = document.activeElement;
      if (target instanceof HTMLElement && !target.closest(backgroundSite)) foreground = target;
    };
    const restore = () => {
      input = false;
      const target = document.activeElement;
      if (!(target instanceof HTMLElement) || !target.closest(backgroundSite)) return;
      if (foreground?.isConnected && foreground !== target && !foreground.closest(backgroundSite)) {
        focusHostElement(foreground);
      } else target.blur();
    };
    const onFocus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (input) return;
      const hiddenSite = target.closest(backgroundSite);
      if (!hiddenSite) {
        foreground = target;
      } else if (foreground?.isConnected && foreground !== target && !foreground.closest(backgroundSite)) {
        focusHostElement(foreground);
      } else {
        target.blur();
      }
    };
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("focus", onFocus, true);
    guards.set(document, { count: 1, capture, restore, input: () => { input = true; }, dispose: () => {
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("focus", onFocus, true);
    } });
  }
  return () => {
    const guard = guards.get(document);
    if (guard && --guard.count === 0) { guard.dispose(); guards.delete(document); }
  };
}

export function controlBackgroundSiteFocus(phase: "capture" | "restore" | "input", document: Document) {
  guards.get(document)?.[phase]();
  const active = document.activeElement;
  if (phase === "restore" && active instanceof HTMLElement && !active.closest(backgroundSite) && active.tagName === "WEBVIEW") {
    focusHostElement(active);
    try { return { webContentsId: (active as Electron.WebviewTag).getWebContentsId() }; }
    catch { /* The foreground guest was closed during the command. */ }
  }
  return {};
}
