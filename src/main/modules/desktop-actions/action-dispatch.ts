import { executeSkinAction } from "./skin-actions";
import { type DesktopActionBridgeOptions, type DesktopActionInvocationContext } from "./action-contracts";
import { type DesktopActionCallRequest, type DesktopActionCallResponse } from "../../../shared/desktop-actions";
import { asRecord, fail, readString, ok, readServiceId, preview, readMarketListOptions, readItemId } from "./action-values";
import { WEBAPP_PAGE_ONLY_ACTIONS, executeNativeWebappAction } from "./webapp-native-actions";
import { t } from "../../support/i18n/main-i18n";
import { executeWebSurfaceAction } from "./web-surface-actions";
import {
  webappImageRunKey,
  activeWebappImageRuns,
  normalizeWebappImageRequest,
  WEBAPP_IMAGE_MASK_REQUIRED,
  MAX_ASSISTANT_PROMPT_CHARS
} from "./webapp-image-input";
import { consumeWebappImageUpload } from "../webs";
import { type AssistantAttachment, type ServiceLogTarget } from "../../../shared/contracts";
import { randomUUID } from "node:crypto";
import { type AgentPlatformImageOperation, type AgentPlatformAssistantBridge } from "../agent-platform";
import { captureWebappContext } from "./webapp-platform-client";
import { startWebappAssistant } from "./webapp-assistant";
import { rememberWebappChat } from "./webapp-connector";
import { executeOpenLocalFileAction } from "./local-file-actions";
import { callRendererAction } from "./renderer-action-results";
import { executeDesktopWebExportArtifact } from "./web-export-actions";
import { getDesktopDeviceInfo } from "../identity";
import { executeWebAction } from "./web-resource-actions";
import { executeWebappToolingAction } from "./webapp-tooling-actions";
import {
  getMarketSettings,
  saveMarketSettings,
  listMarketItems,
  refreshMarketCatalog,
  installMarketItem,
  updateMarketItem,
  uninstallMarketItem,
  exportSandboxImageToPath,
  deleteSandboxImage,
  buildSandboxImage
} from "../marketplace";
import { validateMarketSettings, saveMarketSettingsPreview } from "./market-action-input";
import { resolveHelpOpenRoute } from "./help-routing";
import { callAgentPlatform } from "./platform-http";
import { executeKanbanAction } from "./kanban-actions";
import { executePetAction } from "./pet-actions";

export async function executeAction(
  options: DesktopActionBridgeOptions,
  request: DesktopActionCallRequest,
  invocation: DesktopActionInvocationContext
): Promise<DesktopActionCallResponse> {
  if (request.action.startsWith("desktop.skin.")) return executeSkinAction(options, request, invocation);
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

  if (action.startsWith("desktop.web.")) {
    const response = await executeWebSurfaceAction(options, request, invocation);
    if (response) return response;
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
      const allowedWebappArgs = new Set(["message", "skillIds", "background"]);
      if (isWebappInvocation) {
        const rejectedKeys = Object.keys(args).filter((key) => !allowedWebappArgs.has(key));
        if (rejectedKeys.length > 0) {
          return fail(
            action,
            "invalid_args",
            `WebApp assistant calls only accept message, skillIds and background; rejected: ${rejectedKeys.join(", ")}.`
          );
        }
      }
      const message = typeof args.message === "string" ? args.message : "";
      if (!message.trim()) {
        return fail(action, "invalid_args", "message is required");
      }
      const settings = options.getAssistantSettings(options.app);
      let agentKey = settings.desktopHelperAgentKey;
      let mustUseSkills: string[] | undefined;
      if (isWebappInvocation) {
        const item = options.webs.webappManager.list(options.app)
          .find((candidate) => candidate.id === invocation.webappId) ?? null;
        if (!item) {
          return fail(action, "forbidden", "WebApp is not installed.");
        }
        if (item.copilot) {
          agentKey = item.copilot.agentKey;
          mustUseSkills = [...item.copilot.mustUseSkills];
        }
        if (args.skillIds !== undefined) {
          const allowedSkills = new Set(item.copilot?.mustUseSkills ?? []);
          if (!Array.isArray(args.skillIds) || args.skillIds.length > 16 ||
              args.skillIds.some((id) => typeof id !== "string" || !allowedSkills.has(id))) {
            return fail(action, "invalid_args", "skillIds must be a subset of this WebApp's declared Copilot skills.");
          }
          mustUseSkills = [...new Set(args.skillIds as string[])];
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
      const webappContext = isWebappInvocation ? await captureWebappContext(options, invocation.webappId, invocation.signal) : null;
      if (isWebappInvocation && args.background !== undefined && typeof args.background !== "boolean") return fail(action, "invalid_args", "background must be boolean.");
      if (webappContext && args.background === true) {
        const result = await startWebappAssistant(options, webappContext, { agentKey, source: "copilot", action: "chat", message, ...(mustUseSkills?.length ? { mustUseSkills } : {}) });
        return ok(action, result);
      }
      const completion = await options.assistantBridge.completeText({
        agentKey,
        source: "copilot",
        action: "chat",
        message,
        ...(mustUseSkills?.length ? { mustUseSkills } : {})
      });
      if (isWebappInvocation) {
        await webappContext!.check();
        if (completion.ok && completion.chatId) rememberWebappChat(webappContext!.key, completion.chatId);
      }
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
        : callRendererAction(options, request, args,
          invocation.kind === "agentWebclientWorkPanel" ? "workpanel-bridge" : "desktop-action");
    case "desktop.web.exportArtifact":
      return executeDesktopWebExportArtifact(options, action, args, invocation.kind === "agentPlatform" ? request.source : undefined);
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
    case "desktop.webapp.package.init":
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
      if (!options.getHelpUrl?.()) {
        return fail(action, "help_not_configured", t("help.error.notConfigured"));
      }
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
