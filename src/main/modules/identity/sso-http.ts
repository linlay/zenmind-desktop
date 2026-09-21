import type { FetchResponseLike, ElectronFetchRuntime, FetchLike, OidcConfig } from "./sso-model";
import { DEFAULT_OIDC_CONFIG } from "./sso-defaults";
import { isGoogleOidcConfig } from "./sso-config-values";

export function readFetchErrorStatus(response: FetchResponseLike) {
  const status = typeof response.status === "number" ? response.status : 0;
  const statusText = typeof response.statusText === "string" ? response.statusText : "";
  return [status, statusText].filter(Boolean).join(" ") || "request failed";
}

export async function readFetchErrorBody(response: FetchResponseLike) {
  if (typeof response.text !== "function") {
    return "";
  }
  try {
    return (await response.text()).trim().slice(0, 300);
  } catch {
    return "";
  }
}

export function loadElectronFetchRuntime(): ElectronFetchRuntime | null {
  try {
    const runtime = require("electron") as unknown;
    return runtime && typeof runtime === "object" ? runtime as ElectronFetchRuntime : null;
  } catch {
    return null;
  }
}

export function getElectronNetFetch(runtime: ElectronFetchRuntime | null = loadElectronFetchRuntime()): FetchLike | null {
  const net = runtime?.net;
  const netFetch = net?.fetch;
  if (typeof netFetch !== "function") {
    return null;
  }
  return ((url, init) => netFetch.call(net, url, init)) as FetchLike;
}

export function getDefaultOidcFetch(runtime?: ElectronFetchRuntime | null): FetchLike {
  return getElectronNetFetch(runtime === undefined ? loadElectronFetchRuntime() : runtime) ||
    (fetch as unknown as FetchLike);
}

export function describeFetchError(error: unknown) {
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.message);
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error) {
      if (cause.message && cause.message !== error.message) {
        parts.push(cause.message);
      }
      const code = (cause as Error & { code?: unknown }).code;
      if (typeof code === "string" && !parts.includes(code)) {
        parts.push(code);
      }
    } else if (typeof cause === "string" && cause && cause !== error.message) {
      parts.push(cause);
    }
  } else if (typeof error === "string") {
    parts.push(error);
  }
  return parts.filter(Boolean).join(" - ") || String(error);
}

export function buildOidcFetchStage(action: string, config: OidcConfig = DEFAULT_OIDC_CONFIG) {
  return `${isGoogleOidcConfig(config) ? "Google" : "OIDC"} ${action}`;
}

export async function fetchJson(
  fetchImpl: FetchLike,
  url: string,
  init?: Parameters<FetchLike>[1],
  stage = "OIDC request"
) {
  let response: FetchResponseLike;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw new Error(`${stage} failed: ${describeFetchError(error)}`);
  }
  if (!response.ok) {
    const detail = await readFetchErrorBody(response);
    throw new Error(`${stage} failed: ${readFetchErrorStatus(response)}${detail ? ` - ${detail}` : ""}`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${stage} failed: invalid JSON response - ${describeFetchError(error)}`);
  }
}
