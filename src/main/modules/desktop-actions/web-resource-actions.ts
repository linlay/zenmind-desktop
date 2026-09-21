import { type DesktopActionBridgeOptions, type DesktopActionInvocationContext } from "./action-contracts";
import { fail, ok, readString, asRecord, readWebsiteActionInput, readWebsiteId, readWebappId } from "./action-values";
import {
  sanitizeWebappErrorText,
  webappRuntimeFailureDetails,
  isWebappRuntimeStateFor,
  invalidWebappActionResult,
  sanitizeWebappDiagnosticValue,
  installFailureDetails,
  webappPreferenceFailureDetails,
  projectWebappPublishFailureDetails
} from "./webapp-action-results";
import {
  type DesktopWebappRuntimeMutationResult,
  type DesktopWebappOpenResult,
  type DesktopActionCallRequest,
  type DesktopWebappInstallResult,
  type DesktopWebsiteItemResult,
  type DesktopWebsiteRemoveResult,
  type DesktopWebappPreferenceResult,
  type DesktopWebappPublishResult,
  type DesktopWebappUnpublishResult,
  type DesktopWebappUninstallResult
} from "../../../shared/desktop-actions";
import { rejectUnexpectedArgs, trustedWebappWorkspaceSource } from "./webapp-tooling-actions";
import {
  resolveExistingWorkspacePath,
  WebappToolingError,
  listWebEntries,
  WebappRuntimeRequiredError,
  createWebappImportDiagnostic,
  listWebsiteItems,
  addWebsiteItem,
  updateWebsiteItem,
  removeWebsiteItem
} from "../webs";
import { WEBAPP_ID_PATTERN } from "../../../shared/webapp-manifest";
import { type OpenDialogOptions, dialog } from "electron";
import path from "node:path";
import { t } from "../../support/i18n/main-i18n";

export function webappRoute(webappId: string) {
  return `/webs/webapp:${webappId}`;
}

export function websiteRoute(websiteId: string) {
  return `/webs/website:${websiteId.trim()}`;
}

export function notifyWebsChanged(options: DesktopActionBridgeOptions) {
  const mainWindow = options.getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send("webs.changed", { changedAt: new Date().toISOString() });
}

export async function executeWebappRuntimeMutation(
  options: DesktopActionBridgeOptions,
  action: string,
  webappId: string,
  operation: "start" | "stop" | "restart"
) {
  const command = await options.webs.webappRuntime[operation](options.app, webappId);
  if (!command.ok) {
    return fail(
      action,
      `webapp_${operation}_failed`,
      sanitizeWebappErrorText(command.message),
      webappRuntimeFailureDetails(webappId, operation, command)
    );
  }
  if (!isWebappRuntimeStateFor(command.state, webappId)) {
    return invalidWebappActionResult(action, webappId, operation, ["state"]);
  }
  return ok(action, {
    webappId,
    status: command.state.status
  } satisfies DesktopWebappRuntimeMutationResult);
}

export async function openWebapp(options: DesktopActionBridgeOptions, action: string, webappId: string) {
  const command = await options.webs.webappRuntime.start(options.app, webappId);
  if (!command.ok) {
    return fail(
      action,
      "webapp_open_failed",
      sanitizeWebappErrorText(command.message),
      webappRuntimeFailureDetails(webappId, "open", command)
    );
  }
  if (!isWebappRuntimeStateFor(command.state, webappId)) {
    return invalidWebappActionResult(action, webappId, "open", ["state"]);
  }
  const route = webappRoute(webappId);
  options.navigate(route);
  return ok(action, {
    webappId,
    status: command.state.status,
    route
  } satisfies DesktopWebappOpenResult);
}

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
