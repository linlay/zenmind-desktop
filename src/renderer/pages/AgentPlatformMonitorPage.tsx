import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentPlatformMonitorConnection,
  AgentPlatformMonitorMessage,
  AgentPlatformMonitorSnapshot
} from "@shared/contracts";
import { useI18n } from "../i18n/useI18n";

type MonitorState = {
  loading: boolean;
  refreshing: boolean;
  error: string;
  snapshot: AgentPlatformMonitorSnapshot | null;
};

const DEFAULT_CONNECTION_LIMIT = 100;
const DEFAULT_MESSAGE_LIMIT = 50;
const isMac = /Mac|iPhone|iPod|iPad/i.test(navigator.userAgent);
const isWindows = /Windows/i.test(navigator.userAgent);
const windowPlatformClass = isMac ? "is-mac" : isWindows ? "is-windows" : "is-linux";

function createInitialMonitorState(): MonitorState {
  return {
    loading: true,
    refreshing: false,
    error: "",
    snapshot: null
  };
}

function toFiniteNumber(value: number) {
  return Number.isFinite(value) ? value : 0;
}

function formatTimestamp(value: number, locale: string) {
  const timestamp = toFiniteNumber(value);
  if (timestamp <= 0) {
    return "-";
  }
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(timestamp));
}

function formatCount(value: number) {
  return String(toFiniteNumber(value));
}

function formatBytes(value: number) {
  const bytes = toFiniteNumber(value);
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function readConnectionIdentity(connection: AgentPlatformMonitorConnection) {
  return [
    connection.kind,
    connection.subject,
    connection.gatewayId,
    connection.channel
  ].filter(Boolean).join(" / ") || "-";
}

function collectSessionIds(snapshot: AgentPlatformMonitorSnapshot | null) {
  if (!snapshot) {
    return [];
  }
  const sessionIds = new Set<string>();
  for (const connection of snapshot.connections.connections) {
    if (connection.sessionId) {
      sessionIds.add(connection.sessionId);
    }
  }
  if (snapshot.overview.ws.latestConnection?.sessionId) {
    sessionIds.add(snapshot.overview.ws.latestConnection.sessionId);
  }
  for (const message of snapshot.messages.messages) {
    if (message.sessionId) {
      sessionIds.add(message.sessionId);
    }
  }
  return [...sessionIds].sort();
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M20 6.5v5h-5" />
      <path d="M4 17.5v-5h5" />
      <path d="M18.2 10.2A6.8 6.8 0 0 0 6.1 7.7L4 10" />
      <path d="M5.8 13.8a6.8 6.8 0 0 0 12.1 2.5L20 14" />
    </svg>
  );
}

function MinimizeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6 12h12" />
    </svg>
  );
}

function MaximizeIcon({ restored }: { restored: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {restored ? (
        <>
          <path d="M8 8h8v8H8z" />
          <path d="M11 5h8v8" />
        </>
      ) : (
        <path d="M7 7h10v10H7z" />
      )}
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m7 7 10 10" />
      <path d="m17 7-10 10" />
    </svg>
  );
}

function ConnectionStatus({ connection }: { connection: AgentPlatformMonitorConnection }) {
  const { t } = useI18n();
  return (
    <span className={`agent-monitor-status-pill ${connection.active ? "is-active" : "is-closed"}`}>
      <span aria-hidden="true" />
      {connection.active ? t("agentMonitor.status.active") : t("agentMonitor.status.closed")}
    </span>
  );
}

