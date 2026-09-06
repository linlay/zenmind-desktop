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

import { DesktopActionBridgeOptions, DesktopActionInvocationContext, MAX_WEBAPP_CLIPBOARD_BYTES, MAX_WEBAPP_EXTERNAL_URL_CHARS, MAX_WEBAPP_NOTIFICATION_BODY_CHARS, MAX_WEBAPP_NOTIFICATION_TITLE_CHARS, WEBAPP_EXTERNAL_RATE_LIMIT, WEBAPP_NOTIFICATION_RATE_LIMIT, asRecord, fail, ok, readString, readWebappId, readWebsiteActionInput, readWebsiteId, webappActionRateLimiter } from "./runtime.part-1";

import { executeWebappRuntimeMutation, installFailureDetails, invalidWebappActionResult, notifyWebsChanged, openWebapp, projectWebappPublishFailureDetails, rejectUnexpectedArgs, sanitizeWebappDiagnosticValue, sanitizeWebappErrorText, trustedWebappWorkspaceSource, webappPreferenceFailureDetails, websiteRoute } from "./runtime.part-3";

export async function installWebapp(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest,
  invocation: DesktopActionInvocationContext,
  args: Record<string, unknown>,
) {
  const action = request.action;
  const directArchivePath = readString(args, "archivePath");
  const workspaceArchivePath = readString(args, "workspaceArchivePath");
  const hasDirectArchivePath = Object.hasOwn(args, "archivePath");
  const hasWorkspaceArchivePath = Object.hasOwn(args, "workspaceArchivePath");
  let archivePath = directArchivePath;
  let publicArchivePath = directArchivePath;
  let workspaceRootToRedact = "";
  const hasExpectedId = Object.hasOwn(args, "expectedId");
  const expectedId = hasExpectedId && typeof args.expectedId === "string" ? args.expectedId : "";
  if (Object.prototype.hasOwnProperty.call(args, "itemId")) {
    return fail(action, "invalid_args", "itemId is not supported; install market items with desktop.market.installItem.");
  }
  const invalid = rejectUnexpectedArgs(action, args, ["archivePath", "workspaceArchivePath", "expectedId"]);
  if (invalid) return invalid;
  if (invocation.kind === "agentPlatform") {
    if (!workspaceArchivePath || hasDirectArchivePath) {
      return fail(action, "invalid_args", "Agent Platform must provide workspaceArchivePath and cannot provide archivePath.");
    }
    const trusted = trustedWebappWorkspaceSource(action, request);
    if (!trusted.ok) return trusted.response;
    workspaceRootToRedact = trusted.workspaceRoot;
    try {
      const resolved = resolveExistingWorkspacePath(
        trusted.workspaceRoot,
        workspaceArchivePath,
        "file",
        "archive",
      );
      archivePath = resolved.absolutePath;
      publicArchivePath = resolved.relativePath;
    } catch (error) {
      if (error instanceof WebappToolingError) {
        return fail(action, error.code, sanitizeWebappErrorText(error.message), {
          stage: error.stage,
          ...sanitizeWebappDiagnosticValue(error.details) as Record<string, unknown>,
        });
      }
      return fail(action, "archive_unavailable", "Desktop could not resolve the workspace archive.", { stage: "archive" });
    }
  } else if (!archivePath || hasWorkspaceArchivePath) {
    return fail(action, "invalid_args", "archivePath is required; workspaceArchivePath is reserved for Agent Platform Runs.");
  }
  if (hasExpectedId && !WEBAPP_ID_PATTERN.test(expectedId)) {
    return fail(action, "invalid_args", "expectedId must already be a valid WebApp id; it is never normalized.");
  }
  const previousItemIds = new Set(
    listWebEntries(options.app, options.webs.webappManager).items
      .filter((item) => item.kind === "webapp")
      .map((item) => item.id)
  );
  const installOptions = { ...(expectedId ? { expectedId } : {}) };
  let installResult;
  try {
    installResult = await options.webs.webappManager.installArchive(options.app, archivePath, installOptions);
  } catch (error) {
    if (!(error instanceof WebappRuntimeRequiredError)) {
      const diagnostic = createWebappImportDiagnostic(error);
      const diagnosticRecord = asRecord(diagnostic.details);
      const relatedWebappId = readString(diagnosticRecord, "webappId") || readString(diagnosticRecord, "id") || expectedId;
      return fail(
        action,
        "webapp_install_failed",
        sanitizeWebappErrorText(diagnostic.message, workspaceRootToRedact),
        installFailureDetails({ archivePath: publicArchivePath, expectedId, webappId: relatedWebappId, diagnostic, workspaceRoot: workspaceRootToRedact })
      );
    }
    const dialogOptions: OpenDialogOptions = {
      title: `Select ${error.executable} executable for ${error.webappId}`,
      properties: ["openFile"]
    };
    const owner = options.getMainWindow();
    const selection = options.showFileDialog
      ? await options.showFileDialog(dialogOptions, owner)
      : owner && !owner.isDestroyed()
        ? await dialog.showOpenDialog(owner, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
    const executablePath = selection.canceled ? "" : String(selection.filePaths[0] || "").trim();
    if (!executablePath || !path.isAbsolute(executablePath)) {
      const diagnostic = createWebappImportDiagnostic(error);
      return fail(
        action,
        "webapp_install_failed",
        sanitizeWebappErrorText(error.message, workspaceRootToRedact),
        installFailureDetails({
          archivePath: publicArchivePath,
          expectedId,
          webappId: error.webappId,
          executable: error.executable,
          diagnostic,
          workspaceRoot: workspaceRootToRedact
        })
      );
    }
    options.webs.webappManager.bindRuntimeExecutable(
      options.app,
      error.webappId,
      error.executable,
      executablePath
    );
    try {
      installResult = await options.webs.webappManager.installArchive(options.app, archivePath, installOptions);
    } catch (retryError) {
      if (retryError instanceof WebappRuntimeRequiredError) {
        const diagnostic = createWebappImportDiagnostic(retryError);
        return fail(
          action,
          "webapp_install_failed",
          sanitizeWebappErrorText(retryError.message, workspaceRootToRedact),
          installFailureDetails({
            archivePath: publicArchivePath,
            expectedId,
            webappId: retryError.webappId,
            executable: retryError.executable,
            selectedPath: executablePath,
            diagnostic,
            workspaceRoot: workspaceRootToRedact
          })
        );
      }
      const diagnostic = createWebappImportDiagnostic(retryError);
      const diagnosticRecord = asRecord(diagnostic.details);
      const relatedWebappId = readString(diagnosticRecord, "webappId") || readString(diagnosticRecord, "id") || expectedId;
      return fail(
        action,
        "webapp_install_failed",
        sanitizeWebappErrorText(diagnostic.message, workspaceRootToRedact),
        installFailureDetails({
          archivePath: publicArchivePath,
          expectedId,
          webappId: relatedWebappId,
          selectedPath: executablePath,
          diagnostic,
          workspaceRoot: workspaceRootToRedact
        })
      );
    }
  }
  const webappId = typeof installResult.itemId === "string" ? installResult.itemId.trim() : "";
  if (!installResult.ok || !webappId) {
    const diagnostic = {
      stage: "install" as const,
      code: "install_failed",
      message: installResult.message || "WebApp installation failed.",
      details: {
        ...(webappId ? { webappId } : {}),
        ...(installResult.installPath ? { installPath: installResult.installPath } : {})
      }
    };
    return fail(
      action,
      "webapp_install_failed",
      sanitizeWebappErrorText(diagnostic.message, workspaceRootToRedact),
      installFailureDetails({
        archivePath: publicArchivePath,
        expectedId,
        webappId,
        installPath: installResult.installPath,
        diagnostic,
        workspaceRoot: workspaceRootToRedact
      })
    );
  }
  const installedItem = listWebEntries(options.app, options.webs.webappManager).items.find((item) =>
    item.kind === "webapp" && item.id === webappId
  );
  if (!installedItem) {
    return invalidWebappActionResult(action, webappId, "install", ["item"]);
  }
  notifyWebsChanged(options);
  const operation = previousItemIds.has(webappId) ? "updated" : "installed";
  options.emitWebappChanged?.(operation, webappId);
  return ok(action, {
    webappId,
    operation
  } satisfies DesktopWebappInstallResult);
}

export async function executeWebAction(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest,
  invocation: DesktopActionInvocationContext,
  args: Record<string, unknown>,
) {
  const action = request.action;
  if (action === "desktop.site.list") {
    return ok(action, listWebEntries(options.app, options.webs.webappManager));
  }
  if (action === "desktop.website.list") {
    return ok(action, listWebsiteItems(options.app));
  }
  if (action === "desktop.website.add") {
    const result = addWebsiteItem(options.app, readWebsiteActionInput(args) as any);
    if (!result.ok) {
      const issues = "issues" in result && Array.isArray(result.issues) ? result.issues : [];
      const details = issues.length
        ? { issues }
        : result.item?.id
          ? { websiteId: result.item.id }
          : undefined;
      return fail(action, "website_add_failed", result.message, details);
    }
    if (!result.item) {
      return fail(action, "invalid_action_result", "Website add succeeded without an item.");
    }
    return ok(action, { item: result.item } satisfies DesktopWebsiteItemResult);
  }
  if (action === "desktop.website.update") {
    const websiteId = readWebsiteId(args);
    const result = updateWebsiteItem(options.app, websiteId, readWebsiteActionInput(args) as any);
    if (!result.ok) {
      return fail(action, "website_update_failed", result.message, { websiteId });
    }
    if (!result.item) {
      return fail(action, "invalid_action_result", "Website update succeeded without an item.");
    }
    return ok(action, { item: result.item } satisfies DesktopWebsiteItemResult);
  }
  if (action === "desktop.website.remove") {
    const websiteId = readWebsiteId(args);
    const result = removeWebsiteItem(options.app, websiteId);
    if (!result.ok) {
      return fail(action, "website_remove_failed", result.message, { websiteId });
    }
    return ok(action, { websiteId } satisfies DesktopWebsiteRemoveResult);
  }
  if (action === "desktop.website.open") {
    const websiteId = readWebsiteId(args);
    const item = listWebsiteItems(options.app).items.find((entry) => entry.id === websiteId);
    if (!item) {
      return fail(action, "website_not_found", "The website entry was not found.");
    }
    const route = websiteRoute(websiteId);
    options.navigate(route);
    return ok(action, { item, route });
  }
  if (action === "desktop.webapp.getStatus") {
    return ok(action, options.webs.webappRuntime.getStatus(options.app, readWebappId(args)));
  }
  if (action === "desktop.webapp.checkRuntime") {
    const webappId = readWebappId(args);
    if (!options.webs.webappManager.list(options.app).some((item) => item.id === webappId)) {
      return fail(action, "webapp_not_found", t("webapp.notFound"), { webappId });
    }
    return ok(action, options.webs.webappRuntime.checkRuntime(options.app, webappId));
  }
  if (action === "desktop.webapp.start") {
    const webappId = readWebappId(args);
    return executeWebappRuntimeMutation(options, action, webappId, "start");
  }
  if (action === "desktop.webapp.stop") {
    const webappId = readWebappId(args);
    return executeWebappRuntimeMutation(options, action, webappId, "stop");
  }
  if (action === "desktop.webapp.restart") {
    const webappId = readWebappId(args);
    return executeWebappRuntimeMutation(options, action, webappId, "restart");
  }
  if (action === "desktop.webapp.open") {
    return openWebapp(options, action, readWebappId(args));
  }
  if (action === "desktop.webapp.updatePreferences") {
    const webappId = readWebappId(args);
    const patch = asRecord(args.patch ?? args.input ?? args);
    const result = options.webs.webappManager.update(options.app, webappId, {
      ...(typeof patch.label === "string" ? { label: patch.label } : {}),
      ...(patch.openMode === "workspace" || patch.openMode === "dialog" ? { openMode: patch.openMode } : {})
    });
    if (result.ok) {
      notifyWebsChanged(options);
      options.emitWebappChanged?.("updated", webappId);
    }
    if (!result.ok) {
      return fail(
        action,
        "webapp_update_failed",
        sanitizeWebappErrorText(result.message),
        webappPreferenceFailureDetails(webappId, result.item)
      );
    }
    if (!result.item || result.item.id !== webappId) {
      return invalidWebappActionResult(action, webappId, "update", ["item"]);
    }
    return ok(action, {
      webappId,
      label: result.item.label,
      openMode: result.item.openMode
    } satisfies DesktopWebappPreferenceResult);
  }
  if (action === "desktop.webapp.getPublishStatus") {
    const webappId = readWebappId(args);
    if (!options.webs.webappManager.list(options.app).some((item) => item.id === webappId)) {
      return fail(action, "webapp_not_found", t("webapp.notFound"), { webappId });
    }
    return ok(action, await options.webs.getWebappPublishStatus(options.app, webappId));
  }
  if (action === "desktop.webapp.publish") {
    const webappId = readWebappId(args);
    const runtimeState = options.webs.webappRuntime.getStatus(options.app, webappId);
    const result = await (options.publishWebapp ?? options.webs.publishWebapp)(options.app, webappId, runtimeState);
    options.emitWebappChanged?.(result.ok ? "published" : "publish-failed", webappId);
    if (!result.ok) {
      return fail(
        action,
        "webapp_publish_failed",
        sanitizeWebappErrorText(result.message),
        projectWebappPublishFailureDetails(webappId, "publish", result)
      );
    }
    if (result.state.id !== webappId || !result.state.status || !result.state.url) {
      return invalidWebappActionResult(
        action,
        webappId,
        "publish",
        [
          ...(result.state.id !== webappId ? ["state.id"] : []),
          ...(!result.state.status ? ["state.status"] : []),
          ...(!result.state.url ? ["state.url"] : [])
        ]
      );
    }
    return ok(action, {
      webappId,
      status: result.state.status,
      publicUrl: result.state.url
    } satisfies DesktopWebappPublishResult);
  }
  if (action === "desktop.webapp.unpublish") {
    const webappId = readWebappId(args);
    const result = await (options.unpublishWebapp ?? options.webs.unpublishWebapp)(options.app, webappId);
    options.emitWebappChanged?.(result.ok ? "unpublished" : "publish-failed", webappId);
    if (!result.ok) {
      return fail(
        action,
        "webapp_unpublish_failed",
        sanitizeWebappErrorText(result.message),
        projectWebappPublishFailureDetails(webappId, "unpublish", result)
      );
    }
    if (result.state.id !== webappId || !result.state.status) {
      return invalidWebappActionResult(
        action,
        webappId,
        "unpublish",
        [
          ...(result.state.id !== webappId ? ["state.id"] : []),
          ...(!result.state.status ? ["state.status"] : [])
        ]
      );
    }
    return ok(action, {
      webappId,
      status: result.state.status
    } satisfies DesktopWebappUnpublishResult);
  }
  if (action === "desktop.webapp.install") {
    return installWebapp(options, request, invocation, args);
  }
  if (action === "desktop.webapp.uninstall") {
    const webappId = readWebappId(args);
    const result = await options.webs.webappManager.remove(options.app, webappId);
    if (!result.ok) {
      return fail(
        action,
        "webapp_uninstall_failed",
        sanitizeWebappErrorText(result.message),
        webappPreferenceFailureDetails(webappId, result.item)
      );
    }
    if (!result.item || result.item.id !== webappId) {
      return invalidWebappActionResult(action, webappId, "uninstall", ["item"]);
    }
    notifyWebsChanged(options);
    return ok(action, { webappId } satisfies DesktopWebappUninstallResult);
  }
  return fail(action, "unknown_action", `unknown WebApp action: ${action}`);
}

export function webappPathResult(selectedPath: string) {
  return {
    path: selectedPath,
    name: path.basename(selectedPath) || selectedPath
  };
}

export function readWebappDialogFilters(value: unknown) {
  if (value === undefined) {
    return { ok: true as const, filters: undefined };
  }
  if (!Array.isArray(value) || value.length > 10) {
    return { ok: false as const, message: "filters must be an array with at most 10 items." };
  }
  const filters: NonNullable<OpenDialogOptions["filters"]> = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const name = readString(record, "name");
    const extensions = Array.isArray(record.extensions)
      ? record.extensions.map((extension) => typeof extension === "string" ? extension.trim() : "")
      : [];
    if (
      !name ||
      name.length > 80 ||
      extensions.length === 0 ||
      extensions.length > 20 ||
      extensions.some((extension) => !/^[A-Za-z0-9*][A-Za-z0-9._+-]{0,31}$/u.test(extension))
    ) {
      return { ok: false as const, message: "each filter requires a name and 1-20 safe extensions." };
    }
    filters.push({ name, extensions });
  }
  return { ok: true as const, filters };
}

