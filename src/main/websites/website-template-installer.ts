import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { getDesktopWebsitesDataRoot } from "../user-paths";

const TEMPLATE_ROOT_NAME = "website-templates";
const BUNDLED_DEMO_ID = "demo-node-html";

type AppWithPath = Pick<App, "getPath"> & Partial<Pick<App, "getAppPath">>;

function listTemplateRootCandidates(app: AppWithPath, resourcesPath = process.resourcesPath) {
  const appPath = typeof app.getAppPath === "function" ? app.getAppPath() : "";
  return [
    appPath ? path.join(appPath, "public", TEMPLATE_ROOT_NAME) : "",
    appPath ? path.join(appPath, "dist-renderer", TEMPLATE_ROOT_NAME) : "",
    resourcesPath ? path.join(resourcesPath, TEMPLATE_ROOT_NAME) : ""
  ].filter(Boolean);
}

function findTemplateDir(app: AppWithPath, templateId: string) {
  for (const root of listTemplateRootCandidates(app)) {
    const candidate = path.join(root, templateId);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Keep probing the remaining bundle locations.
    }
  }
  return "";
}

export function installBundledWebsiteTemplates(app: AppWithPath) {
  const targetRoot = getDesktopWebsitesDataRoot(app as App);
  const targetDir = path.join(targetRoot, BUNDLED_DEMO_ID);
  if (fs.existsSync(path.join(targetDir, "website.json"))) {
    return {
      ok: true,
      installed: false,
      sourceDir: "",
      targetDir,
      message: "内置网站小应用示例已存在。"
    };
  }

  const sourceDir = findTemplateDir(app, BUNDLED_DEMO_ID);
  if (!sourceDir) {
    return {
      ok: false,
      installed: false,
      sourceDir: "",
      targetDir,
      message: "未找到内置网站小应用示例模板。"
    };
  }

  fs.mkdirSync(targetRoot, { recursive: true });
  if (fs.existsSync(targetDir)) {
    return {
      ok: true,
      installed: false,
      sourceDir,
      targetDir,
      message: "网站小应用示例目录已存在，未覆盖。"
    };
  }
  fs.cpSync(sourceDir, targetDir, { recursive: true, force: false });
  return {
    ok: true,
    installed: true,
    sourceDir,
    targetDir,
    message: "已安装内置网站小应用示例。"
  };
}

export const __testInternals = {
  BUNDLED_DEMO_ID,
  TEMPLATE_ROOT_NAME,
  listTemplateRootCandidates
};
