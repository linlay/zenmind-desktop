import type { App, BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from "electron";
import type { PluginInstallResult, ServiceId } from "../shared/contracts";
import type { TranslateFunction } from "../shared/i18n";
import { uninstallPlugin } from "./plugin-loader";
import { getService } from "./services/service-registry";

type ShowMessageBox = typeof import("electron").dialog.showMessageBox;

interface HandlePluginUninstallDeps {
  getServiceById?: typeof getService;
  showMessageBox?: ShowMessageBox;
  t?: TranslateFunction;
  uninstall?: typeof uninstallPlugin;
}

function fallbackT(key: Parameters<TranslateFunction>[0], params?: Parameters<TranslateFunction>[1]) {
  switch (key) {
    case "plugin.uninstall.cancel":
      return "取消";
    case "plugin.uninstall.confirm":
      return "卸载";
    case "plugin.uninstall.title":
      return "卸载插件";
    case "plugin.uninstall.message":
      return `确定要卸载插件 ${params?.name ?? ""} 吗？`;
    case "plugin.uninstall.detail":
      return "插件目录将被删除，此操作不可撤销。";
    case "plugin.uninstall.cancelled":
      return "已取消卸载。";
    default:
      return key;
  }
}

export function buildPluginUninstallDialogOptions(
  serviceName: string,
  t: TranslateFunction = fallbackT
): MessageBoxOptions {
  return {
    type: "warning",
    buttons: [t("plugin.uninstall.cancel"), t("plugin.uninstall.confirm")],
    defaultId: 0,
    cancelId: 0,
    title: t("plugin.uninstall.title"),
    message: t("plugin.uninstall.message", { name: serviceName }),
    detail: t("plugin.uninstall.detail")
  };
}

function getDefaultShowMessageBox(): ShowMessageBox {
  const electronDialog = (require("electron") as typeof import("electron")).dialog;
  return electronDialog.showMessageBox.bind(electronDialog) as ShowMessageBox;
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
  const showMessageBox = deps.showMessageBox ?? getDefaultShowMessageBox();
  const t = deps.t ?? fallbackT;
  const uninstall = deps.uninstall ?? uninstallPlugin;
  const service = getServiceById(serviceId);

  if (service.kind !== "plugin") {
    return { ok: false, message: "内置服务不可卸载。" };
  }

  const result = await showPluginUninstallDialog(
    ownerWindow,
    buildPluginUninstallDialogOptions(service.name, t),
    showMessageBox
  );
  if (result.response === 0) {
    return { ok: false, message: t("plugin.uninstall.cancelled") };
  }

  return uninstall(app, serviceId);
}

export const __testInternals = {
  buildPluginUninstallDialogOptions
};
