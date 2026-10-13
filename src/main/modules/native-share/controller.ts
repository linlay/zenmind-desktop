import {
  isNativeShareBatchId,
  type NativeShareReadRequest,
  type NativeShareReadResult,
  type NativeShareTarget,
  type NativeShareTransfer
} from "../../../shared/native-share";
import { NativeShareInbox, type ValidatedShareBatch } from "./inbox";
import { alreadyCompleted, NativeShareInboxError, normalizeNativeShareError, staleTarget } from "./errors";
import { receiveNativeShare } from "./receive";

export type NativeShareDiagnostic = {
  operation: "open" | "read";
  code: string;
  syscall?: string;
};

export type NativeShareControllerOptions = {
  platform: string;
  /** Required on macOS: the composition root supplies Desktop-owned storage, never an extension container. */
  inbox?: string;
  getDefaultAgentKey(): string;
  showMainWindow(route: string): void;
  isTargetActive(target: NativeShareTarget): boolean;
  /** Main-only errno diagnostics contain no source filenames, paths or attachment content. */
  onDiagnostic?(diagnostic: NativeShareDiagnostic): void;
};

type FileProgress = { nextOffset: number; previousOffset: number | null; eof: boolean };
type PendingShare = {
  target: NativeShareTarget;
  batch: ValidatedShareBatch;
  progress: FileProgress[];
  completed: boolean;
  queue: Promise<void>;
};

function validAgentKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/\p{Cc}/u.test(value);
}

function normalizeRequest(value: unknown): NativeShareReadRequest {
  if (typeof value !== "object" || value === null || !("batchId" in value) || !isNativeShareBatchId(value.batchId) ||
      !("newChat" in value) || typeof value.newChat !== "string" || !/^[1-9]\d{12}$/u.test(value.newChat) ||
      !("agentKey" in value) || !validAgentKey(value.agentKey) || !("operation" in value)) {
    throw new NativeShareInboxError("invalid_request", "The share request is invalid.");
  }
  const fields = value.operation === "read"
    ? ["batchId", "newChat", "agentKey", "operation", "fileIndex", "offset"]
    : ["batchId", "newChat", "agentKey", "operation"];
  if (Object.keys(value).some(field => !fields.includes(field))) {
    throw new NativeShareInboxError("invalid_request", "The share request contains unsupported fields.");
  }
  const target = { batchId: value.batchId, newChat: value.newChat, agentKey: value.agentKey };
  if (value.operation === "describe" || value.operation === "complete") return { ...target, operation: value.operation };
  if (value.operation === "read" && "fileIndex" in value && typeof value.fileIndex === "number" &&
      Number.isSafeInteger(value.fileIndex) && value.fileIndex >= 0 && "offset" in value && typeof value.offset === "number" &&
      Number.isSafeInteger(value.offset) && value.offset >= 0) return { ...target, operation: "read", fileIndex: value.fileIndex, offset: value.offset };
  throw new NativeShareInboxError("invalid_request", "The share request is invalid.");
}

function freshProgress(batch: ValidatedShareBatch): FileProgress[] {
  return batch.files.map(() => ({ nextOffset: 0, previousOffset: null, eof: false }));
}

export class NativeShareController {
  private readonly inbox: NativeShareInbox | null;
  private readonly pending = new Map<string, PendingShare>();
  private openQueue = Promise.resolve();
  private lastNonce = 0;
  private disposed = false;

  constructor(private readonly options: NativeShareControllerOptions) {
    // Only macOS has this native Share Extension. Its files arrive by loopback into Desktop-owned storage.
    if (options.platform === "win32") this.inbox = null;
    else if (options.platform === "darwin" && options.inbox) this.inbox = new NativeShareInbox({ inbox: options.inbox });
    else this.inbox = null;
  }

  async open(batchId: string, transfer?: NativeShareTransfer): Promise<void> {
    if (this.disposed || this.options.platform !== "darwin") return;
    if (!this.inbox || !this.options.inbox) throw new NativeShareInboxError("invalid_request", "Desktop-owned share storage is unavailable.");
    const operation = this.openQueue.then(async () => {
      if (transfer) {
        if (transfer.batchId !== batchId) throw new NativeShareInboxError("invalid_request", "The native share batch does not match its handoff.");
        await receiveNativeShare(transfer, this.options.inbox!, {
          onAcknowledgementError: error => this.reportDiagnostic("open", error)
        });
      }
      await this.openBatch(batchId);
    });
    this.openQueue = operation.catch(() => {});
    try { await operation; } catch (error) {
      this.reportDiagnostic("open", error);
      throw normalizeNativeShareError(error);
    }
  }

  private reportDiagnostic(operation: NativeShareDiagnostic["operation"], error: unknown): void {
    const object = typeof error === "object" && error !== null ? error : null;
    const errorCode = object && "code" in object ? object.code : undefined;
    const syscall = object && "syscall" in object ? object.syscall : undefined;
    const diagnostic: NativeShareDiagnostic = {
      operation,
      code: typeof errorCode === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(errorCode) ? errorCode : "unknown_error",
      ...(typeof syscall === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(syscall) ? { syscall } : {})
    };
    // A diagnostic sink cannot change the import result or replace its sanitized error.
    try { this.options.onDiagnostic?.(diagnostic); } catch {}
  }

