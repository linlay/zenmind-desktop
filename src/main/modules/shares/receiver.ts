import { randomUUID } from "node:crypto";
import type { ShareReceiveResult, ShareResolution } from "../../../shared/contracts/shares";

import type { ShareReceiverEndpoint, ShareReceiverRegistration } from "../../support/share-ports";
export type { ShareReceiverEndpoint, ShareReceiverRegistration } from "../../support/share-ports";

export function createShareReceiverRouter(options: {
  resolve(id: string, signal: AbortSignal): Promise<ShareResolution>;
  timeoutMs?: number;
}) {
  const receivers = new Map<string, ShareReceiverRegistration>();
  let active: { controller: AbortController; receiver?: ShareReceiverRegistration } | undefined;
  let disposed = false;
  return {
    register(input: ShareReceiverRegistration) {
      if (disposed || typeof input.receiverId !== "string" || input.receiverId.trim() !== input.receiverId || !/^[a-z][a-z0-9._-]{0,127}$/u.test(input.receiverId) ||
          !["builtin", "plugin", "webapp"].includes(input.owner?.type) ||
          typeof input.owner?.id !== "string" || !input.owner.id.trim() ||
          !Array.isArray(input.contextVersions) || !input.contextVersions.length ||
          input.contextVersions.some(version => !Number.isInteger(version) || version < 1 || version > 2 ** 31 - 1) ||
          new Set(input.contextVersions).size !== input.contextVersions.length || typeof input.activate !== "function" ||
          receivers.has(input.receiverId)) throw new Error("Invalid or duplicate share receiver registration");
      const registration = { ...input, owner: { ...input.owner }, contextVersions: [...input.contextVersions] };
      receivers.set(registration.receiverId, registration);
      return () => {
        if (receivers.get(registration.receiverId) !== registration) return;
        receivers.delete(registration.receiverId);
        if (active?.receiver === registration) active.controller.abort();
      };
    },

    async receive(id: string, intentId: string = randomUUID()): Promise<ShareReceiveResult> {
      if (disposed || typeof id !== "string" || id.trim() !== id || !/^[A-Za-z0-9_-]{1,80}$/u.test(id)) return { status: "unavailable" };
      active?.controller.abort();
      const operation = { controller: new AbortController(), receiver: undefined as ShareReceiverRegistration | undefined };
      active = operation;
      const { signal } = operation.controller;
      const timer = setTimeout(() => operation.controller.abort(), options.timeoutMs ?? 15_000);
      try {
        const description = await untilAborted(options.resolve(id, signal), signal);
        const handoff = description.desktop;
        if (description.id !== id || description.protocolVersion !== 1 || !description.actions.includes("desktop") || !handoff) return { status: "unsupported" };
        const receiver = receivers.get(handoff.receiverId);
        if (!receiver || !receiver.contextVersions.includes(handoff.contextVersion)) return { status: "unsupported" };
        if (signal.aborted) return { status: "unavailable" };
        operation.receiver = receiver;
        const endpoint = await untilAborted(receiver.activate({ intentId, signal }), signal);
        const generation = endpoint.generation;
        const current = () => !signal.aborted && receivers.get(handoff.receiverId) === receiver &&
          typeof generation === "string" && Boolean(generation) && endpoint.generation === generation && endpoint.isCurrent();
        if (!current()) return { status: "unavailable" };
        // Immutable content still shares the live revocation state. Check again
        // after activation/ready, immediately before delivering any context.
        const confirmed = await untilAborted(options.resolve(id, signal), signal);
        if (!current() || confirmed.id !== id || confirmed.protocolVersion !== 1 ||
            !confirmed.actions.includes("desktop") || JSON.stringify(confirmed.desktop) !== JSON.stringify(handoff)) return { status: "unavailable" };
        const result = await untilAborted(endpoint.receive({ ...handoff, intentId, shareId: id }, signal), signal);
        if (!current() || !result || !["received", "unsupported", "unavailable", "invalid_context"].includes(result.status)) return { status: "unavailable" };
        return result;
      } catch { return { status: "unavailable" }; }
      finally {
        clearTimeout(timer);
        operation.controller.abort();
        if (active === operation) active = undefined;
      }
    },

    dispose() {
      disposed = true;
      active?.controller.abort();
      receivers.clear();
    },
  };
}
export type ShareReceiverRouter = ReturnType<typeof createShareReceiverRouter>;

function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("Share handoff ended")); };
    if (signal.aborted) { operation.catch(() => {}); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
