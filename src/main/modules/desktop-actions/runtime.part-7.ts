import type { SiteCdpScope } from "../web-surfaces";
import http from "node:http";

import fs from "node:fs";

import path from "node:path";

import { randomUUID } from "node:crypto";

import type { AddressInfo } from "node:net";

import type { App, BrowserWindow, OpenDialogOptions, SaveDialogOptions, WebContents } from "electron";

import { clipboard, dialog, Notification, shell, systemPreferences, webContents } from "electron";

import type {
  AssistantAttachment,
  DesktopActionConfirmationDecision,
  DesktopActionConfirmationRequest,
  DesktopActionConfirmationResponse,
  DesktopActionRendererRequest,
  DesktopActionRendererResponse,
  DesktopAppInfo,
  DesktopPageContextSnapshot,
  DesktopPetState,
  DesktopRuntimeDiagnostics,
  DesktopWebappChangedReason,
  KanbanIssueInput,
  KanbanIssueMoveInput,
  KanbanIssueUpdateInput,
  MarketListOptions,
  ServiceId,
  ServiceLogTarget,
  ServiceOpenLogViewerRequest,
  WebappCommandResult,
  WebappEntry,
  WebappPublishResult,
  WebappRuntimeState,
  WorkPanelWorkspace
} from "../../../shared/contracts";

import {
  WEBAPP_BRIDGE_AVAILABLE_CAPABILITIES,
  WEBAPP_BRIDGE_RESERVED_CAPABILITIES,
  WEBAPP_BRIDGE_VERSION,
  type WebappBridgeCapabilitiesResult,
  type WebappBridgePermissionStatus
} from "../../../shared/webapp-bridge";

import {
  WEBAPP_ASSISTANT_MESSAGE_MAX_CHARS,
  WEBAPP_ID_PATTERN
} from "../../../shared/webapp-manifest";

import {
  DESKTOP_ACTION_BRIDGE_HOST,
  DESKTOP_ACTION_DEFINITIONS,
  getDesktopActionDefinition,
  isDesktopActionMutating,
  type DesktopActionCallRequest,
  type DesktopActionCallResponse,
  type DesktopActionConfirmationPolicy,
  type DesktopActionError,
  type DesktopActionSource,
  type DesktopCopilotPreferenceResult,
  type DesktopKanbanDeleteResult,
  type DesktopKanbanIssueResult,
  type DesktopPetListResult,
  type DesktopPetSetResult,
  type DesktopPetStateResult,
  type DesktopPetVisibilityResult,
  type DesktopWebActionStateResult,
  type DesktopWebActionSurfaceSummary,
  type DesktopWebActionTabSummary,
  type DesktopWebCloseTabResult,
  type DesktopWebExportArtifactResult,
  type DesktopWebNavigateResult,
  type DesktopWebOpenTabResult,
  type DesktopWebTargetTabResult,
  type DesktopWebappInstallDiagnostic,
  type DesktopWebappInstallFailureDetails,
  type DesktopWebappInstallResult,
  type DesktopWebappInvalidResultDetails,
  type DesktopWebappOpenResult,
  type DesktopWebappPreferenceFailureDetails,
  type DesktopWebappPreferenceResult,
  type DesktopWebappPublishFailureDetails,
  type DesktopWebappPublishResult,
  type DesktopWebappRuntimeFailureDetails,
  type DesktopWebappRuntimeMutationResult,
  type DesktopWebappSummary,
  type DesktopWebappToolingResult,
  type DesktopWebappUninstallResult,
  type DesktopWebappUnpublishResult,
  type DesktopWorkPanelCloseResult,
  type DesktopWorkPanelCloseTabResult,
  type DesktopWorkPanelWorkspaceResult,
  type DesktopWebsiteItemResult,
  type DesktopWebsiteRemoveResult
} from "../../../shared/desktop-actions";

import { isDesktopCopilotPageKey } from "../../../shared/assistant-settings";

import { isSurfaceRole } from "../../../shared/surface-identity";

