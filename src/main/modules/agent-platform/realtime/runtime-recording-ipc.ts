import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { App, BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { AgentRealtimeDebugSnapshot } from "../../../../shared/contracts";
import type { BrowserSurfaceRegistry } from "../../web-surfaces";
import type { AgentRealtimeDebugTraceInput } from "./realtime-debug-trace";
import { AgentRealtimeRecordingController } from "./runtime-recording-controller";

type RuntimeRecordingIpc = {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, input?: unknown) => unknown): void;
};

export function registerAgentRealtimeInspectorIpcHandlers(options: {
  app: App;
  ipcMain: RuntimeRecordingIpc;
  browserSurfaces: BrowserSurfaceRegistry;
  realtimeBroker: { setDebugRecorder(recorder: { append(input: AgentRealtimeDebugTraceInput): void } | null): void };
  mainProcessDir: string;
  inspectorRoutePath: string;
  getInspectorWindow: () => BrowserWindow | null;
  readSnapshot: () => Pick<AgentRealtimeDebugSnapshot, "runtime" | "connections"> & object;
  openInspectorWindow: () => Promise<unknown>;
  showSaveDialog: (options: {
    title: string;
    defaultPath: string;
    filters: Array<{ name: string; extensions: string[] }>;
  }, window: BrowserWindow | null) => Promise<{ canceled: boolean; filePath?: string }>;
  getMainWindow: () => BrowserWindow | null;
}) {
  const controller = new AgentRealtimeRecordingController({
    tempRoot: options.app.getPath("temp"),
    workerPath: path.join(options.mainProcessDir, "main", "runtime-recording-worker.js"),
    sampleSnapshot: () => {
      const snapshot = options.readSnapshot();
      return { runtime: snapshot.runtime, connections: snapshot.connections };
    },
  });
  options.realtimeBroker.setDebugRecorder(controller);
  options.app.once("will-quit", (event) => {
    event.preventDefault();
    options.realtimeBroker.setDebugRecorder(null);
    void controller.dispose().finally(() => options.app.quit());
  });

  const withInspector = async <T>(event: IpcMainInvokeEvent, task: () => Promise<T> | T) => {
    let trusted = false;
    try {
      const inspectorWindow = options.getInspectorWindow();
      const senderFrame = event.senderFrame;
      trusted = Boolean(
        inspectorWindow &&
        !inspectorWindow.isDestroyed() &&
        event.sender === inspectorWindow.webContents &&
        senderFrame === inspectorWindow.webContents.mainFrame &&
        new URL(senderFrame!.url).hash === `#${options.inspectorRoutePath}`
      );
    } catch {
      trusted = false;
    }
    if (!trusted) throw new Error("runtime_inspector_sender_required");
    return task();
  };
  const recordingIdFrom = (input: unknown) => input && typeof input === "object" &&
    typeof (input as { recordingId?: unknown }).recordingId === "string"
    ? (input as { recordingId: string }).recordingId.trim()
    : "";
  const exportingIds = new Set<string>();

  options.ipcMain.handle("diagnostics.openAgentRealtimeInspector", () => options.openInspectorWindow());
  options.ipcMain.handle("diagnostics.getAgentRealtimeDebugSnapshot", (event) =>
    withInspector(event, options.readSnapshot));
  options.ipcMain.handle("diagnostics.openAgentRealtimeTargetDevTools", (event, input) =>
    withInspector(event, () => {
      const webContentsId = input && typeof input === "object"
        ? Number((input as { webContentsId?: unknown }).webContentsId)
        : 0;
      if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) {
        return { ok: false, message: "A valid WebContents ID is required" };
      }
      const diagnostic = options.browserSurfaces.listWebContentsDiagnostics()
        .find((contents) => contents.webContentsId === webContentsId && contents.type === "webview");
      const contents = diagnostic ? options.browserSurfaces.findWebContentsById(webContentsId) : null;
      if (!contents || contents.isDestroyed()) return { ok: false, message: "The WebView is no longer available" };
      contents.openDevTools({ mode: "detach" });
      return { ok: true };
    }));
  options.ipcMain.handle("diagnostics.startAgentRealtimeRecording", (event) =>
    withInspector(event, () => controller.start()));
  options.ipcMain.handle("diagnostics.stopAgentRealtimeRecording", (event) =>
    withInspector(event, () => controller.stop()));
  options.ipcMain.handle("diagnostics.listAgentRealtimeRecordings", (event) =>
    withInspector(event, () => controller.list()));
  options.ipcMain.handle("diagnostics.setAgentRealtimeLiveEventsEnabled", (event, input) =>
    withInspector(event, () => controller.setLiveCaptureEnabled(
      Boolean(input && typeof input === "object" && (input as { enabled?: unknown }).enabled === true),
    )));
  options.ipcMain.handle("diagnostics.queryAgentRealtimeLiveEvents", (event, input) =>
    withInspector(event, () => controller.queryLiveEvents(
      input && typeof input === "object" && (input as { filter?: unknown }).filter &&
      typeof (input as { filter?: unknown }).filter === "object"
        ? (input as { filter: Parameters<typeof controller.queryLiveEvents>[0] }).filter
        : {},
    )));
  options.ipcMain.handle("diagnostics.getAgentRealtimeLiveEvent", (event, input) =>
    withInspector(event, () => controller.getLiveEvent(
      input && typeof input === "object" ? Number((input as { sequence?: unknown }).sequence) : 0,
    )));
  options.ipcMain.handle("diagnostics.queryAgentRealtimeRecordingEvents", (event, input) =>
    withInspector(event, () => {
      const filter = input && typeof input === "object" && (input as { filter?: unknown }).filter &&
        typeof (input as { filter?: unknown }).filter === "object"
        ? (input as { filter: Parameters<typeof controller.queryEvents>[1] }).filter
        : {};
      return controller.queryEvents(recordingIdFrom(input), filter);
    }));
  options.ipcMain.handle("diagnostics.getAgentRealtimeRecordingEvent", (event, input) =>
    withInspector(event, () => controller.getEvent(
      recordingIdFrom(input),
      input && typeof input === "object" ? Number((input as { sequence?: unknown }).sequence) : 0,
    )));
  options.ipcMain.handle("diagnostics.getAgentRealtimeRecordingSamples", (event, input) =>
    withInspector(event, () => controller.getSamples(
      recordingIdFrom(input),
      input && typeof input === "object" && typeof (input as { from?: unknown }).from === "number"
        ? Number((input as { from: number }).from) : undefined,
      input && typeof input === "object" && typeof (input as { to?: unknown }).to === "number"
        ? Number((input as { to: number }).to) : undefined,
    )));
  options.ipcMain.handle("diagnostics.deleteAgentRealtimeRecording", (event, input) =>
    withInspector(event, () => {
      const id = recordingIdFrom(input);
      if (exportingIds.has(id)) throw new Error("recording_is_exporting");
      return controller.delete(id);
    }));
  options.ipcMain.handle("diagnostics.exportAgentRealtimeRecording", (event, input) =>
    withInspector(event, async () => {
      const id = recordingIdFrom(input);
      const summary = (await controller.list()).find((item) => item.id === id);
      if (!summary) return { ok: false, message: "recording_not_found" };
      if (summary.state === "recording" || summary.state === "finalizing") return { ok: false, message: "recording_is_active" };
      if (exportingIds.has(id)) return { ok: false, message: "recording_is_exporting" };
      exportingIds.add(id);
      try {
        const safeName = summary.name.replace(/[\\/:*?"<>|]/gu, "-").trim() || "runtime-recording";
        const saveResult = await options.showSaveDialog({
          title: "Export runtime recording",
          defaultPath: `${safeName}.jsonl`,
          filters: [{ name: "JSON Lines", extensions: ["jsonl"] }],
        }, options.getMainWindow());
        if (saveResult?.canceled || !saveResult?.filePath) return { ok: false, canceled: true };
        await pipeline(
          fs.createReadStream(await controller.exportSource(id)),
          fs.createWriteStream(saveResult.filePath, { mode: 0o600 }),
        );
        return { ok: true };
      } finally {
        exportingIds.delete(id);
      }
    }));
}
