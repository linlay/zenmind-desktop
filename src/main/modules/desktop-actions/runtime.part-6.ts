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

import { AGENT_PLATFORM_CONFIRMATION_EXEMPT_ACTIONS, AGENT_PLATFORM_ONLY_ACTIONS, AGENT_WEBCLIENT_WORKPANEL_ACTIONS, AGENT_WEBCLIENT_WORKPANEL_DESKTOP_ACTIONS, ARGUMENT_FREE_RUNTIME_ACTIONS, AgentWebclientWorkPanelAction, CURRENT_PAGE_WEB_ACTIONS, DesktopActionBridgeOptions, DesktopActionInvocationContext, MAX_ASSISTANT_PROMPT_CHARS, WEBAPP_IMAGE_MASK_REQUIRED, WEBAPP_PAGE_ONLY_ACTIONS, activeWebappImageRuns, asRecord, fail, normalizeWebappImageRequest, ok, preview, readItemId, readMarketListOptions, readServiceId, readString, resolveHelpOpenRoute, saveMarketSettingsPreview, validateMarketSettings, webappImageRunKey } from "./runtime.part-1";

import { callAgentPlatform, confirmDesktopActionIfNeeded } from "./runtime.part-2";

import { callRendererAction, executeWebappToolingAction } from "./runtime.part-3";

import { executeNativeWebappAction, executeWebAction } from "./runtime.part-4";

import { executeDesktopWebExportArtifact, executeKanbanAction, executeOpenLocalFileAction, executePetAction } from "./runtime.part-5";