import { ActionBridgeTimeContractError, normalizeActionBridgeTimePayload } from "./time-normalizer";

import { AGENT_WEBCLIENT_ROUTE_DEFINITIONS } from "../../../shared/agent-webclient-routes";

import { DESKTOP_CDP_PUBLIC_METHODS } from "../../../shared/embedded-cdp";

import type { EmbeddedCdpCommandRequest } from "../web-surfaces";


import type {
  AgentPlatformAssistantBridge,
  AgentPlatformImageOperation
} from "../agent-platform";

import {
  getServiceLogsMeta,
  getResponsiveServiceState,
  getServiceState,
  initializeService,
  installBuiltinService,
  listServices,
  readServiceLog,
  restartService,
  startService,
  stopService
} from "../services";

import { createWebappImportDiagnostic, listWebEntries } from "../webs";

import {
  addWebsiteItem,
  listWebsiteItems,
  removeWebsiteItem,
  updateWebsiteItem
} from "../webs";

import {
  executeWebappToolingInWorker,
  resolveExistingWorkspacePath,
  webappManager,
  WebappToolingError,
  type WebappToolingTask,
  WebappRuntimeRequiredError
} from "../webs";

import { consumeWebappImageUpload } from "../webs";

import { webappWindowManager } from "../webs";

import {
  getWebappPublishStatus,
  publishWebapp,
  unpublishWebapp
} from "../webs";

import {
  buildSandboxImage,
  deleteSandboxImage,
  exportSandboxImageToPath,
  getMarketSettings,
  installMarketItem,
  listMarketItems,
  refreshMarketCatalog,
  saveMarketSettings,
  uninstallMarketItem,
  updateMarketItem
} from "../marketplace";

import { normalizeMarketApiBaseUrl } from "../marketplace";

import { readDesktopProfileFromRoot } from "../../infrastructure/filesystem/profile-store";

import { getDesktopConfigRoot } from "../../infrastructure/filesystem/user-paths";

import {
  DESKTOP_CDP_TARGET_TIMEOUT_CODE,
  isDesktopCdpTimeoutError,
  readDesktopCdpErrorDetails
} from "../web-surfaces";

import {
  inspectCurrentPageCdpElement,
  readCurrentPageCdpLocation,
  type CurrentPageCdpElementSnapshot
} from "../web-surfaces";

import type { KanbanRuntime } from "../kanban";

import { t } from "../../support/i18n/main-i18n";

import { getConfiguredDesktopActionBridgePort } from "./settings";

import { getDesktopDeviceInfo } from "../identity";

import { authorizeWebappActionToken } from "../webs";

import {
  getAvailableFilePath,
  getDesktopDownloadDefaultPath,
  sanitizeDownloadFilename
} from "../../infrastructure/filesystem/download-paths";

import {
  resolveWorkPanelLocalFileFromWorkspace,
  type WorkPanelLocalFilePathResolution,
} from "../work-panel";

import { DesktopActionBridgeOptions, DesktopCdpCallRequest, DesktopCdpCallResponse, asRecord, cdpFail, desktopActionServerState, fail, readBody, webappActionRateLimiter, writeJSON } from "./runtime.part-1";

import { buildDesktopActionConfirmationDetail, buildMutatingActionConfirmationRequest, buildPageControlActionConfirmationRequest, buildSensitiveReadConfirmationRequest, fetchAgentPlatformWithAuth, sanitizeConfirmationUrl, summarizeConfirmationArgs } from "./runtime.part-2";

import { handleActionCall, normalizeActionResponseTimePayload } from "./runtime.part-6";

