import { contextBridge, ipcRenderer } from "electron";
import {
  AGENT_WEBCLIENT_HEADER_LAYOUT_GLOBAL,
  AGENT_WEBCLIENT_HEADER_LAYOUT_REQUEST_CHANNEL,
  AGENT_WEBCLIENT_HEADER_LAYOUT_SNAPSHOT_CHANNEL,
  parseAgentWebclientHeaderLayoutSnapshot,
  readAgentWebclientHeaderLayoutBootstrap,
  type AgentWebclientHeaderLayoutBridge,
  type AgentWebclientHeaderLayoutSnapshot,
} from "../shared/contracts/agent-webclient-bridge";

export function installServiceWebviewHeaderLayout() {
  if (!process.isMainFrame) return;
  const documentId = crypto.randomUUID();
  const initial = readAgentWebclientHeaderLayoutBootstrap(window.location.search);
  let snapshot: AgentWebclientHeaderLayoutSnapshot | null = initial ? { ...initial, schemaVersion: "1.0", revision: 0 } : null;
  let revision = 0;
  let signature = snapshot ? JSON.stringify(snapshot) : "";
  let consumed = false;
  const listeners = new Set<(value: AgentWebclientHeaderLayoutSnapshot | null) => void>();
  function request() {
    ipcRenderer.sendToHost(AGENT_WEBCLIENT_HEADER_LAYOUT_REQUEST_CHANNEL, { version: "1.0", documentId, origin: window.location.origin });
  }
  ipcRenderer.on(AGENT_WEBCLIENT_HEADER_LAYOUT_REQUEST_CHANNEL, () => { if (consumed) request(); });
  ipcRenderer.on(AGENT_WEBCLIENT_HEADER_LAYOUT_SNAPSHOT_CHANNEL, (_event, message: unknown) => {
    if (!message || typeof message !== "object") return;
    const envelope = message as { documentId?: unknown; snapshot?: unknown };
    if (envelope.documentId !== documentId) return;
    const next = parseAgentWebclientHeaderLayoutSnapshot(envelope.snapshot);
    if (envelope.snapshot !== null && (!next || next.revision < revision ||
      (next.revision === revision && JSON.stringify(next) !== signature))) return;
    if (next) { revision = next.revision; signature = JSON.stringify(next); }
    snapshot = next;
    for (const listener of listeners) {
      try { listener(snapshot); } catch { /* One subscriber cannot break layout delivery. */ }
    }
  });
  const bridge: AgentWebclientHeaderLayoutBridge = Object.freeze({
    version: "1.0",
    getSnapshot() { consumed = true; request(); return snapshot; },
    subscribe(listener: (value: AgentWebclientHeaderLayoutSnapshot | null) => void) {
      if (typeof listener !== "function") throw new TypeError("Header layout listener must be a function.");
      consumed = true;
      listeners.add(listener);
      request();
      return () => { listeners.delete(listener); };
    },
  });
  contextBridge.exposeInMainWorld(AGENT_WEBCLIENT_HEADER_LAYOUT_GLOBAL, bridge);
  window.addEventListener("pagehide", () => listeners.clear(), { once: true });
}