export async function executeAction(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest,
  invocation: DesktopActionInvocationContext
): Promise<DesktopActionCallResponse> {
  const action = request.action;
  const args = asRecord(request.args);

  if (
    action === "desktop.runtime.diagnostics" &&
    (invocation.kind === "webappPage" || invocation.kind === "webappBackend")
  ) {
    return fail(action, "forbidden", "Runtime diagnostics are unavailable to WebApp pages and backends.");
  }

  if (WEBAPP_PAGE_ONLY_ACTIONS.has(action)) {
    return invocation.kind === "webappPage"
      ? executeNativeWebappAction(options, action, args, invocation.webappId)
      : fail(action, "forbidden", "This native action is available only to an authorized local WebApp page.");
  }

  if (action === "desktop.display") {
    const targetWindow = options.getMainWindow();
    const hidden = targetWindow && typeof targetWindow.isVisible === "function"
      ? !targetWindow.isVisible()
      : false;
    const minimized = targetWindow && typeof targetWindow.isMinimized === "function"
      ? targetWindow.isMinimized()
      : false;
    if (!targetWindow || targetWindow.isDestroyed() || hidden || minimized) {
      return fail(
        action,
        "display_target_unavailable",
        t("desktopDisplay.targetUnavailable")
      );
    }
  }

  switch (action) {
    case "desktop.assistant.image.cancel": {
      if (invocation.kind !== "webappPage") {
        return fail(action, "forbidden", "Image cancellation is available only to an authorized local WebApp page.");
      }
      const requestId = readString(args, "requestId");
      if (!/^[A-Za-z0-9_-]{8,128}$/u.test(requestId) || Object.keys(args).some((key) => key !== "requestId")) {
        return fail(action, "invalid_args", "requestId is invalid");
      }
      const key = webappImageRunKey(invocation.webappId, requestId);
      const runId = activeWebappImageRuns.get(key);
      if (!runId) {
        return ok(action, { requestId, cancelled: false });
      }
      const stopped = await options.assistantBridge.stopRun(runId);
      return stopped.ok
        ? ok(action, { requestId, cancelled: true })
        : fail(action, "assistant_cancel_failed", stopped.message);
    }
    case "desktop.assistant.image": {
      if (invocation.kind !== "webappPage") {
        return fail(action, "forbidden", "Image generation is available only to an authorized local WebApp page.");
      }
      let normalized: ReturnType<typeof normalizeWebappImageRequest>;
      try {
        normalized = normalizeWebappImageRequest(args);
      } catch (error) {
        return fail(action, "invalid_args", error instanceof Error ? error.message : "image request is invalid");
      }
      const key = webappImageRunKey(invocation.webappId, normalized.requestId);
      if (activeWebappImageRuns.has(key)) {
        return fail(action, "request_conflict", "an image request with this requestId is already running");
      }
      const upload = normalized.uploadId
        ? consumeWebappImageUpload(invocation.webappId, normalized.uploadId)
        : null;
      if (normalized.operation !== "generate" && !upload?.source) {
        return fail(action, "image_upload_missing", "source image upload is missing or expired");
      }
      if (WEBAPP_IMAGE_MASK_REQUIRED.has(normalized.operation) && !upload?.mask) {
        return fail(action, "selection_required", "this image operation requires a selection mask");
      }
      const attachments: AssistantAttachment[] = [];
      if (upload?.source) {
        const extension = upload.source.mimeType === "image/jpeg" ? "jpg" :
          upload.source.mimeType === "image/webp" ? "webp" : "png";
        attachments.push({
          id: "image-studio-source",
          name: `image-studio-source.${extension}`,
          mimeType: upload.source.mimeType,
          sizeBytes: upload.source.bytes.length,
          text: "",
          dataUrl: `data:${upload.source.mimeType};base64,${upload.source.bytes.toString("base64")}`,
          kind: "input",
          document: { format: "image", readStatus: "readable", extractedChars: 0, truncated: false, imageMode: "vision" }
        });
      }
      if (upload?.mask) {
        attachments.push({
          id: "image-studio-mask",
          name: "image-studio-mask.png",
          mimeType: "image/png",
          sizeBytes: upload.mask.bytes.length,
          text: "",
          dataUrl: `data:image/png;base64,${upload.mask.bytes.toString("base64")}`,
          kind: "input",
          document: { format: "image", readStatus: "readable", extractedChars: 0, truncated: false, imageMode: "vision" }
        });
      }
      const runId = `run_webimg_${randomUUID().replace(/-/gu, "")}`;
      activeWebappImageRuns.set(key, runId);
      try {
        const completion = await options.assistantBridge.completeImage({
          runId,
          requestId: normalized.requestId,
          agentKey: "zenmi",
          source: "copilot",
          action: "image_studio",
          operation: normalized.operation as AgentPlatformImageOperation,
          prompt: normalized.prompt,
          negativePrompt: normalized.negativePrompt,
          width: normalized.width,
          height: normalized.height,
          count: normalized.count,
          strength: normalized.strength,
          seed: normalized.seed,
          preserveComposition: normalized.preserveComposition,
          edgeMode: normalized.edgeMode as "strict" | "soft",
          attachments
        });
        if (!completion.ok) {
          return fail(action, "assistant_image_failed", completion.message, {
            runId: completion.runId,
            chatId: completion.chatId
          });
        }
        return ok(action, {
          provider: "desktop-zenmi",
          agentKey: "zenmi",
          requestId: normalized.requestId,
          runId: completion.runId,
          chatId: completion.chatId,
          images: completion.images
        });
      } finally {
        activeWebappImageRuns.delete(key);
      }
    }
    case "desktop.assistant.chat": {
      const isWebappInvocation = invocation.kind === "webappPage" || invocation.kind === "webappBackend";
      const allowedWebappArgs = new Set(["message"]);
      if (isWebappInvocation) {
        const rejectedKeys = Object.keys(args).filter((key) => !allowedWebappArgs.has(key));
        if (rejectedKeys.length > 0) {
          return fail(
            action,
            "invalid_args",
            `WebApp assistant calls only accept message; rejected: ${rejectedKeys.join(", ")}.`
          );
        }
      }
      const message = typeof args.message === "string" ? args.message : "";
      if (!message.trim()) {
        return fail(action, "invalid_args", "message is required");
      }
      const settings = options.getAssistantSettings(options.app);
      let agentKey = settings.desktopHelperAgentKey;
      if (isWebappInvocation) {
        const item = options.webs.webappManager.list(options.app)
          .find((candidate) => candidate.id === invocation.webappId) ?? null;
        if (!item) {
          return fail(action, "forbidden", "WebApp is not installed.");
        }
        const agentField = item.userConfig?.fields.find((field) =>
          field.type === "select" && "source" in field && field.source === "desktop.agents"
        );
        const userConfig = options.webs.webappManager.readUserConfig(options.app, item.id);
        const configuredAgentKey = agentField && typeof userConfig[agentField.name] === "string"
          ? String(userConfig[agentField.name])
          : "";
        if (configuredAgentKey) {
          let agents: Awaited<ReturnType<AgentPlatformAssistantBridge["listAgents"]>> = [];
          try {
            agents = await options.assistantBridge.listAgents();
          } catch {
            agents = [];
          }
          if (!agents.some((candidate) => candidate.agentKey === configuredAgentKey)) {
            return fail(
              action,
              "assistant_agent_unavailable",
              `assistant agent is unavailable: ${configuredAgentKey}`
            );
          }
          agentKey = configuredAgentKey;
        }
      }
      if (message.length > MAX_ASSISTANT_PROMPT_CHARS) {
        return fail(
          action,
          "assistant_message_too_long",
          `assistant input must be at most ${MAX_ASSISTANT_PROMPT_CHARS} characters`
        );
      }
      const completion = await options.assistantBridge.completeText({
        agentKey,
        source: "copilot",
        action: "chat",
        message
      });
      if (!completion.ok) {
        return fail(action, "assistant_failed", completion.message, {
          runId: completion.runId,
          chatId: completion.chatId
        });
      }
      const text = completion.text.trim();
      if (!text) {
        return fail(action, "assistant_empty", "Desktop assistant returned an empty response", {
          runId: completion.runId,
          chatId: completion.chatId
        });
      }
      return ok(action, {
        text,
        ...(isWebappInvocation ? { agentKey } : {}),
        runId: completion.runId,
        chatId: completion.chatId
      });
    }
    case "desktop.theme.get":
    case "desktop.theme.set":
    case "desktop.locale.get":
    case "desktop.locale.set":
    case "desktop.display":
    case "desktop.copilot.getPagePreferences":
    case "desktop.copilot.setPagePreference":
    case "desktop.web.listSurfaces":
    case "desktop.web.getSurfaceState":
    case "desktop.web.activateSurface":
    case "desktop.web.navigate":
    case "desktop.web.reload":
    case "desktop.web.refreshSurface":
    case "desktop.web.goBack":
    case "desktop.web.openTab":
    case "desktop.web.closeTab":
    case "desktop.web.switchTab":
    case "desktop.web.interactElement":
    case "desktop.web.executeScript":
    case "desktop.workpanel.getState":
    case "desktop.workpanel.openTab":
    case "desktop.workpanel.openWeb":
    case "desktop.workpanel.openLocalFile":
    case "desktop.workpanel.refreshWeb":
    case "desktop.workpanel.activateTab":
    case "desktop.workpanel.closeTab":
    case "desktop.workpanel.closeWorkpanel":
      return action === "desktop.workpanel.openLocalFile"
        ? executeOpenLocalFileAction(options, request, args)
        : callRendererAction(options, request, args);
    case "desktop.web.exportArtifact":
      return executeDesktopWebExportArtifact(options, action, args);
    case "desktop.general.deviceName": {
      const deviceInfo = getDesktopDeviceInfo(options.app);
      return ok(action, {
        deviceName: deviceInfo.deviceName,
        configuredDeviceName: deviceInfo.configuredDeviceName
      });
    }
    case "desktop.runtime.info":
      return ok(action, options.getDesktopAppInfo());
    case "desktop.runtime.diagnostics":
      return ok(action, await options.getDesktopRuntimeDiagnostics());
    case "desktop.navigate.toRoute": {
      const route = readString(args, "route") || readString(args, "path");
      if (!route.startsWith("/")) {
        return fail(action, "invalid_args", "route must start with /");
      }
      options.navigate(route);
      return ok(action, { route });
    }
    case "desktop.controlCenter.listServices":
      return ok(action, await options.services.listServices(options.app));
    case "desktop.controlCenter.openService": {
      const serviceId = readServiceId(args);
      const services = await options.services.listServices(options.app);
      if (!services.some((service) => service.id === serviceId)) {
        return fail(action, "service_not_found", "The Desktop service was not found.");
      }
      const route = `/settings/control?serviceId=${encodeURIComponent(serviceId)}`;
      options.navigate(route);
      return ok(action, { serviceId, route });
    }
    case "desktop.controlCenter.getServiceStatus":
    case "desktop.controlCenter.getServiceDetail":
      return ok(action, await options.services.getResponsiveServiceState(options.app, readServiceId(args)));
    case "desktop.controlCenter.getServiceLogsMeta":
      return ok(action, await options.services.getServiceLogsMeta(options.app, readServiceId(args)));
    case "desktop.controlCenter.readServiceLog": {
      const target = readString(args, "target") === "error" ? "error" : "main";
      return ok(action, await options.services.readServiceLog(options.app, readServiceId(args), target as ServiceLogTarget, {
        limitBytes: typeof args.limitBytes === "number" ? args.limitBytes : undefined,
        beforeOffset: typeof args.beforeOffset === "number" ? args.beforeOffset : undefined
      }));
    }
    case "desktop.controlCenter.openLogViewer":
      return ok(action, await options.openLogViewer({
        serviceId: readServiceId(args),
        target: readString(args, "target") === "error" ? "error" : "main",
        title: readString(args, "title") || t("service.logFile")
      }));
    case "desktop.controlCenter.installService": {
      await options.services.installBuiltinService(options.app, readServiceId(args));
      return ok(action, await options.services.getServiceState(options.app, readServiceId(args)));
    }
    case "desktop.controlCenter.initializeService":
      return ok(action, await options.services.initializeService(options.app, readServiceId(args)));
    case "desktop.controlCenter.startService":
      return ok(action, await options.services.startService(options.app, readServiceId(args)));
    case "desktop.controlCenter.stopService":
      return ok(action, await options.services.stopService(options.app, readServiceId(args)));
    case "desktop.controlCenter.restartService":
      return ok(action, await options.services.restartService(options.app, readServiceId(args)));
    case "desktop.site.list":
    case "desktop.website.list":
    case "desktop.website.add":
    case "desktop.website.update":
    case "desktop.website.remove":
    case "desktop.website.open":
    case "desktop.webapp.getStatus":
    case "desktop.webapp.start":
    case "desktop.webapp.stop":
    case "desktop.webapp.restart":
    case "desktop.webapp.open":
    case "desktop.webapp.updatePreferences":
    case "desktop.webapp.checkRuntime":
    case "desktop.webapp.install":
    case "desktop.webapp.uninstall":
    case "desktop.webapp.getPublishStatus":
    case "desktop.webapp.publish":
    case "desktop.webapp.unpublish":
      return executeWebAction(options, request, invocation, args);
    case "desktop.webapp.manifest.init":
    case "desktop.webapp.manifest.validate":
    case "desktop.webapp.package.validate":
    case "desktop.webapp.package.build":
      return executeWebappToolingAction(options, request, args);
    case "desktop.market.getSettings":
      return ok(action, getMarketSettings(options.app));
    case "desktop.market.validateSettings":
      return ok(action, validateMarketSettings(args));
    case "desktop.market.previewSettingsPatch": {
      const patch = asRecord(args.patch);
      const current = getMarketSettings(options.app);
      const next = saveMarketSettingsPreview(patch, current);
      return preview(action, {
        changes: [
          {
            field: "enabled",
            from: current.enabled,
            to: next.enabled
          },
          {
            field: "apiBaseUrl",
            from: current.apiBaseUrl,
            to: next.apiBaseUrl
          }
        ].filter((change) => change.from !== change.to)
      });
    }
    case "desktop.market.applySettingsPatch":
      return ok(action, saveMarketSettings(options.app, saveMarketSettingsPreview(asRecord(args.patch), getMarketSettings(options.app))));
    case "desktop.market.listItems":
      return ok(action, await listMarketItems(options.app, {
        ...readMarketListOptions(args),
        createContainerHubClient: options.createContainerHubClient
      }));
    case "desktop.market.refresh":
      return ok(action, await refreshMarketCatalog(options.app, readMarketListOptions(args)));
    case "desktop.market.getItemDetail": {
      const itemId = readItemId(args);
      const market = await listMarketItems(options.app, {
        ...readMarketListOptions(args),
        createContainerHubClient: options.createContainerHubClient
      });
      const item = market.items.find((candidate) => candidate.id === itemId);
      return item ? ok(action, item) : fail(action, "not_found", `market item not found: ${itemId}`);
    }
    case "desktop.market.installItem":
      return ok(action, await installMarketItem(options.app, readItemId(args), {
        createContainerHubClient: options.createContainerHubClient
      }));
    case "desktop.market.updateItem":
      return ok(action, await updateMarketItem(options.app, readItemId(args), {
        createContainerHubClient: options.createContainerHubClient
      }));
    case "desktop.market.uninstallItem":
      return ok(action, await uninstallMarketItem(options.app, readItemId(args)));
    case "desktop.market.openItem": {
      const itemId = readItemId(args);
      const route = `/market?itemId=${encodeURIComponent(itemId)}`;
      options.navigate(route);
      return ok(action, { itemId, route });
    }
    case "desktop.market.importSkill":
      return fail(action, "interactive_file_picker_required", t("desktopAction.marketImportRequiresPicker"));
    case "desktop.market.importSandboxImage":
      return fail(action, "interactive_file_picker_required", t("desktopAction.sandboxImportRequiresPicker"));
    case "desktop.market.exportSandboxImage": {
      const targetPath = readString(args, "targetPath");
      if (!targetPath) {
        return fail(action, "target_path_required", t("desktopAction.sandboxExportTargetRequired"));
      }
      return ok(action, await exportSandboxImageToPath(options.app, readItemId(args), targetPath));
    }
    case "desktop.market.deleteSandboxImage":
      return ok(action, await deleteSandboxImage(options.app, readItemId(args)));
    case "desktop.market.buildSandboxImage":
      return ok(action, await buildSandboxImage(options.app, readItemId(args), {
        createContainerHubClient: options.createContainerHubClient
      }));
    case "desktop.help.openTopic": {
      const route = resolveHelpOpenRoute(args);
      if (!route) {
        return fail(action, "invalid_args", "route, topic, or id must resolve to an allowed Help route.");
      }
      options.navigate(route);
      return ok(action, { route });
    }
    case "desktop.agent.open": {
      const agentKey = readString(args, "agentKey") || readString(args, "id");
      if (!agentKey) {
        return fail(action, "invalid_args", "agentKey is required.");
      }
      const route = `/agents/${encodeURIComponent(agentKey)}`;
      options.navigate(route);
      return ok(action, { agentKey, route });
    }
    case "desktop.skill.open": {
      const skillKey = readString(args, "skillKey") || readString(args, "id");
      if (!skillKey) {
        return fail(action, "invalid_args", "skillKey is required.");
      }
      const route = `/skills/${encodeURIComponent(skillKey)}`;
      options.navigate(route);
      return ok(action, { skillKey, route });
    }
    case "desktop.agent.update": {
      const agentKey = readString(args, "agentKey") || readString(args, "id");
      if (!agentKey) {
        return fail(action, "invalid_args", "agentKey is required.");
      }
      const definition = asRecord(args.definition);
      const response = await callAgentPlatform(options.app, "/api/admin/agents/update", {
        issueAgentAccessToken: options.issueAgentAccessToken,
        method: "POST",
        body: {
          agentKey,
          ...(Object.keys(definition).length > 0 ? { definition } : {}),
          ...(typeof args.soulPrompt === "string" ? { soulPrompt: args.soulPrompt.slice(0, 100_000) } : {}),
          ...(typeof args.agentsPrompt === "string" ? { agentsPrompt: args.agentsPrompt.slice(0, 100_000) } : {})
        }
      });
      return ok(action, response);
    }
    case "desktop.skill.update": {
      const skillKey = readString(args, "skillKey") || readString(args, "id");
      const filePath = readString(args, "path") || "SKILL.md";
      if (!skillKey) {
        return fail(action, "invalid_args", "skillKey is required.");
      }
      if (typeof args.content !== "string") {
        return fail(action, "invalid_args", "content is required.");
      }
      if (args.content.length > 1024 * 1024) {
        return fail(action, "invalid_args", "content exceeds the 1 MiB editable text limit.");
      }
      const response = await callAgentPlatform(options.app, "/api/admin/skills/file", {
        issueAgentAccessToken: options.issueAgentAccessToken,
        method: "PUT",
        body: {
          key: skillKey,
          path: filePath,
          content: args.content,
          ...(typeof args.baseSha256 === "string" && args.baseSha256.trim()
            ? { baseSha256: args.baseSha256.trim() }
            : {})
        }
      });
      return ok(action, response);
    }
    case "desktop.kanban.listIssues":
    case "desktop.kanban.getIssue":
    case "desktop.kanban.createIssue":
    case "desktop.kanban.updateIssue":
    case "desktop.kanban.deleteIssue":
    case "desktop.kanban.moveIssue":
      return executeKanbanAction(options, action, args);
    case "desktop.pet.state":
    case "desktop.pet.show":
    case "desktop.pet.hide":
    case "desktop.pet.list":
    case "desktop.pet.set":
      return executePetAction(options, action, args);
    default:
      return fail(action, "unknown_action", `unknown action: ${action}`);
  }
}

