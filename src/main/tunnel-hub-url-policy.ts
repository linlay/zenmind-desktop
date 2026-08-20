export function isTunnelHubLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]";
}

export function isTunnelHubForbiddenHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (isTunnelHubLoopbackHostname(normalized)) {
    return false;
  }
  return normalized === "0.0.0.0" ||
    normalized.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized);
}
