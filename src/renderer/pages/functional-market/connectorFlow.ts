import type { DesktopApi } from "@shared/contracts/desktop-api";
import type { MarketItem } from "@shared/contracts";
import type { MarketConnectorAuthSession, MarketConnectorConnection, MarketConnectorTokenSchema } from "@shared/contracts/market-connector-state";

/** Platform projects connector.json auth_browser into session.authBrowser. */
export async function openConnectorAuthorization(
  session: MarketConnectorAuthSession,
  api: Pick<DesktopApi, "connectorAuthBrowser" | "shell">,
  choice?: "embedded" | "system"
): Promise<"embedded" | "system"> {
  const url = connectorAuthorizationUrl(session.authorizationUrl);
  if (!url || !session.sessionId || !connectorSessionActive(session)) throw new Error("market.connector.flow.invalidAuthUrl");
  const browser = choice ?? session.authBrowser ?? "system";
  if (browser === "embedded") {
    await api.connectorAuthBrowser.open({ connectorId: session.connectorId, sessionId: session.sessionId,
      ...(choice === "embedded" ? { browser: "embedded" as const } : {}) });
  } else if (browser === "system") {
    const result = await api.shell.openExternal(url);
    if (!result.ok) throw new Error(result.error || "market.connector.flow.invalidAuthUrl");
  } else { throw new Error("market.connector.flow.invalidAuthUrl"); }
  return browser;
}

