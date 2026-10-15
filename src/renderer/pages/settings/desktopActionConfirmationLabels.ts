import type { DesktopExemptibleActionName } from "../../../shared/desktop-action-confirmation";
import type { TranslationKey } from "../../../shared/i18n";

export const actionConfirmationLabels = {
  "desktop.credentials.fill": "settings.actionConfirmation.action.desktop.credentials.fill",
  "desktop.webapp.install": "settings.actionConfirmation.action.desktop.webapp.install",
  "desktop.webapp.uninstall": "settings.actionConfirmation.action.desktop.webapp.uninstall",
  "desktop.webapp.publish": "settings.actionConfirmation.action.desktop.webapp.publish",
  "desktop.controlCenter.installService": "settings.actionConfirmation.action.desktop.controlCenter.installService",
  "desktop.controlCenter.initializeService": "settings.actionConfirmation.action.desktop.controlCenter.initializeService",
  "desktop.controlCenter.startService": "settings.actionConfirmation.action.desktop.controlCenter.startService",
  "desktop.controlCenter.stopService": "settings.actionConfirmation.action.desktop.controlCenter.stopService",
  "desktop.controlCenter.restartService": "settings.actionConfirmation.action.desktop.controlCenter.restartService",
  "desktop.market.applySettingsPatch": "settings.actionConfirmation.action.desktop.market.applySettingsPatch",
  "desktop.market.installItem": "settings.actionConfirmation.action.desktop.market.installItem",
  "desktop.market.updateItem": "settings.actionConfirmation.action.desktop.market.updateItem",
  "desktop.market.uninstallItem": "settings.actionConfirmation.action.desktop.market.uninstallItem",
  "desktop.market.importSkill": "settings.actionConfirmation.action.desktop.market.importSkill",
  "desktop.market.importSandboxImage": "settings.actionConfirmation.action.desktop.market.importSandboxImage",
  "desktop.market.exportSandboxImage": "settings.actionConfirmation.action.desktop.market.exportSandboxImage",
  "desktop.market.deleteSandboxImage": "settings.actionConfirmation.action.desktop.market.deleteSandboxImage",
} satisfies Record<DesktopExemptibleActionName, TranslationKey>;

export const actionConfirmationCategoryLabels = {
  web: "settings.actionConfirmation.category.web",
  credentials: "settings.actionConfirmation.category.credentials",
  controlCenter: "settings.actionConfirmation.category.controlCenter",
  market: "settings.actionConfirmation.category.market",
} satisfies Record<string, TranslationKey>;