export function normalizeMicrophonePermission(value: string): WebappBridgePermissionStatus {
  if (value === "granted") return "granted";
  if (value === "denied") return "denied";
  if (value === "restricted") return "restricted";
  if (value === "not-determined" || value === "unknown") return "prompt";
  return "unavailable";
}

export function getMicrophonePermission(options: DesktopActionBridgeOptions) {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    return "unavailable" as const;
  }
  try {
    const raw = options.getMicrophonePermission
      ? options.getMicrophonePermission()
      : systemPreferences.getMediaAccessStatus("microphone");
    return normalizeMicrophonePermission(raw);
  } catch {
    return "unavailable" as const;
  }
}

export function getWebappBridgeCapabilities(
  options: DesktopActionBridgeOptions,
  webappId: string
): WebappBridgeCapabilitiesResult | null {
  const item = options.webs.webappManager.list(options.app)
    .find((candidate) => candidate.id === webappId) ?? null;
  if (!item || item.schemaVersion !== 2) {
    return null;
  }
  const microphonePermission = getMicrophonePermission(options);
  const notificationAvailable = options.showNotification ? true : Notification.isSupported();
  return {
    bridgeVersion: WEBAPP_BRIDGE_VERSION,
    capabilities: [
      ...WEBAPP_BRIDGE_AVAILABLE_CAPABILITIES.map((id) => {
        const status = id === "native.microphone" && microphonePermission === "unavailable"
          ? "unavailable" as const
          : id === "native.notification" && !notificationAvailable
            ? "unavailable" as const
            : "available" as const;
        return {
          id,
          status,
          declared: true,
          permission: id === "native.microphone"
            ? microphonePermission
            : id === "native.notification" && !notificationAvailable
              ? "unavailable" as const
              : "not_required" as const
        };
      }),
      ...WEBAPP_BRIDGE_RESERVED_CAPABILITIES.map((id) => ({
        id,
        status: "reserved" as const,
        declared: false,
        permission: "unavailable" as const
      }))
    ]
  };
}

