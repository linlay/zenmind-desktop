import { createVisualsReceiver } from "./visuals-receiver";
import { AGENT_WEBCLIENT_VISUALS_GLOBAL, AGENT_WEBCLIENT_VISUALS_CHANNEL, AGENT_WEBCLIENT_VISUAL_ASSET_CHANNEL } from "../shared/contracts/agent-webclient-bridge";
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
  const visualEnvelope = () => ({ version: "1.1", documentId, origin: window.location.origin });
  const visuals = createVisualsReceiver(
    () => ipcRenderer.sendToHost(AGENT_WEBCLIENT_VISUALS_CHANNEL, visualEnvelope()),
    (resourceSet, slot, requestId) => ipcRenderer.sendToHost(AGENT_WEBCLIENT_VISUAL_ASSET_CHANNEL, { ...visualEnvelope(), resourceSet, slot, requestId })
  );
  ipcRenderer.on(AGENT_WEBCLIENT_VISUALS_CHANNEL, (_event, message) => {
    if (message?.probe === true) visuals.refreshIfConsumed();
    else if (message?.documentId === documentId) visuals.receive(message.snapshot);
  });
  ipcRenderer.on(AGENT_WEBCLIENT_VISUAL_ASSET_CHANNEL, (_event, message) => {
    if (message?.documentId === documentId) visuals.receiveAsset(message);
  });
  contextBridge.exposeInMainWorld(AGENT_WEBCLIENT_VISUALS_GLOBAL, visuals.bridge);
  window.addEventListener("pagehide", () => visuals.dispose(), { once: true });
  const receiver = createAppearanceReceiver(() => {
    ipcRenderer.sendToHost(AGENT_WEBCLIENT_APPEARANCE_REQUEST_CHANNEL, {
      version: "1.1", documentId, origin: window.location.origin
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
