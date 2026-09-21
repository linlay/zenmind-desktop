import { type App } from "electron";
import { type ServiceId, type ServiceConfigReadResult, type ServiceCommandResult, type ServiceImportResult } from "../../../../shared/contracts";
import { getService } from "../service-registry";
import { getInstallDir, getServiceLayout, resolveConfigPath, resolveConfigTemplatePath } from "./layout";
import fs from "node:fs";
import { type ServicesIntegrationPorts } from "../integration-ports";
import { ensureMutableInstallDir } from "./installation";
import { ensureDir, prepareServiceExecutionLayout } from "./execution-layout";
import path from "node:path";
import { CORE_SERVICE_IDS, integrationPorts } from "./manager-contracts";
import { t } from "../../../support/i18n/main-i18n";
import { getServiceState } from "./service-state";

export async function readServiceConfig(app: App, serviceId: ServiceId, key: string): Promise<ServiceConfigReadResult> {
  const service = getService(serviceId);
  const configFile = service.configFiles.find((item) => item.key === key);
  if (!configFile) {
    throw new Error(`unknown config key: ${key}`);
  }

  const installDir = getInstallDir(app, service);
  const layout = getServiceLayout(app, service);
  const filePath = resolveConfigPath(layout, configFile.relativePath);
  if (!fs.existsSync(installDir)) {
    return {
      ok: true,
      path: filePath,
      content: "",
      exists: false,
      source: "missing"
    };
  }

  if (fs.existsSync(filePath)) {
    return {
      ok: true,
      path: filePath,
      content: fs.readFileSync(filePath, "utf8"),
      exists: true,
      source: "file"
    };
  }

  if (configFile.templateRelativePath) {
    const templatePath = resolveConfigTemplatePath(layout, configFile.templateRelativePath);
    if (fs.existsSync(templatePath)) {
      return {
        ok: true,
        path: filePath,
        content: fs.readFileSync(templatePath, "utf8"),
        exists: false,
        source: "template"
      };
    }
  }

  return {
    ok: true,
    path: filePath,
    content: "",
    exists: false,
    source: "missing"
  };
}

export async function writeServiceConfig(
  app: App,
  serviceId: ServiceId,
  key: string,
  content: string,
  ports?: ServicesIntegrationPorts
): Promise<ServiceCommandResult> {
  const service = getService(serviceId);
  const configFile = service.configFiles.find((item) => item.key === key);
  if (!configFile) {
    throw new Error(`unknown config key: ${key}`);
  }
  const installDir = await ensureMutableInstallDir(app, service, ports);
  const layout = getServiceLayout(app, service);

  const filePath = resolveConfigPath(layout, configFile.relativePath);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
  prepareServiceExecutionLayout(service, layout);

  const message =
    key === "env" && CORE_SERVICE_IDS.has(service.id)
      ? t("service.configSavedRestartRequired", { name: service.name })
      : t("service.configSaved", { name: service.name });

  const result = {
    ok: true,
    message,
    service: await getServiceState(app, serviceId, { integrationPorts: ports })
  };
  if (service.kind === "plugin") {
    integrationPorts(ports).emitPluginBridgeHook("plugin.configChanged", { pluginId: service.id, key, service: result.service });
  }
  return result;
}

export async function importServiceFile(
  app: App,
  serviceId: ServiceId,
  targetKey: string,
  sourcePath: string,
  ports?: ServicesIntegrationPorts
): Promise<ServiceImportResult> {
  const service = getService(serviceId);
  const target = service.importTargets.find((item) => item.key === targetKey);
  if (!target) {
    throw new Error(`unknown import target: ${targetKey}`);
  }

  const installDir = await ensureMutableInstallDir(app, service, ports);
  const layout = getServiceLayout(app, service);

  const targetPath = resolveConfigPath(layout, target.relativePath);
  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
  prepareServiceExecutionLayout(service, layout);

  const result = {
    ok: true,
    message: t("service.imported", { label: target.label }),
    targetPath,
    service: await getServiceState(app, serviceId, { integrationPorts: ports })
  };
  if (service.kind === "plugin") {
    integrationPorts(ports).emitPluginBridgeHook("plugin.configChanged", { pluginId: service.id, key: targetKey, service: result.service });
  }
  return result;
}
