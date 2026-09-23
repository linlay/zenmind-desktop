import type { BrowserWindow } from "electron";
import {
  app
} from "electron";
import type {
  EnterpriseChatScreenshotMode
} from "../../../shared/contracts";
import {
  getDataRoot
} from "../../infrastructure/filesystem/user-paths";
import { captureScreenshotForBridge, type AssistantBridgeRuntime } from "../../modules/assistant";
import {
  handleDesktopActionRequest
} from "../../modules/desktop-actions";
import { EnterpriseChatRuntime, readEnterpriseImSettings, redactEnterpriseChatSupportText } from "../../modules/enterprise-chat";
import {
  readServiceLog,
  type ServicesFacade
} from "../../modules/services";
import { type AppShellRuntime } from "../../modules/shell";
import {
  type WebsFacade
} from "../../modules/webs";
import { t } from "../../support/i18n/main-i18n";
export interface AssembleEnterpriseChatDependencies {
  readonly startupPlatform: NodeJS.Platform;
  readonly refreshDesktopSsoIdentityToken: (force?: boolean) => Promise<string>;
  readonly showFileDialog: AppShellRuntime["showFileDialog"];
  readonly showSaveDialog: AppShellRuntime["showSaveDialog"];
  readonly captureEnterpriseChatScreenshot: (mode: EnterpriseChatScreenshotMode) => ReturnType<typeof captureScreenshotForBridge>;
  readonly servicesFacade: Pick<ServicesFacade, "readServiceLog">;
  readonly websFacade: Pick<WebsFacade, "webappRuntime">;
  readonly assistantBridgeRuntime: Pick<AssistantBridgeRuntime, "desktopActionOptions">;
  readonly getMainWindow: () => BrowserWindow | null;
}

export function assembleEnterpriseChat(dependencies: AssembleEnterpriseChatDependencies) {
  return new EnterpriseChatRuntime({
    app,
    platform: dependencies.startupPlatform,
    getServerUrl: () => readEnterpriseImSettings(app, dependencies.startupPlatform).baseUrl,
    initialEnabled: readEnterpriseImSettings(app, dependencies.startupPlatform).enabled,
    refreshIdentityToken: () => dependencies.refreshDesktopSsoIdentityToken(true),
    selectFiles: async () => {
      const result = await dependencies.showFileDialog({
        title: t("enterpriseChat.selectFiles"),
        properties: ["openFile", "multiSelections"]
      });
      return result.canceled ? [] : result.filePaths;
    },
    selectAvatar: async () => {
      const result = await dependencies.showFileDialog({
        title: t("enterpriseChat.selectAvatar"),
        properties: ["openFile"],
        filters: [{ name: t("enterpriseChat.avatarImage"), extensions: ["png", "jpg", "jpeg", "webp"] }]
      });
      return result.canceled ? [] : result.filePaths;
    },
    showSaveDialog: (options) => dependencies.showSaveDialog(options),
    captureScreenshot: (mode) => dependencies.captureEnterpriseChatScreenshot(mode),
    createSupportArtifact: async (action, args) => {
      const readArg = (key: string) => typeof args[key] === "string" ? args[key].trim() : "";
      let filename = "desktop-support.txt";
      let content = "";
      if (action === "desktop.support.requestServiceLogs") {
        const serviceId = (readArg("serviceId") || readArg("id")) as Parameters<typeof readServiceLog>[1];
        const target = readArg("target") === "error" ? "error" : "main";
        const result = await dependencies.servicesFacade.readServiceLog(
          app,
          serviceId,
          target,
          { limitBytes: 512 * 1024 }
        );
        filename = `service-${serviceId}-${target}.log`;
        content = result.content;
      }
      else if (action === "desktop.support.requestWebappLogs") {
        const webappId = readArg("webappId") || readArg("id");
        const target = readArg("target") === "error" ? "error" : "main";
        const result = dependencies.websFacade.webappRuntime.readLog(
          app,
          webappId,
          target,
          { limitBytes: 512 * 1024 }
        );
        filename = `webapp-${webappId}-${target}.log`;
        content = result.content;
      }
      else if (action === "desktop.support.requestSystemInfo") {
        filename = "desktop-system-info.json";
        content = `${JSON.stringify({
          appVersion: app.getVersion(),
          platform: dependencies.startupPlatform,
          arch: process.arch,
          electron: process.versions.electron,
          node: process.versions.node,
          locale: app.getLocale()
        }, null, 2)}\n`;
      }
      else {
        throw new Error("Unsupported support artifact request.");
      }
      return {
        filename,
        contentType: filename.endsWith(".json") ? "application/json" : "text/plain",
        bytes: Buffer.from(redactEnterpriseChatSupportText(content, app.getPath("home"), getDataRoot(app)), "utf8")
      };
    },
    executeDesktopAction: async (request) => {
      const response = await handleDesktopActionRequest(dependencies.assistantBridgeRuntime.desktopActionOptions, {
        requestId: `enterprise-im-${request.messageId}`,
        action: request.action,
        args: request.args,
        permissionMode: "full_access",
        source: {
          chatId: `enterprise-im:${request.conversationId}`
        }
      });
      return {
        confirmed: true,
        status: response.ok ? "succeeded" : "failed",
        response,
        message: response.ok
          ? t("enterpriseChat.desktopActionExecuted")
          : response.error?.message || t("enterpriseChat.desktopActionFailed")
      };
    },
    onStateChanged: (snapshot) => {
      const targetWindow = dependencies.getMainWindow();
      if (targetWindow && !targetWindow.isDestroyed()) {
        targetWindow.webContents.send("enterpriseChat.stateChanged", snapshot);
      }
    }
  });
}

export interface CaptureEnterpriseChatScreenshotDependencies {
  readonly captureDesktopScreenshotForWebview: (mode?: EnterpriseChatScreenshotMode) => ReturnType<typeof captureScreenshotForBridge>;
  readonly getMainWindow: () => BrowserWindow | null;
  readonly ENTERPRISE_CHAT_WINDOW_CAPTURE_HIDE_CSS: string;
}

export async function captureEnterpriseChatScreenshot(dependencies: CaptureEnterpriseChatScreenshotDependencies, mode: EnterpriseChatScreenshotMode) {
  if (mode !== "window") {
    return dependencies.captureDesktopScreenshotForWebview(mode);
  }
  const targetWindow = dependencies.getMainWindow();
  if (!targetWindow ||
    targetWindow.isDestroyed() ||
    targetWindow.webContents.isDestroyed()) {
    return dependencies.captureDesktopScreenshotForWebview(mode);
  }
  let insertedCssKey = "";
  try {
    insertedCssKey = await targetWindow.webContents.insertCSS(dependencies.ENTERPRISE_CHAT_WINDOW_CAPTURE_HIDE_CSS);
    return await dependencies.captureDesktopScreenshotForWebview(mode);
  }
  finally {
    if (insertedCssKey && !targetWindow.webContents.isDestroyed()) {
      await targetWindow.webContents.removeInsertedCSS(insertedCssKey).catch(() => undefined);
    }
  }
}

