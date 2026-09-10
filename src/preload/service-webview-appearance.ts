import { contextBridge, ipcRenderer } from "electron";
import {
  AGENT_WEBCLIENT_APPEARANCE_GLOBAL,
  AGENT_WEBCLIENT_APPEARANCE_REQUEST_CHANNEL,
  AGENT_WEBCLIENT_APPEARANCE_SNAPSHOT_CHANNEL
} from "../shared/contracts/agent-webclient-bridge";
import { createAppearanceReceiver } from "./appearance-receiver";

export function installServiceWebviewAppearance() {
  if (!process.isMainFrame) return;
  // This nonce belongs to the isolated preload document, never to page input.
  // Queued delivery for the previous document cannot populate the new bridge.
  const documentId = globalThis.crypto.randomUUID();
  const receiver = createAppearanceReceiver(() => {
    ipcRenderer.sendToHost(AGENT_WEBCLIENT_APPEARANCE_REQUEST_CHANNEL, {
      version: 1, documentId, origin: window.location.origin
    });
  });
  // A renderer relay may be recreated while the guest document stays alive.
  // Only a document that actually consumed the bridge answers this probe.
  ipcRenderer.on(AGENT_WEBCLIENT_APPEARANCE_REQUEST_CHANNEL, () => receiver.refreshIfConsumed());
  ipcRenderer.on(AGENT_WEBCLIENT_APPEARANCE_SNAPSHOT_CHANNEL, (_event, message: unknown) => {
    if (!message || typeof message !== "object") return;
    const envelope = message as { documentId?: unknown; snapshot?: unknown };
    if (envelope.documentId === documentId) receiver.receive(envelope.snapshot);
  });
  contextBridge.exposeInMainWorld(AGENT_WEBCLIENT_APPEARANCE_GLOBAL, receiver.bridge);
  window.addEventListener("pagehide", () => receiver.dispose(), { once: true });
}
