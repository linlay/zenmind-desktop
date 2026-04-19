import {
  dialog,
  type App,
  type BrowserWindow,
  type MessageBoxOptions,
  type MessageBoxReturnValue
} from "electron";
import type { PluginInstallResult, ServiceId } from "../shared/contracts";
import { isManagedClaudeCodeRelayPlugin } from "./code-assistant";
import { uninstallPlugin } from "./plugin-loader";
import { getService } from "./service-registry";

type ShowMessageBox = typeof dialog.showMessageBox;

interface HandlePluginUninstallDeps {
  getServiceById?: typeof getService;
  showMessageBox?: ShowMessageBox;
  uninstall?: typeof uninstallPlugin;
}

export function buildPluginUninstallDialogOptions(serviceName: string): MessageBoxOptions {
  return {
    type: "warning",
    buttons: ["取消", "卸载"],
    defaultId: 0,
    cancelId: 0,
    title: "卸载插件",
    message: `确定要卸载插件 ${serviceName} 吗？`,
    detail: "插件目录将被删除，此操作不可撤销。"
  };
}

async function showPluginUninstallDialog(
  ownerWindow: BrowserWindow | null,
  options: MessageBoxOptions,
  showMessageBox: ShowMessageBox
): Promise<MessageBoxReturnValue> {
  if (ownerWindow) {
    return showMessageBox(ownerWindow, options);
  }
  return showMessageBox(options);
}

export async function handlePluginUninstall(
  app: App,
  serviceId: ServiceId,
  ownerWindow: BrowserWindow | null,
  deps: HandlePluginUninstallDeps = {}
): Promise<PluginInstallResult> {
  const getServiceById = deps.getServiceById ?? getService;
  const showMessageBox = deps.showMessageBox ?? (dialog.showMessageBox.bind(dialog) as ShowMessageBox);
  const uninstall = deps.uninstall ?? uninstallPlugin;
  const service = getServiceById(serviceId);

  if (isManagedClaudeCodeRelayPlugin(serviceId)) {
    return { ok: false, message: "代码助手集成由 Desktop 托管，暂不支持卸载。" };
  }

  if (service.kind !== "plugin") {
    return { ok: false, message: "内置服务不可卸载。" };
  }

  const result = await showPluginUninstallDialog(
    ownerWindow,
    buildPluginUninstallDialogOptions(service.name),
    showMessageBox
  );
  if (result.response === 0) {
    return { ok: false, message: "已取消卸载。" };
  }

  return uninstall(app, serviceId);
}

export const __testInternals = {
  buildPluginUninstallDialogOptions
};