export async function handleActionCallRaw(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest,
  invocation: DesktopActionInvocationContext = { kind: "desktop" }
): Promise<DesktopActionCallResponse> {
  const action = typeof request.action === "string" ? request.action.trim() : "";
  const definition = action ? getDesktopActionDefinition(action) : null;
  if (!action || !definition) {
    return fail(action || "unknown", "unknown_action", `unknown action: ${action || "(empty)"}`);
  }
  if (AGENT_PLATFORM_ONLY_ACTIONS.has(action) && invocation.kind !== "agentPlatform") {
    return fail(action, "forbidden", `${action} is available only to an authorized internal Agent Platform Run.`);
  }
  const normalizedRequest = { ...request, action };
  const args = asRecord(request.args);
  for (const reservedField of ["source", ["confirmation", "Summary"].join("")]) {
    if (Object.prototype.hasOwnProperty.call(args, reservedField)) {
      return fail(action, "invalid_args", `${reservedField} is reserved.`);
    }
  }
  if (ARGUMENT_FREE_RUNTIME_ACTIONS.has(action) && Object.keys(args).length > 0) {
    return fail(action, "invalid_args", `${action} does not accept args.`);
  }
  if (CURRENT_PAGE_WEB_ACTIONS.has(action)) {
    const snapshot = options.getCurrentPageSnapshot();
    if (
      request.expectedPageKey &&
      snapshot?.pageKey &&
      request.expectedPageKey !== snapshot.pageKey
    ) {
      return fail(action, "stale_page_target", t("desktopAction.stalePageTarget"), {
        expectedPageKey: request.expectedPageKey,
        currentPageKey: snapshot.pageKey
      });
    }
  }
  const confirmationEligibleInvocation = invocation.kind === "desktop" || invocation.kind === "agentPlatform";
  const agentPlatformConfirmationExempt = invocation.kind === "agentPlatform" &&
    AGENT_PLATFORM_CONFIRMATION_EXEMPT_ACTIONS.has(action);
  const requiresConfirmation = definition.confirmation !== "none" &&
    (isDesktopActionMutating(action) || definition.confirmation === "sensitive-read");
  if (requiresConfirmation && confirmationEligibleInvocation && !agentPlatformConfirmationExempt) {
    const confirmationResponse = await confirmDesktopActionIfNeeded(
      options,
      normalizedRequest,
      args,
      definition.confirmation
    );
    if (confirmationResponse) {
      return confirmationResponse;
    }
  }
  try {
    return await executeAction(options, normalizedRequest, invocation);
  } catch (error) {
    return fail(action, "action_failed", error instanceof Error ? error.message : String(error));
  }
}

