import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import type { DesktopClickResult, DesktopClickWait } from "../../../shared/desktop-click";
import type { BrowserObservedDialog, BrowserObservedFileChooser } from "../../../shared/browser-use";
import type { ChromeWorkerController, ChromeWorkerModalState, ChromeWorkerObservation, ChromeWorkerPage, ChromeWorkerRequest, ChromeWorkerTab } from "./chrome-worker-contract";
import { chromeObserveOptions, projectChromeObservation, scanChromeSnapshot, viewportChromeSnapshot, type ChromeFieldMetadata } from "./chrome-observation";
import { ChromeTransferStore, decodeBrowserUploadFiles } from "./chrome-file-transfer";
import { ChromeAwcp, type ChromeAwcpRunLease } from "./chrome-awcp";
import { awcpHostError, isAwcpHostError } from "../awcp";

type ControllerOptions = {
  outputDir: string; clientName: string; profileDirName?: string; extensionToken?: string; signal: AbortSignal;
  onTab?(tab: ChromeWorkerTab): void;
  onDownload?(tab: ChromeWorkerTab, download: import("playwright-core").Download): void;
};
export type ChromeControllerFactory = (options: ControllerOptions) => Promise<ChromeWorkerController>;

export const chromeObservationFailureMessages = {
  observation_snapshot_failed: "Chrome could not capture the page's semantic snapshot.",
  observation_state_failed: "Chrome could not read the selected page's state.",
  observation_viewport_failed: "Chrome could not read the selected page's viewport.",
  observation_projection_failed: "Chrome could not prepare the bounded page observation.",
} as const;

function observationFailureCode(error: unknown): keyof typeof chromeObservationFailureMessages | undefined {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && Object.hasOwn(chromeObservationFailureMessages, code)
    ? code as keyof typeof chromeObservationFailureMessages : undefined;
}

export function chromeWorkerError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function defaultFactory(options: ControllerOptions): Promise<ChromeWorkerController> {
  const runtimeRequire = createRequire(__filename);
  const packaged = path.join(__dirname, "browser-use-runtime", "playwright-core", "lib", "coreBundle.js");
  const coreBundle = fs.existsSync(packaged) ? packaged : path.join(path.dirname(runtimeRequire.resolve("playwright-core/package.json")), "lib", "coreBundle.js");
  const api = runtimeRequire(coreBundle).__desktopBrowserUse as { patchVersion?: number; create?: ChromeControllerFactory } | undefined;
  if (api?.patchVersion !== 1 || !api.create) throw chromeWorkerError("browser_runtime_unavailable", "The reviewed Chrome runtime patch is missing. Rebuild Desktop before connecting.");
  return api.create(options);
}

export function browserUseUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192) throw chromeWorkerError("invalid_params", "A browser URL is required");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw chromeWorkerError("invalid_params", "The browser URL is invalid"); }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    throw chromeWorkerError("url_not_allowed", "Only HTTP and HTTPS pages can be controlled");
  }
  return parsed.href;
}

function textParam(value: unknown, name: string, max = 100_000): string {
  if (typeof value !== "string" || value.length > max) throw chromeWorkerError("invalid_params", `${name} must be a string of at most ${max} characters`);
  return value;
}

/** One Main-owned workspace owns this connection; its queue never follows the UI's active Chrome tab. */
// Read-only page requests stay available while a timed-out input settles.
const unsettledInputBlocked = new Set(["click", "interact", "dialog", "upload", "navigate", "back", "reload", "close"]);

export class ChromeWorkerEngine {
  private controller?: ChromeWorkerController;
  private readonly abort = new AbortController();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly requests = new Map<string, { cancelled: boolean; running: boolean }>();
  private closed = false;
  private transferEpoch = 0;
  private outputDir?: string;
  private disconnecting?: Promise<void>;
  private observations = new Map<string, { id: string; refs: Set<string>; dialogs: Map<string, ChromeWorkerModalState>; choosers: Map<string, ChromeWorkerModalState> }>();
  private readonly observationEpoch = new Map<string, number>();
  private readonly modalIds = new WeakMap<object, string>();
  private readonly knownSecrets = new Map<string, Set<string>>();
  private readonly transfers = new ChromeTransferStore();
  private readonly awcp = new ChromeAwcp(this.abort.signal);
  private watched = new WeakSet<object>();
  /** A timed-out pointer input whose effects are unknown; only this page waits for it, never the connection. */
  private readonly unsettledInput = new Map<string, Promise<void>>();

  constructor(private readonly factory: ChromeControllerFactory = defaultFactory) {}

