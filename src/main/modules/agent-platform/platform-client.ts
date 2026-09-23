import type { App } from "electron";
import type { AgentAuthIssueResult, ServiceId, ServiceState } from "../../../shared/contracts";
import { t } from "../../support/i18n/main-i18n";
import { AGENT_PLATFORM_SERVICE_ID } from "./bridge-contracts";
import { createApiUrl } from "./bridge-values";
import { readErrorText, unwrapApiResponse } from "./platform-http-response";

/** Private platform client operations behind the Assistant facade. */
export class PlatformClient {
  constructor(
    private readonly options: { app: App; getServiceState: (app: App, serviceId: ServiceId) => Promise<ServiceState>; issueAccessToken: (app: App, reason: "missing" | "unauthorized") => Promise<AgentAuthIssueResult> }
  ) {}

  async getJson<T>(pathOrUrl: string, options: { allowNotFound?: boolean; fallbackWhenUnavailable?: T } = {}): Promise<T> {
    const availability = await this.resolvePlatform();
    if (!availability.ok) {
      if ("fallbackWhenUnavailable" in options) {
        return options.fallbackWhenUnavailable as T;
      }
      throw new Error(availability.message);
    }
    const response = await this.platformFetch(availability.baseUrl, pathOrUrl, {
      headers: this.jsonHeaders(availability.token)
    });
    if (response.status === 404 && options.allowNotFound) {
      return null as T;
    }
    if (!response.ok) {
      throw new Error(await readErrorText(response));
    }
    return unwrapApiResponse<T>(await response.json());
  }

  async resolvePlatform(): Promise<
    { ok: true; baseUrl: string; token: string } | { ok: false; message: string }
  > {
    const serviceState = await this.options.getServiceState(this.options.app, AGENT_PLATFORM_SERVICE_ID).catch((error: unknown) => ({
      status: "error",
      message: error instanceof Error ? error.message : String(error),
      healthMeta: { webUrl: "", port: null }
    }) as Pick<ServiceState, "status" | "message" | "healthMeta">);
    const baseUrl = serviceState.status === "running"
      ? serviceState.healthMeta.webUrl.trim() ||
      (serviceState.healthMeta.port ? `http://127.0.0.1:${serviceState.healthMeta.port}` : "")
      : "";
    if (!baseUrl) {
      return {
        ok: false,
        message: serviceState.message || t("agentPlatform.notRunningStartInControlCenter")
      };
    }
    const tokenResult = await this.options.issueAccessToken(this.options.app, "missing");
    if (!tokenResult.ok || !tokenResult.token.trim()) {
      return {
        ok: false,
        message: tokenResult.message || t("agentPlatform.tokenUnavailable")
      };
    }
    return {
      ok: true,
      baseUrl,
      token: tokenResult.token.trim()
    };
  }

  platformFetch(baseUrl: string, pathname: string, init: RequestInit) {
    return fetch(createApiUrl(baseUrl, pathname), init);
  }

  jsonHeaders(token: string, extra: Record<string, string> = {}) {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...extra
    };
  }
}
