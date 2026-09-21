import { type App } from "electron";
import { type WebsIntegrationPorts } from "../integration-ports";
import { readWebappItems, getWebappDir } from "./store";
import { type WebappEntry } from "../../../../shared/contracts";
import { type WebappLauncherContext, type WebappLauncherCheck } from "./launchers";
import { getDesktopWebappDataRoot, getDesktopWebappStateRoot, getDesktopWebappLogsRoot } from "../../../infrastructure/filesystem/user-paths";
import { getWebappAllowedActions } from "./capability-policy";
import { type RuntimeRecord } from "./runtime-state";
import { revokeWebappActionToken } from "./action-tokens";
import { t } from "../../../support/i18n/main-i18n";

export function findWebapp(app: App, webappId: string, ports?: WebsIntegrationPorts) {
  return readWebappItems(app, process.platform, ports)
    .find((item) => item.id === webappId.trim()) ?? null;
}

export function createLauncherContext(
  app: App,
  item: WebappEntry,
  backendPort: number | null,
  webappDir = getWebappDir(app, item.id),
  actionToken = "",
  integrationPorts?: WebsIntegrationPorts
): WebappLauncherContext {
  return {
    app,
    integrationPorts,
    item,
    webappDir,
    dataDir: getDesktopWebappDataRoot(app, item.id),
    stateDir: getDesktopWebappStateRoot(app, item.id),
    logDir: getDesktopWebappLogsRoot(app, item.id),
    backendPort,
    actionToken
  };
}

export function shouldIssueBackendActionToken(item: WebappEntry) {
  return Boolean(item.backend) &&
    getWebappAllowedActions(item, "backendActionToken").length > 0;
}

export function revokeRecordActionTokens(record: RuntimeRecord) {
  revokeWebappActionToken(record.backendActionToken);
  revokeWebappActionToken(record.pageActionToken);
  record.backendActionToken = "";
  record.pageActionToken = "";
}

export function stopRecordHealthMonitor(record: RuntimeRecord) {
  if (record.healthTimer) {
    clearInterval(record.healthTimer);
    record.healthTimer = null;
  }
  record.healthProbeActive = false;
  record.consecutiveHealthFailures = 0;
}

export function prerequisiteMessage(check: WebappLauncherCheck) {
  return check.issues.map((entry) => entry.message).filter(Boolean).join(" ") ||
    t("webapp.runtimePrerequisitesReady");
}
