import { t } from "../../support/i18n/main-i18n";

export function marketCatalogErrorMessage(error: unknown): string {
  // Node fetch wraps OS errors in `cause`; inspect both without exposing their
  // URLs, local paths or raw messages to the renderer. The same codes apply to
  // fetch on macOS and Windows; no platform-specific settings path is assumed.
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = "code" in current ? String(current.code) : "";
    if (current.name === "NetworkError" ||
      (current instanceof TypeError && /fetch failed|failed to fetch|load failed/iu.test(current.message)) ||
      /^(?:EACCES|EPERM|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ENETDOWN|EHOSTDOWN|UND_ERR_SOCKET|ERR_NETWORK_ACCESS_DENIED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED)$/u.test(code)) {
      return t("market.main.catalogNetworkUnavailable");
    }
    current = current.cause;
  }
  return t("market.main.catalogUnavailable", { reason: error instanceof Error ? error.message : String(error) });
}
