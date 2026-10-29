import { randomUUID } from "node:crypto";
import type { App, BrowserWindow, IpcMain, IpcMainInvokeEvent, WebFrameMain } from "electron";
import { MARKET_SHARE_RECEIVER, readMarketShareContext, type MarketShareDelivery } from "../../../shared/market-share";
import type { ShareReceiveResult } from "../../../shared/contracts/shares";
import type { ShareServicePort, ShareReceiverEndpoint } from "../../support/share-ports";
import { getMarketSettings } from "./market-settings";
import { createMarketShare } from "./share-publish";

/** Marketplace owns its page handshake; the public router never knows its route. */
export function registerMarketShareReceiver(options: {
  app: App;
  shares: ShareServicePort;
  ipc: Pick<IpcMain, "handle" | "removeHandler">;
  getMainWindow(): BrowserWindow | null;
  navigate(path: string): void;
}) {
  type Pending = {
    activationId: string;
    generation?: string;
    instanceId?: string;
    frame?: WebFrameMain;
    signal: AbortSignal;
    ready(endpoint: ShareReceiverEndpoint): void;
    close(): void;
    delivery?: { intentId: string; acknowledge(result: ShareReceiveResult): void };
  };
  let pending: Pending | undefined;
  const owner = (event: IpcMainInvokeEvent) => {
    const window = options.getMainWindow();
    const frame = event.senderFrame;
    if (!frame || !window || window.isDestroyed() || window.webContents.isDestroyed() ||
        event.sender !== window.webContents || frame !== window.webContents.mainFrame) throw new Error("Market share sender rejected");
    return { window, frame };
  };
  const current = (operation: Pending) => {
    const window = options.getMainWindow();
    return pending === operation && !operation.signal.aborted && Boolean(window && !window.isDestroyed() &&
      !window.webContents.isDestroyed() && operation.frame === window.webContents.mainFrame &&
      marketShareRoute(operation.frame.url, operation.activationId));
  };
  const unregister = options.shares.registerReceiver({
    receiverId: MARKET_SHARE_RECEIVER, owner: { type: "builtin", id: "marketplace" }, contextVersions: [1],
    activate: ({ signal }) => {
      if (!getMarketSettings(options.app).enabled) return Promise.reject(new Error("Market is disabled"));
      return new Promise((resolve, reject) => {
        pending?.close();
        const operation: Pending = {
          activationId: randomUUID(), signal, ready: resolve,
          close() {
            if (pending === operation) pending = undefined;
            signal.removeEventListener("abort", operation.close);
            operation.delivery?.acknowledge({ status: "unavailable" });
            reject(new Error("Market share page closed"));
          },
        };
        pending = operation;
        signal.addEventListener("abort", operation.close, { once: true });
        try { options.navigate("/market?shareActivation=" + operation.activationId); }
        catch { operation.close(); }
      });
    },
  });

  const channels: string[] = [];
  const handle: IpcMain["handle"] = (channel, listener) => { options.ipc.handle(channel, listener); channels.push(channel); };
  const dispose = () => {
    pending?.close();
    unregister();
    for (const channel of channels) options.ipc.removeHandler(channel);
  };
  try {
    handle("market.shareItem", async (event, input: unknown) => {
      owner(event);
      const frame = event.senderFrame;
      const result = await createMarketShare(options.app, options.shares, input);
      owner(event);
      if (event.senderFrame !== frame) throw new Error("Market share sender changed");
      return result;
    });
    handle("market.shareReady", (event, input: unknown) => {
      const { window, frame } = owner(event);
      const operation = pending;
      if (!operation || !isObject(input) || operation.activationId !== input.activationId ||
          typeof input.instanceId !== "string" || input.instanceId.length !== 36 || !/^[a-f0-9-]+$/u.test(input.instanceId) ||
          !marketShareRoute(frame.url, operation.activationId)) return null;
      if (operation.instanceId && operation.instanceId !== input.instanceId) { operation.close(); return null; }
      if (operation.generation) return current(operation) ? { generation: operation.generation } : null;
      const instanceId = input.instanceId;
      operation.instanceId = instanceId;
      operation.frame = frame;
      operation.generation = randomUUID();
      const generation = operation.generation;
      operation.ready({
        generation,
        isCurrent: () => operation.generation === generation && current(operation),
        receive: (request, signal) => {
          const context = readMarketShareContext(request.context);
          if (request.receiverId !== MARKET_SHARE_RECEIVER || request.contextVersion !== 1 || !context) return Promise.resolve({ status: "invalid_context" });
          if (signal.aborted || !current(operation)) return Promise.resolve({ status: "unavailable" });
          return new Promise(resolve => {
            operation.delivery = { intentId: request.intentId, acknowledge: resolve };
            const delivery: MarketShareDelivery = { activationId: operation.activationId, instanceId, generation,
              target: { intentId: request.intentId, shareId: request.shareId, context } };
            window.webContents.send("market.shareReceive", delivery);
          });
        },
      });
      return { generation };
    });
    handle("market.shareAck", (event, input: unknown) => {
      owner(event);
      const operation = pending;
      if (!operation || !current(operation) || !isObject(input) || input.activationId !== operation.activationId ||
          input.generation !== operation.generation || input.intentId !== operation.delivery?.intentId ||
          (typeof input.status !== "string" || !["received", "invalid_context", "unavailable"].includes(input.status))) return false;
      operation.delivery?.acknowledge({ status: input.status as "received" | "invalid_context" | "unavailable" });
      return true;
    });
    handle("market.shareRelease", (event, input: unknown) => {
      owner(event);
      if (pending && isObject(input) && input.activationId === pending.activationId && input.generation === pending.generation && event.senderFrame === pending.frame) pending.close();
    });
  } catch (error) { dispose(); throw error; }
  return dispose;
}

export function marketShareRoute(value: string, activationId: string) {
  try {
    const url = new URL(value);
    const route = url.hash.startsWith("#/") ? new URL(url.hash.slice(1), "https://desktop.invalid") : url;
    const activations = route.searchParams.getAll("shareActivation");
    return route.pathname === "/market" && activations.length === 1 && activations[0] === activationId;
  } catch { return false; }
}
function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
