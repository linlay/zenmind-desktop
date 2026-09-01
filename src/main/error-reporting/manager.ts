import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { App, CrashReporter } from "electron";
import { getDesktopStateRoot } from "../user-paths";
import { getDesktopSsoAccessToken } from "../oidc-sso";
import { readErrorReportingSettings, writeErrorReportingSettings } from "./settings";

export type DesktopErrorSource = "renderer" | "unhandled_rejection" | "react_error_boundary" | "service_webview" | "main" | "preload";
type QueueItem = {
  idempotencyId: string;
  source: DesktopErrorSource;
  title: string;
  message: string;
  stack: string;
  appVersion: string;
  platform: string;
  installId: string;
  occurredAt: string;
};

const MAX_QUEUE_ITEMS = 100;
const MAX_QUEUE_BYTES = 2 << 20;
const MAX_TEXT_BYTES = 256 << 10;
const REDACTED = "[REDACTED]";

export function sanitizeErrorText(value: unknown) {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text
    .replace(/\b(authorization|cookie|access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|secret|api[_-]?key)(\s*[:=]\s*)[^\s,;]+/giu, `$1$2${REDACTED}`)
    .replace(/([?&](?:token|access_token|refresh_token|id_token|api_key|password)=)[^&#\s]*/giu, `$1${REDACTED}`)
    .replace(/(?:[a-z]:\\(?:[^\\\s]+\\)+)([^\\\s:]+)/giu, "<local-path>/$1")
    .replace(/(?:\/(?:Users|home)\/[^/\s]+(?:\/[^/\s]+)*\/)([^/\s:]+)/gu, "<local-path>/$1")
    .slice(0, MAX_TEXT_BYTES);
}

export function mapDiagnosticSource(value: unknown): DesktopErrorSource {
  switch (value) {
    case "unhandledrejection": return "unhandled_rejection";
    case "react-error-boundary": return "react_error_boundary";
    case "service-webview": return "service_webview";
    case "preload": return "preload";
    case "main": return "main";
    default: return "renderer";
  }
}

export class ErrorReportingManager {
  private queue: QueueItem[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending = false;
  private crashpadStarted = false;
  private readonly queuePath: string;
  private readonly installId: string;

  private readonly fetchImpl: typeof fetch;
  private readonly getToken: () => string;

  constructor(
    private readonly app: App,
    private readonly crashReporter: CrashReporter,
    dependencies: { fetchImpl?: typeof fetch; getToken?: () => string } = {}
  ) {
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.getToken = dependencies.getToken ?? (() => getDesktopSsoAccessToken() || "");
    const root = path.join(getDesktopStateRoot(app), "error-reporting");
    this.queuePath = path.join(root, "queue.json");
    const identityPath = path.join(root, "install-id");
    fs.mkdirSync(root, { recursive: true });
    try { this.installId = fs.readFileSync(identityPath, "utf8").trim(); }
    catch { this.installId = crypto.randomUUID(); fs.writeFileSync(identityPath, `${this.installId}\n`, { mode: 0o600 }); }
    this.loadQueue();
  }

  start() {
    const settings = readErrorReportingSettings(this.app);
    if (!settings.enabled) { this.disable(); return; }
    if (settings.endpoint) {
      if (this.crashpadStarted) {
        this.crashReporter.setUploadToServer(true);
      } else {
        this.crashReporter.start({
          productName: this.app.getName(), submitURL: `${settings.endpoint}/api/v1/crashes`,
          uploadToServer: true, compress: true, rateLimit: true,
          globalExtra: { install_id: this.installId, _companyName: "ZenMind" }
        });
        this.crashpadStarted = true;
      }
      this.schedule(2000);
    }
  }

  report(sourceValue: unknown, details: Record<string, unknown>) {
    const settings = readErrorReportingSettings(this.app);
    if (!settings.enabled || !settings.endpoint) return;
    const message = sanitizeErrorText(details.message ?? details.error ?? "Unknown Desktop error");
    const item: QueueItem = {
      idempotencyId: crypto.randomUUID(), source: mapDiagnosticSource(details.source ?? sourceValue),
      title: sanitizeErrorText(message.split("\n", 1)[0] || "Desktop error"), message,
      stack: sanitizeErrorText(details.stack ?? details.componentStack ?? ""), appVersion: this.app.getVersion(),
      platform: process.platform, installId: this.installId, occurredAt: new Date().toISOString()
    };
    this.queue.push(item);
    while (this.queue.length > MAX_QUEUE_ITEMS || Buffer.byteLength(JSON.stringify(this.queue)) > MAX_QUEUE_BYTES) this.queue.shift();
    this.persist();
    this.schedule(0);
  }

  setEnabled(enabled: boolean) {
    writeErrorReportingSettings(this.app, { enabled });
    if (enabled) this.start(); else this.disable();
  }

  private disable() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try { this.crashReporter.setUploadToServer(false); } catch { /* Crashpad may not have started. */ }
    this.queue = [];
    this.persist();
    try {
      const pending = this.app.getPath("crashDumps");
      for (const name of fs.readdirSync(pending)) {
        if (name.endsWith(".dmp")) fs.rmSync(path.join(pending, name), { force: true });
      }
    } catch { /* Pending dump cleanup is best effort on unsupported runtimes. */ }
  }

  private schedule(delay: number) {
    if (this.timer || this.sending) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, delay);
  }

  private async flush() {
    if (this.sending || this.queue.length === 0) return;
    const settings = readErrorReportingSettings(this.app);
    if (!settings.enabled || !settings.endpoint) return;
    this.sending = true;
    const item = this.queue[0];
    let nextDelay: number | null = null;
    try {
      const token = this.getToken();
      const response = await this.fetchImpl(`${settings.endpoint}/api/v1/errors`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(item), signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) throw new Error(`error upload rejected: ${response.status}`);
      this.queue.shift(); this.persist();
      if (this.queue.length) nextDelay = 250;
    } catch { nextDelay = 30_000; }
    finally {
      this.sending = false;
      if (nextDelay !== null) this.schedule(nextDelay);
    }
  }

  private loadQueue() {
    try { const parsed = JSON.parse(fs.readFileSync(this.queuePath, "utf8")); this.queue = Array.isArray(parsed) ? parsed.slice(-MAX_QUEUE_ITEMS) : []; }
    catch { this.queue = []; }
  }
  private persist() {
    fs.mkdirSync(path.dirname(this.queuePath), { recursive: true });
    const temporary = `${this.queuePath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.queue)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.queuePath);
  }
}

let active: ErrorReportingManager | null = null;
export function initializeErrorReporting(app: App, crashReporter: CrashReporter) {
  if (!active) active = new ErrorReportingManager(app, crashReporter);
  active.start();
}
export function reportDesktopError(source: unknown, details: Record<string, unknown>) { active?.report(source, details); }
export function setDesktopErrorReportingEnabled(enabled: boolean) { active?.setEnabled(enabled); }
