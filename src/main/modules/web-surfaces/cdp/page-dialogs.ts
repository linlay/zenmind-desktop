import { randomUUID } from "node:crypto";
import type { IpcMain, IpcMainEvent, WebContents } from "electron";
import { WORK_PANEL_PAGE_DIALOG_CHANNEL, type WorkPanelPageDialogReply, type WorkPanelPageDialogType } from "../../../../shared/work-panel-page-dialog";
import type { SiteControlScope } from "./site-scope";

type Port = Pick<IpcMain, "on">;
type Router = { ready: WeakSet<WebContents>; watched: WeakSet<WebContents>; handle?: (event: IpcMainEvent, request: unknown) => void };
const routers = new WeakMap<Port, Router>();

/** The fallback lives for the IPC port lifetime, so a stopped gateway cannot strand manual sendSync. */
export function ensureWorkPanelPageDialogIpc(port: Port) {
  let router = routers.get(port);
  if (!router) {
    router = { ready: new WeakSet(), watched: new WeakSet() }; routers.set(port, router);
    const current = router;
    port.on(WORK_PANEL_PAGE_DIALOG_CHANNEL, (event, request) => {
      if (request?.op === "ready") {
        const contents = event.sender;
        try {
          if (event.senderFrame === contents.mainFrame && /^https?:/u.test(contents.mainFrame.url)) {
            current.ready.add(contents);
            if (!current.watched.has(contents)) {
              current.watched.add(contents);
              // A download or a rejected navigation does not replace the preload document.
              contents.on("did-navigate", () => current.ready.delete(contents));
            }
          }
        } catch { /* The sender frame was destroyed. */ }
        return;
      }
      if (current.handle) current.handle(event, request);
      else event.returnValue = { handled: false } satisfies WorkPanelPageDialogReply;
    });
  }
  return router;
}

type Pending = { id: string; type: WorkPanelPageDialogType; defaultValue: string; event: IpcMainEvent; timer: ReturnType<typeof setTimeout> };
type Transaction = {
  contents: WebContents; scope: SiteControlScope; signal?: AbortSignal; pending?: Pending;
  commands: number; ended: boolean; cancelled: boolean; cleanup(): void;
};
export type WorkPanelDialogInput = { track(work: Promise<unknown>): void; end(): void };

/** Owns synchronous page waits only while a Main-issued input transaction is actually in flight. */
export class WorkPanelPageDialogs {
  private readonly inputs = new Map<WebContents, Transaction>();
  private readonly router: Router;
  private readonly receive: NonNullable<Router["handle"]>;

  constructor(port: Port, private readonly callbacks: {
    opened(contents: WebContents, id: string, type: WorkPanelPageDialogType, message: string): void;
    closed(contents: WebContents, id: string, accepted: boolean, reason: "agent" | "cancelled"): void;
  }, private readonly timeoutMs = 120_000) {
    this.router = ensureWorkPanelPageDialogIpc(port);
    this.receive = (event, request) => this.onRequest(event, request);
    this.router.handle = this.receive;
  }

  begin(contents: WebContents, scope: SiteControlScope, tab: { tabId: string; webContentsId: number }, signal?: AbortSignal, ownsScope = false): WorkPanelDialogInput {
    if (!this.router.ready.has(contents)) throw Object.assign(new Error("This WorkPanel page needs its fixed dialog preload. Open or reload the task page before operating it."), { code: "workpanel_dialog_bridge_required" });
    if (this.inputs.has(contents)) throw Object.assign(new Error("An earlier page input is still finishing."), { code: "browser_input_pending" });
    scope.validateTab(tab);
    const abort = () => this.cancel(contents);
    let unsubscribeScope = () => {};
    const navigation = (_event: unknown, _url: unknown, _inPage: unknown, mainFrame: boolean) => { if (mainFrame) this.cancel(contents); };
    const gone = () => this.cancel(contents, true);
    const transaction: Transaction = {
      contents, scope, signal, commands: 0, ended: false, cancelled: false,
      cleanup: () => {
        if (this.inputs.get(contents) !== transaction) return;
        this.inputs.delete(contents);
        signal?.removeEventListener("abort", abort);
        unsubscribeScope();
        contents.off("did-start-navigation", navigation); contents.off("destroyed", gone); contents.off("render-process-gone", gone);
        if (ownsScope) scope.release();
      },
    };
    this.inputs.set(contents, transaction);
    unsubscribeScope = scope.onRelease(() => this.cancel(contents));
    signal?.addEventListener("abort", abort, { once: true });
    contents.on("did-start-navigation", navigation); contents.once("destroyed", gone); contents.once("render-process-gone", gone);
    if (signal?.aborted) this.cancel(contents);
    return {
      track: work => {
        transaction.commands++;
        const settled = () => { transaction.commands--; this.finish(transaction); };
        void work.then(settled, settled);
      },
      end: () => { transaction.ended = true; this.finish(transaction); },
    };
  }

