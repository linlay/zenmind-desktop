import { CloseOutlined, CopyOutlined, DeleteOutlined, DownOutlined, DownloadOutlined, UpOutlined } from "@ant-design/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type {
  AgentRealtimeDebugSnapshot,
  AgentRealtimeDebugTraceDirection,
  AgentRealtimeDebugTraceEntry,
  AgentRealtimeDebugTraceLayer,
  AgentRealtimeRecordingEventFilter,
  AgentRealtimeRecordingEventPage,
  AgentRealtimeRecordingSample,
  AgentRealtimeRecordingSummary,
  EpochMilliseconds,
} from "../../shared/contracts";
import { useI18n } from "../i18n/useI18n";

const PAGE_SIZE = 200;
const EVENT_DETAIL_DEFAULT_HEIGHT = 260;
const EVENT_DETAIL_MIN_HEIGHT = 160;
const EVENT_DETAIL_MAX_HEIGHT = 640;
const EVENT_LIST_MIN_HEIGHT = 120;
const EVENT_DETAIL_RESERVED_HEIGHT = 142;

function constrainEventDetailHeight(height: number, availableHeight: number) {
  const availableMaximum = Math.max(
    EVENT_DETAIL_MIN_HEIGHT,
    availableHeight - EVENT_LIST_MIN_HEIGHT - EVENT_DETAIL_RESERVED_HEIGHT,
  );
  return Math.round(Math.min(Math.max(height, EVENT_DETAIL_MIN_HEIGHT), EVENT_DETAIL_MAX_HEIGHT, availableMaximum));
}

