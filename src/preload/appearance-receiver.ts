import {
  parseAgentWebclientAppearanceSnapshot,
  type AgentWebclientAppearanceBridge,
  type AgentWebclientAppearanceSnapshot
} from "../shared/contracts/agent-webclient-bridge";

export function createAppearanceReceiver(request: () => void, timeoutMs = 2_000) {
  let snapshot: AgentWebclientAppearanceSnapshot | null = null;
  let revision = 0;
  let lastSignature = "";
  let pendingRequest = false;
  let consumed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<(value: AgentWebclientAppearanceSnapshot | null) => void>();
  const pending = new Set<(value: AgentWebclientAppearanceSnapshot | null) => void>();
  const notify = () => {
    for (const listener of listeners) {
      try { listener(snapshot); } catch { /* One consumer cannot break delivery. */ }
    }
  };
  function settle() {
    clearTimeout(timer);
    pendingRequest = false;
    for (const resolve of pending) resolve(snapshot);
    pending.clear();
  }
  function refresh() {
    if (pendingRequest) return;
    pendingRequest = true;
    timer = setTimeout(() => {
      snapshot = null;
      settle();
      notify();
    }, timeoutMs);
    try { request(); } catch {
      snapshot = null;
      settle();
      notify();
    }
  }
  const bridge: AgentWebclientAppearanceBridge = Object.freeze({
    version: 1,
    getSnapshot() {
      consumed = true;
      return new Promise<AgentWebclientAppearanceSnapshot | null>((resolve) => {
        pending.add(resolve);
        refresh();
      });
    },
    subscribe(listener: (value: AgentWebclientAppearanceSnapshot | null) => void) {
      if (typeof listener !== "function") throw new TypeError("Appearance listener must be a function.");
      consumed = true;
      listeners.add(listener);
      refresh();
      return () => { listeners.delete(listener); };
    }
  });
  return {
    bridge,
    refreshIfConsumed() { if (consumed) refresh(); },
    receive(value: unknown) {
      const next = value === null ? null : parseAgentWebclientAppearanceSnapshot(value);
      if (value !== null && !next) return;
      if (next && next.revision < revision) return;
      // An equal revision must describe the same snapshot, including after a
      // timeout. A legitimate host refresh may repeat that exact snapshot.
      if (next && next.revision === revision && JSON.stringify(next) !== lastSignature) return;
      const changed = JSON.stringify(next) !== JSON.stringify(snapshot);
      if (next) { revision = next.revision; lastSignature = JSON.stringify(next); }
      snapshot = next;
      settle();
      if (changed) notify();
    },
    dispose() {
      snapshot = null;
      settle();
      listeners.clear();
    }
  };
}
