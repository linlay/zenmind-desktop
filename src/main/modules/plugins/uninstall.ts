import type { App, BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from "electron";
import type { PluginInstallResult, ServiceId } from "../../../shared/contracts";
import { DEFAULT_LOCALE, translate, type TranslateFunction } from "../../../shared/i18n";
import { t as mainT } from "../../support/i18n/main-i18n";
import { uninstallPlugin } from "./loader";
import { getService } from "../services";

type ShowMessageBox = typeof import("electron").dialog.showMessageBox;

interface HandlePluginUninstallDeps {
  getServiceById?: typeof getService;
  showMessageBox?: ShowMessageBox;
  t?: TranslateFunction;
  uninstall?: typeof uninstallPlugin;
}

function fallbackT(key: Parameters<TranslateFunction>[0], params?: Parameters<TranslateFunction>[1]) {
  return translate(DEFAULT_LOCALE, key, params);
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
    return { ok: false, message: mainT("service.builtinNotUninstallable") };
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
