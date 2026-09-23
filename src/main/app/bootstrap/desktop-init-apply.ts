import { type App } from "electron";
import {
  resolveDesktopInitPath,
  readJsonFile,
  DESKTOP_INIT_FILE,
  isRecord,
  DESKTOP_INIT_BOOTSTRAP_STATE_FILE,
  BootstrapWebsReport,
  BootstrapApplyResult,
  runBootstrapSection,
  writeAssistantDefaults,
  getFailedSections,
  removeDesktopInitFile,
  removeDesktopInitSitesStaging,
  writeBootstrapState,
  errorMessage
} from "./desktop-init-state";
import path from "node:path";
import { getDesktopStateRoot } from "../../infrastructure/filesystem/user-paths";
import fs from "node:fs";
import {
  normalizeDesktopInitAssistantDefaults,
  applyProfileDefaults,
  applyKanbanDefaults,
  applyPetDefaults,
  applyMarketDefaults,
  applySsoDefaults,
  applyTunnelHubDefaults,
  applyDesktopActionBridgeDefaults,
  applyEnterpriseImDefaults,
  applyHelpDefaults,
  applyServiceDefaults
} from "./desktop-init-settings";
import { normalizeUpdateConfig, writeUpdateConfig } from "../../modules/updates";
import { applyWebsiteDefaults } from "./desktop-init-sites";

export function applyDesktopInitBootstrap(
  app: App,
  platform: NodeJS.Platform = process.platform
) {
  const initPath = resolveDesktopInitPath(app, platform);
  let defaults: unknown;
  try {
    defaults = readJsonFile(initPath);
  } catch (error) {
    console.warn(`[desktop-init] failed to read ${DESKTOP_INIT_FILE}:`, error);
    return {
      ok: false,
      applied: false,
      reason: "invalid" as const,
      message: error instanceof Error ? error.message : String(error)
    };
  }
  if (!isRecord(defaults)) {
    return { ok: true, applied: false, reason: "missing" as const };
  }
  try {
    const bootstrapStatePath = path.join(
      getDesktopStateRoot(app, platform),
      DESKTOP_INIT_BOOTSTRAP_STATE_FILE
    );
    const preserveSites = fs.existsSync(bootstrapStatePath);
    const assistant = normalizeDesktopInitAssistantDefaults(defaults.assistant);
    const kanbanDefaults = isRecord(defaults.kanban) ? defaults.kanban : null;
    const errors: Record<string, string> = {};
    let websReport: BootstrapWebsReport = {
      mode: preserveSites ? "preserve" : "initialize",
      items: [],
      warnings: []
    };

    // Validate the update source before writing any initialization section.
    if (Object.prototype.hasOwnProperty.call(defaults, "updates")) normalizeUpdateConfig(defaults.updates, platform);
    const applied: BootstrapApplyResult = {
      updates: runBootstrapSection("updates", errors, () => {
        if (defaults.updates === undefined) return "absent";
        writeUpdateConfig(app, defaults.updates, platform);
        return "applied";
      }),
      profile: runBootstrapSection("profile", errors, () => applyProfileDefaults(app, defaults.profile, platform)),
      kanban: runBootstrapSection("kanban", errors, () => applyKanbanDefaults(app, kanbanDefaults, platform)),
      pet: runBootstrapSection("pet", errors, () => applyPetDefaults(app, defaults.pet, platform)),
      market: runBootstrapSection("market", errors, () => applyMarketDefaults(app, defaults.market, platform)),
      sso: runBootstrapSection("sso", errors, () => applySsoDefaults(app, defaults.sso, platform)),
      tunnelHub: runBootstrapSection("tunnelHub", errors, () => applyTunnelHubDefaults(app, defaults.tunnelHub, platform)),
      webs: runBootstrapSection("webs", errors, () => {
        const result = applyWebsiteDefaults(
          app,
          initPath,
          defaults.webs,
          preserveSites,
          platform
        );
        websReport = result.report;
        return result.status;
      }),
      assistant: runBootstrapSection("assistant", errors, () => writeAssistantDefaults(app, assistant, platform)),
      desktopActionBridge: runBootstrapSection(
        "desktopActionBridge",
        errors,
        () => applyDesktopActionBridgeDefaults(app, defaults.desktopActionBridge, platform)
      ),
      enterpriseIm: runBootstrapSection(
        "enterpriseIm",
        errors,
        () => applyEnterpriseImDefaults(app, defaults.enterpriseIm, platform)
      ),
      help: runBootstrapSection(
        "help",
        errors,
        () => applyHelpDefaults(app, defaults.help, platform)
      ),
      services: runBootstrapSection("services", errors, () => applyServiceDefaults(app, defaults.services, platform))
    };
    const failedSections = getFailedSections(applied);
    if (applied.webs === "failed" && errors.webs) {
      websReport.warnings.push(errors.webs);
    }
    removeDesktopInitFile(initPath);
    removeDesktopInitSitesStaging(initPath);
    writeBootstrapState(app, {
      schemaVersion: 2,
      appliedAt: new Date().toISOString(),
      sourcePath: initPath,
      consumed: true,
      appliedResult: applied,
      failedSections,
      errors,
      websReport
    }, platform);
    return { ok: true, applied: true, appliedResult: applied, failedSections, errors, websReport };
  } catch (error) {
    console.warn(`[desktop-init] failed to apply ${DESKTOP_INIT_FILE}:`, error);
    return {
      ok: false,
      applied: false,
      reason: "invalid" as const,
      message: errorMessage(error)
    };
  }
}