export function getWebappDialogOwner(options: DesktopActionBridgeOptions, webappId: string) {
  return options.webs.webappWindowManager.getWindow(webappId) ?? options.getMainWindow();
}

export async function executeNativeWebappAction(
  options: DesktopActionBridgeOptions,
  action: string,
  args: Record<string, unknown>,
  webappId: string
): Promise<DesktopActionCallResponse> {
  if (action === "desktop.capabilities.list") {
    const result = getWebappBridgeCapabilities(options, webappId);
    return result
      ? ok(action, result)
      : fail(action, "unsupported_schema", "Desktop Bridge v1 requires WebApp manifest schema v2.");
  }

  const owner = getWebappDialogOwner(options, webappId);
  if (action === "desktop.native.browser.openExternal") {
    const rawUrl = readString(args, "url");
    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      return fail(action, "invalid_args", "url must be a valid HTTP(S) URL.");
    }
    if (
      !rawUrl ||
      rawUrl.length > MAX_WEBAPP_EXTERNAL_URL_CHARS ||
      (target.protocol !== "http:" && target.protocol !== "https:")
    ) {
      return fail(action, "invalid_args", "url must be an HTTP(S) URL with at most 8192 characters.");
    }
    if (!webappActionRateLimiter.take(`${webappId}:openExternal`, WEBAPP_EXTERNAL_RATE_LIMIT)) {
      return fail(action, "rate_limited", "The WebApp opened too many external URLs.");
    }
    await (options.openExternal ?? shell.openExternal)(target.toString());
    return ok(action, { opened: true, url: target.toString() });
  }

  if (action === "desktop.native.dialog.selectFiles") {
    const parsedFilters = readWebappDialogFilters(args.filters);
    if (!parsedFilters.ok) return fail(action, "invalid_args", parsedFilters.message);
    const dialogOptions: OpenDialogOptions = {
      title: "Select files",
      properties: args.multiple === true ? ["openFile", "multiSelections"] : ["openFile"],
      ...(parsedFilters.filters ? { filters: parsedFilters.filters } : {})
    };
    const result = options.showFileDialog
      ? await options.showFileDialog(dialogOptions, owner)
      : owner && !owner.isDestroyed()
        ? await dialog.showOpenDialog(owner, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
    return ok(action, {
      canceled: result.canceled,
      files: result.canceled ? [] : result.filePaths.map(webappPathResult)
    });
  }

  if (action === "desktop.native.dialog.selectDirectory") {
    const dialogOptions: OpenDialogOptions = {
      title: "Select directory",
      defaultPath: options.app.getPath("documents"),
      properties: ["openDirectory", "createDirectory"]
    };
    const result = options.showFileDialog
      ? await options.showFileDialog(dialogOptions, owner)
      : owner && !owner.isDestroyed()
        ? await dialog.showOpenDialog(owner, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
    const selectedPath = result.canceled ? "" : String(result.filePaths[0] || "").trim();
    return ok(action, selectedPath
      ? { canceled: false, ...webappPathResult(selectedPath) }
      : { canceled: true });
  }

  if (action === "desktop.native.dialog.selectSavePath") {
    const parsedFilters = readWebappDialogFilters(args.filters);
    if (!parsedFilters.ok) return fail(action, "invalid_args", parsedFilters.message);
    const suggestedName = readString(args, "suggestedName");
    if (suggestedName.length > 255 || (suggestedName && path.basename(suggestedName) !== suggestedName)) {
      return fail(action, "invalid_args", "suggestedName must be a filename with at most 255 characters.");
    }
    const dialogOptions: SaveDialogOptions = {
      title: "Select save path",
      ...(suggestedName ? { defaultPath: path.join(options.app.getPath("documents"), suggestedName) } : {}),
      ...(parsedFilters.filters ? { filters: parsedFilters.filters } : {})
    };
    const result = options.showSaveDialog
      ? await options.showSaveDialog(dialogOptions, owner)
      : owner && !owner.isDestroyed()
        ? await dialog.showSaveDialog(owner, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);
    const selectedPath = result.canceled ? "" : String(result.filePath || "").trim();
    return ok(action, selectedPath
      ? { canceled: false, ...webappPathResult(selectedPath) }
      : { canceled: true });
  }

  if (action === "desktop.native.microphone.getPermission") {
    return ok(action, { permission: getMicrophonePermission(options) });
  }

  if (action === "desktop.native.microphone.requestAccess") {
    if (process.platform === "darwin") {
      const granted = await (options.requestMicrophoneAccess
        ? options.requestMicrophoneAccess()
        : systemPreferences.askForMediaAccess("microphone"));
      return granted
        ? ok(action, { permission: "granted" })
        : fail(action, "permission_denied", "Microphone permission was denied.", { permission: "denied" });
    }
    if (process.platform === "win32") {
      const permission = getMicrophonePermission(options);
      return permission === "denied" || permission === "restricted"
        ? fail(action, "permission_denied", "Microphone permission is unavailable.", { permission })
        : ok(action, { permission });
    }
    return fail(action, "unsupported_platform", "Microphone access is unavailable on this platform.");
  }

  if (action === "desktop.native.clipboard.writeText") {
    const text = typeof args.text === "string" ? args.text : "";
    if (Buffer.byteLength(text, "utf8") > MAX_WEBAPP_CLIPBOARD_BYTES) {
      return fail(action, "invalid_args", "text must be at most 1 MiB when encoded as UTF-8.");
    }
    (options.writeClipboardText ?? ((value: string) => clipboard.writeText(value)))(text);
    return ok(action, { written: true });
  }

  if (action === "desktop.native.notification.show") {
    const title = readString(args, "title");
    const body = typeof args.body === "string" ? args.body.trim() : "";
    if (!title || title.length > MAX_WEBAPP_NOTIFICATION_TITLE_CHARS || body.length > MAX_WEBAPP_NOTIFICATION_BODY_CHARS) {
      return fail(action, "invalid_args", "title is required (max 120 characters); body is limited to 1000 characters.");
    }
    if (!webappActionRateLimiter.take(`${webappId}:notification`, WEBAPP_NOTIFICATION_RATE_LIMIT)) {
      return fail(action, "rate_limited", "The WebApp showed too many notifications.");
    }
    const focus = () => options.webs.webappWindowManager.focus(webappId, options.getMainWindow());
    const shown = options.showNotification
      ? options.showNotification({ title, body, onClick: focus })
      : Notification.isSupported()
        ? (() => {
            const notification = new Notification({ title, body });
            notification.once("click", focus);
            notification.show();
            return true;
          })()
        : false;
    return shown
      ? ok(action, { shown: true })
      : fail(action, "unavailable", "System notifications are unavailable.");
  }

  return fail(action, "unknown_action", `unknown WebApp native action: ${action}`);
}