export async function handleDesktopCdpRequest(
  options: DesktopActionBridgeOptions,
  request: DesktopCdpCallRequest,
  scope?: SiteCdpScope
): Promise<DesktopCdpCallResponse> {
  const method = typeof request.method === "string" ? request.method.trim() : "";
  if (!method) {
    return cdpFail("unknown", "invalid_args", "method is required");
  }
  if (!DESKTOP_CDP_PUBLIC_METHODS.some((candidate) => candidate === method)) {
    return cdpFail(method, "method_not_allowed", "This CDP method is not exposed by Desktop.");
  }
  const params = { ...asRecord(request.params) };
  let targetId = typeof request.targetId === "string" ? request.targetId.trim() : "";
  if (method === "Target.closeTarget") {
    const paramsTargetId = typeof params.targetId === "string" ? params.targetId.trim() : "";
    if (targetId && paramsTargetId && targetId !== paramsTargetId) {
      return cdpFail(method, "invalid_args", "targetId conflicts with params.targetId.");
    }
    targetId ||= paramsTargetId;
    const extraParamKeys = Object.keys(params).filter((key) => key !== "targetId");
    if (extraParamKeys.length > 0) {
      return cdpFail(method, "invalid_args", "Target.closeTarget only accepts targetId.");
    }
    if (!targetId) {
      return cdpFail(method, "target_required", "targetId is required for this CDP method.");
    }
    delete params.targetId;
  }
  try {
    const response = await options.executeCdpCommand({
      method,
      params,
      targetId,
      ...(request.source?.chatId ? { source: { chatId: request.source.chatId } } : {})
    }, scope);
    return {
      ok: true,
      method,
      result: response.result,
      ...(response.targetId ? { targetId: response.targetId } : {}),
      ...(response.surfaceId ? { surfaceId: response.surfaceId } : {})
    };
  } catch (error) {
    if (isDesktopCdpTimeoutError(error)) {
      return cdpFail(method, DESKTOP_CDP_TARGET_TIMEOUT_CODE, error.message, readDesktopCdpErrorDetails(error));
    }
    const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "cdp_failed";
    return cdpFail(method, errorCode, error instanceof Error ? error.message : String(error));
  }
}

export function isLocalhostRequest(req: http.IncomingMessage) {
  return req.socket.remoteAddress === DESKTOP_ACTION_BRIDGE_HOST ||
    req.socket.remoteAddress === "::ffff:127.0.0.1";
}

export function hasJsonContentType(req: http.IncomingMessage) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  return contentType.split(";")[0].trim() === "application/json";
}

export function readBearerToken(req: http.IncomingMessage) {
  const authorization = String(req.headers.authorization || "").trim();
  return authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice("bearer ".length).trim()
    : "";
}