export function normalizeActionResponseTimePayload(
  response: DesktopActionCallResponse
): DesktopActionCallResponse {
  if (response.result === undefined) return response;
  const schema = getDesktopActionDefinition(response.action)?.outputSchema;
  if (!schema) return response;
  try {
    return {
      ...response,
      result: normalizeActionBridgeTimePayload(
        response.result,
        schema,
        `desktop.action.${response.action}.result`
      )
    };
  } catch (error) {
    if (!(error instanceof ActionBridgeTimeContractError)) throw error;
    return {
      ok: false,
      action: response.action,
      error: {
        code: "time_contract_violation",
        message: "time contract violation",
        details: {
          code: "time_contract_violation",
          field: error.field,
          location: error.location,
          expected: "epoch_ms_int64"
        }
      }
    };
  }
}

export async function handleActionCall(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest,
  invocation: DesktopActionInvocationContext = { kind: "desktop" }
): Promise<DesktopActionCallResponse> {
  return normalizeActionResponseTimePayload(
    await handleActionCallRaw(options, request, invocation)
  );
}

export async function handleDesktopActionRequest(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest
) {
  return handleActionCall(options, request);
}

export async function handleAgentPlatformDesktopActionRequest(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest
) {
  return handleActionCall(options, request, { kind: "agentPlatform" });
}

