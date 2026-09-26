import fs from "node:fs";
import path from "node:path";
import { type ServiceDefinition } from "../../../support/manifest/manifest-utils";
import {
  type ServiceLayout,
  getInitializationStatePath,
  getInstallDir,
  getServiceLayout,
  resolveConfigPath,
  resolveConfigTemplatePath
} from "./layout";
import { type App } from "electron";
import { readInitializationState } from "./state-files";
import { readBuiltinAssetSignature, computeAssetSignature, ensureBundleAssetHealthy } from "./bundle-assets";

export function ensureDir(targetPath: string) {
  fs.mkdirSync(targetPath, { recursive: true });
}

export function isDirectoryAssetPath(assetPath: string) {
  return fs.existsSync(assetPath) && fs.statSync(assetPath).isDirectory();
}

export function copyDirectoryAssetToTempRoot(assetPath: string, tempRoot: string) {
  const targetRoot = path.join(tempRoot, path.basename(assetPath));
  fs.cpSync(assetPath, targetRoot, { recursive: true, force: true });
  return targetRoot;
}

export function prepareServiceExecutionLayout(_service: ServiceDefinition, layout: ServiceLayout) {
  ensureDir(layout.configDir);
  ensureDir(layout.dataDir);
  ensureDir(layout.stateDir);
  ensureDir(layout.logDir);
}

export function isAssetNewerThanInstall(
  assetPath: string,
  layoutOrInstallDir: ServiceLayout | string,
  app?: App,
  service?: ServiceDefinition
) {
  try {
    const initStatePath = getInitializationStatePath(layoutOrInstallDir);
    if (!fs.existsSync(initStatePath)) {
      return true;
    }
    const initializationState = readInitializationState(layoutOrInstallDir);
    if (initializationState?.assetSignature) {
      const assetSignature = app && service
        ? readBuiltinAssetSignature(app, service) ?? computeAssetSignature(assetPath)
        : computeAssetSignature(assetPath);
      return initializationState.assetSignature !== assetSignature;
    }
    const assetMtime = fs.statSync(assetPath).mtimeMs;
    return assetMtime > fs.statSync(initStatePath).mtimeMs;
  } catch {
    return true;
  }
}

export function needsBundledAssetRefresh(app: App, service: ServiceDefinition) {
  if (service.kind !== "builtin") {
    return false;
  }

  const installDir = getInstallDir(app, service);
  const layout = getServiceLayout(app, service);
  let assetPath: string;
  try {
    assetPath = ensureBundleAssetHealthy(app, service);
  } catch {
    return false;
  }

  if (!fs.existsSync(installDir)) {
    return true;
  }

  try {
    return isAssetNewerThanInstall(assetPath, layout, app, service);
  } catch {
    return false;
  }
}

export function ensureDefaultConfig(service: ServiceDefinition, layout: ServiceLayout) {
  for (const configFile of service.configFiles) {
    const targetPath = resolveConfigPath(layout, configFile.relativePath);
    if (fs.existsSync(targetPath)) {
      continue;
    }
    if (!configFile.templateRelativePath) {
      continue;
    }
    const templatePath = resolveConfigTemplatePath(layout, configFile.templateRelativePath);
    if (fs.existsSync(templatePath)) {
      ensureDir(path.dirname(targetPath));
      fs.copyFileSync(templatePath, targetPath);
    }
  }
}
