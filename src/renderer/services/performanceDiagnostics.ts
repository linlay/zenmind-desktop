import { sanitizePerformanceEvent } from "../../shared/performance-diagnostics";

let navigation: { route: string; switchId: string; start: number } | undefined;
export function beginChatPerformanceNavigation(route: string) {
  if (!window.electronAPI.diagnostics?.performanceEnabled) return;
  if (navigation) reportPerformanceEvent({ stage: "host-navigation-superseded", switchId: navigation.switchId });
  navigation = undefined;
  if (!route.startsWith("/agent/") || !new URLSearchParams(route.split("?")[1]).has("chatId")) return;
  navigation = { route, switchId: crypto.randomUUID(), start: performance.now() };
  reportPerformanceEvent({ stage: "host-navigation-requested", switchId: navigation.switchId });
}

export function reportPerformanceEvent(event: Record<string, unknown>) {
  if (!window.electronAPI.diagnostics?.performanceEnabled) return;
  window.electronAPI.diagnostics.reportRendererError({ level: "debug", source: "performance",
    message: "performance", details: sanitizePerformanceEvent({ ...event, hostMonoMs: performance.now() }) });
}

export function createSurfacePerformanceTrace() {
  const instanceId = crypto.randomUUID();
  const starts = new Map<number, { start: number; switchId: string }>();
  return (stage: string, details: Record<string, unknown>) => {
    if (!window.electronAPI.diagnostics?.performanceEnabled) return;
    const id = typeof details.transitionId === "number" ? details.transitionId
      : typeof details.previousTransitionId === "number" ? details.previousTransitionId : undefined;
    if (stage === "main-chat-router-waiting-ready" && id !== undefined) {
      if (starts.size >= 32) starts.delete(starts.keys().next().value!);
      const requested = navigation && navigation.route === details.hostRoute && performance.now() - navigation.start < 30000
        ? navigation : undefined;
      starts.set(id, requested ?? { start: performance.now(), switchId: `${instanceId}:${id}` });
      if (requested) navigation = undefined;
    }
    const start = id === undefined ? undefined : starts.get(id);
    reportPerformanceEvent({ ...details, stage, instanceId,
      ...(id === undefined ? {} : { switchId: start?.switchId ?? `${instanceId}:${id}` }),
      ...(start === undefined ? {} : { elapsedMs: performance.now() - start.start }),
    });
    if (id !== undefined && ["main-chat-router-applied-accepted", "main-chat-route-transition-replaced",
      "main-chat-route-load-url-failed"].includes(stage)) starts.delete(id);
  };
}

let consumers = 0;
let stopMonitor: (() => void) | undefined;
export function retainHostPerformanceMonitor() {
  if (!window.electronAPI.diagnostics?.performanceEnabled) return () => {};
  if (consumers++ === 0) {
    let last = performance.now();
    let count = 0, total = 0, max = 0;
    const observer = typeof PerformanceObserver !== "undefined" &&
      PerformanceObserver.supportedEntryTypes.includes("longtask")
      ? new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) { count++; total += entry.duration; max = Math.max(max, entry.duration); }
      }) : undefined;
    observer?.observe({ type: "longtask" });
    const timer = window.setInterval(() => {
      const now = performance.now();
      reportPerformanceEvent({ stage: "host-responsiveness", eventLoopDelayMs: Math.max(0, now - last - 5000),
        longTaskCount: count, longTaskTotalMs: total, longTaskMaxMs: max });
      last = now; count = total = max = 0;
    }, 5000);
    stopMonitor = () => { window.clearInterval(timer); observer?.disconnect(); };
  }
  return () => { if (--consumers === 0) { stopMonitor?.(); stopMonitor = undefined; } };
}
