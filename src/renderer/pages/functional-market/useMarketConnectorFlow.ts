import { useCallback, useEffect, useRef, useState } from "react";
import type { MarketItem } from "@shared/contracts";
import type { MarketConnectorAuthSession, MarketConnectorConnection, MarketConnectorTokenSchema } from "@shared/contracts/market-connector-state";
import { openConnectorAuthorization, connectorAuthorizationUrl, connectorSessionActive, sameConnectorAuthorization, runMarketConnectorFlow, type ConnectorFlowPhase } from "./connectorFlow";

interface FlowState { item: MarketItem; connectorId: string; phase: ConnectorFlowPhase; session?: MarketConnectorAuthSession; schema?: MarketConnectorTokenSchema; enable: boolean; openChat: boolean; draft?: string }
export function useMarketConnectorFlow(onChanged?: () => void, onChat?: (agentKey: string, draft?: string) => void) {
  const [connections, setConnections] = useState<Record<string, MarketConnectorConnection>>({});
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [stateError, setStateError] = useState("");
  const [failure, setFailure] = useState<{ item: MarketItem; message: string; retry: () => unknown; recoveredByReady?: string } | null>(null);
  const error = failure?.message || "";
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!["market.connector.flow.canceled", "market.connector.flow.phase.complete", "market.connector.flow.updated"].includes(notice)) return;
    const timer = window.setTimeout(() => setNotice(""), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const dismissNotice = useCallback(() => setNotice(""), []);
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const opened = useRef<{ connectorId: string; sessionId: string; authorizationUrl: string } | null>(null);
  const embeddedOpened = useRef(false);
  const browserChoice = useRef<"embedded" | "system" | undefined>(undefined);
  const [openingAuth, setOpeningAuth] = useState(false);
  const [authRedirectKey, setAuthRedirectKey] = useState(0);
  const authOpening = useRef(false);
  const mounted = useRef(true);
  const revision = useRef(0);
  const callbacks = useRef({ onChanged, onChat }); callbacks.current = { onChanged, onChat };
  const latest = useRef(flow); latest.current = flow;
  const updateConnection = useCallback((connection: MarketConnectorConnection) => {
    if (mounted.current) setConnections(previous => ({ ...previous, [connection.connectorId]: connection }));
  }, []);
  const refresh = useCallback(async () => {
    if (!mounted.current || controller.current) return;
    const request = ++revision.current;
    try { const list = await window.electronAPI.market.getConnectorConnections(); if (!mounted.current || request !== revision.current) return;
      setConnections(Object.fromEntries(list.map(item => [item.connectorId, item]))); setStateError("");
      // Ready only proves recovery of preparation/auth/enable failures, not update or Agent mounting failures.
      setFailure(previous => previous?.recoveredByReady && list.some(connection => connection.connectorId === previous.recoveredByReady && connection.readiness === "ready") ? null : previous);
    } catch (cause) { if (mounted.current && request === revision.current) setStateError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (mounted.current && request === revision.current) setLoading(false); }
  }, []);
  const dismiss = useCallback(async () => {
    const identity = opened.current; const embedded = embeddedOpened.current; opened.current = null; embeddedOpened.current = false;
    if (identity && embedded) await window.electronAPI.connectorAuthBrowser.dismiss({ connectorId: identity.connectorId, sessionId: identity.sessionId });
  }, []);
  const showSession = useCallback(async (session: MarketConnectorAuthSession, manual = false) => {
    if (!mounted.current || (authOpening.current && !manual)) return;
    setFlow(previous => previous ? { ...previous, session } : previous);
    if (!connectorSessionActive(session) || !session.authorizationUrl) return;
    const url = connectorAuthorizationUrl(session.authorizationUrl);
    if (!url || !session.sessionId) throw new Error("market.connector.flow.invalidAuthUrl");
    const identity = { connectorId: session.connectorId, sessionId: session.sessionId };
    if (sameConnectorAuthorization(opened.current, session, url)) return;
    setAuthRedirectKey(value => value + 1);
    const browser = await openConnectorAuthorization(session, window.electronAPI, browserChoice.current);
    if (!mounted.current || latest.current?.session?.sessionId !== session.sessionId) {
      if (browser === "embedded") await window.electronAPI.connectorAuthBrowser.dismiss({ connectorId: identity.connectorId, sessionId: identity.sessionId });
      return;
    }
    opened.current = { ...identity, authorizationUrl: url }; embeddedOpened.current = browser === "embedded";
  }, []);
  const cancel = useCallback(async () => {
    const previous = latest.current;
    const running = !!controller.current;
    controller.current?.abort(); controller.current = null; revision.current++;
    setBusy(false); setFlow(null); latest.current = null; setFailure(null); setNotice("market.connector.flow.canceled");
    try {
      await dismiss();
      if (!running && previous?.session && connectorSessionActive(previous.session) && previous.session.sessionId) updateConnection(await window.electronAPI.market.cancelConnectorConnection({ connectorId: previous.connectorId, sessionId: previous.session.sessionId }));
      await refresh();
    } catch (cause) { if (mounted.current && previous) setFailure({ item: previous.item, message: cause instanceof Error ? cause.message : String(cause), retry: cancel }); }
  }, [dismiss, refresh, updateConnection]);
  const cancelRef = useRef(cancel); cancelRef.current = cancel;
  useEffect(() => {
    mounted.current = true; void refresh();
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    const timer = window.setInterval(visible, 15_000);
    document.addEventListener("visibilitychange", visible);
    const unsubscribe = window.electronAPI.connectorAuthBrowser.onClosed(identity => {
      if (opened.current?.connectorId === identity.connectorId && opened.current.sessionId === identity.sessionId) void cancelRef.current();
    });
    return () => {
      mounted.current = false; revision.current++;
      const running = !!controller.current;
      controller.current?.abort(); controller.current = null;
      const session = latest.current?.session;
      if (!running && session && connectorSessionActive(session) && session.sessionId) {
        void window.electronAPI.market.cancelConnectorConnection({ connectorId: session.connectorId, sessionId: session.sessionId })
          .catch(() => console.warn("[connector-market] Failed to cancel the abandoned authorization session"));
      }
      clearInterval(timer); document.removeEventListener("visibilitychange", visible); unsubscribe(); void dismiss().catch(() => {});
    };
  }, [refresh, dismiss]);
  const getId = (item: MarketItem) => aliases[item.id] || item.connectorId || item.id;
  const getConnection = (item: MarketItem) => connections[getId(item)];
  const isInstalled = (item: MarketItem) => item.connectorInstalled === true || !!aliases[item.id] || !!getConnection(item);
  const start = async (item: MarketItem, enable = true, openChat = false, draft?: string, credentials?: Record<string, string>) => {
    if (!mounted.current || controller.current) return;
    const setError = (message: string, allowRecovery = true) => setFailure({ item, message, retry: () => start(item, enable, openChat, draft),
      recoveredByReady: allowRecovery && latest.current && ["preparing", "authorizing", "enabling"].includes(latest.current.phase) ? latest.current.connectorId : undefined });
    const abort = new AbortController(); controller.current = abort; revision.current++;
    setBusy(true); setFailure(null); setNotice("");
    browserChoice.current = undefined;
    const credentialSchema = credentials ? latest.current?.schema : undefined;
    const initial: FlowState = { schema: credentialSchema, item, connectorId: getId(item), phase: isInstalled(item) ? "preparing" : "installing", enable, openChat, draft };
    latest.current = initial; setFlow(initial);
    const change = (patch: Partial<FlowState>) => { if (!abort.signal.aborted && mounted.current && latest.current) { const value = { ...latest.current, ...patch }; latest.current = value; setFlow(value); } };
    let cancellationFailed = false;
    let authorizationTimedOut = false;
    let authorizationTimer: number | undefined;
    let rejectAuthorizationTimeout: (reason: Error) => void = () => {};
    const authorizationTimeout = new Promise<never>((_, reject) => { rejectAuthorizationTimeout = reject; });
    const clearAuthorizationTimer = () => {
      if (authorizationTimer !== undefined) window.clearTimeout(authorizationTimer);
      authorizationTimer = undefined;
    };
    abort.signal.addEventListener("abort", clearAuthorizationTimer, { once: true });
    try {
      let agentKey: string | undefined;
      if (enable) {
        const settings = await window.electronAPI.assistant.getSettings();
        if (abort.signal.aborted || !mounted.current) return;
        agentKey = settings.chatDefaultAgentKey.trim();
        if (!agentKey) throw new Error("market.discovery.defaultAgentRequired");
      }
      const result = await Promise.race([runMarketConnectorFlow({ item, installed: isInstalled(item), connectorId: initial.connectorId, enable, agentKey, credentials, signal: abort.signal,
        onPhase: phase => {
          change({ phase });
          if (phase !== "authorizing") { clearAuthorizationTimer(); return; }
          if (authorizationTimer !== undefined || abort.signal.aborted) return;
          authorizationTimer = window.setTimeout(() => {
            if (!mounted.current || controller.current !== abort) return;
            authorizationTimedOut = true;
            const reason = new Error("market.connector.flow.authorizationTimeout");
            rejectAuthorizationTimeout(reason);
            abort.abort(reason);
          }, 3 * 60_000);
        }, onConnection: updateConnection,
        onInstalled: connectorId => { change({ connectorId }); setAliases(previous => ({ ...previous, [item.id]: connectorId })); callbacks.current.onChanged?.(); },
        onSession: async session => { change({ session }); if (!abort.signal.aborted) await showSession(session); },
        onTokenSchema: schema => change({ schema }),
        onCancellationError: () => {
          cancellationFailed = true;
          if (mounted.current && controller.current === abort && !authorizationTimedOut) { setNotice(""); setError("market.connector.flow.cancelFailed", false); }
          else console.warn("[connector-market] Failed to cancel the abandoned authorization session");
        },
      }, window.electronAPI.market), authorizationTimeout]);
      if (abort.signal.aborted || !mounted.current) return;
      if (result.result === "complete") { setFlow(null); latest.current = null; setNotice("market.connector.flow.phase.complete"); if (openChat && agentKey) callbacks.current.onChat?.(agentKey, draft); }
    } catch (cause) {
      if (authorizationTimedOut && mounted.current && controller.current === abort) {
        setError("market.connector.flow.authorizationTimeout", false);
      } else if (!abort.signal.aborted && mounted.current) {
        if (credentials && credentialSchema) {
          change({ phase: "credentials", schema: credentialSchema });
          const reason = cause instanceof Error ? cause.message : String(cause);
          setError(reason.includes("saved credentials were preserved")
            ? "market.connector.flow.credentialCheckFailed"
            : "market.connector.flow.credentialSaveFailed");
        } else setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
    finally {
      clearAuthorizationTimer();
      abort.signal.removeEventListener("abort", clearAuthorizationTimer);
      if (controller.current === abort) { controller.current = null; if (mounted.current) { setBusy(false); if (!cancellationFailed && latest.current) { const value = { ...latest.current, session: undefined }; latest.current = value; setFlow(value); } } try { await dismiss(); } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause), false); } void refresh(); callbacks.current.onChanged?.(); }
    }
  };
  const mutate = async (item: MarketItem, action: "disable" | "disconnect" | "update") => {
    if (!mounted.current || controller.current) return;
    const setError = (message: string) => setFailure({ item, message, retry: () => mutate(item, action) });
    // A mutation must not retain a different connector's failed authorization flow.
    setFlow(null); latest.current = null;
    const abort = new AbortController(); controller.current = abort; revision.current++; setBusy(true); setFailure(null); setNotice("");
    try { const id = getId(item);
      if (action === "update") {
        const result = await window.electronAPI.market.update(item.id);
        if (!result.ok) throw new Error(result.message);
        if (!abort.signal.aborted) { updateConnection(await window.electronAPI.market.getConnectorConnection(result.connectorId || id)); setNotice("market.connector.flow.updated"); }
      }
      else if (action === "disable") { const result = await window.electronAPI.market.setConnectorEnabled({ connectorId: id, enabled: false }); if (!abort.signal.aborted) updateConnection(result); }
      else { const result = await window.electronAPI.market.disconnectConnector(id); if (abort.signal.aborted) return; updateConnection(await window.electronAPI.market.getConnectorConnection(id)); if (result.remote_revocation === "failed") setNotice("market.connector.flow.remoteFailed"); }
    } catch (cause) { if (mounted.current && !abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (controller.current === abort) { controller.current = null; if (mounted.current) setBusy(false); callbacks.current.onChanged?.(); void refresh(); } }
  };
  return { connections, loading, stateError, error, errorItem: failure?.item, dismissError: () => setFailure(null),
    getError: (item: MarketItem) => failure && getId(failure.item) === getId(item) ? failure.message : "",
    notice, dismissNotice, flow, busy, refresh, getConnection, isInstalled, start, cancel, mutate,
    retry: (item?: MarketItem) => { if (failure && (!item || getId(failure.item) === getId(item))) return failure.retry(); },
    submitCredentials: (credentials: Record<string, string>) => { const value = latest.current; return value ? start(value.item, value.enable, value.openChat, value.draft, credentials) : Promise.resolve(); },
    openingAuth, authRedirectKey,
    reopenAuth: async (browser?: "embedded" | "system") => {
      if (!mounted.current || authOpening.current) return;
      const current = latest.current;
      const session = current?.session;
      if (!current || !session || !connectorSessionActive(session)) return;
      authOpening.current = true; setOpeningAuth(true);
      browserChoice.current = browser;
      try {
        await dismiss();
        if (!mounted.current || latest.current?.session?.sessionId !== session.sessionId || !connectorSessionActive(latest.current.session)) return;
        await showSession(session, true);
      } catch (cause) { if (mounted.current) setFailure({ item: current.item, message: cause instanceof Error ? cause.message : String(cause), retry: () => start(current.item, current.enable, current.openChat, current.draft) }); }
      finally { authOpening.current = false; if (mounted.current) setOpeningAuth(false); }
    },
  };
}
export type MarketConnectorFlowRuntime = ReturnType<typeof useMarketConnectorFlow>;