  retains(scope: SiteControlScope) { return [...this.inputs.values()].some(input => input.scope === scope); }

  handle(contents: WebContents, id: string, accept: boolean, promptText?: string): boolean {
    const transaction = this.inputs.get(contents), pending = transaction?.pending;
    if (!transaction || pending?.id !== id) return false;
    try {
      if (transaction.cancelled || transaction.signal?.aborted) throw new Error("cancelled");
      transaction.scope.readContainer();
    } catch {
      this.cancel(contents);
      throw Object.assign(new Error("The input transaction was cancelled; its dialog was dismissed."), { code: "dialog_cancelled" });
    }
    this.answer(transaction, accept, promptText, "agent");
    return true;
  }

  cancel(contents: WebContents, destroyed = false) {
    const transaction = this.inputs.get(contents);
    if (!transaction) return;
    transaction.cancelled = true;
    this.answer(transaction, false, undefined, "cancelled");
    if (destroyed) transaction.cleanup(); else this.finish(transaction);
  }

  dispose() {
    for (const transaction of [...this.inputs.values()]) { this.cancel(transaction.contents, true); }
    if (this.router.handle === this.receive) this.router.handle = undefined;
  }

  private finish(transaction: Transaction) {
    if (transaction.ended && !transaction.commands && !transaction.pending) transaction.cleanup();
  }

  private answer(transaction: Transaction, accepted: boolean, promptText: string | undefined, reason: "agent" | "cancelled") {
    const pending = transaction.pending;
    if (!pending) return;
    transaction.pending = undefined; clearTimeout(pending.timer);
    const reply: WorkPanelPageDialogReply = { handled: true, accepted,
      ...(pending.type === "prompt" && accepted ? { promptText: promptText ?? pending.defaultValue } : {}),
      ...(reason === "cancelled" ? { cancelled: true } : {}),
    };
    try { pending.event.returnValue = reply; } catch { /* A destroyed renderer no longer has a synchronous waiter. */ }
    this.callbacks.closed(transaction.contents, pending.id, accepted, reason);
    this.finish(transaction);
  }

  private onRequest(event: IpcMainEvent, request: unknown) {
    const value = request && typeof request === "object" ? request as Record<string, unknown> : {};
    const contents = event.sender;
    let trustedFrame = false;
    try { trustedFrame = event.senderFrame === contents.mainFrame && /^https?:/u.test(contents.mainFrame.url); } catch { /* The frame was replaced. */ }
    const transaction = this.inputs.get(contents);
    if (!transaction) { event.returnValue = { handled: false } satisfies WorkPanelPageDialogReply; return; }
    const dismiss = () => { event.returnValue = { handled: true, accepted: false, cancelled: true } satisfies WorkPanelPageDialogReply; };
    let valid = trustedFrame && !transaction.cancelled && !transaction.signal?.aborted && !contents.isDestroyed();
    try { transaction.scope.readContainer(); } catch { valid = false; }
    if (!valid || value.op !== "dialog" || typeof value.type !== "string" || !["alert", "confirm", "prompt"].includes(value.type) || typeof value.message !== "string" || value.message.length > 16_384 ||
      (value.defaultValue !== undefined && (typeof value.defaultValue !== "string" || value.defaultValue.length > 4096)) || transaction.pending) { dismiss(); return; }
    const id = randomUUID(), type = value.type as WorkPanelPageDialogType;
    const timer = setTimeout(() => this.cancel(contents), this.timeoutMs); timer.unref?.();
    transaction.pending = { id, type, defaultValue: String(value.defaultValue ?? ""), event, timer };
    this.callbacks.opened(contents, id, type, value.message.slice(0, 1000));
  }
}
