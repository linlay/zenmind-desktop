import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { t } from "../../support/i18n/main-i18n";
import {
  isTunnelHubForbiddenHostname,
  isTunnelHubLoopbackHostname
} from "../tunnel";
import {
  CONVERSATION_EXPORT_TEMPLATE_PATH,
  MAX_CONVERSATION_HTML_BYTES,
  type ConversationExportWorkerRequest,
  type ConversationHtmlRenderResult,
  type ConversationHtmlWorkerErrorCode,
  type ConversationSnapshotReadResult,
  type RenderConversationHtmlResponse
} from "./export-contract";

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
    snapshotProvider: ConversationSnapshotRequestProvider;
    workerPath?: string;
  }) {}

  start(): void {
    if (this.worker || this.disposed) return;
    const bundledWorkerPath = path.join(__dirname, "conversation-html-worker.js");
    const moduleWorkerPath = path.join(__dirname, "html-worker.js");
    const worker = new Worker(
      this.options.workerPath || (fs.existsSync(bundledWorkerPath) ? bundledWorkerPath : moduleWorkerPath),
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
    const snapshotRequest = await this.options.snapshotProvider
      .createChatSnapshotRequest(normalizedChatId);
    if (!snapshotRequest.ok) return snapshotRequest;
    const templateURL = new URL(CONVERSATION_EXPORT_TEMPLATE_PATH, assetOrigin);
    const requestId = randomUUID();
    try {
      const response = await this.renderInWorker({
        kind: "html",
        requestId,
        snapshotUrl: snapshotRequest.snapshotUrl,
        bearerToken: snapshotRequest.bearerToken,
        templateUrl: templateURL.toString(),
        templateCacheKey: templateURL.toString(),
        assetOrigin: new URL(assetOrigin).origin
      });
      if (response.type !== "result") {
        if (response.type === "snapshot") {
          throw new ConversationHtmlWorkerError("worker_failed");
        }
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

  async readChatSnapshot(chatId: string): Promise<ConversationSnapshotReadResult> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return { ok: false, message: t("assistant.chatIdRequired") };
    }
    const snapshotRequest = await this.options.snapshotProvider
      .createChatSnapshotRequest(normalizedChatId);
    if (!snapshotRequest.ok) return snapshotRequest;
    try {
      const response = await this.renderInWorker({
        kind: "snapshot",
        requestId: randomUUID(),
        snapshotUrl: snapshotRequest.snapshotUrl,
        bearerToken: snapshotRequest.bearerToken
      });
      if (response.type !== "snapshot") {
        if (response.type === "error") {
          throw new ConversationHtmlWorkerError(
            response.code,
            response.actualBytes,
            response.limitBytes
          );
        }
        throw new ConversationHtmlWorkerError("worker_failed");
      }
      return { ok: true, bytes: Buffer.from(response.snapshot) };
    } catch (error) {
      if (error instanceof ConversationHtmlWorkerError && error.code === "too_large") {
        return { ok: false, message: t("assistant.chatShareSnapshotTooLarge") };
      }
      return { ok: false, message: t("assistant.chatShareRequestFailed") };
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
    request: ConversationExportWorkerRequest
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