export type ConnectorFlowPhase = "installing" | "preparing" | "authorizing" | "credentials" | "mounting" | "complete";
export function connectorAuthorizationUrl(value?: string): string | null {
  if (!value || /[\s\u0000-\u001f\u007f]/.test(value)) return null;
  try { const url = new URL(value); return !url.username && !url.password && (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) ? url.href : null; }
  catch { return null; }
}
export function sameConnectorAuthorization(previous: { connectorId: string; sessionId: string; authorizationUrl: string } | null, session: MarketConnectorAuthSession, url: string) {
  return !!previous && previous.connectorId === session.connectorId && previous.sessionId === session.sessionId && previous.authorizationUrl === url;
}
export function connectorSessionActive(session?: MarketConnectorAuthSession | null) {
  return !!session && (session.status === "pending" || session.status === "preparing");
}
export function connectorSessionExpired(session: MarketConnectorAuthSession) {
  const deadline = Date.parse(session.expiresAt);
  return Number.isFinite(deadline) && deadline > 0 && deadline <= Date.now();
}
export function connectorFlowDelay(signal: AbortSignal, milliseconds = 1500): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}
/** Owns only sessions explicitly started or resumed by this user intent. */
export function createConnectorSessionOwner(cancel: (identity: { connectorId: string; sessionId: string }) => Promise<unknown>) {
  let current: MarketConnectorAuthSession | undefined;
  let canceled = false;
  const requests = new Map<string, Promise<void>>();
  const cancelCurrent = (): Promise<void> => {
    if (!current || !connectorSessionActive(current) || !current.sessionId) return Promise.resolve();
    const identity = { connectorId: current.connectorId, sessionId: current.sessionId };
    const key = `${identity.connectorId}/${identity.sessionId}`;
    const existing = requests.get(key);
    if (existing) return existing;
    const request = Promise.resolve().then(() => cancel(identity)).then(() => undefined);
    requests.set(key, request);
    return request;
  };
  return {
    observe: async (session: MarketConnectorAuthSession) => { current = session; if (canceled) await cancelCurrent(); },
    cancel: async () => { canceled = true; await cancelCurrent(); },
  };
}
export interface MarketConnectorIntent {
  item: MarketItem; installed: boolean; connectorId: string; mountAgent: boolean; agentKey?: string;
  credentials?: Record<string, string>; signal: AbortSignal;
  onPhase: (phase: ConnectorFlowPhase) => void;
  onInstalled: (connectorId: string) => void;
  onConnection: (connection: MarketConnectorConnection) => void;
  onSession: (session: MarketConnectorAuthSession) => Promise<void>;
  onTokenSchema: (schema: MarketConnectorTokenSchema) => void;
  onCancellationError?: (error: unknown) => void;
}
/** Runs only for an explicit user intent. No state read invokes this function. */
export async function runMarketConnectorFlow(intent: MarketConnectorIntent, api: DesktopApi["market"], wait = connectorFlowDelay): Promise<{ connectorId: string; result: "complete" | "credentials" | "pending_verification" }> {
  const { signal, onPhase, onConnection, onSession } = intent;
  const check = () => { if (signal.aborted) throw signal.reason || new Error("Canceled"); };
  let id = intent.connectorId;
  const owner = createConnectorSessionOwner(identity => api.cancelConnectorConnection(identity));
  const onAbort = () => { void owner.cancel().catch(error => intent.onCancellationError?.(error)); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
  if (!intent.installed) {
    onPhase("installing"); check();
    const installed = await api.install(intent.item.id); check();
    if (!installed.ok) throw new Error(installed.message || "market.connector.flow.installFailed");
    if (!installed.connectorId?.trim()) throw new Error("market.connector.flow.missingId");
    id = installed.connectorId.trim(); intent.onInstalled(id);
  }
  const read = async () => { check(); const state = await api.getConnectorConnection(id); check(); if (state.connectorId !== id) throw new Error("market.connector.flow.missingId"); onConnection(state); return state; };
  let current = await read();
  if (current.capabilities.hasCli && (!current.configured || ["authorization_required", "unavailable", "preparing"].includes(current.readiness))) {
    onPhase("preparing"); check();
    let preparation = await api.prepareConnector(id); check();
    // Platform preparation has a 15-minute limit; do not abandon a valid
    // installation after only three minutes on slow networks.
    const deadline = Date.now() + 15 * 60_000;
    while (preparation.status === "pending" || preparation.status === "preparing") {
      if (Date.now() > deadline) throw new Error("market.connector.flow.timeout");
      await wait(signal); check();
      current = await read();
      if (current.preparation) preparation = current.preparation;
    }
    if (preparation.status !== "ready") throw new Error(preparation.message || "market.connector.flow.notReady");
    current = await read();
  }
  if (intent.credentials || !current.configured || current.readiness === "authorization_required" || ["canceled", "failed"].includes(current.authentication.status)) {
    if (current.capabilities.authMode === "token" && !intent.credentials) {
      const schema = await api.getConnectorTokenSchema(id); check();
      intent.onTokenSchema(schema); onPhase("credentials"); return { connectorId: id, result: "credentials" };
    }
    onPhase("authorizing");
    let session = current.authentication;
    if (!connectorSessionActive(session) || connectorSessionExpired(session)) {
      if (connectorSessionActive(session) && session.sessionId) { await api.cancelConnectorConnection({ connectorId: id, sessionId: session.sessionId }); check(); }
      if (intent.credentials) { current = await api.saveConnectorCredentials({ connectorId: id, credentials: intent.credentials }); check(); onConnection(current); session = current.authentication; }
      else { session = await api.connectConnector(id); await owner.observe(session); check(); }
    }
    await owner.observe(session); check(); await onSession(session); check();
    const deadline = Date.now() + 15 * 60_000;
    if (session.status === "pending_verification" || session.pendingVerification) return { connectorId: id, result: "pending_verification" };
    while (true) {
      current = await read();
      session = current.authentication;
      await owner.observe(session); check(); await onSession(session); check();
      if (current.readiness === "pending_verification" || session.pendingVerification) return { connectorId: id, result: "pending_verification" };
      if (current.configured && ["authorized", "configured", "not_required", "delegated"].includes(session.status)) break;
      if (!connectorSessionActive(session)) throw new Error(session.message || "market.connector.flow.notReady");
      if (connectorSessionExpired(session) || Date.now() > deadline) throw new Error("market.connector.flow.timeout");
      await onSession(session); check(); await wait(signal);
    }
  }
  if (current.readiness === "pending_verification" || (intent.credentials && current.authentication.pendingVerification)) return { connectorId: id, result: "pending_verification" };
  if (intent.mountAgent) {
    if (!current.configured || current.readiness !== "ready") throw new Error(current.authentication.message || "market.connector.flow.notReady");
    if (intent.agentKey) {
      onPhase("mounting"); check();
      let agent = await api.setConnectorAgent({ connectorId: id, agentKey: intent.agentKey, enabled: true }); check();
      const deadline = Date.now() + 60_000;
      while (agent.reloadPending || !agent.activeConnectorIds.includes(id)) {
        if (Date.now() > deadline) throw new Error("market.connector.flow.timeout");
        await wait(signal); check(); agent = await api.getConnectorAgent(intent.agentKey); check();
      }
    }
  }
  check(); onPhase("complete"); return { connectorId: id, result: "complete" };
  } finally {
    signal.removeEventListener("abort", onAbort);
    await owner.cancel().catch(error => intent.onCancellationError?.(error));
  }
}
