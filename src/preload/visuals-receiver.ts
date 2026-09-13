import { parseAgentWebclientVisualSnapshot, isSkinVisualDataUrl, SKIN_VISUAL_SLOTS,
  type AgentWebclientVisualBridge, type AgentWebclientVisualSnapshot, type SkinVisualSlot } from "../shared/contracts/agent-webclient-bridge";

export function createVisualsReceiver(request: () => void, requestAsset: (resourceSet: string, slot: SkinVisualSlot, requestId: string) => void) {
  let snapshot: AgentWebclientVisualSnapshot | null = null, revision = 0, signature = "", consumed = false, disposed = false;
  const listeners = new Set<(value: AgentWebclientVisualSnapshot | null) => void>();
  const reads = new Set<(value: AgentWebclientVisualSnapshot | null) => void>();
  const assets = new Map<string, { resourceSet: string; resolve: (value: string | null) => void; timer: ReturnType<typeof setTimeout> }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  function settle() { clearTimeout(timer); timer = undefined; for (const resolve of reads) resolve(snapshot); reads.clear(); }
  function notify() { for (const listener of listeners) { try { listener(snapshot); } catch { /* Isolate consumers. */ } } }
  function clearAssets() { for (const pending of assets.values()) { clearTimeout(pending.timer); pending.resolve(null); } assets.clear(); }
  function refresh() {
    if (disposed || timer) return;
    timer = setTimeout(() => { snapshot = null; clearAssets(); settle(); notify(); }, 2000);
    try { request(); } catch { snapshot = null; clearAssets(); settle(); notify(); }
  }
  const bridge: AgentWebclientVisualBridge = Object.freeze({
    version: "1.1",
    getSnapshot() { if (disposed) return Promise.resolve(null); consumed = true; return new Promise(resolve => { reads.add(resolve); refresh(); }); },
    subscribe(listener) { if (typeof listener !== "function") throw new TypeError("Invalid visual listener"); if (disposed) return () => {}; consumed = true; listeners.add(listener); refresh(); return () => { listeners.delete(listener); }; },
    getAsset(resourceSet, slot) {
      if (disposed || resourceSet !== snapshot?.resourceSet || !SKIN_VISUAL_SLOTS.includes(slot) || !snapshot.visuals.images[slot] || assets.size >= 40) return Promise.resolve(null);
      return new Promise(resolve => {
        const requestId = crypto.randomUUID();
        const timer = setTimeout(() => { assets.delete(requestId); resolve(null); }, 2000);
        assets.set(requestId, { resourceSet, resolve, timer });
        try { requestAsset(resourceSet, slot, requestId); } catch { clearTimeout(timer); assets.delete(requestId); resolve(null); }
      });
    }
  });
  return {
    bridge,
    refreshIfConsumed() { if (consumed) refresh(); },
    receive(value: unknown) {
      if (disposed) return;
      const next = value === null ? null : parseAgentWebclientVisualSnapshot(value);
      if (value !== null && !next) return;
      if (next && (next.revision < revision || (next.revision === revision && JSON.stringify(next) !== signature))) return;
      if (next?.resourceSet !== snapshot?.resourceSet) clearAssets();
      const changed = JSON.stringify(next) !== JSON.stringify(snapshot);
      if (next) { revision = next.revision; signature = JSON.stringify(next); }
      snapshot = next; settle(); if (changed) notify();
    },
    receiveAsset(value: unknown) {
      if (!value || typeof value !== "object") return;
      const response = value as { requestId?: string; resourceSet?: string; data?: unknown };
      const pending = response.requestId && assets.get(response.requestId);
      if (!pending) return;
      assets.delete(response.requestId!); clearTimeout(pending.timer);
      pending.resolve(response.resourceSet === snapshot?.resourceSet && response.resourceSet === pending.resourceSet && isSkinVisualDataUrl(response.data) ? response.data : null);
    },
    dispose() { disposed = true; snapshot = null; clearAssets(); settle(); listeners.clear(); }
  };
}
