import {
  AGENT_WEBCLIENT_APPEARANCE_REQUEST_CHANNEL,
  AGENT_WEBCLIENT_APPEARANCE_SNAPSHOT_CHANNEL,
  parseAgentWebclientAppearanceSnapshot,
  type AgentWebclientAppearanceSnapshot
} from "../../shared/contracts/agent-webclient-bridge";

type AppearanceWebview = Pick<Electron.WebviewTag, "getURL" | "send" | "addEventListener" | "removeEventListener">;
type Options = {
  webview: AppearanceWebview;
  isCurrentGuest(): boolean;
  trustedUrl(): string;
  read(): Omit<AgentWebclientAppearanceSnapshot, "revision">;
  onNegotiated(theme: "light" | "dark" | null): void;
  onBackground(host: boolean): void;
  revisionState?: { revision: number; signature: string };
};

export function createWebclientAppearanceHost(options: Options) {
  let documentId = "";
  let negotiated = false;
  const sequence = options.revisionState ?? { revision: 0, signature: "" };
  let disposed = false;
  function trusted(origin?: unknown) {
    if (disposed || !options.isCurrentGuest()) return false;
    try {
      const expected = new URL(options.trustedUrl());
      const actual = new URL(options.webview.getURL());
      return ["http:", "https:"].includes(expected.protocol) &&
        expected.origin === actual.origin && (origin === undefined || origin === actual.origin);
    } catch { return false; }
  }
  function send(snapshot: AgentWebclientAppearanceSnapshot | null) {
    if (!documentId || !trusted()) return;
    try {
      options.webview.send(AGENT_WEBCLIENT_APPEARANCE_SNAPSHOT_CHANNEL, { documentId, snapshot });
    } catch { /* Early requests are delivered again at dom-ready. */ }
  }
  function refresh() {
    if (!trusted()) return;
    if (!documentId) {
      try { options.webview.send(AGENT_WEBCLIENT_APPEARANCE_REQUEST_CHANNEL); } catch { /* Retry at dom-ready. */ }
      return;
    }
    const projection = options.read();
    const nextSignature = JSON.stringify(projection);
    if (nextSignature !== sequence.signature) { sequence.signature = nextSignature; sequence.revision += 1; }
    const snapshot = parseAgentWebclientAppearanceSnapshot({ ...projection, revision: sequence.revision });
    if (!snapshot) { send(null); options.onBackground(false); return; }
    if (!negotiated) {
      negotiated = true;
      options.onNegotiated(snapshot.resolvedTheme);
    }
    options.onBackground(snapshot.background.mode === "host");
    send(snapshot);
  }
  function reset() {
    documentId = "";
    negotiated = false;
    options.onNegotiated(null);
    options.onBackground(false);
  }
  const request = (event: Event) => {
    const message = event as Event & { channel?: string; args?: unknown[] };
    if (message.channel !== AGENT_WEBCLIENT_APPEARANCE_REQUEST_CHANNEL) return;
    const value = message.args?.[0];
    if (!value || typeof value !== "object") return;
    const envelope = value as Record<string, unknown>;
    if (envelope.version !== 1 || typeof envelope.origin !== "string" || typeof envelope.documentId !== "string" ||
      !/^[a-f\d-]{36}$/i.test(envelope.documentId) || !trusted(envelope.origin)) return;
    if (envelope.documentId !== documentId) {
      documentId = envelope.documentId;
      negotiated = false;
    }
    refresh();
  };
  const navigation = (event: Event) => {
    const details = event as Event & { isMainFrame?: boolean; isInPlace?: boolean };
    if (details.isMainFrame && !details.isInPlace) reset();
  };
  options.webview.addEventListener("ipc-message", request);
  options.webview.addEventListener("dom-ready", refresh);
  options.webview.addEventListener("did-start-navigation", navigation);
  options.webview.addEventListener("render-process-gone", reset);
  refresh();
  return {
    refresh,
    dispose() {
      send(null);
      disposed = true;
      options.webview.removeEventListener("ipc-message", request);
      options.webview.removeEventListener("dom-ready", refresh);
      options.webview.removeEventListener("did-start-navigation", navigation);
      options.webview.removeEventListener("render-process-gone", reset);
      documentId = "";
      options.onBackground(false);
    }
  };
}
