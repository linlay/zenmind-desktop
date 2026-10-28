export { registerArtifactActionIpc, artifactRelativePath } from "./actions";
export { createArtifactPlatformClient } from "./platform-client";
export type { ArtifactPlatformApi } from "./platform-client";
import type { App, BrowserWindow, IpcMain } from "electron";
import type { RealtimeBroker } from "../agent-platform";
import type { DesktopArtifactIdentity, DesktopArtifactBatchInput, DesktopArtifactFolderInput, DesktopArtifactOrganizeInput, DesktopArtifactSyncState } from "../../../shared/artifacts";
import { requireEpochMillis } from "../../../shared/time-contract";
import { ArtifactStore, getArtifactDatabasePath } from "./store";
import { artifactError, type ArtifactPlatformApi } from "./platform-client";
import { cleanText, object, validIdentity } from "./metadata";
import { ARTIFACT_THUMBNAIL_LIMIT, artifactThumbnailDataUrl, canReadArtifactThumbnail } from "./thumbnail";
export function createArtifactRuntime(options: {
  app: App;
  platform: NodeJS.Platform;
  broker: Pick<RealtimeBroker, "subscribePush"> & Partial<Pick<RealtimeBroker, "subscribeConnection">>;
  platformApi?: ArtifactPlatformApi;
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  getMainWindow(): BrowserWindow | null;
  onError(error: unknown): void;
}) {
  // Lazy storage preserves first-install detection. Sync begins only after the Main handshake.
  const store = new ArtifactStore(() => getArtifactDatabasePath(options.app, options.platform));
  let notification: ReturnType<typeof setTimeout> | null = null;
  let disposed = false, connected = false, epoch = 0;
  let controller: AbortController | null = null;
  let syncTask: Promise<void> | null = null, requested = false;
  let sync: DesktopArtifactSyncState = { phase: "idle", completed: 0, total: 0, failed: 0, denied: 0 };
  const revisions = new Map<string, number>();
  const revision = (chatId: string) => revisions.get(chatId) ?? 0;
  const bump = (chatId: string) => revisions.set(chatId, revision(chatId) + 1);
  function notify() {
    if (notification || disposed)
      return;
    notification = setTimeout(() => {
      notification = null;
      const window = options.getMainWindow();
      if (window && !window.isDestroyed())
        window.webContents.send("artifacts.changed");
    }, 50);
    notification.unref?.();
  }
  function change(write: () => unknown) {
    try {
      write();
      notify();
    }
    catch (error) {
      options.onError(error);
    }
  }
  async function performSync(signal: AbortSignal, generation: number) {
    const api = options.platformApi!;
    sync = { ...sync, phase: "syncing", completed: 0, total: 0, failed: 0, denied: 0 };
    notify();
    const initialRevisions = new Map(revisions);
    const current = (chatId?: string) => !disposed && !signal.aborted && epoch === generation &&
      (!chatId || revision(chatId) === (initialRevisions.get(chatId) ?? 0));
    // Catalog failures never count as an empty catalog, and cannot remove cached records.
    const [activeResult, archiveResult] = await Promise.allSettled([api.listChats(signal), api.listArchives(signal)]);
    if (!current())
      return;
    if (archiveResult.status === "fulfilled") {
      for (const chat of archiveResult.value)
        if (current(chat.chatId))
          store.setChat(chat.chatId, "archived", "unknown", chat.chatName, chat.agentKey);
    }
    else
      sync.failed++;
    if (activeResult.status !== "fulfilled") {
      sync.failed++;
      sync.phase = "partial";
      notify();
      return;
    }
    const active = activeResult.value;
    if (archiveResult.status === "fulfilled") {
      const present = new Set([...active, ...archiveResult.value].map(c => c.chatId));
      for (const chatId of store.knownChats())
        if (!present.has(chatId) && current(chatId))
          store.setChat(chatId, "unavailable");
    }
    sync.total = active.length;
    notify();
    let position = 0;
    async function worker() {
      while (position < active.length && current()) {
        const chat = active[position++];
        if (!current(chat.chatId)) {
          sync.completed++;
          continue;
        }
        try {
          let items;
          // Retry a transient failure once. Permissions and manifest errors remain explicit.
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              items = await api.listArtifacts(chat.chatId, signal);
              break;
            }
            catch (error) {
              if (attempt || ["chat_access_denied", "artifact_not_found"].includes(artifactError(error)) || !current())
                throw error;
            }
          }
          if (!current(chat.chatId))
            continue;
          store.setChat(chat.chatId, "active", "available", chat.chatName, chat.agentKey);
          store.replaceChatManifest(chat.chatId, items!);
        }
        catch (error) {
          if (!current(chat.chatId))
            continue;
          const denied = artifactError(error) === "chat_access_denied";
          store.setChat(chat.chatId, "active", denied ? "denied" : "error", chat.chatName, chat.agentKey);
          if (denied)
            sync.denied++;
          else
            sync.failed++;
        }
        finally {
          if (current()) {
            sync.completed++;
            notify();
          }
        }
      }
    }
    await Promise.all([worker(), worker()]);
    if (!current())
      return;
    sync = { ...sync, phase: sync.failed || sync.denied ? "partial" : "complete", lastSyncedAt: requireEpochMillis(Date.now(), "library.lastSyncedAt") };
    notify();
  }
  function requestSync() {
    if (disposed || !options.platformApi)
      return;
    if (!connected) {
      sync = { ...sync, phase: "offline" };
      notify();
      return;
    }
    if (syncTask) {
      requested = true;
      return;
    }
    requested = false;
    const generation = epoch;
    controller = new AbortController();
    const signal = controller.signal;
    syncTask = performSync(signal, generation).catch(error => {
      if (!signal.aborted && !disposed && generation === epoch) {
        sync = { ...sync, phase: "partial", failed: sync.failed + 1 };
        options.onError(error);
        notify();
      }
    }).finally(() => {
      syncTask = null;
      controller = null;
      if (requested && !disposed && connected)
        requestSync();
    });
  }
  const unsubscribe = options.broker.subscribePush({
    types: ["artifact.published", "resource.pushed", "chat.deleted", "chat.archived", "archive.restored", "archive.deleted"],
    kind: "internal", consumerId: "desktop-artifact-index",
    onPush(frame) {
      if (disposed)
        return;
      const data = object(frame.data ?? frame.payload), chatId = cleanText(data.chatId);
      if (frame.type === "artifact.published" || frame.type === "resource.pushed") {
        if (chatId)
          bump(chatId);
        if (syncTask)
          requested = true;
        change(() => store.ingest(frame));
        return;
      }
      if (!chatId || /[/\\]/u.test(chatId))
        return;
      bump(chatId);
      change(() => store.setChat(chatId, frame.type === "chat.archived" ? "archived" : frame.type === "archive.restored" ? "active" : "deleted"));
      if (frame.type === "archive.restored")
        requestSync();
    },
  });
  const unsubscribeConnection = options.broker.subscribeConnection?.({ consumerId: "desktop-artifact-index", lane: "primary", onState(state) {
      const next = state.phase === "connected";
      if (next === connected)
        return;
      connected = next;
      epoch++;
      controller?.abort();
      if (connected)
        requestSync();
      else {
        sync = { ...sync, phase: "offline" };
        notify();
      }
    } });
  function authorize(event: Parameters<Parameters<IpcMain["handle"]>[1]>[0]) {
    const window = options.getMainWindow();
    if (disposed || !window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
      throw new Error("Library access denied");
  }
  options.ipcMain.handle("artifacts.list", (event, input) => { authorize(event); return { ...store.list(input), sync: { ...sync } }; });
  options.ipcMain.handle("artifacts.organize", (event, input: DesktopArtifactOrganizeInput) => { authorize(event); store.organize(input); notify(); });
  options.ipcMain.handle("artifacts.folder", (event, input: DesktopArtifactFolderInput) => { authorize(event); const result = store.folder(input); if (result.ok) notify(); return result; });
  options.ipcMain.handle("artifacts.organizeMany", (event, input: DesktopArtifactBatchInput) => { authorize(event); const result = store.organizeMany(input); if (result.ok) notify(); return result; });
  options.ipcMain.handle("artifacts.thumbnail", async (event, input: DesktopArtifactIdentity) => {
    authorize(event);
    if (!validIdentity(input) || !options.platformApi) return null;
    const item = store.get(input), generation = epoch, version = revision(input.chatId);
    if (!item || !canReadArtifactThumbnail(item)) return null;
    try {
      const bytes = await options.platformApi.read({ chatId: item.chatId, runId: item.runId, artifactId: item.artifactId }, AbortSignal.timeout(15_000), ARTIFACT_THUMBNAIL_LIMIT);
      authorize(event);
      const latest = store.get(input);
      if (disposed || generation !== epoch || version !== revision(input.chatId) || !latest || !canReadArtifactThumbnail(latest) || latest.sha256 !== item.sha256) return null;
      return artifactThumbnailDataUrl(bytes, item);
    } catch { return null; }
  });
  options.ipcMain.handle("artifacts.sync", event => { authorize(event); requestSync(); return { ...sync }; });
  return {
    recordPublished(event: Record<string, unknown>) {
      if (disposed)
        return;
      const chatId = cleanText(event.chatId);
      if (chatId)
        bump(chatId);
      if (syncTask)
        requested = true;
      change(() => store.ingestPublished(event));
    },
    actionContext(identity: DesktopArtifactIdentity) {
      const record = store.get(identity), generation = epoch, version = revision(identity.chatId);
      return { record, isCurrent: () => {
          if (disposed || epoch !== generation || revision(identity.chatId) !== version || !record)
            return false;
          const latest = store.get(identity);
          return !!latest && latest.sourceState === record.sourceState && latest.contentState === record.contentState &&
            latest.sha256 === record.sha256 && latest.pushedAt === record.pushedAt;
        } };
    },
    reportFailure(identity: DesktopArtifactIdentity, code: string) {
      change(() => {
        if (code === "artifact_changed")
          store.setContentState(identity, "changed");
        else if (code === "artifact_ambiguous")
          store.setContentState(identity, "ambiguous");
        else if (code === "artifact_not_found")
          store.setContentState(identity, "missing");
        else if (code === "chat_access_denied") {
          const record = store.get(identity);
          if (record?.sourceState === "active")
            store.setChat(identity.chatId, "active", "denied");
        }
      });
    },
    read(identity: DesktopArtifactIdentity, signal: AbortSignal) {
      if (!options.platformApi)
        throw new Error("Artifact reader unavailable");
      return options.platformApi.read(identity, signal);
    },
    dispose() {
      if (disposed)
        return;
      disposed = true;
      epoch++;
      controller?.abort();
      unsubscribe();
      unsubscribeConnection?.();
      if (notification)
        clearTimeout(notification);
      notification = null;
      for (const channel of ["artifacts.list", "artifacts.organize", "artifacts.sync", "artifacts.folder", "artifacts.organizeMany", "artifacts.thumbnail"])
        options.ipcMain.removeHandler(channel);
    },
  };
}
export type ArtifactRuntime = ReturnType<typeof createArtifactRuntime>;
