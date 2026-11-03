import {
  AGENT_WEBCLIENT_HEADER_LAYOUT_REQUEST_CHANNEL,
  AGENT_WEBCLIENT_HEADER_LAYOUT_SNAPSHOT_CHANNEL,
  parseAgentWebclientHeaderLayoutSnapshot,
  type AgentWebclientHeaderLayout,
} from "../../shared/contracts/agent-webclient-bridge";

type LayoutWebview = Pick<Electron.WebviewTag, "getURL" | "send" | "addEventListener" | "removeEventListener">;
export function createWebclientHeaderLayoutHost(options: {
  webview: LayoutWebview;
  trustedUrl(): string;
  isCurrentGuest(): boolean;
  read(): AgentWebclientHeaderLayout;
  revisionState: { revision: number; signature: string };
}) {
  let documentId = "";
  let disposed = false;
  function trusted(origin?: unknown) {
    if (disposed || !options.isCurrentGuest()) return false;
    try {
      const expected = new URL(options.trustedUrl());
      const actual = new URL(options.webview.getURL());
      return ["http:", "https:"].includes(expected.protocol) && expected.origin === actual.origin &&
        (origin === undefined || origin === actual.origin);
    } catch { return false; }
  }
  function refresh() {
    if (!trusted()) return;
    try {
      if (!documentId) { options.webview.send(AGENT_WEBCLIENT_HEADER_LAYOUT_REQUEST_CHANNEL); return; }
      const projection = options.read();
      const sequence = options.revisionState;
      const signature = JSON.stringify(projection);
      if (signature !== sequence.signature) { sequence.signature = signature; sequence.revision++; }
      const snapshot = parseAgentWebclientHeaderLayoutSnapshot({ ...projection, schemaVersion: "1.0", revision: sequence.revision });
      options.webview.send(AGENT_WEBCLIENT_HEADER_LAYOUT_SNAPSHOT_CHANNEL, { documentId, snapshot });
    } catch { /* Guest may be loading; replay at dom-ready or on its next request. */ }
  }
  const request = (event: Event) => {
    const message = event as Event & { channel?: string; args?: unknown[] };
    if (message.channel !== AGENT_WEBCLIENT_HEADER_LAYOUT_REQUEST_CHANNEL) return;
    const value = message.args?.[0] as Record<string, unknown> | undefined;
    if (!value || value.version !== "1.0" || typeof value.documentId !== "string" ||
      !/^[a-f\d-]{36}$/i.test(value.documentId) || typeof value.origin !== "string" || !trusted(value.origin)) return;
    documentId = value.documentId;
    refresh();
  };
  const reset = () => { documentId = ""; };
  const navigation = (event: Event) => {
    const detail = event as Event & { isMainFrame?: boolean; isInPlace?: boolean };
    if (detail.isMainFrame && !detail.isInPlace) reset();
  };
  options.webview.addEventListener("ipc-message", request);
  options.webview.addEventListener("dom-ready", refresh);
  options.webview.addEventListener("did-start-navigation", navigation);
  options.webview.addEventListener("render-process-gone", reset);
  refresh();
  return { refresh, dispose() {
    if (documentId && trusted()) {
      try { options.webview.send(AGENT_WEBCLIENT_HEADER_LAYOUT_SNAPSHOT_CHANNEL, { documentId, snapshot: null }); } catch { /* Guest gone. */ }
    }
    disposed = true;
    options.webview.removeEventListener("ipc-message", request);
    options.webview.removeEventListener("dom-ready", refresh);
    options.webview.removeEventListener("did-start-navigation", navigation);
    options.webview.removeEventListener("render-process-gone", reset);
  } };
}
