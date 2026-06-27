import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { getDesktopWebappsDataRoot } from "../../user-paths";
import { t } from "../../i18n/main-i18n";

const DEMO_RESOURCES_ROOT_NAME = "demo";
const DEMO_MANIFEST_FILE_NAME = "manifest.json";
const TEMPLATE_ROOT_NAME = "webapp-templates";
export const BUNDLED_DEMO_ID = "demo-node-html";

type AppWithPath = Pick<App, "getPath"> & Partial<Pick<App, "getAppPath" | "isPackaged">>;

type BundledDemoManifest = {
  bundled?: unknown;
};

type InstallBundledWebappTemplateOptions = {
  platform?: NodeJS.Platform;
  resourcesRoot?: string;
};

function bundledResourcesRoot(app: AppWithPath, resourcesRootOverride?: string) {
  if (resourcesRootOverride) {
    return resourcesRootOverride;
  }
  return app.isPackaged
    ? process.resourcesPath
    : path.join(process.cwd(), "build", "resources");
}

function readBundledDemoManifest(resourcesRoot: string): BundledDemoManifest | null {
  const manifestPath = path.join(resourcesRoot, DEMO_RESOURCES_ROOT_NAME, DEMO_MANIFEST_FILE_NAME);
  try {
    if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
      return null;
    }
    return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BundledDemoManifest;
  } catch {
    return null;
  }
}

function isBundledDemoEnabled(resourcesRoot: string) {
  return readBundledDemoManifest(resourcesRoot)?.bundled === true;
}

function listTemplateRootCandidates(
  app: AppWithPath,
  resourcesRoot = bundledResourcesRoot(app),
  platform: NodeJS.Platform = process.platform
) {
  if (platform === "win32") {
    return [path.join(resourcesRoot, DEMO_RESOURCES_ROOT_NAME, TEMPLATE_ROOT_NAME)];
  }
  if (platform === "darwin") {
    return [path.join(resourcesRoot, DEMO_RESOURCES_ROOT_NAME, TEMPLATE_ROOT_NAME)];
  }
  return [path.join(resourcesRoot, DEMO_RESOURCES_ROOT_NAME, TEMPLATE_ROOT_NAME)];
}

function findTemplateDir(
  app: AppWithPath,
  templateId: string,
  options: InstallBundledWebappTemplateOptions = {}
) {
  const resourcesRoot = bundledResourcesRoot(app, options.resourcesRoot);
  if (!isBundledDemoEnabled(resourcesRoot)) {
    return {
      enabled: false,
      sourceDir: ""
    };
  }

  for (const root of listTemplateRootCandidates(app, resourcesRoot, options.platform)) {
    const candidate = path.join(root, templateId);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return {
          enabled: true,
          sourceDir: candidate
        };
      }
    } catch {
      // Keep probing the remaining bundle locations.
    }
  }
  return {
    enabled: true,
    sourceDir: ""
  };
}

export function installBundledWebappTemplates(
  app: AppWithPath,
  options: InstallBundledWebappTemplateOptions = {}
) {
  const targetRoot = getDesktopWebappsDataRoot(app as App);
  const targetDir = path.join(targetRoot, BUNDLED_DEMO_ID);

  const source = findTemplateDir(app, BUNDLED_DEMO_ID, options);
  if (!source.enabled) {
    return {
      ok: true,
      installed: false,
      sourceDir: "",
      targetDir,
      message: t("webapp.demoMissingInPackage")
    };
  }

  const sourceDir = source.sourceDir;
  if (!sourceDir) {
    return {
      ok: false,
      installed: false,
      sourceDir: "",
      targetDir,
      message: t("webapp.demoTemplateMissing")
    };
  }

  fs.mkdirSync(targetRoot, { recursive: true });
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  fs.cpSync(sourceDir, targetDir, { recursive: true, force: true });
  return {
    ok: true,
    installed: true,
    sourceDir,
    targetDir,
    message: t("webapp.demoInstalled")
  };
}

export const __testInternals = {
  BUNDLED_DEMO_ID,
  DEMO_MANIFEST_FILE_NAME,
  DEMO_RESOURCES_ROOT_NAME,
  TEMPLATE_ROOT_NAME,
  isBundledDemoEnabled,
  listTemplateRootCandidates
};
