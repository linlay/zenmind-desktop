import { useEffect, useMemo, useState } from "react";
import type { DebugEvent, DebugRequestEvent, DebugSanitizedHeaders } from "../../shared/contracts/debug";

type EventKindFilter = "all" | DebugEvent["kind"];
type StatusFilter = "all" | "failed" | "warning" | "ok";

function formatTime(value: number | undefined) {
  if (!value) {
    return "-";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3
  }).format(new Date(value));
}

function getHostname(value: string | undefined) {
  if (!value) {
    return "";
  }
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}

function getSourceLabel(event: DebugEvent) {
  return event.source.surfaceLabel || event.source.surfaceId || `WebContents ${event.webContentsId}`;
}

function getEventMainText(event: DebugEvent) {
  if (event.kind === "request") {
    return event.url;
  }
  if (event.kind === "console") {
    return event.message;
  }
  return event.url || event.details || event.stage;
}

function getEventTone(event: DebugEvent) {
  if (event.kind === "request") {
    if (event.error || (event.statusCode ?? 0) >= 400) {
      return "failed";
    }
    return "ok";
  }
  if (event.kind === "console") {
    return event.level === "error" ? "failed" : event.level === "warning" ? "warning" : "ok";
  }
  return event.stage === "did-fail-load" || event.stage === "render-process-gone" ? "failed" : "ok";
}

function getEventKindLabel(kind: DebugEvent["kind"]) {
  if (kind === "request") {
    return "请求";
  }
  if (kind === "console") {
    return "Console";
  }
  return "加载";
}

function getStatusLabel(event: DebugEvent) {
  if (event.kind === "request") {
    if (event.error) {
      return event.error;
    }
    return event.statusCode ? String(event.statusCode) : "等待";
  }
  if (event.kind === "console") {
    return event.level;
  }
  return event.stage;
}

function getRequestSummary(event: DebugRequestEvent) {
  const status = event.error || event.statusCode || "等待";
  const duration = event.durationMs === undefined ? "-" : `${event.durationMs}ms`;
  return `${event.method} · ${event.resourceType} · ${status} · ${duration}`;
}

