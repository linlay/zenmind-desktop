import { AGENT_WEBCLIENT_VISUALS_CHANNEL as channel, AGENT_WEBCLIENT_VISUAL_ASSET_CHANNEL as assetChannel,
  parseSkinVisuals, isSkinVisualDataUrl, type SkinVisuals, type SkinVisualSlot, type AgentWebclientVisualSnapshot } from "../../shared/contracts/agent-webclient-bridge";

type Guest = Pick<Electron.WebviewTag, "send" | "addEventListener" | "removeEventListener">;
export function createVisualsHost(guest: Guest, trusted: (origin?: unknown) => boolean,
  read: () => SkinVisuals | undefined, nextRevision: () => number) {
  let documentId = "", signature = "";
  let snapshot: AgentWebclientVisualSnapshot | null = null;
  let resources: SkinVisuals["images"] = {};
  const send = (name: string, payload: object) => {
    if (!documentId || !trusted()) return;
    try { guest.send(name, { documentId, ...payload }); } catch { /* Document replacement. */ }
  };
  function refresh() {
    if (!trusted()) return;
    if (!documentId) { try { guest.send(channel, { probe: true }); } catch { /* Retry at ready. */ } return; }
    const visuals = parseSkinVisuals(read() ?? { images: {}, styles: {} }, value => isSkinVisualDataUrl(value) ? value : null);
    const next = JSON.stringify(visuals);
    if (next !== signature) {
      signature = next;
      resources = visuals?.images ?? {};
      snapshot = visuals ? { schemaVersion: "1.1", revision: nextRevision(), resourceSet: crypto.randomUUID(),
        visuals: { styles: visuals.styles, images: Object.fromEntries(Object.keys(resources).map(slot => [slot, slot])) } } : null;
    }
    send(channel, { snapshot });
  }
  const receive = (event: Event) => {
    const message = event as Event & { channel?: string; args?: unknown[] };
    if (message.channel !== channel && message.channel !== assetChannel) return;
    const value = message.args?.[0] as Record<string, unknown> | undefined;
    if (!value || typeof value !== "object" || value.version !== "1.1" || typeof value.documentId !== "string" ||
      !/^[a-f\d-]{36}$/i.test(value.documentId) || typeof value.origin !== "string" || !trusted(value.origin)) return;
    if (message.channel === channel) { documentId = value.documentId; refresh(); return; }
    if (value.documentId !== documentId || typeof value.requestId !== "string" || !/^[a-f\d-]{36}$/i.test(value.requestId)) return;
    // Re-read before serving: queued requests may refer to a skin already replaced.
    refresh();
    const data = value.resourceSet === snapshot?.resourceSet && typeof value.slot === "string"
      ? resources[value.slot as SkinVisualSlot] ?? null : null;
    send(assetChannel, { requestId: value.requestId, resourceSet: value.resourceSet, data });
  };
  guest.addEventListener("ipc-message", receive);
  return {
    refresh,
    reset() { documentId = ""; signature = ""; snapshot = null; resources = {}; },
    dispose() { send(channel, { snapshot: null }); guest.removeEventListener("ipc-message", receive); documentId = ""; resources = {}; }
  };
}
