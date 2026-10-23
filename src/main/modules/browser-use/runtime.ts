import { createHash, randomUUID } from "node:crypto";
import type { BrowserUseBackend, BrowserUsePreferences, BrowserUseSettingsState, BrowserUseState } from "../../../shared/browser-use";
import { AWCP_LIMITS, assertToken, awcpHostError, validateInvokePayload, validateManualPayload } from "../awcp";

export type BrowserRunSource = { chatId: string; runId: string; agentKey: string };
export type BrowserAwcpDispatch = { handled: false } | { handled: true; result: unknown };
export type { BrowserWorkerClient } from "./chrome-workspace";
import type { BrowserWorkerClient, ChromeWorkspace, ChromeWorkspacePage as Page } from "./chrome-workspace";
type Session = {
  chatId: string;
  backend: BrowserUseBackend;
  workspace: ChromeWorkspace;
  connectionRequest?: BrowserUseState["connectionRequest"];
};
type Run = BrowserRunSource & {
  backend: BrowserUseBackend; ready: boolean; controller: AbortController; observations: Map<string, string>; connectionRequested?: boolean;
  checkedClient?: BrowserWorkerClient;
  connectionHealth?: { client: BrowserWorkerClient; promise: Promise<boolean> };
  awcpUsed?: boolean;
  workspaceId: string;
  workspaceGeneration?: number;
  pending: Set<Promise<unknown>>;
  downloads: Map<string, Set<string>>;
};
type RecordValue = Record<string, unknown>;
const chromeCapabilities = {
  observe: true, elementRefs: true, screenshot: true, open: true,
  rawCdp: false, evaluate: false, awcp: true, ignoreCacheReload: false,
  actionObservation: true, dialogs: true, uploadChatFiles: true, downloadToChat: true,
  interactions: ["fill", "type", "select", "focus", "scroll", "hover", "press", "check", "uncheck"],
};
const chromeOnlyMethods = new Set(["Surface.scroll", "Surface.handleDialog", "Surface.uploadFiles", "Surface.getDownloads", "Surface.readDownload"]);
const chromeOnlyInteractions = new Set(["type", "hover", "press", "check", "uncheck"]);
const privateConnectionParams = new Set(["extensionToken", "profileDirName", "userDataDir", "executablePath", "cdpEndpoint", "wsEndpoint", "browserURL", "browserUrl", "endpointURL", "port", "clientName", "channel"]);
const defaultPreferences: BrowserUsePreferences = { defaultBackend: "workpanel", rememberChromeConnection: false, hasSavedAuthorization: false, secureStorageAvailable: false };

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function failure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
function httpUrl(value: unknown) {
  let url: URL;
  try { url = new URL(text(value)); } catch { throw failure("invalid_args", "An HTTP(S) URL is required."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw failure("invalid_args", "Use an HTTP(S) URL without embedded credentials.");
  return url.href;
}
export function browserUseError(error: unknown) {
  const item = record(error);
  return {
    code: text(item.code) || "browser_failed",
    message: (error instanceof Error ? error.message : "The browser operation failed.")
      .replace(/wss?:\/\/[^\s"'<>]+/gu, "[browser connection]").slice(0, 1000),
  };
}

/** Main owns connections and Run leases. No renderer or model may create a lease. */
export class BrowserUseRuntime {
  private readonly sessions = new Map<string, Session>();
  private readonly runs = new Map<string, Run>();
  private readonly workspaces = new Map<string, ChromeWorkspace>();
  constructor(private readonly options: {
    clientName?: string;
    createClient(onExit: () => void): BrowserWorkerClient;
    onChanged?(state: BrowserUseState): void;
    onSettingsChanged?(state: BrowserUseSettingsState): void;
    preferences?: { read(): BrowserUsePreferences; authorization(): string | undefined };
    /** Main compiles only installed and enabled website bridges for this exact URL. */
    getWebsiteBridgeScript?(url: string): string;
    stopRun?(runId: string, agentKey: string): Promise<unknown>;
  }) {}

  private availableWorkspace(): ChromeWorkspace | undefined {
    return [...this.workspaces.values()].filter(workspace => workspace.shared || (workspace.client && ["connected", "connecting"].includes(workspace.connection)))
        .sort((left, right) => Number(!!right.owner) - Number(!!left.owner) || Number(right.pages.size > 0) - Number(left.pages.size > 0) || right.lastUsed - left.lastUsed)[0];
  }
  private attachAvailableWorkspace(session: Session) {
    if (!this.preferences().rememberChromeConnection || session.backend !== "chrome" || session.workspace.client || session.workspace.owner) return;
    const workspace = this.availableWorkspace(); if (!workspace || workspace === session.workspace) return;
    const previous = session.workspace; workspace.shared = true; session.workspace = workspace;
    if (!previous.client && !previous.owner && ![...this.sessions.values()].some(other => other.workspace === previous)) this.workspaces.delete(previous.id);
  }
  private workspaceFor(chatId: string, backend: BrowserUseBackend): ChromeWorkspace {
    const shared = backend === "chrome" && this.preferences().rememberChromeConnection;
    const existing = shared ? this.availableWorkspace() : undefined;
    if (existing) { existing.shared = true; return existing; }
    const id = randomUUID();
    const alias = createHash("sha256").update(shared ? id : chatId).digest("hex").slice(0, 8).toUpperCase();
    const workspace: ChromeWorkspace = { id, shared, generation: 0, activityRevision: 0, lastUsed: Date.now(), connection: "disconnected", pages: new Map(),
      connectionName: `${(this.options.clientName ?? "Desktop").slice(0, 60)} · ${alias}` };
    this.workspaces.set(id, workspace); return workspace;
  }
  private session(chatId: string) {
    if (!chatId.trim() || chatId.length > 256) throw failure("invalid_args", "A canonical Chat is required.");
    let session = this.sessions.get(chatId);
    if (!session) {
      const backend = this.preferences().defaultBackend;
      session = { chatId, backend, workspace: this.workspaceFor(chatId, backend) };
      this.sessions.set(chatId, session);
    }
    return session;
  }
  state(chatId: string): BrowserUseState {
    const session = this.session(chatId), workspace = session.workspace;
    return {
      chatId, backend: session.backend, connection: workspace.connection,
      pages: [...workspace.pages.values()].map(({ pageId: _pageId, ...page }) => page),
      connectionName: workspace.connectionName, workspaceId: workspace.id, workspaceShared: workspace.shared,
      ...(workspace.owner ? { workspaceOwner: { ...workspace.owner } } : {}),
      ...(workspace.selectedSurfaceId ? { selectedSurfaceId: workspace.selectedSurfaceId } : {}),
      ...(session.connectionRequest ? { connectionRequest: session.connectionRequest } : {}),
      activeRunIds: [...this.runs.values()].filter(run => run.chatId === chatId && !run.controller.signal.aborted).map(run => run.runId),
      ...(workspace.error ? { error: workspace.error } : {}),
    };
  }
  private preferences() {
    try { return this.options.preferences?.read() ?? defaultPreferences; }
    catch { return defaultPreferences; }
  }
  settingsState(): BrowserUseSettingsState {
    return { ...(this.options.preferences?.read() ?? defaultPreferences), connectedChats: [...this.sessions.values()].filter(session => session.backend === "chrome" && session.workspace.connection === "connected").length,
      activeRuns: [...this.runs.values()].filter(run => !run.controller.signal.aborted).length + [...this.workspaces.values()].filter(workspace => workspace.owner?.draining).length };
  }
  private settingsChanged() {
    try { this.options.onSettingsChanged?.(this.settingsState()); } catch { /* UI metadata cannot fail a page action. */ }
  }
  hasActiveRuns(): boolean { return [...this.runs.values()].some(run => !run.controller.signal.aborted) || [...this.workspaces.values()].some(workspace => !!workspace.owner); }
  async disconnectIdleConnections(): Promise<void> {
    if (this.hasActiveRuns()) throw failure("browser_busy", "Wait for browser tasks to stop and finish pending operations before forgetting Chrome authorization.");
    await Promise.all([...this.workspaces.values()].map(workspace => this.disconnectWorkspace(workspace)));
  }
  private changedWorkspace(workspace: ChromeWorkspace) {
    for (const session of this.sessions.values()) if (session.workspace === workspace) this.options.onChanged?.(this.state(session.chatId));
  }
  async refreshState(chatId: string): Promise<BrowserUseState> {
    const session = this.session(chatId), workspace = session.workspace;
    // UI reads must not queue behind or interrupt another Chat's owned operation.
    const owner = workspace.owner;
    if (owner?.draining || (owner && this.runs.get(owner.runId)?.pending.size)) return this.state(chatId);
    if (workspace.client && workspace.connection === "connected") {
      const client = workspace.client, generation = workspace.generation, activity = workspace.activityRevision;
      // A Run may start and finish while this UI request is waiting for a reply.
      const current = () => this.sessions.get(chatId) === session && session.workspace === workspace && workspace.client === client
        && workspace.generation === generation && workspace.activityRevision === activity && workspace.owner === owner;
      try {
        const health = record(await client.request("state"));
        if (!current()) return this.state(chatId);
        if (health.connected === false) { if (!workspace.owner) await this.disconnectWorkspace(workspace); }
        else await this.refreshWorkspacePages(workspace, undefined, undefined, current);
      } catch (error) {
        if (!current() || workspace.owner) return this.state(chatId);
        await this.disconnectWorkspace(workspace);
        workspace.error = browserUseError(error);
        this.changed(session);
      }
    }
    return this.state(chatId);
  }
  private changed(session: Session) { this.changedWorkspace(session.workspace); }
  private assertIdle(chatId: string) {
    if (this.state(chatId).activeRunIds.length) throw failure("browser_busy", "Take over the current task before changing its browser.");
  }
  select(chatId: string, backend: BrowserUseBackend) {
    if (backend !== "chrome" && backend !== "workpanel") throw failure("invalid_args", "Unsupported browser.");
    this.assertIdle(chatId);
    const session = this.session(chatId);
    this.assertWorkspaceIdle(session.workspace);
    if (backend === "chrome" && session.backend !== "chrome" && !session.workspace.client) session.workspace = this.workspaceFor(chatId, backend);
    session.backend = backend;
    this.changed(session);
    return this.state(chatId);
  }
  private assertWorkspaceIdle(workspace: ChromeWorkspace) {
    if (workspace.owner) throw failure(workspace.owner.draining ? "browser_workspace_draining" : "browser_busy", "The Chrome workspace is still controlled by another task. Wait or take over the workspace.");
  }
  async connect(chatId: string, options: { interactive?: boolean } = {}) {
    this.assertIdle(chatId);
    const session = this.session(chatId);
    if (session.backend !== "chrome" && !session.workspace.client) session.workspace = this.workspaceFor(chatId, "chrome");
    session.backend = "chrome";
    this.attachAvailableWorkspace(session);
    const workspace = session.workspace;
    this.assertWorkspaceIdle(workspace);
    if (workspace.connection === "connecting") throw failure("browser_connecting", "Chrome is waiting for connection approval.");
    if (options.interactive && workspace.client) { await this.disconnectWorkspace(workspace); this.assertIdle(chatId); this.assertWorkspaceIdle(workspace); }
    const extensionToken = !options.interactive && this.preferences().rememberChromeConnection ? this.options.preferences?.authorization() : undefined;
    await this.connectWorkspace(workspace, { extensionToken });
    this.changedWorkspace(workspace); return this.state(chatId);
  }
  /** A connection belongs to its workspace, never to the first Run waiting for it. */
  private connectWorkspace(workspace: ChromeWorkspace, options: { extensionToken?: string; timeoutMs?: number }): Promise<void> {
    if (workspace.connecting) return workspace.connecting.promise;
    if (workspace.connection === "connected" && workspace.client) return Promise.resolve();
    const previous = workspace.client; workspace.client = undefined; previous?.kill();
    workspace.pages.clear(); workspace.selectedSurfaceId = undefined;
    workspace.connection = "connecting"; workspace.error = undefined;
    const generation = ++workspace.generation, abort = new AbortController();
    let client: BrowserWorkerClient;
    try { client = this.options.createClient(() => {
      if (!client || workspace.client !== client || workspace.generation !== generation) return;
      const wasConnecting = workspace.connection === "connecting";
      workspace.client = undefined; workspace.pages.clear(); workspace.selectedSurfaceId = undefined;
      workspace.connection = "disconnected"; workspace.connecting?.abort.abort(); workspace.connecting = undefined;
      workspace.owner = undefined; workspace.drain = undefined;
      if (!wasConnecting) for (const run of this.runs.values()) if (run.workspaceId === workspace.id && run.backend === "chrome") run.controller.abort();
      this.changedWorkspace(workspace); this.settingsChanged();
    }); } catch {
      const error = failure("browser_runtime_unavailable", "Chrome connection could not be started. Check Desktop's browser installation and connect again.");
      workspace.connection = "error"; workspace.error = browserUseError(error);
      this.changedWorkspace(workspace); this.settingsChanged(); return Promise.reject(error);
    }
    workspace.client = client; this.changedWorkspace(workspace);
    let timer: ReturnType<typeof setTimeout> | undefined, rejectAbort: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(failure("browser_disconnected", "Chrome connection was canceled."));
      abort.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const promise = Promise.resolve().then(async () => {
      try {
        if (options.timeoutMs) timer = setTimeout(() => abort.abort(), options.timeoutMs);
        await Promise.race([client.request("connect", { channel: "chrome", clientName: workspace.connectionName,
          ...(options.extensionToken ? { extensionToken: options.extensionToken } : {}) }, undefined, abort.signal), interrupted]);
        if (abort.signal.aborted || workspace.client !== client || workspace.generation !== generation) throw failure("browser_disconnected", "Chrome connection was canceled.");
        workspace.connection = "connected";
        await Promise.race([this.refreshWorkspacePages(workspace), interrupted]);
        if (abort.signal.aborted || workspace.client !== client || workspace.generation !== generation) throw failure("browser_disconnected", "Chrome connection was canceled.");
        for (const session of this.sessions.values()) if (session.workspace === workspace) session.connectionRequest = undefined;
        this.changedWorkspace(workspace); this.settingsChanged();
      } catch (error) {
        const safeError = options.extensionToken ? failure("chrome_connection_failed", "Chrome could not reconnect with the saved authorization. Connect again from browser settings or choose a page.") : error;
        if (workspace.client === client && workspace.generation === generation) {
          workspace.client = undefined; workspace.pages.clear(); workspace.selectedSurfaceId = undefined; client.kill();
          workspace.connection = "error"; workspace.error = browserUseError(safeError); this.changedWorkspace(workspace); this.settingsChanged();
        }
        throw safeError;
      } finally {
        clearTimeout(timer); abort.signal.removeEventListener("abort", rejectAbort!);
        if (workspace.connecting?.promise === promise) workspace.connecting = undefined;
      }
    });
    workspace.connecting = { promise, abort }; return promise;
  }
  prepareRun(source: BrowserRunSource) {
    if (!source.chatId || !source.runId || !source.agentKey) return;
    const existing = this.runs.get(source.runId);
    if (existing) return; // A Run's environment is immutable, including re-attach.
    this.attachAvailableWorkspace(this.session(source.chatId));
    this.runs.set(source.runId, { ...source, backend: this.session(source.chatId).backend, ready: false, controller: new AbortController(), observations: new Map(), workspaceId: this.session(source.chatId).workspace.id, pending: new Set(), downloads: new Map() });
    this.changed(this.session(source.chatId));
    this.settingsChanged();
  }
  registerRun(source: BrowserRunSource) {
    this.prepareRun(source);
    const run = this.runs.get(source.runId);
    if (run && run.chatId === source.chatId && run.agentKey === source.agentKey) run.ready = true;
  }
  private acquireWorkspace(session: Session, run: Run) {
    const workspace = session.workspace;
    if (run.workspaceId !== workspace.id) throw failure("browser_run_unavailable", "This task belongs to an earlier Chrome workspace.");
    if (workspace.owner && (workspace.owner.runId !== run.runId || workspace.owner.draining))
      throw failure(workspace.owner.draining ? "browser_workspace_draining" : "browser_busy", "Another task controls this Chrome workspace. Wait until it finishes or take over the workspace.");
    const changed = !workspace.owner;
    workspace.owner = { chatId: run.chatId, runId: run.runId, draining: false };
    workspace.activityRevision++;
    workspace.lastUsed = Date.now(); if (changed) this.changedWorkspace(workspace);
  }
  private waitForRun<T>(work: Promise<T>, run: Run, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(failure("browser_run_unavailable", "The browser task was stopped."));
    let abort: () => void = () => undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(failure("browser_run_unavailable", "The browser task was stopped."));
      signal.addEventListener("abort", abort, { once: true });
    });
    return Promise.race([work, interrupted]).then(value => {
      if (signal.aborted || this.runs.get(run.runId) !== run) throw failure("browser_run_unavailable", "The browser task was stopped.");
      return value;
    }).finally(() => signal.removeEventListener("abort", abort));
  }
  private runRequest(session: Session, run: Run, method: string, params: RecordValue, pageId: string | undefined, signal: AbortSignal): Promise<unknown> {
    const client = this.client(session);
    if (signal.aborted || this.runs.get(run.runId) !== run) return Promise.reject(failure("browser_run_unavailable", "The browser task was stopped."));
    if (run.workspaceGeneration !== undefined && run.workspaceGeneration !== session.workspace.generation)
      return Promise.reject(failure("browser_run_unavailable", "The Chrome connection changed after this task began. Start a new task and observe its current pages."));
    const raw = client.request(method, params, pageId, signal); run.pending.add(raw);
    const finished = () => {
      run.pending.delete(raw);
      if (signal.aborted && client.drain) {
        const drain = client.drain(); run.pending.add(drain);
        void drain.then(() => run.pending.delete(drain), () => run.pending.delete(drain));
      }
    };
    void raw.then(finished, finished);
    return this.waitForRun(raw, run, signal);
  }
  releaseRun(runId: string) {
    const run = this.runs.get(runId);
    if (!run) return;
    const workspace = this.workspaces.get(run.workspaceId);
    if (run.awcpUsed && workspace?.client && workspace.connection === "connected")
      void workspace.client.request("awcp-release-run", { runId }).catch(() => undefined);
    run.controller.abort(); this.runs.delete(runId); run.observations.clear(); run.downloads.clear();
    if (workspace?.owner?.runId === runId) {
      const pending = [...run.pending], client = workspace.client, generation = workspace.generation;
      if (!pending.length) workspace.owner = undefined;
      else {
        workspace.owner.draining = true;
        const drain = Promise.allSettled(pending).then(async () => { await client?.drain?.(); }).then(() => {
          if (workspace.generation !== generation || workspace.owner?.runId !== runId) return;
          workspace.owner = undefined; workspace.drain = undefined;
          this.changedWorkspace(workspace); this.settingsChanged();
        });
        workspace.drain = drain; void drain.catch(() => undefined);
      }
    }
    const session = this.sessions.get(run.chatId);
    if (session?.connectionRequest?.runId === runId) session.connectionRequest = undefined;
    if (workspace) this.changedWorkspace(workspace); this.settingsChanged();
  }
  async takeover(chatId: string) {
    const workspace = this.session(chatId).workspace;
    const lease = workspace.owner, owner = lease ? this.runs.get(lease.runId) : undefined;
    const runs = lease ? (owner ? [owner] : []) : [...this.runs.values()].filter(run => run.chatId === chatId && !run.controller.signal.aborted);
    for (const run of runs) run.controller.abort();
    await this.disconnectWorkspace(workspace);
    const results = await Promise.allSettled(runs.map(async run => {
      const response = await this.options.stopRun?.(run.runId, run.agentKey);
      if (record(response).ok === false) throw failure("run_interrupt_failed", "The task could not be interrupted.");
    }));
    for (const run of runs) this.releaseRun(run.runId);
    if (results.some(result => result.status === "rejected")) throw failure("run_interrupt_failed", "Browser control was released, but the task could not be interrupted.");
    return this.state(chatId);
  }
  private async disconnectWorkspace(workspace: ChromeWorkspace): Promise<void> {
    const client = workspace.client; workspace.client = undefined; ++workspace.generation;
    workspace.connecting?.abort.abort(); workspace.connecting = undefined;
    workspace.pages.clear(); workspace.selectedSurfaceId = undefined; workspace.owner = undefined; workspace.drain = undefined;
    workspace.connection = "disconnected"; workspace.error = undefined;
    for (const run of this.runs.values()) if (run.workspaceId === workspace.id && run.backend === "chrome") run.controller.abort();
    for (const session of this.sessions.values()) if (session.workspace === workspace) session.connectionRequest = undefined;
    this.changedWorkspace(workspace); this.settingsChanged();
    if (client) { try { await client.disconnect(); } finally { client.kill(); } }
  }
  async disconnect(chatId: string) {
    await this.disconnectWorkspace(this.session(chatId).workspace); return this.state(chatId);
  }
  async releaseChat(chatId: string) {
    const session = this.sessions.get(chatId); if (!session) return;
    for (const run of [...this.runs.values()]) if (run.chatId === chatId) this.releaseRun(run.runId);
    this.sessions.delete(chatId);
    const workspace = session.workspace;
    const orphaned = () => this.workspaces.get(workspace.id) === workspace && !workspace.shared
      && ![...this.sessions.values()].some(other => other.workspace === workspace);
    if (orphaned()) {
      const generation = workspace.generation;
      await workspace.drain;
      // Remembering may promote this workspace or another Chat may attach while the old Run drains.
      if (orphaned() && workspace.generation === generation && !workspace.owner) {
        this.workspaces.delete(workspace.id);
        await this.disconnectWorkspace(workspace);
      } else this.changedWorkspace(workspace);
    } else this.changedWorkspace(workspace);
    this.settingsChanged();
  }
  async activate(chatId: string, surfaceId: string) {
    const session = this.session(chatId);
    this.assertWorkspaceIdle(session.workspace);
    const page = this.page(session, surfaceId);
    const client = this.client(session);
    await client.request("activate", {}, page.pageId);
    if (session.workspace.client !== client || !session.workspace.pages.has(surfaceId)) {
      throw failure("browser_disconnected", "This browser selection belongs to a released connection.");
    }
    session.workspace.selectedSurfaceId = surfaceId;
    this.changed(session);
    return this.state(chatId);
  }
  private client(session: Session) {
    if (!session.workspace.client || session.workspace.connection !== "connected")
      throw failure("browser_connection_required", "Connect Chrome from the browser control at the top of this Chat, then start a new task.");
    return session.workspace.client;
  }
  private page(session: Session, surfaceId: string) {
    const page = session.workspace.pages.get(surfaceId);
    if (!page) throw failure("target_not_found", "This Chrome workspace does not contain that page. Read its current page list before continuing.");
    return page;
  }
  private async refreshPages(session: Session, signal?: AbortSignal, run?: Run) {
    const workspace = session.workspace;
    return this.refreshWorkspacePages(workspace, signal, run ? (method, params) => this.runRequest(session, run, method, params, undefined, signal!) : undefined);
  }
  private async refreshWorkspacePages(workspace: ChromeWorkspace, signal?: AbortSignal, request?: (method: string, params: RecordValue) => Promise<unknown>, accept?: () => boolean) {
    const client = workspace.client, generation = workspace.generation;
    if (!client || workspace.connection !== "connected") throw failure("browser_connection_required", "Connect this Chrome workspace before using its pages.");
    const result = await (request ? request("list", {}) : client.request("list", {}, undefined, signal));
    if (workspace.client !== client || workspace.generation !== generation || signal?.aborted) throw failure("browser_disconnected", "Chrome disconnected.");
    if (accept && !accept()) return [...workspace.pages.values()].map(({ pageId: _pageId, ...page }) => page);
    const rows = Array.isArray(result) ? result : record(result).pages;
    if (!Array.isArray(rows)) throw failure("browser_protocol_error", "Chrome returned an invalid page list.");
    const existing = new Map([...workspace.pages.values()].map(page => [page.pageId, page])), pages = new Map<string, Page>();
    for (const row of rows.slice(0, 100)) {
      const item = record(row), pageId = text(item.pageId); if (!pageId) continue;
      let url: string; try { url = httpUrl(item.url); } catch { continue; }
      const page: Page = { surfaceId: existing.get(pageId)?.surfaceId ?? `chrome:${randomUUID()}`, pageId, provider: "chrome",
        title: text(item.title).slice(0, 500), url: url.slice(0, 4096), active: item.active === true, isLoading: item.isLoading === true };
      pages.set(page.surfaceId, page);
    }
    workspace.pages = pages;
    if (workspace.selectedSurfaceId && !pages.has(workspace.selectedSurfaceId)) workspace.selectedSurfaceId = undefined;
    if (!workspace.selectedSurfaceId && pages.size === 1) workspace.selectedSurfaceId = pages.keys().next().value;
    this.changedWorkspace(workspace);
    return [...pages.values()].map(({ pageId: _pageId, ...page }) => page);
  }
  private lease(source: unknown) {
    const identity = record(source);
    const run = this.runs.get(text(identity.runId));
    if (!run || !run.ready || run.chatId !== text(identity.chatId) || run.agentKey !== text(identity.agentKey) || run.controller.signal.aborted)
      throw failure("browser_run_unavailable", "This browser task is no longer authorized. Start a new task in the owning Chat.");
    return run;
  }

  private requestConnection(session: Session, run: Run) {
    // A UI request is itself scoped to the accepted, live lease; untrusted tool sources cannot summon it.
    if (this.runs.get(run.runId) !== run || !run.ready || run.controller.signal.aborted || run.chatId !== session.chatId || run.connectionRequested) return;
    run.connectionRequested = true;
    session.connectionRequest = { id: randomUUID(), runId: run.runId, reason: session.workspace.connection === "connected" ? "new_run" : "connect" };
    this.changed(session);
  }

  /** A live utility process may contain an engine whose extension context has closed. */
  private retireConnection(session: Session, client: BrowserWorkerClient) {
    if (session.workspace.client !== client) return;
    session.workspace.client = undefined;
    session.workspace.pages.clear();
    session.workspace.selectedSurfaceId = undefined;
    session.workspace.connection = "disconnected";
    session.workspace.generation++;
    session.workspace.error = undefined;
    // Clear ownership before terminating this worker; its late exit cannot revoke a replacement lease.
    client.kill();
    this.changed(session);
    this.settingsChanged();
  }

  private connectedForRun(session: Session, run: Run, signal: AbortSignal): Promise<boolean> {
    const client = session.workspace.client;
    if (!client || session.workspace.connection !== "connected") return Promise.resolve(false);
    if (run.checkedClient === client) return Promise.resolve(true);
    if (run.connectionHealth?.client === client) return run.connectionHealth.promise;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped: () => void = () => undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      stopped = () => {
        // Caller cancellation does not release a shared connection; the old request drains.
        reject(failure("browser_run_unavailable", "The browser task was stopped."));
      };
      signal.addEventListener("abort", stopped, { once: true });
      timer = setTimeout(() => reject(failure("browser_connection_health_timeout", "Chrome did not confirm its connection state in time.")), 5000);
    });
    const promise = Promise.resolve().then(async () => {
      try {
        if (signal.aborted) throw failure("browser_run_unavailable", "The browser task was stopped.");
        const health = record(await Promise.race([this.runRequest(session, run, "state", {}, undefined, signal), interrupted]));
        if (signal.aborted || this.runs.get(run.runId) !== run || this.sessions.get(run.chatId) !== session)
          throw failure("browser_run_unavailable", "The browser task was stopped.");
        if (session.workspace.client !== client) throw failure("browser_connection_changed", "Chrome's connection changed before the task began.");
        if (health.connected !== false) { run.checkedClient = client; return true; }
        this.retireConnection(session, client);
        run.observations.clear();
        return false;
      } catch (error) {
        if (signal.aborted || this.runs.get(run.runId) !== run)
          throw failure("browser_run_unavailable", "The browser task was stopped.");
        if (session.workspace.client !== client) throw failure("browser_connection_changed", "Chrome's connection changed before the task began.");
        if (["browser_disconnected", "cancelled", "browser_connection_health_timeout"].includes(text(record(error).code))) {
          this.retireConnection(session, client);
          run.observations.clear();
          return false;
        }
        throw error;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", stopped);
        if (run.connectionHealth?.promise === promise) run.connectionHealth = undefined;
      }
    });
    run.connectionHealth = { client, promise };
    return promise;
  }

  private async ensureChromeConnection(session: Session, run: Run, signal: AbortSignal) {
    if (signal.aborted) throw failure("browser_run_unavailable", "The browser task was stopped.");
    if (run.workspaceGeneration !== undefined && run.workspaceGeneration !== session.workspace.generation)
      throw failure("browser_run_unavailable", "The Chrome connection changed after this task began. Start a new task and observe its current pages.");
    if (await this.connectedForRun(session, run, signal)) { run.workspaceGeneration = session.workspace.generation; return; }
    if (signal.aborted || this.runs.get(run.runId) !== run) throw failure("browser_run_unavailable", "The browser task was stopped.");
    let extensionToken: string | undefined;
    try { extensionToken = this.preferences().rememberChromeConnection ? this.options.preferences?.authorization() : undefined; }
    catch {
      this.requestConnection(session, run);
      throw failure("browser_connection_required", "Saved Chrome authorization is unavailable. Open browser settings or choose a page, then start a new task.");
    }
    if (!extensionToken) {
      this.requestConnection(session, run);
      throw failure("browser_connection_required", "Connect Chrome in browser settings or choose a page from this Chat's browser control, then start a new task.");
    }
    const workspace = session.workspace;
    if (workspace.shared && !this.preferences().rememberChromeConnection) throw failure("browser_connection_required", "Connect Chrome explicitly before continuing this task.");
    const pending = this.connectWorkspace(workspace, { extensionToken, timeoutMs: 15_000 });
    try {
      await this.waitForRun(pending, run, signal);
      if (signal.aborted || this.runs.get(run.runId) !== run || this.sessions.get(run.chatId) !== session || session.workspace !== workspace)
        throw failure("browser_run_unavailable", "The browser task was stopped.");
      run.checkedClient = this.client(session);
      run.workspaceGeneration = workspace.generation;
    } catch (error) {
      if (signal.aborted || this.runs.get(run.runId) !== run) throw failure("browser_run_unavailable", "The browser task was stopped.");
      this.requestConnection(session, run); throw error;
    }
  }

  /** Only the authenticated AWCP bridge calls this; model parameters never contain scripts. */
  async awcp(
    requestId: string,
    method: "AWCP.getManual" | "AWCP.invoke",
    request: RecordValue,
    source: RecordValue,
    signal: AbortSignal,
    surfaceId?: string,
  ): Promise<BrowserAwcpDispatch> {
    const candidate = this.runs.get(text(source.runId));
    if (!candidate || candidate.backend !== "chrome") {
      if (typeof surfaceId === "string" && surfaceId.startsWith("chrome:"))
        throw failure("browser_run_unavailable", "This Chrome page is not authorized for the current task.");
      return { handled: false };
    }
    const run = this.lease(source);
    assertToken("requestId", requestId, AWCP_LIMITS.maxRequestIdLength);
    if (method !== "AWCP.getManual" && method !== "AWCP.invoke")
      throw awcpHostError("awcp_invalid_request", "Unsupported AWCP operation.");
    const payload = method === "AWCP.getManual" ? validateManualPayload(request) : validateInvokePayload(requestId, request);
    if (typeof surfaceId !== "string" || !surfaceId.trim() || !surfaceId.startsWith("chrome:"))
      throw awcpHostError("awcp_target_unavailable", "Chrome AWCP requires an exact page in this Chat.");
    const combined = AbortSignal.any([signal, run.controller.signal]);
    if (combined.aborted) throw failure("browser_run_unavailable", "The browser task was stopped.");
    const session = this.session(run.chatId);
    this.acquireWorkspace(session, run);
    await this.ensureChromeConnection(session, run, combined);
    await this.refreshPages(session, combined, run);
    if (combined.aborted || this.runs.get(run.runId) !== run)
      throw failure("browser_run_unavailable", "The browser task was stopped.");
    const page = this.page(session, surfaceId);
    const client = this.client(session);
    // No package is loaded from model data or an arbitrary path. The browser world
    // verifies this exact URL again before installing anything or calling AWCP.
    let bridgeScript: string;
    try { bridgeScript = this.options.getWebsiteBridgeScript?.(page.url) ?? "void 0"; }
    catch { throw awcpHostError("awcp_bridge_unavailable", "Installed website bridges could not be prepared."); }
    if (typeof bridgeScript !== "string" || Buffer.byteLength(bridgeScript, "utf8") > 12 * 1024 * 1024)
      throw awcpHostError("awcp_bridge_unavailable", "The website bridge exceeds its execution budget.");
    run.awcpUsed = true;
    if (method === "AWCP.invoke") run.observations.delete(surfaceId);
    try {
      const result = await this.runRequest(session, run, method === "AWCP.getManual" ? "awcp-manual" : "awcp-invoke", {
        requestId, runId: run.runId, payload, expectedUrl: page.url, bridgeScript,
      }, page.pageId, combined);
      if (combined.aborted || session.workspace.client !== client || this.runs.get(run.runId) !== run)
        throw failure("browser_run_unavailable", "The browser task was stopped.");
      return { handled: true, result };
    } catch (error) {
      if (!combined.aborted && ["browser_disconnected", "cancelled"].includes(text(record(error).code)) && session.workspace.client === client)
        await this.disconnect(run.chatId);
      throw error;
    }
  }

  /** Settings package changes revoke AWCP bindings while standard browser control remains available. */
  refreshWebsiteBridges(): void {
    for (const workspace of this.workspaces.values()) {
      if (workspace.connection !== "connected" || !workspace.client) continue;
      const client = workspace.client;
      void client.request("awcp-refresh", {}).catch(() => undefined);
    }
  }

  /** Called exclusively by the already authenticated reverse Platform bridge. */
  async cdp(request: RecordValue, signal: AbortSignal | undefined, fallback: (signal: AbortSignal) => Promise<unknown>) {
    const run = this.lease(request.source);
    const combined = signal ? AbortSignal.any([signal, run.controller.signal]) : run.controller.signal;
    const method = text(request.method);
    const surfaceId = text(request.surfaceId);
    const params = record(request.params);
    if (combined.aborted) throw failure("browser_run_unavailable", "The task was stopped.");
    if (Object.keys(params).some(key => privateConnectionParams.has(key)))
      throw failure("invalid_args", "Browser connection settings are private to Desktop settings and cannot be supplied by a page operation.");
    if (["Surface.click", "Surface.interact", "Surface.handleDialog", "Surface.uploadFiles"].includes(method)
      && ("ref" in params || "observationId" in params || "dialogId" in params || "chooserId" in params)) {
      if (run.observations.get(surfaceId) !== text(params.observationId))
        throw failure("stale_observation", "Observe this page in the current task before using an element reference.");
    }
    if (run.backend === "workpanel") {
      if (chromeOnlyMethods.has(method) || (method === "Surface.observe" && "viewportOnly" in params) || (method === "Surface.interact"
        && (chromeOnlyInteractions.has(text(params.action)) || "values" in params))) {
        throw failure("capability_unavailable", "This operation requires the connected Chrome environment.");
      }
      if (surfaceId.startsWith("chrome:") || method === "Surface.openChrome") {
        this.requestConnection(this.session(run.chatId), run);
        throw failure("browser_connection_required", "Select and connect Chrome from the browser control at the top of this Chat, then start a new task.");
      }
      const reply = await fallback(combined);
      if (combined.aborted) throw failure("browser_run_unavailable", "The task was stopped.");
      if (method === "Surface.observe") {
        const result = record(record(reply).result);
        if (record(reply).ok === true && text(result.observationId)) run.observations.set(surfaceId, text(result.observationId));
      }
      if (method === "Surface.list" || method === "Surface.getState") {
        const result = record(record(reply).result);
        if (Array.isArray(result.surfaces)) result.surfaces = result.surfaces.map(page => ({ ...record(page), provider: "workpanel" }));
        if (result.surface) result.surface = { ...record(result.surface), provider: "workpanel" };
        result.provider = "workpanel";
      }
      return reply;
    }
    const session = this.session(run.chatId);
    this.acquireWorkspace(session, run);
    await this.ensureChromeConnection(session, run, combined);
    if (combined.aborted) throw failure("browser_run_unavailable", "The task was stopped.");
    let result: unknown;
    try { result = await this.chromeCommand(session, run, method, params, surfaceId, combined); }
    catch (error) {
      if (!combined.aborted && ["browser_disconnected", "cancelled"].includes(text(record(error).code))) await this.disconnect(run.chatId);
      throw error;
    }
    if (combined.aborted) throw failure("browser_run_unavailable", "The task was stopped.");
    const resultNode = record(result);
    const observation = method === "Surface.observe" ? resultNode : record(resultNode.observation);
    const observedSurface = method === "Surface.openChrome" ? text(resultNode.surfaceId) : surfaceId;
    if (observedSurface && text(observation.observationId)) {
      run.observations.set(observedSurface, text(observation.observationId));
      this.rememberDownloads(run, observedSurface, observation.downloads);
    }
    return { ok: true, method, ...(surfaceId ? { surfaceId } : {}), result };
  }

  private rememberDownloads(run: Run, surfaceId: string, input: unknown) {
    const entries = Array.isArray(input) ? input : [];
    run.downloads.set(surfaceId, new Set(entries.map(item => text(record(item).downloadId)).filter(Boolean)));
  }

  private async chromeCommand(session: Session, run: Run, method: string, params: RecordValue, surfaceId: string, signal: AbortSignal) {
    const client = this.client(session);
    if (method === "Surface.list" || method === "Surface.getCurrent") {
      const surfaces = await this.refreshPages(session, signal, run);
      const current = surfaces.find(page => page.surfaceId === session.workspace.selectedSurfaceId) ?? null;
      return { surfaces, currentSurface: current, currentSurfaceId: current?.surfaceId ?? null,
        selectionRequired: surfaces.length > 1 && !current, provider: "chrome", capabilities: chromeCapabilities };
    }
    if (method === "Surface.openChrome") {
      const result = record(await this.runRequest(session, run, "open", { url: httpUrl(params.url) }, undefined, signal));
      const surfaces = await this.refreshPages(session, signal, run);
      const opened = [...session.workspace.pages.values()].find(page => page.pageId === text(result.pageId));
      if (!opened) throw failure("browser_protocol_error", "The opened Chrome page was not registered.");
      session.workspace.selectedSurfaceId = opened.surfaceId;
      this.changed(session);
      return { surfaceId: opened.surfaceId, provider: "chrome", surface: surfaces.find(page => page.surfaceId === opened.surfaceId),
        ...this.actionObservation(result, opened.surfaceId) };
    }
    await this.refreshPages(session, signal, run);
    const page = this.page(session, surfaceId);
    const commands: Record<string, string> = {
      "Surface.getState": "state", "Surface.observe": "observe", "Surface.click": "click",
      "Surface.interact": "interact", "Input.click": "click", "Page.navigate": "navigate",
      "Surface.goBack": "back", "Page.reload": "reload", "Page.bringToFront": "activate",
      "Surface.close": "close", "Page.captureScreenshot": "screenshot",
      "Surface.scroll": "interact", "Surface.handleDialog": "dialog", "Surface.uploadFiles": "upload",
      "Surface.getDownloads": "downloads", "Surface.readDownload": "downloads",
    };
    const command = commands[method];
    if (!command) throw failure("capability_unavailable", "This Chrome session supports page observation and typed page actions. Raw scripts and CDP methods are unavailable.");
    if (method === "Page.reload" && params.ignoreCache === true)
      throw failure("capability_unavailable", "Chrome supports ordinary reload. Use Chrome's own controls for a reload that bypasses its cache.");
    if (method === "Page.navigate") params = { ...params, url: httpUrl(params.url) };
    if (method === "Page.captureScreenshot") params = { ...params, fullPage: params.captureBeyondViewport === true };
    if (method === "Surface.scroll") params = { ...params, action: "scroll" };
    if (method === "Surface.getDownloads" || method === "Surface.readDownload") {
      params = { ...params, action: method === "Surface.getDownloads" ? "list" : "read" };
    }
    if (method === "Surface.getDownloads" || method === "Surface.readDownload") {
      if (!run.observations.has(surfaceId)) throw failure("stale_observation", "Observe this Chrome page in the current task before accessing browser downloads.");
      if (method === "Surface.readDownload" && !run.downloads.get(surfaceId)?.has(text(params.downloadId)))
        throw failure("stale_observation", "Read this page's current download list before saving that download.");
    }
    const result = await this.runRequest(session, run, command, params, page.pageId, signal);
    if (method === "Surface.getDownloads") this.rememberDownloads(run, surfaceId, record(result).downloads);
    if (session.workspace.client !== client || signal.aborted) throw failure("browser_disconnected", "Browser control has been released.");
    if (method === "Surface.close") {
      session.workspace.pages.delete(surfaceId);
      if (session.workspace.selectedSurfaceId === surfaceId) session.workspace.selectedSurfaceId = undefined;
      this.changed(session);
    } else {
      const latest = text(record(record(result).observation).url) ? record(record(result).observation) : record(result);
      if (text(latest.url)) {
        let url: string;
        try { url = httpUrl(latest.url); } catch {
          session.workspace.pages.delete(surfaceId);
          if (session.workspace.selectedSurfaceId === surfaceId) session.workspace.selectedSurfaceId = undefined;
          this.changed(session);
          throw failure("target_not_found", "The Chrome business page is no longer available.");
        }
        page.url = url.slice(0, 4096);
        if (typeof latest.title === "string") page.title = latest.title.slice(0, 500);
        if (typeof latest.active === "boolean") page.active = latest.active;
        if (typeof latest.isLoading === "boolean") page.isLoading = latest.isLoading;
      }
      session.workspace.selectedSurfaceId = surfaceId;
      this.changed(session);
    }
    if (method === "Surface.observe") return { ...record(result), surfaceId, provider: "chrome" };
    if (method === "Surface.getState") return { surface: { ...page, pageId: undefined }, capabilities: chromeCapabilities };
    const { pageId: _pageId, ...publicResult } = record(result);
    return { ...publicResult, ...this.actionObservation(publicResult, surfaceId) };
  }

  private actionObservation(result: RecordValue, surfaceId: string): RecordValue {
    const observation = record(result.observation);
    return {
      ...(text(observation.observationId) ? { observation: { ...observation, surfaceId, provider: "chrome" } } : {}),
      ...(result.observationError ? { observationError: {
        code: text(record(result.observationError).code) || "observation_unavailable",
        message: "The action result is preserved. Capture a fresh observation before continuing.",
      } } : {}),
    };
  }

  async action(request: RecordValue, signal: AbortSignal | undefined, fallback: (signal: AbortSignal) => Promise<unknown>) {
    const action = text(request.action);
    const args = record(request.args);
    if (!action.startsWith("desktop.web.") && action !== "desktop.workpanel.openWeb") return fallback(signal ?? new AbortController().signal);
    const run = this.lease(request.source);
    const combined = signal ? AbortSignal.any([signal, run.controller.signal]) : run.controller.signal;
    if (run.backend !== "chrome") {
      const result = await fallback(combined);
      if (combined.aborted) throw failure("browser_run_unavailable", "The task was stopped.");
      return result;
    }
    if (action === "desktop.workpanel.openWeb")
      throw failure("browser_backend_mismatch", "This task uses Chrome. Use surface_open to open a Chrome webpage.");
    if (action !== "desktop.web.interactElement") throw failure("capability_unavailable", "Use the typed surface tools for Chrome.");
    const response = await this.cdp({
      method: "Surface.interact", surfaceId: args.surfaceId, params: args, source: request.source,
    }, signal, async () => { throw failure("capability_unavailable", "Chrome action cannot switch execution environments."); });
    return { ok: true, action, result: record(response).result };
  }
  dispose() {
    for (const run of this.runs.values()) run.controller.abort();
    this.runs.clear();
    for (const workspace of this.workspaces.values()) { const client = workspace.client; workspace.client = undefined; workspace.generation++; workspace.connecting?.abort.abort(); client?.kill(); }
    this.sessions.clear(); this.workspaces.clear();
    this.settingsChanged();
  }
}