export function startDesktopActionBridge(options: DesktopActionBridgeOptions) {
  const bridgePort = getConfiguredDesktopActionBridgePort(options.app);
  if (desktopActionServerState.activeServer) {
    if (desktopActionServerState.activeServerPort === bridgePort) {
      return desktopActionServerState.activeServer;
    }
    const previousServer = desktopActionServerState.activeServer;
    desktopActionServerState.activeServer = null;
    desktopActionServerState.activeServerPort = 0;
    previousServer.close();
  }

  const server = http.createServer(async (req, res) => {
    if (!isLocalhostRequest(req)) {
      writeJSON(res, 403, fail("unknown", "forbidden", "Desktop Action Bridge only accepts localhost requests."));
      return;
    }

    const url = new URL(req.url || "/", `http://${DESKTOP_ACTION_BRIDGE_HOST}:${bridgePort}`);
    if (req.method === "GET" && url.pathname === "/health") {
      writeJSON(res, 200, {
        ok: true,
        host: DESKTOP_ACTION_BRIDGE_HOST,
        port: (server.address() as AddressInfo | null)?.port ?? bridgePort
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/actions") {
      writeJSON(res, 200, { ok: true, actions: DESKTOP_ACTION_DEFINITIONS });
      return;
    }
    if (req.method === "POST" && url.pathname === "/actions/call") {
      if (!hasJsonContentType(req)) {
        writeJSON(res, 415, fail("unknown", "unsupported_media_type", "Content-Type must be application/json."));
        return;
      }
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as DesktopActionCallRequest;
        const response = await handleActionCall(options, parsed);
        writeJSON(res, response.ok ? 200 : 400, response);
      } catch (error) {
        writeJSON(res, 400, fail("unknown", "invalid_request", error instanceof Error ? error.message : String(error)));
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/webapps/actions/call") {
      if (!hasJsonContentType(req)) {
        writeJSON(res, 415, fail("unknown", "unsupported_media_type", "Content-Type must be application/json."));
        return;
      }
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as DesktopActionCallRequest;
        const authorization = authorizeWebappActionToken(
          readBearerToken(req),
          parsed.action,
          "backendActionToken"
        );
        if (!authorization.ok) {
          writeJSON(res, 403, fail(parsed.action || "unknown", "forbidden", "WebApp action token is missing, expired, or not authorized for this action."));
          return;
        }
        const response = await handleActionCall(
          options,
          {
            ...parsed,
            source: {
              webappId: authorization.webappId
            }
          },
          { kind: "webappBackend", webappId: authorization.webappId }
        );
        writeJSON(res, response.ok ? 200 : 400, response);
      } catch (error) {
        writeJSON(res, 400, fail("unknown", "invalid_request", error instanceof Error ? error.message : String(error)));
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/webapps/pages/actions/call") {
      if (!hasJsonContentType(req)) {
        writeJSON(res, 415, fail("unknown", "unsupported_media_type", "Content-Type must be application/json."));
        return;
      }
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as DesktopActionCallRequest;
        const authorization = authorizeWebappActionToken(
          readBearerToken(req),
          parsed.action,
          "localPageGateway"
        );
        if (!authorization.ok) {
          writeJSON(res, 403, fail(parsed.action || "unknown", "forbidden", "WebApp page token is missing, expired, or not authorized for this action."));
          return;
        }
        const response = await handleActionCall(
          options,
          {
            ...parsed,
            source: {
              webappId: authorization.webappId
            }
          },
          { kind: "webappPage", webappId: authorization.webappId }
        );
        writeJSON(res, response.ok ? 200 : 400, response);
      } catch (error) {
        writeJSON(res, 400, fail("unknown", "invalid_request", error instanceof Error ? error.message : String(error)));
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/cdp/call") {
      if (!hasJsonContentType(req)) {
        writeJSON(res, 415, cdpFail("unknown", "unsupported_media_type", "Content-Type must be application/json."));
        return;
      }
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as DesktopCdpCallRequest;
        const response = await handleDesktopCdpRequest(options, parsed);
        writeJSON(res, response.ok ? 200 : 400, response);
      } catch (error) {
        writeJSON(res, 400, cdpFail("unknown", "invalid_request", error instanceof Error ? error.message : String(error)));
      }
      return;
    }

    writeJSON(res, 404, fail("unknown", "not_found", "Desktop Action Bridge route not found."));
  });

  server.listen(bridgePort, DESKTOP_ACTION_BRIDGE_HOST, () => {
    console.log(`[desktop-action-bridge] listening on ${DESKTOP_ACTION_BRIDGE_HOST}:${bridgePort}`);
  });
  server.on("error", (error) => {
    console.warn(`[desktop-action-bridge] failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  desktopActionServerState.activeServer = server;
  desktopActionServerState.activeServerPort = bridgePort;
  return server;
}

export function stopDesktopActionBridge() {
  const server = desktopActionServerState.activeServer;
  desktopActionServerState.activeServer = null;
  desktopActionServerState.activeServerPort = 0;
  server?.close();
}

export const __testInternals = {
  buildDesktopActionConfirmationDetail,
  buildMutatingActionConfirmationRequest,
  buildSensitiveReadConfirmationRequest,
  buildPageControlActionConfirmationRequest,
  normalizeActionResponseTimePayload,
  sanitizeConfirmationUrl,
  summarizeConfirmationArgs,
  fetchAgentPlatformWithAuth,
  clearWebappActionRateLimits: () => webappActionRateLimiter.clear()
};
