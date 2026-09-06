type StartupTimingValue = string | number | boolean | null | undefined;

type StartupTimingMetadata = Record<string, StartupTimingValue>;

type StartupTimingEvent = {
  phase: string;
  metadata: StartupTimingMetadata;
  durationMs: number;
  startedAt: string;
  endedAt: string;
};

type StartupTimingOptions = {
  log?: boolean;
};

const startupTimingEvents: StartupTimingEvent[] = [];
const BAR_WIDTH = 32;
const SUMMARY_AGGREGATED_PHASES = new Set(["containerEngineAvailable"]);

function nowMs() {
  return Date.now();
}

function nowIso() {
  return new Date().toISOString();
}

function formatDurationMs(durationMs: number) {
  return `${Math.max(0, Math.round(durationMs))}ms`;
}

function formatMetadata(metadata: StartupTimingMetadata = {}) {
  return Object.entries(metadata)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${String(value).replace(/\s+/gu, "_")}`)
    .join(" ");
}

function formatStartupTimingLine(event: StartupTimingEvent, maxDurationMs: number) {
  const metadata = formatMetadata(event.metadata);
  const label = metadata ? `${event.phase} ${metadata}` : event.phase;
  const width = maxDurationMs > 0
    ? Math.max(1, Math.round((event.durationMs / maxDurationMs) * BAR_WIDTH))
    : 1;
  return `[startup-timing] ${label.padEnd(56)} ${formatDurationMs(event.durationMs).padStart(8)} ${"#".repeat(width)}`;
}

function compactStartupTimingEvents(events: StartupTimingEvent[]) {
  const compacted: StartupTimingEvent[] = [];
  const aggregateIndexes = new Map<string, number>();

  for (const event of events) {
    if (!SUMMARY_AGGREGATED_PHASES.has(event.phase)) {
      compacted.push(event);
      continue;
    }

    const key = `${event.phase}:${formatMetadata(event.metadata)}`;
    const existingIndex = aggregateIndexes.get(key);
    if (existingIndex === undefined) {
      aggregateIndexes.set(key, compacted.length);
      compacted.push({
        ...event,
        metadata: {
          ...event.metadata,
          count: 1,
          avgMs: event.durationMs,
          maxMs: event.durationMs
        }
      });
      continue;
    }

    const aggregate = compacted[existingIndex];
    const count = Number(aggregate.metadata.count ?? 1) + 1;
    const durationMs = aggregate.durationMs + event.durationMs;
    const maxMs = Math.max(Number(aggregate.metadata.maxMs ?? 0), event.durationMs);
    compacted[existingIndex] = {
      ...aggregate,
      durationMs,
      endedAt: event.endedAt,
      metadata: {
        ...aggregate.metadata,
        count,
        avgMs: Math.round(durationMs / count),
        maxMs
      }
    };
  }

  return compacted;
}

function cloneStartupTimingEvents() {
  return startupTimingEvents.map((event) => ({
    ...event,
    metadata: { ...event.metadata }
  }));
}

export function recordStartupTiming(
  phase: string,
  metadata: StartupTimingMetadata,
  durationMs: number,
  startedAt: string,
  endedAt: string,
  options: StartupTimingOptions = {}
) {
  const event = {
    phase,
    metadata: { ...metadata },
    durationMs: Math.max(0, Math.round(durationMs)),
    startedAt,
    endedAt
  };
  startupTimingEvents.push(event);
  if (options.log !== false) {
    const metadataText = formatMetadata(event.metadata);
    console.info(
      `[startup-timing] ${event.phase}${metadataText ? ` ${metadataText}` : ""} duration=${formatDurationMs(event.durationMs)}`
    );
  }
  return event;
}

export function beginStartupTiming(
  phase: string,
  metadata: StartupTimingMetadata = {},
  options: StartupTimingOptions = {}
) {
  const startedAtMs = nowMs();
  const startedAt = nowIso();
  let finished = false;

  return {
    end(extraMetadata: StartupTimingMetadata = {}) {
      if (finished) {
        return null;
      }
      finished = true;
      return recordStartupTiming(
        phase,
        { ...metadata, ...extraMetadata },
        nowMs() - startedAtMs,
        startedAt,
        nowIso(),
        options
      );
    }
  };
}

export function formatStartupTimingSummary(events: StartupTimingEvent[] = cloneStartupTimingEvents()) {
  if (events.length === 0) {
    return ["[startup-timing] summary total=0ms count=0"];
  }

  const firstStartedAt = Date.parse(events[0]?.startedAt ?? "");
  const lastEndedAt = Date.parse(events[events.length - 1]?.endedAt ?? "");
  const totalMs = Number.isFinite(firstStartedAt) && Number.isFinite(lastEndedAt)
    ? Math.max(0, lastEndedAt - firstStartedAt)
    : events.reduce((sum, event) => sum + event.durationMs, 0);
  const maxDurationMs = Math.max(...events.map((event) => event.durationMs), 0);
  const summaryEvents = compactStartupTimingEvents(events);
  return [
    `[startup-timing] summary total=${formatDurationMs(totalMs)} count=${events.length}`,
    ...summaryEvents.map((event) => formatStartupTimingLine(event, maxDurationMs))
  ];
}

export function flushStartupTimingSummary() {
  const lines = formatStartupTimingSummary();
  for (const line of lines) {
    console.info(line);
  }
  startupTimingEvents.length = 0;
  return lines;
}

export const __testInternals = {
  formatStartupTimingSummary,
  formatMetadata,
  compactStartupTimingEvents,
  recordStartupTiming,
  beginStartupTiming,
  flushStartupTimingSummary,
  clearStartupTimingEvents() {
    startupTimingEvents.length = 0;
  }
};
