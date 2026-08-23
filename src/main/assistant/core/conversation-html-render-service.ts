import path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { App } from "electron";
import type { ServiceState } from "../../../shared/contracts";
import { t } from "../../i18n/main-i18n";
import { parseSafeLoopbackWebUrl } from "../../loopback-url";
import { getResponsiveServiceState } from "../../services/manager";
import {
  isTunnelHubForbiddenHostname,
  isTunnelHubLoopbackHostname
} from "../../tunnel-hub-url-policy";
import {
  CONVERSATION_EXPORT_TEMPLATE_PATH,
  MAX_CONVERSATION_HTML_BYTES,
  type ConversationHtmlRenderResult,
  type ConversationHtmlWorkerErrorCode,
  type RenderConversationHtmlRequest,
  type RenderConversationHtmlResponse
} from "./conversation-export-contract";

const AGENT_WEBCLIENT_SERVICE_ID = "agent-webclient";

export type ConversationSnapshotRequestResult =
  | { ok: true; snapshotUrl: string; bearerToken: string }
  | { ok: false; message: string };

export type ConversationSnapshotRequestProvider = {
  createChatSnapshotRequest(chatId: string): Promise<ConversationSnapshotRequestResult>;
};

type PendingRender = {
  resolve: (response: RenderConversationHtmlResponse) => void;
  reject: (error: Error) => void;
};

class ConversationHtmlWorkerError extends Error {
  constructor(
    readonly code: ConversationHtmlWorkerErrorCode,
    readonly actualBytes?: number,
    readonly limitBytes?: number
  ) {
    super(code);
    this.name = "ConversationHtmlWorkerError";
  }
}

export class ConversationHtmlRenderService {
  private worker: Worker | null = null;
  private disposed = false;
  private readonly pending = new Map<string, PendingRender>();

  constructor(private readonly options: {
    app: App;
    snapshotProvider: ConversationSnapshotRequestProvider;
    getServiceState?: (app: App, serviceId: string) => Promise<ServiceState>;
    workerPath?: string;
  }) {}

  start(): void {
    if (this.worker || this.disposed) return;
    const worker = new Worker(
      this.options.workerPath || path.join(__dirname, "conversation-html-worker.js"),
      { workerData: { mode: "conversation-html-render" } }
    );
    worker.unref();
    worker.on("message", (response: RenderConversationHtmlResponse) => {
      const pending = this.pending.get(response.requestId);
      if (!pending) return;
      this.pending.delete(response.requestId);
      pending.resolve(response);
    });
    worker.on("error", () => this.handleWorkerFailure(worker));
    worker.on("exit", () => this.handleWorkerFailure(worker));
    this.worker = worker;
  }

  async renderChatHtml(chatId: string, assetOrigin: string): Promise<ConversationHtmlRenderResult> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return { ok: false, message: t("assistant.chatIdRequired") };
    }
    if (!isValidAssetOrigin(assetOrigin)) {
      return { ok: false, message: t("assistant.chatShareTunnelConfigInvalid") };
    }
    const [snapshotRequest, webclientState] = await Promise.all([
      this.options.snapshotProvider.createChatSnapshotRequest(normalizedChatId),
      (this.options.getServiceState || getResponsiveServiceState)(
        this.options.app,
        AGENT_WEBCLIENT_SERVICE_ID
      ).catch(() => null)
    ]);
    if (!snapshotRequest.ok) return snapshotRequest;
    if (!webclientState || webclientState.status !== "running") {
      return { ok: false, message: t("assistant.chatHtmlExportUnsupported") };
    }
    const webclientVersion = String(webclientState.version || "").trim();
    const webclientURL = parseSafeLoopbackWebUrl(
      String(webclientState.healthMeta?.webUrl || "").trim()
    );
    if (!webclientURL || !webclientVersion) {
      return { ok: false, message: t("assistant.chatHtmlExportUnsupported") };
    }
    const templateURL = new URL(CONVERSATION_EXPORT_TEMPLATE_PATH, webclientURL.origin);
    const requestId = randomUUID();
    try {
      const response = await this.renderInWorker({
        requestId,
        snapshotUrl: snapshotRequest.snapshotUrl,
        bearerToken: snapshotRequest.bearerToken,
        templateUrl: templateURL.toString(),
        templateCacheKey: `${templateURL.origin}|${webclientVersion}`,
        assetOrigin: new URL(assetOrigin).origin
      });
      if (response.type === "error") {
        throw new ConversationHtmlWorkerError(
          response.code,
          response.actualBytes,
          response.limitBytes
        );
      }
      const bytes = Buffer.from(response.html);
      return {
        ok: true,
        bytes,
        filename: response.filename
      };
    } catch (error) {
      return { ok: false, message: mapRenderError(error) };
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const worker = this.worker;
    this.worker = null;
    this.rejectPending();
    if (worker) await worker.terminate().catch(() => undefined);
  }

  private renderInWorker(
    request: RenderConversationHtmlRequest
  ): Promise<RenderConversationHtmlResponse> {
    if (this.disposed) {
      return Promise.reject(new ConversationHtmlWorkerError("worker_failed"));
    }
    if (!this.worker) this.start();
    const worker = this.worker;
    if (!worker) {
      return Promise.reject(new ConversationHtmlWorkerError("worker_failed"));
    }
    return new Promise((resolve, reject) => {
      this.pending.set(request.requestId, { resolve, reject });
      try {
        worker.postMessage(request);
      } catch {
        this.pending.delete(request.requestId);
        reject(new ConversationHtmlWorkerError("worker_failed"));
      }
    });
  }

  private handleWorkerFailure(worker: Worker): void {
    if (this.worker !== worker) return;
    this.worker = null;
    this.rejectPending();
  }

  private rejectPending(): void {
    const error = new ConversationHtmlWorkerError("worker_failed");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function isValidAssetOrigin(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    const loopback = isTunnelHubLoopbackHostname(parsed.hostname);
    return value.trim() === parsed.origin && !parsed.username && !parsed.password &&
      !isTunnelHubForbiddenHostname(parsed.hostname) &&
      (parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback));
  } catch {
    return false;
  }
}

function mapRenderError(error: unknown): string {
  if (error instanceof ConversationHtmlWorkerError && error.code === "too_large") {
    return t("assistant.chatHtmlExportTooLarge", {
      actual: error.actualBytes ?? MAX_CONVERSATION_HTML_BYTES + 1,
      limit: error.limitBytes ?? MAX_CONVERSATION_HTML_BYTES
    });
  }
  if (error instanceof ConversationHtmlWorkerError &&
    (error.code === "template_invalid" || error.code === "snapshot_invalid" ||
      error.code === "request_invalid")) {
    return t("assistant.chatHtmlExportUnsupported");
  }
  return t("assistant.chatHtmlExportReadFailed");
}