  request(request: ChromeWorkerRequest): Promise<unknown> {
    if (request.method === "cancel" || request.method === "disconnect") return this.disconnect();
    if (request.method === "release-transfers") {
      if (Object.keys(request.params ?? {}).length || request.pageId)
        return Promise.reject(chromeWorkerError("invalid_params", "Transfer release takes no page or parameters."));
      this.transferEpoch++;
      // Revoke immediately, even while a click is running; reply only after the original response drains.
      return this.transfers.endRun().then(() => ({ released: true }));
    }
    if (request.method === "cancel-request") {
      const params = request.params;
      if (!params || Object.keys(params).join(",") !== "requestId" || typeof params.requestId !== "string" || !params.requestId || params.requestId.length > 128)
        return Promise.reject(chromeWorkerError("invalid_params", "A private pending request identity is required."));
      const entry = this.requests.get(params.requestId);
      if (entry && !entry.running) entry.cancelled = true;
      return Promise.resolve({ cancelled: !!entry && !entry.running, running: entry?.running === true });
    }
    if (request.method === "awcp-release-run") return this.awcp.releaseRun(request.params);
    if (request.method === "awcp-refresh") return this.awcp.refresh(request.params);
    if (this.requests.has(request.id)) return Promise.reject(chromeWorkerError("invalid_params", "The private request identity is already pending."));
    let awcpRun: ChromeAwcpRunLease | undefined;
    try {
      if (request.method === "awcp-manual" || request.method === "awcp-invoke") awcpRun = this.awcp.retainRun(request.params);
    } catch (error) { return Promise.reject(error); }
    const entry = { cancelled: false, running: false }; this.requests.set(request.id, entry);
    const awcpGeneration = this.awcp.generation();
    const transferEpoch = this.transferEpoch;
    const result = this.queue.then(() => {
      if (entry.cancelled) throw chromeWorkerError("cancelled", "The browser request was cancelled before execution.");
      entry.running = true; return this.dispatch(request, awcpGeneration, awcpRun, transferEpoch);
    }).finally(() => {
      if (this.requests.get(request.id) === entry) this.requests.delete(request.id);
      if (awcpRun) this.awcp.releaseRequest(awcpRun);
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  async disconnect(): Promise<{ connected: false; pages: [] }> {
    if (!this.disconnecting) {
      this.closed = true;
      for (const entry of this.requests.values()) if (!entry.running) entry.cancelled = true;
      this.abort.abort();
      this.observations.clear();
      this.observationEpoch.clear();
      this.knownSecrets.clear();
      const controller = this.controller;
      this.controller = undefined;
      this.disconnecting = (async () => {
        try { try { await this.awcp.dispose(); await this.transfers.shutdown(); } finally { await controller?.disconnect(); } }
        finally { this.transfers.dispose(); if (this.outputDir) fs.rmSync(this.outputDir, { recursive: true, force: true }); }
      })();
    }
    await this.disconnecting;
    return { connected: false, pages: [] };
  }

  private ensureConnected(): ChromeWorkerController {
    if (this.closed || this.abort.signal.aborted) throw chromeWorkerError("cancelled", "This Chrome connection has been released");
    if (!this.controller) throw chromeWorkerError("browser_disconnected", "Connect Chrome before using its pages");
    return this.controller;
  }

  private async dispatch(request: ChromeWorkerRequest, awcpGeneration: number, awcpRun: ChromeAwcpRunLease | undefined, transferEpoch: number): Promise<unknown> {
    const params = request.params ?? {};
    if (request.method === "state" && !request.pageId) return this.state();
    if (request.method === "list" && this.closed) throw chromeWorkerError("browser_disconnected", "The Chrome connection has been released");
    if (this.closed) throw chromeWorkerError("cancelled", "This Chrome connection has been released");
    if (request.method === "connect") {
      if (Object.keys(params).some(key => !["profileDirName", "channel", "clientName", "extensionToken"].includes(key)) || (params.channel !== undefined && params.channel !== "chrome")) {
        throw chromeWorkerError("invalid_params", "Custom browser endpoints and launch options are unavailable");
      }
      if (params.extensionToken !== undefined && (typeof params.extensionToken !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(params.extensionToken)))
        throw chromeWorkerError("invalid_params", "The saved Chrome authorization is invalid");
      if (!this.controller) {
        const profile = params.profileDirName;
        if (profile !== undefined && (typeof profile !== "string" || !/^[\w .-]{1,100}$/.test(profile) || profile === "." || profile === "..")) {
          throw chromeWorkerError("invalid_params", "The Chrome profile directory name is invalid");
        }
        this.outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-browser-use-"));
        let controller: ChromeWorkerController;
        const clientName = typeof params.clientName === "string" && params.clientName.trim() && params.clientName.length <= 80 ? params.clientName.trim() : "Desktop";
        try { controller = await this.factory({ outputDir: this.outputDir, clientName, profileDirName: profile as string | undefined,
          ...(typeof params.extensionToken === "string" ? { extensionToken: params.extensionToken } : {}), signal: this.abort.signal,
          onTab: tab => this.watch(tab), onDownload: (tab, download) => { this.watch(tab); void this.transfers.captureDownload(tab, download); } }); }
        catch (error) {
          fs.rmSync(this.outputDir, { recursive: true, force: true });
          this.outputDir = undefined;
          if (params.extensionToken) {
            if (this.abort.signal.aborted) throw chromeWorkerError("cancelled", "Chrome connection was cancelled");
            throw chromeWorkerError("chrome_connection_failed", "Chrome could not establish the saved connection. Check browser settings and connect again");
          }
          throw error;
        }
        if (this.closed) {
          await controller.disconnect();
          throw chromeWorkerError("cancelled", "Chrome connection was cancelled");
        }
        this.controller = controller;
        controller.browserContext.once("close", () => void this.disconnect());
      }
      return this.state();
    }
    const controller = this.ensureConnected();
    if (request.method === "awcp-manual" || request.method === "awcp-invoke") {
      if (typeof request.pageId !== "string" || !request.pageId)
        throw awcpHostError("awcp_invalid_request", "A stable Chrome page identity is required for AWCP.");
      try {
        return await controller.run<unknown>(request.pageId, tab => {
          this.watch(tab);
          if (request.method === "awcp-invoke") this.invalidate(tab.desktopPageId);
          return request.method === "awcp-manual" ? this.awcp.manual(tab, params, awcpRun!, awcpGeneration) : this.awcp.invoke(tab, params, awcpRun!, awcpGeneration);
        });
      } catch (error) {
        if (isAwcpHostError(error)) throw error;
        if (this.closed || this.abort.signal.aborted) throw awcpHostError("awcp_cancelled", "The Chrome AWCP connection was released.");
        const code = (error as { code?: string }).code;
        if (code === "surface_not_found" || code === "browser_disconnected")
          throw awcpHostError("awcp_target_unavailable", "The authorized Chrome page is unavailable.");
        throw awcpHostError("awcp_transport_failed", "The authorized Chrome AWCP operation failed.");
      }
    }
    if (request.method === "list") return controller.list();
    if (request.method === "open") {
      const opened = await controller.open(browserUseUrl(params.url));
      const result = { ...opened, status: "done", action: { outcome: "complete" } };
      try { return await controller.run(opened.pageId, tab => this.withObservation(controller, tab, result)); }
      catch {
        if (this.abort.signal.aborted || this.closed) throw chromeWorkerError("cancelled", "Browser control has been released");
        return { ...result, observationError: { code: "observation_unavailable", message: "The page was opened. Observe the current page list before continuing; do not open it again automatically." } };
      }
    }
    const pageId = request.pageId;
    if (typeof pageId !== "string" || !pageId) throw chromeWorkerError("invalid_params", "A stable Chrome page ID is required");
    if (this.unsettledInput.has(pageId) && unsettledInputBlocked.has(request.method))
      throw chromeWorkerError("input_unsettled", "An earlier pointer input on this page has not settled. Observe the page before another action; do not repeat that input.");
    if (request.method === "observe") return this.observe(controller, pageId, params);
    if (request.method === "click") return this.click(controller, pageId, params, transferEpoch);
    if (request.method === "interact") return this.interact(controller, pageId, params);
    if (request.method === "dialog") return this.handleDialog(controller, pageId, params);
    if (request.method === "upload") return this.upload(controller, pageId, params);
    if (request.method === "downloads") {
      if (Object.keys(params).some(key => !["action", "downloadId", "sha256"].includes(key)) || !["list", "read", "release"].includes(String(params.action)))
        throw chromeWorkerError("invalid_params", "Choose list, read or release for downloads.");
      return controller.run(pageId, async tab => {
        this.watch(tab);
        if (params.action === "list") {
          if (params.downloadId !== undefined || params.sha256 !== undefined) throw chromeWorkerError("invalid_params", "Download identities are not valid for list.");
          return { downloads: this.transfers.list(pageId) };
        }
        if (params.action === "release") {
          if (typeof params.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(params.sha256)) throw chromeWorkerError("invalid_params", "A saved download SHA-256 is required.");
          return this.transfers.releaseDownload(pageId, textParam(params.downloadId, "downloadId", 128), params.sha256);
        }
        if (params.sha256 !== undefined) throw chromeWorkerError("invalid_params", "A download SHA-256 is only valid for release.");
        return this.transfers.read(pageId, textParam(params.downloadId, "downloadId", 128));
      });
    }
    return controller.run(pageId, async tab => {
      this.watch(tab);
      if (request.method === "state") return this.describe(controller, tab);
      if (request.method === "screenshot") {
        const pending = this.pendingModal(tab); if (pending) throw pending;
        const buffer = await tab.page.screenshot({ type: "png", scale: "css", fullPage: params.fullPage === true || params.captureBeyondViewport === true, timeout: 10000 });
        return { data: buffer.toString("base64"), mimeType: "image/png" };
      }
      if (request.method === "activate") { await tab.page.bringToFront(); return this.describe(controller, tab); }
      if (request.method === "close") {
        const pending = this.pendingModal(tab); if (pending) throw pending;
        this.invalidate(pageId);
        await tab.page.close();
        return { closed: true, pageId };
      }
      if (!["navigate", "back", "reload"].includes(request.method)) throw chromeWorkerError("capability_unavailable", "This browser operation is unavailable");
      const url = request.method === "navigate" ? browserUseUrl(params.url) : undefined;
      this.invalidate(pageId);
      const result = await this.modalAction(tab, signal => request.method === "navigate"
        ? tab.page.goto(url!, { waitUntil: "domcontentloaded", timeout: 30000, signal })
        : request.method === "back" ? tab.page.goBack({ waitUntil: "domcontentloaded", timeout: 30000, signal })
          : tab.page.reload({ waitUntil: "domcontentloaded", timeout: 30000, signal }), 30000);
      const state = await this.describe(controller, tab);
      return this.withObservation(controller, tab, { ...state, ...result });
    });
  }

  private async state() {
    return { connected: !!this.controller && !this.closed, pages: this.controller && !this.closed ? await this.controller.list() : [] };
  }

  private watch(tab: ChromeWorkerTab): void {
    if (this.closed) return;
    this.awcp.watch(tab);
    this.transfers.watch(tab);
    if (this.watched.has(tab.page)) return;
    this.watched.add(tab.page);
    const invalidate = () => this.invalidate(tab.desktopPageId);
    tab.page.on("framenavigated", frame => { invalidate(); if (frame === tab.page.mainFrame()) this.knownSecrets.delete(tab.desktopPageId); });
    tab.page.on("close", () => { invalidate(); this.knownSecrets.delete(tab.desktopPageId); });
    tab.page.on("crash", () => { invalidate(); this.knownSecrets.delete(tab.desktopPageId); });
    tab.page.on("dialog", invalidate); tab.page.on("dialogclosed", invalidate); tab.page.on("filechooser", invalidate);
  }

  private holdUnsettledInput(pageId: string, input: Promise<void>) {
    const settled = input.then(() => undefined, () => undefined);
    this.unsettledInput.set(pageId, settled);
    void settled.then(() => { if (this.unsettledInput.get(pageId) === settled) this.unsettledInput.delete(pageId); });
  }

  private invalidate(pageId: string): number {
    this.observations.delete(pageId);
    const epoch = (this.observationEpoch.get(pageId) ?? 0) + 1;
    this.observationEpoch.set(pageId, epoch);
    return epoch;
  }

  private async describe(controller: ChromeWorkerController, tab: ChromeWorkerTab): Promise<ChromeWorkerPage> {
    if (controller.describe) return controller.describe(tab);
    if (tab.page.isClosed()) throw chromeWorkerError("surface_not_found", "The selected Chrome page was closed");
    const visibility = await tab.page.evaluate(() => ({ active: document.visibilityState === "visible", isLoading: document.readyState !== "complete" }));
    if (tab.page.isClosed()) throw chromeWorkerError("surface_not_found", "The selected Chrome page was closed");
    return { pageId: tab.desktopPageId, url: tab.page.url(), title: await tab.page.title(), ...visibility };
  }

  private modalState(tab: ChromeWorkerTab) {
    const dialogs: BrowserObservedDialog[] = [], fileChoosers: BrowserObservedFileChooser[] = [];
    const dialogRefs = new Map<string, ChromeWorkerModalState>(), chooserRefs = new Map<string, ChromeWorkerModalState>();
    for (const state of (tab.modalStates?.() ?? []).slice(0, 16)) {
      const object = state.type === "dialog" ? state.dialog : state.type === "fileChooser" ? state.fileChooser : undefined;
      if (!object) continue;
      let id = this.modalIds.get(object);
      if (!id) { id = randomUUID(); this.modalIds.set(object, id); }
      if (state.type === "dialog" && state.dialog) {
        const type = state.dialog.type();
        if (!["alert", "confirm", "prompt", "beforeunload"].includes(type)) continue;
        dialogs.push({ dialogId: id, type: type as BrowserObservedDialog["type"], message: state.dialog.message() });
        dialogRefs.set(id, state);
      } else if (state.fileChooser) {
        fileChoosers.push({ chooserId: id, multiple: state.fileChooser.isMultiple() }); chooserRefs.set(id, state);
      }
    }
    return { dialogs, fileChoosers, dialogRefs, chooserRefs };
  }

  private pendingModal(tab: ChromeWorkerTab): Error & { code: string } | undefined {
    const states = tab.modalStates?.() ?? [];
    if (states.some(state => state.type === "dialog")) return chromeWorkerError("dialog_pending", "Observe and handle the pending dialog before another page action.");
    if (states.some(state => state.type === "fileChooser")) return chromeWorkerError("file_chooser_pending", "Observe and complete the pending file chooser before another page action.");
  }

  private async observe(controller: ChromeWorkerController, pageId: string, params: Record<string, unknown>): Promise<ChromeWorkerObservation> {
    chromeObserveOptions(params);
    return controller.run(pageId, tab => this.captureTimed(controller, tab, params, 20000));
  }

  private async captureTimed(controller: ChromeWorkerController, tab: ChromeWorkerTab, params: Record<string, unknown>, timeoutMs: number): Promise<ChromeWorkerObservation> {
    this.watch(tab);
    const epoch = this.invalidate(tab.desktopPageId);
    const timeout = new AbortController();
    const signal = AbortSignal.any([this.abort.signal, timeout.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = this.captureObservation(controller, tab, params, epoch, signal).catch(error => {
      if (!signal.aborted && !this.closed && this.pendingModal(tab))
        return this.captureObservation(controller, tab, params, this.invalidate(tab.desktopPageId), signal);
      throw error;
    });
    // A timed-out read cannot publish a late observation or overwrite a later reference map.
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { timeout.abort(); reject(chromeWorkerError("observation_timeout", "The page observation was not ready in time.")); }, timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }

  private async captureObservation(controller: ChromeWorkerController, tab: ChromeWorkerTab, params: Record<string, unknown>, epoch: number, signal: AbortSignal): Promise<ChromeWorkerObservation> {
    const options = chromeObserveOptions(params);
    const live = () => {
      if (this.abort.signal.aborted || this.closed) throw chromeWorkerError("cancelled", "Browser control has been released");
      if (signal.aborted || this.observationEpoch.get(tab.desktopPageId) !== epoch) throw chromeWorkerError("stale_observation", "The page changed while it was being observed.");
    };
    live();
    let modals = this.modalState(tab);
    let snapshot: unknown = [];
    if (!modals.dialogs.length && !modals.fileChoosers.length) {
      const captured = await this.observationStage("observation_snapshot_failed", () => tab.captureSnapshot(undefined, options.depth, options.viewportOnly, undefined, "json", false));
      live(); modals = this.modalState(tab);
      if (!modals.dialogs.length && !modals.fileChoosers.length) {
        if (!Array.isArray(captured.ariaSnapshotJSON)) throw chromeWorkerError("observation_unavailable", "The page did not provide an observation.");
        snapshot = captured.ariaSnapshotJSON;
      }
    }
    const state = await this.observationStage("observation_state_failed", () => this.describe(controller, tab)); live();
    let viewportTruncated = false;
    if (options.viewportOnly && !modals.dialogs.length && !modals.fileChoosers.length) {
      const viewport = await this.observationStage("observation_viewport_failed", () => this.readViewport(tab, signal));
      live();
      const projected = await this.observationStage("observation_projection_failed", () => viewportChromeSnapshot(snapshot, viewport.width, viewport.height));
      snapshot = projected.nodes; viewportTruncated = projected.truncated;
    }
    const scan = await this.observationStage("observation_projection_failed", () => scanChromeSnapshot(snapshot)); scan.truncated ||= viewportTruncated;
    const fields = new Map<string, ChromeFieldMetadata>();
    const editable = scan.entries.flatMap(entry => typeof entry.node !== "string" && typeof entry.node.ref === "string"
      && ["textbox", "searchbox", "combobox", "listbox", "spinbutton", "checkbox", "radio", "button"].includes(entry.node.role ?? "") ? [entry.node.ref] : []);
    for (const ref of editable) fields.set(ref, { sensitive: true, truncated: true });
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(16, editable.length) }, async () => {
      while (index < Math.min(256, editable.length)) {
        const ref = editable[index++]; live();
        try {
          const { locator } = await tab.targetLocator({ target: ref });
          live();
          const field = await locator.evaluate(element => {
            const native = element as HTMLInputElement;
            const autocomplete = (element.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/u);
            const type = element.getAttribute("type")?.toLowerCase();
            const sensitive = type === "password" || type === "file" || autocomplete.some(token => ["current-password", "new-password", "one-time-code", "cc-number", "cc-csc"].includes(token));
            const raw = "value" in element ? String(native.value) : "";
            const metadata: ChromeFieldMetadata = { sensitive, tag: element.tagName.toLowerCase() };
            if (sensitive) {
              if (type === "file") { metadata.fileCount = native.files?.length ?? 0; metadata.multiple = native.multiple; }
              if (raw.length > 8192) metadata.oversizedSecret = true;
              else metadata.secretValue = raw;
              return metadata;
            }
            if (raw.length <= 4096) metadata.value = raw; else metadata.truncated = true;
            metadata.disabled = element.matches(':disabled, [aria-disabled="true"]');
            metadata.required = native.required === true || element.getAttribute("aria-required") === "true";
            metadata.readOnly = native.readOnly === true || element.getAttribute("aria-readonly") === "true";
            if (typeof native.validationMessage === "string" && native.validationMessage.length <= 4096) metadata.validationMessage = native.validationMessage;
            if (element.tagName === "SELECT") {
              const select = element as HTMLSelectElement;
              const choices = [];
              let characters = 24000, truncated = select.options.length > 100;
              for (let i = 0; i < Math.min(select.options.length, 100); i++) {
                const option = select.options[i], label = option.label, value = option.value;
                if (option.closest('[hidden], [aria-hidden="true"]') || option.ownerDocument.defaultView!.getComputedStyle(option).display === "none") continue;
                if (value.length > 1000 || label.length + value.length > characters) { truncated = true; continue; }
                choices.push({ label, value, selected: option.selected, disabled: metadata.disabled === true || option.disabled || !!option.closest("optgroup[disabled]") });
                characters -= label.length + value.length;
              }
              metadata.select = { options: choices, multiple: select.multiple, optionsTruncated: truncated };
            }
            return metadata;
          }, undefined, { timeout: 750, signal });
          live(); fields.set(ref, field);
        } catch { live(); /* Unknown editable values remain masked. */ }
      }
    }));
    live();
    const observationId = randomUUID();
    const projected = await this.observationStage("observation_projection_failed", () => projectChromeObservation({ scan, fields, state, options, observationId,
      dialogs: modals.dialogs, fileChoosers: modals.fileChoosers, downloads: this.transfers.list(tab.desktopPageId), redactions: this.knownSecrets.get(tab.desktopPageId) }));
    live();
    this.observations.set(tab.desktopPageId, { id: observationId, refs: projected.refs, dialogs: modals.dialogRefs, choosers: modals.chooserRefs });
    this.knownSecrets.set(tab.desktopPageId, projected.secrets);
    return projected.observation;
  }

  private async readViewport(tab: ChromeWorkerTab, signal: AbortSignal): Promise<{ width: number; height: number }> {
    if (signal.aborted) throw chromeWorkerError("stale_observation", "The page observation was released.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(chromeWorkerError("stale_observation", "The page observation was released."));
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => reject(new Error("Viewport read deadline exceeded")), 750);
    });
    try {
      // A CSS html locator pierces open shadow roots and can match injected extension panels.
      // Read the exact main Frame's viewport without resolving any page-controlled element target.
      return await Promise.race([tab.page.mainFrame().evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })), stopped]);
    } finally { clearTimeout(timer); signal.removeEventListener("abort", onAbort); }
  }

  private async observationStage<T>(code: keyof typeof chromeObservationFailureMessages, read: () => T | Promise<T>): Promise<T> {
    try { return await read(); }
    catch (error) {
      const known = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
      if (typeof known === "string" && ["cancelled", "stale_observation", "surface_not_found", "browser_disconnected", "observation_timeout", "observation_budget_exceeded", "dialog_pending", "file_chooser_pending"].includes(known)) throw error;
      // Page/extension errors may contain URLs or credentials. Expose the fixed phase only.
      throw chromeWorkerError(code, chromeObservationFailureMessages[code]);
    }
  }

  private async withObservation<T extends object>(controller: ChromeWorkerController, tab: ChromeWorkerTab, result: T, options: Record<string, unknown> = {}) {
    try {
      if (!this.pendingModal(tab)) await delay(100, undefined, { signal: this.abort.signal });
      return { ...result, observation: await this.captureTimed(controller, tab, options, 10000) };
    }
    catch (error) {
      if (this.abort.signal.aborted || this.closed) throw chromeWorkerError("cancelled", "Browser control has been released");
      return { ...result, observationError: { code: observationFailureCode(error) ?? "observation_unavailable", message: "The action result is preserved. Capture a fresh observation before the next action; do not repeat the completed action." } };
    }
  }

  /** A modal interrupts the action with unknown effects; preserve that result without retrying. */
  private async modalAction(tab: ChromeWorkerTab, action: (signal: AbortSignal) => Promise<unknown>, timeoutMs: number, allowChooser = false) {
    try {
      await this.modalAware(tab, action, timeoutMs, allowChooser);
      return { status: "done", action: { outcome: "complete" } };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "dialog_pending" && code !== "file_chooser_pending") throw error;
      return { status: "failed", error: code, action: { outcome: "unknown" } };
    }
  }

  /** The original Playwright call keeps its deadline and is explicitly aborted on a native modal. */
  private async modalAware<T>(tab: ChromeWorkerTab, action: (signal: AbortSignal) => Promise<T>, timeoutMs: number, allowChooser = false): Promise<T> {
    const pending = this.pendingModal(tab);
    if (pending && !(allowChooser && pending.code === "file_chooser_pending")) throw pending;
    const local = new AbortController();
    const signal = AbortSignal.any([this.abort.signal, local.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onModal: () => void = () => undefined, onAbort: () => void = () => undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      onModal = () => { const error = this.pendingModal(tab) ?? chromeWorkerError("dialog_pending", "Observe the pending dialog."); local.abort(); reject(error); };
      onAbort = () => { local.abort(); reject(chromeWorkerError("cancelled", "Browser control has been released")); };
      tab.page.on("dialog", onModal); tab.page.on("filechooser", onModal);
      this.abort.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => { local.abort(); reject(chromeWorkerError("browser_action_timeout", "The page action timed out.")); }, timeoutMs);
    });
    const work = Promise.resolve().then(() => { if (signal.aborted) throw chromeWorkerError("cancelled", "Browser control has been released"); return action(signal); });
    // Promise.race attaches a rejection handler even after a modal wins, so no late rejection escapes.
    try { return await Promise.race([work, interrupted]); }
    catch (error) {
      if (this.abort.signal.aborted) throw chromeWorkerError("cancelled", "Browser control has been released");
      const modal = this.pendingModal(tab);
      if (modal && !(allowChooser && modal.code === "file_chooser_pending")) throw modal;
      throw error;
    }
    finally {
      clearTimeout(timer); tab.page.off("dialog", onModal); tab.page.off("filechooser", onModal);
      this.abort.signal.removeEventListener("abort", onAbort);
    }
  }

  private async nativeOnce(action: () => Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined, onAbort: () => void = () => undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(chromeWorkerError("cancelled", "Browser control has been released"));
      this.abort.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => reject(chromeWorkerError("browser_action_timeout", "The native browser interaction timed out. Observe its current state before continuing.")), 10000);
    });
    const work = Promise.resolve().then(() => {
      if (this.abort.signal.aborted) throw chromeWorkerError("cancelled", "Browser control has been released");
      return action();
    });
    try { await Promise.race([work, interrupted]); }
    finally { clearTimeout(timer); this.abort.signal.removeEventListener("abort", onAbort); }
  }

  private target(pageId: string, params: Record<string, unknown>): string {
    if (typeof params.selector === "string") return `css=${textParam(params.selector, "selector", 4096)}`;
    const ref = params.ref;
    const observation = this.observations.get(pageId);
    if (typeof ref !== "string" || !observation || params.observationId !== observation.id || !observation.refs.has(ref)) {
      throw chromeWorkerError("stale_observation", "Capture a fresh observation of this page before using its element reference");
    }
    return ref;
  }

  private async click(controller: ChromeWorkerController, pageId: string, params: Record<string, unknown>, transferEpoch: number) {
    if (params.captureDownload !== undefined && typeof params.captureDownload !== "boolean") throw chromeWorkerError("invalid_params", "captureDownload must be a boolean.");
    const timeoutMs = params.timeoutMs === undefined ? 3000 : params.timeoutMs;
    if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) throw chromeWorkerError("invalid_params", "timeoutMs must be an integer from 100 to 10000");
    const coordinateInput = params.x !== undefined || params.y !== undefined;
    if (coordinateInput && (params.selector !== undefined || params.ref !== undefined || ![params.x, params.y].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0))) {
      throw chromeWorkerError("invalid_params", "Use one element target or finite non-negative x/y coordinates");
    }
    let wait: DesktopClickWait | undefined;
    if (params.waitFor !== undefined) {
      if (!params.waitFor || typeof params.waitFor !== "object" || Array.isArray(params.waitFor)) throw chromeWorkerError("invalid_params", "waitFor must be an object");
      const value = params.waitFor as Record<string, unknown>;
      if (Object.keys(value).some(key => !["selector", "state", "value", "checked"].includes(key)) || !["visible", "hidden", "value", "checked", "url"].includes(String(value.state))) throw chromeWorkerError("invalid_params", "Invalid click wait condition");
      if (value.state === "url" ? typeof value.value !== "string" || !value.value || value.selector !== undefined : typeof value.selector !== "string" || !value.selector.trim() || value.selector.length > 4096) throw chromeWorkerError("invalid_params", "A selector is required for element conditions; URL conditions require a value");
      if (value.state === "value" && typeof value.value !== "string") throw chromeWorkerError("invalid_params", "A value condition requires a string value");
      if (value.state === "checked" ? typeof value.checked !== "boolean" : value.checked !== undefined) throw chromeWorkerError("invalid_params", "checked is exclusive to checked conditions and must be boolean");
      if (value.state !== "url" && value.state !== "value" && value.value !== undefined) throw chromeWorkerError("invalid_params", "value is exclusive to value and URL conditions");
      wait = value as DesktopClickWait;
    }
    return controller.run(pageId, async tab => {
      this.watch(tab);
      const started = Date.now(), deadline = started + timeoutMs;
      const result: DesktopClickResult = {
        status: "failed", stage: "locate", action: { pressed: false, released: false, outcome: "not_started" },
        conditionMatched: wait ? false : null, timingsMs: { locate: 0, click: 0, wait: 0, total: 0 }
      };
      const remaining = () => {
        if (this.abort.signal.aborted) throw chromeWorkerError("cancelled", "Browser control has been released");
        if (tab.page.isClosed()) throw chromeWorkerError("surface_not_found", "The selected Chrome page was closed");
        const pending = this.pendingModal(tab); if (pending) throw pending;
        if (Date.now() >= deadline) throw chromeWorkerError("browser_action_timeout", "timeout");
        return Math.max(1, deadline - Date.now());
      };
      const perform = async () => {
      let clickStarted = 0, waitStarted = 0;
      try {
        let locator: import("playwright-core").Locator | undefined, waitLocator: import("playwright-core").Locator | undefined;
        await this.modalAware(tab, async signal => {
          locator = coordinateInput ? undefined : params.selector !== undefined
            ? tab.page.locator(this.target(pageId, params)) : (await tab.targetLocator({ target: this.target(pageId, params) })).locator;
          if (signal.aborted) throw chromeWorkerError("cancelled", "Browser control has been released");
          if (wait?.selector) {
            if (locator) {
              const element = await locator.elementHandle({ timeout: remaining() });
              if (!element) throw chromeWorkerError("surface_not_found", "The observed target is no longer available.");
              try {
                const frame = await element.ownerFrame();
                if (!frame || frame.isDetached()) throw chromeWorkerError("surface_not_found", "The target frame is no longer available.");
                waitLocator = frame.locator(`css=${wait.selector}`);
              } finally { await element.dispose(); }
            } else waitLocator = tab.page.mainFrame().locator(`css=${wait.selector}`);
          }
        }, remaining());
        if (waitLocator) await this.modalAware(tab, () => waitLocator!.count(), remaining()); // Validate syntax before dispatch.
        if (locator) await this.modalAware(tab, signal => locator!.click({ trial: true, timeout: remaining(), signal }), remaining());
        if (params.ref !== undefined) this.observed(pageId, params.observationId);
        result.timingsMs.locate = Date.now() - started;
        remaining();
        if (params.captureDownload === true) {
          if (transferEpoch !== this.transferEpoch) throw chromeWorkerError("cancelled", "The download action authorization ended.");
          await this.transfers.prepare(tab);
          if (transferEpoch !== this.transferEpoch) throw chromeWorkerError("cancelled", "The download action authorization ended.");
          remaining();
        }
        result.stage = "click";
        clickStarted = Date.now();
        this.invalidate(pageId);
        result.action.outcome = "unknown";
        if (locator) await this.modalAware(tab, signal => locator!.click({ timeout: remaining(), noWaitAfter: true, signal }), remaining());
        else {
          let timer: ReturnType<typeof setTimeout> | undefined, press: Promise<void> | undefined;
          try {
            await Promise.race([
              this.modalAware(tab, () => (press = tab.page.mouse.click(params.x as number, params.y as number)), remaining()),
              new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(chromeWorkerError("browser_action_timeout", "timeout")), remaining()); })
            ]);
          } catch (error) {
            // The input effects are unknown. Hold this page's mutations until it settles; other pages and
            // the shared connection stay usable, and the press is never repeated.
            if ((error as { code?: string }).code === "browser_action_timeout" && press) this.holdUnsettledInput(pageId, press);
            throw error;
          } finally { clearTimeout(timer); }
        }
        result.action = { pressed: true, released: true, outcome: "complete" };
        result.timingsMs.click = Date.now() - clickStarted;
        result.stage = "observe";
        if (!wait) { remaining(); result.status = "clicked"; return result; }
        waitStarted = Date.now();
        for (;;) {
          remaining();
          const matched = await this.modalAware(tab, async () => wait.state === "url" ? tab.page.url() === wait.value
            : wait.state === "visible" ? await waitLocator!.isVisible()
            : wait.state === "hidden" ? await waitLocator!.isHidden()
            : wait.state === "checked" ? (await waitLocator!.isChecked({ timeout: remaining() })) === wait.checked
            : (await waitLocator!.inputValue({ timeout: remaining() })) === wait.value, remaining());
          if (matched) { result.conditionMatched = true; result.status = "condition_met"; return result; }
          await delay(Math.min(25, remaining()), undefined, { signal: this.abort.signal });
        }
      } catch (error) {
        if (params.captureDownload === true && result.action.outcome === "not_started") await this.transfers.cancelCapture(pageId);
        if (this.abort.signal.aborted) throw chromeWorkerError("cancelled", "Browser control has been released");
        if (params.captureDownload === true && transferEpoch !== this.transferEpoch) throw chromeWorkerError("cancelled", "The download action authorization ended.");
        if (tab.page.isClosed()) {
          if (result.action.outcome === "not_started") throw chromeWorkerError("surface_not_found", "The selected Chrome page was closed");
          result.status = "failed"; result.error = "page_closed"; return result;
        }
        const cause = error as Error & { code?: string };
        if (cause.code === "stale_observation") throw error;
        result.status = cause.code === "browser_action_timeout" || cause.name === "TimeoutError" ? "timeout" : "failed";
        result.error = result.status === "timeout" ? "timeout" : ["dialog_pending", "file_chooser_pending"].includes(cause.code ?? "") ? cause.code : "click_failed";
        return result;
      } finally {
        if (result.stage === "locate") result.timingsMs.locate = Date.now() - started;
        if (clickStarted && result.stage === "click") result.timingsMs.click = Date.now() - clickStarted;
        if (waitStarted) result.timingsMs.wait = Date.now() - waitStarted;
        result.timingsMs.total = Date.now() - started;
      }
      };
      return this.withObservation(controller, tab, await perform());
    });
  }

  private async interact(controller: ChromeWorkerController, pageId: string, params: Record<string, unknown>) {
    const action = params.action;
    if (["kind", "text", "keys"].some(field => Object.hasOwn(params, field)) || action === "set" || action === "key")
      throw chromeWorkerError("invalid_params", "Use action with fill/type/press and the canonical value/key parameters.");
    if (!["fill", "type", "press", "scroll", "focus", "hover", "select", "check", "uncheck"].includes(String(action)))
      throw chromeWorkerError("capability_unavailable", "This browser interaction is unavailable");
    const hasTarget = params.selector !== undefined || params.ref !== undefined;
    const targetText = hasTarget ? this.target(pageId, params) : undefined;
    if (params.values !== undefined && action !== "select") throw chromeWorkerError("invalid_params", "Multiple values are only valid for select.");
    let values: string | string[] | undefined;
    if (action === "select") {
      if (params.values !== undefined && params.value !== undefined) throw chromeWorkerError("invalid_params", "Use value or values, never both.");
      if (params.values !== undefined) {
        if (!Array.isArray(params.values) || params.values.length > 100) throw chromeWorkerError("invalid_params", "values must be an array of at most 100 strings.");
        values = params.values.map(value => textParam(value, "values", 4096));
      } else values = textParam(params.value, "value", 4096);
    }
    const input = action === "fill" || action === "type" ? textParam(params.value, "value") : undefined;
    const key = action === "press" ? textParam(params.key, "key", 40) : undefined;
    if (key && !["Enter", "Escape", "Tab", "Shift+Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Backspace", "Delete", "Space", "ControlOrMeta+A"].includes(key))
      throw chromeWorkerError("invalid_params", "This key is not available.");
    if (action === "scroll" && hasTarget && (params.deltaX !== undefined || params.deltaY !== undefined))
      throw chromeWorkerError("invalid_params", "Choose an element or wheel deltas, never both.");
    const delta = (name: string, fallback: number) => {
      const value = params[name] ?? fallback;
      if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 2000) throw chromeWorkerError("invalid_params", "Wheel deltas must be finite and within 2000 pixels.");
      return value;
    };
    const deltaX = action === "scroll" && !hasTarget ? delta("deltaX", 0) : 0;
    const deltaY = action === "scroll" && !hasTarget ? delta("deltaY", 600) : 0;
    if (!hasTarget && !["scroll", "type", "press"].includes(String(action))) throw chromeWorkerError("invalid_params", "An observed element target is required.");
    return controller.run(pageId, async tab => {
      this.watch(tab);
      const result = await this.modalAction(tab, async signal => {
        const locator = hasTarget ? (await tab.targetLocator({ target: targetText! })).locator : undefined;
        if (signal.aborted) throw chromeWorkerError("cancelled", "Browser control has been released");
        if (params.ref !== undefined) this.observed(pageId, params.observationId);
        this.invalidate(pageId);
        if (action === "fill") await locator!.fill(input!, { timeout: 10000, signal });
        else if (action === "type") {
          if (locator) await locator.pressSequentially(input!, { timeout: 10000, signal });
          else await tab.page.keyboard.insertText(input!);
        } else if (action === "press") {
          if (locator) await locator.press(key!, { timeout: 10000, signal });
          else await tab.page.keyboard.press(key!);
        } else if (action === "scroll") {
          if (locator) await locator.scrollIntoViewIfNeeded({ timeout: 10000, signal });
          else await tab.page.mouse.wheel(deltaX, deltaY);
        } else if (action === "focus") await locator!.focus({ timeout: 10000, signal });
        else if (action === "hover") await locator!.hover({ timeout: 10000, signal });
        else if (action === "select") await locator!.selectOption(values!, { timeout: 10000, signal });
        else await locator!.setChecked(action === "check", { timeout: 10000, signal });
      }, 10000);
      const state = await this.describe(controller, tab);
      return this.withObservation(controller, tab, { ...state, ...result }, action === "scroll" ? { viewportOnly: true } : {});
    });
  }

  private observed(pageId: string, observationId: unknown) {
    const observation = this.observations.get(pageId);
    if (typeof observationId !== "string" || !observation || observation.id !== observationId)
      throw chromeWorkerError("stale_observation", "Observe this page before acting on the pending interaction.");
    return observation;
  }

  private async handleDialog(controller: ChromeWorkerController, pageId: string, params: Record<string, unknown>) {
    if (Object.keys(params).some(key => !["observationId", "dialogId", "action", "promptText"].includes(key)) || !["accept", "dismiss"].includes(String(params.action)))
      throw chromeWorkerError("invalid_params", "Choose accept or dismiss for an observed dialog.");
    return controller.run(pageId, async tab => {
      const observation = this.observed(pageId, params.observationId);
      const state = typeof params.dialogId === "string" ? observation.dialogs.get(params.dialogId) : undefined;
      if (!state?.dialog || !(tab.modalStates?.() ?? []).includes(state)) throw chromeWorkerError("stale_observation", "This dialog is no longer pending on the observed page.");
      if (params.promptText !== undefined && (params.action !== "accept" || state.dialog.type() !== "prompt")) throw chromeWorkerError("invalid_params", "promptText is only valid when accepting a prompt.");
      const prompt = params.promptText === undefined ? undefined : textParam(params.promptText, "promptText", 4096);
      this.invalidate(pageId);
      await this.nativeOnce(() => params.action === "accept" ? state.dialog!.accept(prompt) : state.dialog!.dismiss());
      if (this.abort.signal.aborted) throw chromeWorkerError("cancelled", "Browser control has been released");
      tab.clearModalState?.(state);
      return this.withObservation(controller, tab, { status: "handled", action: params.action, dialogId: params.dialogId });
    });
  }

  private async upload(controller: ChromeWorkerController, pageId: string, params: Record<string, unknown>) {
    if (Object.keys(params).some(key => !["observationId", "ref", "chooserId", "files"].includes(key)) || (params.ref !== undefined) === (params.chooserId !== undefined))
      throw chromeWorkerError("invalid_params", "Choose one observed file input or file chooser.");
    return controller.run(pageId, async tab => {
      this.watch(tab);
      const observation = this.observed(pageId, params.observationId);
      let modal: ChromeWorkerModalState | undefined;
      let locator: import("playwright-core").Locator | undefined;
      let handle: import("playwright-core").ElementHandle | undefined;
      if (params.chooserId !== undefined) {
        modal = typeof params.chooserId === "string" ? observation.choosers.get(params.chooserId) : undefined;
        if (!modal?.fileChooser || !(tab.modalStates?.() ?? []).includes(modal)) throw chromeWorkerError("stale_observation", "This file chooser is no longer pending on the observed page.");
        handle = modal.fileChooser.element();
        const frame = await handle.ownerFrame();
        if (frame?.page() !== tab.page) throw chromeWorkerError("stale_observation", "The file chooser belongs to another page.");
      } else {
        if (typeof params.ref !== "string" || !observation.refs.has(params.ref)) throw chromeWorkerError("stale_observation", "The file input is not part of this observation.");
        locator = (await tab.targetLocator({ target: params.ref })).locator;
        const valid = await locator.evaluate(element => element.tagName === "INPUT" && (element as HTMLInputElement).type === "file" && !element.matches(':disabled, [aria-disabled="true"]'), undefined, { timeout: 1000 });
        if (!valid) throw chromeWorkerError("invalid_params", "The observed target is not an enabled file input.");
      }
      this.observed(pageId, params.observationId);
      const files = decodeBrowserUploadFiles(params.files);
      this.invalidate(pageId);
      const result = await this.modalAction(tab, signal => handle ? handle.setInputFiles(files, { timeout: 10000, signal }) : locator!.setInputFiles(files, { timeout: 10000, signal }), 10000, Boolean(modal));
      if (this.abort.signal.aborted) throw chromeWorkerError("cancelled", "Browser control has been released");
      if (modal) tab.clearModalState?.(modal);
      if (handle) await handle.dispose();
      return this.withObservation(controller, tab, result);
    });
  }

}
