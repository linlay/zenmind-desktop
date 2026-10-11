import type { WebContents } from "electron";
import { disableLocalDocumentNetworkTransports } from "../../../shared/local-document-network-policy";

// These transports do not all pass through Electron webRequest. Install in
// every new realm before document code runs, including synchronous about:blank.
export const LOCAL_DOCUMENT_NETWORK_GUARD_SOURCE = `(${disableLocalDocumentNetworkTransports.toString()})()`;

export type LocalDocumentNetworkGuard = { ready: Promise<void>; dispose(): void };

/** Private protection only; the document never receives a debugger or IPC API. */
export function createLocalDocumentNetworkGuard(contents: WebContents): LocalDocumentNetworkGuard {
  const debug = contents.debugger;
  const children = new Set<string>();
  let disposed = false;
  let rejectReady!: (error: Error) => void;
  const failed = new Promise<void>((_resolve, reject) => { rejectReady = reject; });
  const unavailable = () => new Error("Local document network protection is unavailable.");
  const close = () => {
    if (disposed) return;
    rejectReady(unavailable());
    if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
  };
  const alive = () => !disposed && !contents.isDestroyed() && debug.isAttached();
  const send = async (method: string, params: Record<string, unknown>, sessionId?: string) => {
    if (!alive()) throw unavailable();
    const result = await debug.sendCommand(method, params, sessionId);
    if (!alive()) throw unavailable();
    return result;
  };
  const autoAttach = (sessionId?: string) => send("Target.setAutoAttach", {
    autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
    filter: [{ type: "iframe" }, { type: "worker" }, { type: "shared_worker" }, { type: "service_worker" }],
  }, sessionId);
  const protectPage = async (sessionId?: string) => {
    await send("Page.enable", {}, sessionId);
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: LOCAL_DOCUMENT_NETWORK_GUARD_SOURCE, runImmediately: true,
    }, sessionId);
  };
  const onMessage = (_event: Electron.Event, method: string, params: Record<string, any>) => {
    if (method === "Target.detachedFromTarget") {
      children.delete(params.sessionId);
      return;
    }
    if (method !== "Target.attachedToTarget" || typeof params.sessionId !== "string") return;
    const id = params.sessionId;
    const type = params.targetInfo?.type;
    children.add(id);
    void (async () => {
      if (type === "iframe") await protectPage(id);
      else {
        await send("Runtime.enable", {}, id);
        const result = await send("Runtime.evaluate", { expression: LOCAL_DOCUMENT_NETWORK_GUARD_SOURCE }, id);
        if (result.exceptionDetails) throw unavailable();
      }
      await autoAttach(id);
      if (children.has(id)) await send("Runtime.runIfWaitingForDebugger", {}, id);
    })().catch(error => {
      // A child removed while its initialization was paused cannot run code.
      const closedTarget = /(?:session.*not found|target closed|no session with given id)/iu.test(String(error));
      if (children.has(id) && !closedTarget) close();
    });
  };
  const onDetach = () => { if (!disposed) close(); };
  contents.on("preload-error", close);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    rejectReady(unavailable());
    debug.removeListener("message", onMessage);
    debug.removeListener("detach", onDetach);
    contents.removeListener("destroyed", dispose);
    contents.removeListener("preload-error", close);
    children.clear();
    // Keep the native registrations until the guest is destroyed. Detaching
    // while a document is still alive could expose an unprotected new frame.
  };
  const timer = setTimeout(close, 5000);
  const ready = Promise.race([(async () => {
    if (contents.isDestroyed() || debug.isAttached()) throw unavailable();
    debug.attach("1.3");
    debug.on("message", onMessage);
    debug.on("detach", onDetach);
    contents.once("destroyed", dispose);
    await protectPage();
    await autoAttach();
  })(), failed]);
  void ready.then(() => clearTimeout(timer), () => { clearTimeout(timer); close(); });
  return { ready, dispose };
}