function ConnectionsTable({
  connections,
  locale
}: {
  connections: AgentPlatformMonitorConnection[];
  locale: string;
}) {
  const { t } = useI18n();
  if (connections.length === 0) {
    return <div className="agent-monitor-empty">{t("agentMonitor.empty.connections")}</div>;
  }

  return (
    <div className="agent-monitor-table-scroll">
      <table className="agent-monitor-table">
        <thead>
          <tr>
            <th>{t("agentMonitor.connection.session")}</th>
            <th>{t("agentMonitor.connection.identity")}</th>
            <th>{t("agentMonitor.connection.status")}</th>
            <th>{t("agentMonitor.connection.lastSeen")}</th>
            <th>{t("agentMonitor.connection.messages")}</th>
            <th>{t("agentMonitor.connection.runtime")}</th>
          </tr>
        </thead>
        <tbody>
          {connections.map((connection) => (
            <tr key={connection.sessionId || `${connection.connectedAt}-${connection.remoteAddr}`}>
              <td>
                <code>{connection.sessionId || "-"}</code>
                <span className="agent-monitor-subtle">{connection.remoteAddr || "-"}</span>
              </td>
              <td>
                <strong>{readConnectionIdentity(connection)}</strong>
                <span className="agent-monitor-subtle">{connection.userAgent || "-"}</span>
              </td>
              <td>
                <ConnectionStatus connection={connection} />
              </td>
              <td>
                <span>{formatTimestamp(connection.lastSeenAt || connection.connectedAt, locale)}</span>
                <span className="agent-monitor-subtle">{formatTimestamp(connection.lastMessageAt, locale)}</span>
              </td>
              <td>
                <span>{formatCount(connection.receivedMessages)} / {formatCount(connection.sentMessages)}</span>
                <span className="agent-monitor-subtle">{connection.errors > 0 ? `${connection.errors}` : "0"}</span>
              </td>
              <td>
                <span>{connection.inflightRequests} / {connection.activeStreams}</span>
                <span className="agent-monitor-subtle">{connection.writeQueueDepth}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MessagesTable({
  messages,
  locale
}: {
  messages: AgentPlatformMonitorMessage[];
  locale: string;
}) {
  const { t } = useI18n();
  if (messages.length === 0) {
    return <div className="agent-monitor-empty">{t("agentMonitor.empty.messages")}</div>;
  }

  return (
    <div className="agent-monitor-table-scroll">
      <table className="agent-monitor-table agent-monitor-message-table">
        <thead>
          <tr>
            <th>{t("agentMonitor.message.time")}</th>
            <th>{t("agentMonitor.message.direction")}</th>
            <th>{t("agentMonitor.message.type")}</th>
            <th>{t("agentMonitor.message.session")}</th>
            <th>{t("agentMonitor.message.size")}</th>
            <th>{t("agentMonitor.message.preview")}</th>
          </tr>
        </thead>
        <tbody>
          {messages.map((message) => (
            <tr key={`${message.seq}-${message.sessionId}-${message.timestamp}`}>
              <td>{formatTimestamp(message.timestamp, locale)}</td>
              <td>
                <span className={`agent-monitor-direction is-${message.direction || "unknown"}`}>
                  {message.direction || "-"}
                </span>
              </td>
              <td>
                <strong>{message.type || message.frame || "-"}</strong>
                <span className="agent-monitor-subtle">{message.id || "-"}</span>
              </td>
              <td><code>{message.sessionId || "-"}</code></td>
              <td>{formatBytes(message.sizeBytes)}</td>
              <td>
                <code className="agent-monitor-preview">
                  {message.error || message.payloadPreview || "-"}
                  {message.truncated ? t("agentMonitor.message.truncated") : ""}
                </code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AgentPlatformMonitorPage() {
  const { t, locale } = useI18n();
  const requestIdRef = useRef(0);
  const [state, setState] = useState<MonitorState>(() => createInitialMonitorState());
  const [sessionId, setSessionId] = useState("");
  const [isMaximized, setIsMaximized] = useState(false);
  const snapshot = state.snapshot;
  const sessionIds = useMemo(() => collectSessionIds(snapshot), [snapshot]);
  const activeConnectionCount = snapshot?.connections.connections.filter((connection) => connection.active).length ?? 0;
  const latestConnection = snapshot?.overview.ws.latestConnection ?? null;

  useEffect(() => {
    if (typeof window.electronAPI?.services?.onAgentPlatformMonitorMaximized === "function") {
      return window.electronAPI.services.onAgentPlatformMonitorMaximized((maximized) => {
        setIsMaximized(maximized);
      });
    }
  }, []);

  useEffect(() => {
    void loadSnapshot("");
    return () => {
      requestIdRef.current += 1;
    };
  }, []);

  async function loadSnapshot(nextSessionId = sessionId) {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setState((current) => ({
      ...current,
      loading: !current.snapshot,
      refreshing: Boolean(current.snapshot),
      error: ""
    }));

    try {
      const result = await window.electronAPI.services.readAgentPlatformMonitor({
        sessionId: nextSessionId,
        connectionLimit: DEFAULT_CONNECTION_LIMIT,
        messageLimit: DEFAULT_MESSAGE_LIMIT
      });
      if (requestIdRef.current !== requestId) {
        return;
      }
      if (!result.ok) {
        setState((current) => ({
          ...current,
          loading: false,
          refreshing: false,
          error: result.message
        }));
        return;
      }
      setState({
        loading: false,
        refreshing: false,
        error: "",
        snapshot: result.snapshot
      });
    } catch (error) {
      if (requestIdRef.current !== requestId) {
        return;
      }
      setState((current) => ({
        ...current,
        loading: false,
        refreshing: false,
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  function handleSessionChange(value: string) {
    setSessionId(value);
    void loadSnapshot(value);
  }

  return (
    <main className="agent-monitor-page">
      <div className={`agent-monitor-window-drag-zone ${windowPlatformClass}`} />
      <section className="agent-monitor-panel" aria-labelledby="agent-monitor-title">
        <header className="agent-monitor-head">
          <div className="agent-monitor-title-copy">
            <h1 id="agent-monitor-title">{t("agentMonitor.title")}</h1>
            <p>{t("agentMonitor.subtitle")}</p>
          </div>
          <div className="agent-monitor-actions">
            <button
              type="button"
              className="agent-monitor-icon-button is-refresh"
              onClick={() => void loadSnapshot()}
              disabled={state.loading || state.refreshing}
              aria-label={state.refreshing ? t("agentMonitor.refreshing") : t("agentMonitor.refresh")}
              title={state.refreshing ? t("agentMonitor.refreshing") : t("agentMonitor.refresh")}
            >
              <RefreshIcon />
            </button>
            <button
              type="button"
              className="agent-monitor-control-button"
              onClick={() => void window.electronAPI.services.minimizeAgentPlatformMonitor()}
              aria-label={t("logViewer.window.minimize")}
              title={t("logViewer.window.minimize")}
            >
              <MinimizeIcon />
            </button>
            <button
              type="button"
              className="agent-monitor-control-button"
              onClick={() => void window.electronAPI.services.maximizeAgentPlatformMonitor()}
              aria-label={isMaximized ? t("logViewer.window.restore") : t("logViewer.window.maximize")}
              title={isMaximized ? t("logViewer.window.restore") : t("logViewer.window.maximize")}
            >
              <MaximizeIcon restored={isMaximized} />
            </button>
            <button
              type="button"
              className="agent-monitor-control-button close"
              onClick={() => void window.electronAPI.services.closeAgentPlatformMonitor()}
              aria-label={t("logViewer.window.close")}
              title={t("logViewer.window.close")}
            >
              <CloseIcon />
            </button>
          </div>
        </header>

        <div className="agent-monitor-toolbar">
          <div className="agent-monitor-filter">
            <label htmlFor="agent-monitor-session">{t("agentMonitor.filter.session")}</label>
            <select
              id="agent-monitor-session"
              value={sessionId}
              onChange={(event) => handleSessionChange(event.target.value)}
              disabled={state.loading || state.refreshing}
            >
              <option value="">{t("agentMonitor.filter.allSessions")}</option>
              {sessionIds.map((id) => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>
            {sessionId ? (
              <button type="button" onClick={() => handleSessionChange("")}>
                {t("agentMonitor.filter.clear")}
              </button>
            ) : null}
          </div>
          <span className={`agent-monitor-load-state${state.refreshing ? " is-refreshing" : ""}`}>
            {state.loading
              ? t("agentMonitor.loading")
              : state.refreshing
                ? t("agentMonitor.refreshing")
                : snapshot
                  ? t("agentMonitor.status.loaded")
                  : t("agentMonitor.status.idle")}
          </span>
        </div>

        {state.error ? (
          <div className="agent-monitor-error" role="alert">
            <strong>{t("agentMonitor.error.title")}</strong>
            <span>{state.error}</span>
          </div>
        ) : null}

        <div className="agent-monitor-content">
          <section className="agent-monitor-metrics" aria-label={t("agentMonitor.metrics.ariaLabel")}>
            <div className="agent-monitor-metric">
              <span>{t("agentMonitor.metrics.connectionCount")}</span>
              <strong>{snapshot?.overview.ws.connectionCount ?? 0}</strong>
            </div>
            <div className="agent-monitor-metric">
              <span>{t("agentMonitor.metrics.activeConnections")}</span>
              <strong>{activeConnectionCount}</strong>
            </div>
            <div className="agent-monitor-metric">
              <span>{t("agentMonitor.metrics.recentMessages")}</span>
              <strong>{snapshot?.messages.messages.length ?? 0}</strong>
            </div>
            <div className="agent-monitor-metric">
              <span>{t("agentMonitor.metrics.generatedAt")}</span>
              <strong>{snapshot ? formatTimestamp(snapshot.overview.generatedAt, locale) : "-"}</strong>
            </div>
          </section>

          <section className="agent-monitor-latest">
            <div>
              <span>{t("agentMonitor.latest.title")}</span>
              <strong>{latestConnection?.sessionId || "-"}</strong>
            </div>
            <div>
              <span>{t("agentMonitor.latest.identity")}</span>
              <strong>{latestConnection ? readConnectionIdentity(latestConnection) : "-"}</strong>
            </div>
            <div>
              <span>{t("agentMonitor.latest.lastSeen")}</span>
              <strong>{latestConnection ? formatTimestamp(latestConnection.lastSeenAt || latestConnection.connectedAt, locale) : "-"}</strong>
            </div>
          </section>

          <section className="agent-monitor-section">
            <div className="agent-monitor-section-head">
              <h2>{t("agentMonitor.connections.title")}</h2>
              <span>{t("agentMonitor.connections.subtitle")}</span>
            </div>
            {state.loading ? (
              <div className="agent-monitor-empty">{t("agentMonitor.loading")}</div>
            ) : (
              <ConnectionsTable connections={snapshot?.connections.connections ?? []} locale={locale} />
            )}
          </section>

          <section className="agent-monitor-section">
            <div className="agent-monitor-section-head">
              <h2>{t("agentMonitor.messages.title")}</h2>
              <span>{t("agentMonitor.messages.subtitle")}</span>
            </div>
            {state.loading ? (
              <div className="agent-monitor-empty">{t("agentMonitor.loading")}</div>
            ) : (
              <MessagesTable messages={snapshot?.messages.messages ?? []} locale={locale} />
            )}
          </section>
        </div>
      </section>
    </main>
  );
}
