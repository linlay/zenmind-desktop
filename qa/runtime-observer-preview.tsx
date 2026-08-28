import React from "react";
import ReactDOM from "react-dom/client";
import { createTranslator } from "../src/shared/i18n";
import { RendererI18nContext } from "../src/renderer/i18n/i18n-context";
import { AgentRealtimeInspectorPage } from "../src/renderer/pages/AgentRealtimeInspectorPage";
import type { AgentRealtimeDebugSnapshot } from "../src/shared/contracts";
import "../src/renderer/styles.css";

const MB = 1024 * 1024;
let sample = 0;

const processSpecs = [
  [24116, "Browser", 190, 2.1, 2],
  [26344, "Tab", 246, 4.8, 4],
  [27560, "Tab", 128, 1.3, 2],
  [28672, "Tab", 76, 0.9, 2],
  [29988, "Tab", 62, 0.2, 1],
  [31004, "Tab", 18, 0, 1],
  [32010, "GPU", 122, 1.4, 0],
] as const;

function target(input: Partial<AgentRealtimeDebugSnapshot["runtime"]["targets"][number]> & {
  targetId: string;
  label: string;
}) {
  return {
    url: "",
    title: input.label,
    active: true,
    loading: false,
    crashed: false,
    devToolsOpened: false,
    backgroundThrottling: false,
    orphaned: false,
    ...input,
  };
}