  private async openBatch(batchId: string): Promise<void> {
    if (!this.inbox || this.disposed) return;
    if (!isNativeShareBatchId(batchId)) throw new NativeShareInboxError("invalid_request", "The share batch identifier is invalid.");
    const existing = this.pending.get(batchId);
    if (existing) {
      await existing.queue;
      if (existing.completed) throw alreadyCompleted();
      await this.inbox.assertStable(existing.batch);
      if (!this.disposed) this.options.showMainWindow(this.route(existing.target));
      return;
    }
    const batch = await this.inbox.validate(batchId);
    if (this.disposed) return;
    const agentKey = this.options.getDefaultAgentKey();
    if (!validAgentKey(agentKey)) throw new NativeShareInboxError("invalid_request", "The default share target is unavailable.");
    const timestamp = Math.max(Date.now(), this.lastNonce + 1);
    if (!/^[1-9]\d{12}$/u.test(String(timestamp))) throw new NativeShareInboxError("invalid_request", "The share target could not be created.");
    this.lastNonce = timestamp;
    const target = { batchId, agentKey, newChat: String(timestamp) };
    this.pending.set(batchId, { target, batch, progress: freshProgress(batch), completed: false, queue: Promise.resolve() });
    this.options.showMainWindow(this.route(target));
  }

  private route(target: NativeShareTarget): string {
    const search = new URLSearchParams({ newChat: target.newChat, shareBatch: target.batchId });
    return `/agent/${encodeURIComponent(target.agentKey)}?${search}`;
  }

  private assertActive(pending: PendingShare): void {
    if (this.disposed || !this.options.isTargetActive({ ...pending.target })) throw staleTarget();
  }

  async read(value: unknown): Promise<NativeShareReadResult> {
    try {
      if (!this.inbox) {
        if (this.options.platform === "darwin") throw new NativeShareInboxError("invalid_request", "Desktop-owned share storage is unavailable.");
        throw new NativeShareInboxError("unsupported_platform", "Native sharing is available only on macOS.");
      }
      const request = normalizeRequest(value);
      const pending = this.pending.get(request.batchId);
      if (!pending || this.disposed || pending.target.newChat !== request.newChat || pending.target.agentKey !== request.agentKey) {
        throw new NativeShareInboxError("not_open", "The share target was not opened by Desktop.");
      }
      // Describe resets cursors for a fresh guest. The whole batch has one serialized read/ack lane.
      const operation = pending.queue.then(() => this.readPending(pending, request));
      pending.queue = operation.then(() => {}, () => {});
      return await operation;
    } catch (error) {
      this.reportDiagnostic("read", error);
      const failure = normalizeNativeShareError(error);
      return { ok: false, code: failure.code, message: failure.message };
    }
  }

  private async readPending(pending: PendingShare, request: NativeShareReadRequest): Promise<NativeShareReadResult> {
    this.assertActive(pending);
    if (pending.completed && request.operation === "complete") return { ok: true, completed: true };
    const inbox = this.inbox!;
    if (request.operation === "describe") {
      // A lost acknowledgement can leave a receipt before the guest submits its query.
      // The same active, Desktop-issued target may restore its original files.
      await inbox.assertStable(pending.batch, true);
      this.assertActive(pending);
      pending.progress = freshProgress(pending.batch);
      return { ok: true, batchId: pending.target.batchId, files: pending.batch.files.map(({ name, sizeBytes, mimeType }) => ({ name, sizeBytes, mimeType })) };
    }
    if (request.operation === "complete") {
      if (!pending.progress.every(file => file.eof)) throw new NativeShareInboxError("incomplete", "Not all shared files have been received.");
      await inbox.complete(pending.batch, () => !this.disposed && this.options.isTargetActive({ ...pending.target }));
      pending.completed = true;
      this.assertActive(pending);
      return { ok: true, completed: true };
    }
    const file = pending.batch.files[request.fileIndex];
    const progress = pending.progress[request.fileIndex];
    if (!file || !progress || request.offset > file.sizeBytes ||
        (request.offset !== progress.nextOffset && request.offset !== progress.previousOffset)) {
      throw new NativeShareInboxError("invalid_request", "The shared file read position is invalid.");
    }
    const bytes = await inbox.read(pending.batch, request.fileIndex, request.offset, true);
    this.assertActive(pending);
    const nextOffset = request.offset + bytes.length;
    progress.previousOffset = request.offset;
    progress.nextOffset = nextOffset;
    progress.eof = nextOffset === file.sizeBytes;
    return { ok: true, dataBase64: bytes.toString("base64"), eof: progress.eof };
  }

  dispose(): void {
    this.disposed = true;
    this.pending.clear();
  }
}
