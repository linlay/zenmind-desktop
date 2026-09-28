import { getMainLocale, t } from "../../support/i18n/main-i18n";
import { type PlatformResponse, type AgentPlatformFetchOptions, type DesktopActionBridgeOptions } from "./action-contracts";
import { type App } from "electron";
import { getResponsiveServiceState } from "../services";

export function agentPlatformAuthFailureMessage() {
  return t("desktopAction.agentPlatformAuthFailed");
}

export function unwrapPlatformResponse<T>(payload: unknown): T {
  if (payload && typeof payload === "object" && "code" in payload && "data" in payload) {
    const response = payload as PlatformResponse<T>;
    if (response.code !== 0) {
      throw new Error(response.msg || `agent-platform returned code ${response.code}`);
    }
    return response.data as T;
  }
  return payload as T;
}

export function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function isUnauthorizedPayload(payload: unknown) {
  const record = readObject(payload);
  return typeof record.error === "string" && record.error.trim().toLowerCase() === "unauthorized";
}

export async function readAgentPlatformResponse(response: Response) {
  const text = await response.text();
  if (!text.trim()) {
    return { text, payload: null };
  }
  try {
    return { text, payload: JSON.parse(text) as unknown };
  } catch {
    return { text, payload: null };
  }
}

export async function fetchAgentPlatformWithAuth<T>(
  baseUrl: string,
  pathOrUrl: string,
  options: AgentPlatformFetchOptions
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestUrl = new URL(pathOrUrl, baseUrl).toString();
  if (options.body !== undefined && options.rawBody !== undefined) {
    throw new Error("agent-platform request cannot contain both JSON and raw bodies");
  }
  let requestBody: BodyInit | undefined;
  if (options.rawBody !== undefined) {
    const body = new ArrayBuffer(options.rawBody.byteLength);
    new Uint8Array(body).set(options.rawBody);
    requestBody = body;
  } else if (options.body !== undefined) {
    requestBody = JSON.stringify(options.body);
  }
  const contentType = options.rawBody !== undefined
    ? options.contentType?.trim() || "application/octet-stream"
    : options.body === undefined ? "" : "application/json";

  for (const reason of ["missing", "unauthorized"] as const) {
    const token = await options.issueToken(reason);
    if (!token.ok || !token.token?.trim()) {
      throw new Error(token.message || "agent-platform token unavailable");
    }

    const response = await fetchImpl(requestUrl, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        "X-Locale": getMainLocale(),
        Authorization: `Bearer ${token.token.trim()}`,
        ...(requestBody === undefined ? {} : { "Content-Type": contentType })
      },
      ...(requestBody === undefined ? {} : { body: requestBody })
    });
    const { text, payload } = await readAgentPlatformResponse(response);
    const unauthorized = response.status === 401 || isUnauthorizedPayload(payload);
    if (unauthorized) {
      if (reason === "missing") {
        continue;
      }
      throw new Error(agentPlatformAuthFailureMessage());
    }
    if (!response.ok) {
      throw new Error(text || `agent-platform returned HTTP ${response.status}`);
    }
    return unwrapPlatformResponse<T>(payload);
  }

  throw new Error(agentPlatformAuthFailureMessage());
}

export async function callAgentPlatform<T>(
  app: App,
  pathOrUrl: string,
  options: {
    method?: string;
    body?: unknown;
    rawBody?: Uint8Array;
    contentType?: string;
    issueAgentAccessToken: DesktopActionBridgeOptions["issueAgentAccessToken"];
  }
): Promise<T> {
  const state = await getResponsiveServiceState(app, "agent-platform");
  const baseUrl = state.status === "running"
    ? state.healthMeta.webUrl.trim() || (state.healthMeta.port ? `http://127.0.0.1:${state.healthMeta.port}` : "")
    : "";
  if (!baseUrl) {
    throw new Error("agent-platform is not running");
  }
  const token = await options.issueAgentAccessToken(app, "missing");
  if (!token.ok) {
    throw new Error(token.message || "agent-platform token unavailable");
  }
  return fetchAgentPlatformWithAuth<T>(baseUrl, pathOrUrl, {
    ...options,
    issueToken: async (reason) => (reason === "missing" ? token : options.issueAgentAccessToken(app, reason))
  });
}