export async function handleAgentWebclientWorkPanelActionRequest(
  options: DesktopActionBridgeOptions,
  input: {
    requestId?: string;
    action: AgentWebclientWorkPanelAction;
    ownerChatId: string;
    args?: Record<string, unknown>;
  }
) {
  const method = typeof input.action === "string" ? input.action.trim() : "";
  if (!AGENT_WEBCLIENT_WORKPANEL_ACTIONS.has(method)) {
    return fail(`desktop.workpanel.${method || "unknown"}`, "forbidden", "This action is unavailable to the Agent WebClient WorkPanel bridge.");
  }
  const bridgeAction = method as AgentWebclientWorkPanelAction;
  const action = AGENT_WEBCLIENT_WORKPANEL_DESKTOP_ACTIONS[bridgeAction];
  const ownerChatId = typeof input.ownerChatId === "string" ? input.ownerChatId.trim() : "";
  if (!ownerChatId) {
    return fail(action, "source_chat_required", "A trusted WorkPanel owner chat is required.");
  }
  return handleActionCall(options, {
    ...(input.requestId ? { requestId: input.requestId } : {}),
    action,
    args: bridgeAction === "openItem"
      ? asRecord(input.args)
      : { tabId: readString(asRecord(input.args), "itemId") },
    source: { chatId: ownerChatId }
  }, { kind: "agentWebclientWorkPanel" });
}

export async function handleWebappPageActionRequest(
  options: DesktopActionBridgeOptions,
  webappId: string,
  request: DesktopActionCallRequest
) {
  return handleActionCall(options, {
    ...request,
    source: { webappId }
  }, { kind: "webappPage", webappId });
}
