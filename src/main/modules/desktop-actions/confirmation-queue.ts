import type { BrowserWindow } from "electron";
import type { DesktopActionConfirmationRequest, DesktopActionConfirmationResponse, DesktopActionConfirmationEndReason } from "../../../shared/contracts/copilot";
import { normalizeConfirmationTimeoutSeconds } from "../../../shared/desktop-action-confirmation";
import { requireEpochMillis } from "../../../shared/time-contract";

export type PendingConfirmation = {
  resolve: (response: DesktopActionConfirmationResponse) => void;
  timeout: ReturnType<typeof setTimeout>;
  accept?: (response: DesktopActionConfirmationResponse, senderId: number) => boolean;
};
const queues = new WeakMap<Map<string, PendingConfirmation>, Map<string, () => void>>();

type WindowWatch = { available: boolean; listeners: Set<() => void>; cleanup: () => void };
const windowWatches = new WeakMap<BrowserWindow, WindowWatch>();

function watchWindow(window: BrowserWindow, listener: () => void) {
  let state = windowWatches.get(window);
  if (!state) {
    const invalidate = () => {
      state!.available = false;
      for (const notify of [...state!.listeners]) notify();
    };
    state = { available: true, listeners: new Set(), cleanup: () => {
      window.removeListener("closed", invalidate);
      window.webContents.removeListener("destroyed", invalidate);
      window.webContents.removeListener("render-process-gone", invalidate);
      window.webContents.removeListener("did-start-loading", invalidate);
      windowWatches.delete(window);
    } };
    windowWatches.set(window, state);
    window.once("closed", invalidate);
    window.webContents.once("destroyed", invalidate);
    window.webContents.once("render-process-gone", invalidate);
    window.webContents.once("did-start-loading", invalidate);
  }
  const watch = state;
  watch.listeners.add(listener);
  return { available: () => watch.available, release: () => {
    watch.listeners.delete(listener);
    if (watch.listeners.size === 0) watch.cleanup();
  } };
}

// Main owns ordering, expiry and completion. Every request starts its clock on arrival.
export function callDesktopActionConfirmation(request: DesktopActionConfirmationRequest, options: {
  getMainWindow: () => BrowserWindow | null;
  pendingRequests: Map<string, PendingConfirmation>;
  timeoutMs?: number;
  deadlineAt?: number;
  signal?: AbortSignal;
}): Promise<DesktopActionConfirmationResponse> {
  const { pendingRequests, signal } = options;
  const window = options.getMainWindow();
  const ended = (reason: DesktopActionConfirmationEndReason): DesktopActionConfirmationResponse => ({ requestId: request.requestId, decision: "cancel", reason });
  if (signal?.aborted) return Promise.resolve(ended("aborted"));
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return Promise.resolve(ended("unavailable"));
  if (pendingRequests.has(request.requestId)) return Promise.resolve(ended("unavailable"));
  const timeoutMs = options.timeoutMs === undefined ? normalizeConfirmationTimeoutSeconds(undefined) * 1000
    : Math.min(600_000, Math.max(1, options.timeoutMs));
  // Leave time to dispatch the action and return its result before the tool deadline.
  const expiresAt = requireEpochMillis(Math.max(0, Math.min(Date.now() + timeoutMs, options.deadlineAt === undefined ? Infinity : options.deadlineAt - 1000)), "confirmation.expiresAt");
  if (expiresAt <= Date.now()) return Promise.resolve(ended("timeout"));
  let queue = queues.get(pendingRequests);
  if (!queue) { queue = new Map(); queues.set(pendingRequests, queue); }
  const activeQueue = queue;
  return new Promise((resolve) => {
    let done = false;
    let shown = false;
    const finish = (response: DesktopActionConfirmationResponse) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      watch.release();
      pendingRequests.delete(request.requestId);
      activeQueue.delete(request.requestId);
      if (shown && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        try { window.webContents.send("desktopActions.confirmationClosed", request.requestId); } catch { /* Window closed concurrently. */ }
      }
      resolve(response);
      activeQueue.values().next().value?.();
    };
    const abort = () => finish(ended("aborted"));
    const unavailable = () => finish(ended("unavailable"));
    const show = () => {
      if (done || shown) return;
      if (signal?.aborted) return abort();
      if (Date.now() >= expiresAt) return finish(ended("timeout"));
      if (!watch.available() || window.isDestroyed() || window.webContents.isDestroyed()) return unavailable();
      shown = true;
      try { window.webContents.send("desktopActions.confirm", { ...request, expiresAt }); } catch { unavailable(); }
    };
    const watch = watchWindow(window, unavailable);
    const timeout = setTimeout(() => finish(ended("timeout")), Math.max(1, expiresAt - Date.now()));
    pendingRequests.set(request.requestId, {
      timeout,
      resolve: finish,
      accept(response, senderId) {
        if (done || !shown || senderId !== window.webContents.id || !request.buttons.some(button => button.decision === response.decision)) return false;
        if (signal?.aborted) { abort(); return false; }
        if (Date.now() >= expiresAt) { finish(ended("timeout")); return false; }
        // System end reasons are never accepted from renderer input.
        finish({ requestId: request.requestId, decision: response.decision });
        return true;
      }
    });
    activeQueue.set(request.requestId, show);
    signal?.addEventListener("abort", abort, { once: true });
    activeQueue.values().next().value?.();
  });
}
