import { randomUUID } from "node:crypto";
import type {
  WebappEntry,
  WebappRuntimeState,
} from "../../../../shared/contracts";
import type {
  ShareReceiveRequest,
  ShareReceiveResult,
} from "../../../../shared/contracts/shares";
import type {
  ShareReceiverEndpoint,
  ShareServicePort,
} from "../../../support/share-ports";

/** A single bounded handoff on the existing, authorized local-page Bridge. */
export function createWebappShareReceivers(options: {
  shares: Pick<ShareServicePort, "registerReceiver">;
  listInstalled(): WebappEntry[];
  getState(id: string): WebappRuntimeState | null;
  open(id: string, signal: AbortSignal): Promise<void>;
  onError(id: string): void;
}) {
  type Pending = {
    id: string;
    generation: string;
    signal: AbortSignal;
    instanceId?: string;
    pageSignal?: AbortSignal;
    ready(endpoint: ShareReceiverEndpoint): void;
    close(): void;
    delivery?: {
      request: ShareReceiveRequest;
      finish(result: ShareReceiveResult): void;
    };
  };
  const registrations = new Map<
    string,
    { signature: string; unregister(): void }
  >();
  let pending: Pending | undefined;
  let disposed = false;
  const signature = (item: WebappEntry) =>
    JSON.stringify([item.version, item.installPath, item.shareReceiver]);
  const installed = (id: string) =>
    options.listInstalled().find((item) => item.id === id);
  function sync() {
    if (disposed) return;
    let items: WebappEntry[];
    try {
      items = options.listInstalled();
    } catch {
      pending?.close();
      for (const entry of registrations.values()) entry.unregister();
      registrations.clear();
      options.onError("");
      return;
    }
    const declared = new Map(
      items.filter((item) => item.shareReceiver).map((item) => [item.id, item]),
    );
    for (const [id, entry] of registrations) {
      if (
        !declared.has(id) ||
        signature(declared.get(id)!) !== entry.signature
      ) {
        entry.unregister();
        registrations.delete(id);
        if (pending?.id === id) pending.close();
      }
    }
    for (const [id, item] of declared) {
      if (registrations.has(id)) continue;
      const expected = signature(item);
      try {
        const unregister = options.shares.registerReceiver({
          receiverId: "webapp." + id,
          owner: { type: "webapp", id },
          contextVersions: item.shareReceiver!.contextVersions,
          activate: ({ signal }) =>
            new Promise((resolve, reject) => {
              const selected = installed(id);
              if (
                disposed ||
                signal.aborted ||
                !selected ||
                signature(selected) !== expected
              ) {
                reject(new Error("WebApp share receiver is unavailable"));
                return;
              }
              pending?.close();
              const operation: Pending = {
                id,
                generation: randomUUID(),
                signal,
                ready: resolve,
                close() {
                  if (pending === operation) pending = undefined;
                  signal.removeEventListener("abort", operation.close);
                  operation.pageSignal?.removeEventListener(
                    "abort",
                    operation.close,
                  );
                  operation.delivery?.finish({ status: "unavailable" });
                  reject(new Error("WebApp share handoff ended"));
                },
              };
              pending = operation;
              signal.addEventListener("abort", operation.close, { once: true });
              void options.open(id, signal).catch(operation.close);
            }),
        });
        registrations.set(id, { signature: expected, unregister });
      } catch {
        options.onError(id);
      }
    }
  }
  function current(operation: Pending) {
    const item = installed(operation.id);
    return (
      pending === operation &&
      !operation.signal.aborted &&
      !operation.pageSignal?.aborted &&
      Boolean(
        item &&
        signature(item) === registrations.get(operation.id)?.signature &&
        options.getState(operation.id)?.status === "running",
      )
    );
  }
  return {
    sync,
    handle(
      id: string,
      action: string,
      input: Record<string, unknown>,
      pageSignal: AbortSignal | undefined,
    ): unknown {
      if (!pageSignal || pageSignal.aborted || disposed)
        throw new Error("A current local-page grant is required");
      const operation = pending;
      const instanceId = input.instanceId;
      if (
        typeof instanceId !== "string" ||
        instanceId.length !== 36 ||
        !/^[a-f0-9-]+$/u.test(instanceId)
      )
        throw new Error("Invalid page instance");
      if (!operation || operation.id !== id || !current(operation)) return null;
      if (
        action === "desktop.share.receive" &&
        Object.keys(input).length === 1
      ) {
        if (
          operation.instanceId &&
          (operation.instanceId !== instanceId ||
            operation.pageSignal !== pageSignal)
        ) {
          operation.close();
          return null;
        }
        if (!operation.instanceId) {
          operation.instanceId = instanceId;
          operation.pageSignal = pageSignal;
          pageSignal.addEventListener("abort", operation.close, { once: true });
          operation.ready({
            generation: operation.generation,
            isCurrent: () => current(operation),
            receive: (request, signal) => {
              if (signal.aborted || !current(operation))
                return Promise.resolve({ status: "unavailable" });
              return new Promise((resolve) => {
                operation.delivery = { request, finish: resolve };
              });
            },
          });
        }
        return operation.delivery
          ? {
              generation: operation.generation,
              request: operation.delivery.request,
            }
          : null;
      }
      if (
        operation.instanceId !== instanceId ||
        operation.pageSignal !== pageSignal ||
        input.generation !== operation.generation
      )
        return null;
      if (
        action === "desktop.share.release" &&
        Object.keys(input).length === 2
      ) {
        operation.close();
        return { released: true };
      }
      if (
        action === "desktop.share.ack" &&
        Object.keys(input).length === 4 &&
        operation.delivery &&
        input.intentId === operation.delivery.request.intentId &&
        typeof input.status === "string" &&
        ["received", "invalid_context", "unavailable"].includes(input.status)
      ) {
        operation.delivery.finish({
          status: input.status as
            | "received"
            | "invalid_context"
            | "unavailable",
        });
        return { acknowledged: true };
      }
      throw new Error("Invalid or stale WebApp share message");
    },
    dispose() {
      disposed = true;
      pending?.close();
      for (const entry of registrations.values()) entry.unregister();
      registrations.clear();
    },
  };
}