function HeaderTable({ title, headers }: { title: string; headers: DebugSanitizedHeaders }) {
  const entries = Object.entries(headers);
  return (
    <section className="debug-viewer-header-block">
      <h3>{title}</h3>
      {entries.length === 0 ? (
        <p className="debug-viewer-empty-line">暂无 headers</p>
      ) : (
        <dl>
          {entries.map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

function EventDetail({
  event,
  onOpenDevTools
}: {
  event: DebugEvent | null;
  onOpenDevTools: (webContentsId: number) => void;
}) {
  if (!event) {
    return (
      <aside className="debug-viewer-detail is-empty">
        <span>选择一条记录查看详情</span>
      </aside>
    );
  }

  return (
    <aside className="debug-viewer-detail">
      <div className="debug-viewer-detail-head">
        <div>
          <span>{getEventKindLabel(event.kind)}</span>
          <h2>{getSourceLabel(event)}</h2>
        </div>
        <button type="button" onClick={() => onOpenDevTools(event.webContentsId)}>
          打开 DevTools
        </button>
      </div>
      <dl className="debug-viewer-meta-grid">
        <div>
          <dt>来源</dt>
          <dd>{getSourceLabel(event)}</dd>
        </div>
        <div>
          <dt>WebContents</dt>
          <dd>{event.webContentsId}</dd>
        </div>
        <div>
          <dt>时间</dt>
          <dd>{formatTime(event.createdAt)}</dd>
        </div>
        <div>
          <dt>状态</dt>
          <dd>{getStatusLabel(event)}</dd>
        </div>
      </dl>
      {event.kind === "request" ? (
        <>
          <div className="debug-viewer-url-block">
            <span>{getRequestSummary(event)}</span>
            <code>{event.url}</code>
          </div>
          <dl className="debug-viewer-meta-grid">
            <div>
              <dt>开始</dt>
              <dd>{formatTime(event.startedAt)}</dd>
            </div>
            <div>
              <dt>完成</dt>
              <dd>{formatTime(event.completedAt)}</dd>
            </div>
            <div>
              <dt>缓存</dt>
              <dd>{event.fromCache ? "是" : "否"}</dd>
            </div>
            <div>
              <dt>Status line</dt>
              <dd>{event.statusLine || "-"}</dd>
            </div>
          </dl>
          <HeaderTable title="Request headers" headers={event.requestHeaders} />
          <HeaderTable title="Response headers" headers={event.responseHeaders} />
        </>
      ) : (
        <div className="debug-viewer-url-block">
          <span>{event.kind === "console" ? event.level : event.stage}</span>
          <code>{getEventMainText(event)}</code>
        </div>
      )}
    </aside>
  );
}

export function DebugViewerPage() {
  const [events, setEvents] = useState<DebugEvent[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<EventKindFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.debug.listEvents()
      .then((nextEvents) => {
        if (!cancelled) {
          setEvents(nextEvents);
          setSelectedId(nextEvents.at(-1)?.id ?? "");
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setMessage(reason instanceof Error ? reason.message : String(reason));
        }
      });

    const unsubscribe = window.electronAPI.debug.onEvent((event) => {
      setEvents((currentEvents) => [...currentEvents, event].slice(-1000));
      setSelectedId((currentId) => currentId || event.id);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const sources = useMemo(() => {
    const map = new Map<number, string>();
    for (const event of events) {
      map.set(event.webContentsId, getSourceLabel(event));
    }
    return [...map.entries()].map(([webContentsId, label]) => ({ webContentsId, label }));
  }, [events]);

  const filteredEvents = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return events
      .filter((event) => kindFilter === "all" || event.kind === kindFilter)
      .filter((event) => {
        if (sourceFilter === "all") {
          return true;
        }
        return String(event.webContentsId) === sourceFilter;
      })
      .filter((event) => {
        if (statusFilter === "all") {
          return true;
        }
        return getEventTone(event) === statusFilter;
      })
      .filter((event) => {
        if (!normalizedQuery) {
          return true;
        }
        return [
          getSourceLabel(event),
          getEventMainText(event),
          event.kind === "request" ? event.method : "",
          event.kind === "request" ? String(event.statusCode ?? "") : "",
          event.kind === "request" ? getHostname(event.url) : ""
        ].some((value) => value.toLowerCase().includes(normalizedQuery));
      })
      .slice()
      .reverse();
  }, [events, kindFilter, query, sourceFilter, statusFilter]);

  const selectedEvent = useMemo(
    () => events.find((event) => event.id === selectedId) ?? filteredEvents[0] ?? null,
    [events, filteredEvents, selectedId]
  );

  async function handleClearEvents() {
    await window.electronAPI.debug.clearEvents();
    setEvents([]);
    setSelectedId("");
  }

  async function handleOpenDevTools(webContentsId: number) {
    const result = await window.electronAPI.debug.openWebviewDevTools(webContentsId);
    setMessage(result.ok ? "DevTools 已打开。" : result.message || "打开 DevTools 失败。");
  }

  return (
    <main className="debug-viewer-page">
      <header className="debug-viewer-toolbar">
        <div className="debug-viewer-title">
          <span>ZenMind Debug</span>
          <h1>内嵌网页调试</h1>
        </div>
        <div className="debug-viewer-actions">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索 URL、来源、状态"
            aria-label="搜索调试事件"
          />
          <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)} aria-label="来源筛选">
            <option value="all">全部来源</option>
            {sources.map((source) => (
              <option value={String(source.webContentsId)} key={source.webContentsId}>
                {source.label}
              </option>
            ))}
          </select>
          <select value={kindFilter} onChange={(event) => setKindFilter(event.target.value as EventKindFilter)} aria-label="类型筛选">
            <option value="all">全部类型</option>
            <option value="request">请求</option>
            <option value="console">Console</option>
            <option value="load">加载</option>
          </select>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)} aria-label="状态筛选">
            <option value="all">全部状态</option>
            <option value="failed">失败</option>
            <option value="warning">警告</option>
            <option value="ok">正常</option>
          </select>
          <button type="button" onClick={handleClearEvents}>清空</button>
          <button type="button" onClick={() => void window.electronAPI.debug.closeViewer()}>关闭</button>
        </div>
      </header>
      {message ? (
        <div className="debug-viewer-message" role="status">
          {message}
        </div>
      ) : null}
      <section className="debug-viewer-layout">
        <div className="debug-viewer-list" role="list" aria-label="调试事件列表">
          {filteredEvents.length === 0 ? (
            <div className="debug-viewer-empty">等待内嵌网页请求或日志事件。</div>
          ) : filteredEvents.map((event) => (
            <button
              type="button"
              role="listitem"
              className={`debug-viewer-row is-${getEventTone(event)}${selectedEvent?.id === event.id ? " is-selected" : ""}`}
              key={event.id}
              onClick={() => setSelectedId(event.id)}
            >
              <span className="debug-viewer-row-time">{formatTime(event.createdAt)}</span>
              <span className="debug-viewer-row-kind">{getEventKindLabel(event.kind)}</span>
              <span className="debug-viewer-row-source">{getSourceLabel(event)}</span>
              <span className="debug-viewer-row-main">{getEventMainText(event)}</span>
              <span className="debug-viewer-row-status">{getStatusLabel(event)}</span>
            </button>
          ))}
        </div>
        <EventDetail event={selectedEvent} onOpenDevTools={(webContentsId) => void handleOpenDevTools(webContentsId)} />
      </section>
    </main>
  );
}
