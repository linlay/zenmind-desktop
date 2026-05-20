import fs from "node:fs";
import type {
  ServiceLogReadOptions,
  ServiceLogReadResult,
  ServiceLogStreamOptions
} from "../../../shared/contracts";

export const LOG_READ_WINDOW_BYTES = 256 * 1024;
export const LOG_STREAM_POLL_INTERVAL_MS = 1000;

export function readServiceLogFile(
  filePath: string,
  options: ServiceLogReadOptions = {}
): ServiceLogReadResult {
  if (!filePath) {
    return {
      ok: true,
      path: "",
      exists: false,
      content: "",
      truncated: false,
      startOffset: 0,
      endOffset: 0,
      hasPrevious: false,
      resetRequired: false,
      totalBytes: 0
    };
  }

  try {
    const stat = fs.statSync(filePath);
    const totalBytes = stat.size;
    const requestedLimitBytes =
      typeof options.limitBytes === "number" && Number.isFinite(options.limitBytes)
        ? Math.floor(options.limitBytes)
        : LOG_READ_WINDOW_BYTES;
    const limitBytes = Math.min(
      LOG_READ_WINDOW_BYTES,
      Math.max(1, requestedLimitBytes)
    );
    const requestedBeforeOffset =
      typeof options.beforeOffset === "number" && Number.isFinite(options.beforeOffset)
        ? Math.max(0, Math.floor(options.beforeOffset))
        : undefined;
    const resetRequired = requestedBeforeOffset !== undefined && requestedBeforeOffset > totalBytes;
    const requestedEndOffset =
      requestedBeforeOffset === undefined || resetRequired ? totalBytes : Math.min(requestedBeforeOffset, totalBytes);
    const requestedStartOffset = Math.max(0, requestedEndOffset - limitBytes);
    const bytesToRead = requestedEndOffset - requestedStartOffset;

    if (bytesToRead === 0) {
      return {
        ok: true,
        path: filePath,
        exists: true,
        content: "",
        truncated: requestedStartOffset > 0,
        startOffset: requestedStartOffset,
        endOffset: requestedEndOffset,
        hasPrevious: requestedStartOffset > 0,
        resetRequired,
        totalBytes
      };
    }

    const descriptor = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(bytesToRead);
      const bytesRead = fs.readSync(descriptor, buffer, 0, bytesToRead, requestedStartOffset);
      const actualEndOffset = requestedStartOffset + bytesRead;
      let alignedStartOffset = requestedStartOffset;
      let contentStartIndex = 0;
      let startsOnLineBoundary = requestedStartOffset === 0;

      if (!startsOnLineBoundary && requestedStartOffset > 0) {
        const previousByte = Buffer.alloc(1);
        const previousByteCount = fs.readSync(descriptor, previousByte, 0, 1, requestedStartOffset - 1);
        startsOnLineBoundary = previousByteCount === 1 && previousByte[0] === 0x0a;
      }

      if (!startsOnLineBoundary && requestedStartOffset > 0 && bytesRead > 0) {
        const newlineIndex = buffer.indexOf(0x0a, 0);
        if (newlineIndex !== -1 && newlineIndex + 1 < bytesRead) {
          contentStartIndex = newlineIndex + 1;
          alignedStartOffset += contentStartIndex;
        }
      }

      const hasPrevious = alignedStartOffset > 0;
      return {
        ok: true,
        path: filePath,
        exists: true,
        content: buffer.toString("utf8", contentStartIndex, bytesRead),
        truncated: hasPrevious,
        startOffset: alignedStartOffset,
        endOffset: actualEndOffset,
        hasPrevious,
        resetRequired,
        totalBytes
      };
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ok: true,
        path: filePath,
        exists: false,
        content: "",
        truncated: false,
        startOffset: 0,
        endOffset: 0,
        hasPrevious: false,
        resetRequired: false,
        totalBytes: 0
      };
    }
    throw error;
  }
}

export function readLogRange(filePath: string, startOffset: number, endOffset: number) {
  const bytesToRead = Math.max(0, endOffset - startOffset);
  if (bytesToRead === 0) {
    return "";
  }

  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = fs.readSync(descriptor, buffer, 0, bytesToRead, startOffset);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

export function normalizeLogStreamPollInterval(options: ServiceLogStreamOptions) {
  if (typeof options.pollIntervalMs !== "number" || !Number.isFinite(options.pollIntervalMs)) {
    return LOG_STREAM_POLL_INTERVAL_MS;
  }
  return Math.max(250, Math.floor(options.pollIntervalMs));
}

export function normalizeLogStreamOffset(options: ServiceLogStreamOptions) {
  if (typeof options.fromOffset !== "number" || !Number.isFinite(options.fromOffset)) {
    return 0;
  }
  return Math.max(0, Math.floor(options.fromOffset));
}