function formatBytes(bytes: number) {
  const sign = bytes < 0 ? "−" : "";
  const absolute = Math.abs(bytes);
  if (absolute < 1024) return `${sign}${absolute} B`;
  if (absolute < 1024 * 1024) return `${sign}${(absolute / 1024).toFixed(1)} KB`;
  return `${sign}${(absolute / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(startedAt: number, endedAt = Date.now()) {
  const totalSeconds = Math.max(0, Math.floor((endedAt - startedAt) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function directionGlyph(direction: AgentRealtimeDebugTraceDirection) {
  if (direction === "desktop-to-platform") return "D → P";
  if (direction === "platform-to-desktop") return "P → D";
  if (direction === "surface-to-desktop") return "S → D";
  return "D → S";
}

function findTextMatches(value: string, query: string) {
  const needle = query.trim();
  if (!needle) return [];
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const expression = new RegExp(escaped, "giu");
  return [...value.matchAll(expression)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function RecordingMetricChart({ samples, pid }: { samples: AgentRealtimeRecordingSample[]; pid: number | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || pid === null) return;
    const points = samples.flatMap((sample) => {
      const process = sample.runtime.processes.find((item) => item.pid === pid);
      return process ? [{ time: Number(sample.sampledAt), memory: process.workingSetBytes, cpu: process.cpuPercent }] : [];
    });
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(520, canvas.clientWidth);
    const height = 180;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, height);
    if (points.length < 2) return;
    const padding = 18;
    const minTime = points[0].time;
    const maxTime = points.at(-1)!.time;
    const maxMemory = Math.max(...points.map((point) => point.memory), 1);
    const maxCpu = Math.max(...points.map((point) => point.cpu), 100);
    const draw = (color: string, read: (point: typeof points[number]) => number, max: number) => {
      context.strokeStyle = color;
      context.lineWidth = 1.75;
      context.beginPath();
      points.forEach((point, index) => {
        const x = padding + ((point.time - minTime) / Math.max(1, maxTime - minTime)) * (width - padding * 2);
        const y = height - padding - (read(point) / max) * (height - padding * 2);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.stroke();
    };
    draw("#5790ff", (point) => point.memory, maxMemory);
    draw("#f0a323", (point) => point.cpu, maxCpu);
  }, [pid, samples]);
  return <canvas ref={canvasRef} className="runtime-recording-chart" />;
}

export function AgentRealtimeRecordingPanel({
  surfaceId,
  runtime,
}: {
  surfaceId?: string;
  runtime?: AgentRealtimeDebugSnapshot["runtime"];
}) {
  const { locale, t } = useI18n();
  const [recordings, setRecordings] = useState<AgentRealtimeRecordingSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<"overview" | "events" | "metrics">("overview");
  const [page, setPage] = useState<AgentRealtimeRecordingEventPage>({ items: [], total: 0 });
  const [cursor, setCursor] = useState(0);
  const [samples, setSamples] = useState<AgentRealtimeRecordingSample[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<AgentRealtimeDebugTraceEntry | null>(null);
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [detailSearch, setDetailSearch] = useState("");
  const [detailMatchIndex, setDetailMatchIndex] = useState(0);
  const [eventDetailHeight, setEventDetailHeight] = useState(EVENT_DETAIL_DEFAULT_HEIGHT);
  const [eventDetailResizing, setEventDetailResizing] = useState(false);
  const [layer, setLayer] = useState<"all" | AgentRealtimeDebugTraceLayer>("all");
  const [direction, setDirection] = useState<"all" | AgentRealtimeDebugTraceDirection>("all");
  const [lane, setLane] = useState<"all" | "primary" | "btw">("all");
  const [eventName, setEventName] = useState("all");
  const [associationId, setAssociationId] = useState("");
  const [fromTime, setFromTime] = useState("");
  const [toTime, setToTime] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [liveRefreshVersion, setLiveRefreshVersion] = useState(0);
  const [liveEventTypes, setLiveEventTypes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const requestVersion = useRef(0);
  const detailRequestVersion = useRef(0);
  const eventsPanelRef = useRef<HTMLDivElement | null>(null);
  const detailResizeCleanupRef = useRef<(() => void) | null>(null);
  const detailMatchRefs = useRef<Array<HTMLElement | null>>([]);

  const selected = recordings.find((item) => item.id === selectedId) || null;
  const active = recordings.find((item) => item.state === "recording" || item.state === "preparing" || item.state === "finalizing") || null;
  const deletableRecordings = recordings.filter((item) => item.state === "completed" || item.state === "incomplete");
  const analyzable = selected?.state === "completed" || selected?.state === "incomplete";
  const liveMode = !selected;
  const eventRecording = analyzable ? selected : null;
  const eventRecordingId = eventRecording?.id || null;
  const eventRecordingCount = eventRecording?.eventCount || 0;
  const liveQueryVersion = liveMode ? liveRefreshVersion : 0;

  function errorMessage(error: unknown) {
    const raw = error instanceof Error ? error.message : String(error);
    return raw.includes("No handler registered for 'diagnostics.")
      ? t("settings.debug.realtime.recording.restartRequired")
      : raw;
  }

  function availableEventsHeight() {
    return eventsPanelRef.current?.clientHeight || window.innerHeight;
  }

  function handleEventDetailPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    detailResizeCleanupRef.current?.();
    const resizer = event.currentTarget;
    const pointerId = event.pointerId;
    const startClientY = event.clientY;
    const startHeight = eventDetailHeight;
    try {
      resizer.setPointerCapture(pointerId);
    } catch {
      // Window-level listeners keep the drag active when capture is unavailable.
    }
    const handlePointerMove = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      if (pointerEvent.cancelable) pointerEvent.preventDefault();
      setEventDetailHeight(constrainEventDetailHeight(
        startHeight + startClientY - pointerEvent.clientY,
        availableEventsHeight(),
      ));
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerup", handlePointerEnd, true);
      window.removeEventListener("pointercancel", handlePointerEnd, true);
      window.removeEventListener("blur", cleanup);
      if (detailResizeCleanupRef.current === cleanup) detailResizeCleanupRef.current = null;
      setEventDetailResizing(false);
      try {
        if (resizer.hasPointerCapture(pointerId)) resizer.releasePointerCapture(pointerId);
      } catch {
        // Pointer capture may already be released after leaving the window.
      }
    };
    const handlePointerEnd = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId === pointerId) cleanup();
    };
    detailResizeCleanupRef.current = cleanup;
    setEventDetailResizing(true);
    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("pointerup", handlePointerEnd, true);
    window.addEventListener("pointercancel", handlePointerEnd, true);
    window.addEventListener("blur", cleanup);
  }

  function handleEventDetailKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    let nextHeight: number | null = null;
    if (event.key === "ArrowUp") nextHeight = eventDetailHeight + 20;
    if (event.key === "ArrowDown") nextHeight = eventDetailHeight - 20;
    if (event.key === "Home") nextHeight = EVENT_DETAIL_MIN_HEIGHT;
    if (event.key === "End") nextHeight = EVENT_DETAIL_MAX_HEIGHT;
    if (nextHeight === null) return;
    event.preventDefault();
    setEventDetailHeight(constrainEventDetailHeight(nextHeight, availableEventsHeight()));
  }

  async function refreshRecordings() {
    try {
      const next = await window.electronAPI.diagnostics.listAgentRealtimeRecordings();
      setRecordings(next);
      setSelectedId((current) => current && next.some((item) => item.id === current) ? current : null);
      setMessage("");
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  useEffect(() => {
    void window.electronAPI.diagnostics.setAgentRealtimeLiveEventsEnabled({ enabled: true })
      .catch((error) => setMessage(errorMessage(error)));
    void refreshRecordings();
    const timer = window.setInterval(() => {
      void refreshRecordings();
      setLiveRefreshVersion((current) => current + 1);
    }, 500);
    const handleResize = () => setEventDetailHeight((current) =>
      constrainEventDetailHeight(current, availableEventsHeight()));
    window.addEventListener("resize", handleResize);
    return () => {
      window.clearInterval(timer);
      void window.electronAPI.diagnostics.setAgentRealtimeLiveEventsEnabled({ enabled: false }).catch(() => undefined);
      window.removeEventListener("resize", handleResize);
      detailResizeCleanupRef.current?.();
    };
  }, []);

  useEffect(() => {
    setCursor(0);
    detailRequestVersion.current += 1;
    setSelectedEvent(null);
    setDetailSearch("");
  }, [associationId, direction, errorsOnly, eventName, eventRecordingId, fromTime, lane, layer, search, surfaceId, toTime]);

  useEffect(() => {
    if (!liveMode && !eventRecordingId) {
      setPage({ items: [], total: 0 });
      setSamples([]);
      return;
    }
    const version = ++requestVersion.current;
    const from = fromTime ? new Date(fromTime).getTime() as EpochMilliseconds : undefined;
    const to = toTime ? new Date(toTime).getTime() as EpochMilliseconds : undefined;
    const filter: AgentRealtimeRecordingEventFilter = {
      cursor,
      limit: PAGE_SIZE,
      order: liveMode ? "desc" : "asc",
      ...(surfaceId ? { surfaceId } : {}),
      ...(layer !== "all" ? { layer } : {}),
      ...(direction !== "all" ? { direction } : {}),
      ...(lane !== "all" ? { lane } : {}),
      ...(eventName !== "all" ? { eventName } : {}),
      ...(associationId.trim() ? { associationId: associationId.trim() } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(search.trim() ? { query: search.trim() } : {}),
      ...(errorsOnly ? { errorsOnly: true } : {}),
    };
    void Promise.all([
      liveMode
        ? window.electronAPI.diagnostics.queryAgentRealtimeLiveEvents({ filter })
        : window.electronAPI.diagnostics.queryAgentRealtimeRecordingEvents({ recordingId: eventRecordingId!, filter }),
      !liveMode && analyzable
        ? window.electronAPI.diagnostics.getAgentRealtimeRecordingSamples({ recordingId: eventRecordingId!, from, to })
        : Promise.resolve([]),
    ]).then(([nextPage, nextSamples]) => {
      if (requestVersion.current !== version) return;
      setPage(nextPage);
      setSamples(nextSamples);
      if (liveMode) {
        setLiveEventTypes((current) => [...new Set([
          ...current,
          ...nextPage.items.map((item) => item.name),
        ])].sort());
      }
      const firstPid = nextSamples.flatMap((sample) => sample.runtime.processes.map((item) => item.pid))[0];
      const pids = new Set(nextSamples.flatMap((sample) => sample.runtime.processes.map((item) => item.pid)));
      setSelectedPid((current) => current !== null && pids.has(current) ? current : firstPid ?? null);
    }).catch((error) => {
      if (requestVersion.current === version) setMessage(errorMessage(error));
    });
  }, [analyzable, associationId, cursor, direction, errorsOnly, eventName, eventRecordingCount, eventRecordingId, fromTime, lane, layer, liveMode, liveQueryVersion, search, surfaceId, toTime]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      await refreshRecordings();
      setMessage("");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const processOptions = useMemo(() => {
    const values = new Map<number, string>();
    samples.forEach((sample) => sample.runtime.processes.forEach((process) => {
      values.set(process.pid, `${process.type} · PID ${process.pid}`);
    }));
    return [...values.entries()];
  }, [samples]);
  const eventTypeOptions = useMemo(() => selected
    ? Object.keys(selected.eventTypeCounts).sort()
    : liveEventTypes, [liveEventTypes, selected]);

  const selectedProcessPoints = selectedPid === null ? [] : samples.flatMap((sample) => {
    const process = sample.runtime.processes.find((item) => item.pid === selectedPid);
    return process ? [process] : [];
  });
  const memoryDelta = selectedProcessPoints.length > 1
    ? selectedProcessPoints.at(-1)!.workingSetBytes - selectedProcessPoints[0].workingSetBytes
    : 0;
  const durationSeconds = selected
    ? Math.max(1, (Number(selected.endedAt || Date.now()) - Number(selected.startedAt)) / 1_000)
    : 1;
  const detailJson = selectedEvent ? JSON.stringify(selectedEvent.data, null, 2) : "";
  const detailMatches = useMemo(() => findTextMatches(detailJson, detailSearch), [detailJson, detailSearch]);
  const activeDetailMatchIndex = detailMatches.length > 0
    ? Math.min(detailMatchIndex, detailMatches.length - 1)
    : 0;
  const highlightedDetailJson = useMemo(() => {
    if (detailMatches.length === 0) return detailJson;
    const content: ReactNode[] = [];
    let offset = 0;
    detailMatches.forEach((match, index) => {
      if (match.start > offset) content.push(detailJson.slice(offset, match.start));
      content.push(
        <mark
          key={`${match.start}-${match.end}`}
          ref={(element) => { detailMatchRefs.current[index] = element; }}
          className={index === activeDetailMatchIndex ? "is-current" : ""}
        >
          {detailJson.slice(match.start, match.end)}
        </mark>,
      );
      offset = match.end;
    });
    if (offset < detailJson.length) content.push(detailJson.slice(offset));
    return content;
  }, [activeDetailMatchIndex, detailJson, detailMatches]);

  useEffect(() => {
    setDetailMatchIndex(0);
  }, [detailJson, detailSearch]);

  useEffect(() => {
    if (detailMatches.length === 0) return;
    detailMatchRefs.current[activeDetailMatchIndex]?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [activeDetailMatchIndex, detailJson, detailMatches.length, detailSearch]);

  function moveDetailMatch(delta: number) {
    if (detailMatches.length === 0) return;
    setDetailMatchIndex((current) => (current + delta + detailMatches.length) % detailMatches.length);
  }

  function handleDetailSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setDetailSearch("");
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    moveDetailMatch(event.shiftKey ? -1 : 1);
  }

  return (
    <section className="runtime-recordings">
      <aside className="runtime-recording-sidebar">
        <div className="runtime-recording-command">
          <button
            type="button"
            className="is-primary"
            disabled={busy || Boolean(active)}
            onClick={() => void run(async () => {
              const created = await window.electronAPI.diagnostics.startAgentRealtimeRecording();
              setSelectedId(created.id);
            })}
          >
            {t("settings.debug.realtime.recording.start")}
          </button>
          <button
            type="button"
            className="is-stop"
            disabled={busy || !active || active.state !== "recording"}
            onClick={() => void run(() => window.electronAPI.diagnostics.stopAgentRealtimeRecording())}
          >
            {active?.state === "finalizing"
              ? t("settings.debug.realtime.recording.finalizing")
              : t("settings.debug.realtime.recording.stop")}
          </button>
          <button
            type="button"
            className="is-clear"
            disabled={busy || deletableRecordings.length === 0}
            onClick={() => {
              if (!window.confirm(t("settings.debug.realtime.recording.clearConfirm"))) return;
              void run(async () => {
                for (const recording of deletableRecordings) {
                  await window.electronAPI.diagnostics.deleteAgentRealtimeRecording({ recordingId: recording.id });
                }
              });
            }}
          >
            <DeleteOutlined />
            {t("settings.debug.realtime.recording.clear")}
          </button>
          <p>{t("settings.debug.realtime.recording.lifecycleHint")}</p>
        </div>
        <div className="runtime-recording-list">
          {recordings.map((recording) => (
            <button
              key={recording.id}
              type="button"
              className={selectedId === recording.id ? "is-selected" : ""}
              onClick={() => setSelectedId(recording.id)}
            >
              <strong>{recording.name}</strong>
              <span>{new Date(Number(recording.startedAt)).toLocaleTimeString(locale)} · {formatDuration(Number(recording.startedAt), Number(recording.endedAt || Date.now()))}</span>
              <span>{recording.eventCount} {t("settings.debug.realtime.recording.events")} · {formatBytes(recording.bytes)}</span>
              <em className={`is-${recording.state}`}>{t(`settings.debug.realtime.recording.state.${recording.state}`)}</em>
            </button>
          ))}
          {recordings.length === 0 ? <div className="runtime-empty">{t("settings.debug.realtime.recording.empty")}</div> : null}
        </div>
      </aside>

      <div className="runtime-recording-content">
        {message ? <div className="runtime-observer-error" role="status">{message}</div> : null}
        {selected && !analyzable ? (
          <>
            <header className="runtime-recording-header">
              <div>
                <h2>{selected.name}</h2>
                <span>{new Date(Number(selected.startedAt)).toLocaleString(locale)}</span>
              </div>
              <div className="runtime-recording-actions">
                <button type="button" title={t("settings.debug.realtime.recording.closeSnapshot")} onClick={() => setSelectedId(null)}><CloseOutlined /></button>
              </div>
            </header>
            <div className="runtime-recording-progress">
              <span className="runtime-recording-dot" />
              <h2>{selected.state === "finalizing" ? t("settings.debug.realtime.recording.finalizing") : t("settings.debug.realtime.recording.recording")}</h2>
              <strong>{formatDuration(Number(selected.startedAt))}</strong>
              <p>{selected.eventCount} {t("settings.debug.realtime.recording.events")} · {formatBytes(selected.bytes)}</p>
              {runtime ? (
                <div className="runtime-recording-live-metrics">
                  <span><b>{formatBytes(runtime.totalWorkingSetBytes)}</b> RSS</span>
                  <span><b>{runtime.processes.reduce((total, process) => total + process.cpuPercent, 0).toFixed(1)}%</b> CPU</span>
                  <span><b>{runtime.processes.length}</b> PID</span>
                  <span><b>{runtime.surfaceCount}</b> {t("settings.debug.realtime.surfaceShort")}</span>
                  <span><b>{runtime.webviewCount}</b> WebViews</span>
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <header className="runtime-recording-header">
              <div>
                <h2>{selected ? selected.name : t("settings.debug.realtime.recording.liveEvents")}</h2>
                <span>{selected
                  ? `${new Date(Number(selected.startedAt)).toLocaleString(locale)} – ${selected.endedAt ? new Date(Number(selected.endedAt)).toLocaleString(locale) : "—"}`
                  : t("settings.debug.realtime.recording.liveEventsHint")}</span>
              </div>
              <div className="runtime-recording-actions">
                {selected ? (
                  <>
                    <button type="button" title={t("settings.debug.realtime.recording.export")} onClick={() => void run(() => window.electronAPI.diagnostics.exportAgentRealtimeRecording({ recordingId: selected.id }))}><DownloadOutlined /></button>
                    <button type="button" className="is-danger" title={t("settings.debug.realtime.recording.delete")} onClick={() => {
                      if (window.confirm(t("settings.debug.realtime.recording.deleteConfirm"))) {
                        void run(() => window.electronAPI.diagnostics.deleteAgentRealtimeRecording({ recordingId: selected.id }));
                      }
                    }}><DeleteOutlined /></button>
                    <button type="button" title={t("settings.debug.realtime.recording.closeSnapshot")} onClick={() => setSelectedId(null)}><CloseOutlined /></button>
                  </>
                ) : null}
              </div>
            </header>
            {selected?.state === "incomplete" ? (
              <div className="runtime-recording-incomplete">{t("settings.debug.realtime.recording.incomplete")}: {selected.incompleteReason}</div>
            ) : null}
            {selected ? <nav className="runtime-recording-tabs">
              {(["overview", "events", "metrics"] as const).map((item) => (
                <button key={item} type="button" className={tab === item ? "is-active" : ""} onClick={() => setTab(item)}>
                  {t(`settings.debug.realtime.recording.tab.${item}`)}
                </button>
              ))}
            </nav> : null}

            {selected && tab === "overview" ? (
              <div className="runtime-recording-overview">
                <article><span>{t("settings.debug.realtime.recording.events")}</span><strong>{selected.eventCount}</strong></article>
                <article><span>{t("settings.debug.realtime.recording.errors")}</span><strong>{selected.errorCount}</strong></article>
                <article><span>{t("settings.debug.realtime.recording.duration")}</span><strong>{formatDuration(Number(selected.startedAt), Number(selected.endedAt || Date.now()))}</strong></article>
                <article><span>{t("settings.debug.realtime.recording.size")}</span><strong>{formatBytes(selected.bytes)}</strong></article>
                <article><span>{t("settings.debug.realtime.recording.samples")}</span><strong>{selected.sampleCount}</strong></article>
                <article><span>{t("settings.debug.realtime.recording.integrity")}</span><strong>{t(`settings.debug.realtime.recording.state.${selected.state}`)}</strong></article>
                <article><span>{t("settings.debug.realtime.recording.rate")}</span><strong>{(selected.eventCount / durationSeconds).toFixed(1)}/s</strong></article>
                <article className="runtime-recording-distribution"><span>{t("settings.debug.realtime.recording.directionDistribution")}</span><strong>{Object.entries(selected.directionCounts).map(([key, count]) => `${key}: ${count}`).join(" · ") || "—"}</strong></article>
                <article className="runtime-recording-distribution"><span>{t("settings.debug.realtime.recording.typeDistribution")}</span><strong>{Object.entries(selected.eventTypeCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([key, count]) => `${key}: ${count}`).join(" · ") || "—"}</strong></article>
              </div>
            ) : null}

            {(!selected || tab === "events") ? (
              <div
                ref={eventsPanelRef}
                className={`runtime-recording-events${selectedEvent ? " has-detail" : ""}${eventDetailResizing ? " is-resizing-detail" : ""}`}
                style={selectedEvent ? {
                  gridTemplateRows: `auto 32px minmax(${EVENT_LIST_MIN_HEIGHT}px, 1fr) auto 8px ${eventDetailHeight}px`,
                } : undefined}
              >
                <div className="runtime-event-filters">
                  <input className="runtime-event-search" type="search" value={search} placeholder={t("settings.debug.realtime.recording.searchEvents")} onChange={(event) => setSearch(event.target.value)} />
                  <select value={layer} onChange={(event) => setLayer(event.target.value as typeof layer)}>
                    <option value="all">{t("settings.debug.realtime.all")}</option>
                    <option value="platform-ws">Platform WS</option>
                    <option value="surface-bridge">Surface Bridge</option>
                  </select>
                  <select value={direction} onChange={(event) => setDirection(event.target.value as typeof direction)}>
                    <option value="all">{t("settings.debug.realtime.allDirections")}</option>
                    <option value="platform-to-desktop">P → D</option>
                    <option value="desktop-to-platform">D → P</option>
                    <option value="surface-to-desktop">S → D</option>
                    <option value="desktop-to-surface">D → S</option>
                  </select>
                  <select value={lane} onChange={(event) => setLane(event.target.value as typeof lane)}>
                    <option value="all">Lane: {t("settings.debug.realtime.all")}</option>
                    <option value="primary">primary</option>
                    <option value="btw">btw</option>
                  </select>
                  <select value={eventName} onChange={(event) => setEventName(event.target.value)}>
                    <option value="all">{t("settings.debug.realtime.recording.allTypes")}</option>
                    {eventTypeOptions.map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                  <input type="search" value={associationId} placeholder={t("settings.debug.realtime.recording.associationId")} onChange={(event) => setAssociationId(event.target.value)} />
                  <label>{t("settings.debug.realtime.recording.from")} <input type="datetime-local" value={fromTime} onChange={(event) => setFromTime(event.target.value)} /></label>
                  <label>{t("settings.debug.realtime.recording.to")} <input type="datetime-local" value={toTime} onChange={(event) => setToTime(event.target.value)} /></label>
                  <label><input type="checkbox" checked={errorsOnly} onChange={(event) => setErrorsOnly(event.target.checked)} /> {t("settings.debug.realtime.recording.errorsOnly")}</label>
                  {surfaceId ? <strong>Surface: {surfaceId}</strong> : null}
                </div>
                <div className="runtime-event-grid runtime-event-head" role="row">
                  <span>{t("settings.debug.realtime.time")}</span><span>{t("settings.debug.realtime.direction")}</span><span>{t("settings.debug.realtime.layer")}</span><span>Surface ID</span><span>{t("settings.debug.realtime.event")}</span><span>{t("settings.debug.realtime.size")}</span>
                </div>
                <div className="runtime-event-list">
                  {page.items.map((event) => (
                    <button key={event.sequence} type="button" className={`runtime-event-grid runtime-event-row${selectedEvent?.sequence === event.sequence ? " is-selected" : ""}`} onClick={() => {
                      const version = ++detailRequestVersion.current;
                      const request = selected
                        ? window.electronAPI.diagnostics.getAgentRealtimeRecordingEvent({ recordingId: selected.id, sequence: event.sequence })
                        : window.electronAPI.diagnostics.getAgentRealtimeLiveEvent({ sequence: event.sequence });
                      void request.then((detail) => {
                        if (detailRequestVersion.current === version) setSelectedEvent(detail);
                      });
                    }}>
                      <time>{new Date(Number(event.recordedAt)).toLocaleTimeString(locale, { hour12: false })}</time>
                      <code>{directionGlyph(event.direction)}</code><span>{event.layer}</span><strong>{event.surfaceId || "—"}</strong><span title={event.summary}>{event.summary}</span><span>{formatBytes(event.size)}</span>
                    </button>
                  ))}
                  {page.items.length === 0 ? <div className="runtime-empty">{t("settings.debug.realtime.empty")}</div> : null}
                </div>
                <footer className="runtime-recording-pager">
                  <span>{page.total === 0 ? 0 : cursor + 1}–{Math.min(cursor + page.items.length, page.total)} / {page.total}</span>
                  <button type="button" disabled={cursor === 0} onClick={() => setCursor(Math.max(0, cursor - PAGE_SIZE))}>{t("settings.debug.realtime.recording.previous")}</button>
                  <button type="button" disabled={!page.nextCursor} onClick={() => setCursor(page.nextCursor || cursor)}>{t("settings.debug.realtime.recording.next")}</button>
                </footer>
                {selectedEvent ? (
                  <>
                    <div
                      className={`runtime-event-detail-resizer${eventDetailResizing ? " is-active" : ""}`}
                      role="separator"
                      tabIndex={0}
                      aria-label={t("settings.debug.realtime.recording.resizeDetail")}
                      aria-orientation="horizontal"
                      aria-valuemin={EVENT_DETAIL_MIN_HEIGHT}
                      aria-valuemax={Math.min(EVENT_DETAIL_MAX_HEIGHT, Math.max(EVENT_DETAIL_MIN_HEIGHT, availableEventsHeight() - EVENT_LIST_MIN_HEIGHT - EVENT_DETAIL_RESERVED_HEIGHT))}
                      aria-valuenow={eventDetailHeight}
                      onDoubleClick={() => setEventDetailHeight(constrainEventDetailHeight(EVENT_DETAIL_DEFAULT_HEIGHT, availableEventsHeight()))}
                      onKeyDown={handleEventDetailKeyDown}
                      onPointerDown={handleEventDetailPointerDown}
                    ><span aria-hidden="true" /></div>
                    <section className="runtime-recording-event-detail">
                      <div className="runtime-recording-detail-tools">
                        <input
                          type="search"
                          value={detailSearch}
                          placeholder={t("settings.debug.realtime.recording.searchDetail")}
                          onChange={(event) => setDetailSearch(event.target.value)}
                          onKeyDown={handleDetailSearchKeyDown}
                        />
                        <output className={detailSearch.trim() && detailMatches.length === 0 ? "is-empty" : ""}>
                          {detailSearch.trim() ? `${detailMatches.length ? activeDetailMatchIndex + 1 : 0} / ${detailMatches.length}` : ""}
                        </output>
                        <div className="runtime-recording-find-actions">
                          <button
                            type="button"
                            disabled={detailMatches.length === 0}
                            title={t("settings.debug.realtime.recording.previousMatch")}
                            aria-label={t("settings.debug.realtime.recording.previousMatch")}
                            onClick={() => moveDetailMatch(-1)}
                          ><UpOutlined /></button>
                          <button
                            type="button"
                            disabled={detailMatches.length === 0}
                            title={t("settings.debug.realtime.recording.nextMatch")}
                            aria-label={t("settings.debug.realtime.recording.nextMatch")}
                            onClick={() => moveDetailMatch(1)}
                          ><DownOutlined /></button>
                        </div>
                        <button type="button" onClick={() => void window.electronAPI.clipboard.writeText(detailJson)}><CopyOutlined /> {t("settings.debug.realtime.copy")}</button>
                      </div>
                      <details open><summary>{t("settings.debug.realtime.recording.fullPayload")}</summary><pre>{highlightedDetailJson}</pre></details>
                    </section>
                  </>
                ) : null}
              </div>
            ) : null}

            {selected && tab === "metrics" ? (
              <div className="runtime-recording-metrics">
                <div className="runtime-section-heading">
                  <h2>{t("settings.debug.realtime.recording.metrics")}</h2>
                  <select value={selectedPid ?? ""} onChange={(event) => setSelectedPid(Number(event.target.value))}>
                    {processOptions.map(([pid, label]) => <option key={pid} value={pid}>{label}</option>)}
                  </select>
                </div>
                <RecordingMetricChart samples={samples} pid={selectedPid} />
                <div className="runtime-recording-legend"><span className="is-memory">RSS</span><span className="is-cpu">CPU</span></div>
                <dl>
                  <div><dt>RSS</dt><dd>{selectedProcessPoints.length ? formatBytes(selectedProcessPoints.at(-1)!.workingSetBytes) : "—"}</dd></div>
                  <div><dt>Δ</dt><dd>{memoryDelta > 0 ? "+" : ""}{formatBytes(memoryDelta)}</dd></div>
                  <div><dt>CPU</dt><dd>{selectedProcessPoints.length ? `${selectedProcessPoints.at(-1)!.cpuPercent.toFixed(1)}%` : "—"}</dd></div>
                  <div><dt>{t("settings.debug.realtime.recording.sampleGaps")}</dt><dd>{samples.filter((sample) => sample.delayedByMs > 250 || sample.error).length}</dd></div>
                </dl>
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
