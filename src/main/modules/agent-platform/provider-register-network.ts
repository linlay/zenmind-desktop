import { t } from "../../support/i18n/main-i18n";
const MAX_ERROR_BODY_LENGTH = 240;
type ProviderRegisterFetchResponse = {
  ok: boolean;
  status: number;
  statusText?: string;
  text: () => Promise<string>;
};

export type ProviderRegisterFetch = (
  input: string,
  init: {
    method: "POST";
    credentials: "omit";
    redirect: "error";
    signal: AbortSignal;
    headers: Record<string, string>;
    body: string;
  }
) => Promise<ProviderRegisterFetchResponse>;


export class ProviderRegisterHttpError extends Error {
 constructor(public readonly status: number, message: string) { super(message); }
}
function redactSensitiveText(value: string) {
  return value
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "<redacted-jwt>")
    .replace(/\b(?:dk|th|sk)_[A-Za-z0-9_-]{8,}\b/gu, "<redacted-key>");
}

function summarizeResponseBody(value: string) {
  const normalized = redactSensitiveText(value).replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= MAX_ERROR_BODY_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_ERROR_BODY_LENGTH)}...`;
}

function summarizeRequestError(error: unknown, token: string) {
  const details: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && current !== null && !seen.has(current) && seen.size < 4) {
    seen.add(current);
    if (typeof current !== "object") {
      details.push(String(current));
      break;
    }
    const failure = current as { message?: unknown; code?: unknown; cause?: unknown };
    const code = typeof failure.code === "string" ? failure.code : "";
    const message = typeof failure.message === "string" ? failure.message : "";
    if (code || message) {
      details.push([code, message].filter(Boolean).join(": "));
    }
    current = failure.cause;
  }
  const message = (details.join(" -> ") || String(error)).split(token).join("<redacted-token>");
  return redactSensitiveText(message);
}

export async function requestApiKey(input: {
  endpoint: string;
  token: string;
  deviceId: string;
  fetchImpl: ProviderRegisterFetch;
  bind?: boolean;
}) {
  let response: ProviderRegisterFetchResponse;
  let responseText: string;
  try {
    response = await input.fetchImpl(input.endpoint, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ name: input.deviceId, ...(input.bind ? { device_id: input.deviceId } : {}) })
    });
    responseText = await response.text();
  } catch (error) {
    throw new Error(t("providerRegister.requestFailed", { message: summarizeRequestError(error, input.token) }));
  }

  if (!response.ok) {
    const suffix = input.bind ? "" : summarizeResponseBody(responseText.split(input.token).join("<redacted-token>"));
    throw new ProviderRegisterHttpError(response.status,
      t("providerRegister.httpFailed", {
        status: response.status,
        statusText: response.statusText ? ` ${response.statusText}` : "",
        suffix: suffix ? `: ${suffix}` : ""
      })
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error(t("providerRegister.responseNotJson"));
  }

  const key = typeof (parsed as { key?: unknown })?.key === "string"
    ? (parsed as { key: string }).key.trim()
    : "";
  if (!key) {
    throw new Error(t("providerRegister.responseMissingKey"));
  }
  return key;
}
