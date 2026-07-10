const REDACTED_URL_VALUE = "REDACTED";
const SENSITIVE_URL_PARAMETER_NAMES = new Set([
  "accesstoken",
  "access_token",
  "api_key",
  "apikey",
  "authorization",
  "clientsecret",
  "client_secret",
  "code",
  "idtoken",
  "id_token",
  "key",
  "refreshtoken",
  "refresh_token",
  "secret",
  "token",
]);

function isSensitiveUrlParameter(name: string) {
  const normalizedName = name.trim().toLowerCase().replace(/[.-]/gu, "_");
  return SENSITIVE_URL_PARAMETER_NAMES.has(normalizedName) ||
    SENSITIVE_URL_PARAMETER_NAMES.has(normalizedName.replace(/_/gu, ""));
}

function redactUrlSearchParams(params: URLSearchParams) {
  let redacted = false;
  for (const [name] of params) {
    if (isSensitiveUrlParameter(name)) {
      params.set(name, REDACTED_URL_VALUE);
      redacted = true;
    }
  }
  return redacted;
}

function redactUrlFragment(hash: string) {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!fragment.includes("=")) {
    return hash;
  }

  const params = new URLSearchParams(fragment);
  if (!redactUrlSearchParams(params)) {
    return hash;
  }
  return `#${params.toString()}`;
}

function redactUnparseableUrl(value: string) {
  return value.replace(/([?&#])([^=&#]+)=([^&#]*)/gu, (match, separator: string, name: string) => (
    isSensitiveUrlParameter(name) ? `${separator}${name}=${REDACTED_URL_VALUE}` : match
  ));
}

/**
 * Keep the useful shape of a WebView URL visible without putting credentials
 * that happen to be carried in a query string on screen.
 */
export function redactWebviewDebugUrl(value: string) {
  const rawUrl = value.trim();
  if (!rawUrl) {
    return "";
  }

  try {
    const url = new URL(rawUrl);
    redactUrlSearchParams(url.searchParams);
    url.hash = redactUrlFragment(url.hash);
    return url.toString();
  } catch {
    return redactUnparseableUrl(rawUrl);
  }
}
