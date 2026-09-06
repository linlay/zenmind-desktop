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

import { DESKTOP_WEB_EXPORT_FORMATS, DESKTOP_WEB_EXPORT_MAX_BYTES, DESKTOP_WEB_EXPORT_PROVIDER_VERSION, DESKTOP_WEB_EXPORT_SPEC, DesktopActionBridgeOptions, DesktopWebExportFormat, asRecord, fail, ok, readKanbanInput, readKanbanIssueId, readKanbanMoveInput, readString } from "./runtime.part-1";

import { callRendererAction } from "./runtime.part-3";

export async function executeKanbanAction(options: DesktopActionBridgeOptions, action: string, args: Record<string, unknown>) {
  const runtime = options.getKanbanRuntime?.() ?? null;
  if (!runtime) {
    return fail(action, "kanban_unavailable", "Kanban runtime is not initialized.");
  }
  if (action === "desktop.kanban.listIssues") {
    return ok(action, runtime.listIssues());
  }
  if (action === "desktop.kanban.getIssue") {
    const id = readKanbanIssueId(args);
    if (!id) {
      return fail(action, "invalid_args", "id is required.");
    }
    const list = runtime.listIssues();
    const issue = list.issues.find((candidate) => candidate.id === id);
    return issue
      ? ok(action, { issue } satisfies DesktopKanbanIssueResult)
      : fail(action, "not_found", `Kanban issue not found: ${id}`, { issueId: id });
  }
  if (action === "desktop.kanban.createIssue") {
    const input = readKanbanInput(args);
    if (!input) {
      return fail(action, "invalid_args", "input object is required.");
    }
    const result = await runtime.createIssue(input as unknown as KanbanIssueInput);
    if (!result.ok) {
      return fail(action, "kanban_create_failed", result.message);
    }
    if (!result.issue) {
      return fail(action, "invalid_action_result", "Kanban create succeeded without an issue.");
    }
    return ok(action, { issue: result.issue } satisfies DesktopKanbanIssueResult);
  }
  if (action === "desktop.kanban.updateIssue") {
    const id = readKanbanIssueId(args);
    const input = readKanbanInput(args);
    if (!id || !input) {
      return fail(action, "invalid_args", "id and input object are required.");
    }
    const result = await runtime.updateIssue(id, input as unknown as KanbanIssueUpdateInput);
    if (!result.ok) {
      return fail(action, "kanban_update_failed", result.message, { issueId: id });
    }
    if (!result.issue) {
      return fail(action, "invalid_action_result", "Kanban update succeeded without an issue.");
    }
    return ok(action, { issue: result.issue } satisfies DesktopKanbanIssueResult);
  }
  if (action === "desktop.kanban.deleteIssue") {
    const id = readKanbanIssueId(args);
    if (!id) {
      return fail(action, "invalid_args", "id is required.");
    }
    const result = await runtime.deleteIssueWithAutomation(id);
    if (!result.ok) {
      return fail(action, "kanban_delete_failed", result.message, { issueId: id });
    }
    if (!result.deletedIssueId) {
      return fail(action, "invalid_action_result", "Kanban delete succeeded without a deletedIssueId.");
    }
    return ok(action, { deletedIssueId: result.deletedIssueId } satisfies DesktopKanbanDeleteResult);
  }
  const input = readKanbanMoveInput(args);
  if (!input) {
    return fail(action, "invalid_args", "id, status, and numeric position are required.");
  }
  const result = await runtime.moveIssue(input);
  if (!result.ok) {
    return fail(action, "kanban_move_failed", result.message, { issueId: input.id });
  }
  if (!result.issue) {
    return fail(action, "invalid_action_result", "Kanban move succeeded without an issue.");
  }
  return ok(action, { issue: result.issue } satisfies DesktopKanbanIssueResult);
}

