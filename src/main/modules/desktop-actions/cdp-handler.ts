import { type DesktopActionBridgeOptions, type DesktopCdpCallRequest, type DesktopCdpCallResponse } from "./action-contracts";
import {
  type SiteControlScope,
  validateDesktopCdpParams,
  DesktopCdpParamsError,
  isDesktopCdpTimeoutError,
  DESKTOP_CDP_TARGET_TIMEOUT_CODE,
  readDesktopCdpErrorDetails
} from "../web-surfaces";
import { cdpFail, asRecord } from "./action-values";
import { DESKTOP_CDP_PUBLIC_METHODS } from "../../../shared/embedded-cdp";

export async function handleDesktopCdpRequest(
  options: DesktopActionBridgeOptions,
  request: DesktopCdpCallRequest,
  scope?: SiteControlScope,
  signal?: AbortSignal,
  trustedRunSource = false
): Promise<DesktopCdpCallResponse> {
  const method = typeof request.method === "string" ? request.method.trim() : "";
  if (!method) {
    return cdpFail("unknown", "invalid_args", "method is required");
  }
  if (!DESKTOP_CDP_PUBLIC_METHODS.some((candidate) => candidate === method)) {
    return cdpFail(method, "method_not_allowed", "This CDP method is not exposed by Desktop.");
  }
  try {
    validateDesktopCdpParams(method, request.params);
  } catch (error) {
    if (error instanceof DesktopCdpParamsError) return cdpFail(method, error.code, error.message, {
      ...error.details,
      ...(typeof request.surfaceId === "string" && request.surfaceId.trim() ? { surfaceId: request.surfaceId.trim() } : {})
    });
    throw error;
  }
  const allowedFields = new Set(["requestId", "method", "params", "surfaceId", "source"]);
  if (Object.keys(request).some((key) => !allowedFields.has(key))) return cdpFail(method, "invalid_args", "Unsupported CDP request field. Use surfaceId to select a page.");
  const params = { ...asRecord(request.params) };
  let surfaceId = typeof request.surfaceId === "string" ? request.surfaceId.trim() : "";
  if (method === "Surface.close") {
    const paramsSurfaceId = typeof params.surfaceId === "string" ? params.surfaceId.trim() : "";
    if (surfaceId && paramsSurfaceId && surfaceId !== paramsSurfaceId) {
      return cdpFail(method, "invalid_args", "surfaceId conflicts with params.surfaceId.");
    }
    surfaceId ||= paramsSurfaceId;
    const extraParamKeys = Object.keys(params).filter((key) => key !== "surfaceId");
    if (extraParamKeys.length > 0) {
      return cdpFail(method, "invalid_args", "Surface.close only accepts surfaceId.");
    }
    if (!surfaceId) {
      return cdpFail(method, "target_required", "surfaceId is required for this CDP method.");
    }
    delete params.surfaceId;
  }
  try {
    const response = await options.executeCdpCommand({
      method,
      params,
      surfaceId,
      ...(trustedRunSource && request.source?.chatId ? { source: { chatId: request.source.chatId } } : {})
    }, scope, signal);
    return {
      ok: true,
      method,
      result: response.result,
      ...(response.surfaceId ? { surfaceId: response.surfaceId } : {})
    };
  } catch (error) {
    if (isDesktopCdpTimeoutError(error)) {
      return cdpFail(method, DESKTOP_CDP_TARGET_TIMEOUT_CODE, error.message, readDesktopCdpErrorDetails(error));
    }
    const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "cdp_failed";
    const details = error instanceof DesktopCdpParamsError ? error.details
      : errorCode === "target_not_in_current_surface" || errorCode === "target_not_found" || errorCode === "target_required"
        ? { method, surfaceId, executed: false, retryable: false,
            recovery: "Call Surface.list for this Run and use a currently authorized surfaceId. Do not reuse an old target or switch to another application. If no authorized target remains, stop and report the unavailable page." }
        : { method, ...(surfaceId ? { surfaceId } : {}) };
    return cdpFail(method, errorCode, error instanceof Error ? error.message : String(error), details);
  }
}
