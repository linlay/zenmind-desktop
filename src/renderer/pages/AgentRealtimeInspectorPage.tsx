import {
  CaretDownOutlined,
  CaretRightOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  CodeOutlined,
  CopyOutlined,
  DeleteOutlined,
  DisconnectOutlined,
  LoadingOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
  WarningFilled,
} from "@ant-design/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentRealtimeDebugProcess,
  AgentRealtimeDebugSnapshot,
  AgentRealtimeDebugTarget,
  AgentRealtimeDebugTraceDirection,
  AgentRealtimeDebugTraceEntry,
  AgentRealtimeDebugTraceLayer,
} from "../../shared/contracts";
import { useI18n } from "../i18n/useI18n";
import "./AgentRealtimeInspectorPage.css";

type ViewId = "targets" | "events" | "topology" | "system";
type DetailTab = "overview" | "memory" | "events" | "raw";
type LayerFilter = "all" | AgentRealtimeDebugTraceLayer;
type DirectionFilter = "all" | AgentRealtimeDebugTraceDirection;
type SortKey = "memory" | "delta" | "cpu" | "surface";
type MemoryPoint = { capturedAt: number; bytes: number };
type MemoryHistory = Record<number, MemoryPoint[]>;
type TracePresentation = { json: string; size: string; searchText: string };

const MAX_RENDERED_FRAMES = 500;
const MEMORY_HISTORY_WINDOW_MS = 5 * 60 * 1_000;
const MEMORY_WARNING_BYTES = 384 * 1024 * 1024;
const MEMORY_DELTA_WARNING_BYTES = 64 * 1024 * 1024;

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatBytes(bytes: number | undefined) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatPercent(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}%` : "—";
}

function formatFrameTime(value: number, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
  }).format(new Date(value));
}

function formatDiagnosticTime(value: number | undefined, locale: string) {
  return value ? formatFrameTime(value, locale) : "—";
}

function describeTrace(entry: AgentRealtimeDebugTraceEntry) {
  const data = entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
    ? entry.data as Record<string, unknown>
    : {};
  const input = data.input && typeof data.input === "object" && !Array.isArray(data.input)
    ? data.input as Record<string, unknown>
    : {};
  const label = [data.frame, data.kind, data.type, data.method, input.kind]
    .find((value) => typeof value === "string" && value.trim());
  return typeof label === "string" ? label : "event";
}

function createTracePresentation(entry: AgentRealtimeDebugTraceEntry): TracePresentation {
  const json = formatJson(entry.data);
  const bytes = new TextEncoder().encode(json).byteLength;
  return {
    json,
    size: bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`,
    searchText: [
      entry.sequence,
      entry.direction,
      entry.layer,
      entry.surfaceId,
      entry.surfaceKind,
      entry.route,
      describeTrace(entry),
      json,
    ].join(" ").toLocaleLowerCase(),
  };
}

function directionGlyph(direction: AgentRealtimeDebugTraceDirection) {
  if (direction === "desktop-to-platform") return "D → P";
  if (direction === "platform-to-desktop") return "P → D";
  if (direction === "surface-to-desktop") return "S → D";
  return "D → S";
}

function memoryDelta(points: MemoryPoint[] | undefined) {
  if (!points || points.length < 2) return 0;
  return points.at(-1)!.bytes - points[0].bytes;
}

function targetState(target: AgentRealtimeDebugTarget) {
  if (target.crashed) return "crashed";
  if (target.orphaned) return "detached";
  if (target.loading) return "loading";
  if (target.active) return "visible";
  return "hidden";
}

function targetNeedsAttention(target: AgentRealtimeDebugTarget, process: AgentRealtimeDebugProcess | undefined, delta: number) {
  return target.crashed || target.orphaned ||
    (process?.workingSetBytes ?? 0) >= MEMORY_WARNING_BYTES ||
    delta >= MEMORY_DELTA_WARNING_BYTES;
}

function TargetStatusIcon({ target, warning }: { target: AgentRealtimeDebugTarget; warning: boolean }) {
  if (target.crashed) return <CloseCircleFilled className="is-danger" />;
  if (target.orphaned) return <DisconnectOutlined className="is-muted" />;
  if (target.loading) return <LoadingOutlined className="is-loading" />;
  if (warning) return <WarningFilled className="is-warning" />;
  return <CheckCircleFilled className={target.active ? "is-success" : "is-muted"} />;
}

function MemorySparkline({ points, compact = false }: { points: MemoryPoint[]; compact?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = compact ? 72 : 304;
    const height = compact ? 18 : 96;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, height);
    if (points.length < 2) return;
    const values = points.map((point) => point.bytes);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = Math.max(1, max - min);
    const padding = compact ? 1 : 8;
    context.strokeStyle = "#5790ff";
    context.lineWidth = compact ? 1.25 : 1.75;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.beginPath();
    points.forEach((point, index) => {
      const x = padding + (index / (points.length - 1)) * (width - padding * 2);
      const y = height - padding - ((point.bytes - min) / range) * (height - padding * 2);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  }, [compact, points]);
  return <canvas ref={canvasRef} className={compact ? "runtime-memory-sparkline is-compact" : "runtime-memory-sparkline"} />;
}

