import http from "node:http";
import https from "node:https";
import { t } from "../../../support/i18n/main-i18n";

export function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function getServiceVerificationDelayMs() {
  const raw = Number.parseInt(process.env.SERVICE_VERIFY_DELAY_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1500;
}

export const CONTAINER_HUB_RUNNING_VERIFICATION_TIMEOUT_MS = 6000;

export function normalizeProbeUrl(baseURL: string, pathname?: string) {
  const parsed = new URL(baseURL);
  if (pathname) {
    parsed.pathname = pathname;
    parsed.search = "";
    parsed.hash = "";
  }
  return parsed.toString();
}

export type HttpProbeResult = {
  target: string;
  ok: boolean;
  statusCode?: number;
  contentType?: string;
  message?: string;
  bodyPreview?: string;
};

export type HttpProbeOptions = {
  timeoutMs?: number;
  headers?: Record<string, string>;
};

export function probeHttpUrl(target: string, optionsOrTimeoutMs: HttpProbeOptions | number = 1200): Promise<HttpProbeResult> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      resolve({ target, ok: false, message: t("service.urlInvalid") });
      return;
    }

    const options = typeof optionsOrTimeoutMs === "number"
      ? { timeoutMs: optionsOrTimeoutMs }
      : optionsOrTimeoutMs;
    const timeoutMs = options.timeoutMs ?? 1200;
    const client = parsed.protocol === "https:" ? https : http;
    const request = client.request(parsed, {
      method: "GET",
      headers: options.headers,
      timeout: timeoutMs
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        if (Buffer.concat(chunks).byteLength < 4096) {
          chunks.push(chunk);
        }
      });
      response.on("end", () => {
        const statusCode = response.statusCode ?? 0;
        const contentType = String(response.headers["content-type"] ?? "");
        const bodyPreview = Buffer.concat(chunks).toString("utf8").slice(0, 1000);
        resolve({
          target,
          ok: statusCode >= 200 && statusCode < 400,
          statusCode,
          contentType,
          bodyPreview,
          message: statusCode >= 200 && statusCode < 400
            ? undefined
            : `HTTP ${statusCode || t("service.probeNoResponse")}`
        });
      });
    });

    request.on("timeout", () => {
      request.destroy(new Error("HTTP probe timeout"));
    });
    request.on("error", (error) => {
      resolve({
        target,
        ok: false,
        message: error.message
      });
    });
    request.end();
  });
}
