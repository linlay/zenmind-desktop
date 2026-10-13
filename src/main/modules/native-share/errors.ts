import type { NativeShareErrorCode } from "../../../shared/native-share";

export class NativeShareInboxError extends Error {
  constructor(readonly code: NativeShareErrorCode, message: string) {
    super(message);
    this.name = "NativeShareInboxError";
  }
}

export function invalidBatch(): NativeShareInboxError {
  return new NativeShareInboxError("invalid_batch", "The share batch is incomplete or invalid.");
}

export function changedFile(): NativeShareInboxError {
  return new NativeShareInboxError("changed_file", "The shared files changed after they were opened.");
}

export function alreadyCompleted(): NativeShareInboxError {
  return new NativeShareInboxError("already_completed", "This share batch has already been delivered.");
}

export function staleTarget(): NativeShareInboxError {
  return new NativeShareInboxError("stale_target", "The share target is no longer active.");
}

/** Filesystem exceptions contain local paths; they must never cross the IPC boundary. */
export function normalizeNativeShareError(error: unknown): NativeShareInboxError {
  return error instanceof NativeShareInboxError
    ? error
    : new NativeShareInboxError("io_error", "The shared files could not be accessed.");
}
