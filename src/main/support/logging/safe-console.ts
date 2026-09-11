type ConsoleWriter = (...args: unknown[]) => void;

function isConsoleWriteFailure(error: unknown) {
  const maybeCode = (error as { code?: unknown } | null)?.code;
  if (maybeCode === "EIO" || maybeCode === "EPIPE" || maybeCode === "ERR_STREAM_DESTROYED") {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /\b(write\s+EIO|EPIPE|ERR_STREAM_DESTROYED)\b/u.test(message);
}

export function writeSafeConsoleError(writer: ConsoleWriter, ...args: unknown[]) {
  try {
    writer(...args);
  } catch (error) {
    if (!isConsoleWriteFailure(error)) {
      throw error;
    }
  }
}

export function safeConsoleError(...args: unknown[]) {
  writeSafeConsoleError(console.error, ...args);
}

export const __testInternals = {
  isConsoleWriteFailure
};
