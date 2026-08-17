import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentRealtimeDebugSnapshot,
  AgentRealtimeDebugTraceDirection,
  AgentRealtimeDebugTraceEntry,
  AgentRealtimeDebugTraceLayer,
} from "../../shared/contracts";
import { useI18n } from "../i18n/useI18n";
import "./AgentRealtimeInspectorPage.css";

type LayerFilter = "all" | AgentRealtimeDebugTraceLayer;
type DirectionFilter = "all" | AgentRealtimeDebugTraceDirection;
type DetailTab = "payload" | "context";
type TracePresentation = {
  json: string;
  size: string;
  searchText: string;
};

const MAX_RENDERED_FRAMES = 500;

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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

function formatFrameTime(value: number, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
  }).format(new Date(value));
}

function formatPayloadSize(json: string) {
  const bytes = new TextEncoder().encode(json).byteLength;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function createTracePresentation(entry: AgentRealtimeDebugTraceEntry): TracePresentation {
  const json = formatJson(entry.data);
  return {
    json,
    size: formatPayloadSize(json),
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

export function AgentRealtimeInspectorPage() {
  const { locale, t } = useI18n();
  const [snapshot, setSnapshot] = useState<AgentRealtimeDebugSnapshot | null>(null);
  const [message, setMessage] = useState("");
  const [live, setLive] = useState(true);
  const [follow, setFollow] = useState(true);
  const [search, setSearch] = useState("");
  const [layer, setLayer] = useState<LayerFilter>("all");
  const [direction, setDirection] = useState<DirectionFilter>("all");
  const [surfaceId, setSurfaceId] = useState("all");
  const [selectedSequence, setSelectedSequence] = useState<number | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("payload");
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

  const surfaceIds = useMemo(() => {
    const values = new Set<string>();
    snapshot?.surfaces.forEach((surface) => values.add(surface.surfaceId));
    snapshot?.trace.forEach((entry) => {
      if (entry.surfaceId) values.add(entry.surfaceId);
    });
    return [...values].sort((left, right) => left.localeCompare(right));
  }, [snapshot]);

  const filteredFrames = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase();
    return (snapshot?.trace || []).flatMap((entry) => {
      if (layer !== "all" && entry.layer !== layer) return [];
      if (direction !== "all" && entry.direction !== direction) return [];
      if (surfaceId !== "all" && entry.surfaceId !== surfaceId) return [];
      const presentation = tracePresentationCacheRef.current.get(entry.sequence) || createTracePresentation(entry);
      tracePresentationCacheRef.current.set(entry.sequence, presentation);
      if (normalizedSearch && !presentation.searchText.includes(normalizedSearch)) return [];
      return [{ entry, presentation }];
    });
  }, [direction, layer, search, snapshot?.trace, surfaceId]);

  useEffect(() => {
    if (selectedSequence !== null && !filteredFrames.some((frame) => frame.entry.sequence === selectedSequence)) {
      setSelectedSequence(null);
    }
  }, [filteredFrames, selectedSequence]);

  useEffect(() => {
    if (!follow || !frameListRef.current) return;
    frameListRef.current.scrollTop = frameListRef.current.scrollHeight;
  }, [filteredFrames.length, follow]);

  const selectedEntry = selectedSequence === null
    ? null
    : snapshot?.trace.find((entry) => entry.sequence === selectedSequence) || null;
  const selectedSurface = selectedEntry?.surfaceId
    ? snapshot?.surfaces.find((surface) => surface.surfaceId === selectedEntry.surfaceId) || null
    : null;
  const connection = snapshot?.connection;
  const connectionClass = connection?.phase === "connected"
    ? "is-connected"
    : connection?.phase === "connecting" || connection?.phase === "reconnecting"
      ? "is-connecting"
      : "is-disconnected";

  return (
    <main className="agent-realtime-inspector">
      <header className="agent-realtime-inspector-header">
        <div className="agent-realtime-inspector-title">
          <span className={`agent-realtime-inspector-status ${connectionClass}`} aria-hidden="true" />
          <div>
            <h1>{t("settings.debug.realtime.inspectorTitle")}</h1>
            <span>{connection?.endpoint || t("settings.debug.realtime.idle")}</span>
          </div>
        </div>
        <div className="agent-realtime-inspector-connection">
          <span>{connection?.phase || t("settings.debug.realtime.idle")}</span>
          <span>gen {connection?.generation ?? 0}</span>
          <span>WS {connection?.physicalConnectionCount ?? 0}</span>
          <span>↻ {connection?.reconnectCount ?? 0}</span>
          <span>{t("settings.debug.realtime.surfaces")} {snapshot?.surfaces.length ?? 0}</span>
        </div>
        <div className="agent-realtime-inspector-actions">
          <button type="button" onClick={() => void loadSnapshot()} title={t("common.refresh")}>↻</button>
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
            {live ? t("settings.debug.realtime.freeze") : t("settings.debug.realtime.resume")}
          </button>
          <button type="button" disabled={!snapshot?.trace.length} onClick={() => void clearTrace()}>
            {t("settings.debug.realtime.clear")}
          </button>
          <button
            type="button"
            disabled={filteredFrames.length === 0}
            onClick={() => void window.electronAPI.clipboard.writeText(
              formatJson(filteredFrames.map((frame) => frame.entry)),
            )}
          >
            {t("settings.debug.realtime.copy")}
          </button>
        </div>
      </header>

      <section className="agent-realtime-inspector-filters" aria-label={t("settings.debug.realtime.filters") }>
        <div className="agent-realtime-inspector-layer-tabs">
          {(["all", "platform-ws", "surface-bridge"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={layer === value ? "is-active" : ""}
              onClick={() => setLayer(value)}
            >
              {value === "all"
                ? t("settings.debug.realtime.all")
                : value === "platform-ws"
                  ? t("settings.debug.realtime.platformWs")
                  : t("settings.debug.realtime.surfaceBridge")}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={search}
          placeholder={t("settings.debug.realtime.searchPlaceholder")}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select value={direction} onChange={(event) => setDirection(event.target.value as DirectionFilter)}>
          <option value="all">{t("settings.debug.realtime.allDirections")}</option>
          <option value="platform-to-desktop">P → D</option>
          <option value="desktop-to-platform">D → P</option>
          <option value="surface-to-desktop">S → D</option>
          <option value="desktop-to-surface">D → S</option>
        </select>
        <select value={surfaceId} onChange={(event) => setSurfaceId(event.target.value)}>
          <option value="all">{t("settings.debug.realtime.allSurfaces")}</option>
          {surfaceIds.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <button
          type="button"
          className={follow ? "is-active" : ""}
          onClick={() => setFollow((current) => !current)}
        >
          {t("settings.debug.realtime.follow")}
        </button>
      </section>

      {message || connection?.lastError ? (
        <div className="agent-realtime-inspector-error" role="status">{message || connection?.lastError}</div>
      ) : null}

      <section className="agent-realtime-inspector-workspace">
        <div className="agent-realtime-inspector-frames">
          <div className="agent-realtime-inspector-frame-head" aria-hidden="true">
            <span>{t("settings.debug.realtime.time")}</span>
            <span>{t("settings.debug.realtime.direction")}</span>
            <span>{t("settings.debug.realtime.layer")}</span>
            <span>surfaceId</span>
            <span>{t("settings.debug.realtime.event")}</span>
            <span>{t("settings.debug.realtime.size")}</span>
          </div>
          <div
            ref={frameListRef}
            className="agent-realtime-inspector-frame-list"
            onScroll={(event) => {
              const element = event.currentTarget;
              const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 28;
              if (follow !== nearBottom) setFollow(nearBottom);
            }}
          >
            {filteredFrames.length === 0 ? (
              <div className="agent-realtime-inspector-empty">{t("settings.debug.realtime.empty")}</div>
            ) : filteredFrames.map(({ entry, presentation }) => (
              <button
                key={entry.sequence}
                type="button"
                className={`agent-realtime-inspector-frame is-${entry.direction}${selectedSequence === entry.sequence ? " is-selected" : ""}`}
                onClick={() => setSelectedSequence(entry.sequence)}
              >
                <time>{formatFrameTime(entry.recordedAt, locale)}</time>
                <code>{directionGlyph(entry.direction)}</code>
                <span>{entry.layer === "platform-ws" ? "Platform WS" : "Surface Bridge"}</span>
                <strong title={entry.surfaceId || ""}>{entry.surfaceId || "—"}</strong>
                <span title={describeTrace(entry)}>{describeTrace(entry)}</span>
                <span>{presentation.size}</span>
              </button>
            ))}
          </div>
        </div>

        <aside className="agent-realtime-inspector-detail">
          <div className="agent-realtime-inspector-detail-tabs">
            <button type="button" className={detailTab === "payload" ? "is-active" : ""} onClick={() => setDetailTab("payload")}>
              Payload
            </button>
            <button type="button" className={detailTab === "context" ? "is-active" : ""} onClick={() => setDetailTab("context")}>
              {t("settings.debug.realtime.context")}
            </button>
          </div>
          {!selectedEntry ? (
            <div className="agent-realtime-inspector-empty">{t("settings.debug.realtime.selectFrame")}</div>
          ) : detailTab === "payload" ? (
            <pre>{tracePresentationCacheRef.current.get(selectedEntry.sequence)?.json || formatJson(selectedEntry.data)}</pre>
          ) : (
            <dl className="agent-realtime-inspector-context">
              <div><dt>#</dt><dd>{selectedEntry.sequence}</dd></div>
              <div><dt>{t("settings.debug.realtime.time")}</dt><dd>{new Date(selectedEntry.recordedAt).toLocaleString(locale)}</dd></div>
              <div><dt>{t("settings.debug.realtime.direction")}</dt><dd>{selectedEntry.direction}</dd></div>
              <div><dt>{t("settings.debug.realtime.layer")}</dt><dd>{selectedEntry.layer}</dd></div>
              <div><dt>surfaceId</dt><dd>{selectedEntry.surfaceId || "—"}</dd></div>
              <div><dt>surface kind</dt><dd>{selectedEntry.surfaceKind || selectedSurface?.kind || "—"}</dd></div>
              <div><dt>webContentsId</dt><dd>{selectedEntry.webContentsId ?? selectedSurface?.webContentsId ?? "—"}</dd></div>
              <div><dt>route</dt><dd>{selectedEntry.route || selectedSurface?.route || "—"}</dd></div>
              <div><dt>ownerChatId</dt><dd>{selectedSurface?.ownerChatId || "—"}</dd></div>
              <div><dt>{t("settings.debug.realtime.active")}</dt><dd>{selectedSurface ? String(selectedSurface.active) : "—"}</dd></div>
            </dl>
          )}
        </aside>
      </section>

      <footer className="agent-realtime-inspector-footer">
        <span>{filteredFrames.length} / {snapshot?.trace.length ?? 0} {t("settings.debug.realtime.frames")}</span>
        <span>{t("settings.debug.realtime.runs")} {snapshot?.broker.runCount ?? 0}</span>
        <span>{t("settings.debug.realtime.streams")} {snapshot?.broker.activeStreamCount ?? 0}</span>
        <span>{live ? t("settings.debug.realtime.liveFast") : t("settings.debug.realtime.frozen")}</span>
      </footer>
    </main>
  );
}
