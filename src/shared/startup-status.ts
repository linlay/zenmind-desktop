const DEFAULT_STARTUP_ACTION_MESSAGE = "启动中...";

export function formatStartupStatusText(serviceName: string, message?: string | null) {
  const normalizedServiceName = serviceName.trim();
  const normalizedMessage = (message ?? "").trim() || DEFAULT_STARTUP_ACTION_MESSAGE;

  if (!normalizedServiceName) {
    return normalizedMessage;
  }
  if (normalizedMessage === normalizedServiceName || normalizedMessage.startsWith(`${normalizedServiceName} `)) {
    return normalizedMessage;
  }
  if (normalizedMessage.startsWith(`${normalizedServiceName}：`) || normalizedMessage.startsWith(`${normalizedServiceName}:`)) {
    return normalizedMessage;
  }
  return `${normalizedServiceName} ${normalizedMessage}`;
}
