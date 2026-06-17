export function formatStartupStatusText(
  serviceName: string,
  message?: string | null,
  fallbackMessage = "Starting..."
) {
  const normalizedServiceName = serviceName.trim();
  const normalizedMessage = (message ?? "").trim() || fallbackMessage;

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
