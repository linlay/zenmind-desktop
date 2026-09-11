import type { DesktopCloseShortcutRequest } from "../../shared/contracts/desktop-api";

type CloseShortcutHandler = (request: DesktopCloseShortcutRequest) => boolean;
const handlers = new Set<CloseShortcutHandler>();

export function registerDesktopCloseShortcutHandler(handler: CloseShortcutHandler) {
  handlers.add(handler);
  return () => { handlers.delete(handler); };
}

export function dispatchDesktopCloseShortcut(request: DesktopCloseShortcutRequest) {
  for (const handler of handlers) {
    // Handling includes a rejected/guarded close: never close another layer afterward.
    if (handler(request)) return;
  }
  if (request.guestId === null && !request.website && request.fallbackToWindowClose) {
    window.electronAPI.desktopShell.requestWindowClose();
  }
}