export async function executePetAction(options: DesktopActionBridgeOptions, action: string, args: Record<string, unknown>) {
  const desktopPet = options.desktopPet;
  if (!desktopPet) {
    return fail(action, "pet_action_unavailable", "Desktop pet action is unavailable.");
  }
  const state = await desktopPet.refreshState();
  if (action === "desktop.pet.state") {
    return ok(action, {
      supported: state.supported,
      enabled: state.enabled,
      appearanceId: state.appearanceId
    } satisfies DesktopPetStateResult);
  }
  if (action === "desktop.pet.list") {
    return ok(action, {
      appearanceId: state.appearanceId,
      appearances: state.appearanceOptions.map(({ id, displayName, description }) => ({
        id,
        displayName,
        description
      }))
    } satisfies DesktopPetListResult);
  }
  if (action === "desktop.pet.show") {
    if (!state.supported) {
      return fail(action, "pet_unsupported", t("settings.desktopPet.enableUnavailable"));
    }
    const nextState = await desktopPet.show();
    if (!nextState.enabled) {
      return fail(action, "pet_enable_failed", "Desktop pet could not be shown.");
    }
    return ok(action, { enabled: nextState.enabled } satisfies DesktopPetVisibilityResult);
  }
  if (action === "desktop.pet.hide") {
    const nextState = await desktopPet.hide();
    return ok(action, { enabled: nextState.enabled } satisfies DesktopPetVisibilityResult);
  }
  if (action !== "desktop.pet.set") {
    return fail(action, "unknown_action", `unknown action: ${action}`);
  }
  const appearanceId = readString(args, "appearanceId") || readString(args, "id");
  if (!appearanceId) {
    return fail(action, "invalid_args", "id or appearanceId is required.");
  }
  if (!state.supported) {
    return fail(action, "pet_unsupported", t("settings.desktopPet.enableUnavailable"));
  }
  const appearance = state.appearanceOptions.find((candidate) => candidate.id === appearanceId);
  if (!appearance) {
    return fail(action, "pet_appearance_not_found", t("settings.desktopPet.enableUnavailable"), {
      appearanceId
    });
  }
  const nextState = await desktopPet.saveSettings({ appearanceId });
  return ok(action, { appearanceId: nextState.appearanceId } satisfies DesktopPetSetResult);
}

export type DesktopExportWebContents = Pick<
  WebContents,
  "executeJavaScript" | "isDestroyed" | "printToPDF"
>;

export type DesktopExportProviderDescription = {
  formats?: unknown;
  suggestedFilenames?: unknown;
};

export function isDesktopWebExportFormat(value: string): value is DesktopWebExportFormat {
  return (DESKTOP_WEB_EXPORT_FORMATS as readonly string[]).includes(value);
}

export function hasUnpairedUtf16Surrogate(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function decodeStrictBase64(value: string) {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    return null;
  }
  const buffer = Buffer.from(value, "base64");
  return value.replace(/=+$/u, "") === buffer.toString("base64").replace(/=+$/u, "")
    ? buffer
    : null;
}

export function validateExportFilename(value: unknown, extension: string) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 240 ||
    /[\\/\u0000-\u001f]/u.test(value) ||
    !value.toLowerCase().endsWith(extension)
  ) {
    return "";
  }
  return value.trim();
}

export function resolveCurrentRootWebapp(
  options: DesktopActionBridgeOptions
): { snapshot: DesktopPageContextSnapshot; contents: DesktopExportWebContents } | null {
  const snapshot = options.getCurrentPageSnapshot();
  if (
    !snapshot ||
    snapshot.pageKind !== "webview" ||
    typeof snapshot.webContentsId !== "number" ||
    !snapshot.surfaceId?.startsWith("app:") ||
    !snapshot.surfaceRoute?.startsWith("/webs/webapp:")
  ) {
    return null;
  }
  const contents = options.getWebContentsById?.(snapshot.webContentsId) ??
    webContents?.fromId(snapshot.webContentsId) ?? null;
  if (!contents || contents.isDestroyed()) {
    return null;
  }
  return { snapshot, contents };
}

export async function readDesktopExportProvider(
  contents: DesktopExportWebContents
): Promise<
  | { status: "ok"; description: DesktopExportProviderDescription }
  | { status: "unavailable" }
  | { status: "render_failed" }
> {
  try {
    const result = await contents.executeJavaScript(`(async () => {
      const provider = globalThis.__DESKTOP_WEBAPP_EXPORT__;
      if (!provider || provider.version !== ${DESKTOP_WEB_EXPORT_PROVIDER_VERSION} || typeof provider.describe !== "function" || typeof provider.create !== "function") {
        return { status: "unavailable" };
      }
      try {
        return { status: "ok", description: await provider.describe() };
      } catch {
        return { status: "render_failed" };
      }
    })()`, true) as unknown;
    const record = asRecord(result);
    if (record.status === "ok") {
      return { status: "ok", description: asRecord(record.description) };
    }
    return { status: record.status === "render_failed" ? "render_failed" : "unavailable" };
  } catch {
    return { status: "render_failed" };
  }
}