function makeSnapshot(): AgentRealtimeDebugSnapshot {
  sample += 1;
  const capturedAt = Date.now() as AgentRealtimeDebugSnapshot["capturedAt"];
  const processes = processSpecs.map(([pid, type, memoryMb, cpuPercent, targetCount]) => ({
    pid,
    type,
    cpuPercent,
    creationTime: Date.now() - 8 * 60_000,
    sandboxed: type !== "Browser",
    workingSetBytes: (memoryMb + (pid === 26344 ? sample * 0.25 : 0)) * MB,
    peakWorkingSetBytes: (memoryMb + 18) * MB,
    privateBytes: (memoryMb * 0.72) * MB,
    targetCount,
  }));
  const targets = [
    target({ targetId: "main-window", label: "ZenMind Desktop", webContentsId: 1, webContentsType: "window", pid: 24116, url: "file:///(redacted)", title: "ZenMind Desktop" }),
    target({ targetId: "runtime-window", label: "Desktop Runtime Observer", webContentsId: 2, webContentsType: "window", pid: 24116, url: "file:///(redacted)", title: "Desktop Runtime Observer", active: false }),
    target({ targetId: "main-chat", surfaceId: "main-chat", registrationId: "reg-main", label: "Main Chat", surfaceKind: "service", surfaceType: "service", surfaceRole: "main-chat", surfaceLevel: "root", interaction: "interactive", ownerWebContentsId: 1, webContentsId: 11, webContentsType: "webview", pid: 26344, url: "https://app.zenmind.ai/agent/coder", title: "ZenMind Chat" }),
    target({ targetId: "copilot", surfaceId: "copilot-dock", registrationId: "reg-copilot", label: "Copilot Dock", surfaceKind: "service", surfaceType: "service", surfaceRole: "copilot-dock", surfaceLevel: "child", parentSurfaceId: "main-chat", interaction: "interactive", ownerWebContentsId: 1, webContentsId: 12, webContentsType: "webview", pid: 26344, url: "https://app.zenmind.ai/copilot/coder", title: "ZenMind Copilot" }),
    target({ targetId: "kanban", surfaceId: "kanban-chat", registrationId: "reg-kanban", label: "Kanban Chat", surfaceKind: "service", surfaceType: "service", surfaceRole: "kanban-chat", surfaceLevel: "root", interaction: "interactive", ownerWebContentsId: 1, webContentsId: 13, webContentsType: "webview", pid: 26344, url: "https://app.zenmind.ai/kanban", title: "Kanban" }),
    target({ targetId: "debug", surfaceId: "agent-debug", registrationId: "reg-debug", label: "Agent Debug", surfaceKind: "chat-work-panel", surfaceType: "chat-work-panel", surfaceRole: "debug", surfaceLevel: "child", parentSurfaceId: "main-chat", interaction: "read-only", ownerWebContentsId: 1, webContentsId: 14, webContentsType: "webview", pid: 26344, url: "https://app.zenmind.ai/debug", title: "Agent Debug", active: false }),
    target({ targetId: "browser-1", surfaceId: "browser", registrationId: "reg-browser", label: "Developer Docs", surfaceKind: "browser", surfaceType: "browser", surfaceRole: "browser", surfaceLevel: "root", interaction: "interactive", ownerWebContentsId: 1, webContentsId: 21, webContentsType: "webview", pid: 27560, url: "https://developer.mozilla.org/", title: "MDN" }),
    target({ targetId: "browser-2", surfaceId: "browser", registrationId: "reg-browser", label: "GitHub", surfaceKind: "browser", surfaceType: "browser", surfaceRole: "browser", surfaceLevel: "root", interaction: "interactive", ownerWebContentsId: 1, webContentsId: 22, webContentsType: "webview", pid: 27560, url: "https://github.com/zenmind/", title: "GitHub", active: false }),
    target({ targetId: "website", surfaceId: "website:zenmind", registrationId: "reg-site", label: "ZenMind Website", surfaceKind: "website", surfaceType: "website", surfaceRole: "website", surfaceLevel: "root", interaction: "interactive", ownerWebContentsId: 1, webContentsId: 31, webContentsType: "webview", pid: 28672, url: "https://zenmind.ai/", title: "ZenMind" }),
    target({ targetId: "webapp", surfaceId: "webapp:notes", registrationId: "reg-webapp", label: "Notes", surfaceKind: "webapp", surfaceType: "webapp", surfaceRole: "webapp", surfaceLevel: "root", interaction: "interactive", ownerWebContentsId: 1, webContentsId: 41, webContentsType: "webview", pid: 29988, url: "http://127.0.0.1:18421/", title: "Notes" }),
    target({ targetId: "orphan", label: "Old Panel", webContentsId: 51, webContentsType: "webview", pid: 31004, url: "https://app.zenmind.ai/old-panel", title: "Old Panel", active: false, orphaned: true }),
    target({ targetId: "crashed", surfaceId: "website:console", registrationId: "reg-console", label: "Console", surfaceKind: "website", surfaceType: "website", surfaceRole: "website", surfaceLevel: "root", interaction: "interactive", ownerWebContentsId: 1, webContentsId: 32, webContentsType: "webview", pid: 28672, url: "https://console.zenmind.ai/", title: "Console", active: false, crashed: true }),
  ];
  const trace = [
    { sequence: 1, recordedAt: (Date.now() - 3200) as typeof capturedAt, layer: "surface-bridge" as const, direction: "surface-to-desktop" as const, surfaceId: "copilot-dock", surfaceKind: "service", surfaceRole: "copilot-dock" as const, surfaceLevel: "child" as const, parentSurfaceId: "main-chat", interaction: "interactive" as const, route: "/copilot/coder", data: { type: "attach", webContentsId: 12 } },
    { sequence: 2, recordedAt: (Date.now() - 2800) as typeof capturedAt, layer: "surface-bridge" as const, direction: "desktop-to-surface" as const, surfaceId: "copilot-dock", data: { type: "dom-ready" } },
    { sequence: 3, recordedAt: (Date.now() - 1800) as typeof capturedAt, layer: "platform-ws" as const, direction: "desktop-to-platform" as const, surfaceId: "main-chat", data: { frame: "request.query", requestId: "req-42" } },
    { sequence: 4, recordedAt: (Date.now() - 900) as typeof capturedAt, layer: "platform-ws" as const, direction: "platform-to-desktop" as const, surfaceId: "main-chat", data: { frame: "run.start", runId: "run-84" } },
  ];
  return {
    capturedAt,
    runtime: { surfaceCount: 12, webviewCount: 9, orphanWebviewCount: 1, totalWorkingSetBytes: 842 * MB, processes, targets },
    connections: {
      primary: { source: "desktop-main", phase: "connected", generation: 4, physicalConnectionCount: 1, reconnectCount: 0, endpoint: "wss://platform.zenmind.ai/ws", physicalSessionId: "primary-4", lastInboundAt: capturedAt, lastHeartbeatAt: capturedAt },
      btw: { source: "desktop-btw", phase: "connected", generation: 1, physicalConnectionCount: 1, reconnectCount: 0, endpoint: "wss://platform.zenmind.ai/ws", physicalSessionId: "btw-1", lastInboundAt: capturedAt, lastHeartbeatAt: capturedAt },
    },
    broker: { pendingRequestCount: 0, pendingQueryCount: 0, activeStreamCount: 2, runCount: 2, localRunSubscriberCount: 1, pushSubscriberCount: 3, connectionSubscriberCount: 4, pendingCloneCount: 0, pendingClones: [], replayEventCount: 32, replayBytes: 12800, unknownFrameCount: 0, unknownRequestIdCount: 0, seqGapCount: 0, staleFrameCount: 0, seqRegressionCount: 0, duplicateTerminalCount: 0, replayEvictionCount: 0, observerReleaseCount: 1, seqExpiredCount: 0, upstreamAttachCount: 2, upstreamDetachCount: 1, cloneCreatedCount: 1, cloneRevokedCount: 0, laneRotationCount: 0 },
    bridge: { registeredSenderCount: 4, logicalSessionCount: 2, pendingRequestCount: 0, activeStreamCount: 2, rootObserver: { token: "redacted", kind: "main_chat", surfaceId: "main-chat", generation: "4", contextId: "chat-42", webContentsId: 11, runIds: ["run-84"] } },
    surfaces: [],
    logicalSessions: [{ logicalSessionId: "session-main", surfaceId: "main-chat", webContentsId: 11, phase: "connected", logicalGeneration: 4, physicalGeneration: 4, reconnectCount: 0, openedAt: (Date.now() - 480000) as typeof capturedAt, pendingRequestCount: 0, activeStreamCount: 1 }],
    runRecovery: [{ lane: "primary", runId: "run-84", chatId: "chat-42", lastSeq: 18, state: "observed", rootObserverCount: 1, cloneCount: 0, upstreamState: "attached", restoreCount: 0, lastRestoreResult: "not-needed" }],
    trace,
  };
}

(window as any).electronAPI = {
  diagnostics: {
    getAgentRealtimeDebugSnapshot: async () => makeSnapshot(),
    clearAgentRealtimeDebugTrace: async () => ({ ...makeSnapshot(), trace: [] }),
    openAgentRealtimeTargetDevTools: async () => ({ ok: true }),
  },
  clipboard: { writeText: async () => ({ ok: true }) },
};

document.documentElement.dataset.theme = "dark";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <RendererI18nContext.Provider value={{ locale: "en-US", source: "default", t: createTranslator("en-US"), setLocale: async () => undefined }}>
    <AgentRealtimeInspectorPage />
  </RendererI18nContext.Provider>,
);