export function AgentRealtimeInspectorPage() {
  const { locale, t } = useI18n();
  const [snapshot, setSnapshot] = useState<AgentRealtimeDebugSnapshot | null>(null);
  const [memoryHistory, setMemoryHistory] = useState<MemoryHistory>({});
  const [message, setMessage] = useState("");
  const [live, setLive] = useState(true);
  const [view, setView] = useState<ViewId>("targets");
  const [detailTab, setDetailTab] = useState<DetailTab>("overview");
  const [search, setSearch] = useState("");
  const [layer, setLayer] = useState<LayerFilter>("all");
  const [direction, setDirection] = useState<DirectionFilter>("all");
  const [eventSurfaceId, setEventSurfaceId] = useState("all");
  const [follow, setFollow] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("memory");
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [selectedSequence, setSelectedSequence] = useState<number | null>(null);
  const [collapsedPids, setCollapsedPids] = useState<Set<number>>(new Set());
  const refreshPendingRef = useRef(false);
  const frameListRef = useRef<HTMLDivElement | null>(null);
  const lastSequenceRef = useRef(0);
  const tracePresentationCacheRef = useRef(new Map<number, TracePresentation>());

  async function loadSnapshot() {
    if (refreshPendingRef.current) return;
    refreshPendingRef.current = true;
    try {
      const nextSnapshot = await window.electronAPI.diagnostics.getAgentRealtimeDebugSnapshot({
        afterSequence: lastSequenceRef.current,
      });
      const newestSequence = nextSnapshot.trace.at(-1)?.sequence;
      if (newestSequence !== undefined) lastSequenceRef.current = newestSequence;
      setMemoryHistory((current) => {
        const next: MemoryHistory = { ...current };
        const cutoff = Number(nextSnapshot.capturedAt) - MEMORY_HISTORY_WINDOW_MS;
        for (const process of nextSnapshot.runtime.processes) {
          const points = (next[process.pid] || []).filter((point) => point.capturedAt >= cutoff);
          if (points.at(-1)?.capturedAt !== Number(nextSnapshot.capturedAt)) {
            points.push({ capturedAt: Number(nextSnapshot.capturedAt), bytes: process.workingSetBytes });
          }
          next[process.pid] = points;
        }
        return next;
      });
      setSnapshot((currentSnapshot) => {
        if (!currentSnapshot) return nextSnapshot;
        const knownSequences = new Set(currentSnapshot.trace.map((entry) => entry.sequence));
        const mergedTrace = [
          ...currentSnapshot.trace,
          ...nextSnapshot.trace.filter((entry) => !knownSequences.has(entry.sequence)),
        ].slice(-MAX_RENDERED_FRAMES);
        const liveSequences = new Set(mergedTrace.map((entry) => entry.sequence));
        for (const sequence of tracePresentationCacheRef.current.keys()) {
          if (!liveSequences.has(sequence)) tracePresentationCacheRef.current.delete(sequence);
        }
        return { ...nextSnapshot, trace: mergedTrace };
      });
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      refreshPendingRef.current = false;
    }
  }

  async function clearTrace() {
    try {
      const nextSnapshot = await window.electronAPI.diagnostics.clearAgentRealtimeDebugTrace();
      setSnapshot(nextSnapshot);
      setSelectedSequence(null);
      lastSequenceRef.current = 0;
      tracePresentationCacheRef.current.clear();
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  useEffect(() => {
    void loadSnapshot();
  }, []);

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => void loadSnapshot(), 500);
    return () => window.clearInterval(timer);
  }, [live]);

  const processByPid = useMemo(() => new Map(
    (snapshot?.runtime.processes || []).map((process) => [process.pid, process]),
  ), [snapshot?.runtime.processes]);

  const filteredTargets = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase();
    const targets = snapshot?.runtime.targets || [];
    if (!normalized) return targets;
    return targets.filter((target) => [
      target.surfaceId,
      target.label,
      target.surfaceRole,
      target.surfaceKind,
      target.webContentsId,
      target.pid,
      target.url,
      target.title,
      target.parentSurfaceId,
      target.ownerChatId,
    ].join(" ").toLocaleLowerCase().includes(normalized));
  }, [search, snapshot?.runtime.targets]);

  const targetGroups = useMemo(() => {
    const byPid = new Map<number, AgentRealtimeDebugTarget[]>();
    for (const target of filteredTargets) {
      const pid = target.pid || 0;
      const values = byPid.get(pid) || [];
      values.push(target);
      byPid.set(pid, values);
    }
    const normalized = search.trim().toLocaleLowerCase();
    for (const process of processByPid.values()) {
      if (byPid.has(process.pid)) continue;
      const matchesProcess = [process.pid, process.type, process.name, process.serviceName]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalized);
      if (!normalized || matchesProcess) byPid.set(process.pid, []);
    }
    const groups = [...byPid.entries()].map(([pid, targets]) => {
      const process = processByPid.get(pid);
      const delta = memoryDelta(memoryHistory[pid]);
      return { pid, process, targets, delta };
    });
    groups.sort((left, right) => {
      if (sortKey === "cpu") return (right.process?.cpuPercent || 0) - (left.process?.cpuPercent || 0);
      if (sortKey === "delta") return right.delta - left.delta;
      if (sortKey === "surface") return (left.targets[0]?.surfaceId || "").localeCompare(right.targets[0]?.surfaceId || "");
      return (right.process?.workingSetBytes || 0) - (left.process?.workingSetBytes || 0);
    });
    for (const group of groups) {
      group.targets.sort((left, right) => {
        if (left.active !== right.active) return left.active ? -1 : 1;
        return (left.surfaceId || left.label).localeCompare(right.surfaceId || right.label);
      });
    }
    return groups;
  }, [filteredTargets, memoryHistory, processByPid, search, sortKey]);

  const selectedTarget = selectedTargetId
    ? snapshot?.runtime.targets.find((target) => target.targetId === selectedTargetId) || null
    : null;
  const selectedProcess = selectedTarget?.pid ? processByPid.get(selectedTarget.pid) : undefined;
  const selectedHistory = selectedTarget?.pid ? memoryHistory[selectedTarget.pid] || [] : [];
  const selectedDelta = memoryDelta(selectedHistory);

  useEffect(() => {
    const targets = snapshot?.runtime.targets || [];
    if (selectedTargetId && targets.some((target) => target.targetId === selectedTargetId)) return;
    const preferred = targets.find((target) => {
      const process = target.pid ? processByPid.get(target.pid) : undefined;
      return targetNeedsAttention(target, process, memoryDelta(target.pid ? memoryHistory[target.pid] : undefined));
    }) || targets[0];
    setSelectedTargetId(preferred?.targetId || null);
  }, [memoryHistory, processByPid, selectedTargetId, snapshot?.runtime.targets]);

  const surfaceIds = useMemo(() => {
    const values = new Set<string>();
    snapshot?.runtime.targets.forEach((target) => {
      if (target.surfaceId) values.add(target.surfaceId);
    });
    snapshot?.trace.forEach((entry) => {
      if (entry.surfaceId) values.add(entry.surfaceId);
    });
    return [...values].sort((left, right) => left.localeCompare(right));
  }, [snapshot]);

  const filteredFrames = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase();
    return (snapshot?.trace || []).flatMap((entry) => {
      if (layer !== "all" && entry.layer !== layer) return [];
      if (direction !== "all" && entry.direction !== direction) return [];
      if (eventSurfaceId !== "all" && entry.surfaceId !== eventSurfaceId) return [];
      const presentation = tracePresentationCacheRef.current.get(entry.sequence) || createTracePresentation(entry);
      tracePresentationCacheRef.current.set(entry.sequence, presentation);
      if (normalized && !presentation.searchText.includes(normalized)) return [];
      return [{ entry, presentation }];
    });
  }, [direction, eventSurfaceId, layer, search, snapshot?.trace]);

  useEffect(() => {
    if (!follow || !frameListRef.current || view !== "events") return;
    frameListRef.current.scrollTop = frameListRef.current.scrollHeight;
  }, [filteredFrames.length, follow, view]);

  const selectedEntry = selectedSequence === null
    ? null
    : snapshot?.trace.find((entry) => entry.sequence === selectedSequence) || null;
  const selectedSurfaceEvents = selectedTarget?.surfaceId
    ? (snapshot?.trace || []).filter((entry) => entry.surfaceId === selectedTarget.surfaceId).slice(-12).reverse()
    : [];
  const primaryConnection = snapshot?.connections.primary;
  const btwConnection = snapshot?.connections.btw;
  const connected = primaryConnection?.phase === "connected";
  function selectTarget(target: AgentRealtimeDebugTarget) {
    setSelectedTargetId(target.targetId);
    setDetailTab("overview");
  }

  async function openSelectedDevTools() {
    if (!selectedTarget?.webContentsId) return;
    const result = await window.electronAPI.diagnostics.openAgentRealtimeTargetDevTools({
      webContentsId: selectedTarget.webContentsId,
    });
    if (!result.ok) setMessage(result.message || t("settings.debug.realtime.targetUnavailable"));
  }

  async function copySelectedSnapshot() {
    if (!selectedTarget) return;
    await window.electronAPI.clipboard.writeText(formatJson({
      capturedAt: snapshot?.capturedAt,
      target: selectedTarget,
      process: selectedProcess,
      memoryHistory: selectedHistory,
      recentEvents: selectedSurfaceEvents,
    }));
  }

  const tabs: Array<{ id: ViewId; label: string }> = [
    { id: "targets", label: t("settings.debug.realtime.targets") },
    { id: "events", label: t("settings.debug.realtime.events") },
    { id: "topology", label: t("settings.debug.realtime.topology") },
    { id: "system", label: t("settings.debug.realtime.system") },
  ];

  return (
    <main className="runtime-observer">
      <header className="runtime-observer-toolbar">
        <div className="runtime-observer-heading">
          <CodeOutlined aria-hidden="true" />
          <h1>{t("settings.debug.realtime.inspectorTitle")}</h1>
          <span className={`runtime-health${connected ? " is-healthy" : " is-offline"}`}>
            <span aria-hidden="true" />
            {connected ? t("settings.debug.realtime.healthy") : t("settings.debug.realtime.offline")}
          </span>
        </div>
        <div className="runtime-summary" aria-label={t("settings.debug.realtime.runtimeSummary") }>
          <span><strong>{snapshot?.runtime.surfaceCount ?? 0}</strong> {t("settings.debug.realtime.surfaceShort")}</span>
          <span><strong>{snapshot?.runtime.webviewCount ?? 0}</strong> WebViews</span>
          <span><strong>{formatBytes(snapshot?.runtime.totalWorkingSetBytes)}</strong></span>
        </div>
        <label className="runtime-search">
          <SearchOutlined aria-hidden="true" />
          <input
            type="search"
            value={search}
            placeholder={t("settings.debug.realtime.targetSearchPlaceholder")}
            onChange={(event) => setSearch(event.target.value)}
          />
          <kbd>⌘K</kbd>
        </label>
        <div className="runtime-toolbar-actions">
          <button
            type="button"
            className={live ? "is-active" : ""}
            onClick={() => {
              setLive((current) => {
                if (!current) void loadSnapshot();
                return !current;
              });
            }}
          >
            {live ? <PauseOutlined /> : <PlayCircleOutlined />}
            {live ? t("settings.debug.realtime.pause") : t("settings.debug.realtime.resume")}
          </button>
          <button type="button" onClick={() => void loadSnapshot()}>
            <ReloadOutlined />
            {t("common.refresh")}
          </button>
          <button type="button" disabled={!snapshot?.trace.length} onClick={() => void clearTrace()}>
            <DeleteOutlined />
            {t("settings.debug.realtime.clear")}
          </button>
        </div>
      </header>

      {message || primaryConnection?.lastError || btwConnection?.lastError ? (
        <div className="runtime-observer-error" role="status">
          {message || primaryConnection?.lastError || btwConnection?.lastError}
        </div>
      ) : null}

      <section className="runtime-observer-body">
        <div className="runtime-observer-main">
          <nav className="runtime-view-tabs" aria-label={t("settings.debug.realtime.views") }>
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={view === tab.id ? "is-active" : ""}
                onClick={() => setView(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          {view === "targets" ? (
            <section className="runtime-targets" aria-label={t("settings.debug.realtime.targets") }>
              <div className="runtime-target-grid runtime-target-head" role="row">
                <span>{t("settings.debug.realtime.status")}</span>
                <button type="button" onClick={() => setSortKey("surface")}>Surface ID</button>
                <span>{t("settings.debug.realtime.kind")}</span>
                <span>{t("settings.debug.realtime.owner")}</span>
                <span>WebContents</span>
                <span>PID</span>
                <span>URL / Route</span>
                <span>{t("settings.debug.realtime.state")}</span>
                <button type="button" className={sortKey === "memory" ? "is-sorted" : ""} onClick={() => setSortKey("memory")}>RSS</button>
                <button type="button" className={sortKey === "delta" ? "is-sorted" : ""} onClick={() => setSortKey("delta")}>Δ 5m</button>
                <button type="button" className={sortKey === "cpu" ? "is-sorted" : ""} onClick={() => setSortKey("cpu")}>CPU</button>
              </div>
              <div className="runtime-target-scroll">
                {targetGroups.length === 0 ? (
                  <div className="runtime-empty">{t("settings.debug.realtime.noTargets")}</div>
                ) : targetGroups.map((group) => {
                  const collapsed = collapsedPids.has(group.pid);
                  const processWarning = (group.process?.workingSetBytes || 0) >= MEMORY_WARNING_BYTES ||
                    group.delta >= MEMORY_DELTA_WARNING_BYTES;
                  return (
                    <div key={group.pid || "unavailable"} className="runtime-process-group">
                      <button
                        type="button"
                        className={`runtime-process-row${processWarning ? " has-warning" : ""}`}
                        onClick={() => setCollapsedPids((current) => {
                          const next = new Set(current);
                          if (next.has(group.pid)) next.delete(group.pid);
                          else next.add(group.pid);
                          return next;
                        })}
                      >
                        {collapsed ? <CaretRightOutlined /> : <CaretDownOutlined />}
                        <span className="runtime-process-dot" aria-hidden="true" />
                        <strong>{group.pid ? `Process ${group.pid}` : t("settings.debug.realtime.unavailableProcess")}</strong>
                        <span>({group.process?.type || "unavailable"})</span>
                        <span className="runtime-count">{group.targets.length}</span>
                        <span className="runtime-process-metrics">RSS {formatBytes(group.process?.workingSetBytes)} · CPU {formatPercent(group.process?.cpuPercent)}</span>
                      </button>
                      {!collapsed ? group.targets.map((target) => {
                        const process = target.pid ? processByPid.get(target.pid) : undefined;
                        const history = target.pid ? memoryHistory[target.pid] || [] : [];
                        const delta = memoryDelta(history);
                        const warning = targetNeedsAttention(target, process, delta);
                        const state = targetState(target);
                        return (
                          <button
                            key={target.targetId}
                            type="button"
                            className={`runtime-target-grid runtime-target-row${selectedTargetId === target.targetId ? " is-selected" : ""}${warning ? " has-warning" : ""}`}
                            onClick={() => selectTarget(target)}
                          >
                            <span className="runtime-target-status"><TargetStatusIcon target={target} warning={warning} /></span>
                            <strong title={target.surfaceId || target.label}>{target.surfaceId || (target.orphaned ? t("settings.debug.realtime.unregistered") : target.label)}</strong>
                            <span title={target.surfaceRole || target.surfaceType || target.webContentsType}>{target.surfaceRole || target.surfaceType || target.webContentsType || "—"}</span>
                            <span title={target.parentSurfaceId || String(target.ownerWebContentsId || "")}>{target.parentSurfaceId || (target.ownerWebContentsId ? `WC ${target.ownerWebContentsId}` : "—")}</span>
                            <code>{target.webContentsId ?? "—"}</code>
                            <code>{target.pid ?? "—"}</code>
                            <span title={target.url || target.title}>{target.url || target.title || "—"}</span>
                            <span className={`runtime-state is-${state}`}>{t(`settings.debug.realtime.state.${state}`)}</span>
                            <span title={process && process.targetCount > 1 ? t("settings.debug.realtime.sharedProcessMemory") : ""}>
                              {formatBytes(process?.workingSetBytes)}{process && process.targetCount > 1 ? " · shared" : ""}
                            </span>
                            <span className={delta >= MEMORY_DELTA_WARNING_BYTES ? "is-warning-text" : delta > 0 ? "is-positive" : ""}>
                              {delta > 0 ? "+" : ""}{formatBytes(delta)}
                            </span>
                            <span>{formatPercent(process?.cpuPercent)}</span>
                          </button>
                        );
                      }) : null}
                    </div>
                  );
                })}
              </div>
              <footer className="runtime-target-footer">
                <span>{snapshot?.runtime.surfaceCount ?? 0} {t("settings.debug.realtime.surfaceShort")} · {snapshot?.runtime.webviewCount ?? 0} WebViews</span>
                <span>RSS {formatBytes(snapshot?.runtime.totalWorkingSetBytes)}</span>
                <span>{t("settings.debug.realtime.orphaned")} {snapshot?.runtime.orphanWebviewCount ?? 0}</span>
                <span>{t("settings.debug.realtime.processMemoryNote")}</span>
                <span>{formatDiagnosticTime(Number(snapshot?.capturedAt), locale)}</span>
              </footer>
            </section>
          ) : null}

          {view === "events" ? (
            <section className="runtime-events">
              <div className="runtime-event-filters">
                <select value={layer} onChange={(event) => setLayer(event.target.value as LayerFilter)}>
                  <option value="all">{t("settings.debug.realtime.all")}</option>
                  <option value="platform-ws">Platform WS</option>
                  <option value="surface-bridge">Surface Bridge</option>
                </select>
                <select value={direction} onChange={(event) => setDirection(event.target.value as DirectionFilter)}>
                  <option value="all">{t("settings.debug.realtime.allDirections")}</option>
                  <option value="platform-to-desktop">P → D</option>
                  <option value="desktop-to-platform">D → P</option>
                  <option value="surface-to-desktop">S → D</option>
                  <option value="desktop-to-surface">D → S</option>
                </select>
                <select value={eventSurfaceId} onChange={(event) => setEventSurfaceId(event.target.value)}>
                  <option value="all">{t("settings.debug.realtime.allSurfaces")}</option>
                  {surfaceIds.map((surfaceId) => <option key={surfaceId} value={surfaceId}>{surfaceId}</option>)}
                </select>
                <button type="button" className={follow ? "is-active" : ""} onClick={() => setFollow((current) => !current)}>
                  {t("settings.debug.realtime.follow")}
                </button>
              </div>
              <div className="runtime-event-grid runtime-event-head" role="row">
                <span>{t("settings.debug.realtime.time")}</span>
                <span>{t("settings.debug.realtime.direction")}</span>
                <span>{t("settings.debug.realtime.layer")}</span>
                <span>Surface ID</span>
                <span>{t("settings.debug.realtime.event")}</span>
                <span>{t("settings.debug.realtime.size")}</span>
              </div>
              <div ref={frameListRef} className="runtime-event-list">
                {filteredFrames.length === 0 ? (
                  <div className="runtime-empty">{t("settings.debug.realtime.empty")}</div>
                ) : filteredFrames.map(({ entry, presentation }) => (
                  <button
                    key={entry.sequence}
                    type="button"
                    className={`runtime-event-grid runtime-event-row${selectedSequence === entry.sequence ? " is-selected" : ""}`}
                    onClick={() => {
                      setSelectedSequence(entry.sequence);
                      const target = snapshot?.runtime.targets.find((candidate) => candidate.surfaceId === entry.surfaceId);
                      if (target) setSelectedTargetId(target.targetId);
                      setDetailTab("events");
                    }}
                  >
                    <time>{formatFrameTime(Number(entry.recordedAt), locale)}</time>
                    <code>{directionGlyph(entry.direction)}</code>
                    <span>{entry.layer === "platform-ws" ? "Platform WS" : "Surface Bridge"}</span>
                    <strong title={entry.surfaceId || ""}>{entry.surfaceId || "—"}</strong>
                    <span title={describeTrace(entry)}>{describeTrace(entry)}</span>
                    <span>{presentation.size}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {view === "topology" ? (
            <section className="runtime-topology">
              <div className="runtime-topology-head">
                <span>Surface ID</span><span>{t("settings.debug.realtime.kind")}</span><span>{t("settings.debug.realtime.owner")}</span><span>WebContents / PID</span><span>{t("settings.debug.realtime.state")}</span>
              </div>
              <div className="runtime-topology-list">
                {(snapshot?.runtime.targets || [])
                  .filter((target) => !target.parentSurfaceId)
                  .map((root) => (
                    <div key={root.targetId} className="runtime-topology-family">
                      <button type="button" onClick={() => selectTarget(root)} className={selectedTargetId === root.targetId ? "is-selected" : ""}>
                        <strong>{root.surfaceId || root.label}</strong>
                        <span>{root.surfaceRole || root.surfaceKind || root.webContentsType}</span>
                        <span>—</span>
                        <code>{root.webContentsId ?? "—"} / {root.pid ?? "—"}</code>
                        <span>{t(`settings.debug.realtime.state.${targetState(root)}`)}</span>
                      </button>
                      {(snapshot?.runtime.targets || [])
                        .filter((child) => child.parentSurfaceId === root.surfaceId)
                        .map((child) => (
                          <button key={child.targetId} type="button" className={`is-child${selectedTargetId === child.targetId ? " is-selected" : ""}`} onClick={() => selectTarget(child)}>
                            <strong>{child.surfaceId || child.label}</strong>
                            <span>{child.surfaceRole || child.surfaceKind || child.webContentsType}</span>
                            <span>{child.parentSurfaceId}</span>
                            <code>{child.webContentsId ?? "—"} / {child.pid ?? "—"}</code>
                            <span>{t(`settings.debug.realtime.state.${targetState(child)}`)}</span>
                          </button>
                        ))}
                    </div>
                  ))}
              </div>
            </section>
          ) : null}

          {view === "system" ? (
            <section className="runtime-system">
              <article>
                <h2>{t("settings.debug.realtime.physicalConnection")}</h2>
                {[primaryConnection, btwConnection].map((connection, index) => (
                  <dl key={index === 0 ? "primary" : "btw"}>
                    <div><dt>Lane</dt><dd>{index === 0 ? "Primary" : "BTW"}</dd></div>
                    <div><dt>Phase</dt><dd>{connection?.phase || "idle"}</dd></div>
                    <div><dt>Session ID</dt><dd>{connection?.physicalSessionId || "—"}</dd></div>
                    <div><dt>Generation</dt><dd>{connection?.generation ?? 0}</dd></div>
                    <div><dt>Last inbound</dt><dd>{formatDiagnosticTime(connection?.lastInboundAt, locale)}</dd></div>
                    <div><dt>Heartbeat</dt><dd>{formatDiagnosticTime(connection?.lastHeartbeatAt, locale)}</dd></div>
                    <div><dt>Reconnects</dt><dd>{connection?.reconnectCount ?? 0}</dd></div>
                  </dl>
                ))}
              </article>
              <article>
                <h2>Overview lease</h2>
                {snapshot?.broker.overviewLease ? (
                  <>
                    <dl>
                      <div><dt>State</dt><dd>{snapshot.broker.overviewLease.state}</dd></div>
                      <div><dt>Chat</dt><dd>{snapshot.broker.overviewLease.chatId || "—"}</dd></div>
                      <div><dt>Generation</dt><dd>{snapshot.broker.overviewLease.parentGeneration}</dd></div>
                      <div><dt>Context epoch</dt><dd>{snapshot.broker.overviewLease.contextEpoch}</dd></div>
                      <div><dt>Runs</dt><dd>{snapshot.broker.overviewLease.runIds.join(", ") || "—"}</dd></div>
                      <div><dt>Pending / UI</dt><dd>{snapshot.broker.overviewLease.pendingSubscriberCount} / {snapshot.broker.overviewLease.uiSubscriberCount}</dd></div>
                    </dl>
                    <div className="runtime-system-list">
                      {snapshot.broker.overviewLease.subscribers.map((subscriber, index) => (
                        <div key={`${subscriber.runId}:${subscriber.chatId}:${index}`}>
                          <code>{subscriber.runId}</code>
                          <span>{subscriber.chatId}</span>
                          <span>seq {subscriber.lastSeq}</span>
                        </div>
                      ))}
                      {!snapshot.broker.overviewLease.subscribers.length
                        ? <div className="runtime-empty">No Overview UI subscriber</div>
                        : null}
                    </div>
                  </>
                ) : <div className="runtime-empty">No active Overview lease</div>}
              </article>
              <article>
                <h2>{t("settings.debug.realtime.logicalFramePorts")}</h2>
                <div className="runtime-system-list">
                  {(snapshot?.logicalSessions || []).map((session) => (
                    <button key={`${session.logicalSessionId}:${session.openedAt}`} type="button" onClick={() => {
                      const target = snapshot?.runtime.targets.find((candidate) => candidate.surfaceId === session.surfaceId);
                      if (target) selectTarget(target);
                    }}>
                      <code>{session.logicalSessionId}</code><span>{session.surfaceId || "—"}</span><span>{session.phase}</span><span>L{session.logicalGeneration} / P{session.physicalGeneration}</span>
                      {session.streams.map((stream) => (
                        <span key={stream.requestId} title={`${stream.type} ${stream.chatId}`}>
                          {stream.virtual ? "clone" : "root"} {stream.runId || "pending"} · seq {stream.lastSeq}
                        </span>
                      ))}
                    </button>
                  ))}
                  {!snapshot?.logicalSessions.length ? <div className="runtime-empty">{t("settings.debug.realtime.noLogicalSessions")}</div> : null}
                </div>
              </article>
              <article>
                <h2>{t("settings.debug.realtime.runRecovery")}</h2>
                <div className="runtime-system-list">
                  {(snapshot?.runRecovery || []).map((run) => (
                    <div key={run.runId}>
                      <code>{run.runId}</code><span>{run.lane}</span><span>seq {run.lastSeq}</span><span>{run.state} / {run.upstreamState}</span><span>clones {run.cloneCount}</span>
                      <span>last {run.lastEventType || "—"}{run.lastEventSeq === undefined ? "" : ` @${run.lastEventSeq}`}</span>
                      <span>plan/task {run.lastPlanTaskEventType || "—"}{run.lastPlanTaskEventSeq === undefined ? "" : ` @${run.lastPlanTaskEventSeq}`}</span>
                      <span title={run.lastRestoreResult}>{run.lastRestoreResult}</span>
                    </div>
                  ))}
                  {!snapshot?.runRecovery.length ? <div className="runtime-empty">{t("settings.debug.realtime.noTrackedRuns")}</div> : null}
                </div>
              </article>
            </section>
          ) : null}
        </div>

        <aside className="runtime-detail">
          <div className="runtime-detail-tabs">
            {(["overview", "memory", "events", "raw"] as const).map((tab) => (
              <button key={tab} type="button" className={detailTab === tab ? "is-active" : ""} onClick={() => setDetailTab(tab)}>
                {t(`settings.debug.realtime.detail.${tab}`)}
              </button>
            ))}
          </div>
          <div className="runtime-detail-scroll">
            {!selectedTarget ? (
              <div className="runtime-empty">{t("settings.debug.realtime.selectTarget")}</div>
            ) : detailTab === "overview" ? (
              <>
                <section className="runtime-detail-section">
                  <div className="runtime-detail-title">
                    <div><strong>{selectedTarget.surfaceId || selectedTarget.label}</strong><span>{targetNeedsAttention(selectedTarget, selectedProcess, selectedDelta) ? t("settings.debug.realtime.attention") : targetState(selectedTarget)}</span></div>
                    <button type="button" title={t("settings.debug.realtime.copy")} onClick={() => void copySelectedSnapshot()}><CopyOutlined /></button>
                  </div>
                </section>
                <section className="runtime-detail-section">
                  <h2>{t("settings.debug.realtime.identity")}</h2>
                  <dl>
                    <div><dt>Surface ID</dt><dd>{selectedTarget.surfaceId || "—"}</dd></div>
                    <div><dt>{t("settings.debug.realtime.kind")}</dt><dd>{selectedTarget.surfaceRole || selectedTarget.surfaceType || selectedTarget.webContentsType || "—"}</dd></div>
                    <div><dt>WebContents ID</dt><dd>{selectedTarget.webContentsId ?? "—"}</dd></div>
                    <div><dt>URL / Route</dt><dd title={selectedTarget.url}>{selectedTarget.url || "—"}</dd></div>
                    <div><dt>{t("settings.debug.realtime.created")}</dt><dd>{selectedProcess?.creationTime ? new Date(selectedProcess.creationTime).toLocaleString(locale) : "—"}</dd></div>
                  </dl>
                </section>
                <section className="runtime-detail-section">
                  <h2>{t("settings.debug.realtime.rendererProcess")}</h2>
                  <dl>
                    <div><dt>PID</dt><dd>{selectedProcess?.pid ?? "—"}</dd></div>
                    <div><dt>{t("settings.debug.realtime.processType")}</dt><dd>{selectedProcess?.type || "—"}</dd></div>
                    <div><dt>CPU</dt><dd>{formatPercent(selectedProcess?.cpuPercent)}</dd></div>
                    <div><dt>{t("settings.debug.realtime.sandboxed")}</dt><dd>{typeof selectedProcess?.sandboxed === "boolean" ? String(selectedProcess.sandboxed) : "—"}</dd></div>
                  </dl>
                </section>
                <section className="runtime-detail-section">
                  <h2>{t("settings.debug.realtime.lifecycle")}</h2>
                  <dl>
                    <div><dt>{t("settings.debug.realtime.state")}</dt><dd><span className={`runtime-state is-${targetState(selectedTarget)}`}>{t(`settings.debug.realtime.state.${targetState(selectedTarget)}`)}</span></dd></div>
                    <div><dt>{t("settings.debug.realtime.parent")}</dt><dd>{selectedTarget.parentSurfaceId || "—"}</dd></div>
                    <div><dt>{t("settings.debug.realtime.active")}</dt><dd>{String(selectedTarget.active)}</dd></div>
                    <div><dt>{t("settings.debug.realtime.loading")}</dt><dd>{String(selectedTarget.loading)}</dd></div>
                    <div><dt>DevTools</dt><dd>{selectedTarget.devToolsOpened ? t("settings.debug.realtime.open") : t("settings.debug.realtime.closed")}</dd></div>
                    <div><dt>Background throttle</dt><dd>{String(selectedTarget.backgroundThrottling)}</dd></div>
                  </dl>
                </section>
                <section className="runtime-detail-section runtime-overview-memory">
                  <div className="runtime-section-heading">
                    <h2>{t("settings.debug.realtime.memoryFiveMinutes")}</h2>
                    <span>RSS {formatBytes(selectedProcess?.workingSetBytes)}</span>
                  </div>
                  <MemorySparkline points={selectedHistory} />
                </section>
                <section className="runtime-detail-section">
                  <div className="runtime-section-heading">
                    <h2>{t("settings.debug.realtime.recentEvents")}</h2>
                    <span>{selectedSurfaceEvents.length}</span>
                  </div>
                  <div className="runtime-detail-events is-compact">
                    {selectedSurfaceEvents.slice(0, 5).map((entry) => (
                      <button
                        key={entry.sequence}
                        type="button"
                        onClick={() => {
                          setSelectedSequence(entry.sequence);
                          setDetailTab("events");
                        }}
                      >
                        <time>{formatFrameTime(Number(entry.recordedAt), locale)}</time>
                        <strong>{describeTrace(entry)}</strong>
                        <span>{directionGlyph(entry.direction)}</span>
                      </button>
                    ))}
                    {selectedSurfaceEvents.length === 0 ? <div className="runtime-empty">{t("settings.debug.realtime.noSurfaceEvents")}</div> : null}
                  </div>
                </section>
              </>
            ) : detailTab === "memory" ? (
              <section className="runtime-detail-section runtime-memory-detail">
                <div className="runtime-section-heading">
                  <h2>{t("settings.debug.realtime.memoryFiveMinutes")}</h2>
                  <span>RSS</span>
                </div>
                <MemorySparkline points={selectedHistory} />
                <dl>
                  <div><dt>RSS</dt><dd>{formatBytes(selectedProcess?.workingSetBytes)}</dd></div>
                  <div><dt>Δ 5m</dt><dd className={selectedDelta >= MEMORY_DELTA_WARNING_BYTES ? "is-warning-text" : ""}>{selectedDelta > 0 ? "+" : ""}{formatBytes(selectedDelta)}</dd></div>
                  <div><dt>Peak</dt><dd>{formatBytes(selectedProcess?.peakWorkingSetBytes)}</dd></div>
                  <div><dt>Private</dt><dd>{formatBytes(selectedProcess?.privateBytes)}</dd></div>
                  <div><dt>{t("settings.debug.realtime.sharedTargets")}</dt><dd>{selectedProcess?.targetCount ?? 0}</dd></div>
                </dl>
                <p>{t("settings.debug.realtime.processMemoryExplanation")}</p>
              </section>
            ) : detailTab === "events" ? (
              <section className="runtime-detail-section">
                <div className="runtime-section-heading"><h2>{t("settings.debug.realtime.recentEvents")}</h2><span>{selectedSurfaceEvents.length}</span></div>
                <div className="runtime-detail-events">
                  {selectedSurfaceEvents.map((entry) => (
                    <button key={entry.sequence} type="button" className={selectedEntry?.sequence === entry.sequence ? "is-selected" : ""} onClick={() => setSelectedSequence(entry.sequence)}>
                      <time>{formatFrameTime(Number(entry.recordedAt), locale)}</time>
                      <strong>{describeTrace(entry)}</strong>
                      <span>{directionGlyph(entry.direction)}</span>
                    </button>
                  ))}
                  {selectedSurfaceEvents.length === 0 ? <div className="runtime-empty">{t("settings.debug.realtime.noSurfaceEvents")}</div> : null}
                </div>
                {selectedEntry ? <pre>{tracePresentationCacheRef.current.get(selectedEntry.sequence)?.json || formatJson(selectedEntry.data)}</pre> : null}
              </section>
            ) : (
              <pre className="runtime-raw">{formatJson({ target: selectedTarget, process: selectedProcess })}</pre>
            )}
          </div>
          <footer className="runtime-detail-actions">
            <button type="button" className="is-primary" disabled={!selectedTarget?.webContentsId || selectedTarget.webContentsType !== "webview"} onClick={() => void openSelectedDevTools()}>
              <CodeOutlined />
              {t("settings.debug.realtime.openDevTools")}
            </button>
            <button type="button" disabled={!selectedTarget} onClick={() => void copySelectedSnapshot()}>
              <CopyOutlined />
              {t("settings.debug.realtime.copySnapshot")}
            </button>
          </footer>
        </aside>
      </section>
    </main>
  );
}