export async function createDesktopExportPayload(
  contents: DesktopExportWebContents,
  format: Exclude<DesktopWebExportFormat, "pdf">
) {
  try {
    return await contents.executeJavaScript(`(async () => {
      const provider = globalThis.__DESKTOP_WEBAPP_EXPORT__;
      if (!provider || provider.version !== ${DESKTOP_WEB_EXPORT_PROVIDER_VERSION} || typeof provider.create !== "function") {
        return { status: "unavailable" };
      }
      try {
        return { status: "ok", payload: await provider.create({ format: ${JSON.stringify(format)} }) };
      } catch {
        return { status: "render_failed" };
      }
    })()`, true) as unknown;
  } catch {
    return { status: "render_failed" };
  }
}

export async function writeDesktopExportFile(
  options: DesktopActionBridgeOptions,
  filename: string,
  data: Buffer
) {
  const platform = options.platform ?? process.platform;
  const defaultPath = getDesktopDownloadDefaultPath(options.app, filename, platform);
  const filePath = await getAvailableFilePath(defaultPath, { platform });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(temporaryPath, data, { flag: "wx" });
    await fs.promises.rename(temporaryPath, filePath);
    return filePath;
  } catch (error) {
    await fs.promises.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function executeDesktopWebExportArtifact(
  options: DesktopActionBridgeOptions,
  action: string,
  args: Record<string, unknown>
): Promise<DesktopActionCallResponse> {
  const format = readString(args, "format").toLowerCase();
  if (!isDesktopWebExportFormat(format)) {
    return fail(action, "export_format_unsupported", "format must be png, html, project, or pdf.");
  }
  const target = resolveCurrentRootWebapp(options);
  if (!target) {
    return fail(action, "current_webapp_required", "The current active root surface must be a WebApp.");
  }
  const provider = await readDesktopExportProvider(target.contents);
  if (provider.status === "unavailable") {
    return fail(action, "export_provider_unavailable", "The current WebApp does not expose export provider v1.");
  }
  if (provider.status === "render_failed") {
    return fail(action, "export_render_failed", "The WebApp export provider could not be inspected.");
  }
  const formats = Array.isArray(provider.description.formats)
    ? provider.description.formats.filter((value): value is string => typeof value === "string")
    : [];
  if (!formats.includes(format)) {
    return fail(action, "export_format_unsupported", `The current WebApp does not support ${format} export.`);
  }

  const spec = DESKTOP_WEB_EXPORT_SPEC[format];
  let filename = "";
  let data: Buffer | null = null;
  if (format === "pdf") {
    const suggestedFilenames = asRecord(provider.description.suggestedFilenames);
    filename = validateExportFilename(suggestedFilenames.pdf, spec.extension) || "poster.pdf";
    try {
      data = await target.contents.printToPDF({
        pageSize: "A4",
        printBackground: true,
        preferCSSPageSize: true
      });
    } catch {
      return fail(action, "export_render_failed", "Desktop could not render the WebApp as PDF.");
    }
  } else {
    const generated = asRecord(await createDesktopExportPayload(target.contents, format));
    if (generated.status === "unavailable") {
      return fail(action, "export_provider_unavailable", "The current WebApp export provider became unavailable.");
    }
    if (generated.status !== "ok") {
      return fail(action, "export_render_failed", `The WebApp could not render ${format}.`);
    }
    const payload = asRecord(generated.payload);
    filename = validateExportFilename(payload.filename, spec.extension);
    if (
      !filename ||
      payload.mimeType !== spec.mimeType ||
      payload.encoding !== spec.encoding ||
      typeof payload.data !== "string"
    ) {
      return fail(action, "export_payload_invalid", "The WebApp returned an invalid export payload.");
    }
    if (spec.encoding === "base64") {
      data = decodeStrictBase64(payload.data);
    } else if (!hasUnpairedUtf16Surrogate(payload.data)) {
      data = Buffer.from(payload.data, "utf8");
    }
    if (!data) {
      return fail(action, "export_payload_invalid", "The WebApp returned malformed export data.");
    }
  }
  if (!data || data.byteLength === 0) {
    return fail(action, "export_payload_invalid", "The rendered export is empty.");
  }
  if (data.byteLength > DESKTOP_WEB_EXPORT_MAX_BYTES) {
    return fail(action, "export_too_large", "The rendered export exceeds the 32 MiB limit.", {
      sizeBytes: data.byteLength,
      maxBytes: DESKTOP_WEB_EXPORT_MAX_BYTES
    });
  }

  const safeFilename = sanitizeDownloadFilename(filename, `poster${spec.extension}`);
  try {
    const filePath = await writeDesktopExportFile(options, safeFilename, data);
    return ok(action, {
      surfaceId: target.snapshot.surfaceId!,
      format,
      filePath,
      filename: path.basename(filePath),
      mimeType: spec.mimeType,
      sizeBytes: data.byteLength
    } satisfies DesktopWebExportArtifactResult);
  } catch {
    return fail(action, "export_write_failed", "Desktop could not write the export to Downloads.");
  }
}

export function validateOpenLocalFileArgs(
  args: Record<string, unknown>,
): { ok: true; path: string; title: string } | { ok: false; response: DesktopActionCallResponse } {
  const action = "desktop.workpanel.openLocalFile";
  const rejectedKeys = Object.keys(args).filter((key) => key !== "path" && key !== "title");
  if (rejectedKeys.length > 0) {
    return {
      ok: false,
      response: fail(action, "invalid_args", `openLocalFile does not accept: ${rejectedKeys.join(", ")}.`),
    };
  }
  const requestedPath = typeof args.path === "string" ? args.path : "";
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (args.title !== undefined && (typeof args.title !== "string" || title.length > 160)) {
    return {
      ok: false,
      response: fail(action, "invalid_args", "title must be a string of at most 160 characters."),
    };
  }
  return { ok: true, path: requestedPath, title };
}

export async function executeOpenLocalFileAction(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest,
  args: Record<string, unknown>,
): Promise<DesktopActionCallResponse> {
  const action = "desktop.workpanel.openLocalFile";
  const validated = validateOpenLocalFileArgs(args);
  if (!validated.ok) return validated.response;
  const source = request.source;
  const runId = source?.runId?.trim() || "";
  const ownerChatId = source?.chatId?.trim() || "";
  const agentKey = source?.agentKey?.trim() || "";
  if (!runId || !ownerChatId || !agentKey || source?.teamId) {
    return fail(action, "forbidden", "openLocalFile requires a trusted Agent-owned Platform Run.");
  }

  let workspaceResolution: WorkPanelLocalFilePathResolution;
  try {
    const navigation = await options.assistantBridge.listNavigationAgents();
    const agent = navigation.ok
      ? navigation.items.find((candidate) => candidate.agentKey === agentKey)
      : null;
    const workspaceDir = agent?.workspaceDir?.trim() || "";
    if (!workspaceDir || workspaceDir === "@chat" || agent?.workspaceDirExists === false) {
      return fail(action, "workspace_unavailable", "The Agent workspace is unavailable on this Desktop.");
    }
    workspaceResolution = resolveWorkPanelLocalFileFromWorkspace(
      workspaceDir,
      validated.path,
      options.platform ?? process.platform,
    );
  } catch {
    return fail(action, "workspace_unavailable", "Desktop could not resolve the Agent workspace.");
  }
  if (!workspaceResolution.ok) {
    return fail(action, workspaceResolution.code, workspaceResolution.message);
  }

  const mainWindow = options.getMainWindow();
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    mainWindow.webContents.isDestroyed() ||
    !options.prepareWorkPanelLocalFileClaim ||
    !options.discardWorkPanelLocalFileClaim
  ) {
    return fail(action, "target_unavailable", "The Desktop WorkPanel renderer is unavailable.");
  }
  const prepared = options.prepareWorkPanelLocalFileClaim({
    ownerChatId,
    rendererWebContentsId: mainWindow.webContents.id,
    filePath: workspaceResolution.filePath,
    workspaceRelativePath: workspaceResolution.relativePath,
  });
  if (!prepared) {
    return fail(action, "file_unavailable", "The requested local file became unavailable.");
  }
  try {
    return await callRendererAction(options, request, {
      claimId: prepared.claimId,
      ...(validated.title ? { title: validated.title } : {}),
    });
  } finally {
    options.discardWorkPanelLocalFileClaim(prepared.claimId);
  }
}
